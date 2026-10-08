/**
 * Check a signed task receipt: the agent's signature, the totals, and every
 * public payment against the chain (the transaction exists, succeeded, and
 * moved that amount of USDC from the smart account to that recipient).
 * Browser-safe: used by `npm run receipt:verify` and by the demo site.
 */
import { StrKey, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { ASSETS, stroopsToUsdc } from "./config.js";
import { addUsdc, verifyReceiptSignature, type ReceiptPayment, type SignedReceipt } from "./receipt.js";

export type CheckStatus = "ok" | "fail" | "skip";

export interface ReceiptCheck {
  status: CheckStatus;
  text: string;
  /** For a payment line: its index in receipt.payments. */
  payment?: number;
}

/** USDC transfers in a transaction's events (Protocol 23+ meta v4, or v3). */
export function usdcTransfers(meta: xdr.TransactionMeta, sac: string = ASSETS.usdc.sac): { from: string; to: string; amount: bigint }[] {
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
      if (!id || StrKey.encodeContract(Buffer.from(id as unknown as Uint8Array)) !== sac) continue;
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

/** The checks that need no network: signature and totals. */
export function checkReceiptOffline(signed: SignedReceipt): ReceiptCheck[] {
  const r = signed.receipt;
  const sum = addUsdc(r.payments.map((p) => p.amountUsdc));
  return [
    {
      status: verifyReceiptSignature(signed) ? "ok" : "fail",
      text: verifyReceiptSignature(signed)
        ? `Signed by the agent key ${signed.signer}`
        : "The signature does not match: the receipt was changed after signing, or another key signed it",
    },
    {
      status: sum === r.totals.spentUsdc ? "ok" : "fail",
      text:
        sum === r.totals.spentUsdc
          ? `Total spent ${r.totals.spentUsdc} USDC matches its ${r.payments.length} payment line(s)`
          : `Total says ${r.totals.spentUsdc} USDC, but the payment lines add up to ${sum} USDC`,
    },
  ];
}

/** Check one payment line against the chain. */
export async function checkPaymentOnChain(server: rpc.Server, smartAccount: string, p: ReceiptPayment, index: number): Promise<ReceiptCheck> {
  if (!p.tx) {
    return {
      status: "skip",
      payment: index,
      text: `${p.amountUsdc} USDC to ${p.merchant}: a private voucher, settled confidentially later, so it has no transaction of its own`,
    };
  }
  const short = `${p.tx.slice(0, 8)}…`;
  let t: rpc.Api.GetTransactionResponse;
  try {
    t = await server.getTransaction(p.tx);
  } catch (e) {
    return { status: "fail", payment: index, text: `${short} could not be read from the network (${e instanceof Error ? e.message : String(e)})` };
  }
  if (t.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    return {
      status: "fail",
      payment: index,
      text:
        t.status === rpc.Api.GetTransactionStatus.NOT_FOUND
          ? `${short} not found (older than the network's retention window, or another network)`
          : `${short} did not succeed`,
    };
  }
  const moved = usdcTransfers(t.resultMetaXdr).find((x) => x.from === smartAccount && (!p.address || x.to === p.address));
  const ok = Boolean(moved && stroopsToUsdc(moved.amount) === p.amountUsdc);
  return {
    status: ok ? "ok" : "fail",
    payment: index,
    text: ok
      ? `${short} moved ${p.amountUsdc} USDC from the smart account to ${p.merchant}`
      : moved
        ? `${short} moved ${stroopsToUsdc(moved.amount)} USDC, but the receipt says ${p.amountUsdc}`
        : `${short} has no USDC transfer from the smart account${p.address ? " to that recipient" : ""}`,
  };
}

/** Parse a receipt file; throws a readable error for anything that is not one. */
export function parseSignedReceipt(text: string): SignedReceipt {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("This file is not JSON. Pick the receipt file downloaded from the dashboard (acan-receipt-….json).");
  }
  const r = v?.receipt;
  if (r?.kind !== "acan-task-receipt" || typeof v?.signature !== "string" || typeof v?.signer !== "string") {
    throw new Error("This JSON file is not a signed ACAN task receipt.");
  }
  if (!Array.isArray(r.payments) || !Array.isArray(r.blocked) || !r.totals) throw new Error("The receipt is missing its payments or totals.");
  return v as SignedReceipt;
}
