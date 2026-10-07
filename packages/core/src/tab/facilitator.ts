import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { applyVoucher, tabToJson, type TabLedger, type TabState } from "./ledger.js";
import {
  TAB_SCHEME,
  verifyVoucherSignature,
  voucherShapeError,
  type TabPayload,
  type TabVoucher,
} from "./voucher.js";

/** A confidential transfer as seen (and decrypted) by the merchant. */
export interface ReceivedSettlement {
  tx: string;
  from: string;
  to: string;
  /** Decrypted amount, atomic units. Only the recipient (and auditor) can read it. */
  amount: bigint;
}

/** Looks up a confidential transfer by hash and decrypts it with the merchant's keys. */
export interface SettlementInbox {
  lookup(txHash: string): Promise<ReceivedSettlement | null>;
}

type Checked =
  | { ok: true; voucher: TabVoucher; next: TabState }
  | { ok: false; reason: string; message: string; payer?: string };

/**
 * Facilitator for the "acan-tab" scheme, run in-process by the merchant.
 *
 * verify: checks the voucher signature, that it is the next link in the
 *   payer's chain, and that unsettled debt stays within the credit limit. A
 *   referenced settlement is decrypted with the merchant's confidential keys
 *   and must be a transfer payer → merchant.
 * settle: re-runs the same checks and records the voucher. No transaction
 *   is sent: the merchant's revenue arrives in the payer's batched
 *   confidential settlements.
 */
export class TabFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = TAB_SCHEME;
  readonly caipFamily = "stellar:*";
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ledger: TabLedger,
    private readonly inbox: SettlementInbox,
    /** The merchant (G...) that settlements must be addressed to. */
    private readonly payee: string,
  ) {}

  getExtra(_network: Network): Record<string, unknown> | undefined {
    return undefined;
  }

  getSigners(_network: string): string[] {
    return [];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const r = await this.serial(() => this.check(payload, requirements));
    return r.ok
      ? { isValid: true, payer: r.voucher.payer }
      : { isValid: false, invalidReason: r.reason, invalidMessage: r.message, payer: r.payer };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.serial(async () => {
      const r = await this.check(payload, requirements);
      if (!r.ok) {
        return {
          success: false,
          errorReason: r.reason,
          errorMessage: r.message,
          payer: r.payer,
          transaction: "",
          network: requirements.network,
        };
      }
      this.ledger.put(r.next);
      return {
        success: true,
        payer: r.voucher.payer,
        // No on-chain transaction per request: a stable voucher reference.
        transaction: `tab:${r.voucher.payer}:${r.voucher.nonce}`,
        network: requirements.network,
        amount: r.voucher.amount,
        extra: { tab: tabToJson(r.next) },
      };
    });
  }

  /** Credit a settlement reported outside a paid request (e.g. closing a tab). */
  async creditSettlement(payer: string, txHashIn: string): Promise<TabState> {
    if (!/^[0-9a-f]{64}$/i.test(txHashIn)) throw new Error("txHash must be a transaction hash");
    const txHash = txHashIn.toLowerCase();
    return this.serial(async () => {
      const prev = this.ledger.get(payer);
      if (prev.credited.some((c) => c.tx === txHash)) return prev;
      const s = await this.inbox.lookup(txHash);
      const err = settlementError(s, payer, this.payee);
      if (err) throw new Error(err);
      const next = {
        ...prev,
        settled: prev.settled + s!.amount,
        credited: [...prev.credited, { tx: txHash, amount: s!.amount, at: new Date().toISOString() }],
      };
      this.ledger.put(next);
      return next;
    });
  }

  private async check(payload: PaymentPayload, req: PaymentRequirements): Promise<Checked> {
    const p = payload.payload as unknown as TabPayload;
    const shape = voucherShapeError(p?.voucher);
    if (shape) return { ok: false, reason: "acan_tab_invalid_voucher", message: shape };
    const v = p.voucher;
    const payer = v.payer;
    if (typeof p.signature !== "string") {
      return { ok: false, reason: "acan_tab_invalid_signature", message: "signature missing", payer };
    }
    if (req.scheme !== TAB_SCHEME || payload.accepted?.scheme !== TAB_SCHEME) {
      return { ok: false, reason: "unsupported_scheme", message: "not an acan-tab payment", payer };
    }
    const mismatch =
      (v.network !== req.network && "network") ||
      (v.token !== req.asset && "token") ||
      (v.payee !== req.payTo && "payee") ||
      (req.payTo !== this.payee && "merchant") ||
      (v.amount !== req.amount && "amount");
    if (mismatch) {
      return { ok: false, reason: "acan_tab_requirements_mismatch", message: `voucher ${mismatch} does not match`, payer };
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - v.issuedAt) > Math.max(60, req.maxTimeoutSeconds)) {
      return { ok: false, reason: "acan_tab_voucher_expired", message: "voucher issuedAt is outside the allowed window", payer };
    }
    if (!verifyVoucherSignature(v, p.signature)) {
      return { ok: false, reason: "acan_tab_invalid_signature", message: "voucher signature does not verify", payer };
    }
    const creditLimit = BigInt(String(req.extra?.creditLimit ?? "0"));
    const prev = this.ledger.get(payer);

    let settlement: { tx: string; amount: bigint } | undefined;
    if (p.settlementTx !== undefined) {
      if (typeof p.settlementTx !== "string" || !/^[0-9a-f]{64}$/i.test(p.settlementTx)) {
        return { ok: false, reason: "acan_tab_settlement_invalid", message: "settlementTx must be a transaction hash", payer };
      }
    }
    const stx = p.settlementTx?.toLowerCase();
    if (stx && !prev.credited.some((c) => c.tx === stx)) {
      const s = await this.inbox.lookup(stx);
      const err = settlementError(s, payer, this.payee);
      if (err) return { ok: false, reason: "acan_tab_settlement_invalid", message: err, payer };
      settlement = { tx: s!.tx, amount: s!.amount };
    }

    const r = applyVoucher(prev, v, p.signature, creditLimit, settlement);
    if (!r.ok) return { ...r, payer };
    return { ok: true, voucher: v, next: r.next };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function settlementError(s: ReceivedSettlement | null, payer: string, payee: string): string | null {
  if (!s) return "settlement transaction not found (or not a confidential transfer to this merchant)";
  if (s.from !== payer) return `settlement was sent by ${s.from}, not the tab's payer`;
  if (s.to !== payee) return "settlement was not sent to this merchant";
  if (s.amount <= 0n) return "settlement amount is zero";
  return null;
}

