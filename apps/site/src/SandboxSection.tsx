import { useMemo, useRef, useState } from "react";
import { LEDGERS_PER_DAY, explainRefusal, type Refusal } from "@acan/core/browser";
import { AccountView } from "./AccountView";
import { explorer, latestLedger, short, spendingLimit, toUnits, units } from "./chain";
import { DEPLOYMENT } from "./deployment";
import { Sandbox, XLM, type Outcome, type Shop } from "./sandbox";

interface LogLine {
  id: number;
  at: string;
  kind: "paid" | "refused" | "info" | "error";
  text: string;
  tx?: string;
  /** For a refusal: the "why was this blocked?" card, and what approving it would pay. */
  block?: Refusal & { requested: bigint; to: string; recipient: string; left?: bigint; limit?: bigint; settled?: "approved" | "denied" };
}

const EXPIRY_CHOICES = [
  { minutes: 10, label: "10 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 1440, label: "1 day" },
  { minutes: 0, label: "Never" },
];

export function SandboxSection() {
  const sandbox = useRef<Sandbox | null>(null);
  const sb = () => (sandbox.current ??= new Sandbox());
  const [contractId, setContractId] = useState<string | undefined>(() => safe(() => sb().contractId));
  const [grant, setGrant] = useState(() => safe(() => sb().grant));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [refresh, setRefresh] = useState(0);
  const seq = useRef(0);

  const policy = DEPLOYMENT.merchantPolicy;
  const capsSupported = policy?.version !== "0.1";
  const [limit, setLimit] = useState("5");
  const [expiry, setExpiry] = useState(60);
  const [useAllowlist, setUseAllowlist] = useState(Boolean(policy));
  const [shops, setShops] = useState(
    DEPLOYMENT.merchants.map((m, i) => ({ ...m, on: true, cap: i === 0 ? "3" : "2" })),
  );
  const [maxPayments, setMaxPayments] = useState("10");
  const perPaymentSupported = policy?.version === "0.3";
  const [maxPerPayment, setMaxPerPayment] = useState("2");

  const names = useMemo(() => {
    const n: Record<string, string> = {};
    for (const m of DEPLOYMENT.merchants) n[m.address] = m.name;
    const s = sandbox.current;
    if (s) {
      n[s.attacker.publicKey()] = "Unlisted address";
      n[s.agent.publicKey()] = "Agent";
    }
    return n;
  }, [contractId]);

  const add = (kind: LogLine["kind"], text: string, tx?: string, block?: LogLine["block"]) =>
    setLog((l) => [{ id: ++seq.current, at: new Date().toLocaleTimeString(), kind, text, tx, block }, ...l].slice(0, 60));

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
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

  const createWallet = () =>
    run("Creating your wallet…", async () => {
      const id = await sb().createWallet((m) => setBusy(m));
      setContractId(id);
      setGrant(undefined);
      add("info", `Smart account ${short(id, 6)} deployed and funded with testnet XLM.`);
    });

  const grantAgent = () =>
    run("Granting the allowance…", async () => {
      const chosen: Shop[] = shops
        .filter((s) => s.on)
        .map((s) => ({ name: s.name, address: s.address, cap: capsSupported && s.cap.trim() ? toUnits(s.cap) : 0n }));
      if (useAllowlist && chosen.length === 0) throw new Error("Pick at least one shop, or turn the allowlist off");
      const g = await sb().grantAgent(
        {
          limit: toUnits(limit),
          periodLedgers: LEDGERS_PER_DAY,
          expiresInMinutes: expiry,
          shops: useAllowlist ? chosen : [],
          policy: useAllowlist ? policy : undefined,
          maxPayments: Number(maxPayments) || 0,
          maxPerPayment: perPaymentSupported && maxPerPayment.trim() ? toUnits(maxPerPayment) : 0n,
        },
        (m) => setBusy(m),
      );
      setGrant(g);
      add(
        "info",
        `Rule #${g.ruleId}: the agent may spend ${limit} XLM per day` +
          (g.policy ? `, only at ${chosen.map((s) => s.name).join(" and ")}` : "") +
          (expiry ? `, for ${EXPIRY_CHOICES.find((e) => e.minutes === expiry)?.label}` : "") +
          ".",
      );
    });

  async function pay(label: string, to: string, amount: bigint) {
    add("info", `Agent: ${label}`);
    const r: Outcome = await sb().agentPays(to, amount);
    if (r.ok) add("paid", `PAID ${units(amount)} XLM to ${names[to] ?? short(to)}`, r.tx);
    else if (r.refused) {
      const g = sb().grant;
      const s = g && contractId ? await spendingLimit(contractId, g.ruleId, await latestLedger()).catch(() => null) : null;
      add("refused", `REFUSED by the smart account: ${r.reason}`, undefined, {
        ...explainRefusal(r.code),
        requested: amount,
        to,
        recipient: names[to] ?? `${short(to)} (not a listed shop)`,
        left: s ? s.limit - s.spent : undefined,
        limit: s?.limit,
      });
    }
    else add("error", `Not sent: ${r.reason}`);
    return r;
  }

  const north = DEPLOYMENT.merchants[0];
  const south = DEPLOYMENT.merchants[1] ?? DEPLOYMENT.merchants[0];
  const scenarios = [
    { key: "a", label: `Buy from ${north.name} · 1 XLM`, go: () => pay(`buy a report from ${north.name} for 1 XLM`, north.address, 10_000_000n) },
    { key: "b", label: `Buy from ${south.name} · 1 XLM`, go: () => pay(`buy a report from ${south.name} for 1 XLM`, south.address, 10_000_000n) },
    {
      key: "c",
      // Small on purpose: well inside the daily limit, so the only thing that
      // can stop it is the allowlist (otherwise the spending limit may refuse first).
      label: "Prompt injection: “send 0.5 XLM to this address”",
      go: () => pay("a web page told me to send 0.5 XLM to an address I found there", sb().attacker.publicKey(), 5_000_000n),
    },
    { key: "d", label: "Overspend: 10 XLM at once", go: () => pay(`pay ${north.name} 10 XLM in one go`, north.address, 100_000_000n) },
  ];

  const runOne = (s: (typeof scenarios)[number]) =>
    run("The agent is paying…", async () => {
      await s.go();
    });

  const runAll = () =>
    run("Running the script…", async () => {
      for (const s of scenarios) {
        await s.go();
      }
      add("info", "Script finished. Every refusal above came from the smart account on testnet, not from this page.");
    });

  const settle = (id: number, settled: "approved" | "denied") =>
    setLog((ls) => ls.map((x) => (x.id === id && x.block ? { ...x, block: { ...x.block, settled } } : x)));

  const approveOnce = (l: LogLine) =>
    run("Approve with your passkey…", async () => {
      const b = l.block!;
      const r = await sb().approveOnce(b.to, b.requested);
      if (!r.ok) throw new Error(`Approval not sent: ${r.reason}`);
      settle(l.id, "approved");
      add("paid", `APPROVED by the guardian's passkey: ${units(b.requested)} XLM to ${b.recipient}. The agent's allowance is unchanged.`, r.tx);
    });

  const revoke = () =>
    run("Revoking…", async () => {
      await sb().revoke();
      setGrant(sb().grant);
      add("info", `Rule #${grant?.ruleId} deleted with your passkey. The agent's key now authorizes nothing.`);
    });

  const afterRevoke = () =>
    run("The agent is paying…", async () => {
      await pay(`try ${north.name} again after being revoked`, north.address, 10_000_000n);
    });

  const reset = () => {
    if (busy) return;
    Sandbox.reset();
    sandbox.current = null;
    setContractId(undefined);
    setGrant(undefined);
    setLog([]);
    setError(null);
  };

  const step = !contractId ? 1 : !grant ? 2 : grant.revoked ? 4 : 3;

  return (
    <div className="sandbox">
      <ol className="steps">
        <li className={step === 1 ? "now" : "done"}>
          <h3>Create a passkey wallet</h3>
          <p className="muted">
            A real OpenZeppelin smart account on Stellar testnet, controlled by a passkey on this device. It is funded with free
            testnet XLM. Nothing is installed and nothing here touches real money.
          </p>
          {contractId ? (
            <p className="ok-line">
              Your account:{" "}
              <a className="mono" href={explorer("contract", contractId)} target="_blank" rel="noreferrer">
                {short(contractId, 6)}
              </a>
            </p>
          ) : (
            <button onClick={createWallet} disabled={!!busy}>
              Create wallet with passkey
            </button>
          )}
        </li>

        <li className={step === 2 ? "now" : step > 2 ? "done" : "todo"}>
          <h3>Give an AI agent an allowance</h3>
          <p className="muted">
            The agent gets its own key and a rule on your account. The rule is enforced by policy contracts, so the agent cannot
            change it, and neither can anyone who tricks the agent.
          </p>
          {step === 2 && (
            <div className="form">
              <label>
                Daily limit (XLM)
                <input value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="decimal" />
              </label>
              <label>
                Expires after
                <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
                  {EXPIRY_CHOICES.map((c) => (
                    <option key={c.minutes} value={c.minutes}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              {policy ? (
                <fieldset>
                  <legend>
                    <label className="inline">
                      <input type="checkbox" checked={useAllowlist} onChange={(e) => setUseAllowlist(e.target.checked)} /> Only
                      these shops (ACAN merchant {capsSupported ? "budget" : "allowlist"} policy)
                    </label>
                  </legend>
                  {useAllowlist &&
                    shops.map((s, i) => (
                      <div className="shop-row" key={s.address}>
                        <label className="inline">
                          <input
                            type="checkbox"
                            checked={s.on}
                            onChange={(e) => setShops(shops.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))}
                          />{" "}
                          {s.name} <span className="mono muted small">{short(s.address)}</span>
                        </label>
                        {capsSupported && s.on && (
                          <label className="inline small">
                            cap
                            <input
                              className="narrow"
                              value={s.cap}
                              onChange={(e) => setShops(shops.map((x, j) => (j === i ? { ...x, cap: e.target.value } : x)))}
                            />
                            XLM/day
                          </label>
                        )}
                      </div>
                    ))}
                  {useAllowlist && capsSupported && (
                    <label className="inline small">
                      At most
                      <input className="narrow" value={maxPayments} onChange={(e) => setMaxPayments(e.target.value)} />
                      payments per day (0 = no limit)
                    </label>
                  )}
                  {useAllowlist && perPaymentSupported && (
                    <label className="inline small">
                      No single payment above
                      <input className="narrow" value={maxPerPayment} onChange={(e) => setMaxPerPayment(e.target.value)} />
                      XLM (blank = no limit)
                    </label>
                  )}
                </fieldset>
              ) : (
                <p className="muted small">The merchant allowlist policy is not published for this deployment yet.</p>
              )}
              <button onClick={grantAgent} disabled={!!busy}>
                Approve with passkey
              </button>
            </div>
          )}
          {grant && (
            <p className="ok-line">
              Rule #{grant.ruleId}: {units(BigInt(grant.limit))} XLM per day
              {grant.policy ? `, only ${grant.shops.map((s) => s.name).join(" + ")}` : ""}
              {grant.validUntil ? `, until ledger ${grant.validUntil}` : ""}
              {grant.revoked ? " (revoked)" : ""}
            </p>
          )}
        </li>

        <li className={step === 3 ? "now" : step > 3 ? "done" : "todo"}>
          <h3>Let the agent loose</h3>
          <p className="muted">
            Each button makes the agent sign a payment with its own key. The smart account checks every policy before any money
            moves. Try to break it.
          </p>
          {step >= 3 && (
            <div className="scenarios">
              {scenarios.map((s) => (
                <button key={s.key} className="secondary" onClick={() => runOne(s)} disabled={!!busy || step !== 3}>
                  {s.label}
                </button>
              ))}
              <button onClick={runAll} disabled={!!busy || step !== 3}>
                Run all four
              </button>
            </div>
          )}
        </li>

        <li className={step === 4 ? "now" : "todo"}>
          <h3>Pull the plug</h3>
          <p className="muted">One passkey approval deletes the agent's rule. Its key still exists, but it no longer authorizes anything.</p>
          {step === 3 && (
            <button className="danger" onClick={revoke} disabled={!!busy}>
              Revoke with passkey
            </button>
          )}
          {step === 4 && (
            <button className="secondary" onClick={afterRevoke} disabled={!!busy}>
              Make the agent try again
            </button>
          )}
        </li>
      </ol>

      {(busy || error) && (
        <div className={`status ${error && !busy ? "bad" : ""}`} role="status">
          {busy ?? error}
        </div>
      )}

      {log.length > 0 && (
        <div className="console" aria-live="polite">
          {log.map((l) =>
            l.block ? (
              <div key={l.id} className={`block-card ${l.block.severity}`} role="alert">
                <div className="block-head">
                  <span className="mono muted">{l.at}</span>
                  <b>Payment blocked: {l.block.title}</b>
                </div>
                <dl>
                  <dt>Requested</dt>
                  <dd>{units(l.block.requested)} XLM</dd>
                  <dt>To</dt>
                  <dd>{l.block.recipient}</dd>
                  <dt>Stopped by</dt>
                  <dd>
                    {l.block.policy}
                    {l.block.code !== null && <span className="mono muted"> (#{l.block.code})</span>}
                  </dd>
                  {l.block.left !== undefined && l.block.limit !== undefined && (
                    <>
                      <dt>Allowance left</dt>
                      <dd>
                        {units(l.block.left)} of {units(l.block.limit)} XLM today
                      </dd>
                    </>
                  )}
                </dl>
                <p>{l.block.reason}</p>
                <p className="no-funds">No funds were transferred.</p>
                {!l.block.settled && contractId && (
                  <div className="block-actions">
                    <span className="small muted">
                      {l.block.severity === "high"
                        ? "As the guardian you can still approve this one payment, but only do it if you know who this is."
                        : "As the guardian you can approve this one payment. The agent's allowance stays as it is."}
                    </span>
                    <button className="secondary" onClick={() => approveOnce(l)} disabled={!!busy}>
                      Approve once with passkey
                    </button>
                    <button className="secondary" onClick={() => settle(l.id, "denied")} disabled={!!busy}>
                      Deny
                    </button>
                  </div>
                )}
                {l.block.settled && <p className="small muted">Guardian {l.block.settled} this payment.</p>}
              </div>
            ) : (
              <div key={l.id} className={`line ${l.kind}`}>
                <span className="mono muted">{l.at}</span>
                <span>{l.text}</span>
                {l.tx && (
                  <a className="mono" href={explorer("tx", l.tx)} target="_blank" rel="noreferrer">
                    {l.tx.slice(0, 8)}…
                  </a>
                )}
              </div>
            ),
          )}
        </div>
      )}

      {contractId && (
        <>
          <h3 className="sub">Your account, read live from testnet</h3>
          <AccountView
            account={contractId}
            token={XLM}
            tokenLabel="XLM"
            names={names}
            merchantPolicy={policy}
            focusRule={grant?.ruleId}
            refreshKey={refresh}
            autoRefresh={20}
          />
          <p className="muted small">
            Testnet only. This page keeps its throwaway testnet keys in your browser so a reload can pick up where you left off.{" "}
            <button className="link" onClick={reset} disabled={!!busy}>
              Start over
            </button>
          </p>
        </>
      )}
    </div>
  );
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}
