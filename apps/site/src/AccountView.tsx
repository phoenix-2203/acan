import { useCallback, useEffect, useRef, useState } from "react";
import { OZ_SMART_ACCOUNT } from "@acan/core/browser";
import {
  LEDGER_SECONDS,
  activity,
  contextRules,
  explorer,
  explorerFor,
  latestLedger,
  merchantPolicy,
  short,
  spendingLimit,
  tokenBalance,
  units,
  type ActivityItem,
  type MerchantPolicyView,
  type RuleView,
  type SpendingView,
} from "./chain";

interface RuleDetail {
  rule: RuleView;
  spending?: SpendingView | null;
  merchant?: MerchantPolicyView | null;
}

export interface AccountViewProps {
  account: string;
  /** Token whose balance and transfers are shown. */
  token: string;
  tokenLabel: string;
  /** Display names for addresses (merchants, agent, ...). */
  names: Record<string, string>;
  merchantPolicy?: { address: string; version: string };
  /** Rule to highlight (the agent's). */
  focusRule?: number;
  /** Bump to force a refresh (after a payment, a grant, a revoke). */
  refreshKey?: number;
  /** Seconds between automatic refreshes (0 = off). */
  autoRefresh?: number;
  /** How far back the activity list looks, in ledgers (default about a day). */
  historyLedgers?: number;
}

/**
 * A smart account as the chain sees it: its rules (who may sign what, under
 * which policies, until when), each policy's live state, and recent activity.
 */
export function AccountView(p: AccountViewProps) {
  const [now, setNow] = useState<number | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [rules, setRules] = useState<RuleDetail[] | null>(null);
  const [events, setEvents] = useState<ActivityItem[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Callers may pass a fresh `names` object on every render: key on its content.
  const names = useRef(p.names);
  names.current = p.names;
  const namesKey = JSON.stringify(p.names);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const ledger = await latestLedger();
      const [bal, list] = await Promise.all([tokenBalance(p.token, p.account).catch(() => null), contextRules(p.account)]);
      const details = await Promise.all(
        list.map(async (rule): Promise<RuleDetail> => {
          const hasLimit = rule.policies.includes(OZ_SMART_ACCOUNT.spendingLimitPolicy);
          const mp = p.merchantPolicy && rule.policies.includes(p.merchantPolicy.address) ? p.merchantPolicy : undefined;
          const [spending, merchant] = await Promise.all([
            hasLimit ? spendingLimit(p.account, rule.id, ledger) : Promise.resolve(undefined),
            mp ? merchantPolicy(mp.address, mp.version, p.account, rule.id) : Promise.resolve(undefined),
          ]);
          return { rule, spending, merchant };
        }),
      );
      setNow(ledger);
      setBalance(bal);
      setRules(details);
      activity(p.account, [p.token], names.current, p.historyLedgers)
        .then((ev) => {
          setEvents(ev);
          setEventsError(null);
        })
        .catch((e) => setEventsError(e instanceof Error ? e.message : String(e)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [p.account, p.token, p.merchantPolicy?.address, p.merchantPolicy?.version, namesKey, p.historyLedgers]);

  useEffect(() => {
    void load();
  }, [load, p.refreshKey]);

  useEffect(() => {
    if (!p.autoRefresh) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, p.autoRefresh * 1000);
    return () => clearInterval(t);
  }, [load, p.autoRefresh]);

  const name = (a: string) => p.names[a] ?? short(a);
  const policyName = (a: string) =>
    a === OZ_SMART_ACCOUNT.spendingLimitPolicy
      ? "Spending limit"
      : a === p.merchantPolicy?.address
        ? p.merchantPolicy.version === "0.1"
          ? "Merchant allowlist"
          : "Merchant budget"
        : a === OZ_SMART_ACCOUNT.thresholdPolicy
          ? "Threshold"
          : `Policy ${short(a)}`;

  return (
    <div className="acct">
      <div className="acct-head">
        <div>
          <div className="label">Smart account</div>
          <a className="mono" href={explorer("contract", p.account)} target="_blank" rel="noreferrer">
            {short(p.account, 6)}
          </a>
        </div>
        <div>
          <div className="label">Balance</div>
          <div className="mono">{balance === null ? "…" : `${units(balance)} ${p.tokenLabel}`}</div>
        </div>
        <div>
          <div className="label">Ledger</div>
          <div className="mono">{now ?? "…"}</div>
        </div>
        <button className="ghost small" onClick={() => void load()} disabled={loading}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>
      {error && <p className="error">Could not read testnet: {error}</p>}

      <div className="rules">
        {rules === null && !error && <p className="muted">Reading the account's rules from testnet…</p>}
        {rules?.map(({ rule, spending, merchant }) => {
          const expired = rule.validUntil !== undefined && now !== null && now > rule.validUntil;
          const focus = rule.id === p.focusRule;
          return (
            <div key={rule.id} className={`rule ${focus ? "focus" : ""} ${expired ? "expired" : ""}`}>
              <div className="rule-top">
                <span className="rule-id mono">#{rule.id}</span>
                <span className="rule-name">{rule.name}</span>
                <span className="tag">{rule.scope}</span>
                {expired ? (
                  <span className="tag bad">expired</span>
                ) : rule.validUntil !== undefined && now !== null ? (
                  <span className="tag">expires in {duration((rule.validUntil - now) * LEDGER_SECONDS)}</span>
                ) : null}
              </div>
              <div className="rule-line">
                <span className="muted">Signs:</span> {rule.signers.map((s) => s.label).join(", ") || "none"}
              </div>
              {rule.policies.length > 0 && (
                <div className="rule-line">
                  <span className="muted">Policies:</span> {rule.policies.map(policyName).join(" + ")}
                </div>
              )}
              {spending && (
                <Meter
                  label={`Spent this period (${duration(spending.periodLedgers * LEDGER_SECONDS)} rolling)`}
                  used={spending.spent}
                  cap={spending.limit}
                  unit={p.tokenLabel}
                  extra={`${spending.payments} payment${spending.payments === 1 ? "" : "s"}`}
                />
              )}
              {merchant && (
                <div className="shops">
                  <div className="muted small">
                    May only pay
                    {merchant.maxPayments ? ` · at most ${merchant.maxPayments} payments per period (${merchant.payments ?? 0} used)` : ""}
                    {merchant.maxPerPayment ? ` · at most ${units(merchant.maxPerPayment)} ${p.tokenLabel} per payment` : ""}
                  </div>
                  {merchant.recipients.map((r) =>
                    r.cap > 0n ? (
                      <Meter key={r.address} label={name(r.address)} used={r.spent} cap={r.cap} unit={p.tokenLabel} compact />
                    ) : (
                      <div key={r.address} className="shop-line">
                        <a href={explorerFor(r.address)} target="_blank" rel="noreferrer">
                          {name(r.address)}
                        </a>
                        {merchant.version !== "0.1" && <span className="muted"> · no cap of its own</span>}
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="label" style={{ marginTop: 18 }}>
        Recent on-chain activity
      </div>
      {eventsError && events === null ? (
        <p className="error">Could not read events: {eventsError}</p>
      ) : events === null ? (
        <p className="muted small">Reading events…</p>
      ) : events.length === 0 ? (
        <p className="muted small">No activity in the last {duration((p.historyLedgers ?? 17_280) * LEDGER_SECONDS)}.</p>
      ) : (
        <ul className="activity">
          {events.slice(0, 12).map((e) => (
            <li key={e.id} className={e.kind}>
              <span className="mono small muted">{new Date(e.at).toLocaleString()}</span>
              <span>
                {e.text}
                {e.amount !== undefined && <b> {units(e.amount)} {e.token}</b>}
              </span>
              <a className="mono small" href={explorer("tx", e.txHash)} target="_blank" rel="noreferrer">
                {e.txHash.slice(0, 8)}…
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Meter(p: { label: string; used: bigint; cap: bigint; unit: string; extra?: string; compact?: boolean }) {
  const pct = p.cap > 0n ? Math.min(100, Number((p.used * 10_000n) / p.cap) / 100) : 0;
  return (
    <div className={`meter ${p.compact ? "compact" : ""}`}>
      <div className="meter-row">
        <span>{p.label}</span>
        <span className="mono">
          {units(p.used)} / {units(p.cap)} {p.unit}
          {p.extra ? ` · ${p.extra}` : ""}
        </span>
      </div>
      <div className="bar">
        <div className={`fill ${pct >= 100 ? "full" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function duration(seconds: number): string {
  if (seconds <= 0) return "0 min";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} days`;
}
