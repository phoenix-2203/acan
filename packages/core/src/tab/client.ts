import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type {
  DefaultAsset,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
  SettleResponse,
} from "@x402/core/types";
import { TAB_SCHEME, signVoucher, type TabPayload, type TabVoucher } from "./voucher.js";

/** Pays a merchant confidentially. Returns the settlement transaction hash. */
export interface TabSettler {
  settle(payee: string, amount: bigint): Promise<string>;
}

/** The agent's own record of one tab with one merchant. */
export interface AgentTab {
  payee: string;
  nonce: number;
  owed: bigint;
  settled: bigint;
  /** A settlement sent on-chain but not yet acknowledged by the merchant. */
  unacked?: { tx: string; amount: bigint };
  settlements: { tx: string; amount: bigint; at: string }[];
}

export interface TabEvent {
  kind: "settling" | "settled";
  payee: string;
  amount: bigint;
  tx?: string;
}

/**
 * Client side of the "acan-tab" scheme.
 *
 * Each request is paid with a signed voucher: no transaction, no fee, no
 * on-chain trace. When the next voucher would push unsettled debt over the
 * merchant's credit limit, the agent first pays the whole outstanding tab in
 * one confidential transfer (amount hidden on-chain) and attaches its hash.
 */
export class TabClientScheme implements SchemeNetworkClient {
  readonly scheme = TAB_SCHEME;
  private tabs = new Map<string, AgentTab>();
  private inFlight?: { payee: string; voucher: TabVoucher };
  private resource = "unspecified";

  constructor(
    private readonly opts: {
      vault: Keypair;
      confidentialToken: string;
      settler: TabSettler;
      /** JSON file that persists tabs between runs. */
      statePath?: string;
      onEvent?: (e: TabEvent) => void;
    },
  ) {
    this.load();
  }

  /** Lets x402Client spend controls treat the confidential token like USDC (7 decimals). */
  readonly findDefaultAsset = (asset: string): DefaultAsset | undefined =>
    asset === this.opts.confidentialToken ? { asset, decimals: 7, symbol: "USDC" } : undefined;

  /** URL recorded in the next voucher (informational evidence for the merchant). */
  setResource(url: string): void {
    this.resource = url || "unspecified";
  }

  get payer(): string {
    return this.opts.vault.publicKey();
  }

  tab(payee: string): AgentTab {
    return this.tabs.get(payee) ?? { payee, nonce: 0, owed: 0n, settled: 0n, settlements: [] };
  }

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    if (req.scheme !== TAB_SCHEME) throw new Error(`Unsupported scheme ${req.scheme}`);
    if (req.asset !== this.opts.confidentialToken) {
      throw new Error(`Merchant asks for ${req.asset}; this agent settles in ${this.opts.confidentialToken}`);
    }
    if (!StrKey.isValidEd25519PublicKey(req.payTo)) throw new Error(`Invalid payee ${req.payTo}`);
    if (!/^\d+$/.test(req.amount)) throw new Error(`Invalid amount ${req.amount}`);
    const amount = BigInt(req.amount);
    const creditLimit = BigInt(String(req.extra?.creditLimit ?? "0"));
    if (amount <= 0n) throw new Error("Amount must be positive");
    if (amount > creditLimit) throw new Error(`Price ${amount} exceeds the merchant's credit limit ${creditLimit}`);

    const t = this.tab(req.payTo);
    const debt = t.owed - t.settled;
    if (!t.unacked && debt + amount > creditLimit) {
      // Settle everything owed so far in one confidential transfer.
      this.opts.onEvent?.({ kind: "settling", payee: req.payTo, amount: debt });
      const tx = await this.opts.settler.settle(req.payTo, debt);
      t.unacked = { tx, amount: debt };
      this.save(t); // money has moved: persist before anything else can fail
      this.opts.onEvent?.({ kind: "settled", payee: req.payTo, amount: debt, tx });
    }

    const voucher: TabVoucher = {
      v: 1,
      network: req.network,
      token: req.asset,
      payer: this.payer,
      payee: req.payTo,
      nonce: t.nonce + 1,
      amount: amount.toString(),
      cumulative: (t.owed + amount).toString(),
      resource: this.resource,
      issuedAt: Math.floor(Date.now() / 1000),
    };
    const payload: TabPayload = {
      voucher,
      signature: signVoucher(voucher, this.opts.vault),
      ...(t.unacked ? { settlementTx: t.unacked.tx } : {}),
    };
    this.inFlight = { payee: req.payTo, voucher };
    return { x402Version, payload: payload as unknown as Record<string, unknown> };
  }

  /**
   * Record the merchant's acknowledgement after a successful (HTTP 200) paid
   * request. The merchant's tab in `settle.extra.tab` is authoritative.
   */
  commit(settle: SettleResponse): void {
    const f = this.inFlight;
    this.inFlight = undefined;
    if (!f || !settle.success) return;
    const t = this.tab(f.payee);
    const m = (settle.extra?.tab ?? {}) as { nonce?: number; owed?: string; settled?: string };
    t.nonce = m.nonce ?? f.voucher.nonce;
    t.owed = m.owed !== undefined ? BigInt(m.owed) : BigInt(f.voucher.cumulative);
    if (t.unacked) {
      t.settlements.push({ ...t.unacked, at: new Date().toISOString() });
      t.unacked = undefined;
    }
    t.settled = m.settled !== undefined ? BigInt(m.settled) : t.settlements.reduce((a, s) => a + s.amount, 0n);
    this.save(t);
  }

  /** Overwrite local state with the merchant's view (GET <tabUrl>/<payer>). */
  syncFromMerchant(payee: string, view: { nonce: number; owed: string; settled: string }): AgentTab {
    const t = this.tab(payee);
    t.nonce = view.nonce;
    t.owed = BigInt(view.owed);
    t.settled = BigInt(view.settled);
    this.save(t);
    return t;
  }

  /** Record a settlement made outside a paid request (closing the tab). */
  recordSettlement(payee: string, tx: string, amount: bigint, merchantSettled?: bigint): void {
    const t = this.tab(payee);
    t.settlements.push({ tx, amount, at: new Date().toISOString() });
    t.unacked = undefined;
    t.settled = merchantSettled ?? t.settled + amount;
    this.save(t);
  }

  private load(): void {
    const p = this.opts.statePath;
    if (!p || !existsSync(p)) return;
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, Record<string, any>>;
    const mine = raw[this.payer] ?? {};
    for (const [payee, t] of Object.entries(mine)) {
      this.tabs.set(payee, {
        payee,
        nonce: t.nonce,
        owed: BigInt(t.owed),
        settled: BigInt(t.settled),
        unacked: t.unacked ? { tx: t.unacked.tx, amount: BigInt(t.unacked.amount) } : undefined,
        settlements: (t.settlements ?? []).map((s: any) => ({ ...s, amount: BigInt(s.amount) })),
      });
    }
  }

  private save(t: AgentTab): void {
    this.tabs.set(t.payee, t);
    const p = this.opts.statePath;
    if (!p) return;
    const raw = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : {};
    raw[this.payer] = Object.fromEntries(
      [...this.tabs].map(([k, v]) => [k, JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)))]),
    );
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(raw, null, 2));
  }
}
