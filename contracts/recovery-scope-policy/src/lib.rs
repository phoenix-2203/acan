//! # ACAN recovery scope policy
//!
//! An OpenZeppelin smart-account policy (stellar-accounts 0.7.2) for the
//! context rule that holds a guardian's **recovery key**. The rule is scoped to
//! the smart account's own address (`CallContract(account)`), and this policy
//! narrows it to exactly one action:
//!
//! - `add_signer(admin_rule_id, signer)` on the smart account itself, where
//!   `admin_rule_id` is the guardian's own rule (the passkey's rule).
//!
//! Everything else the account's own address can do is refused, in
//! particular `execute` (which would let the key make any call as the account,
//! including a payment) and `upgrade`. A token transfer is a call to the token,
//! not to the account, so the rule's context type already refuses it.
//!
//! With policies attached, OpenZeppelin leaves signer checks to the policies,
//! so this policy also requires every signer on the rule to have signed.
//!
//! Recovery therefore means: on a new device, the key adds a new passkey to the
//! guardian's rule. It can never pay from the account on its own.
#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address, Env, Symbol, TryFromVal, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, ContextRuleType, Signer},
};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum RecoveryScopeError {
    NotInstalled = 3500,
    /// Anything other than adding a signer to the guardian's rule.
    NotAllowed = 3501,
    /// A signer on the recovery rule did not sign.
    MissingSignature = 3502,
    AlreadyInstalled = 3503,
    /// The rule must be scoped to the smart account's own address.
    OnlyOwnAccount = 3504,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RecoveryScopeParams {
    /// The guardian's own rule (the passkey's), the only rule the key may add a signer to.
    pub admin_rule_id: u32,
}

#[contracttype]
pub enum StorageKey {
    Params(Address, u32),
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct RecoveryScopeInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub admin_rule_id: u32,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct RecoveryScopeUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

#[contract]
pub struct RecoveryScopePolicy;

#[contractimpl]
impl Policy for RecoveryScopePolicy {
    type AccountParams = RecoveryScopeParams;

    fn enforce(e: &Env, context: Context, authenticated_signers: Vec<Signer>, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();
        let params = load_params(e, &smart_account, context_rule.id);
        // OpenZeppelin passes only the rule's signers that signed; all of them must have.
        if context_rule.signers.is_empty() || authenticated_signers.len() != context_rule.signers.len() {
            panic_with_error!(e, RecoveryScopeError::MissingSignature)
        }
        let allowed = match context {
            Context::Contract(ContractContext { contract, fn_name, args }) => {
                contract == smart_account
                    && fn_name == Symbol::new(e, "add_signer")
                    && args.len() == 2
                    && u32::try_from_val(e, &args.get_unchecked(0)).ok() == Some(params.admin_rule_id)
            }
            _ => false,
        };
        if !allowed {
            panic_with_error!(e, RecoveryScopeError::NotAllowed)
        }
    }

    fn install(e: &Env, install_params: RecoveryScopeParams, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();
        if context_rule.context_type != ContextRuleType::CallContract(smart_account.clone()) {
            panic_with_error!(e, RecoveryScopeError::OnlyOwnAccount)
        }
        let key = StorageKey::Params(smart_account.clone(), context_rule.id);
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, RecoveryScopeError::AlreadyInstalled)
        }
        e.storage().persistent().set(&key, &install_params);
        RecoveryScopeInstalled { smart_account, context_rule_id: context_rule.id, admin_rule_id: install_params.admin_rule_id }.publish(e);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();
        let key = StorageKey::Params(smart_account.clone(), context_rule.id);
        if !e.storage().persistent().has(&key) {
            panic_with_error!(e, RecoveryScopeError::NotInstalled)
        }
        e.storage().persistent().remove(&key);
        RecoveryScopeUninstalled { smart_account, context_rule_id: context_rule.id }.publish(e);
    }
}

#[contractimpl]
impl RecoveryScopePolicy {
    /// The settings a smart account's recovery rule was installed with.
    pub fn get_params(e: Env, context_rule_id: u32, smart_account: Address) -> RecoveryScopeParams {
        load_params(&e, &smart_account, context_rule_id)
    }
}

fn load_params(e: &Env, smart_account: &Address, rule_id: u32) -> RecoveryScopeParams {
    e.storage()
        .persistent()
        .get(&StorageKey::Params(smart_account.clone(), rule_id))
        .unwrap_or_else(|| panic_with_error!(e, RecoveryScopeError::NotInstalled))
}

#[cfg(test)]
mod test;
