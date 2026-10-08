/**
 * Check a task receipt: the agent's signature, the totals, and every public
 * payment against the chain (the transaction exists, succeeded, and moved
 * that amount of USDC from the smart account to that recipient).
 *
 * Usage: npm run receipt:verify -- <receipt.json>
 */
import { readFileSync } from "node:fs";
import { StrKey, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { ASSETS, TESTNET, addUsdc, stroopsToUsdc, verifyReceiptSignature, type SignedReceipt } from "@acan/core";

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run receipt:verify -- <receipt.json>");
  process.exit(2);
}
const signed = JSON.parse(readFileSync(file, "utf8")) as SignedReceipt;
const r = signed.receipt;
let failures = 0;
const ok = (good: boolean, text: string) => {
  console.log(`${good ? "OK  " : "FAIL"}  ${text}`);
  if (!good) failures++;
};

ok(verifyReceiptSignature(signed), `signed by the agent key ${signed.signer}`);
ok(addUsdc(r.payments.map((p) => p.amountUsdc)) === r.totals.spentUsdc, `total spent ${r.totals.spentUsdc} USDC matches its ${r.payments.length} payment line(s)`);

const server = new rpc.Server(TESTNET.rpcUrl);

/** USDC transfers in a transaction's events (Protocol 23+ meta v4, or v3). */
function transfers(meta: xdr.TransactionMeta): { from: string; to: string; amount: bigint }[] {
  const out: { from: string; to: string; amount: bigint }[] = [];
  let events: xdr.ContractEvent[] = [];
  try {
    const v = meta.switch();
    if (v === 4) events = meta.v4().operations().flatMap((o) => o.events());
    else if (v === 3) events = meta.v3().sorobanMeta()?.events() ?? [];
  } catch {
    return out;
  }
  for (const e of events) {
    try {
      const id = e.contractId();
      if (!id || StrKey.encodeContract(Buffer.from(id as unknown as Uint8Array)) !== ASSETS.usdc.sac) continue;
      const body = e.body().v0();
      const topics = body.topics().map((t) => scValToNative(t));
      if (topics[0] !== "transfer") continue;
      const v = scValToNative(body.data());
      out.push({ from: String(topics[1]), to: String(topics[2]), amount: BigInt(typeof v === "object" && v && "amount" in v ? v.amount : v) });
    } catch {
      /* not a token transfer event */
    }
  }
  return out;
}

for (const p of r.payments) {
  if (!p.tx) {
    console.log(`--    ${p.amountUsdc} USDC to ${p.merchant} (${p.item}): ${p.scheme} voucher, settled confidentially later; not checkable per request`);
    continue;
  }
  const t = await server.getTransaction(p.tx);
  if (t.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    ok(false, `${p.tx.slice(0, 8)}… ${t.status === rpc.Api.GetTransactionStatus.NOT_FOUND ? "not found (older than the RPC's retention window, or wrong network)" : "did not succeed"}`);
    continue;
  }
  const moved = transfers(t.resultMetaXdr).find((x) => x.from === r.smartAccount && (!p.address || x.to === p.address));
  ok(
    Boolean(moved && stroopsToUsdc(moved.amount) === p.amountUsdc),
    `${p.tx.slice(0, 8)}… ${p.amountUsdc} USDC from the smart account to ${p.merchant}${moved ? "" : " (no matching transfer event)"}`,
  );
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nreceipt verified");
process.exitCode = failures ? 1 : 0;
