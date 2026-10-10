import raw from "../../../deployments/testnet.json";

/** Public addresses of ACAN's own testnet deployment (deployments/testnet.json). */
export interface Deployment {
  smartAccount: string;
  agent: string;
  agentRuleId: number;
  agentVault?: string;
  merchants: { name: string; address: string }[];
  merchantPolicy?: { address: string; version: string };
  /** OpenZeppelin weighted-threshold policy that makes the provenance co-signer required. */
  cosignerGatePolicy?: string;
  /** ACAN recovery scope policy: limits a recovery key to adding a signer to the guardian's rule. */
  recoveryScopePolicy?: string;
  /** HTTPS address of the AI relay (apps/relay) for the sandbox's AI chat; no chat without it. */
  aiRelay?: string;
}

export const DEPLOYMENT = raw as Deployment;

export const REPO_URL = "https://github.com/phoenix-2203/acan";
