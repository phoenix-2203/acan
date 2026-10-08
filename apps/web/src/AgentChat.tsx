import { useEffect, useRef, useState } from "react";

/** The local agent chat service (npm run agent:chat:server). */
export const AGENT_CHAT_URL = (import.meta as any).env?.VITE_AGENT_CHAT_URL ?? "http://127.0.0.1:4040";

interface ChatOption {
  id: string;
  label: string;
  detail?: string;
  action: { kind: "buy" | "approve" | "say" };
}

type ChatEvent = { seq: number; at: string } & (
  | { type: "user" | "agent" | "activity" | "error"; text: string }
  | { type: "options"; id: string; question: string; options: ChatOption[] }
  | { type: "chosen"; optionsId: string; optionId: string; label: string }
  | {
      type: "payment";
      status: "paid" | "blocked" | "refused" | "error";
      label: string;
      priceUsdc?: string;
      receipt?: string;
      reason?: string;
      block?: BlockedPayment;
    }
  | { type: "budget"; limitUsdc: string; spentUsdc: string; remainingUsdc: string }
);

export interface BlockedPayment {
  title: string;
  policy: string;
  reason: string;
  severity: "medium" | "high";
  code: number | null;
  requestedUsdc?: string;
  recipient: string;
  allowanceLeftUsdc?: string;
  limitUsdc?: string;
}

/** "Why was this blocked?": what was asked, which control refused it, what is left. */
export function BlockCard({ b, unit = "USDC" }: { b: BlockedPayment; unit?: string }) {
  return (
    <div className={`block-card ${b.severity}`} role="alert">
      <div className="block-title">Payment blocked: {b.title}</div>
      <dl>
        {b.requestedUsdc && (
          <>
            <dt>Requested</dt>
            <dd>
              {b.requestedUsdc} {unit}
            </dd>
          </>
        )}
        <dt>To</dt>
        <dd>{b.recipient}</dd>
        <dt>Stopped by</dt>
        <dd>
          {b.policy}
          {b.code !== null ? <span className="mono muted"> (#{b.code})</span> : null}
        </dd>
        {b.allowanceLeftUsdc && (
          <>
            <dt>Allowance left</dt>
            <dd>
              {b.allowanceLeftUsdc} of {b.limitUsdc} {unit}
            </dd>
          </>
        )}
      </dl>
      <p>{b.reason}</p>
      <p className="no-funds">No funds were transferred. The smart account refused before any money moved.</p>
    </div>
  );
}

interface ChatState {
  /** Changes when a new conversation starts or the service restarts. */
  generation: string;
  model: string;
  mode: string;
  autopilot: boolean;
  busy: boolean;
  pending: { id: string; options: ChatOption[] } | null;
  events: ChatEvent[];
}

const STARTERS = [
  "What can you buy for me, and at what prices?",
  "Get me the latest Stellar ledger as cheaply as possible.",
  "Tell me a fact about Stellar or x402.",
  "How much of my allowance is left?",
];

/**
 * Talk to the agent: type a request or tap a suggestion. The agent proposes
 * purchases as buttons; nothing is paid until you tap one, and the smart
 * account still enforces the allowance on-chain.
 */
export function AgentChat({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<ChatState | null>(null);
  const [offline, setOffline] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const events = useRef<ChatEvent[]>([]);
  const generation = useRef("");
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const get = async (after: number) => (await (await fetch(`${AGENT_CHAT_URL}/chat?after=${after}`)).json()) as ChatState;
        const after = events.current.at(-1)?.seq ?? 0;
        let s = await get(after);
        if (s.generation !== generation.current) {
          // First load, or a new conversation started elsewhere: take it from the beginning.
          generation.current = s.generation;
          if (after > 0) s = await get(0);
          events.current = s.events;
        } else if (s.events.length) {
          events.current = [...events.current, ...s.events];
        }
        if (!stop) {
          setState({ ...s, events: events.current });
          setOffline(false);
        }
      } catch {
        if (!stop) setOffline(true);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const t = setInterval(poll, 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [enabled]);

  const count = state?.events.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [count, state?.busy]);

  async function post(path: string, body?: unknown) {
    setError(null);
    try {
      const r = await fetch(`${AGENT_CHAT_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      else setState((s) => (s ? { ...s, busy: true } : s));
    } catch {
      setOffline(true);
    }
  }

  const send = (t: string) => {
    const msg = t.trim();
    if (!msg) return;
    setText("");
    void post("/chat/message", { text: msg });
  };

  if (offline) {
    return (
      <p className="muted">
        The agent chat service is not running. Start it in another terminal with <code>npm run agent:chat:server</code>.
      </p>
    );
  }
  if (!state) return <p className="muted">Connecting to the agent…</p>;

  const busy = state.busy;
  return (
    <div className="chat">
      <div className="chat-meta muted small">
        {state.model} · {state.mode} payments · {state.autopilot ? "autopilot on" : "you approve each purchase"}
        <button className="link" onClick={() => void post("/chat/reset")} disabled={busy}>
          New conversation
        </button>
      </div>

      <div className="chat-log">
        {state.events.length === 0 && <p className="muted small">Ask for something, or tap a suggestion below.</p>}
        {state.events.map((e) => {
          switch (e.type) {
            case "user":
              return (
                <div key={e.seq} className="msg user">
                  {e.text}
                </div>
              );
            case "agent":
              return (
                <div key={e.seq} className="msg agent">
                  {e.text}
                </div>
              );
            case "activity":
              return (
                <div key={e.seq} className="chat-note">
                  {e.text}
                </div>
              );
            case "options": {
              const open = state.pending?.id === e.id;
              const chosen = state.events.find((x) => x.type === "chosen" && x.optionsId === e.id) as
                | Extract<ChatEvent, { type: "chosen" }>
                | undefined;
              return (
                <div key={e.seq} className="msg agent options">
                  <div>{e.question}</div>
                  <div className="choices">
                    {e.options.map((o) => (
                      <button
                        key={o.id}
                        className={`choice ${o.action.kind === "say" ? "plain" : ""} ${chosen?.optionId === o.id ? "picked" : ""}`}
                        disabled={!open || busy}
                        onClick={() => void post("/chat/choose", { optionsId: e.id, optionId: o.id })}
                      >
                        <span>{o.label}</span>
                        {o.detail && <span className="choice-detail">{o.detail}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              );
            }
            case "chosen":
              return (
                <div key={e.seq} className="msg user">
                  {e.label}
                </div>
              );
            case "payment":
              if (e.block) return <BlockCard key={e.seq} b={e.block} />;
              return (
                <div key={e.seq} className={`chat-pay ${e.status}`}>
                  {e.status === "paid" ? "PAID" : e.status.toUpperCase()} {e.priceUsdc ? `${e.priceUsdc} USDC` : ""} · {e.label}
                  {e.receipt?.startsWith("http") ? (
                    <a href={e.receipt} target="_blank" rel="noreferrer" className="mono">
                      {" "}
                      tx
                    </a>
                  ) : e.receipt ? (
                    <span className="mono muted"> {e.receipt}</span>
                  ) : null}
                  {e.reason && <div className="small">{e.reason}</div>}
                </div>
              );
            case "budget":
              return (
                <div key={e.seq} className="chat-note">
                  Allowance left: {e.remainingUsdc} of {e.limitUsdc} USDC
                </div>
              );
            case "error":
              return (
                <div key={e.seq} className="chat-pay error">
                  {e.text}
                </div>
              );
            default:
              return null;
          }
        })}
        {busy && <div className="chat-note typing">Agent is working…</div>}
        <div ref={bottom} />
      </div>

      {!busy && !state.pending && state.events.length === 0 && (
        <div className="starters">
          {STARTERS.map((s) => (
            <button key={s} className="ghost small-btn" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      {error && <div className="banner error">{error}</div>}
      <form
        className="chat-input"
        onSubmit={(ev) => {
          ev.preventDefault();
          send(text);
        }}
      >
        <input
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          placeholder={state.pending ? "Tap an option above, or type something else" : "Ask the agent…"}
          disabled={busy}
          maxLength={1000}
        />
        <button type="submit" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
