import { useState } from "react";
import { formatRecoveryCode, recoveryFileText, type RecoveryCode } from "@acan/core/browser";
import { recoveredPasskey, recoveryRuleFor } from "./recovery";

/** Guardian wallet step: save a recovery code, or recover on a new device. */
export function RecoveryBox(props: {
  account: string | null;
  available: boolean;
  busy: boolean;
  newCode: RecoveryCode | null;
  onSetup: () => void;
  onRecover: (code: string) => void;
  onSaved: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const { account, available, busy, newCode } = props;

  if (!account) {
    if (!available) return null;
    return !open ? (
      <button className="link" style={{ paddingLeft: 0, marginTop: 10 }} onClick={() => setOpen(true)}>
        Lost your device? Recover with your code
      </button>
    ) : (
      <div className="recover-form">
        <p className="muted small">Paste your recovery code. You'll create a new passkey on this device, and the code adds it to your account.</p>
        <textarea className="mono" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="acan-recovery-1:…" />
        <div className="row">
          <button onClick={() => props.onRecover(text)} disabled={busy || !text.trim()}>
            Recover my wallet
          </button>
          <button className="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (newCode) {
    const code = formatRecoveryCode(newCode);
    const download = () => {
      const blob = new Blob([recoveryFileText(newCode)], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `acan-recovery-${newCode.account.slice(0, 6)}.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    return (
      <div className="recovery-card" role="dialog" aria-labelledby="rc-title">
        <h3 id="rc-title">Save your recovery code</h3>
        <p>
          Your passkey lives on this device. If you lose the device, this code is the only way back into your account. Nobody else can
          recover it for you.
        </p>
        <code className="recovery-code">{code}</code>
        <div className="row">
          <button className="ghost" onClick={() => void navigator.clipboard?.writeText(code).then(() => setCopied(true))}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="ghost" onClick={download}>
            Download .txt
          </button>
        </div>
        <p className="recovery-warn">
          Keep it offline. On its own the code can't pay from your account, but anyone holding it could add their own passkey and take the
          account over. Treat it like a key, not a note.
        </p>
        <button onClick={props.onSaved}>I've saved it</button>
      </div>
    );
  }

  const rule = recoveryRuleFor(account);
  if (rule !== undefined) {
    return (
      <p className="muted small">
        {recoveredPasskey()?.contractId === account ? "This browser's passkey was added with your recovery code. " : ""}Recovery code set up
        (rule #{rule}: it can only add a passkey to this account).
      </p>
    );
  }
  if (!available) return null;
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <span className="muted small">No recovery code yet. If this device is lost, so is the wallet.</span>
      <button className="ghost" onClick={props.onSetup} disabled={busy}>
        Set up a recovery code
      </button>
    </div>
  );
}
