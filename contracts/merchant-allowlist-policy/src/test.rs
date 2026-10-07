extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext},
    symbol_short,
    testutils::Address as _,
    vec, Address, Env, IntoVal, String, Symbol, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};

use crate::{AllowlistError, AllowlistParams, MerchantAllowlistPolicy, MerchantAllowlistPolicyClient};

struct Setup<'a> {
    e: Env,
    client: MerchantAllowlistPolicyClient<'a>,
    account: Address,
    token: Address,
    merchant: Address,
    rule: ContextRule,
    signers: Vec<Signer>,
}

fn setup<'a>() -> Setup<'a> {
    let e = Env::default();
    e.mock_all_auths();
    let id = e.register(MerchantAllowlistPolicy, ());
    let client = MerchantAllowlistPolicyClient::new(&e, &id);
    let account = Address::generate(&e);
    let token = Address::generate(&e);
    let merchant = Address::generate(&e);
    let rule = rule(&e, 3, ContextRuleType::CallContract(token.clone()));
    let signers = vec![&e, Signer::Delegated(Address::generate(&e))];
    Setup { e, client, account, token, merchant, rule, signers }
}

fn rule(e: &Env, id: u32, context_type: ContextRuleType) -> ContextRule {
    ContextRule {
        id,
        context_type,
        name: String::from_str(e, "agent-usdc"),
        signers: Vec::new(e),
        signer_ids: Vec::new(e),
        policies: Vec::new(e),
        policy_ids: Vec::new(e),
        valid_until: None,
    }
}

fn call(e: &Env, token: &Address, f: Symbol, from: &Address, to: &Address, amount: i128) -> Context {
    Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: f,
        args: vec![e, from.into_val(e), to.into_val(e), amount.into_val(e)],
    })
}

fn code<T>(r: Result<T, Result<soroban_sdk::Error, soroban_sdk::InvokeError>>) -> u32 {
    match r {
        Err(Ok(err)) => err.get_code(),
        Err(Err(_)) => panic!("unexpected invoke error"),
        Ok(_) => panic!("expected an error"),
    }
}

#[test]
fn allows_listed_recipient_and_rejects_others() {
    let s = setup();
    let params = AllowlistParams { recipients: vec![&s.e, s.merchant.clone()] };
    s.client.install(&params, &s.rule, &s.account);
    assert_eq!(s.client.get_recipients(&3, &s.account), params.recipients);

    let ok = call(&s.e, &s.token, symbol_short!("transfer"), &s.account, &s.merchant, 100);
    s.client.enforce(&ok, &s.signers, &s.rule, &s.account);

    let stranger = Address::generate(&s.e);
    let bad = call(&s.e, &s.token, symbol_short!("transfer"), &s.account, &stranger, 100);
    assert_eq!(
        code(s.client.try_enforce(&bad, &s.signers, &s.rule, &s.account)),
        AllowlistError::RecipientNotAllowed as u32
    );
}

#[test]
fn rejects_non_transfer_calls_and_missing_signers() {
    let s = setup();
    s.client.install(&AllowlistParams { recipients: vec![&s.e, s.merchant.clone()] }, &s.rule, &s.account);
    let approve = call(&s.e, &s.token, symbol_short!("approve"), &s.account, &s.merchant, 100);
    assert_eq!(code(s.client.try_enforce(&approve, &s.signers, &s.rule, &s.account)), AllowlistError::NotAllowed as u32);
    let ok = call(&s.e, &s.token, symbol_short!("transfer"), &s.account, &s.merchant, 100);
    assert_eq!(code(s.client.try_enforce(&ok, &Vec::new(&s.e), &s.rule, &s.account)), AllowlistError::NotAllowed as u32);
}

#[test]
fn install_validation_and_uninstall() {
    let s = setup();
    let empty = AllowlistParams { recipients: Vec::new(&s.e) };
    assert_eq!(code(s.client.try_install(&empty, &s.rule, &s.account)), AllowlistError::InvalidParams as u32);
    let dup = AllowlistParams { recipients: vec![&s.e, s.merchant.clone(), s.merchant.clone()] };
    assert_eq!(code(s.client.try_install(&dup, &s.rule, &s.account)), AllowlistError::InvalidParams as u32);
    let default_rule = rule(&s.e, 0, ContextRuleType::Default);
    let one = AllowlistParams { recipients: vec![&s.e, s.merchant.clone()] };
    assert_eq!(
        code(s.client.try_install(&one, &default_rule, &s.account)),
        AllowlistError::OnlyCallContractAllowed as u32
    );

    s.client.install(&one, &s.rule, &s.account);
    assert_eq!(code(s.client.try_install(&one, &s.rule, &s.account)), AllowlistError::AlreadyInstalled as u32);
    s.client.uninstall(&s.rule, &s.account);
    let ok = call(&s.e, &s.token, symbol_short!("transfer"), &s.account, &s.merchant, 1);
    assert_eq!(code(s.client.try_enforce(&ok, &s.signers, &s.rule, &s.account)), AllowlistError::NotInstalled as u32);
}

#[test]
fn allowlists_are_per_account_and_rule() {
    let s = setup();
    s.client.install(&AllowlistParams { recipients: vec![&s.e, s.merchant.clone()] }, &s.rule, &s.account);
    let other_account = Address::generate(&s.e);
    let ok = call(&s.e, &s.token, symbol_short!("transfer"), &other_account, &s.merchant, 1);
    assert_eq!(code(s.client.try_enforce(&ok, &s.signers, &s.rule, &other_account)), AllowlistError::NotInstalled as u32);
}

// ---------------------------------------------------------------------------
// Integration: the real OpenZeppelin smart-account auth flow (do_check_auth)
// with a context rule carrying BOTH the spending-limit policy and this one,
// as ACAN installs them for an agent.
// ---------------------------------------------------------------------------
mod account {
    use soroban_sdk::{
        auth::{Context, CustomAccountInterface},
        contract, contractimpl,
        crypto::Hash,
        Address, Env, Map, String, Val, Vec,
    };
    use stellar_accounts::smart_account::{self, AuthPayload, ContextRule, ContextRuleType, Signer, SmartAccountError};

    #[contract]
    pub struct TestAccount;

    #[contractimpl]
    impl TestAccount {
        pub fn add_rule(
            e: &Env,
            context_type: ContextRuleType,
            signers: Vec<Signer>,
            policies: Map<Address, Val>,
        ) -> ContextRule {
            smart_account::add_context_rule(e, &context_type, &String::from_str(e, "agent-usdc"), None, &signers, &policies)
        }
    }

    #[contractimpl]
    impl CustomAccountInterface for TestAccount {
        type Error = SmartAccountError;
        type Signature = AuthPayload;
        fn __check_auth(e: Env, payload: Hash<32>, sigs: AuthPayload, ctx: Vec<Context>) -> Result<(), SmartAccountError> {
            smart_account::do_check_auth(&e, &payload, &sigs, &ctx)
        }
    }
}

mod spending_limit_policy {
    use soroban_sdk::{auth::Context, contract, contractimpl, Address, Env, Vec};
    use stellar_accounts::{
        policies::{spending_limit, Policy},
        smart_account::{ContextRule, Signer},
    };

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
}

#[test]
fn smart_account_enforces_allowlist_and_spending_limit_together() {
    use soroban_sdk::{map, Bytes, BytesN, Map, Val};
    use stellar_accounts::{policies::spending_limit::SpendingLimitAccountParams, smart_account::AuthPayload};

    let e = Env::default();
    e.mock_all_auths_allowing_non_root_auth();
    let account = e.register(account::TestAccount, ());
    let limit_policy = e.register(spending_limit_policy::SpendingLimit, ());
    let allow_policy = e.register(MerchantAllowlistPolicy, ());
    let token = Address::generate(&e);
    let merchant = Address::generate(&e);
    let vault = Address::generate(&e);
    let agent = Signer::Delegated(Address::generate(&e));

    let policies: Map<Address, Val> = map![
        &e,
        (limit_policy.clone(), SpendingLimitAccountParams { spending_limit: 1_000_000, period_ledgers: 17_280 }.into_val(&e)),
        (allow_policy.clone(), AllowlistParams { recipients: vec![&e, merchant.clone(), vault.clone()] }.into_val(&e))
    ];
    let rule: ContextRule = account::TestAccountClient::new(&e, &account).add_rule(
        &ContextRuleType::CallContract(token.clone()),
        &vec![&e, agent.clone()],
        &policies,
    );

    let check = |to: &Address, amount: i128| {
        let payload = AuthPayload {
            signers: map![&e, (agent.clone(), Bytes::new(&e))],
            context_rule_ids: vec![&e, rule.id],
        };
        let hash: BytesN<32> = e.crypto().sha256(&Bytes::from_array(&e, &[7u8; 32])).into();
        let ctx = call(&e, &token, symbol_short!("transfer"), &account, to, amount);
        e.try_invoke_contract_check_auth::<soroban_sdk::Error>(&account, &hash, payload.into_val(&e), &vec![&e, ctx])
    };

    // An allowlisted merchant, within the limit: accepted.
    assert!(check(&merchant, 400_000).is_ok());
    // The agent's own vault (top-ups) is on the list too.
    assert!(check(&vault, 400_000).is_ok());
    // Anyone else is refused by the allowlist, even for a tiny amount.
    let stranger = Address::generate(&e);
    let err = check(&stranger, 1).unwrap_err();
    assert_eq!(err, Ok(soroban_sdk::Error::from_contract_error(AllowlistError::RecipientNotAllowed as u32)));
    // An allowlisted merchant above the spending limit: refused by the spending-limit policy (3221).
    // (Each check_auth call here is evaluated on its own, so this uses an amount above the whole limit.)
    let err = check(&merchant, 1_200_000).unwrap_err();
    assert_eq!(err, Ok(soroban_sdk::Error::from_contract_error(3221)));
}
