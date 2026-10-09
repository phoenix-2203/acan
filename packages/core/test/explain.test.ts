/**
 * Explainable receipts: the co-signer's decisions re-run from the receipt alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "buffer";
import { explainReceipt } from "../src/provenance/explain.js";
import { signReceipt, type SignedReceipt, type TaskReceipt } from "../src/receipt.js";
import { cosignerFor } from "../../../research/prototype/src/fixture.js";
import { ACCOUNT, CATALOG, KEYS, NORTHWIND, PASSPHRASE, PLANS, RULE_ID, SOUTHGATE, TOKEN, TRANSCRIPT, entryFor, request } from "../../../research/prototype/src/scenario.js";

function build(): SignedReceipt {
  const c = cosignerFor();
  const req = request({ product: "ledger-report", maxAmount: "300000" });
  const entry = entryFor(SOUTHGATE, 80_000n).toXDR("base64");
  const d = c.review({ request: req, plan: PLANS.clean, transcript: TRANSCRIPT, payIndex: 0, authEntry: entry });
  assert.equal(d.verdict, "cosign");
  if (d.verdict !== "cosign") throw new Error();
  const receipt: TaskReceipt = {
    v: 1,
    kind: "acan-task-receipt",
    network: "stellar:testnet",
    task: req.request.task,
    agent: KEYS.agent.publicKey(),
    smartAccount: ACCOUNT,
    ruleId: RULE_ID,
    mode: "public",
    startedAt: "2026-10-09T15:00:00.000Z",
    endedAt: "2026-10-09T15:01:00.000Z",
    totals: { spentUsdc: "0.008", payments: 1, blocked: 1, guardianApprovals: 0 },
    merchants: [{ merchant: "Southgate Data", address: SOUTHGATE, spentUsdc: "0.008", payments: 1 }],
    payments: [
      { at: "2026-10-09T15:00:30.000Z", merchant: "Southgate Data", address: SOUTHGATE, item: "ledger-report", amountUsdc: "0.008", scheme: "transfer", tx: "a".repeat(64), payIndex: 0, authEntry: entry, cosignature: d.signature.signature.toString("hex") },
    ],
    blocked: [{ at: "2026-10-09T15:00:40.000Z", recipient: "Northwind Data", amountUsdc: "0.025", policy: "Provenance co-signer", code: null, held: { payIndex: 0, why: ["x"] } }],
    asset: { code: "USDC", sac: TOKEN },
    provenance: { request: req as any, plan: PLANS.clean, transcript: TRANSCRIPT, catalog: CATALOG, cosigner: KEYS.cosigner.publicKey(), networkPassphrase: PASSPHRASE },
  };
  return signReceipt(receipt, (dg) => Buffer.from(KEYS.agent.sign(dg)), KEYS.agent.publicKey());
}

test("a clean payment re-runs clean and its co-signature verifies", () => {
  const checks = explainReceipt(build());
  assert.equal(checks[0].status, "ok");
  assert.match(checks[1].text, /trace to the request and the pinned catalog/);
  assert.equal(checks[1].status, "ok");
  assert.equal(checks[2].status, "ok");
  assert.match(checks[2].text, /signed exactly this transfer/);
});

test("a hold is confirmed only when the re-run finds untrusted influence", () => {
  const s = build();
  // The clean plan has nothing to hold: the receipt's hold must be called out.
  assert.equal(explainReceipt(s).at(-1)!.status, "fail");
  // With the steered plan, the re-run agrees with a hold.
  const steered = { ...s, receipt: { ...s.receipt, payments: [], provenance: { ...s.receipt.provenance!, plan: PLANS.steered } } };
  const last = explainReceipt(steered).at(-1)!;
  assert.equal(last.status, "ok");
  assert.match(last.text, /depended on content from news\.example/);
});

test("tampering is caught: another amount, another recipient, a forged request, a swapped co-signature", () => {
  const s = build();
  const p0 = s.receipt.payments[0];
  const amount = { ...s, receipt: { ...s.receipt, payments: [{ ...p0, amountUsdc: "0.0081" }] } };
  assert.ok(explainReceipt(amount).some((c) => c.status === "fail"));
  const to = { ...s, receipt: { ...s.receipt, payments: [{ ...p0, address: NORTHWIND }] } };
  assert.ok(explainReceipt(to).some((c) => c.status === "fail"));
  const req = s.receipt.provenance!.request as any;
  const forged = { ...s, receipt: { ...s.receipt, provenance: { ...s.receipt.provenance!, request: { ...req, request: { ...req.request, fields: { ...req.request.fields, maxAmount: "9" } } } } } };
  assert.equal(explainReceipt(forged)[0].status, "fail");
  const swapped = { ...s, receipt: { ...s.receipt, payments: [{ ...p0, cosignature: "00".repeat(64) }] } };
  assert.equal(explainReceipt(swapped)[2].status, "fail");
});
