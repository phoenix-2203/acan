/**
 * Talk to the agent in the terminal. Type what you need; when the agent
 * proposes purchases, pick one by number. Every payment is still authorized
 * on-chain under the agent's rule.
 *
 * Usage: npm run agent:chat            (AGENT_AUTOPILOT=1 lets the model buy without asking)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadEnv } from "@acan/core";
import { ChatEngine, type ChatEvent } from "./chat-engine.js";
import { merchantPins, merchantUrls } from "./merchants.js";
import { AgentWallet, type Mode } from "./wallet.js";

loadEnv();

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const mode: Mode = process.env.ACAN_MODE === "private" ? "private" : "public";
const wallet = new AgentWallet(mode, (l) => console.log(dim(l)));
const engine = new ChatEngine({
  wallet,
  merchants: merchantUrls(),
  pins: merchantPins(),
  autopilot: process.env.AGENT_AUTOPILOT === "1",
});

function show(e: ChatEvent): void {
  switch (e.type) {
    case "agent":
      console.log(`${bold("agent>")} ${e.text}`);
      break;
    case "activity":
      console.log(dim(`  · ${e.text}`));
      break;
    case "options":
      console.log(`${bold("agent>")} ${e.question}`);
      e.options.forEach((o, i) => console.log(`  ${bold(String(i + 1))}) ${o.label}${o.detail ? dim(`   ${o.detail}`) : ""}`));
      break;
    case "payment":
      if (e.status === "paid") console.log(green(`  PAID ${e.priceUsdc} USDC for ${e.label}  ${dim(e.receipt ?? "")}`));
      else if (e.block) {
        console.log(red(`  PAYMENT BLOCKED: ${e.block.title}`));
        console.log(`    requested   ${e.block.requestedUsdc ?? "?"} USDC to ${e.block.recipient}`);
        console.log(`    stopped by  ${e.block.policy}${e.block.code !== null ? ` (#${e.block.code})` : ""}`);
        if (e.block.allowanceLeftUsdc) console.log(`    allowance   ${e.block.allowanceLeftUsdc} of ${e.block.limitUsdc} USDC left`);
        console.log(`    ${e.block.reason} No funds were transferred.`);
      } else console.log(red(`  ${e.status.toUpperCase()} ${e.label}: ${e.reason ?? ""}`));
      break;
    case "budget":
      console.log(dim(`  allowance left ${e.remainingUsdc} of ${e.limitUsdc} USDC`));
      break;
    case "error":
      console.log(red(`  ${e.text}`));
      break;
    default:
      break;
  }
}
engine.onEvent = show;

console.log(bold("ACAN agent chat") + dim(`  (${engine.modelLabel}, ${mode} payments, rule #${wallet.ruleId})`));
console.log(dim("Ask for data, e.g. “what is the latest ledger, as cheaply as possible?”. Pick options by number. /receipt for a signed task receipt, /quit to leave.\n"));

const rl = createInterface({ input: stdin, output: stdout });
rl.on("SIGINT", () => {
  rl.close();
});
rl.on("close", async () => {
  await wallet.close().catch(() => {});
  process.exit(0);
});

for (;;) {
  const pending = engine.pendingOptions;
  const line = (await rl.question(pending ? `${bold("pick")} (1-${pending.options.length}) or type> ` : `${bold("you")}> `)).trim();
  if (!line) continue;
  if (line === "/quit" || line === "/exit") break;
  if (line === "/receipt") {
    const r = await engine.receipt();
    if (!r || !("receipt" in r)) {
      console.log(dim("  nothing to report yet"));
      continue;
    }
    mkdirSync(".acan/receipts", { recursive: true });
    const file = `.acan/receipts/receipt-${r.receipt.endedAt.replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify(r, null, 2));
    const t = r.receipt.totals;
    console.log(green(`  receipt: spent ${t.spentUsdc} USDC in ${t.payments} payment(s), ${t.blocked} blocked, ${t.guardianApprovals} approval(s)`));
    for (const m of r.receipt.merchants) console.log(`    ${m.spentUsdc.padEnd(8)} ${m.merchant} (${m.payments}×)`);
    console.log(dim(`  signed by the agent key; saved to ${file} (check it: npm run receipt:verify -- ${file})`));
    continue;
  }
  const n = Number(line);
  if (pending && Number.isInteger(n) && n >= 1 && n <= pending.options.length) {
    await engine.choose(pending.id, pending.options[n - 1].id);
  } else {
    await engine.send(line);
  }
}
rl.close();
