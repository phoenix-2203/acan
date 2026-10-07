/**
 * Prove a per-merchant cap on testnet: read the cap the guardian set for
 * merchant A on the agent's rule, then have the agent try to pay merchant A
 * slightly more than what is left of it. The smart account refuses during
 * authorization (RecipientCapExceeded), so nothing is sent.
 *
 * Usage: npm run demo:caps
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
  PaymentRejectedError,
  SmartAccountAgentSigner,
  TESTNET,
  loadEnv,
  merchantPolicyState,
  requireEnv,
  smartAccountTransfer,
  stroopsToUsdc,
} from "@acan/core";

loadEnv();

async function main() {
  const smartAccount = requireEnv("SMART_ACCOUNT");
  const ruleId = Number(requireEnv("AGENT_RULE_ID"));
  const merchant = requireEnv("MERCHANT_ADDRESS");
  const { params, usage } = await merchantPolicyState(requireEnv("ALLOWLIST_POLICY"), smartAccount, ruleId);
  const entry = params.recipients.find((r) => r.address === merchant);
  if (!entry) throw new Error(`merchant A is not on rule ${ruleId}'s allowlist`);
  if (entry.cap === 0n) throw new Error(`merchant A has no cap on rule ${ruleId}; set one in the dashboard first`);
  const spent = usage.spent.get(merchant) ?? 0n;
  const attempt = entry.cap - spent + 10_000n; // 0.001 USDC over what is left
  console.log(
    `merchant A cap ${stroopsToUsdc(entry.cap)} USDC per period, used ${stroopsToUsdc(spent)}; ` +
      `the agent tries to pay ${stroopsToUsdc(attempt)}…`,
  );
  const signer = new SmartAccountAgentSigner({
    smartAccount,
    agentSecret: requireEnv("AGENT_SECRET"),
    contextRuleId: ruleId,
    networkPassphrase: TESTNET.networkPassphrase,
  });
  try {
    const hash = await smartAccountTransfer({
      signer,
      source: Keypair.fromSecret(requireEnv("AGENT_VAULT_SECRET")),
      to: merchant,
      amount: attempt,
    });
    console.log(`UNEXPECTED: the payment went through (${hash}).`);
    process.exitCode = 1;
  } catch (e) {
    if (e instanceof PaymentRejectedError) {
      console.log(`REFUSED by the smart account: ${e.message}`);
      console.log("Nothing was sent; merchant A cannot take more than its own slice of the allowance.");
      return;
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(`DEMO FAILED: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
