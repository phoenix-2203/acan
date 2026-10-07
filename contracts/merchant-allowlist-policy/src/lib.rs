//! # ACAN merchant budget policy
//!
//! An OpenZeppelin smart-account policy (stellar-contracts v0.7) for a
//! context rule that authorizes an AI agent. It limits the rule to token
//! transfers and, on top of the account's overall spending limit, adds:
//!
//! - an **allowlist**: the rule may only pay listed recipients;
//! - a **cap per recipient**: at most `cap` to each recipient per period, so a
//!   single misbehaving or compromised merchant can only take its own slice;
//! - a **payment-count limit**: at most `max_payments` transfers per period,
//!   which stops runaway loops of small payments.
//!
//! Periods are fixed windows of `period_ledgers` ledgers that restart on the
//! first payment after a window ends. One deployment serves any number of
//! smart accounts: each (account, context rule) pair has its own settings.
#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, symbol_short,
    Address, Env, Map, TryFromVal, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, ContextRuleType, Signer},
};

/// Maximum recipients per rule (keeps enforcement cheap).
pub const MAX_RECIPIENTS: u32 = 20;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum MerchantPolicyError {
    /// No policy is installed for this account and rule.
    NotInstalled = 3400,
    /// The transfer's recipient is not on the allowlist.
    RecipientNotAllowed = 3401,
    /// The call is not a token transfer, or no signer was authenticated.
    NotAllowed = 3402,
    /// A policy is already installed for this account and rule.
    AlreadyInstalled = 3403,
    /// Empty, too many or duplicate recipients, a negative cap or amount, or a zero period.
    InvalidParams = 3404,
    /// The policy only applies to CallContract context rules.
    OnlyCallContractAllowed = 3405,
    /// This payment would exceed the recipient's cap for the current period.
    RecipientCapExceeded = 3406,
    /// This payment would exceed the number of payments allowed per period.
    TooManyPayments = 3407,
}

/// One allowed recipient. `cap` is the most it may receive per period
/// (atomic units); 0 means no per-recipient cap (allowlist only).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Recipient {
    pub address: Address,
    pub cap: i128,
}

/// Installation parameters.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MerchantPolicyParams {
    pub recipients: Vec<Recipient>,
    /// Length of a period in ledgers (about 5 s each; 17,280 is about a day).
    pub period_ledgers: u32,
    /// Payments allowed per period; 0 means no limit.
    pub max_payments: u32,
}

/// Usage in the current period.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PeriodState {
    pub window_start: u32,
    pub payments: u32,
    /// Amount paid to each recipient in this period.
    pub spent: Map<Address, i128>,
}

#[contracttype]
pub enum StorageKey {
    Params(Address, u32),
    State(Address, u32),
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct MerchantPolicyInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub params: MerchantPolicyParams,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct MerchantPolicyUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

#[contract]
pub struct MerchantBudgetPolicy;

#[contractimpl]
impl Policy for MerchantBudgetPolicy {
    type AccountParams = MerchantPolicyParams;

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();
        if authenticated_signers.is_empty() {
            panic_with_error!(e, MerchantPolicyError::NotAllowed)
        }
        let params = load_params(e, &smart_account, context_rule.id);
        let (to, amount) = match context {
            Context::Contract(ContractContext { fn_name, args, .. }) if fn_name == symbol_short!("transfer") => {
                let to = args
                    .get(1)
                    .and_then(|v| Address::try_from_val(e, &v).ok())
                    .unwrap_or_else(|| panic_with_error!(e, MerchantPolicyError::NotAllowed));
                let amount = args
                    .get(2)
                    .and_then(|v| i128::try_from_val(e, &v).ok())
                    .unwrap_or_else(|| panic_with_error!(e, MerchantPolicyError::NotAllowed));
                (to, amount)
            }
            _ => panic_with_error!(e, MerchantPolicyError::NotAllowed),
        };
        if amount < 0 {
            panic_with_error!(e, MerchantPolicyError::InvalidParams)
        }
        let cap = match params.recipients.iter().find(|r| r.address == to) {
            Some(r) => r.cap,
            None => panic_with_error!(e, MerchantPolicyError::RecipientNotAllowed),
        };

        let key = StorageKey::State(smart_account.clone(), context_rule.id);
        let now = e.ledger().sequence();
        let mut state: PeriodState = e.storage().persistent().get(&key).unwrap_or(PeriodState {
            window_start: now,
            payments: 0,
            spent: Map::new(e),
        });
        if now >= state.window_start.saturating_add(params.period_ledgers) {
            state = PeriodState { window_start: now, payments: 0, spent: Map::new(e) };
        }

        let already = state.spent.get(to.clone()).unwrap_or(0);
        let total = already.checked_add(amount).unwrap_or_else(|| panic_with_error!(e, MerchantPolicyError::InvalidParams));
        if cap > 0 && total > cap {
            panic_with_error!(e, MerchantPolicyError::RecipientCapExceeded)
        }
        if params.max_payments > 0 && state.payments >= params.max_payments {
            panic_with_error!(e, MerchantPolicyError::TooManyPayments)
        }
        state.payments += 1;
        state.spent.set(to, total);
        e.storage().persistent().set(&key, &state);
    }

    fn install(e: &Env, install_params: MerchantPolicyParams, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();
        if !matches!(context_rule.context_type, ContextRuleType::CallContract(_)) {
            panic_with_error!(e, MerchantPolicyError::OnlyCallContractAllowed)
        }
        validate(e, &install_params);
        let key = StorageKey::Params(smart_account.clone(), context_rule.id);
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, MerchantPolicyError::AlreadyInstalled)
        }
        e.storage().persistent().set(&key, &install_params);
        MerchantPolicyInstalled { smart_account, context_rule_id: context_rule.id, params: install_params }.publish(e);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();
        let key = StorageKey::Params(smart_account.clone(), context_rule.id);
        if !e.storage().persistent().has(&key) {
            panic_with_error!(e, MerchantPolicyError::NotInstalled)
        }
        e.storage().persistent().remove(&key);
        e.storage().persistent().remove(&StorageKey::State(smart_account.clone(), context_rule.id));
        MerchantPolicyUninstalled { smart_account, context_rule_id: context_rule.id }.publish(e);
    }
}

#[contractimpl]
impl MerchantBudgetPolicy {
    /// The settings a smart account's context rule was installed with.
    pub fn get_params(e: Env, context_rule_id: u32, smart_account: Address) -> MerchantPolicyParams {
        load_params(&e, &smart_account, context_rule_id)
    }

    /// The recipients a smart account's context rule may pay (allowlist view).
    pub fn get_recipients(e: Env, context_rule_id: u32, smart_account: Address) -> Vec<Address> {
        let params = load_params(&e, &smart_account, context_rule_id);
        let mut out = Vec::new(&e);
        for r in params.recipients.iter() {
            out.push_back(r.address);
        }
        out
    }

    /// Usage in the current period (an expired window reads as empty).
    pub fn get_state(e: Env, context_rule_id: u32, smart_account: Address) -> PeriodState {
        let params = load_params(&e, &smart_account, context_rule_id);
        let now = e.ledger().sequence();
        let empty = PeriodState { window_start: now, payments: 0, spent: Map::new(&e) };
        match e.storage().persistent().get::<_, PeriodState>(&StorageKey::State(smart_account, context_rule_id)) {
            Some(s) if now < s.window_start.saturating_add(params.period_ledgers) => s,
            _ => empty,
        }
    }
}

fn validate(e: &Env, p: &MerchantPolicyParams) {
    let r = &p.recipients;
    if r.is_empty() || r.len() > MAX_RECIPIENTS || p.period_ledgers == 0 {
        panic_with_error!(e, MerchantPolicyError::InvalidParams)
    }
    for i in 0..r.len() {
        let a = r.get_unchecked(i);
        if a.cap < 0 {
            panic_with_error!(e, MerchantPolicyError::InvalidParams)
        }
        for j in (i + 1)..r.len() {
            if a.address == r.get_unchecked(j).address {
                panic_with_error!(e, MerchantPolicyError::InvalidParams)
            }
        }
    }
}

fn load_params(e: &Env, smart_account: &Address, rule_id: u32) -> MerchantPolicyParams {
    e.storage()
        .persistent()
        .get(&StorageKey::Params(smart_account.clone(), rule_id))
        .unwrap_or_else(|| panic_with_error!(e, MerchantPolicyError::NotInstalled))
}

#[cfg(test)]
mod test;
