//! The recovery rule checked by OpenZeppelin's own `do_check_auth`
//! (stellar-accounts 0.7.2) with real ed25519 signatures: the recovery key can
//! add a signer to the guardian's rule, and nothing else.
extern crate std;

use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    auth::{Context, ContractContext},
    map,
    testutils::{Address as _, Ledger as _},
    vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, Map, Symbol, Val, Vec,
};
use stellar_accounts::smart_account::{AuthPayload, ContextRule, ContextRuleType, Signer};

use crate::{RecoveryScopeParams, RecoveryScopePolicy};

const UNVALIDATED_CONTEXT: u32 = 3002;
const NOT_ALLOWED: u32 = 3501;
const MISSING_SIGNATURE: u32 = 3502;
const ONLY_OWN_ACCOUNT: u32 = 3504;
const BAD_SIGNATURE: u32 = u32::MAX;

mod contracts {
    use soroban_sdk::{
        auth::{Context, CustomAccountInterface},
        contract, contractimpl,
        crypto::Hash,
        Address, Bytes, BytesN, Env, Map, String, Val, Vec,
    };
    use stellar_accounts::{
        smart_account::{self, AuthPayload, ContextRule, ContextRuleType, Signer, SmartAccountError},
        verifiers::{ed25519, Verifier},
    };

    #[contract]
    pub struct Ed25519Verifier;

    #[contractimpl]
    impl Verifier for Ed25519Verifier {
        type KeyData = BytesN<32>;
        type SigData = BytesN<64>;
        fn verify(e: &Env, hash: Bytes, key_data: BytesN<32>, sig_data: BytesN<64>) -> bool {
            ed25519::verify(e, &hash, &key_data, &sig_data)
        }
        fn canonicalize_key(e: &Env, key_data: BytesN<32>) -> Bytes {
            ed25519::canonicalize_key(e, &key_data)
        }
        fn batch_canonicalize_key(e: &Env, key_data: Vec<BytesN<32>>) -> Vec<Bytes> {
            ed25519::batch_canonicalize_key(e, &key_data)
        }
    }

    #[contract]
    pub struct Account;

    #[contractimpl]
    impl Account {
        pub fn add_rule(e: &Env, context_type: ContextRuleType, signers: Vec<Signer>, policies: Map<Address, Val>) -> ContextRule {
            smart_account::add_context_rule(e, &context_type, &String::from_str(e, "rule"), None, &signers, &policies)
        }
    }

    #[contractimpl]
    impl CustomAccountInterface for Account {
        type Error = SmartAccountError;
        type Signature = AuthPayload;
        fn __check_auth(e: Env, payload: Hash<32>, sigs: AuthPayload, ctx: Vec<Context>) -> Result<(), SmartAccountError> {
            smart_account::do_check_auth(&e, &payload, &sigs, &ctx)
        }
    }
}

use contracts::{Account, AccountClient, Ed25519Verifier};

struct World {
    e: Env,
    account: Address,
    verifier: Address,
    policy: Address,
    token: Address,
    admin: SigningKey,
    recovery: SigningKey,
    admin_rule: u32,
    recovery_rule: u32,
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn world() -> World {
    let e = Env::default();
    e.mock_all_auths_allowing_non_root_auth();
    e.ledger().set_sequence_number(1_000_000);
    let account = e.register(Account, ());
    let verifier = e.register(Ed25519Verifier, ());
    let policy = e.register(RecoveryScopePolicy, ());
    let token = Address::generate(&e);
    let admin = key(1);
    let recovery = key(2);
    let mut w = World { e, account, verifier, policy, token, admin, recovery, admin_rule: 0, recovery_rule: 0 };
    let client = AccountClient::new(&w.e, &w.account);
    // The guardian's rule (a passkey in production; an ed25519 key stands in for it here).
    w.admin_rule = client.add_rule(&ContextRuleType::Default, &vec![&w.e, w.signer(&w.admin)], &Map::new(&w.e)).id;
    // The recovery rule: scoped to the account's own address, narrowed by the policy.
    let params: Val = RecoveryScopeParams { admin_rule_id: w.admin_rule }.into_val(&w.e);
    let rule: ContextRule = client.add_rule(
        &ContextRuleType::CallContract(w.account.clone()),
        &vec![&w.e, w.signer(&w.recovery)],
        &map![&w.e, (w.policy.clone(), params)],
    );
    w.recovery_rule = rule.id;
    w
}

impl World {
    fn signer(&self, k: &SigningKey) -> Signer {
        Signer::External(self.verifier.clone(), Bytes::from_array(&self.e, &k.verifying_key().to_bytes()))
    }

    fn call(&self, contract: &Address, fn_name: &str, args: Vec<Val>) -> Context {
        Context::Contract(ContractContext { contract: contract.clone(), fn_name: Symbol::new(&self.e, fn_name), args })
    }

    fn add_signer_ctx(&self, rule: u32) -> Context {
        let new_passkey = self.signer(&key(9));
        self.call(&self.account, "add_signer", vec![&self.e, rule.into_val(&self.e), new_passkey.into_val(&self.e)])
    }

    fn transfer_ctx(&self) -> Context {
        let thief = Address::generate(&self.e);
        self.call(&self.token, "transfer", vec![&self.e, self.account.into_val(&self.e), thief.into_val(&self.e), 1_000_000_000i128.into_val(&self.e)])
    }

    /// Runs the account's `__check_auth` with real signatures over OZ's digest.
    fn check(&self, rule: u32, ctx: Context, keys: &[&SigningKey]) -> Result<(), u32> {
        let e = &self.e;
        let payload = [7u8; 32];
        let mut pre = Bytes::from_array(e, &payload);
        pre.append(&vec![e, rule].to_xdr(e));
        let digest = e.crypto().sha256(&pre).to_array();
        let mut signers = Map::new(e);
        for k in keys {
            signers.set(self.signer(k), Bytes::from_array(e, &k.sign(&digest).to_bytes()));
        }
        let auth = AuthPayload { signers, context_rule_ids: vec![e, rule] };
        match e.try_invoke_contract_check_auth::<soroban_sdk::Error>(&self.account, &BytesN::from_array(e, &payload), auth.into_val(e), &vec![e, ctx]) {
            Ok(()) => Ok(()),
            Err(Ok(err)) if err.is_type(soroban_sdk::xdr::ScErrorType::Contract) => Err(err.get_code()),
            Err(Ok(err)) if err.is_type(soroban_sdk::xdr::ScErrorType::Crypto) => Err(BAD_SIGNATURE),
            Err(other) => panic!("unexpected error: {:?}", other),
        }
    }
}

#[test]
fn recovery_key_can_add_a_passkey_to_the_guardians_rule() {
    let w = world();
    assert_eq!(w.check(w.recovery_rule, w.add_signer_ctx(w.admin_rule), &[&w.recovery]), Ok(()));
}

#[test]
fn recovery_key_cannot_pay() {
    let w = world();
    // A token transfer is a call to the token, which the account-scoped rule does not cover.
    assert_eq!(w.check(w.recovery_rule, w.transfer_ctx(), &[&w.recovery]), Err(UNVALIDATED_CONTEXT));
}

#[test]
fn recovery_key_cannot_use_execute_to_pay() {
    let w = world();
    let thief = Address::generate(&w.e);
    let inner: Vec<Val> = vec![&w.e, w.account.into_val(&w.e), thief.into_val(&w.e), 1_000_000_000i128.into_val(&w.e)];
    let ctx = w.call(&w.account, "execute", vec![&w.e, w.token.into_val(&w.e), Symbol::new(&w.e, "transfer").into_val(&w.e), inner.into_val(&w.e)]);
    assert_eq!(w.check(w.recovery_rule, ctx, &[&w.recovery]), Err(NOT_ALLOWED));
}

#[test]
fn recovery_key_cannot_upgrade_or_change_other_rules() {
    let w = world();
    let e = &w.e;
    let upgrade = w.call(&w.account, "upgrade", vec![e, BytesN::from_array(e, &[0u8; 32]).into_val(e)]);
    assert_eq!(w.check(w.recovery_rule, upgrade, &[&w.recovery]), Err(NOT_ALLOWED));
    // Adding a signer to any rule but the guardian's (here: the recovery rule itself).
    assert_eq!(w.check(w.recovery_rule, w.add_signer_ctx(w.recovery_rule), &[&w.recovery]), Err(NOT_ALLOWED));
    assert_eq!(w.check(w.recovery_rule, w.add_signer_ctx(42), &[&w.recovery]), Err(NOT_ALLOWED));
    let new_rule = w.call(&w.account, "add_context_rule", vec![e, ContextRuleType::Default.into_val(e)]);
    assert_eq!(w.check(w.recovery_rule, new_rule, &[&w.recovery]), Err(NOT_ALLOWED));
    let remove = w.call(&w.account, "remove_signer", vec![e, w.admin_rule.into_val(e), w.signer(&w.admin).into_val(e)]);
    assert_eq!(w.check(w.recovery_rule, remove, &[&w.recovery]), Err(NOT_ALLOWED));
}

#[test]
fn recovery_rule_needs_the_recovery_signature() {
    let w = world();
    // No signature at all: OpenZeppelin leaves this to the policy, which refuses.
    assert_eq!(w.check(w.recovery_rule, w.add_signer_ctx(w.admin_rule), &[]), Err(MISSING_SIGNATURE));
    // Someone else's key is not a signer of the rule and is refused by OpenZeppelin.
    let other = key(5);
    assert_eq!(w.check(w.recovery_rule, w.add_signer_ctx(w.admin_rule), &[&other]), Err(3016)); // UnauthorizedSigner
}

#[test]
fn guardian_rule_is_unchanged() {
    let w = world();
    assert_eq!(w.check(w.admin_rule, w.transfer_ctx(), &[&w.admin]), Ok(()));
    assert_eq!(w.check(w.admin_rule, w.add_signer_ctx(w.admin_rule), &[&w.admin]), Ok(()));
}

#[test]
fn policy_installs_only_on_a_rule_scoped_to_the_account_itself() {
    let w = world();
    let params: Val = RecoveryScopeParams { admin_rule_id: w.admin_rule }.into_val(&w.e);
    let client = AccountClient::new(&w.e, &w.account);
    for scope in [ContextRuleType::Default, ContextRuleType::CallContract(w.token.clone())] {
        let r = client.try_add_rule(&scope, &vec![&w.e, w.signer(&key(3))], &map![&w.e, (w.policy.clone(), params.clone())]);
        let err = r.err().expect("must be refused").expect("contract error");
        assert_eq!(err, soroban_sdk::Error::from_contract_error(ONLY_OWN_ACCOUNT));
    }
}

/// The install parameters as XDR, pinned so the TypeScript encoder
/// (packages/core/src/recovery.ts `recoveryScopeParams`) is checked against it.
pub const PARAMS_ADMIN_0_XDR_HEX: &str = "0000001100000001000000010000000f0000000d61646d696e5f72756c655f69640000000000000300000000";

#[test]
fn install_params_encoding_matches_the_typescript_encoder() {
    let e = Env::default();
    let v: Val = RecoveryScopeParams { admin_rule_id: 0 }.into_val(&e);
    let bytes = v.to_xdr(&e);
    let mut hex = std::string::String::new();
    for b in bytes.iter() {
        hex.push_str(&std::format!("{:02x}", b));
    }
    assert_eq!(hex, PARAMS_ADMIN_0_XDR_HEX);
}
