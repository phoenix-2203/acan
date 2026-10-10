import { useEffect, useMemo, useState } from "react";
import { Keypair } from "@stellar/stellar-sdk";
import { delegationId, requestId, signDelegation, type SignedDelegation, type SignedRequest } from "@acan/core/browser";
import { units } from "../chain";
import { xlmToStroops } from "../ai-agent";
import { MERCHANTS } from "../merchants";
import { useStore } from "../store";
import { Icon } from "../ui";

const PRODUCT = "ledger-report";
const XLM = (s: string) => xlmToStroops(s).toString();

interface Node {
  id: string;
  name: string;
  role: string;
  max: bigint;
  chain: SignedDelegation[];
  key: Keypair;
}

/**
 * Agents hiring agents. You sign one task; your agent (Lead) hires Scout with
 * part of it, and Scout hires Runner with part of that. Nobody below Lead holds
 * a key on your account: every payment is co-signed only if the whole chain
 * back to you checks out and every budget on the way has room.
 */
export function TeamView() {
  const s = useStore();
  const g = s.grant;
  const ready = s.step === 3 && g?.gated && g.catalog;
  const [root, setRoot] = useState<SignedRequest | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [cancelled, setCancelled] = useState<Set<string>>(new Set());
  const [spent, setSpent] = useState<Record<string, bigint>>({});
  const [tick, bump] = useState(0);
  const southgate = MERCHANTS[1];
  const price = useMemo(() => xlmToStroops(southgate.items.find((i) => i.id === PRODUCT)!.priceXlm), [southgate]);

  // What the co-signer has counted under each link (the hosted co-signer is asked over HTTP).
  useEffect(() => {
    if (nodes.length === 0) return;
    let on = true;
    void Promise.all(nodes.map(async (n) => [n.id, await s.sb().spentUnder(n.id).catch(() => 0n)] as const)).then((pairs) => {
      if (on) setSpent(Object.fromEntries(pairs));
    });
    return () => {
      on = false;
    };
  }, [nodes, tick, s.refresh]);

  const start = () => {
    const sb = s.sb();
    const req = sb.signRequest("Research the ledger: buy ledger reports, up to 1.6 XLM", { product: PRODUCT, maxAmount: XLM("1.6") });
    const now = Math.floor(Date.now() / 1000);
    const scoutKey = Keypair.random();
    const runnerKey = Keypair.random();
    const toScout = signDelegation(sb.agent, {
      parent: requestId(req),
      delegate: scoutKey.publicKey(),
      task: "Find ledger data",
      fields: { product: PRODUCT, maxAmount: XLM("1.2") },
      nonce: `scout-${now}`,
      issuedAt: now - 1,
      ttlSeconds: 600,
    });
    const toRunner = signDelegation(scoutKey, {
      parent: delegationId(toScout),
      delegate: runnerKey.publicKey(),
      task: "Fetch one ledger report",
      fields: { product: PRODUCT, maxAmount: XLM("0.8") },
      nonce: `runner-${now}`,
      issuedAt: now - 1,
      ttlSeconds: 300,
    });
    setRoot(req);
    setCancelled(new Set());
    setNodes([
      { id: requestId(req), name: "Lead", role: "your agent", max: xlmToStroops("1.6"), chain: [], key: sb.agent },
      { id: delegationId(toScout), name: "Scout", role: "hired by Lead", max: xlmToStroops("1.2"), chain: [toScout], key: scoutKey },
      { id: delegationId(toRunner), name: "Runner", role: "hired by Scout", max: xlmToStroops("0.8"), chain: [toScout, toRunner], key: runnerKey },
    ]);
    s.add("info", "You signed the task: ledger reports, up to 1.6 XLM. Lead hired Scout (up to 1.2 XLM); Scout hired Runner (up to 0.8 XLM).");
  };

  const buy = (n: Node) =>
    s.run(`${n.name} is paying…`, async () => {
      await s.payDelegated(n.name, root!, n.chain, southgate.address, price);
      bump((x) => x + 1);
    });

  /** Scout tries to give a new helper more than Scout itself has, or another item. */
  const widen = (what: "budget" | "item") =>
    s.run("Scout hires a greedy helper…", async () => {
      const scout = nodes[1];
      const helper = Keypair.random();
      const now = Math.floor(Date.now() / 1000);
      const d = signDelegation(scout.key, {
        parent: scout.id,
        delegate: helper.publicKey(),
        task: what === "budget" ? "Spend 5 XLM on ledger reports" : "Buy the full dataset",
        fields: what === "budget" ? { product: PRODUCT, maxAmount: XLM("5") } : { product: "full-dataset", maxAmount: XLM("0.8") },
        nonce: `greedy-${now}-${what}`,
        issuedAt: now - 1,
        ttlSeconds: 300,
      });
      await s.payDelegated(what === "budget" ? "Helper (given 5 XLM by Scout)" : "Helper (sent for the full dataset)", root!, [...scout.chain, d], southgate.address, price);
    });

  const cancel = (n: Node) =>
    s.run(`Cancelling ${n.name}…`, async () => {
      await s.sb().cancel(n.id);
      setCancelled(new Set([...cancelled, n.id]));
      s.add("info", n.chain.length === 0 ? "You cancelled the whole task." : `You cancelled ${n.name}'s mandate, and everything ${n.name} handed on.`);
    });

  const isCancelled = (n: Node) => nodes.slice(0, nodes.indexOf(n) + 1).some((x) => cancelled.has(x.id));

  if (!ready) {
    return (
      <div className="callout">
        <Icon name="key" />
        <div>
          <b>Agent team needs an allowance with the provenance gate on.</b>
          <p className="muted small">Grant one in Wallet & allowance with “Provenance gate” ticked and Southgate Data allowed.</p>
          <a className="button small" href="#/app/wallet">
            Go to Wallet & allowance
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {!root ? (
        <section className="ap-card">
          <h3>Sign one task; let your agent build a team</h3>
          <p className="muted">
            You ask for ledger reports, up to 1.6 XLM. Your agent hires Scout with 1.2 XLM of that, and Scout hires Runner with 0.8. Sub-agents
            get no key on your account. Each of their payments is co-signed only if the chain back to you checks out, every budget on the way has
            room, and nothing on the way was cancelled.
          </p>
          <button onClick={start}>Sign the task and build the team</button>
        </section>
      ) : (
        <>
          <section className="ap-card">
            <div className="ap-head">
              <span className="chip chip-new">Your task</span>
              <span className="muted small">signed on this device · ledger reports · up to 1.6 XLM</span>
            </div>
            <ol className="team">
              {nodes.map((n, i) => {
                const spentHere = spent[n.id] ?? 0n;
                const off = isCancelled(n);
                return (
                  <li key={n.id} className={off ? "off" : ""} style={{ marginLeft: i * 28 }}>
                    <div className="team-top">
                      <b>{n.name}</b>
                      <span className="muted small">{n.role}</span>
                      {off && <span className="chip chip-bad">cancelled</span>}
                    </div>
                    <div className="meter compact">
                      <div className="meter-row">
                        <span className="small">
                          {units(spentHere)} of {units(n.max)} XLM
                        </span>
                        <span className="small muted mono">{n.id.slice(0, 8)}…</span>
                      </div>
                      <div className="bar">
                        <div className="fill" style={{ width: `${Math.min(100, Number((spentHere * 100n) / n.max))}%` }} />
                      </div>
                    </div>
                    <div className="row">
                      <button className="small" onClick={() => void buy(n)} disabled={!!s.busy}>
                        {n.name} buys a ledger report ({units(price)} XLM)
                      </button>
                      {!off && (
                        <button className="secondary small" onClick={() => void cancel(n)} disabled={!!s.busy}>
                          {i === 0 ? "Cancel the whole task" : `Cancel ${n.name}`}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
          <section className="ap-card">
            <h3>Try to break it</h3>
            <div className="starters">
              <button className="starter attack" onClick={() => void widen("budget")} disabled={!!s.busy}>
                <span>Scout gives a helper 5 XLM</span>
                <span className="small muted">more than Scout itself was given</span>
              </button>
              <button className="starter attack" onClick={() => void widen("item")} disabled={!!s.busy}>
                <span>Scout sends a helper for the full dataset</span>
                <span className="small muted">an item you never asked for</span>
              </button>
            </div>
            <p className="muted small">
              Suggested order: Runner buys (paid) → Scout buys (refused: Runner's spend already counts against Scout) → Lead buys (paid) → Runner
              buys again (refused: nothing left on the way up) → cancel Scout, then Runner tries (refused). Every refusal names the link that failed.
            </p>
            <button className="secondary small" onClick={() => setRoot(null)} disabled={!!s.busy}>
              Start a new team
            </button>
          </section>
        </>
      )}
    </div>
  );
}
