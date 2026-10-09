/**
 * Run the provenance co-signer for ACAN's own account (the MCP / CLI agent).
 *
 * .env: COSIGNER_SECRET (S...), COSIGNER_RULE_ID (the gated rule),
 *       SMART_ACCOUNT, COSIGNER_DEVICE_KEYS (G..., comma-separated: the
 *       dashboard's request key), COSIGNER_PORT (4040).
 * Pinned catalog: .acan/pinned-catalog.json (npm run catalog:pin).
 *
 * Usage: npm run cosigner
 */
import { readFileSync } from "node:fs";
import { ASSETS, OZ_SMART_ACCOUNT, TESTNET, loadEnv, requireEnv } from "@acan/core";
import { createCosignerService } from "./service.js";

loadEnv();
const port = Number(process.env.COSIGNER_PORT ?? 4040);
const catalog = JSON.parse(readFileSync(".acan/pinned-catalog.json", "utf8"));
const deviceKeys = requireEnv("COSIGNER_DEVICE_KEYS").split(",").map((s) => s.trim()).filter(Boolean);
createCosignerService({
  secret: requireEnv("COSIGNER_SECRET"),
  account: requireEnv("SMART_ACCOUNT"),
  token: ASSETS.usdc.sac,
  ruleId: Number(requireEnv("COSIGNER_RULE_ID")),
  networkPassphrase: TESTNET.networkPassphrase,
  verifier: OZ_SMART_ACCOUNT.ed25519Verifier,
  deviceKeys,
  catalog,
}).listen(port, "127.0.0.1", () => console.log(`provenance co-signer on http://127.0.0.1:${port} (rule #${process.env.COSIGNER_RULE_ID}, ${catalog.length} pinned items)`));
