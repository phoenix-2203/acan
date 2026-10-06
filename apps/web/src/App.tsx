import { useCallback, useEffect, useState } from "react";
import { ASSETS, LEDGERS_PER_DAY, LEDGERS_PER_HOUR, usdcToStroops } from "@acan/core/browser";
import {
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

type Busy = null | "create" | "connect" | "grant" | `revoke-${number}`;

const PERIODS = [
  { label: "per hour", ledgers: LEDGERS_PER_HOUR },
  { label: "per day", ledgers: LEDGERS_PER_DAY },
  { label: "per week", ledgers: LEDGERS_PER_DAY * 7 },
];

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
    const [bal, pays, ...allow] = await Promise.all([
      usdcBalance(account).catch(() => null),
      recentPayments(account).catch(() => [] as Payment[]),
      ...g.map((x) => readAllowance(x.ruleId)),
    ]);
    setBalance(bal);
    setPayments(pays);
    setAllowances(Object.fromEntries(g.map((x, i) => [x.ruleId, allow[i]])));
  }, [account]);

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
      const g = await grantAgent(agentKey.trim(), usdcToStroops(limit), period);
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
          </div>
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
                </div>
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

      <footer className="muted">
        Built on OpenZeppelin smart accounts, x402 and Soroban. Testnet only.
      </footer>
    </div>
  );
}
