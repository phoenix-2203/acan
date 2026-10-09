//! OpenZeppelin's `weighted_threshold` policy (stellar-accounts 0.7.2),
//! deployed as-is. ACAN installs it on a provenance-gated agent rule with
//! weights {agent: 1, co-signer: W} and threshold W + 1, where W is at least
//! the number of agent keys on the rule, so no set of agent keys can authorize
//! a payment without the provenance co-signer. All logic is OpenZeppelin's;
//! this crate only exposes it as a contract.
#![no_std]

use soroban_sdk::{auth::Context, contract, contractimpl, Address, Env, Vec};
use stellar_accounts::{
    policies::{weighted_threshold, Policy},
    smart_account::{ContextRule, Signer},
};

#[contract]
pub struct CosignerGatePolicy;

#[contractimpl]
impl Policy for CosignerGatePolicy {
    type AccountParams = weighted_threshold::WeightedThresholdAccountParams;

    fn enforce(e: &Env, context: Context, authenticated_signers: Vec<Signer>, context_rule: ContextRule, smart_account: Address) {
        weighted_threshold::enforce(e, &context, &authenticated_signers, &context_rule, &smart_account)
    }

    fn install(e: &Env, params: Self::AccountParams, context_rule: ContextRule, smart_account: Address) {
        weighted_threshold::install(e, &params, &context_rule, &smart_account)
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        weighted_threshold::uninstall(e, &context_rule, &smart_account)
    }
}

#[contractimpl]
impl CosignerGatePolicy {
    /// The threshold installed for one account's rule.
    pub fn get_threshold(e: &Env, context_rule_id: u32, smart_account: Address) -> u32 {
        weighted_threshold::get_threshold(e, context_rule_id, &smart_account)
    }
}

#[cfg(test)]
mod test;
