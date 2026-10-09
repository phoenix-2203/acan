import { type ReactNode } from "react";
import { Activity } from "./Activity";
import { AiChat } from "./AiChat";
import { DEPLOYMENT, REPO_URL } from "./deployment";
import { ReceiptSection } from "./ReceiptSection";
import { useStore } from "./store";
import { Icon, VIEWS } from "./ui";
import { AutopilotView } from "./views/Autopilot";
import { HowLearn, PrivacyLearn, ProofLearn, ProvenanceLearn, RunLearn, SecurityLearn } from "./views/Learn";
import { WalletView } from "./views/Wallet";

const INTRO: Record<string, string> = {
  autopilot:
    "An AI agent that pays on its own. Each payment needs the provenance co-signer, which signs only what traces back to your own request. Try the Tidewire task: the note it reads tells the agent to buy something else.",
  wallet: "Everything runs in your browser against Stellar testnet. The refusals you see are real contract errors, not checks in this page.",
  agent: "The agent proposes, you pick, and your smart account has the final word. Try to talk it into paying a stranger.",
  live: `ACAN's own guardian account, read from testnet now. Rule #${DEPLOYMENT.agentRuleId} is the AI agent's allowance, in USDC, with the merchant budget policy attached.`,
  receipts:
    "Every Autopilot task ends with a receipt the agent signs. Here anyone can check it: the signature, every payment on testnet, and why each payment was allowed or held, re-run from the receipt itself.",
  provenance: "Why a manipulated agent can't pay, even when the payment is inside every limit.",
  how: "The parts of ACAN and how they fit.",
  security: "Each row is covered by a test in the repository or by an on-chain policy.",
  proof: "Every claim on this site, with its transaction, and ACAN's own wallet read live from testnet.",
  privacy: "In private mode the agent's payments are vouchers, settled in confidential transfers whose amounts are hidden on-chain. You still see everything with your auditor key.",
  run: "Run the whole stack locally against testnet.",
};

/** Views that use the sandbox show the activity log beside them. */
const WITH_ACTIVITY = new Set(["autopilot", "wallet", "agent"]);

export function Shell({ view }: { view: string }) {
  const v = VIEWS.find((x) => x.id === (view === "live" ? "proof" : view)) ?? VIEWS[0];
  return (
    <div className="shell">
      <aside className="rail">
        <a className="wordmark" href="#/">
          ACAN
        </a>
        {(["Try", "Learn"] as const).map((g) => (
          <nav key={g}>
            <p className="rail-group">{g}</p>
            {VIEWS.filter((x) => x.group === g).map((x) => (
              <a key={x.id} href={`#/app/${x.id}`} className={x.id === v.id ? "active" : ""} aria-current={x.id === v.id ? "page" : undefined}>
                <Icon name={x.icon} size={18} />
                <span>{x.title}</span>
                {x.isNew && <span className="dot" title="New" />}
              </a>
            ))}
          </nav>
        ))}
        <div className="rail-foot">
          <span className="net">
            <i /> Stellar testnet
          </span>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            <Icon name="git" size={16} /> Source
          </a>
        </div>
      </aside>

      <main className="stage">
        <header className="stage-head" key={`h-${v.id}`}>
          <a className="back" href="#/">
            <Icon name="back" size={16} /> Home
          </a>
          <div>
            <p className="eyebrow">
              {v.group}
              {v.isNew && <span className="new">New</span>}
            </p>
            <h1>{v.title}</h1>
            <p className="muted intro">{INTRO[v.id]}</p>
          </div>
        </header>
        <div className={`stage-body ${WITH_ACTIVITY.has(v.id) ? "with-activity" : ""}`} key={v.id}>
          <div className="stage-main">{body(v.id)}</div>
          {WITH_ACTIVITY.has(v.id) && <Activity />}
        </div>
      </main>
    </div>
  );
}

function body(id: string): ReactNode {
  switch (id) {
    case "autopilot":
      return <AutopilotView />;
    case "wallet":
      return <WalletView />;
    case "agent":
      return <AgentView />;
    case "live":
    case "proof":
      return <ProofLearn />;
    case "privacy":
      return <PrivacyLearn />;
    case "receipts":
      return <ReceiptSection />;
    case "provenance":
      return <ProvenanceLearn />;
    case "how":
      return <HowLearn />;
    case "security":
      return <SecurityLearn />;
    case "run":
      return <RunLearn />;
    default:
      return null;
  }
}

function AgentView() {
  const s = useStore();
  if (!s.ai) return <p className="muted">The AI relay is not configured for this deployment.</p>;
  return (
    <div className="stack">
      {s.step !== 3 && (
        <div className="callout">
          <Icon name="wallet" />
          <div>
            <b>{s.step === 1 ? "Create a passkey wallet first." : s.step === 2 ? "Give the agent an allowance first." : "The allowance was revoked."}</b>
            <p className="muted small">The agent spends from your own sandbox wallet, under the rule you approve.</p>
            <a className="button small" href="#/app/wallet">
              Go to Wallet & allowance
            </a>
          </div>
        </div>
      )}
      <AiChat agent={s.ai} attacker={s.contractId ? s.sb().attacker.publicKey() : "G…"} disabled={!!s.busy || s.step !== 3} />
    </div>
  );
}
