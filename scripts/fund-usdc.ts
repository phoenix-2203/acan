/**
 * Move testnet USDC from the TREASURY account into the agent's smart account.
 * Usage: npm run fund:usdc -- 2        (amount in USDC, default 1)
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
  explorerTx,
  loadEnv,
  requireEnv,
  stroopsToUsdc,
  tokenBalance,
  transferFromClassic,
  usdcToStroops,
} from "@acan/core";

loadEnv();

async function main() {
  const treasury = Keypair.fromSecret(requireEnv("TREASURY_SECRET"));
  const smartAccount = requireEnv("SMART_ACCOUNT");
  const amount = usdcToStroops(process.argv[2] ?? "1");

  const have = await tokenBalance(treasury.publicKey());
  if (have < amount) {
    throw new Error(
      `Treasury has ${stroopsToUsdc(have)} USDC, needs ${stroopsToUsdc(amount)}. Get more at https://faucet.circle.com (address ${treasury.publicKey()}).`,
    );
  }
  const hash = await transferFromClassic(treasury, smartAccount, amount);
  const balance = await tokenBalance(smartAccount);
  console.log(`PASS  sent ${stroopsToUsdc(amount)} USDC to ${smartAccount}`);
  console.log(`      smart account balance: ${stroopsToUsdc(balance)} USDC`);
  console.log(`      ${explorerTx(hash)}`);
}

main().catch((e) => {
  console.error(`FAIL  ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
