//! # ACAN recovery scope policy
//!
//! An OpenZeppelin smart-account policy (stellar-accounts 0.7.2) for the
//! context rule that holds a guardian's **recovery key**. The rule is scoped to
//! the smart account's own address (`CallContract(account)`), and this policy
//! narrows it to exactly one action:
//!
//! - `add_context_rule(Default, name, None, [one passkey], {})` on the smart
//!   account itself: a new rule for a new passkey, with no expiry, no
//!   policies, and exactly one signer verified by the passkey (WebAuthn)
//!   verifier.
//!
//! The new passkey gets a rule of its own rather than joining the guardian's
//! existing rule: OpenZeppelin requires every signer of a rule without
//! policies to sign, so a second passkey on the same rule would lock both
//! devices out of it.
//!
//! Everything else the account's own address can do is refused, in
//! particular `execute` (which would let the key make any call as the account,
//! including a payment), `upgrade`, and adding signers or policies to existing
//! rules. A token transfer is a call to the token, not to the account, so the
//! rule's context type already refuses it.
//!
//! With policies attached, OpenZeppelin leaves signer checks to the policies,
//! so this policy also requires every signer on the rule to have signed.
#![no_std]

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address, Env, Map, Symbol, TryFromVal, Val, Vec,
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
    /// Anything other than adding one passkey under a new rule of its own.
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
    /// The passkey (WebAuthn) verifier contract the new signer must use.
    pub passkey_verifier: Address,
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
    pub passkey_verifier: Address,
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
                contract == smart_account && fn_name == Symbol::new(e, "add_context_rule") && is_one_new_passkey(e, &args, &params.passkey_verifier)
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
        RecoveryScopeInstalled { smart_account, context_rule_id: context_rule.id, passkey_verifier: install_params.passkey_verifier.clone() }.publish(e);
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

/// `add_context_rule(Default, _name, None, [External(passkey_verifier, _)], {})`.
fn is_one_new_passkey(e: &Env, args: &Vec<Val>, passkey_verifier: &Address) -> bool {
    if args.len() != 5 {
        return false;
    }
    let Ok(context_type) = ContextRuleType::try_from_val(e, &args.get_unchecked(0)) else { return false };
    let Ok(valid_until) = Option::<u32>::try_from_val(e, &args.get_unchecked(2)) else { return false };
    let Ok(signers) = Vec::<Signer>::try_from_val(e, &args.get_unchecked(3)) else { return false };
    let Ok(policies) = Map::<Address, Val>::try_from_val(e, &args.get_unchecked(4)) else { return false };
    if context_type != ContextRuleType::Default || valid_until.is_some() || !policies.is_empty() || signers.len() != 1 {
        return false;
    }
    matches!(signers.get_unchecked(0), Signer::External(verifier, _) if verifier == *passkey_verifier)
}

fn load_params(e: &Env, smart_account: &Address, rule_id: u32) -> RecoveryScopeParams {
    e.storage()
        .persistent()
        .get(&StorageKey::Params(smart_account.clone(), rule_id))
        .unwrap_or_else(|| panic_with_error!(e, RecoveryScopeError::NotInstalled))
}

#[cfg(test)]
mod test;
