import { ChainClient, auditTransfer, auditWithdraw, hybridFetchEvents, type ConfidentialEvent } from "./vendor.js";
import { CONFIDENTIAL_TESTNET } from "./deployment.js";

/** One confidential-token event involving the watched account, both views. */
export interface AuditRow {
  ledger: number;
  txHash: string;
  type: ConfidentialEvent["type"];
  from?: string;
  to?: string;
  /** What anyone can read on-chain: an amount, or null when it is hidden. */
  publicAmount: string | null;
  /** What the auditor key reveals (atomic units), when it applies. */
  decryptedAmount?: string;
  /** Watched account's confidential balance after the event, when the auditor can read it. */
  balanceAfter?: string;
  /** False when the auditor key could not decrypt this event. */
  decrypted?: boolean;
}

export interface AuditReport {
  account: string;
  token: string;
  latestLedger: number;
  rows: AuditRow[];
  /** Decrypted totals sent to each recipient (atomic units). */
  totalsTo: Record<string, string>;
}

/**
 * Read the confidential token's events for `account` (RPC retention, ~7 days)
 * and decrypt transfers with the auditor secret, if given.
 */
export async function auditAccount(account: string, auditorSecret: bigint | null): Promise<AuditReport> {
  const dep = CONFIDENTIAL_TESTNET;
  const client = new ChainClient({
    rpcUrl: dep.rpcUrl,
    networkPassphrase: dep.networkPassphrase,
    contracts: { token: dep.contracts.token, verifier: dep.contracts.verifier, auditor: dep.contracts.auditor },
  });
  const { events, latestLedger } = await hybridFetchEvents(client, undefined, { fromLedger: dep.deployedAtLedger });
  const rows: AuditRow[] = [];
  const totals = new Map<string, bigint>();
  for (const e of events) {
    if (!involves(e, account)) continue;
    const row: AuditRow = { ledger: e.ledger, txHash: e.txHash, type: e.type, publicAmount: null };
    switch (e.type) {
      case "register":
      case "merge":
        row.from = e.account;
        break;
      case "deposit":
        row.from = e.from;
        row.to = e.to;
        row.publicAmount = e.amount.toString();
        break;
      case "withdraw":
        row.from = e.from;
        row.to = e.to;
        row.publicAmount = e.amount.toString();
        if (auditorSecret !== null) {
          row.balanceAfter = auditWithdraw(auditorSecret, e).senderBalance.toString();
          row.decrypted = true;
        }
        break;
      case "transfer":
        row.from = e.from;
        row.to = e.to;
        if (auditorSecret !== null) {
          const a = auditTransfer(auditorSecret, e);
          row.decrypted = a.channelsAgree;
          if (a.channelsAgree) {
            row.decryptedAmount = a.amount.toString();
            if (e.from === account) {
              row.balanceAfter = a.senderBalance.toString();
              totals.set(e.to, (totals.get(e.to) ?? 0n) + a.amount);
            }
          }
        }
        break;
    }
    rows.push(row);
  }
  return {
    account,
    token: dep.contracts.token,
    latestLedger,
    rows,
    totalsTo: Object.fromEntries([...totals].map(([k, v]) => [k, v.toString()])),
  };
}

function involves(e: ConfidentialEvent, a: string): boolean {
  switch (e.type) {
    case "transfer":
    case "deposit":
    case "withdraw":
      return e.from === a || e.to === a;
    case "register":
    case "merge":
      return e.account === a;
    default:
      return false;
  }
}
