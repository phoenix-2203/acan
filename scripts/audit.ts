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
import {
  CONFIDENTIAL_TESTNET,
  ConfidentialAccount,
  auditTransfer,
  auditWithdraw,
  hybridFetchEvents,
  parseScalar,
  type ConfidentialEvent,
} from "@acan/confidential";

loadEnv();

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const usdc = (v: bigint) => `${stroopsToUsdc(v)} USDC`;

async function main() {
  const vault = requireEnv("AGENT_VAULT_ADDRESS");
  const merchant = process.env.MERCHANT_ADDRESS ?? "";
  const names = new Map([[vault, "agent-vault"], [merchant, "merchant"]]);
  const who = (a: string) => names.get(a) ?? short(a);
  const auditorSecret = process.env.CT_AUDITOR_SECRET ? parseScalar(process.env.CT_AUDITOR_SECRET) : null;

  // A read-only client (the vault's keys are not used here).
  const reader = new ConfidentialAccount({
    secret: requireEnv("AGENT_VAULT_SECRET"),
    ctSecretHex: requireEnv("AGENT_CT_SK"),
    statePath: `.acan/ct-${vault}.json`,
  });
  const { events, latestLedger } = await hybridFetchEvents(reader.client, undefined, {
    fromLedger: CONFIDENTIAL_TESTNET.deployedAtLedger,
  });
  const mine = events.filter((e) => involves(e, vault));
  console.log(`Confidential token ${CONFIDENTIAL_TESTNET.contracts.token}`);
  console.log(`${mine.length} event(s) involving the agent vault ${vault} (up to ledger ${latestLedger})\n`);

  console.log("PUBLIC VIEW (anyone reading the chain)");
  for (const e of mine) console.log(`  ${String(e.ledger).padEnd(9)} ${publicLine(e, who)}`);

  if (!auditorSecret) {
    console.log("\nGUARDIAN VIEW unavailable: CT_AUDITOR_SECRET is not in .env (run npm run ct:setup).");
    return;
  }
  console.log("\nGUARDIAN VIEW (decrypted with the auditor key)");
  let toMerchant = 0n;
  let count = 0;
  for (const e of mine) {
    if (e.type === "transfer") {
      const a = auditTransfer(auditorSecret, e);
      if (!a.channelsAgree) {
        console.log(`  ${String(e.ledger).padEnd(9)} transfer ${who(e.from)} → ${who(e.to)}: not decryptable with this key`);
        continue;
      }
      if (e.to === merchant) {
        toMerchant += a.amount;
        count++;
      }
      console.log(
        `  ${String(e.ledger).padEnd(9)} transfer ${who(e.from)} → ${who(e.to)}  ${usdc(a.amount).padEnd(12)}` +
          ` vault balance after: ${usdc(a.senderBalance)}   ${explorerTx(e.txHash)}`,
      );
    } else if (e.type === "withdraw") {
      const a = auditWithdraw(auditorSecret, e);
      console.log(`  ${String(e.ledger).padEnd(9)} withdraw ${usdc(e.amount)}  balance after: ${usdc(a.senderBalance)}`);
    } else {
      console.log(`  ${String(e.ledger).padEnd(9)} ${publicLine(e, who)}`);
    }
  }
  console.log(`\nTotal settled to the merchant: ${usdc(toMerchant)} in ${count} confidential transfer(s).`);

  const url = process.env.MERCHANT_URL ?? `http://localhost:${process.env.MERCHANT_PORT ?? 4021}`;
  try {
    const tab = await (await fetch(`${url}/tab/${vault}`)).json();
    const match = BigInt(tab.settled) === toMerchant ? "MATCHES" : "DIFFERS FROM";
    console.log(`Merchant's ledger: owed ${usdc(BigInt(tab.owed))}, settled ${usdc(BigInt(tab.settled))} (${match} the decrypted total).`);
  } catch {
    console.log("(Merchant not running: skipped the cross-check with its tab ledger.)");
  }
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

function publicLine(e: ConfidentialEvent, who: (a: string) => string): string {
  switch (e.type) {
    case "register":
      return `register  ${who(e.account)}`;
    case "deposit":
      return `deposit   ${who(e.from)} → ${who(e.to)}  ${usdc(e.amount)} (public)`;
    case "merge":
      return `merge     ${who(e.account)}`;
    case "transfer":
      return `transfer  ${who(e.from)} → ${who(e.to)}  amount: hidden`;
    case "withdraw":
      return `withdraw  ${who(e.from)} → ${who(e.to)}  ${usdc(e.amount)} (public)`;
    default:
      return e.type;
  }
}

main().catch((e) => {
  console.error(`AUDIT FAILED: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
