use acan_merchant_allowlist_policy::{MerchantBudgetPolicy, MerchantPolicyError, MerchantPolicyParams, Recipient};
use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    auth::{Context, ContractContext},
    map, symbol_short,
    testutils::{Address as _, Ledger as _},
    vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, Map, Val, Vec,
};
use stellar_accounts::{
    policies::{simple_threshold::SimpleThresholdAccountParams, spending_limit::SpendingLimitAccountParams, weighted_threshold::WeightedThresholdAccountParams},
    smart_account::{AuthPayload, ContextRule, ContextRuleType, Signer},
};

use crate::fixture as fx;

const DAY: u32 = 17_280;
// OpenZeppelin error codes (stellar-accounts 0.7.2).
const WEIGHTED_NOT_ALLOWED: u32 = 3213;
const SPENDING_LIMIT_EXCEEDED: u32 = 3221;
/// Not a contract error: the host's ed25519 check failed (Error(Crypto, InvalidInput)).
const BAD_SIGNATURE: u32 = u32::MAX;

// ---------------------------------------------------------------------------
// Contracts: OZ's ed25519 verifier, a smart account and OZ policies, wrapped
// exactly as a deployment would wrap them.
// ---------------------------------------------------------------------------
mod contracts {
    use soroban_sdk::{
        auth::{Context, CustomAccountInterface},
        contract, contractimpl,
        crypto::Hash,
        Address, Bytes, BytesN, Env, Map, String, Val, Vec,
    };
    use stellar_accounts::{
        policies::{simple_threshold, spending_limit, weighted_threshold, Policy},
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
            smart_account::add_context_rule(e, &context_type, &String::from_str(e, "agent-usdc"), None, &signers, &policies)
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

    #[contract]
    pub struct SpendingLimit;
    #[contractimpl]
    impl Policy for SpendingLimit {
        type AccountParams = spending_limit::SpendingLimitAccountParams;
        fn enforce(e: &Env, c: Context, s: Vec<Signer>, r: ContextRule, a: Address) {
            spending_limit::enforce(e, &c, &s, &r, &a)
        }
        fn install(e: &Env, p: Self::AccountParams, r: ContextRule, a: Address) {
            spending_limit::install(e, &p, &r, &a)
        }
        fn uninstall(e: &Env, r: ContextRule, a: Address) {
            spending_limit::uninstall(e, &r, &a)
        }
    }

    #[contract]
    pub struct SimpleThreshold;
    #[contractimpl]
    impl Policy for SimpleThreshold {
        type AccountParams = simple_threshold::SimpleThresholdAccountParams;
        fn enforce(e: &Env, c: Context, s: Vec<Signer>, r: ContextRule, a: Address) {
            simple_threshold::enforce(e, &c, &s, &r, &a)
        }
        fn install(e: &Env, p: Self::AccountParams, r: ContextRule, a: Address) {
            simple_threshold::install(e, &p, &r, &a)
        }
        fn uninstall(e: &Env, r: ContextRule, a: Address) {
            simple_threshold::uninstall(e, &r, &a)
        }
    }

    #[contract]
    pub struct WeightedThreshold;
    #[contractimpl]
    impl Policy for WeightedThreshold {
        type AccountParams = weighted_threshold::WeightedThresholdAccountParams;
        fn enforce(e: &Env, c: Context, s: Vec<Signer>, r: ContextRule, a: Address) {
            weighted_threshold::enforce(e, &c, &s, &r, &a)
        }
        fn install(e: &Env, p: Self::AccountParams, r: ContextRule, a: Address) {
            weighted_threshold::install(e, &p, &r, &a)
        }
        fn uninstall(e: &Env, r: ContextRule, a: Address) {
            weighted_threshold::uninstall(e, &r, &a)
        }
    }

    // Keep the unused-import lint quiet for types only used in signatures above.
    #[allow(dead_code)]
    fn _types(_: ContextRuleType) {}
}

use contracts::{Account, AccountClient, Ed25519Verifier, SimpleThreshold, SpendingLimit, WeightedThreshold};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn unhex<const N: usize>(s: &str) -> [u8; N] {
    assert_eq!(s.len(), N * 2, "hex length");
    let mut out = [0u8; N];
    for i in 0..N {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

struct World {
    e: Env,
    account: Address,
    verifier: Address,
    token: Address,
    southgate: Address,
    northwind: Address,
}

fn world() -> World {
    let e = Env::default();
    // Policies call `smart_account.require_auth()`; that is the account's own
    // authorization, not a signer check. Signer checks below are real ed25519.
    e.mock_all_auths_allowing_non_root_auth();
    // A realistic ledger number. (At sequence 0, OZ spending_limit's rolling
    // window treats entries recorded at ledger 0 as already expired, which can
    // only happen in a test host.)
    e.ledger().set_sequence_number(1_000_000);
    let account = e.register(Account, ());
    let verifier = e.register(Ed25519Verifier, ());
    let token = Address::from_str(&e, fx::TOKEN);
    let southgate = Address::from_str(&e, fx::SOUTHGATE);
    let northwind = Address::from_str(&e, fx::NORTHWIND);
    World { e, account, verifier, token, southgate, northwind }
}

impl World {
    fn signer(&self, pk: [u8; 32]) -> Signer {
        Signer::External(self.verifier.clone(), Bytes::from_array(&self.e, &pk))
    }

    /// ACAN's limits as they are today: overall spending limit plus the merchant
    /// budget (both merchants allowlisted, the steered payment is within every cap).
    fn acan_limits(&self) -> Map<Address, Val> {
        let e = &self.e;
        let limit = e.register(SpendingLimit, ());
        let merchant = e.register(MerchantBudgetPolicy, ());
        let params = MerchantPolicyParams {
            recipients: vec![
                e,
                Recipient { address: self.southgate.clone(), cap: 800_000 },
                Recipient { address: self.northwind.clone(), cap: 800_000 },
            ],
            period_ledgers: DAY,
            max_payments: 0,
            max_per_payment: 500_000,
        };
        map![
            e,
            (limit, SpendingLimitAccountParams { spending_limit: 1_000_000, period_ledgers: DAY }.into_val(e)),
            (merchant, params.into_val(e))
        ]
    }

    fn rule(&self, signers: &[Signer], policies: Map<Address, Val>) -> ContextRule {
        let mut v = Vec::new(&self.e);
        for s in signers {
            v.push_back(s.clone());
        }
        AccountClient::new(&self.e, &self.account).add_rule(&ContextRuleType::CallContract(self.token.clone()), &v, &policies)
    }

    fn with(&self, mut policies: Map<Address, Val>, extra: (Address, Val)) -> Map<Address, Val> {
        policies.set(extra.0, extra.1);
        policies
    }

    fn weighted(&self, weights: &[(Signer, u32)], threshold: u32) -> (Address, Val) {
        let e = &self.e;
        let mut m = Map::new(e);
        for (s, w) in weights {
            m.set(s.clone(), *w);
        }
        (e.register(WeightedThreshold, ()), WeightedThresholdAccountParams { signer_weights: m, threshold }.into_val(e))
    }

    fn simple(&self, threshold: u32) -> (Address, Val) {
        (self.e.register(SimpleThreshold, ()), SimpleThresholdAccountParams { threshold }.into_val(&self.e))
    }

    /// Runs the account's `__check_auth` for one `token.transfer(account, to, amount)`.
    fn check(&self, rule: u32, payload: [u8; 32], sigs: &[(Signer, [u8; 64])], to: &Address, amount: i128) -> Result<(), u32> {
        let e = &self.e;
        let mut signers = Map::new(e);
        for (s, sig) in sigs {
            signers.set(s.clone(), Bytes::from_array(e, sig));
        }
        let auth = AuthPayload { signers, context_rule_ids: vec![e, rule] };
        let ctx = Context::Contract(ContractContext {
            contract: self.token.clone(),
            fn_name: symbol_short!("transfer"),
            args: vec![e, self.account.into_val(e), to.into_val(e), amount.into_val(e)],
        });
        let hash = BytesN::from_array(e, &payload);
        match e.try_invoke_contract_check_auth::<soroban_sdk::Error>(&self.account, &hash, auth.into_val(e), &vec![e, ctx]) {
            Ok(()) => Ok(()),
            Err(Ok(err)) if err.is_type(soroban_sdk::xdr::ScErrorType::Contract) => Err(err.get_code()),
            Err(Ok(err)) if err.is_type(soroban_sdk::xdr::ScErrorType::Crypto) => Err(BAD_SIGNATURE),
            Err(other) => {
                std::println!("non-contract error: {:?}", other);
                Err(0)
            }
        }
    }

    /// The digest OZ checks: sha256(payload || xdr(rule_ids)).
    fn digest(&self, payload: [u8; 32], rule: u32) -> [u8; 32] {
        let e = &self.e;
        let mut pre = Bytes::from_array(e, &payload);
        pre.append(&vec![e, rule].to_xdr(e));
        e.crypto().sha256(&pre).to_array()
    }
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn sign(k: &SigningKey, digest: [u8; 32]) -> [u8; 64] {
    k.sign(&digest).to_bytes()
}

// ---------------------------------------------------------------------------
// 1. The TypeScript co-signer's real signatures, checked by OZ do_check_auth
// ---------------------------------------------------------------------------

#[test]
fn ts_agent_and_cosigner_signatures_are_accepted_together() {
    let w = world();
    let agent = w.signer(unhex(fx::AGENT_PK));
    let cos = w.signer(unhex(fx::COSIGNER_PK));
    let gate = w.weighted(&[(agent.clone(), 1), (cos.clone(), 2)], 3);
    let rule = w.rule(&[agent.clone(), cos.clone()], w.with(w.acan_limits(), gate));
    assert_eq!(rule.id, fx::RULE_ID);

    let both = [(agent, unhex(fx::CLEAN_AGENT_SIG)), (cos, unhex(fx::CLEAN_COSIGNER_SIG))];
    assert_eq!(w.check(rule.id, unhex(fx::CLEAN_PAYLOAD), &both, &w.southgate, fx::CLEAN_AMOUNT), Ok(()));
}

#[test]
fn ts_agent_alone_or_cosigner_alone_is_refused() {
    let w = world();
    let agent = w.signer(unhex(fx::AGENT_PK));
    let cos = w.signer(unhex(fx::COSIGNER_PK));
    let gate = w.weighted(&[(agent.clone(), 1), (cos.clone(), 2)], 3);
    let rule = w.rule(&[agent.clone(), cos.clone()], w.with(w.acan_limits(), gate));

    let agent_only = [(agent, unhex(fx::CLEAN_AGENT_SIG))];
    assert_eq!(w.check(rule.id, unhex(fx::CLEAN_PAYLOAD), &agent_only, &w.southgate, fx::CLEAN_AMOUNT), Err(WEIGHTED_NOT_ALLOWED));
    let cos_only = [(cos, unhex(fx::CLEAN_COSIGNER_SIG))];
    assert_eq!(w.check(rule.id, unhex(fx::CLEAN_PAYLOAD), &cos_only, &w.southgate, fx::CLEAN_AMOUNT), Err(WEIGHTED_NOT_ALLOWED));
}

#[test]
fn steered_payment_passes_todays_rule_but_not_the_gated_rule() {
    // Today's ACAN rule: the agent key alone, with the spending limit and the
    // merchant budget. The steered payment (allowlisted merchant, within every
    // cap) is accepted: limits cannot tell it was manipulated.
    let w = world();
    let agent = w.signer(unhex(fx::AGENT_PK));
    let today = w.rule(&[agent.clone()], w.acan_limits());
    assert_eq!(today.id, fx::RULE_ID);
    let sig = [(agent.clone(), unhex(fx::STEERED_AGENT_SIG))];
    assert_eq!(w.check(today.id, unhex(fx::STEERED_PAYLOAD), &sig, &w.northwind, fx::STEERED_AMOUNT), Ok(()));

    // Gated rule: the co-signer escalated this payment (its choice came from the
    // injected note), so there is no co-signature, and the account refuses.
    let w = world();
    let agent = w.signer(unhex(fx::AGENT_PK));
    let cos = w.signer(unhex(fx::COSIGNER_PK));
    let gate = w.weighted(&[(agent.clone(), 1), (cos.clone(), 2)], 3);
    let gated = w.rule(&[agent.clone(), cos], w.with(w.acan_limits(), gate));
    let sig = [(agent, unhex(fx::STEERED_AGENT_SIG))];
    assert_eq!(w.check(gated.id, unhex(fx::STEERED_PAYLOAD), &sig, &w.northwind, fx::STEERED_AMOUNT), Err(WEIGHTED_NOT_ALLOWED));
}

#[test]
fn signatures_do_not_carry_over_to_another_payment() {
    let w = world();
    let agent = w.signer(unhex(fx::AGENT_PK));
    let cos = w.signer(unhex(fx::COSIGNER_PK));
    let gate = w.weighted(&[(agent.clone(), 1), (cos.clone(), 2)], 3);
    let rule = w.rule(&[agent.clone(), cos.clone()], w.with(w.acan_limits(), gate));
    // The clean payment's signatures presented for the steered payment's payload.
    let both = [(agent, unhex(fx::CLEAN_AGENT_SIG)), (cos, unhex(fx::CLEAN_COSIGNER_SIG))];
    assert_eq!(w.check(rule.id, unhex(fx::STEERED_PAYLOAD), &both, &w.northwind, fx::STEERED_AMOUNT), Err(BAD_SIGNATURE));
}

// ---------------------------------------------------------------------------
// 2. Every ACAN limit still applies when both have signed
// ---------------------------------------------------------------------------

#[test]
fn limits_still_apply_with_both_signatures() {
    let w = world();
    let (a, c) = (key(1), key(9));
    let agent = w.signer(a.verifying_key().to_bytes());
    let cos = w.signer(c.verifying_key().to_bytes());
    let gate = w.weighted(&[(agent.clone(), 1), (cos.clone(), 2)], 3);
    let rule = w.rule(&[agent.clone(), cos.clone()], w.with(w.acan_limits(), gate));
    let both = |payload: [u8; 32]| {
        let d = w.digest(payload, rule.id);
        [(agent.clone(), sign(&a, d)), (cos.clone(), sign(&c, d))]
    };

    let stranger = Address::generate(&w.e);
    assert_eq!(w.check(rule.id, [1; 32], &both([1; 32]), &stranger, 10), Err(MerchantPolicyError::RecipientNotAllowed as u32));
    assert_eq!(w.check(rule.id, [2; 32], &both([2; 32]), &w.southgate, 600_000), Err(MerchantPolicyError::PaymentTooLarge as u32));
    assert_eq!(w.check(rule.id, [3; 32], &both([3; 32]), &w.southgate, 400_000), Ok(()));
    assert_eq!(w.check(rule.id, [4; 32], &both([4; 32]), &w.northwind, 400_000), Ok(()));
    // 900_000 of the 1_000_000 overall limit after this one; Southgate at 500_000 of its 800_000 cap.
    assert_eq!(w.check(rule.id, [5; 32], &both([5; 32]), &w.southgate, 100_000), Ok(()));
    // Within Southgate's cap (700_000) but over the overall limit (1_100_000): refused by spending_limit.
    assert_eq!(w.check(rule.id, [6; 32], &both([6; 32]), &w.southgate, 200_000), Err(SPENDING_LIMIT_EXCEEDED));
}

// ---------------------------------------------------------------------------
// 3. Red-team finding A6: a signer count is not a named co-signer
// ---------------------------------------------------------------------------

#[test]
fn simple_threshold_can_be_met_by_two_agent_keys_without_the_cosigner() {
    let w = world();
    let (a, b, c) = (key(1), key(2), key(9));
    let (sa, sb, sc) = (w.signer(a.verifying_key().to_bytes()), w.signer(b.verifying_key().to_bytes()), w.signer(c.verifying_key().to_bytes()));
    let rule = w.rule(&[sa.clone(), sb.clone(), sc], w.with(w.acan_limits(), w.simple(2)));
    let d = w.digest([7; 32], rule.id);
    let agents_only = [(sa, sign(&a, d)), (sb, sign(&b, d))];
    // Accepted: the naive "2 signatures" gate is bypassed once a second agent key is on the rule.
    assert_eq!(w.check(rule.id, [7; 32], &agents_only, &w.southgate, 10), Ok(()));
}

#[test]
fn weighted_threshold_requires_the_cosigner_whatever_agent_keys_sign() {
    let w = world();
    let (a, b, c) = (key(1), key(2), key(9));
    let (sa, sb, sc) = (w.signer(a.verifying_key().to_bytes()), w.signer(b.verifying_key().to_bytes()), w.signer(c.verifying_key().to_bytes()));
    // Agents weigh 1 each, the co-signer W = 2 (>= number of agent keys), threshold W + 1.
    let gate = w.weighted(&[(sa.clone(), 1), (sb.clone(), 1), (sc.clone(), 2)], 3);
    let rule = w.rule(&[sa.clone(), sb.clone(), sc.clone()], w.with(w.acan_limits(), gate));
    let d = w.digest([8; 32], rule.id);
    assert_eq!(w.check(rule.id, [8; 32], &[(sa.clone(), sign(&a, d)), (sb.clone(), sign(&b, d))], &w.southgate, 10), Err(WEIGHTED_NOT_ALLOWED));
    assert_eq!(w.check(rule.id, [8; 32], &[(sc.clone(), sign(&c, d))], &w.southgate, 10), Err(WEIGHTED_NOT_ALLOWED));
    assert_eq!(w.check(rule.id, [8; 32], &[(sa, sign(&a, d)), (sc, sign(&c, d))], &w.southgate, 10), Ok(()));
}

#[test]
fn weighted_threshold_misconfigured_with_too_many_agent_keys_is_bypassable() {
    // The configuration rule matters: with three agent keys and W = 2, the
    // agents alone reach the threshold. The guardian must keep W >= agent keys.
    let w = world();
    let (a, b, x, c) = (key(1), key(2), key(3), key(9));
    let (sa, sb, sx, sc) = (
        w.signer(a.verifying_key().to_bytes()),
        w.signer(b.verifying_key().to_bytes()),
        w.signer(x.verifying_key().to_bytes()),
        w.signer(c.verifying_key().to_bytes()),
    );
    let gate = w.weighted(&[(sa.clone(), 1), (sb.clone(), 1), (sx.clone(), 1), (sc.clone(), 2)], 3);
    let rule = w.rule(&[sa.clone(), sb.clone(), sx.clone(), sc], w.with(w.acan_limits(), gate));
    let d = w.digest([9; 32], rule.id);
    let agents_only = [(sa, sign(&a, d)), (sb, sign(&b, d)), (sx, sign(&x, d))];
    assert_eq!(w.check(rule.id, [9; 32], &agents_only, &w.southgate, 10), Ok(()));
}

