import type { AuditReport } from "./guardian";

const EXPLORER = "https://stellar.expert/explorer/testnet/tx/";

/** USDC with 7 decimals, from atomic units. */
function usdc(v: string | undefined): string {
  if (v === undefined || v === null) return "";
  const n = BigInt(v);
  const whole = n / 10_000_000n;
  const frac = (n % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function cell(v: string | number | undefined): string {
  const s = v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The guardian's spending report as CSV: one row per confidential-token event
 * of the agent's vault, with what the public sees next to what the auditor
 * key decrypted, and a link to each transaction.
 */
export function auditCsv(report: AuditReport): string {
  const name = (a?: string) => (a ? report.names[a] ?? a : "");
  const header = ["ledger", "event", "from", "to", "public_amount_usdc", "decrypted_amount_usdc", "vault_balance_after_usdc", "transaction"];
  const rows = report.rows.map((r) => [
    r.ledger,
    r.type,
    name(r.from),
    name(r.to),
    r.publicAmount === null ? "hidden" : usdc(r.publicAmount),
    usdc(r.decryptedAmount),
    usdc(r.balanceAfter),
    `${EXPLORER}${r.txHash}`,
  ]);
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\n") + "\n";
}

/** The same report as JSON, with totals per recipient, for archiving or other tools. */
export function auditJson(report: AuditReport, generatedAt = new Date().toISOString()): string {
  return JSON.stringify(
    {
      generatedAt,
      account: report.account,
      token: report.token,
      latestLedger: report.latestLedger,
      totalsUsdc: Object.fromEntries(Object.entries(report.totalsTo).map(([k, v]) => [report.names[k] ?? k, usdc(v)])),
      events: report.rows.map((r) => ({
        ...r,
        from: r.from && (report.names[r.from] ?? r.from),
        to: r.to && (report.names[r.to] ?? r.to),
        transaction: `${EXPLORER}${r.txHash}`,
      })),
    },
    null,
    2,
  );
}

/** Offer `text` as a file download in the browser. */
export function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
