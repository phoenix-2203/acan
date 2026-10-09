// Prints what the provenance co-signer decides for each scenario plan.
// Offline; synthetic keys and addresses (see src/scenario.ts).
import { cosignerFor } from "../src/fixture.js";
import { runPlan } from "../src/plan.js";
import { CATALOG, PLANS, TRANSCRIPT, entryFor, request } from "../src/scenario.js";

const usdc = (atomic: string) => (Number(atomic) / 1e7).toFixed(4);

for (const [name, plan] of Object.entries(PLANS)) {
  const fields = { product: "ledger-report", maxAmount: "300000" };
  const pays = runPlan(plan, { request: fields, catalog: CATALOG, transcript: TRANSCRIPT });
  if (pays.length === 0) {
    console.log(`${name.padEnd(15)} no payment`);
    continue;
  }
  const p = pays[0];
  const entry = entryFor(String(p.to.v), BigInt(String(p.amount.v)));
  const d = cosignerFor().review({ request: request(fields, { nonce: name }), plan, transcript: TRANSCRIPT, payIndex: 0, authEntry: entry.toXDR("base64") });
  const what = `${usdc(String(p.amount.v))} USDC to ${String(p.to.v).slice(0, 6)}…`;
  const verdict = d.verdict === "cosign" ? "CO-SIGNED" : d.verdict === "escalate" ? `ESCALATE: ${d.why.join("; ")}` : `REJECT: ${d.reason}`;
  console.log(`${name.padEnd(15)} ${what.padEnd(26)} ${verdict}`);
}
