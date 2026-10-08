import { useState } from "react";
import { LEDGERS_PER_HOUR, usdcToStroops } from "@acan/core/browser";
import { grantAgent, short, type AgentGrant } from "./acan";
import { AGENT_CHAT_URL } from "./AgentChat";
import type { GuardianConfig } from "./guardian";

/** What the local agent service drafts from a sentence (apps/agent/src/policy-draft.ts). */
export interface PolicyDraft {
  agentName: string;
  budgetUsdc: string;
  periodHours: number;
  expiresInHours: number;
  merchants: { url: string; name: string; address: string; capUsdc: string | null }[];
  maxPerPaymentUsdc: string | null;
  maxPayments: number;
  privateMode: boolean;
  summary: string;
  tiers: { auto: string; ask: string; block: string };
  notes: string[];
}

const EXAMPLES = [
  "Give my research agent $1 for the next 24 hours, small purchases only.",
  "Let my agent spend up to 20 cents a day at Southgate only, for a week.",
  "$0.50 for the next hour, private payments, no single payment above 5 cents.",
];

const hoursLabel = (h: number) => (h === 0 ? "no end date" : h < 48 ? `${h} hour${h === 1 ? "" : "s"}` : `${Math.round(h / 24)} days`);

/**
 * "Give my research agent $5 for the next 24 hours": the agent service drafts
 * a policy, this card shows exactly what the chain will enforce, and the
 * guardian approves it with the passkey. Nothing is created before that.
 */
export function PolicyComposer(props: {
  config: GuardianConfig | null;
  disabled: boolean;
  /** Runs a passkey action with the dashboard's busy/error handling. */
  run: (fn: () => Promise<void>) => void;
  onGranted: (g: AgentGrant) => void;
}) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [agentKey, setAgentKey] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const version = props.config?.allowlistPolicyVersion ?? "0.2";
  const policy = props.config?.allowlistPolicy ?? null;

  async function makeDraft(request: string) {
    setDrafting(true);
    setError(null);
    setDraft(null);
    try {
      const r = await fetch(`${AGENT_CHAT_URL}/policy/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: request }),
      });
      const raw = await r.text();
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        // Express answers an unknown route with an HTML page: an agent service
        // started before this feature existed.
        throw new Error(
          r.status === 404
            ? "The running agent service is an older version. Stop it (Ctrl+C) and start it again: npm run agent:chat:server"
            : `Unexpected answer from the agent service (HTTP ${r.status})`,
        );
      }
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setDraft(body.draft);
      setAgentKey(body.agentKey);
    } catch (e) {
      setError(
        e instanceof TypeError
          ? "The agent service is not running. Start it with: npm run agent:chat:server"
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setDrafting(false);
    }
  }

  const perPaymentDropped = Boolean(draft?.maxPerPaymentUsdc && version !== "0.3");

  const approve = () =>
    props.run(async () => {
      if (!draft || !agentKey) return;
      const periodLedgers = Math.max(1, Math.round(draft.periodHours * LEDGERS_PER_HOUR));
      const expires = draft.expiresInHours > 0 ? Math.round(draft.expiresInHours * LEDGERS_PER_HOUR) : undefined;
      const allowlist =
        policy && draft.merchants.length > 0
          ? {
              policy,
              recipients: draft.merchants.map((m) => ({ address: m.address, cap: m.capUsdc ? usdcToStroops(m.capUsdc) : 0n })),
              maxPayments: draft.maxPayments,
              maxPerPayment: draft.maxPerPaymentUsdc && version === "0.3" ? usdcToStroops(draft.maxPerPaymentUsdc) : 0n,
              version,
            }
          : undefined;
      const g = await grantAgent(agentKey, usdcToStroops(draft.budgetUsdc), periodLedgers, expires, allowlist);
      // Tell the local agent service to pay under the new rule (best effort).
      await fetch(`${AGENT_CHAT_URL}/agent/rule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ruleId: g.ruleId }),
      }).catch(() => undefined);
      setDraft(null);
      setText("");
      props.onGranted(g);
    });

  return (
    <div className="composer">
      <label className="composer-label" htmlFor="policy-text">
        Describe the allowance in your own words
      </label>
      <div className="composer-row">
        <textarea
          id="policy-text"
          rows={2}
          value={text}
          placeholder={EXAMPLES[0]}
          onChange={(e) => setText(e.target.value)}
          disabled={props.disabled || drafting}
        />
        <button onClick={() => void makeDraft(text || EXAMPLES[0])} disabled={props.disabled || drafting}>
          {drafting ? "Drafting…" : "Draft policy"}
        </button>
      </div>
      <div className="starters">
        {EXAMPLES.slice(1).map((ex) => (
          <button key={ex} className="ghost small-btn" disabled={props.disabled || drafting} onClick={() => setText(ex)}>
            {ex}
          </button>
        ))}
      </div>
      {error && <div className="banner error">{error}</div>}

      {draft && (
        <div className="policy-card">
          <div className="policy-title">
            <b>{draft.agentName}</b>
            <span className="muted small">{draft.summary}</span>
          </div>
          <dl>
            <dt>Budget</dt>
            <dd>
              {draft.budgetUsdc} USDC per {draft.periodHours === 24 ? "day" : hoursLabel(draft.periodHours)}
            </dd>
            <dt>Ends</dt>
            <dd>{draft.expiresInHours ? `after ${hoursLabel(draft.expiresInHours)}, on its own` : "never (revoke it yourself)"}</dd>
            <dt>May pay</dt>
            <dd>
              {draft.merchants.length === 0
                ? "nobody"
                : draft.merchants.map((m) => (
                    <div key={m.address}>
                      ✓ {m.name} <span className="mono muted">{short(m.address)}</span>
                      {m.capUsdc ? ` · at most ${m.capUsdc} USDC per period` : ""}
                    </div>
                  ))}
            </dd>
            <dt>Per payment</dt>
            <dd>{draft.maxPerPaymentUsdc && !perPaymentDropped ? `at most ${draft.maxPerPaymentUsdc} USDC` : "no limit of its own"}</dd>
            {draft.maxPayments > 0 && (
              <>
                <dt>Payments</dt>
                <dd>at most {draft.maxPayments} per period</dd>
              </>
            )}
            <dt>Privacy</dt>
            <dd>{draft.privateMode ? "private (run the agent with --private)" : "public payments"}</dd>
          </dl>
          <ul className="tiers">
            <li className="tier auto">{draft.tiers.auto}</li>
            <li className="tier ask">{draft.tiers.ask}</li>
            <li className="tier block">{draft.tiers.block}</li>
          </ul>
          {[...draft.notes, ...(perPaymentDropped ? ["The per-payment limit needs merchant policy v0.3 (npm run allowlist:deploy); it is left out."] : []), ...(!policy ? ["No merchant policy is configured, so only the overall budget and expiry apply."] : [])].map(
            (n) => (
              <p key={n} className="muted small">
                Note: {n}
              </p>
            ),
          )}
          <p className="muted small">
            For agent key <span className="mono">{agentKey ? short(agentKey) : "?"}</span>. The chain enforces every line above; the AI only
            drafted it.
          </p>
          <div className="policy-actions">
            <button onClick={approve} disabled={props.disabled || draft.merchants.length === 0}>
              Approve with passkey
            </button>
            <button className="ghost" onClick={() => setDraft(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
