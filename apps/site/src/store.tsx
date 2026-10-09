/**
 * The sandbox's shared state: one wallet, one allowance, one activity log,
 * used by every "Try" view (Wallet, AI agent, Autopilot). Everything runs in
 * this browser against Stellar testnet.
 */
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { explainRefusal, type Refusal, type SignedReceipt, type SignedRequest, type Step } from "@acan/core/browser";
import { SandboxAgent, type PayResult } from "./ai-agent";
import { latestLedger, short, spendingLimit, units } from "./chain";
import { DEPLOYMENT } from "./deployment";
import { MERCHANTS } from "./merchants";
import { pickPlan, sourceName, transcriptFor } from "./provenance-agent";
import { Sandbox, type GrantSettings, type Outcome, type SavedGrant } from "./sandbox";

export interface Block extends Refusal {
  requested: bigint;
  to: string;
  recipient: string;
  left?: bigint;
  limit?: bigint;
  settled?: "approved" | "denied";
}

/** The co-signer would not sign: why, in plain words. */
export interface Held {
  requested: bigint;
  to: string;
  recipient: string;
  why: string[];
  verdict: "escalate" | "reject";
  settled?: "approved" | "denied" | "tried-alone";
}

export interface LogLine {
  id: number;
  at: string;
  kind: "paid" | "refused" | "held" | "info" | "error";
  text: string;
  tx?: string;
  block?: Block;
  held?: Held;
}

interface Store {
  sb: () => Sandbox;
  contractId?: string;
  grant?: SavedGrant;
  busy: string | null;
  error: string | null;
  log: LogLine[];
  refresh: number;
  names: Record<string, string>;
  ai: SandboxAgent | null;
  step: 1 | 2 | 3 | 4;
  add: (kind: LogLine["kind"], text: string, extra?: Partial<LogLine>) => void;
  run: (label: string, fn: () => Promise<void>) => Promise<void>;
  setBusy: (s: string | null) => void;
  createWallet: () => Promise<void>;
  grantAgent: (s: GrantSettings, summary: string) => Promise<void>;
  /** A payment the user chose (scripted button or a picked AI option). Gated rules go through the co-signer. */
  pay: (label: string, to: string, amount: bigint) => Promise<Outcome>;
  /** A payment the autonomous agent makes from a plan. */
  payFromPlan: (request: SignedRequest, plan: Step[], payIndex: number, to: string, amount: bigint) => Promise<Outcome>;
  /** Show that the agent's key alone cannot pay under a gated rule. */
  tryAlone: (line: LogLine) => Promise<void>;
  approveOnce: (line: LogLine) => Promise<void>;
  settle: (id: number, settled: "approved" | "denied") => void;
  revoke: () => Promise<void>;
  /** After a revoke: grant a new allowance on the same wallet. */
  newGrant: () => void;
  reset: () => void;
  /** The signed receipt of the last Autopilot task (opened on the Receipts page). */
  receipt: SignedReceipt | null;
  setReceipt: (r: SignedReceipt | null) => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside SandboxProvider");
  return s;
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

const label = (names: Record<string, string>, to: string) => names[to] ?? `${short(to)} (not a listed shop)`;

export function SandboxProvider({ children }: { children: ReactNode }) {
  const sandbox = useRef<Sandbox | null>(null);
  const sb = () => (sandbox.current ??= new Sandbox());
  const [contractId, setContractId] = useState<string | undefined>(() => safe(() => sb().contractId));
  const [grant, setGrant] = useState(() => safe(() => sb().grant));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [receipt, setReceipt] = useState<SignedReceipt | null>(null);
  const seq = useRef(0);
  const contractRef = useRef(contractId);
  contractRef.current = contractId;

  const names = useMemo(() => {
    const n: Record<string, string> = {};
    for (const m of MERCHANTS) n[m.address] = m.name;
    const s = sandbox.current;
    if (s) {
      n[s.attacker.publicKey()] = "Unlisted address";
      n[s.agent.publicKey()] = "Agent";
    }
    return n;
  }, [contractId]);
  const namesRef = useRef(names);
  namesRef.current = names;

  const add: Store["add"] = (kind, text, extra = {}) =>
    setLog((l) => [{ id: ++seq.current, at: new Date().toLocaleTimeString(), kind, text, ...extra }, ...l].slice(0, 80));

  async function run(busyLabel: string, fn: () => Promise<void>) {
    setBusy(busyLabel);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      add("error", msg);
    } finally {
      setBusy(null);
      setRefresh((r) => r + 1);
    }
  }

  /** Log any outcome the same way, whoever made the payment. */
  async function record(what: string, to: string, amount: bigint, r: Outcome) {
    const n = namesRef.current;
    if (r.ok) {
      add("paid", `PAID ${units(amount)} XLM to ${label(n, to)}`, { tx: r.tx });
    } else if (r.why) {
      add("held", `NOT CO-SIGNED: ${what}`, {
        held: { requested: amount, to, recipient: label(n, to), why: r.why.map(plainWhy), verdict: r.verdict ?? "escalate" },
      });
    } else if (r.refused) {
      const g = sb().grant;
      const c = contractRef.current;
      const s = g && c ? await spendingLimit(c, g.ruleId, await latestLedger()).catch(() => null) : null;
      add("refused", `REFUSED by the smart account: ${r.reason}`, {
        block: { ...explainRefusal(r.code), requested: amount, to, recipient: label(n, to), left: s ? s.limit - s.spent : undefined, limit: s?.limit },
      });
    } else add("error", `Not sent: ${r.reason}`);
  }

  async function pay(what: string, to: string, amount: bigint): Promise<Outcome> {
    add("info", `Agent: ${what}`);
    const s = sb();
    let r: Outcome;
    if (s.grant?.gated) {
      // The user chose this payment themselves, so every value in it is theirs: sign it as their request.
      const request = s.signRequest(what, { to, amount: amount.toString(), maxAmount: amount.toString() });
      r = await s.gatedPay({ request, plan: pickPlan(), transcript: {}, payIndex: 0 }, to, amount);
    } else {
      r = await s.agentPays(to, amount);
    }
    await record(what, to, amount, r);
    return r;
  }

  async function payFromPlan(request: SignedRequest, plan: Step[], payIndex: number, to: string, amount: bigint): Promise<Outcome> {
    const r = await sb().gatedPay({ request, plan, transcript: transcriptFor(plan), payIndex }, to, amount);
    await record(request.request.task, to, amount, r);
    return r;
  }

  const settle: Store["settle"] = (id, settled) =>
    setLog((ls) =>
      ls.map((x) =>
        x.id !== id ? x : x.block ? { ...x, block: { ...x.block, settled } } : x.held ? { ...x, held: { ...x.held, settled } } : x,
      ),
    );

  const ai = useRef<SandboxAgent | null>(null);
  if (DEPLOYMENT.aiRelay && !ai.current) {
    ai.current = new SandboxAgent(DEPLOYMENT.aiRelay.replace(/\/$/, ""), {
      shops: () => {
        const allowed = sb().grant?.shops.map((x) => x.address);
        return allowed?.length ? MERCHANTS.filter((m) => allowed.includes(m.address)) : MERCHANTS;
      },
      allowance: async () => {
        const g = sb().grant;
        if (!g || g.revoked || !contractRef.current) return null;
        const s = await spendingLimit(contractRef.current, g.ruleId, await latestLedger());
        return s ? { limitXlm: units(s.limit), spentXlm: units(s.spent), leftXlm: units(s.limit - s.spent) } : null;
      },
      pay: async (to, stroops, what): Promise<PayResult> => {
        setBusy("The agent is paying…");
        setError(null);
        try {
          const r = await pay(what, to, stroops);
          if (r.ok) return r;
          if (r.why) return { ok: false, refused: false, code: null, reason: `The provenance co-signer did not sign: ${r.why.map(plainWhy).join("; ")}` };
          const why = r.refused ? explainRefusal(r.code) : undefined;
          return { ...r, title: why?.title, policy: why?.policy };
        } finally {
          setBusy(null);
          setRefresh((n) => n + 1);
        }
      },
    });
  }

  const store: Store = {
    sb,
    contractId,
    grant,
    busy,
    error,
    log,
    refresh,
    names,
    ai: ai.current,
    step: !contractId ? 1 : !grant ? 2 : grant.revoked ? 4 : 3,
    add,
    run,
    setBusy,
    createWallet: () =>
      run("Creating your wallet…", async () => {
        const id = await sb().createWallet((m) => setBusy(m));
        setContractId(id);
        setGrant(undefined);
        add("info", `Smart account ${short(id, 6)} deployed and funded with testnet XLM.`);
      }),
    grantAgent: (s, summary) =>
      run("Granting the allowance…", async () => {
        const g = await sb().grantAgent(s, (m) => setBusy(m));
        setGrant(g);
        add("info", `Rule #${g.ruleId}: ${summary}`);
      }),
    pay,
    payFromPlan,
    tryAlone: (l) =>
      run("The agent signs alone…", async () => {
        const h = l.held!;
        add("info", "Agent: pay anyway, signing with only my own key");
        const r = await sb().agentPays(h.to, h.requested);
        setLog((ls) => ls.map((x) => (x.id === l.id && x.held ? { ...x, held: { ...x.held, settled: "tried-alone" } } : x)));
        await record("pay with the agent's key alone", h.to, h.requested, r);
      }),
    approveOnce: (l) =>
      run("Approve with your passkey…", async () => {
        const to = l.block?.to ?? l.held!.to;
        const amount = l.block?.requested ?? l.held!.requested;
        const r = await sb().approveOnce(to, amount);
        if (!r.ok) throw new Error(`Approval not sent: ${r.reason}`);
        settle(l.id, "approved");
        add("paid", `APPROVED by the guardian's passkey: ${units(amount)} XLM to ${label(namesRef.current, to)}. The agent's allowance is unchanged.`, { tx: r.tx });
      }),
    settle,
    revoke: () =>
      run("Revoking…", async () => {
        const id = sb().grant?.ruleId;
        await sb().revoke();
        setGrant(sb().grant);
        add("info", `Rule #${id} deleted with your passkey. The agent's key now authorizes nothing.`);
      }),
    receipt,
    setReceipt,
    newGrant: () => {
      if (busy) return;
      sb().clearGrant();
      setGrant(undefined);
    },
    reset: () => {
      if (busy) return;
      Sandbox.reset();
      sandbox.current = null;
      setContractId(undefined);
      setGrant(undefined);
      setLog([]);
      setError(null);
    },
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

/** "amount depends on tool:tidewire.example" → "the amount came from content from tidewire.example". */
export function plainWhy(w: string): string {
  const m = w.match(/^(recipient|amount|the decision to pay) depends on (.+)$/);
  if (!m) return w;
  const what = m[1] === "recipient" ? "Who gets paid" : m[1] === "amount" ? "How much" : "Whether to pay at all";
  return `${what} came from ${m[2].split(", ").map(sourceName).join(" and ")}`;
}
