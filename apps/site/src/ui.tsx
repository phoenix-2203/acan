import { useEffect, useState, type ReactNode } from "react";
import { explorer } from "./chain";

/** Hash routes: "#/" is the landing page, "#/app/<view>" the app. */
export function useRoute(): string {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = () => {
      setHash(location.hash);
      window.scrollTo({ top: 0 });
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#/, "") || "/";
}

const PATHS: Record<string, ReactNode> = {
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10h18M16 14.5h2" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="7" width="16" height="11" rx="3" />
      <path d="M12 3v4M9 12h.01M15 12h.01M9.5 15.5h5" />
    </>
  ),
  trace: (
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M6.5 7.5 10.5 16M17.5 7.5 13.5 16" />
      <path d="m10.8 18 .9.9 1.8-1.9" />
    </>
  ),
  pulse: <path d="M3 12h4l2.5-6 5 12L17 12h4" />,
  team: (
    <>
      <circle cx="12" cy="5" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="18" r="2.2" />
      <path d="M12 7.2v4M12 11.2 6.8 16M12 11.2l5.2 4.8" />
    </>
  ),
  eye: (
    <>
      <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
      <path d="M4 4l16 16" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  proof: (
    <>
      <circle cx="12" cy="9" r="5.5" />
      <path d="m9.6 9 1.6 1.6 3.2-3.2M8.5 13.8 7 21l5-2.5 5 2.5-1.5-7.2" />
    </>
  ),
  code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />,
  play: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m10 9 5 3-5 3z" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M17 6l2 2M14.5 8.5l2 2" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  git: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path d="M6 7v10M18 11c0 4-6 3-11.5 6.5" />
    </>
  ),
  block: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
};

export function Icon({ name, size = 20 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? PATHS.layers}
    </svg>
  );
}

export const Tx = ({ hash }: { hash: string }) => (
  <a className="mono tx" href={explorer("tx", hash)} target="_blank" rel="noreferrer">
    {hash.slice(0, 8)}…
  </a>
);

export interface AppView {
  id: string;
  group: "Try" | "Learn";
  title: string;
  icon: string;
  blurb: string;
  isNew?: boolean;
}

export const VIEWS: AppView[] = [
  { id: "autopilot", group: "Try", title: "Autopilot", icon: "trace", blurb: "An agent that pays on its own, only for what traces back to you", isNew: true },
  { id: "team", group: "Try", title: "Agent team", icon: "team", blurb: "Your agent hires sub-agents; authority narrows and cancels down the chain", isNew: true },
  { id: "wallet", group: "Try", title: "Wallet & allowance", icon: "wallet", blurb: "Create a passkey wallet and give an agent a capped allowance" },
  { id: "agent", group: "Try", title: "AI agent", icon: "bot", blurb: "Chat with an agent that spends from your wallet; try to trick it" },
  { id: "receipts", group: "Try", title: "Receipts", icon: "receipt", blurb: "Every task’s receipt: what was paid, and why it was allowed" },
  { id: "provenance", group: "Learn", title: "Provenance gate", icon: "key", blurb: "Why a tricked agent can't pay, even inside its limits", isNew: true },
  { id: "privacy", group: "Learn", title: "Private payments", icon: "eye", blurb: "Vouchers and confidential settlement: amounts hidden on-chain" },
  { id: "how", group: "Learn", title: "How it works", icon: "layers", blurb: "Smart account, policies, x402, private mode, MCP" },
  { id: "security", group: "Learn", title: "Security", icon: "shield", blurb: "Defences against published x402 attacks" },
  { id: "proof", group: "Learn", title: "Proof on testnet", icon: "proof", blurb: "Every claim, with its transaction" },
  { id: "run", group: "Learn", title: "Run it yourself", icon: "code", blurb: "The full stack: merchants, agent, dashboard, MCP" },
];
