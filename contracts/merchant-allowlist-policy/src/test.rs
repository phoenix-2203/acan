extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext},
    symbol_short,
    testutils::{Address as _, Ledger as _},
    vec, Address, Env, IntoVal, String, Symbol, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType, Signer};

use crate::{
    MerchantBudgetPolicy, MerchantBudgetPolicyClient, MerchantPolicyError, MerchantPolicyParams, Recipient,
};

const DAY: u32 = 17_280;

struct Setup<'a> {
    e: Env,
    client: MerchantBudgetPolicyClient<'a>,
    account: Address,
    token: Address,
    merchant: Address,
    other: Address,
    rule: ContextRule,
    signers: Vec<Signer>,
}

fn setup<'a>() -> Setup<'a> {
    let e = Env::default();
    e.mock_all_auths();
    let id = e.register(MerchantBudgetPolicy, ());
    let client = MerchantBudgetPolicyClient::new(&e, &id);
    let account = Address::generate(&e);
    let token = Address::generate(&e);
    let merchant = Address::generate(&e);
    let other = Address::generate(&e);
    let rule = rule(&e, 3, ContextRuleType::CallContract(token.clone()));
    let signers = vec![&e, Signer::Delegated(Address::generate(&e))];
    Setup { e, client, account, token, merchant, other, rule, signers }
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

fn params(e: &Env, recipients: &[(&Address, i128)], max_payments: u32) -> MerchantPolicyParams {
    let mut v = Vec::new(e);
    for (a, cap) in recipients {
        v.push_back(Recipient { address: (*a).clone(), cap: *cap });
    }
    MerchantPolicyParams { recipients: v, period_ledgers: DAY, max_payments }
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

impl Setup<'_> {
    fn pay(&self, to: &Address, amount: i128) -> u32 {
        let c = call(&self.e, &self.token, symbol_short!("transfer"), &self.account, to, amount);
        match self.client.try_enforce(&c, &self.signers, &self.rule, &self.account) {
            Ok(_) => 0,
            Err(Ok(err)) => err.get_code(),
            Err(Err(_)) => panic!("unexpected invoke error"),
        }
    }
}

#[test]
fn allows_listed_recipient_and_rejects_others() {
    let s = setup();
    s.client.install(&params(&s.e, &[(&s.merchant, 0)], 0), &s.rule, &s.account);
    assert_eq!(s.client.get_recipients(&3, &s.account), vec![&s.e, s.merchant.clone()]);
    assert_eq!(s.pay(&s.merchant, 100), 0);
    let stranger = Address::generate(&s.e);
    assert_eq!(s.pay(&stranger, 1), MerchantPolicyError::RecipientNotAllowed as u32);
}

#[test]
fn caps_each_recipient_separately() {
    let s = setup();
    s.client.install(&params(&s.e, &[(&s.merchant, 500), (&s.other, 200)], 0), &s.rule, &s.account);
    assert_eq!(s.pay(&s.merchant, 300), 0);
    assert_eq!(s.pay(&s.merchant, 200), 0); // exactly at the cap
    assert_eq!(s.pay(&s.merchant, 1), MerchantPolicyError::RecipientCapExceeded as u32);
    // The other merchant's slice is untouched by the first one's spending.
    assert_eq!(s.pay(&s.other, 200), 0);
    assert_eq!(s.pay(&s.other, 1), MerchantPolicyError::RecipientCapExceeded as u32);
    let st = s.client.get_state(&3, &s.account);
    assert_eq!(st.spent.get(s.merchant.clone()), Some(500));
    assert_eq!(st.payments, 3);
}

#[test]
fn limits_payments_per_period_and_resets_after_it() {
    let s = setup();
    s.client.install(&params(&s.e, &[(&s.merchant, 0)], 3), &s.rule, &s.account);
    for _ in 0..3 {
        assert_eq!(s.pay(&s.merchant, 1), 0);
    }
    assert_eq!(s.pay(&s.merchant, 1), MerchantPolicyError::TooManyPayments as u32);
    // A new period starts once the window has passed.
    s.e.ledger().with_mut(|l| l.sequence_number += DAY);
    assert_eq!(s.client.get_state(&3, &s.account).payments, 0);
    assert_eq!(s.pay(&s.merchant, 1), 0);
}

#[test]
fn caps_reset_with_the_period() {
    let s = setup();
    s.client.install(&params(&s.e, &[(&s.merchant, 100)], 0), &s.rule, &s.account);
    assert_eq!(s.pay(&s.merchant, 100), 0);
    assert_eq!(s.pay(&s.merchant, 1), MerchantPolicyError::RecipientCapExceeded as u32);
    s.e.ledger().with_mut(|l| l.sequence_number += DAY - 1);
    assert_eq!(s.pay(&s.merchant, 1), MerchantPolicyError::RecipientCapExceeded as u32);
    s.e.ledger().with_mut(|l| l.sequence_number += 1);
    assert_eq!(s.pay(&s.merchant, 100), 0);
}

#[test]
fn rejects_non_transfer_calls_and_missing_signers() {
    let s = setup();
    s.client.install(&params(&s.e, &[(&s.merchant, 0)], 0), &s.rule, &s.account);
    let approve = call(&s.e, &s.token, symbol_short!("approve"), &s.account, &s.merchant, 100);
    assert_eq!(
        code(s.client.try_enforce(&approve, &s.signers, &s.rule, &s.account)),
        MerchantPolicyError::NotAllowed as u32
    );
    let ok = call(&s.e, &s.token, symbol_short!("transfer"), &s.account, &s.merchant, 100);
    assert_eq!(
        code(s.client.try_enforce(&ok, &Vec::new(&s.e), &s.rule, &s.account)),
        MerchantPolicyError::NotAllowed as u32
    );
}

#[test]
fn install_validation_and_uninstall() {
    let s = setup();
    let empty = MerchantPolicyParams { recipients: Vec::new(&s.e), period_ledgers: DAY, max_payments: 0 };
    assert_eq!(code(s.client.try_install(&empty, &s.rule, &s.account)), MerchantPolicyError::InvalidParams as u32);
    let dup = params(&s.e, &[(&s.merchant, 0), (&s.merchant, 5)], 0);
    assert_eq!(code(s.client.try_install(&dup, &s.rule, &s.account)), MerchantPolicyError::InvalidParams as u32);
    let negative = params(&s.e, &[(&s.merchant, -1)], 0);
    assert_eq!(code(s.client.try_install(&negative, &s.rule, &s.account)), MerchantPolicyError::InvalidParams as u32);
    let mut zero_period = params(&s.e, &[(&s.merchant, 0)], 0);
    zero_period.period_ledgers = 0;
    assert_eq!(code(s.client.try_install(&zero_period, &s.rule, &s.account)), MerchantPolicyError::InvalidParams as u32);
    let one = params(&s.e, &[(&s.merchant, 0)], 0);
    let default_rule = rule(&s.e, 0, ContextRuleType::Default);
    assert_eq!(
        code(s.client.try_install(&one, &default_rule, &s.account)),
        MerchantPolicyError::OnlyCallContractAllowed as u32
    );

    s.client.install(&one, &s.rule, &s.account);
    assert_eq!(code(s.client.try_install(&one, &s.rule, &s.account)), MerchantPolicyError::AlreadyInstalled as u32);
    s.client.uninstall(&s.rule, &s.account);
    assert_eq!(s.pay(&s.merchant, 1), MerchantPolicyError::NotInstalled as u32);
}

#[test]
fn settings_are_per_account_and_rule() {
    let s = setup();
    s.client.install(&params(&s.e, &[(&s.merchant, 0)], 0), &s.rule, &s.account);
    let other_account = Address::generate(&s.e);
    let ok = call(&s.e, &s.token, symbol_short!("transfer"), &other_account, &s.merchant, 1);
    assert_eq!(
        code(s.client.try_enforce(&ok, &s.signers, &s.rule, &other_account)),
        MerchantPolicyError::NotInstalled as u32
    );
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
fn smart_account_enforces_merchant_budgets_and_spending_limit_together() {
    use soroban_sdk::{map, Bytes, BytesN, Map, Val};
    use stellar_accounts::{policies::spending_limit::SpendingLimitAccountParams, smart_account::AuthPayload};

    let e = Env::default();
    e.mock_all_auths_allowing_non_root_auth();
    let account = e.register(account::TestAccount, ());
    let limit_policy = e.register(spending_limit_policy::SpendingLimit, ());
    let merchant_policy = e.register(MerchantBudgetPolicy, ());
    let token = Address::generate(&e);
    let merchant = Address::generate(&e);
    let vault = Address::generate(&e);
    let agent = Signer::Delegated(Address::generate(&e));

    let policies: Map<Address, Val> = map![
        &e,
        (limit_policy.clone(), SpendingLimitAccountParams { spending_limit: 1_000_000, period_ledgers: DAY }.into_val(&e)),
        (merchant_policy.clone(), params(&e, &[(&merchant, 500_000), (&vault, 0)], 0).into_val(&e))
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
    let err = |c: u32| Err(Ok(soroban_sdk::Error::from_contract_error(c)));

    // A listed merchant within its cap and the overall limit: accepted.
    assert!(check(&merchant, 400_000).is_ok());
    // The vault (no per-recipient cap) within the overall limit: accepted.
    assert!(check(&vault, 400_000).is_ok());
    // Anyone else is refused, even for a tiny amount.
    assert_eq!(check(&Address::generate(&e), 1), err(MerchantPolicyError::RecipientNotAllowed as u32));
    // Above the merchant's own cap: refused by this policy.
    assert_eq!(check(&merchant, 600_000), err(MerchantPolicyError::RecipientCapExceeded as u32));
    // Above the overall limit: refused by the spending-limit policy (3221).
    assert_eq!(check(&vault, 1_200_000), err(3221));
}

/// Prints the XDR of a fixed params value; the dashboard's encoder test pins
/// the same bytes, so the TypeScript and Rust encodings cannot drift apart.
#[test]
fn params_xdr_fixture() {
    use soroban_sdk::xdr::ToXdr;
    let e = Env::default();
    let a = Address::from_str(&e, "GBCYIJE4JZEGQFMZ2CV7G5KWAGGGJDCGEUANYOPFB7QEIO23457OESPT");
    let b = Address::from_str(&e, "CCV4VQTGJN6GUVNM4LN3JWOWBOOX3E7IGKJ6QUPKZVKMDNV7WEJXVYAQ");
    let p = MerchantPolicyParams {
        recipients: vec![&e, Recipient { address: a, cap: 500_000 }, Recipient { address: b, cap: 0 }],
        period_ledgers: DAY,
        max_payments: 10,
    };
    let bytes = p.to_xdr(&e);
    let mut v = std::vec::Vec::new();
    for i in 0..bytes.len() {
        v.push(bytes.get_unchecked(i));
    }
    std::println!("FIXTURE {}", hex(&v));
}

fn hex(b: &[u8]) -> std::string::String {
    b.iter().map(|x| std::format!("{:02x}", x)).collect()
}
