import { useState } from "react";
import { formatRecoveryCode, recoveryFileText, type RecoveryCode } from "@acan/core/browser";
import { recoveredPasskey, savedCode } from "./recovery";

/** Guardian wallet step: the recovery code (shown after creating the wallet, and again on request), or recover on a new device. */
export function RecoveryBox(props: {
  account: string | null;
  busy: boolean;
  newCode: RecoveryCode | null;
  onSetup: () => void;
  onRecover: (code: string) => void;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [show, setShow] = useState(false);
  const { account, busy, newCode } = props;

  if (!account) {
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

  const saved = savedCode(account);
  if (newCode || (show && saved)) {
    return <CodeCard code={(newCode ?? saved)!} first={Boolean(newCode)} onDone={() => (newCode ? props.onSaved() : setShow(false))} />;
  }
  if (saved) {
    return (
      <div className="row" style={{ marginTop: 10 }}>
        <span className="muted small">
          {recoveredPasskey()?.contractId === account ? "This browser's passkey was added with your recovery code. " : ""}Recovery code set up
          (rule #{saved.ruleId}).
        </span>
        <button className="ghost" onClick={() => setShow(true)} disabled={busy}>
          Show my recovery code
        </button>
      </div>
    );
  }
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <span className="muted small">No recovery code in this browser. If this device is lost, so is the wallet.</span>
      <button className="ghost" onClick={props.onSetup} disabled={busy}>
        Set up a recovery code
      </button>
    </div>
  );
}

function CodeCard({ code, first, onDone }: { code: RecoveryCode; first: boolean; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = formatRecoveryCode(code);
  const download = () => {
    const blob = new Blob([recoveryFileText(code)], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `acan-recovery-${code.account.slice(0, 6)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="recovery-card" role="dialog" aria-labelledby="rc-title">
      <h3 id="rc-title">{first ? "Save your recovery code" : "Your recovery code"}</h3>
      <p>
        Your passkey lives on this device. If you lose the device, this code is the only way back into your account. Nobody else can
        recover it for you.
      </p>
      <code className="recovery-code">{text}</code>
      <div className="row">
        <button className="ghost" onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button className="ghost" onClick={download}>
          Download .txt
        </button>
      </div>
      <p className="recovery-warn">
        Keep it offline. Anyone holding this code can take over your account and spend from it. Treat it like a key, not a note. It is also
        kept in this browser so you can see it again here.
      </p>
      <button onClick={onDone}>{first ? "I've saved it" : "Hide"}</button>
    </div>
  );
}
