import { useEffect, useRef, useState } from "react";
import { toPng } from "html-to-image";
import {
  checkPaymentOnChain,
  checkReceiptOffline,
  explainReceipt,
  parseSignedReceipt,
  type ReceiptCheck,
  type SignedReceipt,
} from "@acan/core/browser";
import { explorer, server, short } from "./chain";
import { downloadReceipt } from "./receipt-build";
import { useStore } from "./store";

/**
 * "Check a receipt": open a task receipt the agent signed, see it as a receipt,
 * and check it in the browser: the signature, the totals, and every payment
 * against Stellar testnet. The same checks as `npm run receipt:verify`.
 */
export function ReceiptSection() {
  const [signed, setSigned] = useState<SignedReceipt | null>(null);
  const [fileName, setFileName] = useState("");
  const [checks, setChecks] = useState<ReceiptCheck[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const run = useRef(0);
  const store = useStore();
  const latest = store.receipt;

  useEffect(() => {
    if (latest) void check(latest, "your last Autopilot task");
  }, [latest]);

  async function open(file: File) {
    setError(null);
    setChecks([]);
    setSigned(null);
    if (file.size > 1_000_000) return setError("That file is too large to be a receipt.");
    let s: SignedReceipt;
    try {
      s = parseSignedReceipt(await file.text());
    } catch (e) {
      return setError(e instanceof Error ? e.message : String(e));
    }
    await check(s, file.name);
  }

  async function check(s: SignedReceipt, name: string) {
    setError(null);
    setSigned(s);
    setFileName(name);
    const id = ++run.current;
    const offline = [...checkReceiptOffline(s), ...explainReceipt(s)];
    setChecks(offline);
    setChecking(true);
    const all = [...offline];
    for (const [i, p] of s.receipt.payments.entries()) {
      const c = await checkPaymentOnChain(server, s.receipt.smartAccount, p, i, s.receipt.asset);
      if (id !== run.current) return;
      all.push(c);
      setChecks([...all]);
    }
    setChecking(false);
  }

  async function saveImage() {
    if (!card.current || !signed) return;
    setSaving(true);
    try {
      const url = await toPng(card.current, { pixelRatio: 2, cacheBust: true, skipFonts: false }).catch(() =>
        toPng(card.current!, { pixelRatio: 2, skipFonts: true }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `acan-receipt-${signed.receipt.endedAt.slice(0, 19).replace(/[:T]/g, "-")}.png`;
      a.click();
    } catch (e) {
      setError(`Could not make the image: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  const verdict = !signed ? null : checking ? "checking" : failed ? "failed" : "verified";
  // A line's tick: failed if any of its checks failed; ok once its on-chain check (the last one) is in.
  const paymentCheck = (i: number) => {
    const mine = checks.filter((c) => c.payment === i);
    return mine.find((c) => c.status === "fail") ?? (mine.some((c) => c.text.includes(" moved ") || c.status === "skip") ? mine.at(-1) : undefined);
  };

  return (
    <div className="receipt-tool">
      {!signed && (
        <div className="callout">
          <div>
            <b>Get a receipt by running a task.</b>
            <p className="muted small">
              Every Autopilot task ends with a receipt signed by the agent: what it paid, what was held and why. It also carries what is
              needed to re-run the co-signer's decisions, so anyone can check not only what was paid but why it was allowed.
            </p>
            <a className="button small" href="#/app/autopilot">
              Run a task in Autopilot
            </a>
          </div>
        </div>
      )}
      <label
        className={`dropzone ${dragging ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) void open(f);
        }}
      >
        <input
          id="receipt-file"
          type="file"
          accept=".json,application/json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void open(f);
            e.target.value = "";
          }}
        />
        <b>{signed ? "Check another receipt file" : "Check a receipt file"}</b>
        <span className="muted small">Drop an acan-receipt-….json here or click to choose one. It is checked in this browser and never uploaded.</span>
      </label>
      {error && <div className="status bad">{error}</div>}

      {signed && (
        <div className="receipt-layout">
          <div className="paper" ref={card}>
            <div className="paper-head">
              <span className="paper-brand">ACAN</span>
              <span className="paper-kind">Task receipt</span>
            </div>
            <p className="paper-task">“{signed.receipt.task}”</p>
            <dl className="paper-meta">
              <dt>Agent</dt>
              <dd className="mono">{short(signed.receipt.agent, 6)}</dd>
              <dt>Paid from</dt>
              <dd className="mono">{short(signed.receipt.smartAccount, 6)}</dd>
              <dt>Under</dt>
              <dd>
                rule #{signed.receipt.ruleId} · {signed.receipt.mode} payments
              </dd>
              <dt>When</dt>
              <dd>
                {new Date(signed.receipt.startedAt).toLocaleString()} – {new Date(signed.receipt.endedAt).toLocaleTimeString()}
              </dd>
            </dl>

            <div className="paper-rule" />
            {signed.receipt.payments.length === 0 && <p className="muted small">No payments in this task.</p>}
            {signed.receipt.payments.map((p, i) => {
              const c = paymentCheck(i);
              return (
                <div className="paper-line" key={i}>
                  <div className="paper-item">
                    <span>
                      {p.merchant}
                      {p.approvedByGuardian ? " · approved with passkey" : ""}
                    </span>
                    <span className="muted small mono">{p.item}</span>
                    {p.tx ? (
                      <a className="mono small" href={explorer("tx", p.tx)} target="_blank" rel="noreferrer">
                        tx {p.tx.slice(0, 8)}…
                      </a>
                    ) : (
                      <span className="muted small">private voucher</span>
                    )}
                  </div>
                  <span className="paper-amount mono">{p.amountUsdc}</span>
                  <span className={`tick ${c?.status ?? "wait"}`} title={c?.text ?? "Checking on testnet…"} aria-label={c?.text ?? "Checking"}>
                    {c?.status === "ok" ? "✓" : c?.status === "fail" ? "✕" : c?.status === "skip" ? "–" : "…"}
                  </span>
                </div>
              );
            })}
            {signed.receipt.blocked.map((b, i) => (
              <div className="paper-line blocked" key={`b${i}`}>
                <div className="paper-item">
                  <span>{b.held ? "Held" : "Blocked"}: {b.recipient}</span>
                  <span className="small">
                    {b.held ? b.held.why.join("; ") : b.policy}
                    {b.code !== null ? ` (#${b.code})` : ""} · no funds moved
                  </span>
                </div>
                <span className="paper-amount mono">{b.amountUsdc ?? "–"}</span>
                <span className="tick skip">–</span>
              </div>
            ))}

            <div className="paper-rule" />
            <div className="paper-total">
              <span>Total spent</span>
              <span className="mono">
                {signed.receipt.totals.spentUsdc} {signed.receipt.asset?.code ?? "USDC"}
              </span>
            </div>
            <div className="paper-sub muted small">
              {signed.receipt.totals.payments} payment(s) · {signed.receipt.totals.blocked} blocked · {signed.receipt.totals.guardianApprovals} passkey
              approval(s)
              {signed.receipt.allowance ? ` · allowance left ${signed.receipt.allowance.leftAtEndUsdc} of ${signed.receipt.allowance.limitUsdc} ${signed.receipt.asset?.code ?? "USDC"}` : ""}
            </div>
            <div className={`stamp ${verdict}`}>
              {verdict === "verified" ? "Verified on Stellar testnet" : verdict === "failed" ? "Does not check out" : "Checking on testnet…"}
            </div>
            <p className="paper-foot mono">signed by {short(signed.signer, 6)} · check the file at acan-demo.duckdns.org/#/app/receipts</p>
          </div>

          <div className="checks">
            <h3 className="sub">What was checked</h3>
            <ul>
              {checks.map((c, i) => (
                <li key={i} className={c.status}>
                  <span className="tick-inline">{c.status === "ok" ? "✓" : c.status === "fail" ? "✕" : "–"}</span>
                  <span>{c.text}</span>
                </li>
              ))}
              {checking && <li className="wait">Reading the next transaction from testnet…</li>}
            </ul>
            <p className="muted small">
              The signature covers every field, so changing any amount, merchant or transaction makes it fail. Each payment is matched to a
              transfer from the smart account on testnet.
              {signed.receipt.provenance ? " The co-signer's decisions are re-run here from the receipt alone: same request, same plan, same content read, same pinned catalog." : ""}{" "}
              {fileName && <span className="mono">({fileName})</span>}
            </p>
            <div className="row">
              <button onClick={saveImage} disabled={saving || checking}>
                {saving ? "Making the image…" : "Save as image"}
              </button>
              <button className="secondary" onClick={() => downloadReceipt(signed)}>
                Download the file
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
