/**
 * Return everything left in the agent's private vault to the guardian's smart
 * account, in one withdrawal (its amount is public). Use it when a task is
 * done or the agent is being retired.
 *
 * Usage: npm run agent:return
 */
import { explorerTx, loadEnv } from "@acan/core";
import { AgentWallet } from "./wallet.js";

loadEnv();

async function main() {
  const wallet = new AgentWallet("private");
  try {
    const before = await wallet.vaultSpendable();
    console.log(`private vault holds ${before} USDC (spendable)`);
    const r = await wallet.returnUnused();
    console.log(r ? `returned ${r.amountUsdc} USDC to ${wallet.smartAccount}  ${explorerTx(r.tx)}` : "nothing to return");
  } finally {
    await wallet.close();
  }
}

main().catch((e) => {
  console.error(`RETURN FAILED: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
