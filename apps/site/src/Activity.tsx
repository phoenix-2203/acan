import { explorer, units } from "./chain";
import { useStore, type LogLine } from "./store";

/** The sandbox's activity log: payments, refusals (with "why"), and payments the co-signer would not back. */
export function Activity() {
  const s = useStore();
  return (
    <aside className="activity-panel">
      <div className="panel-head">
        <b>Activity</b>
        <span className="muted small">newest first</span>
      </div>
      {(s.busy || s.error) && (
        <div className={`status ${s.error && !s.busy ? "bad" : ""}`} role="status">
          {s.busy && <span className="spinner" aria-hidden="true" />}
          {s.busy ?? s.error}
        </div>
      )}
      {s.log.length === 0 && !s.busy && <p className="muted small empty">Nothing yet. What the agent pays, and what is refused, shows up here.</p>}
      <div className="log" aria-live="polite">
        {s.log.map((l) => (l.block ? <BlockCard key={l.id} l={l} /> : l.held ? <HeldCard key={l.id} l={l} /> : <Line key={l.id} l={l} />))}
      </div>
    </aside>
  );
}

function Line({ l }: { l: LogLine }) {
  return (
    <div className={`line ${l.kind} enter`}>
      <span className="mono muted">{l.at}</span>
      <span>{l.text}</span>
      {l.tx && (
        <a className="mono" href={explorer("tx", l.tx)} target="_blank" rel="noreferrer">
          {l.tx.slice(0, 8)}…
        </a>
      )}
    </div>
  );
}

function BlockCard({ l }: { l: LogLine }) {
  const s = useStore();
  const b = l.block!;
  return (
    <div className={`block-card ${b.severity} enter`} role="alert">
      <div className="block-head">
        <span className="mono muted">{l.at}</span>
        <b>Payment blocked: {b.title}</b>
      </div>
      <dl>
        <dt>Requested</dt>
        <dd>{units(b.requested)} XLM</dd>
        <dt>To</dt>
        <dd>{b.recipient}</dd>
        <dt>Stopped by</dt>
        <dd>
          {b.policy}
          {b.code !== null && <span className="mono muted"> (#{b.code})</span>}
        </dd>
        {b.left !== undefined && b.limit !== undefined && (
          <>
            <dt>Allowance left</dt>
            <dd>
              {units(b.left)} of {units(b.limit)} XLM today
            </dd>
          </>
        )}
      </dl>
      <p>{b.reason}</p>
      <p className="no-funds">No funds were transferred. This refusal came from the smart account on testnet.</p>
      {!b.settled && s.contractId && (
        <div className="block-actions">
          <span className="small muted">
            {b.severity === "high"
              ? "As the guardian you can still approve this one payment, but only if you know who this is."
              : "As the guardian you can approve this one payment. The agent's allowance stays as it is."}
          </span>
          <button className="secondary small" onClick={() => s.approveOnce(l)} disabled={!!s.busy}>
            Approve once with passkey
          </button>
          <button className="secondary small" onClick={() => s.settle(l.id, "denied")} disabled={!!s.busy}>
            Deny
          </button>
        </div>
      )}
      {b.settled && <p className="small muted">Guardian {b.settled} this payment.</p>}
    </div>
  );
}

function HeldCard({ l }: { l: LogLine }) {
  const s = useStore();
  const h = l.held!;
  return (
    <div className="held-card enter" role="alert">
      <div className="block-head">
        <span className="mono muted">{l.at}</span>
        <b>{h.verdict === "escalate" ? "Not co-signed: it doesn't trace back to you" : "Co-signer refused"}</b>
      </div>
      <dl>
        <dt>Wanted to pay</dt>
        <dd>
          {units(h.requested)} XLM to {h.recipient}
        </dd>
      </dl>
      <ul className="why">
        {h.why.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
      <p className="no-funds">Nothing was signed or sent.</p>
      {!h.settled && (
        <div className="block-actions">
          <button className="secondary small" onClick={() => s.tryAlone(l)} disabled={!!s.busy}>
            Let the agent try with its key alone
          </button>
          <button className="secondary small" onClick={() => s.approveOnce(l)} disabled={!!s.busy}>
            Approve once with passkey
          </button>
          <button className="secondary small" onClick={() => s.settle(l.id, "denied")} disabled={!!s.busy}>
            Deny
          </button>
        </div>
      )}
      {h.settled === "tried-alone" && <p className="small muted">The agent tried alone; see the smart account's answer above.</p>}
      {h.settled && h.settled !== "tried-alone" && <p className="small muted">Guardian {h.settled} this payment.</p>}
    </div>
  );
}
