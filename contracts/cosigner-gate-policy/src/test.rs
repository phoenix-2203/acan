//! The gate as ACAN installs it: an OZ smart account rule with the agent and the
//! provenance co-signer as signers, this policy, and nothing else. (The real
//! ed25519 path, the limits and the TypeScript co-signer's signatures are
//! covered by research/prototype/soroban.)
extern crate std;

use soroban_sdk::{
    auth::{Context, ContractContext},
    map, symbol_short,
    testutils::Address as _,
    vec, Address, Bytes, BytesN, Env, IntoVal, Map, Val,
};
use stellar_accounts::{
    policies::weighted_threshold::WeightedThresholdAccountParams,
    smart_account::{AuthPayload, ContextRule, ContextRuleType, Signer},
};

use crate::{CosignerGatePolicy, CosignerGatePolicyClient};

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
        pub fn add_rule(e: &Env, context_type: ContextRuleType, signers: Vec<Signer>, policies: Map<Address, Val>) -> ContextRule {
            smart_account::add_context_rule(e, &context_type, &String::from_str(e, "agent"), None, &signers, &policies)
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

const NOT_ALLOWED: u32 = 3213;

struct World {
    e: Env,
    account: Address,
    token: Address,
    policy: Address,
}

fn world() -> World {
    let e = Env::default();
    e.mock_all_auths_allowing_non_root_auth();
    let account = e.register(account::TestAccount, ());
    let policy = e.register(CosignerGatePolicy, ());
    let token = Address::generate(&e);
    World { e, account, token, policy }
}

impl World {
    fn signer(&self) -> Signer {
        Signer::Delegated(Address::generate(&self.e))
    }

    fn rule(&self, signers: &[(Signer, u32)], threshold: u32) -> ContextRule {
        let e = &self.e;
        let mut list = vec![e];
        let mut weights = Map::new(e);
        for (s, w) in signers {
            list.push_back(s.clone());
            weights.set(s.clone(), *w);
        }
        let policies: Map<Address, Val> = map![e, (self.policy.clone(), WeightedThresholdAccountParams { signer_weights: weights, threshold }.into_val(e))];
        account::TestAccountClient::new(e, &self.account).add_rule(&ContextRuleType::CallContract(self.token.clone()), &list, &policies)
    }

    fn check(&self, rule: u32, signed: &[&Signer]) -> Result<(), u32> {
        let e = &self.e;
        let mut signers = Map::new(e);
        for s in signed {
            signers.set((*s).clone(), Bytes::new(e));
        }
        let auth = AuthPayload { signers, context_rule_ids: vec![e, rule] };
        let ctx = Context::Contract(ContractContext {
            contract: self.token.clone(),
            fn_name: symbol_short!("transfer"),
            args: vec![e, self.account.into_val(e), Address::generate(e).into_val(e), 10i128.into_val(e)],
        });
        let hash = BytesN::from_array(e, &[1; 32]);
        match e.try_invoke_contract_check_auth::<soroban_sdk::Error>(&self.account, &hash, auth.into_val(e), &vec![e, ctx]) {
            Ok(()) => Ok(()),
            Err(Ok(err)) => Err(err.get_code()),
            Err(Err(_)) => Err(0),
        }
    }
}

#[test]
fn agent_needs_the_cosigner() {
    let w = world();
    let (agent, cos) = (w.signer(), w.signer());
    let rule = w.rule(&[(agent.clone(), 1), (cos.clone(), 1)], 2);
    assert_eq!(w.check(rule.id, &[&agent]), Err(NOT_ALLOWED));
    assert_eq!(w.check(rule.id, &[&cos]), Err(NOT_ALLOWED));
    assert_eq!(w.check(rule.id, &[&agent, &cos]), Ok(()));
    assert_eq!(CosignerGatePolicyClient::new(&w.e, &w.policy).get_threshold(&rule.id, &w.account), 2);
}

#[test]
fn several_agent_keys_still_need_the_cosigner_when_its_weight_covers_them() {
    let w = world();
    let (a, b, cos) = (w.signer(), w.signer(), w.signer());
    let rule = w.rule(&[(a.clone(), 1), (b.clone(), 1), (cos.clone(), 2)], 3);
    assert_eq!(w.check(rule.id, &[&a, &b]), Err(NOT_ALLOWED));
    assert_eq!(w.check(rule.id, &[&a, &cos]), Ok(()));
}
