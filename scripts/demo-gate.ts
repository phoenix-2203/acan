/**
 * The provenance gate on ACAN's own account, end to end on testnet, the way an
 * MCP client uses it:
 *   1. the agent asks the guardian to sign a task (dashboard → "Tasks to sign");
 *   2. it buys what the task allows: co-signed and paid;
 *   3. it tries the same item at a pricier merchant, then an item the task
 *      doesn't cover: the co-signer refuses both, nothing is signed;
 *   4. it signs the pricier one with its own key only: the smart account refuses.
 *
 * Needs: merchants (npm run merchant, npm run merchant:b), npm run guardian,
 * npm run cosigner, the dashboard open, and in .env COSIGNER_URL,
 * COSIGNER_RULE_ID (the gated rule), COSIGNER_DEVICE_KEYS.
 *
 * Usage: npm run demo:gate
 */
import { loadEnv, requireEnv } from "@acan/core";
import { AgentWallet } from "../apps/agent/src/wallet.js";
import { DEFAULT_MERCHANTS, merchantPins } from "../apps/agent/src/merchants.js";

loadEnv();
const [northwind, southgate] = DEFAULT_MERCHANTS;
const pins = merchantPins();
const w = new AgentWallet("public");
console.log(`Gated rule #${w.ruleId}; co-signer at ${w.cosignerUrl}\n`);

console.log("1. Asking the guardian to sign: “Buy the cheapest ledger report”, up to 0.02 USDC");
await w.startTask({ task: "Buy the cheapest ledger report", product: "/api/ledger", maxUsdc: "0.02" });
console.log("   signed in the dashboard\n");

const show = (label: string, r: Awaited<ReturnType<AgentWallet["buy"]>>) =>
  console.log(`${label}\n   ${r.ok ? `PAID ${r.priceUsdc} USDC ${r.receipt}` : `${r.status.toUpperCase()}: ${r.reason}`}\n`);

show("2. The cheapest ledger report (Southgate)", await w.buy(`${southgate}/api/ledger`, pins.get(southgate)));
show("3a. The same item at Northwind (pricier)", await w.buy(`${northwind}/api/ledger`, pins.get(northwind)));
show("3b. An item the task doesn't cover (/api/balance)", await w.buy(`${southgate}/api/balance?account=${requireEnv("SMART_ACCOUNT")}`, pins.get(southgate)));

console.log("4. The agent signs Northwind's ledger report with its own key only");
delete process.env.COSIGNER_URL; // this wallet signs with the agent key alone, on the same gated rule
const alone = new AgentWallet("public", console.log, w.ruleId);
show("   result", await alone.buy(`${northwind}/api/ledger`, pins.get(northwind)));
