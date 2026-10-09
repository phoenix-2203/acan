import { useState } from "react";
import { untrusted, type SignedRequest, type Step } from "@acan/core/browser";
import { units } from "../chain";
import { DEPLOYMENT } from "../deployment";
import { TIDEWIRE_NOTE, TIDEWIRE_URL } from "../merchants";
import { plan as askPlanner, pinnedCatalog, preview, sourceName, type PlanReply, type Preview } from "../provenance-agent";
import { buildTaskReceipt, downloadReceipt, type TaskLine } from "../receipt-build";
import { useStore } from "../store";
import { Icon } from "../ui";

const STARTERS = [
  { text: "Buy the cheapest ledger report", hint: "traces back to you" },
  { text: "Read today's Tidewire note and buy the report it recommends", hint: "the note carries a hidden instruction" },
  { text: "Get me a route with traffic from Marlow Maps", hint: "traces back to you" },
];

type Phase = "idle" | "planning" | "planned" | "running" | "done";

export function AutopilotView() {
  const s = useStore();
  const relay = DEPLOYMENT.aiRelay?.replace(/\/$/, "");
  const [task, setTask] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [reply, setReply] = useState<PlanReply | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pv, setPv] = useState<Preview | null>(null);
  const [results, setResults] = useState<{ ok: boolean; text: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const g = s.grant;
  const ready = s.step === 3 && g?.gated && g.catalog;
  const catalog = g?.catalog ?? pinnedCatalog([]);

  async function plan(t: string) {
    if (!relay || !ready || !t.trim()) return;
    setTask(t);
    setPhase("planning");
    setErr(null);
    setResults([]);
    try {
      const r = await askPlanner(relay, t.trim(), catalog);
      const f = { ...r.fields, maxAmount: r.fields.maxAmount ?? g!.limit };
      setReply(r);
      setFields(f);
      setPv(preview(r.plan, f, catalog));
      setPhase("planned");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }

  async function confirmAndRun() {
    if (!reply || !pv) return;
    setPhase("running");
    const request: SignedRequest = s.sb().signRequest(task, fields);
    s.add("info", `You signed the request on this device: “${task}”`);
    const out: { ok: boolean; text: string }[] = [];
    const lines: TaskLine[] = [];
    const startedAt = new Date().toISOString();
    await s.run("The agent is working…", async () => {
      for (const [i, p] of pv.pays.entries()) {
        const to = String(p.to.v);
        const amount = BigInt(String(p.amount.v));
        s.setBusy(`Payment ${i + 1}: asking the provenance co-signer…`);
        const r = await s.payFromPlan(request, reply.plan, i, to, amount);
        const merchant = s.names[to] ?? to;
        lines.push(r.ok ? { payIndex: i, to, amount, merchant, ok: true, tx: r.tx, authEntry: r.authEntry, cosignature: r.cosignature } : { payIndex: i, to, amount, merchant, ok: false, why: r.why });
        out.push({
          ok: r.ok,
          text: r.ok ? `Paid ${units(amount)} XLM to ${merchant}` : r.why ? `Held: ${units(amount)} XLM to ${merchant} did not trace back to you` : `Not paid: ${r.reason}`,
        });
      }
      if (lines.length) s.setReceipt(buildTaskReceipt(s.sb(), request, reply.plan, catalog, lines, startedAt));
    });
    setResults(out);
    setPhase("done");
  }

  const reset = () => {
    setPhase("idle");
    setReply(null);
    setPv(null);
    setResults([]);
    setTask("");
  };

  if (!relay) return <p className="muted">The AI relay is not configured for this deployment.</p>;

  return (
    <div className="stack">
      {!ready && (
        <div className="callout">
          <Icon name="key" />
          <div>
            <b>Autopilot needs an allowance with the provenance gate on.</b>
            <p className="muted small">
              {s.step === 1
                ? "Create a passkey wallet first."
                : s.step === 2
                  ? "Give the agent an allowance with “Provenance gate” ticked."
                  : g && !g.gated
                    ? "This allowance was granted without the gate. Revoke it, then press “Grant a new allowance” and keep “Provenance gate” ticked."
                    : "The allowance was revoked. Press “Grant a new allowance” in step 4 and keep “Provenance gate” ticked."}
            </p>
            <a className="button small" href="#/app/wallet">
              Go to Wallet & allowance
            </a>
          </div>
        </div>
      )}

      <section className={`ap-card ${ready ? "" : "dim"}`}>
        <h3>Give the agent a task</h3>
        <p className="muted small">
          It pays on its own, with no button for you to press per payment. A payment only goes through if who gets paid, how much, and
          the decision to pay all trace back to what you asked.
        </p>
        <form
          className="ap-input"
          onSubmit={(e) => {
            e.preventDefault();
            void plan(task);
          }}
        >
          <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Buy the cheapest ledger report" disabled={!ready || phase === "planning" || phase === "running"} maxLength={300} />
          <button disabled={!ready || !task.trim() || phase === "planning" || phase === "running"}>{phase === "planning" ? "Planning…" : "Plan it"}</button>
        </form>
        <div className="starters">
          {STARTERS.map((x, i) => (
            <button key={x.text} className={`starter ${i === 1 ? "attack" : ""}`} onClick={() => void plan(x.text)} disabled={!ready || phase === "planning" || phase === "running"}>
              <span>{x.text}</span>
              <span className="small muted">{x.hint}</span>
            </button>
          ))}
        </div>
        {err && <p className="error">{err}</p>}
      </section>

      {reply && pv && (
        <div className="ap-grid">
          <section className="ap-card enter">
            <div className="ap-head">
              <span className="chip">Planner</span>
              <span className="muted small">saw only your words and your pinned catalog</span>
            </div>
            {reply.say && <p className="say">{reply.say}</p>}
            <PlanSteps steps={reply.plan} />
            {pv.error && <p className="error">The plan does not run: {pv.error}</p>}
            {!pv.error && pv.pays.length === 0 && <p className="muted small">This plan makes no payment.</p>}
          </section>

          <section className="ap-card enter">
            <div className="ap-head">
              <span className="chip chip-new">Co-signer preview</span>
              <span className="muted small">the same check runs again, for real, before any signature</span>
            </div>
            {pv.pays.map((p, i) => (
              <Verdict key={i} to={String(p.to.v)} amount={String(p.amount.v)} taint={pv.taint[i]} srcTo={untrusted(p.to.src)} srcAmount={untrusted(p.amount.src)} ctx={untrusted(p.ctx)} names={s.names} />
            ))}
            {phase === "planned" && pv.pays.length > 0 && (
              <div className="confirm">
                <p className="small">
                  <b>Your request</b>, signed by a key on this device:
                </p>
                <dl className="fields">
                  <dt>Task</dt>
                  <dd>“{task}”</dd>
                  {fields.product && (
                    <>
                      <dt>Item</dt>
                      <dd className="mono">{fields.product}</dd>
                    </>
                  )}
                  <dt>Up to</dt>
                  <dd>{units(BigInt(fields.maxAmount))} XLM</dd>
                </dl>
                <div className="row">
                  <button onClick={() => void confirmAndRun()} disabled={!!s.busy}>
                    Sign request and let it run
                  </button>
                  <button className="secondary" onClick={reset} disabled={!!s.busy}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {phase === "done" && (
              <div className="results">
                {results.map((r, i) => (
                  <p key={i} className={r.ok ? "ok-line" : "held-line"}>
                    <Icon name={r.ok ? "check" : "block"} size={16} /> {r.text}
                  </p>
                ))}
                <p className="muted small">Details, and what you can do about a held payment, are in the activity log.</p>
                <div className="row">
                  {s.receipt && (
                    <>
                      <a className="button small" href="#/app/receipts">
                        Open the receipt
                      </a>
                      <button className="secondary small" onClick={() => downloadReceipt(s.receipt!)}>
                        Download it
                      </button>
                    </>
                  )}
                  <button className="secondary small" onClick={reset}>
                    New task
                  </button>
                </div>
              </div>
            )}
          </section>

          {reply.plan.some((x) => x.op === "fetch" && x.url === TIDEWIRE_URL) && (
            <section className="ap-card untrusted enter">
              <div className="ap-head">
                <span className="chip chip-bad">Untrusted content</span>
                <span className="muted small">what the agent read at {new URL(TIDEWIRE_URL).host}; the planner never saw it</span>
              </div>
              <pre className="note">
                <Highlighted text={TIDEWIRE_NOTE} />
              </pre>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Verdict(p: { to: string; amount: string; taint: string[]; srcTo: string[]; srcAmount: string[]; ctx: string[]; names: Record<string, string> }) {
  const clean = p.taint.length === 0;
  const valid = /^\d+$/.test(p.amount);
  const row = (label: string, src: string[]) => (
    <li className={src.length ? "bad" : "ok"}>
      <Icon name={src.length ? "block" : "check"} size={16} />
      <span>
        <b>{label}</b> {src.length ? <>came from {src.map(sourceName).join(" and ")}</> : <>traces to your request and your pinned catalog</>}
      </span>
    </li>
  );
  return (
    <div className={`verdict ${clean ? "clean" : "tainted"}`}>
      <div className="verdict-top">
        <b>
          {valid ? units(BigInt(p.amount)) : "?"} XLM → {p.names[p.to] ?? p.to}
        </b>
        <span className={`stamp ${clean ? "verified" : "failed"}`}>{clean ? "Will co-sign" : "Won't co-sign"}</span>
      </div>
      <ul className="trace-list">
        {row("Who gets paid", p.srcTo)}
        {row("How much", p.srcAmount)}
        {row("Whether to pay", p.ctx)}
      </ul>
    </div>
  );
}

function PlanSteps({ steps }: { steps: Step[] }) {
  const line = (x: Step, i: number, depth = 0): React.ReactNode => {
    const pad = { paddingLeft: depth * 16 };
    switch (x.op) {
      case "request":
        return <li key={i} style={pad}><Src k="user" /> your request: <code>{x.field}</code></li>;
      case "catalog":
        return <li key={i} style={pad}><Src k="pinned" /> your pinned catalog</li>;
      case "fetch":
        return <li key={i} style={pad}><Src k="tool" /> read <code>{x.url}</code></li>;
      case "lit":
        return <li key={i} style={pad}><Src k="planner" /> value the AI wrote: <code>{JSON.stringify(x.value)}</code></li>;
      case "field":
        return <li key={i} style={pad}>take <code>{x.key}</code> from <code>{x.from}</code></li>;
      case "filter":
        return <li key={i} style={pad}>keep items whose <code>{x.key}</code> is <code>{x.equals}</code></li>;
      case "cheapest":
        return <li key={i} style={pad}>pick the cheapest</li>;
      case "add":
        return <li key={i} style={pad}>add <code>{x.a}</code> and <code>{x.b}</code></li>;
      case "format":
        return <li key={i} style={pad}>build text from {x.args.map((a) => <code key={a}>{a}</code>)}</li>;
      case "if":
        return (
          <li key={i} style={pad}>
            if <code>{x.left}</code> is <code>{x.right}</code>:
            <ol>{x.then.map((y, j) => line(y, j, depth + 1))}</ol>
          </li>
        );
      case "pay":
        return <li key={i} style={pad} className="pay-step">pay <code>{x.amount}</code> to <code>{x.to}</code></li>;
      default:
        return <li key={i}>{JSON.stringify(x)}</li>;
    }
  };
  return <ol className="plan">{steps.map((x, i) => line(x, i))}</ol>;
}

function Src({ k }: { k: "user" | "pinned" | "tool" | "planner" }) {
  const t = { user: "you", pinned: "pinned", tool: "untrusted", planner: "AI-written" }[k];
  return <span className={`src src-${k}`}>{t}</span>;
}

function Highlighted({ text }: { text: string }) {
  const m = text.match(/\[Note to AI assistants:[^\]]*\]/);
  if (!m || m.index === undefined) return <>{text}</>;
  return (
    <>
      {text.slice(0, m.index)}
      <mark>{m[0]}</mark>
      {text.slice(m.index + m[0].length)}
    </>
  );
}
