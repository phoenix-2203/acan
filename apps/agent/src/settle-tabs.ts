/**
 * Settle every open tab the agent has with the known merchants, each in one
 * confidential transfer, and have the merchants confirm the credit.
 *
 * Usage: npm run agent:settle
 */
import { loadEnv } from "@acan/core";
import { AgentWallet } from "./wallet.js";

loadEnv();

const MERCHANTS = (process.env.MERCHANT_URLS ?? "http://localhost:4021,http://localhost:4022")
  .split(",")
  .map((u) => u.trim().replace(/\/$/, ""))
  .filter(Boolean);

async function main() {
  const wallet = new AgentWallet("private");
  let settled = 0;
  try {
    for (const url of MERCHANTS) {
      let name = url;
      try {
        name = (await (await fetch(url)).json()).name ?? url;
      } catch {
        console.log(`${url}: unreachable, skipped`);
        continue;
      }
      await wallet.syncTab(url);
      const tx = await wallet.closeTab(url);
      if (tx) settled++;
      else console.log(`${name}: nothing owed`);
    }
    const vault = await wallet.vaultSpendable();
    console.log(`\n${settled} tab(s) settled. Private vault balance: ${vault} USDC (known only to the agent and the auditor).`);
  } finally {
    await wallet.close();
  }
}

main().catch((e) => {
  console.error(`SETTLE FAILED: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
