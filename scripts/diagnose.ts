/**
 * Builds one signed x402 payment from the smart account (without sending it
 * to the merchant) and asks two facilitators to verify it:
 *   1. the public one at x402.org
 *   2. the same @x402/stellar facilitator code run locally with a higher fee ceiling
 * Prints the exact verdict and reason from each, plus the payment's fee.
 */
import { Transaction } from "@stellar/stellar-sdk";
import { x402Client } from "@x402/fetch";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createEd25519Signer } from "@x402/stellar";
import {
  ASSETS,
  SmartAccountAgentSigner,
  SmartAccountAwareFacilitator,
  SmartAccountExactStellarScheme,
  TESTNET,
  loadEnv,
  requireEnv,
} from "@acan/core";

loadEnv();

async function main() {
  const signer = new SmartAccountAgentSigner({
    smartAccount: requireEnv("SMART_ACCOUNT"),
    agentSecret: requireEnv("AGENT_SECRET"),
    contextRuleId: Number(requireEnv("AGENT_RULE_ID")),
    networkPassphrase: TESTNET.networkPassphrase,
  });

  const requirements = {
    scheme: "exact",
    network: TESTNET.x402Network,
    asset: ASSETS.usdc.sac,
    amount: "100000",
    payTo: requireEnv("MERCHANT_ADDRESS"),
    maxTimeoutSeconds: 300,
    extra: { areFeesSponsored: true },
  } as any;

  const client = new x402Client().register("stellar:*", new SmartAccountExactStellarScheme(signer, { url: TESTNET.rpcUrl }));
  const payload = await client.createPaymentPayload({
    x402Version: 2,
    resource: { url: "http://localhost/diagnose", description: "diagnose", mimeType: "application/json" },
    accepts: [requirements],
  } as any);

  const tx = new Transaction((payload.payload as any).transaction, TESTNET.networkPassphrase);
  const sd = tx.toEnvelope().v1().tx().ext().sorobanData();
  console.log(`payment built OK   inner fee=${tx.fee}  resourceFee=${sd.resourceFee().toString()} stroops`);
  console.log(`                   instructions=${sd.resources().instructions()}`);

  const pub = new HTTPFacilitatorClient({ url: TESTNET.facilitatorUrl });
  try {
    const supported = await pub.getSupported();
    const stellar = supported.kinds.filter((k: any) => String(k.network).startsWith("stellar"));
    console.log(`public facilitator supports: ${JSON.stringify(stellar)}`);
    const v = await pub.verify(payload as any, requirements);
    console.log(`public facilitator verify:  isValid=${v.isValid}  reason=${v.invalidReason ?? "-"}  ${v.invalidMessage ?? ""}`);
  } catch (e) {
    console.log(`public facilitator error: ${e instanceof Error ? e.message : e}`);
  }

  const local = new SmartAccountAwareFacilitator([createEd25519Signer(requireEnv("FACILITATOR_SECRET"), TESTNET.x402Network)], {
    rpcConfig: { url: TESTNET.rpcUrl },
    maxTransactionFeeStroops: Number(process.env.FACILITATOR_MAX_FEE_STROOPS ?? 10_000_000),
  });
  const lv = await local.verify(payload as any, requirements);
  console.log(`local facilitator verify:   isValid=${lv.isValid}  reason=${(lv as any).invalidReason ?? "-"}  ${(lv as any).invalidMessage ?? ""}`);
}

main().catch((e) => {
  console.error(`DIAGNOSE FAILED: ${e instanceof Error ? e.stack : e}`);
  process.exit(1);
});
