/**
 * ACAN agent, private mode (Milestone B).
 *
 * Buys from an x402 route that uses the "acan-tab" scheme. Each request is
 * paid with a signed voucher (no transaction, no on-chain trace). Every few
 * requests the agent settles the whole tab in ONE confidential transfer whose
 * amount is hidden on-chain. Money reaches the agent's confidential vault
 * only through the guardian's smart account and its spending-limit policy.
 *
 * Usage: npm run agent:private -- [requests=7] [delayMs=1000]
 */
import { Keypair } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import {
  PaymentRejectedError,
  SmartAccountAgentSigner,
  TESTNET,
  TabClientScheme,
  explorerTx,
  loadEnv,
  requireEnv,
  spendingLimitState,
  stroopsToUsdc,
  usdcToStroops,
} from "@acan/core";
import { CONFIDENTIAL_TESTNET, ConfidentialAccount, ConfidentialVault } from "@acan/confidential";

loadEnv();

const MERCHANT_URL = process.env.MERCHANT_URL ?? `http://localhost:${process.env.MERCHANT_PORT ?? 4021}`;
const ENDPOINT = `${MERCHANT_URL}/api/insight-private`;
const REQUESTS = Number(process.argv[2] ?? 7);
const DELAY_MS = Number(process.argv[3] ?? 1000);
const CLOSE_TAB = process.env.CLOSE_TAB !== "0";

const smartAccount = requireEnv("SMART_ACCOUNT");
const ruleId = Number(requireEnv("AGENT_RULE_ID"));
const vaultKp = Keypair.fromSecret(requireEnv("AGENT_VAULT_SECRET"));

const signer = new SmartAccountAgentSigner({
  smartAccount,
  agentSecret: requireEnv("AGENT_SECRET"),
  contextRuleId: ruleId,
  networkPassphrase: TESTNET.networkPassphrase,
});
const account = new ConfidentialAccount({
  secret: vaultKp.secret(),
  ctSecretHex: requireEnv("AGENT_CT_SK"),
  statePath: `.acan/ct-${vaultKp.publicKey()}.json`,
});

const ts = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);
const usdc = (v: bigint) => `${stroopsToUsdc(v)} USDC`;
let onChainSettlements = 0;

const vault = new ConfidentialVault(account, {
  vaultKeypair: vaultKp,
  signer,
  chunk: usdcToStroops(process.env.TOPUP_CHUNK_USDC ?? "0.10"),
  onEvent: (e) => {
    switch (e.kind) {
      case "topup-start":
        return log(`   vault top-up: pulling ${usdc(e.amount)} from the smart account (policy-checked)`);
      case "topup-pulled":
        return log(`   pulled (public, fixed-size chunk)  ${explorerTx(e.tx)}`);
      case "topup-deposited":
        return log(`   deposited into the confidential balance  ${explorerTx(e.tx)}`);
      case "topup-merged":
        return log(`   merged, vault spendable ${usdc(e.spendable)} (known only to the agent)`);
      case "transfer":
        onChainSettlements++;
        return log(`   CONFIDENTIAL TRANSFER (amount hidden on-chain)  ${explorerTx(e.tx)}`);
    }
  },
});

const scheme = new TabClientScheme({
  vault: vaultKp,
  confidentialToken: CONFIDENTIAL_TESTNET.contracts.token,
  settler: vault,
  statePath: ".acan/agent-tabs.json",
  onEvent: (e) => {
    if (e.kind === "settling") log(`   tab is at its credit limit: settling ${usdc(e.amount)} owed so far…`);
  },
});
const client = new x402Client().register("stellar:*", scheme);
const http = new x402HTTPClient(client);

async function allowanceLine(): Promise<string> {
  try {
    const s = await spendingLimitState(smartAccount, ruleId);
    return `allowance left ${usdc(BigInt(s.spending_limit) - BigInt(s.cached_total_spent))}`;
  } catch {
    return "allowance unavailable";
  }
}

function rejection(err: unknown): string | null {
  for (let e: any = err; e; e = e.cause) if (e instanceof PaymentRejectedError) return e.message;
  return null;
}

async function syncTab(payee: string): Promise<void> {
  const r = await fetch(`${MERCHANT_URL}/tab/${vaultKp.publicKey()}`);
  if (!r.ok) throw new Error(`merchant tab endpoint: HTTP ${r.status} (is the private route enabled?)`);
  const t = scheme.syncFromMerchant(payee, await r.json());
  log(`tab with ${payee.slice(0, 6)}…: ${t.nonce} vouchers, owed ${usdc(t.owed)}, settled ${usdc(t.settled)}`);
}

async function buyOnce(i: number): Promise<"paid" | "blocked" | "error"> {
  const first = await fetch(ENDPOINT);
  if (first.status !== 402) {
    log(`#${i} unexpected status ${first.status} (expected 402)`);
    return "error";
  }
  const required = http.getPaymentRequiredResponse((n) => first.headers.get(n));
  const req = required.accepts.find((a) => a.scheme === "acan-tab");
  if (!req) throw new Error("merchant does not offer the acan-tab scheme on this route");
  scheme.setResource(ENDPOINT);

  let payload;
  try {
    payload = await client.createPaymentPayload(required);
  } catch (err) {
    const reason = rejection(err);
    if (reason) {
      log(`#${i} BLOCKED by the smart account while topping up the vault: ${reason}`);
      return "blocked";
    }
    throw err;
  }

  const paid = await fetch(ENDPOINT, { headers: http.encodePaymentSignatureHeader(payload) });
  if (paid.status !== 200) {
    log(`#${i} merchant refused: HTTP ${paid.status}`);
    try {
      const pr = http.getPaymentRequiredResponse((n) => paid.headers.get(n));
      if (pr.error) console.log(`          reason: ${pr.error}`);
    } catch {
      /* no PAYMENT-REQUIRED header */
    }
    return "error";
  }
  const body = await paid.json();
  const settle = http.getPaymentSettleResponse((n) => paid.headers.get(n));
  scheme.commit(settle);
  const t = scheme.tab(req.payTo);
  log(`#${i} PAID with signed voucher #${t.nonce} (no transaction)  tab: owed ${usdc(t.owed)}, settled ${usdc(t.settled)}`);
  console.log(`          got: "${body.insight}"`);
  return "paid";
}

async function closeTab(payee: string): Promise<void> {
  const t = scheme.tab(payee);
  const due = t.owed - t.settled;
  if (due <= 0n) return;
  log(`closing the tab: settling the remaining ${usdc(due)} in one confidential transfer…`);
  const tx = await vault.settle(payee, due);
  const r = await fetch(`${MERCHANT_URL}/tab/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payer: vaultKp.publicKey(), txHash: tx }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`merchant did not credit the settlement: ${body.error}`);
  scheme.recordSettlement(payee, tx, due, BigInt(body.settled));
  log(`tab closed: merchant confirms settled ${usdc(BigInt(body.settled))} of ${usdc(BigInt(body.owed))}`);
}

async function main() {
  console.log(`ACAN agent (private mode)  ->  ${ENDPOINT}`);
  console.log(`vault ${vaultKp.publicKey()} (confidential balance), funded only via smart account ${smartAccount} rule ${ruleId}`);
  console.log(`${await allowanceLine()}\n`);
  if (!(await account.isRegistered())) throw new Error("vault is not registered: run `npm run ct:setup`");

  const info = await (await fetch(MERCHANT_URL)).json();
  const payee: string = info.payTo;
  await syncTab(payee);

  let paid = 0;
  try {
    for (let i = 1; i <= REQUESTS; i++) {
      const r = await buyOnce(i);
      if (r === "paid") paid++;
      if (r === "blocked") break;
      if (r === "error") process.exitCode = 1;
      if (i < REQUESTS) await new Promise((res) => setTimeout(res, DELAY_MS));
    }
    if (CLOSE_TAB && paid > 0) await closeTab(payee);
  } finally {
    await account.close();
  }
  console.log(
    `\nDone: ${paid} paid request(s), ${onChainSettlements} confidential settlement transfer(s) on-chain. ` +
      `${await allowanceLine()}.`,
  );
  console.log("An observer sees the transfers but not the amounts; the guardian can decrypt them with `npm run audit`.");
}

main().catch(async (e) => {
  console.error(`\nAGENT FAILED: ${e instanceof Error ? e.stack ?? e.message : e}`);
  await account.close().catch(() => undefined);
  process.exit(1);
});
