import { useCallback, useEffect, useState } from "react";
import { ASSETS, LEDGERS_PER_DAY, LEDGERS_PER_HOUR, usdcToStroops } from "@acan/core/browser";
import {
  currentLedger,
  explorer,
  fmt,
  grantAgent,
  kit,
  loadGrants,
  readAllowance,
  recentPayments,
  revokeAgent,
  short,
  usdcBalance,
  type Allowance,
  type AgentGrant,
  type Payment,
} from "./acan";
import {
  approve,
  checkRequest,
  fetchApprovals,
  fetchAudit,
  fetchConfig,
  reject,
  type GuardianConfig,
  type Approval,
  type AuditReport,
} from "./guardian";

type Busy = null | "create" | "connect" | "grant" | `revoke-${number}` | `approve-${string}` | `reject-${string}`;

const PERIODS = [
  { label: "per hour", ledgers: LEDGERS_PER_HOUR },
  { label: "per day", ledgers: LEDGERS_PER_DAY },
  { label: "per week", ledgers: LEDGERS_PER_DAY * 7 },
];

const EXPIRIES = [
  { label: "never", ledgers: 0 },
  { label: "in 1 hour", ledgers: LEDGERS_PER_HOUR },
  { label: "in 1 day", ledgers: LEDGERS_PER_DAY },
  { label: "in 7 days", ledgers: LEDGERS_PER_DAY * 7 },
];

/** "expires in 3 h", "expired", or "" (no expiry). ~5 s per ledger. */
function expiryLabel(validUntil: number | undefined, ledger: number | null): string {
  if (validUntil === undefined || ledger === null) return "";
  const left = validUntil - ledger;
  if (left < 0) return "expired";
  const mins = Math.round((left * 5) / 60);
  return mins >= 90 ? `expires in ${Math.round(mins / 60)} h` : `expires in ${mins} min`;
}

const periodLabel = (ledgers: number) =>
  PERIODS.find((p) => p.ledgers === ledgers)?.label ?? `per ${ledgers} ledgers`;

export default function App() {
  const [account, setAccount] = useState<string | undefined>();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [grants, setGrants] = useState<AgentGrant[]>([]);
  const [allowances, setAllowances] = useState<Record<number, Allowance | null>>({});
  const [payments, setPayments] = useState<Payment[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [agentKey, setAgentKey] = useState("");
  const [limit, setLimit] = useState("0.05");
  const [period, setPeriod] = useState(LEDGERS_PER_DAY);
  const [expiry, setExpiry] = useState(0);
  const [ledger, setLedger] = useState<number | null>(null);
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [config, setConfig] = useState<GuardianConfig | null>(null);
  const [allowOnly, setAllowOnly] = useState<Record<string, boolean>>({});
  /** Per-recipient cap in USDC as typed ("" = no cap). */
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [maxPayments, setMaxPayments] = useState("");
  const [useAllowlist, setUseAllowlist] = useState(true);
  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  // Silent restore of a previous passkey session.
  useEffect(() => {
    kit
      .connectWallet()
      .then((r) => r && setAccount(kit.contractId))
      .catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    if (!account) return;
    const g = loadGrants(account);
    setGrants(g);
    const [seq, bal, pays, ...allow] = await Promise.all([
      currentLedger().catch(() => null),
      usdcBalance(account).catch(() => null),
      recentPayments(account).catch(() => [] as Payment[]),
      ...g.map((x) => readAllowance(x.ruleId)),
    ]);
    setLedger(seq as number | null);
    setBalance(bal as bigint | null);
    setPayments(pays as Payment[]);
    setAllowances(Object.fromEntries(g.map((x, i) => [x.ruleId, allow[i] as Allowance | null])));
  }, [account]);

  // Guardian service (npm run guardian): approval requests + decrypted private spending.
  useEffect(() => {
    fetchConfig()
      .then((c) => {
        setConfig(c);
        setAllowOnly(Object.fromEntries(c.recipients.map((r) => [r.address, true])));
        if (c.agentAddress) setAgentKey((k) => k || c.agentAddress!);
      })
      .catch(() => setConfig(null));
  }, []);

  const refreshGuardian = useCallback(async () => {
    try {
      setApprovals(await fetchApprovals());
    } catch {
      setApprovals(null);
    }
  }, []);
  const refreshAudit = useCallback(async () => {
    try {
      setAudit(await fetchAudit());
      setAuditError(null);
    } catch (e) {
      setAuditError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    if (!account) return;
    refreshGuardian();
    refreshAudit();
    const t1 = setInterval(refreshGuardian, 2000);
    const t2 = setInterval(refreshAudit, 15000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [account, refreshGuardian, refreshAudit]);

  useEffect(() => {
    if (!account) return;
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [account, refresh]);

  async function run(kind: Busy, fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const create = () =>
    run("create", async () => {
      const r = await kit.createWallet("ACAN", "guardian", {
        autoSubmit: true,
        autoFund: true,
        nativeTokenContract: ASSETS.xlm.sac,
      });
      if (r.submitResult && !r.submitResult.success) {
        throw new Error(r.submitResult.error?.message ?? "Wallet deployment failed");
      }
      setAccount(r.contractId);
      setNotice("Guardian wallet created. Your passkey is its only admin.");
    });

  const connect = () =>
    run("connect", async () => {
      await kit.connectWallet({ prompt: true });
      setAccount(kit.contractId);
    });

  const grant = () =>
    run("grant", async () => {
      const allowlist =
        config?.allowlistPolicy && useAllowlist
          ? {
              policy: config.allowlistPolicy,
              recipients: config.recipients
                .filter((r) => allowOnly[r.address])
                .map((r) => ({ address: r.address, cap: caps[r.address]?.trim() ? usdcToStroops(caps[r.address].trim()) : 0n })),
              maxPayments: maxPayments.trim() ? Number(maxPayments.trim()) : 0,
            }
          : undefined;
      const g = await grantAgent(agentKey.trim(), usdcToStroops(limit), period, expiry || undefined, allowlist);
      setNotice(`Agent authorized under rule #${g.ruleId}. Copy the .env lines below into your project.`);
      setAgentKey("");
      await refresh();
    });

  const revoke = (ruleId: number) =>
    run(`revoke-${ruleId}`, async () => {
      await revokeAgent(ruleId);
      setNotice(`Rule #${ruleId} deleted. The agent key can no longer spend anything.`);
      await refresh();
    });

  const approveReq = (a: Approval) =>
    run(`approve-${a.id}`, async () => {
      await approve(a);
      setNotice(`Approved ${a.amountUsdc} USDC to ${a.merchant}. The agent will pay it now; its allowance is unchanged.`);
      await refreshGuardian();
    });

  const rejectReq = (a: Approval) =>
    run(`reject-${a.id}`, async () => {
      await reject(a);
      setNotice(`Rejected ${a.amountUsdc} USDC to ${a.merchant}.`);
      await refreshGuardian();
    });

  const pending = (approvals ?? []).filter((a) => a.status === "pending");
  useEffect(() => {
    document.title = pending.length ? `(${pending.length}) Approval needed · ACAN` : "ACAN guardian";
  }, [pending.length]);

  const nameOf = (addr?: string) => (addr ? audit?.names[addr] ?? short(addr) : "");

  return (
    <div className="page">
      <header className="top">
        <div>
          <div className="brand">ACAN</div>
          <h1>Allowances for autonomous agents</h1>
          <p className="lede">
            Your passkey owns the wallet. Your agent gets a capped key that only works for USDC, only up to
            the limit you set. Stellar enforces it on-chain at every payment.
          </p>
        </div>
        <span className="pill">Stellar testnet</span>
      </header>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
      {pending.length > 0 && (
        <div className="banner attention" role="alert">
          Your agent is asking you to approve {pending[0].amountUsdc} USDC to {pending[0].merchant}
          {pending.length > 1 ? ` (+${pending.length - 1} more)` : ""}.{" "}
          <button className="link" onClick={() => document.getElementById("approvals")?.scrollIntoView({ behavior: "smooth" })}>
            Review
          </button>
        </div>
      )}

      <section className="card">
        <div className="step">1</div>
        <div className="body">
          <h2>Guardian wallet</h2>
          {!account ? (
            <>
              <p className="muted">
                A smart account on Stellar controlled by a passkey (Touch ID, Face ID or a security key). No seed
                phrase. Fees are sponsored.
              </p>
              <div className="row">
                <button onClick={create} disabled={busy !== null}>
                  {busy === "create" ? "Creating…" : "Create with passkey"}
                </button>
                <button className="ghost" onClick={connect} disabled={busy !== null}>
                  {busy === "connect" ? "Connecting…" : "Use existing passkey"}
                </button>
              </div>
            </>
          ) : (
            <dl className="facts">
              <div>
                <dt>Smart account</dt>
                <dd>
                  <a href={explorer("contract", account)} target="_blank" rel="noreferrer" className="mono">
                    {short(account, 6)}
                  </a>
                  <button className="link" onClick={() => navigator.clipboard?.writeText(account)}>
                    copy
                  </button>
                </dd>
              </div>
              <div>
                <dt>USDC balance</dt>
                <dd className="mono big">{balance === null ? "—" : fmt(balance)}</dd>
              </div>
            </dl>
          )}
        </div>
      </section>

      <section className={`card ${account ? "" : "disabled"}`}>
        <div className="step">2</div>
        <div className="body">
          <h2>Authorize an agent</h2>
          <p className="muted">
            Paste the agent's public key from <code>npm run setup</code>. It will only be able to call the USDC
            contract, within this allowance.
          </p>
          <label>
            Agent public key
            <input
              className="mono"
              placeholder="G…"
              value={agentKey}
              onChange={(e) => setAgentKey(e.target.value)}
              disabled={!account}
            />
          </label>
          <div className="row">
            <label className="grow">
              Allowance (USDC)
              <input value={limit} onChange={(e) => setLimit(e.target.value)} disabled={!account} inputMode="decimal" />
            </label>
            <label className="grow">
              Period
              <select value={period} onChange={(e) => setPeriod(Number(e.target.value))} disabled={!account}>
                {PERIODS.map((p) => (
                  <option key={p.ledgers} value={p.ledgers}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grow">
              Expires
              <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))} disabled={!account}>
                {EXPIRIES.map((x) => (
                  <option key={x.ledgers} value={x.ledgers}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {config?.allowlistPolicy && (
            <fieldset className="allowlist">
              <label className="check">
                <input type="checkbox" checked={useAllowlist} onChange={(e) => setUseAllowlist(e.target.checked)} />
                Only allow payments to these recipients (merchant budget contract)
              </label>
              {useAllowlist && (
                <>
                  {config.recipients.map((r) => (
                    <div className="recipient-row" key={r.address}>
                      <label className="check sub">
                        <input
                          type="checkbox"
                          checked={!!allowOnly[r.address]}
                          onChange={(e) => setAllowOnly({ ...allowOnly, [r.address]: e.target.checked })}
                        />
                        {r.label} <span className="mono muted">{short(r.address)}</span>
                      </label>
                      <input
                        className="cap"
                        placeholder="no cap"
                        inputMode="decimal"
                        aria-label={`Cap for ${r.label} (USDC per period)`}
                        value={caps[r.address] ?? ""}
                        disabled={!allowOnly[r.address]}
                        onChange={(e) => setCaps({ ...caps, [r.address]: e.target.value })}
                      />
                    </div>
                  ))}
                  <p className="muted small">
                    Caps are USDC per period for each recipient, on top of the overall allowance. Leave blank for no
                    cap.
                  </p>
                  <label className="inline">
                    Max payments per period
                    <input
                      className="cap"
                      placeholder="no limit"
                      inputMode="numeric"
                      value={maxPayments}
                      onChange={(e) => setMaxPayments(e.target.value.replace(/[^0-9]/g, ""))}
                    />
                  </label>
                </>
              )}
            </fieldset>
          )}
          <button onClick={grant} disabled={!account || busy !== null || !agentKey.trim()}>
            {busy === "grant" ? "Waiting for passkey…" : "Approve with passkey"}
          </button>
        </div>
      </section>

      <section className={`card ${account ? "" : "disabled"}`}>
        <div className="step">3</div>
        <div className="body">
          <h2>Active allowances</h2>
          {grants.length === 0 && <p className="muted">No agents authorized yet.</p>}
          {grants.map((g) => {
            const a = allowances[g.ruleId];
            const spent = a?.spent ?? 0n;
            const lim = a?.limit ?? g.limitStroops;
            const pct = lim > 0n ? Number((spent * 1000n) / lim) / 10 : 0;
            return (
              <div className="grant" key={g.ruleId}>
                <div className="grant-head">
                  <span className="mono">Rule #{g.ruleId}</span>
                  <span className="mono muted">agent {short(g.agentKey)}</span>
                  {a === null && <span className="tag">removed</span>}
                  {a !== null && expiryLabel(g.validUntil, ledger) && (
                    <span className="tag">
                      {expiryLabel(g.validUntil, ledger)}
                    </span>
                  )}
                </div>
                {g.recipients && (
                  <div className="muted small">
                    May only pay:{" "}
                    {g.recipients
                      .map((r, i) => {
                        const label = config?.recipients.find((x) => x.address === r)?.label ?? short(r);
                        const cap = g.caps?.[i];
                        return cap && cap !== "0" ? `${label} (max ${fmt(BigInt(cap))})` : label;
                      })
                      .join(", ")}
                    {g.maxPayments ? `; at most ${g.maxPayments} payments ${periodLabel(g.periodLedgers)}` : ""}
                  </div>
                )}
                <div className="meter" aria-label={`${pct}% of allowance used`}>
                  <div className="fill" style={{ width: `${Math.min(pct, 100)}%` }} />
                </div>
                <div className="grant-foot">
                  <span className="mono">
                    {fmt(spent)} / {fmt(lim)} USDC {periodLabel(g.periodLedgers)}
                  </span>
                  <span className="muted">{a ? `${a.payments} payment(s)` : ""}</span>
                  <button
                    className="danger"
                    onClick={() => revoke(g.ruleId)}
                    disabled={busy !== null || a === null}
                  >
                    {busy === `revoke-${g.ruleId}` ? "Revoking…" : "Revoke"}
                  </button>
                </div>
                <pre className="env">{`SMART_ACCOUNT=${account}\nAGENT_RULE_ID=${g.ruleId}`}</pre>
              </div>
            );
          })}
        </div>
      </section>

      <section className={`card ${account ? "" : "disabled"}`}>
        <div className="step">4</div>
        <div className="body">
          <h2>Payments from this wallet</h2>
          {payments.length === 0 && <p className="muted">No USDC payments in the last day.</p>}
          <ul className="feed">
            {payments.slice(0, 20).map((p) => (
              <li key={p.id}>
                <span className="mono">{fmt(p.amount)} USDC</span>
                <span className="muted">to {short(p.to)}</span>
                <span className="muted">{new Date(p.closedAt).toLocaleTimeString()}</span>
                <a href={explorer("tx", p.txHash)} target="_blank" rel="noreferrer" className="mono">
                  {p.txHash.slice(0, 10)}…
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className={`card ${account ? "" : "disabled"}`}>
        <div className="step">5</div>
        <div className="body">
          <h2 id="approvals">Approval requests</h2>
          {approvals === null ? (
            <p className="muted">
              Start the guardian service with <code>npm run guardian</code> to receive requests from your agent.
            </p>
          ) : approvals.length === 0 ? (
            <p className="muted">
              No requests. When a payment would exceed the allowance, the agent can ask you to approve that one
              payment here.
            </p>
          ) : (
            <ul className="requests">
              {approvals.map((a) => {
                const problem = account ? checkRequest(a, account) : "connect the wallet first";
                return (
                  <li key={a.id} className={`request ${a.status}`}>
                    <div className="request-head">
                      <span className="mono big">{a.amountUsdc} USDC</span>
                      <span>to {a.merchant}</span>
                      <span className="tag">{a.status}</span>
                    </div>
                    <div className="muted">
                      “{a.reason}”
                    </div>
                    <div className="mono muted small">{a.url}</div>
                    {a.status === "pending" &&
                      (problem ? (
                        <div className="banner error">Refusing to sign: {problem}</div>
                      ) : (
                        <div className="row">
                          <button onClick={() => approveReq(a)} disabled={busy !== null}>
                            {busy === `approve-${a.id}` ? "Waiting for passkey…" : "Approve with passkey"}
                          </button>
                          <button className="ghost" onClick={() => rejectReq(a)} disabled={busy !== null}>
                            Reject
                          </button>
                        </div>
                      ))}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section className={`card ${account ? "" : "disabled"}`}>
        <div className="step">6</div>
        <div className="body">
          <h2>Private spending</h2>
          <p className="muted">
            Payments the agent settled confidentially. The public sees who paid whom, never how much. Your auditor
            key decrypts the amounts on this computer.
          </p>
          {auditError && <p className="muted">Guardian service unavailable ({auditError}). Run <code>npm run guardian</code>.</p>}
          {audit && (
            <>
              <table className="audit">
                <thead>
                  <tr>
                    <th>Ledger</th>
                    <th>Event</th>
                    <th>Public sees</th>
                    <th>You see</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {audit.rows
                    .filter((r) => r.type !== "register")
                    .slice()
                    .reverse()
                    .map((r) => (
                      <tr key={`${r.txHash}-${r.type}`}>
                        <td className="mono">{r.ledger}</td>
                        <td>
                          {r.type === "transfer"
                            ? `${nameOf(r.from)} → ${nameOf(r.to)}`
                            : r.type === "merge"
                              ? "merge into spendable"
                              : `${r.type} ${nameOf(r.to)}`}
                        </td>
                        <td className="mono">{r.publicAmount !== null ? `${fmt(BigInt(r.publicAmount))} USDC` : "hidden"}</td>
                        <td className="mono">
                          {r.decryptedAmount
                            ? `${fmt(BigInt(r.decryptedAmount))} USDC`
                            : r.publicAmount !== null
                              ? `${fmt(BigInt(r.publicAmount))} USDC`
                              : audit.auditorKey
                                ? "not decryptable"
                                : "no auditor key"}
                        </td>
                        <td>
                          <a href={explorer("tx", r.txHash)} target="_blank" rel="noreferrer" className="mono">
                            {r.txHash.slice(0, 8)}…
                          </a>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <ul className="feed">
                {Object.entries(audit.totalsTo).map(([to, total]) => (
                  <li key={to}>
                    <span>Total settled to {nameOf(to)}</span>
                    <span className="mono">{fmt(BigInt(total))} USDC</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>

      <footer className="muted">
        Built on OpenZeppelin smart accounts, x402, Soroban and confidential tokens. Testnet only.
      </footer>
    </div>
  );
}
