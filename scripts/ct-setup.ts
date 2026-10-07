/**
 * One-time setup for confidential settlement (Milestone B). Safe to re-run.
 *
 *   AGENT_VAULT   classic account the agent controls; pays tabs from its
 *                 confidential balance (needs XLM for fees + a USDC trustline)
 *   AGENT_CT_SK   the vault's confidential spending secret
 *   MERCHANT_CT_SK / MERCHANT_B_CT_SK each merchant's confidential secret (decrypts settlements)
 *   CT_AUDITOR_SECRET the guardian's auditor key for this deployment
 *
 * Registers the vault and the merchant on the confidential token (each
 * registration is a zero-knowledge proof, generated locally; ~10-30 s).
 */
import { existsSync, readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { ensureUsdcTrustline, explorerTx, friendbot, loadEnv, requireEnv, saveEnv } from "@acan/core";
import { CONFIDENTIAL_TESTNET, ConfidentialAccount, randomScalar, toHex32 } from "@acan/confidential";

const env = loadEnv();
const DEPLOYMENT_FILE = "vendor/ctd-demo/deployments/testnet.json";
const step = (msg: string) => console.log(`\n▸ ${msg}`);
const ok = (msg: string) => console.log(`  PASS  ${msg}`);

function secretFor(name: string, make: () => string): string {
  const v = env[name] || make();
  saveEnv({ [name]: v });
  return v;
}

async function main() {
  const merchantSecret = requireEnv("MERCHANT_SECRET");
  const vaultSecret = secretFor("AGENT_VAULT_SECRET", () => Keypair.random().secret());
  const vault = Keypair.fromSecret(vaultSecret);
  saveEnv({ AGENT_VAULT_ADDRESS: vault.publicKey() });
  const agentCt = secretFor("AGENT_CT_SK", () => toHex32(randomScalar()));
  const merchantCt = secretFor("MERCHANT_CT_SK", () => toHex32(randomScalar()));
  const merchantBSecret = process.env.MERCHANT_B_SECRET;
  const merchantBCt = merchantBSecret ? secretFor("MERCHANT_B_CT_SK", () => toHex32(randomScalar())) : undefined;

  step("Guardian auditor key");
  if (env.CT_AUDITOR_SECRET) {
    ok("CT_AUDITOR_SECRET already in .env");
  } else if (existsSync(DEPLOYMENT_FILE)) {
    const d = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
    if (d.contracts?.token !== CONFIDENTIAL_TESTNET.contracts.token) {
      throw new Error(`${DEPLOYMENT_FILE} is for token ${d.contracts?.token}, not ${CONFIDENTIAL_TESTNET.contracts.token}`);
    }
    saveEnv({ CT_AUDITOR_SECRET: d.auditor.secretHex });
    ok(`copied from ${DEPLOYMENT_FILE}`);
  } else {
    console.log(`  SKIP  ${DEPLOYMENT_FILE} not found; the audit view will be unavailable`);
  }

  step("Agent vault account (testnet XLM + USDC trustline)");
  await friendbot(vault.publicKey());
  const tl = await ensureUsdcTrustline(vault);
  ok(`AGENT_VAULT ${vault.publicKey()} (trustline ${tl ? "added" : "already present"})`);

  step("Registering confidential accounts (generates a proof each)");
  const parties: [string, string, string][] = [
    ["agent vault", vaultSecret, agentCt],
    ["merchant A", merchantSecret, merchantCt],
  ];
  if (merchantBSecret && merchantBCt) parties.push(["merchant B", merchantBSecret, merchantBCt]);
  else console.log("  SKIP  merchant B: run `npm run setup` first to create MERCHANT_B");
  for (const [name, secret, ct] of parties) {
    const acct = new ConfidentialAccount({
      secret,
      ctSecretHex: ct,
      statePath: `.acan/ct-${Keypair.fromSecret(secret).publicKey()}.json`,
    });
    try {
      const t0 = Date.now();
      const hash = await acct.register();
      ok(
        hash
          ? `${name} registered in ${((Date.now() - t0) / 1000).toFixed(1)} s  ${explorerTx(hash)}`
          : `${name} already registered`,
      );
    } finally {
      await acct.close();
    }
  }

  console.log("\nCONFIDENTIAL SETUP COMPLETE (secrets saved to .env, which is git-ignored)");
}

main().catch((e) => {
  console.error(`\nCT SETUP FAILED: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(1);
});
