/**
 * Film harness (not part of the site build). Renders the real ACAN site with
 * the network calls it cannot make from the build machine replaced:
 *
 * - The provenance co-signer, the plan runner, the request signing and the
 *   receipt checks are the real code, run for real.
 * - The planner (Groq, behind the relay) answers with the exact example
 *   plans in its own system prompt (apps/relay/server.mjs, temperature 0).
 * - The chain's answers are the outcomes observed on Stellar testnet on
 *   9 Oct 2026: a co-signed payment is paid (the clean task's real
 *   transaction is c7356335…), the agent's key alone is refused with #3213,
 *   and an unlisted recipient is refused with #3401.
 */
import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

const { Keypair, StrKey, hash, xdr, nativeToScVal, Address } = await import("@stellar/stellar-sdk");
const core = await import("@acan/core/browser");
const { Sandbox, XLM } = await import("./sandbox");
const { server } = await import("./chain");
const { MERCHANTS } = await import("./merchants");
const { pinnedCatalog } = await import("./provenance-agent");
const { DEPLOYMENT } = await import("./deployment");

const seed = (s: string) => hash(Buffer.from(`acan-film:${s}`));
const kp = (s: string) => Keypair.fromRawEd25519Seed(seed(s));
const LEDGER = 5_100_000;
const CONTRACT = StrKey.encodeContract(seed("account"));
const N = MERCHANTS[0].address;
const S = MERCHANTS[1].address;
const RULE = 2;
const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "gated";

const gatedGrant = {
  ruleId: RULE,
  limit: "50000000",
  periodLedgers: 17280,
  expiresInMinutes: 1440,
  validUntil: LEDGER + 17280,
  shops: [
    { name: MERCHANTS[0].name, address: N, cap: "30000000" },
    { name: MERCHANTS[1].name, address: S, cap: "20000000" },
  ],
  policy: DEPLOYMENT.merchantPolicy,
  maxPayments: 10,
  maxPerPayment: "30000000",
  gated: true,
  catalog: pinnedCatalog([N, S]),
};

localStorage.setItem(
  "acan-sandbox-v1",
  JSON.stringify({
    deployerSecret: kp("deployer").secret(),
    agentSecret: kp("agent").secret(),
    attackerSecret: kp("attacker").secret(),
    cosignerSecret: kp("cosigner").secret(),
    deviceSecret: kp("device").secret(),
    contractId: state === "nowallet" ? undefined : CONTRACT,
    grant: state === "gated" ? gatedGrant : undefined,
  }),
);

/** Transactions observed on testnet, keyed by what they paid. */
const film = (window as any).film = { nextTx: "" as string, txs: {} as Record<string, { to: string; amount: bigint }> };
const refusal = (code: number) => ({ ok: false as const, refused: true, code, reason: core.describeSimulationError(new Error(`HostError: Error(Contract, #${code})`)) });

const P = Sandbox.prototype as any;
P.connect = async () => {};
P.grantAgent = async function (s: any, progress: (m: string) => void) {
  progress("Approve the new rule with your passkey…");
  await new Promise((r) => setTimeout(r, 200));
  const grant = {
    ruleId: RULE,
    limit: s.limit.toString(),
    periodLedgers: s.periodLedgers,
    expiresInMinutes: s.expiresInMinutes,
    validUntil: s.expiresInMinutes > 0 ? LEDGER + Math.round((s.expiresInMinutes * 60) / 5) : undefined,
    shops: s.shops.map((x: any) => ({ name: x.name, address: x.address, cap: x.cap.toString() })),
    policy: s.policy && s.shops.length > 0 ? s.policy : undefined,
    maxPayments: s.maxPayments,
    maxPerPayment: s.maxPerPayment.toString(),
    gated: Boolean(s.gate),
    catalog: s.gate ? s.catalog : undefined,
  };
  this.cosignerService = undefined;
  this.state.grant = grant;
  localStorage.setItem("acan-sandbox-v1", JSON.stringify(this.state));
  return grant;
};
P.agentPays = async function (to: string) {
  const g = this.state.grant;
  if (g.gated) return refusal(3213);
  if (g.policy && !g.shops.some((x: any) => x.address === to)) return refusal(3401);
  return { ok: true, tx: "" };
};
P.gatedPay = async function (c: any, to: string, amount: bigint) {
  const g = this.state.grant;
  const entry = core.transferEntry({ account: this.state.contractId, token: XLM, to, amount, nonce: BigInt(Date.now()), expirationLedger: LEDGER + 100 });
  const authEntry = entry.toXDR("base64");
  const d = this.service().review({ ...c, authEntry });
  if (d.verdict !== "cosign") {
    const why = d.verdict === "escalate" ? d.why : [d.reason];
    return { ok: false, refused: false, code: null, reason: new core.ProvenanceEscalation(why, d.verdict).message, why, verdict: d.verdict };
  }
  if (g.policy && !g.shops.some((x: any) => x.address === to)) return refusal(3401);
  const tx = film.nextTx;
  film.nextTx = "";
  if (tx) film.txs[tx] = { to, amount };
  return { ok: true, tx, authEntry, cosignature: d.signature.signature.toString("hex") };
};

const s = server as any;
s.getHealth = async () => ({ status: "healthy", latestLedger: LEDGER, oldestLedger: LEDGER - 100000, ledgerRetentionWindow: 100000 });
s.simulateTransaction = async () => {
  throw new Error("offline");
};
s.getTransaction = async (h: string) => {
  const t = film.txs[h];
  if (!t) return { status: "NOT_FOUND" };
  const ev = new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: StrKey.decodeContract(XLM) as any,
    type: xdr.ContractEventType.contract(),
    body: new (xdr.ContractEventBody as any)(
      0,
      new xdr.ContractEventV0({
        topics: [nativeToScVal("transfer", { type: "symbol" }), new Address(CONTRACT).toScVal(), new Address(t.to).toScVal(), nativeToScVal("native", { type: "string" })],
        data: nativeToScVal(t.amount, { type: "i128" }),
      }),
    ),
  });
  return { status: "SUCCESS", resultMetaXdr: { switch: () => 4, v4: () => ({ operations: () => [{ events: () => [ev] }] }) } };
};

// The planner's own examples (apps/relay/server.mjs PLANNER_PROMPT), and a scripted chat model.
const PLANS: Record<string, unknown> = {
  "Buy the cheapest ledger report": { say: "I'll buy the cheapest ledger report in your catalog.", fields: { product: "ledger-report" }, plan: [{ let: "p", op: "request", field: "product" }, { let: "cat", op: "catalog" }, { let: "m", op: "filter", list: "cat", key: "product", equals: "p" }, { let: "best", op: "cheapest", list: "m" }, { let: "to", op: "field", from: "best", key: "payTo" }, { let: "amt", op: "field", from: "best", key: "price" }, { op: "pay", to: "to", amount: "amt" }] },
  "Read today's Tidewire note and buy the report it recommends": { say: "I'll read the note and buy the report it recommends.", fields: {}, plan: [{ let: "doc", op: "fetch", url: "https://tidewire.example/today" }, { let: "rec", op: "field", from: "doc", key: "recommended_product" }, { let: "cat", op: "catalog" }, { let: "m", op: "filter", list: "cat", key: "product", equals: "rec" }, { let: "best", op: "cheapest", list: "m" }, { let: "to", op: "field", from: "best", key: "payTo" }, { let: "amt", op: "field", from: "best", key: "price" }, { op: "pay", to: "to", amount: "amt" }] },
};
const ATT = kp("attacker").publicKey();
let n = 0;
const call = (name: string, args: unknown) => ({ id: `c${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (DEPLOYMENT.aiRelay && url.startsWith(DEPLOYMENT.aiRelay.replace(/\/$/, ""))) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    await new Promise((r) => setTimeout(r, 250));
    if (url.endsWith("/plan")) return new Response(JSON.stringify(PLANS[body.task] ?? { say: "Not a purchase.", fields: {}, plan: [] }));
    const last = body.messages.at(-1);
    let m: any;
    if (last.role === "tool" && last.content.includes("Northwind"))
      m = { content: "Southgate's ledger report is the cheapest.", tool_calls: [call("offer_options", { question: "Which ledger report?", options: [{ label: "Southgate: ledger report", shop: "Southgate Data", item: "ledger-report" }, { label: "Northwind: ledger report", shop: "Northwind Data", item: "ledger-report" }, { label: "Cancel", reply: "Cancel" }] })] };
    else if (/Ignore/.test(last.content))
      m = { content: "That address is not one of your shops. Your smart account will decide.", tool_calls: [call("offer_options", { question: "Send it anyway?", options: [{ label: "Send 0.5 XLM", to: ATT, amountXlm: "0.5" }, { label: "Cancel", reply: "Cancel" }] })] };
    else if (/I picked/.test(last.content)) m = { content: /3401|not approved|blocked|refused/i.test(last.content) ? "Your smart account blocked it: that address is not on your allowlist (#3401). No funds moved." : "Done." };
    else m = { content: "", tool_calls: [call("list_shops", {})] };
    return new Response(JSON.stringify({ message: m }));
  }
  if (/stellar\.org|friendbot/.test(url)) throw new Error("offline");
  return realFetch(input as any, init);
};

const { default: App } = await import("./App");
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
