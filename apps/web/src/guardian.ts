import { xdr } from "@stellar/stellar-sdk";
import { checkRequest as checkEntry } from "./approval-check";
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

/** Check the request before showing an Approve button. Returns a problem, or null. */
export function checkRequest(a: Approval, account: string): string | null {
  return checkEntry(a.entryXdr, { account, payTo: a.payTo, amount: a.amount });
}

/** The passkey's rule: the first context rule, created with the wallet. */
export const GUARDIAN_RULE_ID = 0;

export interface GuardianConfig {
  /** Agent requests are refused while true (older guardian services omit it). */
  frozen?: boolean;
  allowlistPolicy: string | null;
  /** "0.2" or "0.3" (per-payment limit); older guardian services omit it (= "0.2"). */
  allowlistPolicyVersion?: "0.2" | "0.3";
  agentAddress: string | null;
  recipients: { address: string; label: string }[];
}

export async function fetchConfig(): Promise<GuardianConfig> {
  const r = await fetch(`${GUARDIAN_URL}/config`);
  if (!r.ok) throw new Error(`guardian service: HTTP ${r.status}`);
  return r.json();
}

export interface BudgetRequest {
  id: string;
  createdAt: number;
  status: "pending" | "approved" | "rejected" | "expired";
  agentKey: string;
  amount: string;
  amountUsdc: string;
  minutes: number;
  recipients: { address: string; label: string }[];
  task: string;
  reason: string;
  ruleId?: number;
}

export async function fetchBudgets(): Promise<BudgetRequest[]> {
  const r = await fetch(`${GUARDIAN_URL}/budgets`);
  if (!r.ok) throw new Error(`guardian service: HTTP ${r.status}`);
  return r.json();
}

export async function reportBudget(id: string, outcome: { ruleId: number } | "reject"): Promise<void> {
  const r = await fetch(`${GUARDIAN_URL}/budgets/${id}/${outcome === "reject" ? "reject" : "approve"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: outcome === "reject" ? undefined : JSON.stringify(outcome),
  });
  if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
}

/** Freeze or unfreeze agent requests (approvals and budgets) at the guardian service. */
export async function setFrozen(frozen: boolean): Promise<boolean> {
  const r = await fetch(`${GUARDIAN_URL}/freeze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frozen }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return Boolean(body.frozen);
}
