import { useEffect, useRef, useState } from "react";
import { Icon, Tx } from "../ui";

/**
 * A replay of ACAN's recorded private-mode run on Stellar testnet (README,
 * "Private mode"): 7 paid requests of 0.01 USDC, credit limit 0.03, three
 * confidential settlements. The transactions are real; the toggle shows what
 * the public sees on-chain versus what the guardian's auditor key decrypts.
 */
type Step =
  | { kind: "topup"; label: string; tx: string; amount: string }
  | { kind: "voucher"; n: number; cumulative: string }
  | { kind: "settle"; label: string; tx: string; amount: string; vaultAfter: string };

const STEPS: Step[] = [
  { kind: "topup", label: "Top-up from the smart account, under the agent's capped rule", tx: "3544896310c5f3600ddc3b086e25b0c8d09e086242e1d5c44d560f2a7870dd4a", amount: "0.10" },
  { kind: "topup", label: "Deposit into the confidential balance", tx: "17229ad5e96a4015c7d5c6fa486e1999e6f06ff4115885ddccfdd935e7754193", amount: "0.10" },
  { kind: "voucher", n: 1, cumulative: "0.01" },
  { kind: "voucher", n: 2, cumulative: "0.02" },
  { kind: "voucher", n: 3, cumulative: "0.03" },
  { kind: "settle", label: "Tab at its credit limit: settled", tx: "0f466ad20ddbaca87ccb7c953f0d74648c4ea32525a151307a18af9d3a96c7ec", amount: "0.03", vaultAfter: "0.07" },
  { kind: "voucher", n: 4, cumulative: "0.01" },
  { kind: "voucher", n: 5, cumulative: "0.02" },
  { kind: "voucher", n: 6, cumulative: "0.03" },
  { kind: "settle", label: "Tab at its credit limit: settled", tx: "57924ba11591129f8cb3389a6d5eb538d1fa1cdbecd8d7e85a516afb2415ba96", amount: "0.03", vaultAfter: "0.04" },
  { kind: "voucher", n: 7, cumulative: "0.01" },
  { kind: "settle", label: "Tab closed: settled", tx: "70b5dec854e3cf715041fa791fdcb2fae066ae7ea6a17ca9e1b7e8a1ad507014", amount: "0.01", vaultAfter: "0.03" },
];

export function PrivateReplay() {
  const [shown, setShown] = useState(0);
  const [mine, setMine] = useState(false);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!playing) return;
    if (shown >= STEPS.length) {
      setPlaying(false);
      return;
    }
    timer.current = window.setTimeout(() => setShown((n) => n + 1), STEPS[shown]?.kind === "voucher" ? 650 : 1100);
    return () => window.clearTimeout(timer.current);
  }, [playing, shown]);

  const play = () => {
    setShown(0);
    setPlaying(true);
  };
  const vouchers = STEPS.slice(0, shown).filter((s) => s.kind === "voucher").length;
  const settlements = STEPS.slice(0, shown).filter((s) => s.kind === "settle").length;

  return (
    <section className="ap-card replay">
      <div className="replay-head">
        <div>
          <h3>Replay: the private run on testnet</h3>
          <p className="muted small">The recorded run, step by step. Every transaction link is real.</p>
        </div>
        <div className="row">
          <div className="seg" role="group" aria-label="Whose view">
            <button className={mine ? "" : "on"} onClick={() => setMine(false)}>
              Public view
            </button>
            <button className={mine ? "on" : ""} onClick={() => setMine(true)}>
              Your view (auditor key)
            </button>
          </div>
          <button onClick={play} disabled={playing}>
            {shown ? "Replay" : "Play"}
          </button>
        </div>
      </div>

      <div className="replay-stats">
        <div>
          <b className="mono">{vouchers}</b>
          <span className="muted small">paid requests</span>
        </div>
        <div>
          <b className="mono">0</b>
          <span className="muted small">transactions per request</span>
        </div>
        <div>
          <b className="mono">{settlements}</b>
          <span className="muted small">confidential settlements</span>
        </div>
        <div>
          <b className="mono">{mine ? `${(settlements === 0 ? 0 : [0.03, 0.06, 0.07][settlements - 1]).toFixed(2)} USDC` : "hidden"}</b>
          <span className="muted small">spent via the vault</span>
        </div>
      </div>

      <ol className="replay-list">
        {STEPS.slice(0, shown).map((s, i) => (
          <li key={i} className={`enter ${s.kind}`}>
            {s.kind === "voucher" ? (
              <>
                <span className="dot-v" />
                <span>
                  Request {s.n}: a signed voucher for 0.01 USDC <span className="muted">(owed since the last settlement: {s.cumulative})</span>
                </span>
                <span className="muted small">no transaction</span>
              </>
            ) : s.kind === "topup" ? (
              <>
                <Icon name="wallet" size={16} />
                <span>
                  {s.label}: <b>{s.amount} USDC</b> <span className="muted small">(public by design)</span>
                </span>
                <Tx hash={s.tx} />
              </>
            ) : (
              <>
                <Icon name="eye" size={16} />
                <span>
                  {s.label}: vault → merchant,{" "}
                  {mine ? (
                    <b className="reveal">
                      {s.amount} USDC <span className="muted small">(vault left: {s.vaultAfter})</span>
                    </b>
                  ) : (
                    <b className="hidden-amt">amount hidden</b>
                  )}
                </span>
                <Tx hash={s.tx} />
              </>
            )}
          </li>
        ))}
        {shown === 0 && <li className="empty muted small">Press Play, then flip between the public view and yours.</li>}
      </ol>
      <p className="muted small">
        Source: ACAN's recorded run (<code>npm run agent:private</code>, then <code>npm run audit</code>). Your view shows the auditor's decryption from that
        run; the amounts are not visible on-chain.
      </p>
    </section>
  );
}
