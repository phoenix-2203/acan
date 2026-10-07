/**
 * Build and deploy ACAN's merchant allowlist policy contract to testnet, then
 * save its address to .env as ALLOWLIST_POLICY and to deployments/testnet.json
 * (public addresses only, read by the demo site). Needs the stellar CLI, Rust
 * with the wasm32v1-none target, and a funded CLI identity (default: admin).
 *
 * Usage: npm run allowlist:deploy  [-- <identity>]
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { StrKey } from "@stellar/stellar-sdk";
import { explorerAccount, loadEnv, saveEnv } from "@acan/core";

loadEnv();
const identity = process.argv[2] ?? "admin";
const WASM = "contracts/target/wasm32v1-none/release/acan_merchant_allowlist_policy.wasm";

function run(args: string[], capture = false): string {
  console.log(`$ stellar ${args.join(" ")}`);
  const out = execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
  return (out ?? "").trim();
}

run(["contract", "build", "--manifest-path", "contracts/Cargo.toml"]);
if (!existsSync(WASM)) throw new Error(`build did not produce ${WASM}`);
const out = run(["contract", "deploy", "--wasm", WASM, "--source", identity, "--network", "testnet"], true);
const id = out.split(/\s+/).reverse().find((t) => StrKey.isValidContract(t));
if (!id) throw new Error(`could not find the contract id in the deploy output:\n${out}`);
saveEnv({ ALLOWLIST_POLICY: id });
console.log(`\nALLOWLIST_POLICY=${id} saved to .env`);
console.log(`Explorer: ${explorerAccount(id)}`);
console.log("Publishing the new address for the demo site (deployments/testnet.json)…");
execFileSync("npx", ["tsx", "scripts/publish-deployment.ts", "--policy-version", "0.2"], { stdio: "inherit" });
