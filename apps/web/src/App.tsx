import { useCallback, useEffect, useState } from "react";
import { ASSETS, LEDGERS_PER_DAY, LEDGERS_PER_HOUR, usdcToStroops, type RecoveryCode } from "@acan/core/browser";
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
  agentRulesOnChain,
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
  fetchBudgets,
  fetchConfig,
  reject,
  reportBudget,
  type BudgetRequest,
  type GuardianConfig,
  type Approval,
  type AuditReport,
  setFrozen,
} from "./guardian";
import { auditCsv, auditJson, download } from "./audit-export";
import { AgentChat } from "./AgentChat";
import { TasksPanel } from "./TasksPanel";
import { RecoveryBox } from "./RecoveryBox";
import { connectRecovered, recoverWallet, replaceRecovery, setupRecovery } from "./recovery";
import { PolicyComposer } from "./PolicyComposer";

type Busy =
  | null
  | "create"
  | "connect"
  | "recovery"
  | "grant"
  | `revoke-${number}`
  | "revoke-all"
  | "freeze"
  | `approve-${string}`
  | `reject-${string}`
  | `budget-${string}`;

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
  const [budgets, setBudgets] = useState<BudgetRequest[]>([]);
  const [config, setConfig] = useState<GuardianConfig | null>(null);
  const [newCode, setNewCode] = useState<RecoveryCode | null>(null);
  const [allowOnly, setAllowOnly] = useState<Record<string, boolean>>({});
  /** Per-recipient cap in USDC as typed ("" = no cap). */
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [maxPayments, setMaxPayments] = useState("");
  /** Largest single payment in USDC as typed ("" = no limit). Needs policy v0.3. */
  const [maxPerPayment, setMaxPerPayment] = useState("");
  const [useAllowlist, setUseAllowlist] = useState(true);
  const [useGate, setUseGate] = useState(true);
  const [audit, setAudit] = useState<AuditReport | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  /** Agent rule ids that exist on-chain (null = could not read). */
  const [onChainIds, setOnChainIds] = useState<Set<number> | null>(null);

  // Silent restore of a previous passkey session.
  useEffect(() => {
    const recovered = connectRecovered();
    if (recovered) {
      setAccount(recovered);
      return;
    }
    kit
      .connectWallet()
      .then((r) => r && setAccount(kit.contractId))
      .catch(() => undefined);
  }, []);

  const refresh = useCallback(async () => {
    if (!account) return;
    // The chain is the source of truth: list every agent rule on the account,
    // including ones this browser has no record of.
    const local = loadGrants(account);
    const onChain = await agentRulesOnChain().catch(() => null);
    const discovered: AgentGrant[] = (onChain ?? [])
      .filter((r) => !local.some((l) => l.ruleId === r.ruleId))
      .map((r) => ({
        ruleId: r.ruleId,
        agentKey: r.agentKey,
        limitStroops: 0n,
        periodLedgers: LEDGERS_PER_DAY,
        validUntil: r.validUntil,
        task: r.name.startsWith("task") ? r.name : undefined,
        discovered: true,
        createdAt: "",
      }));
    const g = [...local, ...discovered].sort((a, b) => a.ruleId - b.ruleId);
    setGrants(g);
    setOnChainIds(onChain ? new Set(onChain.map((r) => r.ruleId)) : null);
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
      setBudgets(await fetchBudgets());
    } catch {
      setBudgets([]);
    }
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
      if (config?.recoveryScopePolicy) setNewCode(await setupRecovery(config.recoveryScopePolicy));
    });

  const makeRecoveryCode = () =>
    run("recovery", async () => {
      if (!config?.recoveryScopePolicy) throw new Error("Set RECOVERY_SCOPE_POLICY (npm run recovery:deploy) and restart the guardian service");
      setNewCode(await setupRecovery(config.recoveryScopePolicy));
    });

  const newRecoveryCode = () =>
    run("recovery", async () => {
      if (!config?.recoveryScopePolicy) throw new Error("Set RECOVERY_SCOPE_POLICY (npm run recovery:deploy) and restart the guardian service");
      const r = await replaceRecovery(config.recoveryScopePolicy);
      setNewCode(r.code);
      if (r.warning) setError(r.warning);
      else setNotice(`New recovery code (rule #${r.code.ruleId}). The old code no longer works.`);
    });

  const recover = (code: string) =>
    run("recovery", async () => {
      const r = await recoverWallet(code, setNotice, config?.recoveryScopePolicy);
      setAccount(r.account);
      setNotice(`Recovered: this browser's new passkey was added to ${short(r.account, 6)} (tx ${r.tx.slice(0, 8)}…).`);
    });

  const connect = () =>
    run("connect", async () => {
      const recovered = connectRecovered();
      if (recovered) {
        setAccount(recovered);
        return;
      }
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
              maxPerPayment: maxPerPayment.trim() ? usdcToStroops(maxPerPayment.trim()) : 0n,
              version: config.allowlistPolicyVersion ?? "0.2",
            }
          : undefined;
      const gate =
        useGate && config?.cosignerGatePolicy && config.cosignerAddress ? { policy: config.cosignerGatePolicy, cosigner: config.cosignerAddress } : undefined;
      const g = await grantAgent(agentKey.trim(), usdcToStroops(limit), period, expiry || undefined, allowlist, undefined, gate);
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

  /** Emergency stop: delete every live agent rule, one passkey approval each. */
  const revokeAll = () =>
    run("revoke-all", async () => {
      const live = grants.filter(isLive);
      let done = 0;
      for (const g of live) {
        setNotice(`Emergency stop: revoking rule #${g.ruleId} (${done + 1} of ${live.length})…`);
        await revokeAgent(g.ruleId);
        done++;
      }
      setNotice(`Emergency stop complete: ${done} agent rule(s) deleted. No agent key can spend from this wallet.`);
      await refresh();
    });

  const isLive = (g: AgentGrant) =>
    allowances[g.ruleId] !== null &&
    (onChainIds?.has(g.ruleId) ?? true) &&
    !(g.validUntil !== undefined && ledger !== null && ledger > g.validUntil);
  const liveCount = grants.filter(isLive).length;

  const toggleFreeze = () =>
    run("freeze", async () => {
      const frozen = await setFrozen(!config?.frozen);
      setConfig((c) => (c ? { ...c, frozen } : c));
      setNotice(frozen ? "Agent requests frozen; pending ones were rejected." : "Agent requests accepted again.");
      await refreshGuardian();
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
  const pendingBudgets = budgets.filter((b) => b.status === "pending");
  const waiting = pending.length + pendingBudgets.length;
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Approval needed · ACAN` : "ACAN guardian";
  }, [waiting]);

  const approveBudget = (b: BudgetRequest) =>
    run(`budget-${b.id}`, async () => {
      // One passkey approval creates a rule that ends by itself: the budget is
      // both the spending limit and the period, and the rule expires with it.
      const ledgers = b.minutes * 12; // ~5 s per ledger
      const g = await grantAgent(
        b.agentKey,
        BigInt(b.amount),
        ledgers,
        ledgers,
        config?.allowlistPolicy
          ? {
              policy: config.allowlistPolicy,
              recipients: b.recipients.map((r) => ({ address: r.address, cap: 0n })),
              maxPayments: 0,
              version: config.allowlistPolicyVersion ?? "0.2",
            }
          : undefined,
        b.task || b.reason,
      );
      await reportBudget(b.id, { ruleId: g.ruleId });
      setNotice(`Task budget approved: rule #${g.ruleId}, ${b.amountUsdc} USDC for ${b.minutes} min. It expires on its own.`);
      await refresh();
      await refreshGuardian();
    });

  const rejectBudget = (b: BudgetRequest) =>
    run(`budget-${b.id}`, async () => {
      await reportBudget(b.id, "reject");
      setNotice(`Budget request for ${b.amountUsdc} USDC rejected.`);
      await refreshGuardian();
    });

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
      {waiting > 0 && (
        <div className="banner attention" role="alert">
          {pendingBudgets.length > 0
            ? `Your agent is asking for a task budget of ${pendingBudgets[0].amountUsdc} USDC for ${pendingBudgets[0].minutes} min`
            : `Your agent is asking you to approve ${pending[0].amountUsdc} USDC to ${pending[0].merchant}`}
          {waiting > 1 ? ` (+${waiting - 1} more)` : ""}.{" "}
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
              <RecoveryBox account={null} available={Boolean(config?.recoveryScopePolicy)} busy={busy !== null} newCode={null} onSetup={makeRecoveryCode} onReplace={newRecoveryCode} onRecover={recover} onSaved={() => setNewCode(null)} />
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
          {account && (
            <RecoveryBox account={account} available={Boolean(config?.recoveryScopePolicy)} busy={busy !== null} newCode={newCode} onSetup={makeRecoveryCode} onReplace={newRecoveryCode} onRecover={recover} onSaved={() => setNewCode(null)} />
          )}
        </div>
      </section>

      <section className={`card ${account ? "" : "disabled"}`}>
        <div className="step">2</div>
        <div className="body">
          <h2>Authorize an agent</h2>
          <PolicyComposer
            config={config}
            disabled={!account || busy !== null}
            run={(fn) => void run("grant", fn)}
            onGranted={(g) => {
              setNotice(`Agent authorized under rule #${g.ruleId}. Copy the .env lines below into your project.`);
              void refresh();
            }}
          />
          <p className="muted or">Or set it up by hand:</p>
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
                  {config.allowlistPolicyVersion === "0.3" && (
                    <label className="inline">
                      Largest single payment (USDC)
                      <input
                        className="cap"
                        placeholder="no limit"
                        inputMode="decimal"
                        value={maxPerPayment}
                        onChange={(e) => setMaxPerPayment(e.target.value)}
                      />
                    </label>
                  )}
                </>
              )}
            </fieldset>
          )}
          {config?.cosignerGatePolicy && config.cosignerAddress && (
            <label className="inline">
              <input type="checkbox" checked={useGate} onChange={(e) => setUseGate(e.target.checked)} /> Provenance gate: every payment also needs
              the co-signer <code>{config.cosignerAddress.slice(0, 6)}…</code>, which signs only what traces back to a task you signed
            </label>
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
          {liveCount > 1 && (
            <div className="stop">
              <span>
                {liveCount} agents can spend from this wallet.
              </span>
              <button className="danger" onClick={revokeAll} disabled={busy !== null}>
                {busy === "revoke-all" ? "Stopping…" : `Emergency stop: revoke all ${liveCount}`}
              </button>
            </div>
          )}
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
                  {g.task && <span className="tag">task budget</span>}
                  {g.discovered && <span className="tag">found on-chain</span>}
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
                    {g.maxPerPayment && g.maxPerPayment !== "0" ? `; at most ${fmt(BigInt(g.maxPerPayment))} USDC per payment` : ""}
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
        <div className="step">AI</div>
        <div className="body">
          <h2>Talk to your agent</h2>
          <p className="muted">
            Ask in plain words. The agent compares the merchants and offers you choices. Nothing is paid until you tap one, and
            the smart account still checks every payment against the allowance above.
          </p>
          <AgentChat enabled={Boolean(account)} />
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
                {(() => {
                  const known = config?.recipients.find((r) => r.address === p.to);
                  return known ? (
                    <span className="muted">to {known.label}</span>
                  ) : (
                    <span className="unknown" title="Not one of the recipients configured in the guardian service">
                      to {short(p.to)} · unknown recipient
                    </span>
                  );
                })()}
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
        <div className="step">✓</div>
        <div className="body">
          <h2 id="tasks">Tasks to sign (provenance gate)</h2>
          <TasksPanel account={account} />
        </div>
      </section>

      <section className={`card ${account ? "" : "disabled"}`}>
        <div className="step">5</div>
        <div className="body">
          <h2 id="approvals">Approval requests</h2>
          {config && (
            <div className={`freeze ${config.frozen ? "on" : ""}`}>
              <span>
                {config.frozen
                  ? "Frozen: agents cannot ask you for approvals or budgets."
                  : "Agents can ask you to approve a payment or a task budget."}
              </span>
              <button className={config.frozen ? "secondary" : "danger"} onClick={toggleFreeze} disabled={busy !== null}>
                {config.frozen ? "Unfreeze" : "Freeze requests"}
              </button>
            </div>
          )}
          {budgets.length > 0 && (
            <ul className="requests">
              {budgets.map((b) => (
                <li key={b.id} className={`request ${b.status}`}>
                  <div className="request-head">
                    <span className="mono big">{b.amountUsdc} USDC</span>
                    <span>task budget for {b.minutes} min</span>
                    <span className="tag">{b.status}{b.ruleId !== undefined ? ` · rule #${b.ruleId}` : ""}</span>
                  </div>
                  <div className="muted">“{b.reason}”</div>
                  {b.task && <div className="muted small">Task: {b.task}</div>}
                  <div className="muted small">
                    Only: {b.recipients.map((r) => r.label || short(r.address)).join(", ")}
                  </div>
                  {b.status === "pending" &&
                    (b.agentKey !== config?.agentAddress && config?.agentAddress ? (
                      <div className="banner error">Refusing: this request is for a different agent key.</div>
                    ) : (
                      <div className="row">
                        <button onClick={() => approveBudget(b)} disabled={busy !== null || !account}>
                          {busy === `budget-${b.id}` ? "Waiting for passkey…" : "Approve budget with passkey"}
                        </button>
                        <button className="ghost" onClick={() => rejectBudget(b)} disabled={busy !== null}>
                          Reject
                        </button>
                      </div>
                    ))}
                </li>
              ))}
            </ul>
          )}
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
                    {a.status === "pending" && config && !config.recipients.some((r) => r.address === a.payTo) && (
                      <div className="banner error">
                        Unknown recipient: {short(a.payTo)} is not one of your listed merchants. Approve only if you know
                        exactly who this is.
                      </div>
                    )}
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
              <div className="row">
                <button
                  className="ghost"
                  onClick={() => download(`acan-spending-${new Date().toISOString().slice(0, 10)}.csv`, auditCsv(audit), "text/csv")}
                >
                  Download report (CSV)
                </button>
                <button
                  className="ghost"
                  onClick={() =>
                    download(`acan-spending-${new Date().toISOString().slice(0, 10)}.json`, auditJson(audit), "application/json")
                  }
                >
                  JSON
                </button>
              </div>
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
