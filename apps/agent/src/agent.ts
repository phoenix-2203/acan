/**
 * ACAN demo agent.
 *
 * An autonomous loop that buys data from an x402-protected API. It never holds
 * a funded wallet: it signs for the guardian's smart account with a key that
 * the account only honours under a context rule scoped to USDC transfers and
 * capped by an on-chain spending-limit policy. When the cap is reached the
 * account itself refuses to authorize the payment.
 *
 * Usage: npm run agent -- [requests=10] [delayMs=1500]
 */
import { x402Client, x402HTTPClient } from "@x402/fetch";
import {
  PaymentRejectedError,
  SmartAccountAgentSigner,
  SmartAccountExactStellarScheme,
  TESTNET,
  explorerTx,
  loadEnv,
  requireEnv,
  spendingLimitState,
  stroopsToUsdc,
  tokenBalance,
} from "@acan/core";

loadEnv();

const MERCHANT_URL = process.env.MERCHANT_URL ?? `http://localhost:${process.env.MERCHANT_PORT ?? 4021}`;
const ENDPOINT = `${MERCHANT_URL}/api/insight`;
const REQUESTS = Number(process.argv[2] ?? 10);
const DELAY_MS = Number(process.argv[3] ?? 1500);

const smartAccount = requireEnv("SMART_ACCOUNT");
const ruleId = Number(requireEnv("AGENT_RULE_ID"));

const signer = new SmartAccountAgentSigner({
  smartAccount,
  agentSecret: requireEnv("AGENT_SECRET"),
  contextRuleId: ruleId,
  networkPassphrase: TESTNET.networkPassphrase,
});

const client = new x402Client().register(
  "stellar:*",
  new SmartAccountExactStellarScheme(signer, { url: TESTNET.rpcUrl }),
);
const http = new x402HTTPClient(client);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

async function allowanceLine(): Promise<string> {
  try {
    const s = await spendingLimitState(smartAccount, ruleId);
    const left = BigInt(s.spending_limit) - BigInt(s.cached_total_spent);
    return `allowance left ${stroopsToUsdc(left)}/${stroopsToUsdc(s.spending_limit)} USDC`;
  } catch {
    return "allowance unavailable";
  }
}

async function buyOnce(i: number): Promise<"paid" | "blocked" | "error"> {
  const first = await fetch(ENDPOINT);
  if (first.status !== 402) {
    console.log(`[${ts()}] #${i} unexpected status ${first.status} (expected 402)`);
    return "error";
  }
  const required = http.getPaymentRequiredResponse((name) => first.headers.get(name));
  const req = required.accepts[0];
  console.log(`[${ts()}] #${i} 402 Payment Required: ${stroopsToUsdc(req.amount)} USDC to ${req.payTo.slice(0, 6)}…`);

  let payload;
  try {
    payload = await client.createPaymentPayload(required);
  } catch (err) {
    if (err instanceof PaymentRejectedError || (err as Error)?.cause instanceof PaymentRejectedError) {
      const reason = err instanceof PaymentRejectedError ? err.message : ((err as Error).cause as Error).message;
      console.log(`[${ts()}] #${i} BLOCKED by the smart account: ${reason}`);
      return "blocked";
    }
    throw err;
  }

  const paid = await fetch(ENDPOINT, { headers: http.encodePaymentSignatureHeader(payload) });
  if (paid.status !== 200) {
    console.log(`[${ts()}] #${i} merchant refused payment: HTTP ${paid.status} ${(await paid.text()).slice(0, 300)}`);
    return "error";
  }
  const body = await paid.json();
  const settle = http.getPaymentSettleResponse((name) => paid.headers.get(name));
  console.log(`[${ts()}] #${i} PAID  ${explorerTx(settle.transaction)}`);
  console.log(`          got: "${body.insight}"   (${await allowanceLine()})`);
  return "paid";
}

async function main() {
  console.log(`ACAN agent  ->  ${ENDPOINT}`);
  console.log(`paying from smart account ${smartAccount} (rule ${ruleId})`);
  console.log(`agent key ${signer.agentAddress} holds no funds`);
  console.log(`balance ${stroopsToUsdc(await tokenBalance(smartAccount))} USDC, ${await allowanceLine()}\n`);

  let paid = 0;
  for (let i = 1; i <= REQUESTS; i++) {
    const result = await buyOnce(i);
    if (result === "paid") paid++;
    if (result === "blocked") {
      console.log(`\nAgent stopped: the guardian's on-chain limit held. ${paid} purchase(s) completed.`);
      return;
    }
    if (result === "error") process.exitCode = 1;
    if (i < REQUESTS) await sleep(DELAY_MS);
  }
  console.log(`\nDone: ${paid}/${REQUESTS} purchases completed.`);
}

main().catch((e) => {
  console.error(`\nAGENT FAILED: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
