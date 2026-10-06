/**
 * One-time testnet setup. Safe to re-run: existing keys in .env are reused.
 *
 * Creates and funds (via Friendbot) three classic accounts:
 *   MERCHANT     receives x402 payments (needs a USDC trustline)
 *   FACILITATOR  pays settlement fees when FACILITATOR=local
 *   TREASURY     holds testnet USDC from Circle's faucet, used to top up the
 *                agent's smart account (needs a USDC trustline)
 * and one key that is never funded:
 *   AGENT        the AI agent's Ed25519 signing key; it only signs for the
 *                smart account under a capped context rule
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
  ensureUsdcTrustline,
  explorerAccount,
  friendbot,
  loadEnv,
  saveEnv,
  stroopsToUsdc,
  tokenBalance,
} from "@acan/core";

const env = loadEnv();

function keyFor(name: string): Keypair {
  const secret = env[`${name}_SECRET`];
  const kp = secret ? Keypair.fromSecret(secret) : Keypair.random();
  saveEnv({ [`${name}_SECRET`]: kp.secret(), [`${name}_ADDRESS`]: kp.publicKey() });
  return kp;
}

const step = (msg: string) => console.log(`\n▸ ${msg}`);
const ok = (msg: string) => console.log(`  PASS  ${msg}`);

async function main() {
  const merchant = keyFor("MERCHANT");
  const facilitator = keyFor("FACILITATOR");
  const treasury = keyFor("TREASURY");
  const agent = keyFor("AGENT");

  step("Funding classic accounts with testnet XLM (Friendbot)");
  for (const [name, kp] of [["MERCHANT", merchant], ["FACILITATOR", facilitator], ["TREASURY", treasury]] as const) {
    await friendbot(kp.publicKey());
    ok(`${name} ${kp.publicKey()}`);
  }

  step("Adding USDC trustlines");
  for (const [name, kp] of [["MERCHANT", merchant], ["TREASURY", treasury]] as const) {
    const hash = await ensureUsdcTrustline(kp);
    ok(`${name} trustline ${hash ? `added (${hash.slice(0, 10)}…)` : "already present"}`);
  }

  const treasuryUsdc = await tokenBalance(treasury.publicKey());
  console.log(`\nAgent public key (register this in the dashboard): ${agent.publicKey()}`);
  console.log(`Treasury USDC balance: ${stroopsToUsdc(treasuryUsdc)} USDC`);
  if (treasuryUsdc === 0n) {
    console.log(
      `\nACTION NEEDED: get testnet USDC for the treasury.\n` +
        `  1. Open https://faucet.circle.com\n` +
        `  2. Choose "Stellar Testnet"\n` +
        `  3. Paste this address: ${treasury.publicKey()}\n` +
        `  Then run: npm run status`,
    );
  }
  console.log(`\nTreasury on explorer: ${explorerAccount(treasury.publicKey())}`);
  console.log("\nSETUP COMPLETE (secrets saved to .env, which is git-ignored)");
}

main().catch((e) => {
  console.error(`\nSETUP FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
