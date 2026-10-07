import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TabVoucher } from "./voucher.js";

/** A merchant's view of one payer's tab. All amounts are atomic units. */
export interface TabState {
  payer: string;
  /** Nonce of the last accepted voucher (0 = none yet). */
  nonce: number;
  /** Total owed (cumulative of the last accepted voucher). */
  owed: bigint;
  /** Total received through confidential settlements. */
  settled: bigint;
  /** Settlement transactions already credited (prevents double counting). */
  credited: { tx: string; amount: bigint; at: string }[];
  /** Latest signed voucher: the merchant's evidence of the full debt. */
  lastVoucher?: TabVoucher;
  lastSignature?: string;
}

export const outstanding = (s: Pick<TabState, "owed" | "settled">): bigint => s.owed - s.settled;

export type TabCheck =
  | { ok: true; next: TabState }
  | { ok: false; reason: string; message: string };

/**
 * Pure state transition for one voucher (plus an optional, already
 * decrypted settlement). Does not mutate `prev`.
 */
export function applyVoucher(
  prev: TabState,
  voucher: TabVoucher,
  signature: string,
  creditLimit: bigint,
  settlement?: { tx: string; amount: bigint },
): TabCheck {
  let settled = prev.settled;
  const credited = [...prev.credited];
  if (settlement && !credited.some((c) => c.tx === settlement.tx)) {
    if (settlement.amount <= 0n) {
      return { ok: false, reason: "acan_tab_settlement_invalid", message: "settlement amount is zero" };
    }
    settled += settlement.amount;
    credited.push({ tx: settlement.tx, amount: settlement.amount, at: new Date().toISOString() });
  }
  if (voucher.nonce !== prev.nonce + 1) {
    return {
      ok: false,
      reason: "acan_tab_nonce_mismatch",
      message: `expected nonce ${prev.nonce + 1}, got ${voucher.nonce}`,
    };
  }
  const amount = BigInt(voucher.amount);
  const cumulative = BigInt(voucher.cumulative);
  if (cumulative !== prev.owed + amount) {
    return {
      ok: false,
      reason: "acan_tab_cumulative_mismatch",
      message: `expected cumulative ${prev.owed + amount}, got ${cumulative}`,
    };
  }
  const due = cumulative - settled;
  if (due > creditLimit) {
    return {
      ok: false,
      reason: "acan_tab_settlement_required",
      message: `unsettled ${due} would exceed the credit limit ${creditLimit}; settle ${cumulative - amount - settled} first`,
    };
  }
  return {
    ok: true,
    next: {
      payer: prev.payer,
      nonce: voucher.nonce,
      owed: cumulative,
      settled,
      credited,
      lastVoucher: voucher,
      lastSignature: signature,
    },
  };
}

/** Credit a settlement that arrives outside a paid request (closing a tab). */
export function applySettlement(prev: TabState, tx: string, amount: bigint): TabState {
  if (prev.credited.some((c) => c.tx === tx)) return prev;
  if (amount <= 0n) throw new Error("settlement amount must be positive");
  return {
    ...prev,
    settled: prev.settled + amount,
    credited: [...prev.credited, { tx, amount, at: new Date().toISOString() }],
  };
}

/** In-memory tab store with optional JSON-file persistence. */
export class TabLedger {
  private tabs = new Map<string, TabState>();

  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
      for (const [payer, { outstanding: _derived, ...t }] of Object.entries(raw)) {
        this.tabs.set(payer, {
          ...t,
          owed: BigInt(t.owed),
          settled: BigInt(t.settled),
          credited: (t.credited ?? []).map((c: any) => ({ ...c, amount: BigInt(c.amount) })),
        });
      }
    }
  }

  get(payer: string): TabState {
    return this.tabs.get(payer) ?? { payer, nonce: 0, owed: 0n, settled: 0n, credited: [] };
  }

  isCredited(payer: string, tx: string): boolean {
    return this.get(payer).credited.some((c) => c.tx === tx);
  }

  put(state: TabState): void {
    this.tabs.set(state.payer, state);
    this.persist();
  }

  all(): TabState[] {
    return [...this.tabs.values()];
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const out: Record<string, unknown> = {};
    for (const [k, t] of this.tabs) out[k] = tabToJson(t);
    writeFileSync(this.path, JSON.stringify(out, null, 2));
  }
}

export function tabToJson(t: TabState): Record<string, unknown> {
  return {
    ...t,
    owed: t.owed.toString(),
    settled: t.settled.toString(),
    outstanding: outstanding(t).toString(),
    credited: t.credited.map((c) => ({ ...c, amount: c.amount.toString() })),
  };
}
