/**
 * Read-only views of Stellar testnet: the same contract calls the dashboard
 * and the agent make, decoded for display. Every number on the site comes
 * from here, live, with no backend.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { ASSETS, OZ_SMART_ACCOUNT, TESTNET, getEventsSince } from "@acan/core/browser";

export const server = new rpc.Server(TESTNET.rpcUrl);
const READER = Keypair.random().publicKey();

/** Simulate a read-only contract call and decode the result. */
export async function read(contractId: string, fn: string, args: xdr.ScVal[] = []): Promise<any> {
  const tx = new TransactionBuilder(new Account(READER, "0"), { fee: BASE_FEE, networkPassphrase: TESTNET.networkPassphrase })
    .addOperation(Operation.invokeContractFunction({ contract: contractId, function: fn, args }))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval);
}

export const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
export const addr = (a: string) => nativeToScVal(a, { type: "address" });

/**
 * Latest ledger, from getHealth: a few bytes, where getLatestLedger also
 * carries the full ledger header and close meta on current RPC versions.
 */
export async function latestLedger(): Promise<number> {
  return (await server.getHealth()).latestLedger;
}

// ---- smart account rules ----------------------------------------------------

export type SignerView =
  | { kind: "passkey"; label: string }
  | { kind: "ed25519"; label: string; key: string }
  | { kind: "delegated"; label: string; address: string }
  | { kind: "other"; label: string };

export interface RuleView {
  id: number;
  name: string;
  scope: string;
  scopeContract?: string;
  signers: SignerView[];
  policies: string[];
  validUntil?: number;
}

const TOKENS: Record<string, string> = {
  [ASSETS.usdc.sac]: "USDC",
  [ASSETS.xlm.sac]: "XLM",
};

export function tokenName(contract: string): string {
  return TOKENS[contract] ?? short(contract);
}

function describeSigner(raw: any): SignerView {
  if (Array.isArray(raw) && raw[0] === "External") {
    const verifier = String(raw[1]);
    const key = raw[2] as Uint8Array;
    if (verifier === OZ_SMART_ACCOUNT.webauthnVerifier) return { kind: "passkey", label: "Passkey" };
    if (verifier === OZ_SMART_ACCOUNT.ed25519Verifier && key?.length === 32) {
      const g = StrKey.encodeEd25519PublicKey(key as any);
      return { kind: "ed25519", label: `Agent key ${short(g)}`, key: g };
    }
    return { kind: "other", label: `External signer (${short(verifier)})` };
  }
  if (Array.isArray(raw) && raw[0] === "Delegated") {
    return { kind: "delegated", label: `Delegated ${short(String(raw[1]))}`, address: String(raw[1]) };
  }
  return { kind: "other", label: "Signer" };
}

function describeScope(raw: any): { scope: string; scopeContract?: string } {
  if (Array.isArray(raw) && raw[0] === "CallContract") {
    const c = String(raw[1]);
    return { scope: `${tokenName(c)} transfers only`, scopeContract: c };
  }
  if (Array.isArray(raw) && raw[0] === "Default") return { scope: "Anything (admin)" };
  if (Array.isArray(raw) && raw[0] === "CreateContract") return { scope: "Contract deployment" };
  return { scope: String(raw) };
}

/** All context rules of a smart account (ids can be sparse after revocations). */
export async function contextRules(account: string): Promise<RuleView[]> {
  const count = Number(await read(account, "get_context_rules_count"));
  const rules: RuleView[] = [];
  // Ids keep increasing after a rule is removed, so probe past the count.
  const maxId = count + 64;
  for (let start = 0; rules.length < count && start < maxId; start += 8) {
    const batch = await Promise.all(
      Array.from({ length: 8 }, (_, i) => start + i).map((id) =>
        read(account, "get_context_rule", [u32(id)]).catch(() => null),
      ),
    );
    for (const r of batch) {
      if (!r) continue;
      const recovery = String(r.name) === "recovery";
      const scope = describeScope(r.context_type);
      rules.push({
        id: Number(r.id),
        name: String(r.name),
        ...scope,
        ...(scope.scopeContract === account ? { scope: "Changes to this account only" } : {}),
        ...(recovery ? { scope: "Anything (recovery key)" } : {}),
        signers: (r.signers ?? []).map(describeSigner).map((x: SignerView) => (recovery && x.kind === "ed25519" ? { ...x, label: `Recovery key ${short(x.key)}` } : x)),
        policies: (r.policies ?? []).map((p: unknown) => String(p)),
        validUntil: r.valid_until === undefined || r.valid_until === null ? undefined : Number(r.valid_until),
      });
    }
  }
  return rules.sort((a, b) => a.id - b.id);
}

// ---- policies ---------------------------------------------------------------

export interface SpendingView {
  limit: bigint;
  periodLedgers: number;
  /** Spent inside the current rolling window. */
  spent: bigint;
  payments: number;
}

/** OpenZeppelin spending-limit state, with the rolling window applied at `now`. */
export async function spendingLimit(account: string, ruleId: number, now: number): Promise<SpendingView | null> {
  try {
    const d = await read(OZ_SMART_ACCOUNT.spendingLimitPolicy, "get_spending_limit_data", [u32(ruleId), addr(account)]);
    const period = Number(d.period_ledgers);
    const live = (d.spending_history ?? []).filter((e: any) => Number(e.ledger_sequence) > now - period);
    return {
      limit: BigInt(d.spending_limit),
      periodLedgers: period,
      spent: live.reduce((s: bigint, e: any) => s + BigInt(e.amount), 0n),
      payments: live.length,
    };
  } catch {
    return null;
  }
}

export interface MerchantPolicyView {
  version: "0.1" | "0.2" | "0.3";
  recipients: { address: string; cap: bigint; spent: bigint }[];
  periodLedgers?: number;
  maxPayments?: number;
  /** Largest single payment (v0.3); 0n = no limit. */
  maxPerPayment?: bigint;
  payments?: number;
}

/** ACAN merchant budget policy state (v0.2), or the plain allowlist (v0.1). */
export async function merchantPolicy(
  policy: string,
  version: string,
  account: string,
  ruleId: number,
): Promise<MerchantPolicyView | null> {
  const args = [u32(ruleId), addr(account)];
  try {
    if (version === "0.1") {
      const list = (await read(policy, "get_recipients", args)) as string[];
      return { version: "0.1", recipients: list.map((a) => ({ address: String(a), cap: 0n, spent: 0n })) };
    }
    const params = await read(policy, "get_params", args);
    const state = await read(policy, "get_state", args);
    const spent = toMap(state.spent);
    return {
      version: version === "0.3" ? "0.3" : "0.2",
      recipients: (params.recipients ?? []).map((r: any) => ({
        address: String(r.address),
        cap: BigInt(r.cap),
        spent: spent.get(String(r.address)) ?? 0n,
      })),
      periodLedgers: Number(params.period_ledgers),
      maxPayments: Number(params.max_payments),
      maxPerPayment: BigInt(params.max_per_payment ?? 0),
      payments: Number(state.payments),
    };
  } catch {
    return null;
  }
}

function toMap(raw: unknown): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (raw instanceof Map) for (const [k, v] of raw) out.set(String(k), BigInt(v as bigint));
  else if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) out.set(k, BigInt(v as bigint));
  return out;
}

export async function tokenBalance(token: string, holder: string): Promise<bigint> {
  return BigInt(await read(token, "balance", [addr(holder)]));
}

// ---- activity ---------------------------------------------------------------

export interface ActivityItem {
  id: string;
  ledger: number;
  at: string;
  txHash: string;
  kind: "payment" | "rule-added" | "rule-removed" | "rule-changed";
  text: string;
  to?: string;
  amount?: bigint;
  token?: string;
}

/**
 * Recent on-chain activity of a smart account: token transfers out of it and
 * changes to its rules, from Soroban events (as far back as the RPC keeps).
 */
export async function activity(
  account: string,
  tokens: string[],
  names: Record<string, string> = {},
  /** How far back to look, in ledgers (17,280 is about a day). */
  windowLedgers = 17_280,
): Promise<ActivityItem[]> {
  const health = await server.getHealth();
  const latest = health.latestLedger;
  const startLedger = Math.max(health.oldestLedger + 1, latest - windowLedgers);
  const fromTopic = addr(account).toXDR("base64");
  const sym = (s: string) => xdr.ScVal.scvSymbol(s).toXDR("base64");
  // getEvents scans 10,000 ledgers per call: follow the cursor up to now.
  const events = await getEventsSince(server, startLedger, [
    { type: "contract", contractIds: tokens, topics: [[sym("transfer"), fromTopic, "*", "*"]] },
    { type: "contract", contractIds: [account] },
  ]);
  const out: ActivityItem[] = [];
  for (const e of events) {
    const topic0 = safeNative(e.topic[0]);
    const base = { id: e.id, ledger: e.ledger, at: e.ledgerClosedAt, txHash: e.txHash };
    if (topic0 === "transfer" && e.contractId && tokens.includes(e.contractId.toString())) {
      const to = String(safeNative(e.topic[2]));
      const amount = amountOf(e.value);
      const token = tokenName(e.contractId.toString());
      out.push({ ...base, kind: "payment", to, amount, token, text: `Paid ${names[to] ?? short(to)}` });
    } else if (topic0 === "context_rule_added") {
      out.push({ ...base, kind: "rule-added", text: `Rule #${safeNative(e.topic[1])} added` });
    } else if (topic0 === "context_rule_removed") {
      out.push({ ...base, kind: "rule-removed", text: `Rule #${safeNative(e.topic[1])} removed (revoked)` });
    } else if (typeof topic0 === "string" && topic0.startsWith("context_rule")) {
      out.push({ ...base, kind: "rule-changed", text: `Rule #${safeNative(e.topic[1])}: ${topic0.replace(/_/g, " ")}` });
    }
  }
  return out.reverse();
}

function safeNative(v: xdr.ScVal | undefined): any {
  try {
    return v ? scValToNative(v) : undefined;
  } catch {
    return undefined;
  }
}

function amountOf(v: xdr.ScVal): bigint {
  const n = safeNative(v);
  if (typeof n === "bigint") return n;
  if (n && typeof n === "object" && "amount" in n) return BigInt((n as { amount: bigint }).amount);
  return 0n;
}

// ---- formatting -------------------------------------------------------------

export function short(a: string, n = 4): string {
  return a.length > 2 * n + 3 ? `${a.slice(0, n + 1)}…${a.slice(-n)}` : a;
}

/** Atomic units (7 decimals) to a display string. */
export function units(v: bigint, decimals = 7): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / base}${frac ? "." + frac : ""}`;
}

export function toUnits(text: string, decimals = 7): bigint {
  const s = text.trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(s)) throw new Error(`Invalid amount: ${text}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0"));
}

export const explorer = (kind: "tx" | "contract" | "account", id: string) =>
  `https://stellar.expert/explorer/testnet/${kind}/${id}`;

export const explorerFor = (address: string) =>
  explorer(address.startsWith("C") ? "contract" : "account", address);

/** Seconds per ledger on testnet, for countdowns. */
export const LEDGER_SECONDS = 5;

export function isAddress(a: string): boolean {
  return StrKey.isValidEd25519PublicKey(a) || StrKey.isValidContract(a);
}

export { Address };
