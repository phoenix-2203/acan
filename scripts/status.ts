/** Print balances and the agent's allowance state. */
import { loadEnv, merchantPolicyState, spendingLimitState, stroopsToUsdc, tokenBalance, explorerAccount } from "@acan/core";

loadEnv();

const line = (k: string, v: string) => console.log(`${k.padEnd(26)} ${v}`);

async function main() {
  const env = process.env;
  if (env.TREASURY_ADDRESS) line("Treasury USDC", `${stroopsToUsdc(await tokenBalance(env.TREASURY_ADDRESS))}`);
  if (env.MERCHANT_ADDRESS) line("Merchant A USDC", `${stroopsToUsdc(await tokenBalance(env.MERCHANT_ADDRESS))}`);
  if (env.MERCHANT_B_ADDRESS) line("Merchant B USDC", `${stroopsToUsdc(await tokenBalance(env.MERCHANT_B_ADDRESS))}`);
  if (env.AGENT_VAULT_ADDRESS) line("Agent vault USDC (public)", `${stroopsToUsdc(await tokenBalance(env.AGENT_VAULT_ADDRESS))}`);
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
  if (env.AGENT_RULE_ID && env.ALLOWLIST_POLICY) {
    try {
      const { params, usage } = await merchantPolicyState(env.ALLOWLIST_POLICY, env.SMART_ACCOUNT, Number(env.AGENT_RULE_ID));
      const names: Record<string, string> = {
        [env.MERCHANT_ADDRESS ?? ""]: "merchant A",
        [env.MERCHANT_B_ADDRESS ?? ""]: "merchant B",
        [env.AGENT_VAULT_ADDRESS ?? ""]: "agent vault",
      };
      for (const r of params.recipients) {
        const used = usage.spent.get(r.address) ?? 0n;
        const label = names[r.address] ?? `${r.address.slice(0, 6)}…`;
        line(`  may pay ${label}`, r.cap > 0n ? `${stroopsToUsdc(used)} / ${stroopsToUsdc(r.cap)} USDC used` : `no cap (${stroopsToUsdc(used)} USDC used)`);
      }
      if (params.max_payments > 0) line("  payments this period", `${usage.payments} / ${params.max_payments}`);
    } catch {
      line("Merchant budget policy", "not installed on this rule");
    }
  }
  line("Explorer", explorerAccount(env.SMART_ACCOUNT));
}

main().catch((e) => {
  console.error(`FAIL  ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
