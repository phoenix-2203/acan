/**
 * Write the PUBLIC addresses of this ACAN deployment to
 * deployments/testnet.json, which the demo site reads to show live testnet
 * state. Only public keys and contract ids are written; no secret from .env
 * ever goes into the file (every value is checked to be a G... or C...
 * address or a number before it is written).
 *
 * Usage: npm run deployment:publish  [-- --policy-version 0.2]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { StrKey } from "@stellar/stellar-sdk";
import { loadEnv, requireEnv } from "@acan/core";

loadEnv();
const PATH = "deployments/testnet.json";
const args = process.argv.slice(2);
const versionArg = args.includes("--policy-version") ? args[args.indexOf("--policy-version") + 1] : undefined;

const pub = (name: string): string => {
  const v = requireEnv(name);
  if (!StrKey.isValidEd25519PublicKey(v) && !StrKey.isValidContract(v)) {
    throw new Error(`${name} is not a public G... or C... address; refusing to publish it`);
  }
  return v;
};
const optionalPub = (name: string): string | undefined => (process.env[name] ? pub(name) : undefined);

const previous = JSON.parse(readFileSync(PATH, "utf8"));
const policy = optionalPub("ALLOWLIST_POLICY");
const ruleId = Number(requireEnv("AGENT_RULE_ID"));
if (!Number.isInteger(ruleId) || ruleId < 0) throw new Error("AGENT_RULE_ID must be a rule number");

const next = {
  network: "stellar:testnet",
  note: previous.note,
  smartAccount: pub("SMART_ACCOUNT"),
  agent: pub("AGENT_ADDRESS"),
  agentRuleId: ruleId,
  agentVault: optionalPub("AGENT_VAULT_ADDRESS"),
  merchants: [
    { name: "Northwind Data", address: pub("MERCHANT_ADDRESS") },
    ...(process.env.MERCHANT_B_ADDRESS ? [{ name: "Southgate Data", address: pub("MERCHANT_B_ADDRESS") }] : []),
  ],
  merchantPolicy: policy
    ? {
        address: policy,
        version: versionArg ?? (policy === previous.merchantPolicy?.address ? previous.merchantPolicy.version : "0.2"),
      }
    : undefined,
};
writeFileSync(PATH, JSON.stringify(next, null, 2) + "\n");
console.log(`wrote ${PATH}:`);
console.log(JSON.stringify(next, null, 2));
console.log("\nCommit and push it so the demo site shows this deployment.");
