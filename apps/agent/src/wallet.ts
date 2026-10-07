/**
 * The agent's paying side, shared by the AI agent: buy one x402 resource in
 * public mode (an `exact` USDC transfer from the guardian's smart account) or
 * private mode (an `acan-tab` voucher, settled confidentially).
 *
 * Everything here stays inside the guardian's limits: public payments are
 * authorized by the smart account's capped rule, and private settlements are
 * funded only by top-ups through that same rule.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { xdr } from "@stellar/stellar-sdk";
import {
  PaymentRejectedError,
  SmartAccountAgentSigner,
  SmartAccountExactStellarScheme,
  TESTNET,
  TabClientScheme,
  explorerTx,
  prepareSmartAccountPayment,
  requireEnv,
  spendingLimitState,
  stroopsToUsdc,
  usdcToStroops,
} from "@acan/core";
import { CONFIDENTIAL_TESTNET, ConfidentialAccount, ConfidentialVault, type VaultEvent } from "@acan/confidential";

export type Mode = "public" | "private";

export interface Purchase {
  ok: boolean;
  status: "paid" | "blocked" | "refused" | "error";
  url: string;
  priceUsdc?: string;
  scheme?: string;
  /** On-chain transaction (public mode) or voucher reference (private mode). */
  receipt?: string;
  data?: unknown;
  reason?: string;
}

export class AgentWallet {
  readonly signer: SmartAccountAgentSigner;
  readonly smartAccount: string;
  readonly ruleId: number;
  private readonly client: x402Client;
  private readonly http: x402HTTPClient;
  private readonly tab?: TabClientScheme;
  private readonly vault?: ConfidentialVault;
  private readonly account?: ConfidentialAccount;
  private readonly vaultKp?: Keypair;
  readonly settlements: string[] = [];

  constructor(
    readonly mode: Mode,
    private readonly log: (line: string) => void = console.log,
  ) {
    this.smartAccount = requireEnv("SMART_ACCOUNT");
    this.ruleId = Number(requireEnv("AGENT_RULE_ID"));
    this.signer = new SmartAccountAgentSigner({
      smartAccount: this.smartAccount,
      agentSecret: requireEnv("AGENT_SECRET"),
      contextRuleId: this.ruleId,
      networkPassphrase: TESTNET.networkPassphrase,
    });
    this.client = new x402Client();
    if (mode === "public") {
      this.client.register("stellar:*", new SmartAccountExactStellarScheme(this.signer, { url: TESTNET.rpcUrl }));
    } else {
      this.vaultKp = Keypair.fromSecret(requireEnv("AGENT_VAULT_SECRET"));
      this.account = new ConfidentialAccount({
        secret: this.vaultKp.secret(),
        ctSecretHex: requireEnv("AGENT_CT_SK"),
        statePath: `.acan/ct-${this.vaultKp.publicKey()}.json`,
      });
      this.vault = new ConfidentialVault(this.account, {
        vaultKeypair: this.vaultKp,
        signer: this.signer,
        chunk: usdcToStroops(process.env.TOPUP_CHUNK_USDC ?? "0.10"),
        onEvent: (e) => this.onVaultEvent(e),
      });
      this.tab = new TabClientScheme({
        vault: this.vaultKp,
        confidentialToken: CONFIDENTIAL_TESTNET.contracts.token,
        settler: this.vault,
        statePath: ".acan/agent-tabs.json",
        onEvent: (e) => {
          if (e.kind === "settling") this.log(`   tab at its credit limit: settling ${stroopsToUsdc(e.amount)} USDC owed so far`);
        },
      });
      this.client.register("stellar:*", this.tab);
    }
    this.http = new x402HTTPClient(this.client);
  }

  private onVaultEvent(e: VaultEvent): void {
    if (e.kind === "topup-start") this.log(`   vault top-up: pulling ${stroopsToUsdc(e.amount)} USDC from the smart account (policy-checked)`);
    if (e.kind === "topup-pulled") this.log(`   top-up ${explorerTx(e.tx)}`);
    if (e.kind === "transfer") {
      this.settlements.push(e.tx);
      this.log(`   CONFIDENTIAL TRANSFER (amount hidden on-chain) ${explorerTx(e.tx)}`);
    }
  }

  /** Remaining allowance for the current period, in USDC. */
  async allowance(): Promise<{ limitUsdc: string; spentUsdc: string; remainingUsdc: string; periodLedgers: number }> {
    const s = await spendingLimitState(this.smartAccount, this.ruleId);
    const limit = BigInt(s.spending_limit);
    const spent = BigInt(s.cached_total_spent);
    return {
      limitUsdc: stroopsToUsdc(limit),
      spentUsdc: stroopsToUsdc(spent),
      remainingUsdc: stroopsToUsdc(limit - spent),
      periodLedgers: Number(s.period_ledgers),
    };
  }

  /** Private mode: confidential vault balance (known only to the agent). */
  async vaultSpendable(): Promise<string | undefined> {
    if (!this.account) return undefined;
    return stroopsToUsdc((await this.account.balances()).spendable);
  }

  /** Private mode: make the local tab match the merchant's record. */
  async syncTab(merchantUrl: string): Promise<void> {
    if (!this.tab || !this.vaultKp) return;
    const info = await (await fetch(merchantUrl)).json();
    const r = await fetch(`${merchantUrl}/tab/${this.vaultKp.publicKey()}`);
    if (r.ok) this.tab.syncFromMerchant(info.payTo, await r.json());
  }

  async buy(url: string): Promise<Purchase> {
    const first = await fetch(url);
    if (first.status === 200) return { ok: true, status: "paid", url, priceUsdc: "0", data: await first.json() };
    if (first.status !== 402) return { ok: false, status: "error", url, reason: `HTTP ${first.status}: ${(await first.text()).slice(0, 200)}` };
    const required = this.http.getPaymentRequiredResponse((n) => first.headers.get(n));
    const scheme = this.mode === "public" ? "exact" : "acan-tab";
    const req = required.accepts.find((a) => a.scheme === scheme);
    if (!req) return { ok: false, status: "refused", url, reason: `merchant does not accept ${scheme}` };
    const priceUsdc = stroopsToUsdc(req.amount);
    this.tab?.setResource(url);

    let payload;
    try {
      payload = await this.client.createPaymentPayload({ ...required, accepts: [req] });
    } catch (err) {
      for (let e: any = err; e; e = e.cause) {
        if (e instanceof PaymentRejectedError) {
          return { ok: false, status: "blocked", url, priceUsdc, scheme, reason: `blocked by the smart account: ${e.message}` };
        }
      }
      return { ok: false, status: "error", url, priceUsdc, scheme, reason: err instanceof Error ? err.message : String(err) };
    }

    const paid = await fetch(url, { headers: this.http.encodePaymentSignatureHeader(payload) });
    if (paid.status !== 200) {
      let reason = `HTTP ${paid.status}`;
      try {
        const pr = this.http.getPaymentRequiredResponse((n) => paid.headers.get(n));
        if (pr.error) reason += `: ${pr.error}`;
      } catch {
        /* no PAYMENT-REQUIRED header */
      }
      return { ok: false, status: "refused", url, priceUsdc, scheme, reason };
    }
    const settle = this.http.getPaymentSettleResponse((n) => paid.headers.get(n));
    this.tab?.commit(settle);
    return {
      ok: true,
      status: "paid",
      url,
      priceUsdc,
      scheme,
      receipt: this.mode === "public" ? explorerTx(settle.transaction) : `voucher ${settle.transaction}`,
      data: await paid.json(),
    };
  }

  /**
   * Ask the guardian to approve one payment the allowance would refuse.
   * The guardian signs this exact payment with their passkey in the
   * dashboard (under their own rule, not the agent's), so it is a one-off:
   * the agent's allowance is unchanged. Paid publicly with "exact".
   */
  async requestApproval(
    url: string,
    reason: string,
    timeoutMs = Number(process.env.APPROVAL_TIMEOUT_MS ?? 240_000),
  ): Promise<Purchase> {
    const guardian = process.env.GUARDIAN_URL ?? "http://127.0.0.1:4030";
    const first = await fetch(url);
    if (first.status !== 402) return { ok: false, status: "error", url, reason: `expected HTTP 402, got ${first.status}` };
    const required = this.http.getPaymentRequiredResponse((n) => first.headers.get(n));
    const req = required.accepts.find((a) => a.scheme === "exact");
    if (!req) return { ok: false, status: "refused", url, reason: "merchant does not accept exact payments" };
    const priceUsdc = stroopsToUsdc(req.amount);
    let merchant = new URL(url).host;
    try {
      merchant = (await (await fetch(new URL(url).origin)).json()).name ?? merchant;
    } catch {
      /* catalog unavailable */
    }

    const prepared = await prepareSmartAccountPayment(this.smartAccount, req, { url: TESTNET.rpcUrl });
    const created = await fetch(`${guardian}/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchant,
        url,
        payTo: req.payTo,
        amount: req.amount,
        reason,
        entryXdr: prepared.entry().toXDR("base64"),
        maxLedger: prepared.maxLedger,
      }),
    }).catch(() => null);
    if (!created?.ok) return { ok: false, status: "error", url, priceUsdc, reason: "guardian service unreachable (npm run guardian)" };
    const { id } = await created.json();
    const dashboard = process.env.DASHBOARD_URL ?? "http://localhost:5173";
    this.log(
      `   waiting up to ${Math.round(timeoutMs / 60_000)} min for the guardian to approve ${priceUsdc} USDC to ${merchant}` +
        ` (dashboard: ${dashboard}, section 5)…`,
    );

    const end = Date.now() + timeoutMs;
    let approval: any;
    for (;;) {
      approval = await (await fetch(`${guardian}/approvals/${id}`)).json();
      if (approval.status !== "pending") break;
      if (Date.now() > end) return { ok: false, status: "refused", url, priceUsdc, reason: "the guardian did not answer in time" };
      await new Promise((r) => setTimeout(r, 2_000));
    }
    if (approval.status !== "approved") {
      return { ok: false, status: "refused", url, priceUsdc, reason: `the guardian ${approval.status} the request` };
    }
    this.log(`   ${"APPROVED"} with the guardian's passkey`);

    let transaction: string;
    try {
      transaction = await prepared.finalize(xdr.SorobanAuthorizationEntry.fromXDR(approval.signedEntryXdr, "base64"));
    } catch (err) {
      return { ok: false, status: "error", url, priceUsdc, reason: err instanceof Error ? err.message : String(err) };
    }
    const header = this.http.encodePaymentSignatureHeader({
      x402Version: required.x402Version,
      resource: required.resource,
      accepted: req,
      payload: { transaction },
    });
    const paid = await fetch(url, { headers: header });
    if (paid.status !== 200) return { ok: false, status: "refused", url, priceUsdc, reason: `merchant answered HTTP ${paid.status}` };
    const settle = this.http.getPaymentSettleResponse((n) => paid.headers.get(n));
    return { ok: true, status: "paid", url, priceUsdc, scheme: "exact (guardian-approved)", receipt: explorerTx(settle.transaction), data: await paid.json() };
  }

  /** Private mode: settle what is still owed to a merchant, in one confidential transfer. */
  async closeTab(merchantUrl: string): Promise<string | null> {
    if (!this.tab || !this.vault || !this.vaultKp) return null;
    const info = await (await fetch(merchantUrl)).json();
    const t = this.tab.tab(info.payTo);
    const due = t.owed - t.settled;
    if (due <= 0n) return null;
    this.log(`   closing tab with ${info.name}: settling ${stroopsToUsdc(due)} USDC confidentially`);
    const tx = await this.vault.settle(info.payTo, due);
    const r = await fetch(`${merchantUrl}/tab/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payer: this.vaultKp.publicKey(), txHash: tx }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(`${info.name} did not credit the settlement: ${body.error}`);
    this.tab.recordSettlement(info.payTo, tx, due, BigInt(body.settled));
    return tx;
  }

  async close(): Promise<void> {
    await this.account?.close();
  }
}
