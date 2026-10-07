//! # ACAN merchant allowlist policy
//!
//! An OpenZeppelin smart-account policy (stellar-contracts v0.7) that limits a
//! context rule to token transfers whose recipient is on an allowlist.
//!
//! ACAN attaches it, next to the spending-limit policy, to the context rule
//! that authorizes an AI agent's key on the guardian's smart account. The
//! agent can then pay only the merchants the guardian approved (plus its own
//! confidential vault, for top-ups), and only within the spending limit. Any
//! other recipient, or any call other than `transfer`, makes the smart
//! account's `__check_auth` fail.
//!
//! One deployment serves any number of smart accounts: each (account,
//! context rule) pair stores its own allowlist.
#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, symbol_short,
    Address, Env, TryFromVal, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, ContextRuleType, Signer},
};

/// Maximum recipients per allowlist (keeps enforcement cheap).
pub const MAX_RECIPIENTS: u32 = 20;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum AllowlistError {
    /// No allowlist is installed for this account and rule.
    NotInstalled = 3400,
    /// The transfer's recipient is not on the allowlist.
    RecipientNotAllowed = 3401,
    /// The call is not a token transfer, or no signer was authenticated.
    NotAllowed = 3402,
    /// An allowlist is already installed for this account and rule.
    AlreadyInstalled = 3403,
    /// The allowlist is empty, too long, or has duplicates.
    InvalidParams = 3404,
    /// The policy only applies to CallContract context rules.
    OnlyCallContractAllowed = 3405,
}

/// Installation parameters: the recipients this rule may pay.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AllowlistParams {
    pub recipients: Vec<Address>,
}

#[contracttype]
pub enum AllowlistKey {
    AccountContext(Address, u32),
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct AllowlistInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub recipients: Vec<Address>,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct AllowlistUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

#[contract]
pub struct MerchantAllowlistPolicy;

#[contractimpl]
impl Policy for MerchantAllowlistPolicy {
    type AccountParams = AllowlistParams;

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();
        if authenticated_signers.is_empty() {
            panic_with_error!(e, AllowlistError::NotAllowed)
        }
        let recipients = load(e, &smart_account, context_rule.id);
        match context {
            Context::Contract(ContractContext { fn_name, args, .. }) if fn_name == symbol_short!("transfer") => {
                let to = args
                    .get(1)
                    .and_then(|v| Address::try_from_val(e, &v).ok())
                    .unwrap_or_else(|| panic_with_error!(e, AllowlistError::NotAllowed));
                if !recipients.contains(&to) {
                    panic_with_error!(e, AllowlistError::RecipientNotAllowed)
                }
            }
            _ => panic_with_error!(e, AllowlistError::NotAllowed),
        }
    }

    fn install(e: &Env, install_params: AllowlistParams, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();
        if !matches!(context_rule.context_type, ContextRuleType::CallContract(_)) {
            panic_with_error!(e, AllowlistError::OnlyCallContractAllowed)
        }
        let r = &install_params.recipients;
        if r.is_empty() || r.len() > MAX_RECIPIENTS {
            panic_with_error!(e, AllowlistError::InvalidParams)
        }
        for i in 0..r.len() {
            for j in (i + 1)..r.len() {
                if r.get_unchecked(i) == r.get_unchecked(j) {
                    panic_with_error!(e, AllowlistError::InvalidParams)
                }
            }
        }
        let key = AllowlistKey::AccountContext(smart_account.clone(), context_rule.id);
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, AllowlistError::AlreadyInstalled)
        }
        e.storage().persistent().set(&key, r);
        AllowlistInstalled { smart_account, context_rule_id: context_rule.id, recipients: r.clone() }.publish(e);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();
        let key = AllowlistKey::AccountContext(smart_account.clone(), context_rule.id);
        if !e.storage().persistent().has(&key) {
            panic_with_error!(e, AllowlistError::NotInstalled)
        }
        e.storage().persistent().remove(&key);
        AllowlistUninstalled { smart_account, context_rule_id: context_rule.id }.publish(e);
    }
}

#[contractimpl]
impl MerchantAllowlistPolicy {
    /// The recipients a smart account's context rule may pay.
    pub fn get_recipients(e: Env, context_rule_id: u32, smart_account: Address) -> Vec<Address> {
        load(&e, &smart_account, context_rule_id)
    }
}

fn load(e: &Env, smart_account: &Address, rule_id: u32) -> Vec<Address> {
    e.storage()
        .persistent()
        .get(&AllowlistKey::AccountContext(smart_account.clone(), rule_id))
        .unwrap_or_else(|| panic_with_error!(e, AllowlistError::NotInstalled))
}

#[cfg(test)]
mod test;
