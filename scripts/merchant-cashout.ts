/**
 * Merchant cash-out: fold received confidential settlements into the
 * spendable balance, then withdraw them to the merchant's public USDC
 * balance (one withdraw proof). The withdrawn amount is public.
 *
 * Usage: npm run merchant:cashout            (merchant A)
 *        MERCHANT_PROFILE=b npm run merchant:cashout   (merchant B)
 */
import { explorerTx, loadEnv, requireEnv, stroopsToUsdc, tokenBalance } from "@acan/core";
import { ConfidentialAccount } from "@acan/confidential";

loadEnv();

const P = (process.env.MERCHANT_PROFILE ?? "a").toLowerCase() === "b" ? "MERCHANT_B" : "MERCHANT";

async function main() {
  const address = requireEnv(`${P}_ADDRESS`);
  const acct = new ConfidentialAccount({
    secret: requireEnv(`${P}_SECRET`),
    ctSecretHex: requireEnv(`${P}_CT_SK`),
    statePath: `.acan/ct-${address}.json`,
  });
  try {
    let b = await acct.balances();
    console.log(`confidential: spendable ${stroopsToUsdc(b.spendable)}, receiving ${stroopsToUsdc(b.receiving)} USDC`);
    if (b.receiving > 0n) {
      console.log(`merge  ${explorerTx(await acct.merge())}`);
      await acct.waitForSpendable(b.spendable + b.receiving);
      b = await acct.balances();
    }
    if (b.spendable === 0n) return console.log("nothing to withdraw");
    console.log(`withdrawing ${stroopsToUsdc(b.spendable)} USDC (generating proof)…`);
    console.log(`withdraw  ${explorerTx(await acct.withdraw(b.spendable))}`);
    console.log(`merchant public USDC balance: ${stroopsToUsdc(await tokenBalance(address))}`);
  } finally {
    await acct.close();
  }
}

main().catch((e) => {
  console.error(`CASHOUT FAILED: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
