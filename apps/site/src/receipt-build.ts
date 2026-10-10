/**
 * The signed, explainable receipt of one Autopilot task: what was paid, what
 * was held and why, plus everything needed to re-run the co-signer's decisions.
 */
import { Buffer } from "buffer";
import { signReceipt, stroopsToUsdc, TESTNET, type PricedItem, type ReceiptBlocked, type ReceiptPayment, type SignedReceipt, type SignedRequest, type Step } from "@acan/core/browser";
import { transcriptFor } from "./provenance-agent";
import type { Sandbox } from "./sandbox";
import { XLM } from "./sandbox";

export interface TaskLine {
  payIndex: number;
  to: string;
  amount: bigint;
  merchant: string;
  ok: boolean;
  tx?: string;
  authEntry?: string;
  cosignature?: string;
  why?: string[];
}

export function buildTaskReceipt(sb: Sandbox, request: SignedRequest, plan: Step[], catalog: PricedItem[], lines: TaskLine[], startedAt: string): SignedReceipt {
  const g = sb.grant!;
  const item = (to: string, amount: bigint) => catalog.find((c) => c.payTo === to && c.price === amount.toString())?.product ?? "transfer";
  const payments: ReceiptPayment[] = lines
    .filter((l) => l.ok)
    .map((l) => ({
      at: new Date().toISOString(),
      merchant: l.merchant,
      address: l.to,
      item: item(l.to, l.amount),
      amountUsdc: stroopsToUsdc(l.amount),
      scheme: "transfer",
      tx: l.tx,
      payIndex: l.payIndex,
      authEntry: l.authEntry,
      cosignature: l.cosignature,
    }));
  const blocked: ReceiptBlocked[] = lines
    .filter((l) => !l.ok)
    .map((l) => ({
      at: new Date().toISOString(),
      recipient: l.merchant,
      amountUsdc: stroopsToUsdc(l.amount),
      policy: l.why ? "Provenance co-signer" : "Smart account",
      code: null,
      ...(l.why ? { held: { payIndex: l.payIndex, why: l.why } } : {}),
    }));
  const spent = lines.filter((l) => l.ok).reduce((t, l) => t + l.amount, 0n);
  const byMerchant = new Map<string, { merchant: string; address?: string; total: bigint; n: number }>();
  for (const l of lines.filter((x) => x.ok)) {
    const m = byMerchant.get(l.to) ?? { merchant: l.merchant, address: l.to, total: 0n, n: 0 };
    m.total += l.amount;
    m.n++;
    byMerchant.set(l.to, m);
  }
  const receipt = {
    v: 1 as const,
    kind: "acan-task-receipt" as const,
    network: "stellar:testnet",
    task: request.request.task,
    agent: sb.agent.publicKey(),
    smartAccount: sb.contractId!,
    ruleId: g.ruleId,
    mode: "public" as const,
    startedAt,
    endedAt: new Date().toISOString(),
    totals: { spentUsdc: stroopsToUsdc(spent), payments: payments.length, blocked: blocked.length, guardianApprovals: 0 },
    merchants: [...byMerchant.values()].map((m) => ({ merchant: m.merchant, address: m.address, spentUsdc: stroopsToUsdc(m.total), payments: m.n })),
    payments,
    blocked,
    asset: { code: "XLM", sac: XLM },
    provenance: {
      request: request as unknown as { request: Record<string, unknown>; publicKey: string; signature: string },
      plan,
      transcript: transcriptFor(plan),
      catalog,
      cosigner: sb.cosignerKey,
      networkPassphrase: TESTNET.networkPassphrase,
    },
  };
  return signReceipt(receipt, (d) => Buffer.from(sb.agent.sign(d)), sb.agent.publicKey());
}

export function downloadReceipt(r: SignedReceipt): void {
  const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `acan-receipt-${r.receipt.endedAt.slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
