import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { ASSETS } from "@acan/core/browser";
import { kit } from "./acan";

/** The local guardian service (npm run guardian). */
export const GUARDIAN_URL = (import.meta as any).env?.VITE_GUARDIAN_URL ?? "http://127.0.0.1:4030";

export interface Approval {
  id: string;
  createdAt: number;
  status: "pending" | "approved" | "rejected" | "expired";
  merchant: string;
  url: string;
  payTo: string;
  amount: string;
  amountUsdc: string;
  reason: string;
  entryXdr: string;
  maxLedger: number;
}

export interface AuditRow {
  ledger: number;
  txHash: string;
  type: string;
  from?: string;
  to?: string;
  publicAmount: string | null;
  decryptedAmount?: string;
  balanceAfter?: string;
  decrypted?: boolean;
}

export interface AuditReport {
  account: string;
  token: string;
  latestLedger: number;
  rows: AuditRow[];
  totalsTo: Record<string, string>;
  names: Record<string, string>;
  auditorKey: boolean;
}

export async function fetchApprovals(): Promise<Approval[]> {
  const r = await fetch(`${GUARDIAN_URL}/approvals`);
  if (!r.ok) throw new Error(`guardian service: HTTP ${r.status}`);
  return r.json();
}

export async function fetchAudit(): Promise<AuditReport> {
  const r = await fetch(`${GUARDIAN_URL}/audit`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `guardian service: HTTP ${r.status}`);
  return body;
}

/**
 * What the auth entry really authorizes, decoded from the XDR itself rather
 * than trusting the agent's description of it.
 */
export function decodeEntry(entryXdr: string): { contract: string; fn: string; from: string; to: string; amount: bigint } {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
  const fnx = entry.rootInvocation().function();
  if (fnx.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") throw new Error("not a contract call");
  const call = fnx.contractFn();
  const args = call.args();
  return {
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    fn: call.functionName().toString(),
    from: args[0] ? (scValToNative(args[0]) as string) : "",
    to: args[1] ? (scValToNative(args[1]) as string) : "",
    amount: args[2] ? BigInt(scValToNative(args[2]) as bigint) : 0n,
  };
}

/** Check the request before showing an Approve button. Returns a problem, or null. */
export function checkRequest(a: Approval, account: string): string | null {
  try {
    const d = decodeEntry(a.entryXdr);
    if (entryHasSubInvocations(a.entryXdr)) return "the authorization includes extra calls";
    if (d.contract !== ASSETS.usdc.sac) return `not a USDC payment (contract ${d.contract})`;
    if (d.fn !== "transfer") return `not a transfer (${d.fn})`;
    if (d.from !== account) return "not from this smart account";
    if (d.to !== a.payTo) return "recipient differs from the request";
    if (d.amount.toString() !== a.amount) return "amount differs from the request";
    return null;
  } catch (e) {
    return `cannot decode the authorization: ${e instanceof Error ? e.message : e}`;
  }
}

function entryHasSubInvocations(entryXdr: string): boolean {
  return xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64").rootInvocation().subInvocations().length > 0;
}

/**
 * Approve with the guardian's passkey: sign this one payment under the
 * guardian's own rule (rule 0, created with the wallet), so the agent's
 * allowance is not involved and nothing else is authorized.
 */
export async function approve(a: Approval): Promise<void> {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(a.entryXdr, "base64");
  const signed = await kit.signAuthEntry(entry, { expiration: a.maxLedger, contextRuleIds: [GUARDIAN_RULE_ID] });
  const r = await fetch(`${GUARDIAN_URL}/approvals/${a.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedEntryXdr: signed.toXDR("base64") }),
  });
  if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
}

export async function reject(a: Approval): Promise<void> {
  const r = await fetch(`${GUARDIAN_URL}/approvals/${a.id}/reject`, { method: "POST" });
  if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
}

/** The passkey's rule: the first context rule, created with the wallet. */
export const GUARDIAN_RULE_ID = 0;

export interface GuardianConfig {
  allowlistPolicy: string | null;
  agentAddress: string | null;
  recipients: { address: string; label: string }[];
}

export async function fetchConfig(): Promise<GuardianConfig> {
  const r = await fetch(`${GUARDIAN_URL}/config`);
  if (!r.ok) throw new Error(`guardian service: HTTP ${r.status}`);
  return r.json();
}
