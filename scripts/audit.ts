/**
 * Guardian audit: what the public sees vs what the guardian can decrypt.
 *
 * Reads the confidential token's events from Stellar RPC (last ~7 days, the
 * RPC retention window) for the agent's vault, and prints:
 *   PUBLIC VIEW    what any observer of the chain learns
 *   GUARDIAN VIEW  the same transfers decrypted with the auditor key
 *
 * Usage: npm run audit
 */
import { explorerTx, loadEnv, requireEnv, stroopsToUsdc } from "@acan/core";
import { auditAccount, parseScalar, type AuditRow } from "@acan/confidential";

loadEnv();

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const usdc = (v: string | bigint) => `${stroopsToUsdc(v)} USDC`;

async function main() {
  const vault = requireEnv("AGENT_VAULT_ADDRESS");
  const merchants = [
    { name: "merchant A", address: process.env.MERCHANT_ADDRESS, url: process.env.MERCHANT_URL ?? "http://localhost:4021" },
    { name: "merchant B", address: process.env.MERCHANT_B_ADDRESS, url: process.env.MERCHANT_B_URL ?? "http://localhost:4022" },
  ].filter((m): m is { name: string; address: string; url: string } => Boolean(m.address));
  const names = new Map<string, string>([[vault, "agent-vault"], ...merchants.map((m) => [m.address, m.name] as [string, string])]);
  const who = (a?: string) => (a ? names.get(a) ?? short(a) : "");
  const auditorSecret = process.env.CT_AUDITOR_SECRET ? parseScalar(process.env.CT_AUDITOR_SECRET) : null;

  const report = await auditAccount(vault, auditorSecret);
  console.log(`Confidential token ${report.token}`);
  console.log(`${report.rows.length} event(s) involving the agent vault ${vault} (up to ledger ${report.latestLedger})\n`);

  const publicLine = (r: AuditRow) => {
    switch (r.type) {
      case "register":
        return `register  ${who(r.from)}`;
      case "merge":
        return `merge     ${who(r.from)}`;
      case "deposit":
        return `deposit   ${who(r.from)} → ${who(r.to)}  ${usdc(r.publicAmount!)} (public)`;
      case "withdraw":
        return `withdraw  ${who(r.from)} → ${who(r.to)}  ${usdc(r.publicAmount!)} (public)`;
      case "transfer":
        return `transfer  ${who(r.from)} → ${who(r.to)}  amount: hidden`;
      default:
        return r.type;
    }
  };

  console.log("PUBLIC VIEW (anyone reading the chain)");
  for (const r of report.rows) console.log(`  ${String(r.ledger).padEnd(9)} ${publicLine(r)}`);

  if (!auditorSecret) {
    console.log("\nGUARDIAN VIEW unavailable: CT_AUDITOR_SECRET is not in .env (run npm run ct:setup).");
    return;
  }
  console.log("\nGUARDIAN VIEW (decrypted with the auditor key)");
  for (const r of report.rows) {
    if (r.type === "transfer") {
      const line = r.decrypted
        ? `transfer ${who(r.from)} → ${who(r.to)}  ${usdc(r.decryptedAmount!).padEnd(12)} vault balance after: ${usdc(r.balanceAfter ?? "0")}   ${explorerTx(r.txHash)}`
        : `transfer ${who(r.from)} → ${who(r.to)}: not decryptable with this key`;
      console.log(`  ${String(r.ledger).padEnd(9)} ${line}`);
    } else {
      console.log(`  ${String(r.ledger).padEnd(9)} ${publicLine(r)}`);
    }
  }

  console.log("");
  for (const m of merchants) {
    const total = BigInt(report.totalsTo[m.address] ?? "0");
    const count = report.rows.filter((r) => r.type === "transfer" && r.to === m.address && r.decrypted).length;
    let check = "(merchant not running: skipped the cross-check with its tab ledger)";
    try {
      const tab = await (await fetch(`${m.url}/tab/${vault}`)).json();
      const match = BigInt(tab.settled) === total ? "MATCHES" : "DIFFERS FROM";
      check = `merchant's ledger: owed ${usdc(tab.owed)}, settled ${usdc(tab.settled)} (${match} the decrypted total)`;
    } catch {
      /* merchant offline */
    }
    console.log(`Settled to ${m.name}: ${usdc(total)} in ${count} confidential transfer(s); ${check}.`);
  }
}

main().catch((e) => {
  console.error(`AUDIT FAILED: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
