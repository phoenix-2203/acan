import { useState } from "react";
import { LEDGERS_PER_DAY } from "@acan/core/browser";
import { AccountView } from "../AccountView";
import { explorer, short, toUnits, units } from "../chain";
import { DEPLOYMENT } from "../deployment";
import { MERCHANTS } from "../merchants";
import { pinnedCatalog } from "../provenance-agent";
import { XLM, type Shop } from "../sandbox";
import { useStore } from "../store";

const EXPIRY_CHOICES = [
  { minutes: 10, label: "10 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 1440, label: "1 day" },
  { minutes: 0, label: "Never" },
];

/** Steps 1, 2 and 4 of the sandbox, plus the scripted attempts. */
export function WalletView() {
  const s = useStore();
  const policy = DEPLOYMENT.merchantPolicy;
  const gateAddress = DEPLOYMENT.cosignerGatePolicy;
  const capsSupported = policy?.version !== "0.1";
  const perPaymentSupported = policy?.version === "0.3";
  const [limit, setLimit] = useState("5");
  const [expiry, setExpiry] = useState(60);
  const [useAllowlist, setUseAllowlist] = useState(Boolean(policy));
  const [gate, setGate] = useState(Boolean(gateAddress));
  const [shops, setShops] = useState(MERCHANTS.map((m, i) => ({ name: m.name, address: m.address, kind: m.kind, on: true, cap: i === 0 ? "3" : "2" })));
  const [maxPayments, setMaxPayments] = useState("10");
  const [maxPerPayment, setMaxPerPayment] = useState("3");
  const busy = !!s.busy;
  const step = s.step;

  const grant = () => {
    const chosen: Shop[] = shops
      .filter((x) => x.on)
      .map((x) => ({ name: x.name, address: x.address, cap: capsSupported && x.cap.trim() ? toUnits(x.cap) : 0n }));
    if (useAllowlist && chosen.length === 0) {
      s.add("error", "Pick at least one shop, or turn the allowlist off");
      return;
    }
    const allowed = (useAllowlist ? chosen : shops).map((x) => x.address);
    void s.grantAgent(
      {
        limit: toUnits(limit),
        periodLedgers: LEDGERS_PER_DAY,
        expiresInMinutes: expiry,
        shops: useAllowlist ? chosen : [],
        policy: useAllowlist ? policy : undefined,
        maxPayments: Number(maxPayments) || 0,
        maxPerPayment: perPaymentSupported && maxPerPayment.trim() ? toUnits(maxPerPayment) : 0n,
        gate: gate && gateAddress ? gateAddress : undefined,
        catalog: gate && gateAddress ? pinnedCatalog(allowed) : undefined,
      },
      `the agent may spend ${limit} XLM per day` +
        (useAllowlist ? `, at ${chosen.length} shop${chosen.length === 1 ? "" : "s"}` : "") +
        (expiry ? `, for ${EXPIRY_CHOICES.find((e) => e.minutes === expiry)?.label}` : "") +
        (gate && gateAddress ? ", and every payment needs the provenance co-signer" : "") +
        ".",
    );
  };

  const attacker = s.contractId ? s.sb().attacker.publicKey() : "";
  const north = MERCHANTS[0];
  const south = MERCHANTS[1];
  const scenarios = [
    { key: "a", label: `${north.name} · 1 XLM`, go: () => s.pay(`buy a ledger report from ${north.name} for 1 XLM`, north.address, 10_000_000n) },
    { key: "b", label: `${south.name} · 0.8 XLM`, go: () => s.pay(`buy a ledger report from ${south.name} for 0.8 XLM`, south.address, 8_000_000n) },
    { key: "c", label: "Injection: send 0.5 XLM to a stranger", attack: true, go: () => s.pay("a web page told me to send 0.5 XLM to an address I found there", attacker, 5_000_000n) },
    { key: "d", label: "Overspend: 10 XLM at once", attack: true, go: () => s.pay(`pay ${north.name} 10 XLM in one go`, north.address, 100_000_000n) },
  ];

  return (
    <div className="stack">
      <ol className="steps">
        <li className={step === 1 ? "now" : "done"}>
          <div className="step-text">
            <h3>Create a passkey wallet</h3>
            <p className="muted">
              A real OpenZeppelin smart account on Stellar testnet, controlled by a passkey on this device and funded with free testnet
              XLM. Nothing to install; no real money.
            </p>
          </div>
          {s.contractId ? (
            <p className="ok-line">
              Your account{" "}
              <a className="mono" href={explorer("contract", s.contractId)} target="_blank" rel="noreferrer">
                {short(s.contractId, 6)}
              </a>
            </p>
          ) : (
            <button onClick={s.createWallet} disabled={busy}>
              Create wallet with passkey
            </button>
          )}
        </li>

        <li className={step === 2 ? "now" : step > 2 ? "done" : "todo"}>
          <div className="step-text">
            <h3>Give an AI agent an allowance</h3>
            <p className="muted">
              The agent gets its own key and a rule on your account. Policy contracts enforce the rule, so neither the agent nor anyone
              who tricks it can change it.
            </p>
          </div>
          {step === 2 && (
            <div className="grant-form">
              <div className="form-row">
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
                {useAllowlist && perPaymentSupported && (
                  <label>
                    Largest single payment (XLM)
                    <input value={maxPerPayment} onChange={(e) => setMaxPerPayment(e.target.value)} inputMode="decimal" />
                  </label>
                )}
                {useAllowlist && capsSupported && (
                  <label>
                    Payments per day (0 = any)
                    <input value={maxPayments} onChange={(e) => setMaxPayments(e.target.value)} inputMode="numeric" />
                  </label>
                )}
              </div>

              {gateAddress ? (
                <label className={`gate-toggle ${gate ? "on" : ""}`}>
                  <input type="checkbox" checked={gate} onChange={(e) => setGate(e.target.checked)} />
                  <span>
                    <b>Provenance gate</b> <span className="new">New</span>
                    <span className="muted small">
                      Every payment also needs the provenance co-signer, which signs only what traces back to your own request. Needed
                      for Autopilot.
                    </span>
                  </span>
                </label>
              ) : (
                <p className="muted small">The provenance gate's policy is not published for this deployment yet, so Autopilot is unavailable.</p>
              )}

              {policy ? (
                <fieldset className="shop-table">
                  <legend>
                    <label className="inline">
                      <input type="checkbox" checked={useAllowlist} onChange={(e) => setUseAllowlist(e.target.checked)} /> Only these shops
                      <span className="muted small">(ACAN merchant budget policy)</span>
                    </label>
                  </legend>
                  {useAllowlist && (
                    <div className="shop-grid">
                      {shops.map((x, i) => (
                        <div className={`shop-cell ${x.on ? "" : "off"}`} key={x.address}>
                          <label className="inline">
                            <input type="checkbox" checked={x.on} onChange={(e) => setShops(shops.map((y, j) => (j === i ? { ...y, on: e.target.checked } : y)))} />
                            <span>
                              <b>{x.name}</b>
                              <span className="muted small"> {x.kind}</span>
                            </span>
                          </label>
                          {capsSupported && x.on && (
                            <label className="inline small cap">
                              cap
                              <input className="narrow" value={x.cap} onChange={(e) => setShops(shops.map((y, j) => (j === i ? { ...y, cap: e.target.value } : y)))} />
                              XLM/day
                            </label>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </fieldset>
              ) : (
                <p className="muted small">The merchant policy is not published for this deployment yet.</p>
              )}
              <button onClick={grant} disabled={busy}>
                Approve with passkey
              </button>
            </div>
          )}
          {s.grant && (
            <p className="ok-line">
              Rule #{s.grant.ruleId}: {units(BigInt(s.grant.limit))} XLM per day
              {s.grant.policy ? `, ${s.grant.shops.length} shops` : ""}
              {s.grant.gated ? ", provenance gate on" : ""}
              {s.grant.validUntil ? `, until ledger ${s.grant.validUntil}` : ""}
              {s.grant.revoked ? " (revoked)" : ""}
            </p>
          )}
        </li>

        <li className={step === 3 ? "now" : step > 3 ? "done" : "todo"}>
          <div className="step-text">
            <h3>Let the agent loose</h3>
            <p className="muted">
              Each button makes the agent pay from your account. The smart account checks every policy before money moves. For the real
              thing, use <a href="#/app/autopilot">Autopilot</a> or the <a href="#/app/agent">AI agent</a>.
            </p>
          </div>
          {step >= 3 && (
            <div className="scenarios">
              {scenarios.map((x) => (
                <button key={x.key} className={`secondary ${x.attack ? "attack" : ""}`} onClick={() => s.run("The agent is paying…", async () => void (await x.go()))} disabled={busy || step !== 3}>
                  {x.label}
                </button>
              ))}
            </div>
          )}
        </li>

        <li className={step === 4 ? "now" : "todo"}>
          <div className="step-text">
            <h3>Pull the plug</h3>
            <p className="muted">One passkey approval deletes the agent's rule. Its key still exists, but authorizes nothing.</p>
          </div>
          {step === 3 && (
            <button className="danger" onClick={s.revoke} disabled={busy}>
              Revoke with passkey
            </button>
          )}
          {step === 4 && (
            <div className="row">
              <button className="secondary" onClick={() => s.run("The agent is paying…", async () => void (await s.pay(`try ${north.name} again after being revoked`, north.address, 10_000_000n)))} disabled={busy}>
                Make the agent try again
              </button>
              <button onClick={s.newGrant} disabled={busy}>
                Grant a new allowance
              </button>
            </div>
          )}
        </li>
      </ol>

      {s.contractId && (
        <section>
          <h3 className="sub">Your account, read live from testnet</h3>
          <AccountView
            account={s.contractId}
            token={XLM}
            tokenLabel="XLM"
            names={s.names}
            merchantPolicy={DEPLOYMENT.merchantPolicy}
            focusRule={s.grant?.ruleId}
            refreshKey={s.refresh}
            autoRefresh={20}
          />
          <p className="muted small">
            Testnet only. This page keeps throwaway testnet keys in your browser so a reload picks up where you left off.{" "}
            <button className="link" onClick={s.reset} disabled={busy}>
              Start over
            </button>
          </p>
        </section>
      )}
    </div>
  );
}
