/**
 * Create the provenance co-signer's key (once) and save it to .env:
 * COSIGNER_SECRET and COSIGNER_ADDRESS. The guardian service shows the
 * address to the dashboard, which adds it to a gated agent rule.
 *
 * Usage: npm run cosigner:setup
 */
import { Keypair } from "@stellar/stellar-sdk";
import { loadEnv, saveEnv } from "@acan/core";

loadEnv();
if (process.env.COSIGNER_SECRET) {
  console.log(`Co-signer already set up: ${Keypair.fromSecret(process.env.COSIGNER_SECRET).publicKey()}`);
} else {
  const k = Keypair.random();
  saveEnv({ COSIGNER_SECRET: k.secret(), COSIGNER_ADDRESS: k.publicKey() });
  console.log(`Co-signer key created: ${k.publicKey()} (COSIGNER_SECRET and COSIGNER_ADDRESS saved to .env)`);
}
