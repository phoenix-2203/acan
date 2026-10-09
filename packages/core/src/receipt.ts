/**
 * Task receipts: what an agent did with its allowance during one task, signed
 * with the agent's key. Every public payment line carries its transaction
 * hash, so anyone can check the receipt against the chain
 * (`npm run receipt:verify`); the signature proves which agent key issued it.
 */
import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

export const RECEIPT_DOMAIN = "acan-task-receipt-v1";

export interface ReceiptPayment {
  at: string;
  merchant: string;
  address?: string;
  item: string;
  amountUsdc: string;
  /** "exact" (on-chain transfer), "acan-tab" (voucher, settled confidentially later), or "transfer". */
  scheme: string;
  /** On-chain transaction hash, for public payments. */
  tx?: string;
  /** Voucher reference, for private payments. */
  voucher?: string;
  approvedByGuardian?: boolean;
  /** Provenance-gated payments: which `pay` of the receipt's plan this was. */
  payIndex?: number;
  /** The unsigned authorization entry the co-signer reviewed (base64 XDR). */
  authEntry?: string;
  /** The provenance co-signer's signature over that entry's auth digest (hex). */
  cosignature?: string;
}

export interface ReceiptBlocked {
  at: string;
  recipient: string;
  amountUsdc?: string;
  policy: string;
  code: number | null;
  /** Held by the provenance co-signer: which `pay` of the plan, and why (as the co-signer said). */
  held?: { payIndex: number; why: string[] };
}

export interface TaskReceipt {
  v: 1;
  kind: "acan-task-receipt";
  network: string;
  task: string;
  agent: string;
  smartAccount: string;
  ruleId: number;
  mode: "public" | "private";
  startedAt: string;
  endedAt: string;
  allowance?: { limitUsdc: string; leftAtStartUsdc: string; leftAtEndUsdc: string };
  totals: { spentUsdc: string; payments: number; blocked: number; guardianApprovals: number; returnedUsdc?: string };
  merchants: { merchant: string; address?: string; spentUsdc: string; payments: number }[];
  payments: ReceiptPayment[];
  blocked: ReceiptBlocked[];
  /** The token paid in; USDC when absent. Amount fields named *Usdc then hold amounts in this asset. */
  asset?: { code: string; sac: string };
  /**
   * Explainable receipts: everything needed to re-run the provenance
   * co-signer's decision for every payment and every hold.
   */
  provenance?: {
    /** The user's request, signed on their device. */
    request: { request: Record<string, unknown>; publicKey: string; signature: string };
    plan: unknown[];
    transcript: Record<string, string>;
    /** The price book the guardian pinned for the co-signer. */
    catalog: { merchant: string; product: string; price: string; payTo: string }[];
    /** The co-signer's public key (G...). */
    cosigner: string;
    networkPassphrase: string;
  };
}

export interface SignedReceipt {
  receipt: TaskReceipt;
  /** Ed25519 public key (G...) that signed: the agent's key. */
  signer: string;
  /** base64 Ed25519 signature over {@link receiptDigest}. */
  signature: string;
}

/** JSON with object keys sorted at every level, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function receiptDigest(r: TaskReceipt): Buffer {
  return Buffer.from(hash(Buffer.from(`${RECEIPT_DOMAIN}\n${canonicalJson(r)}`, "utf8")));
}

export function signReceipt(r: TaskReceipt, sign: (digest: Buffer) => Buffer, signer: string): SignedReceipt {
  return { receipt: r, signer, signature: sign(receiptDigest(r)).toString("base64") };
}

/** True when the signature is valid and the signer is the agent named in the receipt. */
export function verifyReceiptSignature(s: SignedReceipt): boolean {
  if (!StrKey.isValidEd25519PublicKey(s.signer) || s.signer !== s.receipt.agent) return false;
  const sig = Buffer.from(s.signature, "base64");
  if (sig.length !== 64) return false;
  try {
    return Keypair.fromPublicKey(s.signer).verify(receiptDigest(s.receipt), sig);
  } catch {
    return false;
  }
}

/** Sum of decimal USDC strings, exactly (7 decimals). */
export function addUsdc(values: string[]): string {
  const total = values.reduce((t, v) => {
    const [w, f = ""] = v.split(".");
    return t + BigInt(w || "0") * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
  }, 0n);
  const frac = (total % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return `${total / 10_000_000n}${frac ? `.${frac}` : ""}`;
}

/** Collects what happens during a task and produces the receipt. */
export class ReceiptRecorder {
  readonly startedAt = new Date().toISOString();
  readonly payments: ReceiptPayment[] = [];
  readonly blocked: ReceiptBlocked[] = [];
  leftAtStartUsdc?: string;

  constructor(
    readonly base: Pick<TaskReceipt, "network" | "agent" | "smartAccount" | "ruleId" | "mode"> & { task: string },
  ) {}

  paid(p: Omit<ReceiptPayment, "at">): void {
    this.payments.push({ at: new Date().toISOString(), ...p });
  }

  refused(b: Omit<ReceiptBlocked, "at">): void {
    this.blocked.push({ at: new Date().toISOString(), ...b });
  }

  build(extra: { allowance?: { limitUsdc: string; remainingUsdc: string }; returnedUsdc?: string; task?: string } = {}): TaskReceipt {
    const byMerchant = new Map<string, { merchant: string; address?: string; amounts: string[] }>();
    for (const p of this.payments) {
      const k = p.address ?? p.merchant;
      const m = byMerchant.get(k) ?? { merchant: p.merchant, address: p.address, amounts: [] };
      m.amounts.push(p.amountUsdc);
      byMerchant.set(k, m);
    }
    return {
      v: 1,
      kind: "acan-task-receipt",
      ...this.base,
      task: extra.task ?? this.base.task,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      allowance:
        extra.allowance && this.leftAtStartUsdc !== undefined
          ? { limitUsdc: extra.allowance.limitUsdc, leftAtStartUsdc: this.leftAtStartUsdc, leftAtEndUsdc: extra.allowance.remainingUsdc }
          : undefined,
      totals: {
        spentUsdc: addUsdc(this.payments.map((p) => p.amountUsdc)),
        payments: this.payments.length,
        blocked: this.blocked.length,
        guardianApprovals: this.payments.filter((p) => p.approvedByGuardian).length,
        ...(extra.returnedUsdc ? { returnedUsdc: extra.returnedUsdc } : {}),
      },
      merchants: [...byMerchant.values()].map((m) => ({
        merchant: m.merchant,
        address: m.address,
        spentUsdc: addUsdc(m.amounts),
        payments: m.amounts.length,
      })),
      payments: [...this.payments],
      blocked: [...this.blocked],
    };
  }
}

/** The transaction hash in an explorer URL or a bare hash; undefined for vouchers. */
export function txHashOf(receipt: string | undefined): string | undefined {
  const m = receipt?.match(/([0-9a-f]{64})\/?$/i);
  return m ? m[1].toLowerCase() : undefined;
}
