/**
 * Prove the merchant allowlist on testnet: the agent's key tries to send
 * 0.001 USDC from the guardian's smart account to an address that is NOT on
 * the allowlist (by default the treasury account). The smart account refuses during simulation, so nothing is
 * sent and no fee is spent.
 *
 * Usage: npm run demo:allowlist  [-- <G... recipient with a USDC trustline>]
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
  PaymentRejectedError,
  SmartAccountAgentSigner,
  TESTNET,
  loadEnv,
  requireEnv,
  smartAccountTransfer,
  usdcToStroops,
} from "@acan/core";

loadEnv();

async function main() {
  // Default recipient: the treasury. It holds a USDC trustline (so the transfer
  // itself would be valid) but it is not on the agent's allowlist.
  const to = process.argv[2] ?? requireEnv("TREASURY_ADDRESS");
  const signer = new SmartAccountAgentSigner({
    smartAccount: requireEnv("SMART_ACCOUNT"),
    agentSecret: requireEnv("AGENT_SECRET"),
    contextRuleId: Number(requireEnv("AGENT_RULE_ID")),
    networkPassphrase: TESTNET.networkPassphrase,
  });
  // The vault only pays the network fee if a transaction is ever sent.
  const feePayer = Keypair.fromSecret(requireEnv("AGENT_VAULT_SECRET"));
  console.log(`agent tries to pay 0.001 USDC from the smart account to ${to} (not on the allowlist)…`);
  try {
    const hash = await smartAccountTransfer({ signer, source: feePayer, to, amount: usdcToStroops("0.001") });
    console.log(`UNEXPECTED: the payment went through (${hash}). Is the allowlist installed on rule ${signer.contextRuleId}?`);
    process.exitCode = 1;
  } catch (e) {
    if (e instanceof PaymentRejectedError) {
      console.log(`REFUSED by the smart account: ${e.message}`);
      console.log("Nothing was sent; the allowlist policy rejected the recipient during authorization.");
      return;
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(`DEMO FAILED: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
