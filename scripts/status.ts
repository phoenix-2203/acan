/** Print balances and the agent's allowance state. */
import { loadEnv, spendingLimitState, stroopsToUsdc, tokenBalance, explorerAccount } from "@acan/core";

loadEnv();

const line = (k: string, v: string) => console.log(`${k.padEnd(26)} ${v}`);

async function main() {
  const env = process.env;
  if (env.TREASURY_ADDRESS) line("Treasury USDC", `${stroopsToUsdc(await tokenBalance(env.TREASURY_ADDRESS))}`);
  if (env.MERCHANT_ADDRESS) line("Merchant USDC", `${stroopsToUsdc(await tokenBalance(env.MERCHANT_ADDRESS))}`);
  if (!env.SMART_ACCOUNT) {
    line("Smart account", "not set yet (create it in the dashboard, then paste into .env)");
    return;
  }
  line("Smart account", env.SMART_ACCOUNT);
  line("Smart account USDC", stroopsToUsdc(await tokenBalance(env.SMART_ACCOUNT)));
  if (env.AGENT_RULE_ID) {
    const s = await spendingLimitState(env.SMART_ACCOUNT, Number(env.AGENT_RULE_ID));
    const remaining = BigInt(s.spending_limit) - BigInt(s.cached_total_spent);
    line("Agent rule id", env.AGENT_RULE_ID);
    line("Allowance per period", `${stroopsToUsdc(s.spending_limit)} USDC / ${s.period_ledgers} ledgers`);
    line("Spent this period", `${stroopsToUsdc(s.cached_total_spent)} USDC (${s.spending_history.length} payments)`);
    line("Remaining", `${stroopsToUsdc(remaining)} USDC`);
  }
  line("Explorer", explorerAccount(env.SMART_ACCOUNT));
}

main().catch((e) => {
  console.error(`FAIL  ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
