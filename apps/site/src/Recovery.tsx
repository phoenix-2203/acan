import { useState } from "react";
import { formatRecoveryCode, recoveryFileText } from "@acan/core/browser";
import { short } from "./chain";
import { DEPLOYMENT } from "./deployment";
import { useStore } from "./store";

/** Step 1 extras: save a recovery code after creating the wallet, or recover on a new device. */
export function RecoveryPanel() {
  const s = useStore();
  const busy = !!s.busy;
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const available = Boolean(DEPLOYMENT.recoveryScopePolicy);

  if (!s.contractId) {
    if (!available) return null;
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

  if (s.newCode) {
    const code = formatRecoveryCode(s.newCode);
    const download = () => {
      const blob = new Blob([recoveryFileText(s.newCode!, { site: location.origin })], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `acan-recovery-${short(s.newCode!.account, 4).replace(/[^A-Z0-9]/g, "")}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    return (
      <section className="recovery-card" role="dialog" aria-labelledby="rc-title">
        <h3 id="rc-title">Save your recovery code</h3>
        <p>
          Your passkey lives on this device. If you lose the device, this code is the only way back into your account. Nobody else can
          recover it for you.
        </p>
        <code className="recovery-code">{code}</code>
        <div className="row">
          <button
            className="secondary small"
            onClick={() => {
              void navigator.clipboard?.writeText(code).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="secondary small" onClick={download}>
            Download .txt
          </button>
        </div>
        <p className="recovery-warn">
          Keep it offline. On its own the code can't pay from your account, but anyone holding it could add their own passkey and take the
          account over. Treat it like a key, not a note.
        </p>
        <button onClick={s.dismissCode}>I've saved it</button>
      </section>
    );
  }

  if (s.recoveryRule !== undefined) {
    return (
      <p className="small muted">
        {s.recovered ? "This device's passkey was added with your recovery code. " : ""}Recovery code set up (rule #{s.recoveryRule}: it can only
        add a passkey to this account).
      </p>
    );
  }

  if (!available) return null;
  return (
    <div className="recovery">
      <p className="small muted">No recovery code yet. If this device is lost, so is the wallet.</p>
      <button className="secondary small" onClick={() => void s.setupRecovery()} disabled={busy}>
        Set up a recovery code
      </button>
    </div>
  );
}
