import { useState } from "react";
import { formatRecoveryCode, recoveryFileText, type RecoveryCode } from "@acan/core/browser";
import { short } from "./chain";
import { useStore } from "./store";

/** Step 1 extras: the recovery code (shown after creating the wallet, and again on request), or recover on a new device. */
export function RecoveryPanel() {
  const s = useStore();
  const busy = !!s.busy;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [show, setShow] = useState(false);

  if (!s.contractId) {
    return (
      <div className="recovery">
        {!open ? (
          <button className="link" onClick={() => setOpen(true)}>
            Lost your device? Recover with your code
          </button>
        ) : (
          <div className="recover-form">
            <label className="small" htmlFor="rc">
              Paste your recovery code. You'll create a new passkey on this device, and the code adds it to your account.
            </label>
            <textarea id="rc" className="mono" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="acan-recovery-1:…" />
            <div className="row">
              <button onClick={() => void s.recover(text)} disabled={busy || !text.trim()}>
                Recover my wallet
              </button>
              <button className="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const fresh = s.newCode;
  const saved = s.savedCode();
  if (fresh || (show && saved)) {
    return <CodeCard code={(fresh ?? saved)!} first={Boolean(fresh)} onDone={() => (fresh ? s.dismissCode() : setShow(false))} />;
  }

  if (s.recoveryRule !== undefined) {
    return (
      <div className="recovery">
        <p className="small muted">
          {s.recovered ? "This device's passkey was added with your recovery code. " : ""}Recovery code set up (rule #{s.recoveryRule}).
        </p>
        {saved && (
          <button className="secondary small" onClick={() => setShow(true)} disabled={busy}>
            Show my recovery code
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="recovery">
      <p className="small muted">No recovery code yet. If this device is lost, so is the wallet.</p>
      <button className="secondary small" onClick={() => void s.setupRecovery()} disabled={busy}>
        Set up a recovery code
      </button>
    </div>
  );
}

function CodeCard({ code, first, onDone }: { code: RecoveryCode; first: boolean; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = formatRecoveryCode(code);
  const download = () => {
    const blob = new Blob([recoveryFileText(code, { site: location.origin })], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `acan-recovery-${short(code.account, 4).replace(/[^A-Z0-9]/g, "")}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <section className="recovery-card" role="dialog" aria-labelledby="rc-title">
      <h3 id="rc-title">{first ? "Save your recovery code" : "Your recovery code"}</h3>
      <p>
        Your passkey lives on this device. If you lose the device, this code is the only way back into your account. Nobody else can
        recover it for you.
      </p>
      <code className="recovery-code">{text}</code>
      <div className="row">
        <button className="secondary small" onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button className="secondary small" onClick={download}>
          Download .txt
        </button>
      </div>
      <p className="recovery-warn">
        Keep it offline. Anyone holding this code can take over your account and spend from it. Treat it like a key, not a note. It is also
        kept in this browser so you can see it again here.
      </p>
      <button onClick={onDone}>{first ? "I've saved it" : "Hide"}</button>
    </section>
  );
}
