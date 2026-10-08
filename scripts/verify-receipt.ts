/**
 * Check a task receipt: the agent's signature, the totals, and every public
 * payment against the chain (the transaction exists, succeeded, and moved
 * that amount of USDC from the smart account to that recipient).
 *
 * Usage: npm run receipt:verify               (the newest receipt in ~/Downloads or .acan/receipts)
 *        npm run receipt:verify -- <receipt.json>
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rpc } from "@stellar/stellar-sdk";
import { TESTNET, checkPaymentOnChain, checkReceiptOffline, parseSignedReceipt } from "@acan/core";

/** The most recent receipt file: downloaded from the dashboard, or written by the CLI agent. */
function newestReceipt(): string | undefined {
  const found: { path: string; at: number }[] = [];
  for (const [dir, prefix] of [
    [join(homedir(), "Downloads"), "acan-receipt-"],
    [".acan/receipts", "receipt-"],
  ] as const) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.startsWith(prefix) && f.endsWith(".json")) found.push({ path: join(dir, f), at: statSync(join(dir, f)).mtimeMs });
    }
  }
  return found.sort((a, b) => b.at - a.at)[0]?.path;
}

const file = process.argv[2] ?? newestReceipt();
if (!file) {
  console.error("No receipt found. Download one from the dashboard (Task receipt → Download), or pass a file: npm run receipt:verify -- <file>");
  process.exit(2);
}
console.log(`checking ${file}\n`);
const signed = parseSignedReceipt(readFileSync(file, "utf8"));
const r = signed.receipt;
let failures = 0;
const ok = (good: boolean, text: string) => {
  console.log(`${good ? "OK  " : "FAIL"}  ${text}`);
  if (!good) failures++;
};

for (const c of checkReceiptOffline(signed)) ok(c.status === "ok", c.text);

const server = new rpc.Server(TESTNET.rpcUrl);
for (const [i, p] of r.payments.entries()) {
  const c = await checkPaymentOnChain(server, r.smartAccount, p, i);
  if (c.status === "skip") console.log(`--    ${c.text}`);
  else ok(c.status === "ok", c.text);
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nreceipt verified");
process.exitCode = failures ? 1 : 0;
