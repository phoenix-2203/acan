import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { ReceiptRecorder, addUsdc, canonicalJson, signReceipt, txHashOf, verifyReceiptSignature } from "../src/receipt.js";

test("a task receipt adds up, is signed by the agent, and any edit breaks it", () => {
  const agent = Keypair.random();
  const rec = new ReceiptRecorder({
    network: "stellar:testnet",
    agent: agent.publicKey(),
    smartAccount: "CCV4VQTGJN6GUVNM4LN3JWOWBOOX3E7IGKJ6QUPKZVKMDNV7WEJXVYAQ",
    ruleId: 6,
    mode: "public",
    task: "ledger + balance",
  });
  rec.leftAtStartUsdc = "0.2";
  rec.paid({ merchant: "Southgate Data", address: "GS", item: "/api/ledger", amountUsdc: "0.005", scheme: "exact", tx: "a".repeat(64) });
  rec.paid({ merchant: "Northwind Data", address: "GN", item: "/api/balance", amountUsdc: "0.02", scheme: "exact", tx: "b".repeat(64), approvedByGuardian: true });
  rec.paid({ merchant: "Southgate Data", address: "GS", item: "/api/insight", amountUsdc: "0.02", scheme: "exact", tx: "c".repeat(64) });
  rec.refused({ recipient: "GBAD…", amountUsdc: "2", policy: "Merchant allowlist", code: 3401 });
  const r = rec.build({ allowance: { limitUsdc: "0.2", remainingUsdc: "0.175" } });
  assert.equal(r.totals.spentUsdc, "0.045");
  assert.equal(r.totals.guardianApprovals, 1);
  assert.equal(r.totals.blocked, 1);
  assert.deepEqual(r.merchants.map((m) => [m.merchant, m.spentUsdc, m.payments]), [
    ["Southgate Data", "0.025", 2],
    ["Northwind Data", "0.02", 1],
  ]);
  assert.deepEqual(r.allowance, { limitUsdc: "0.2", leftAtStartUsdc: "0.2", leftAtEndUsdc: "0.175" });

  const signed = signReceipt(r, (d) => Buffer.from(agent.sign(d)), agent.publicKey());
  assert.ok(verifyReceiptSignature(signed));
  // Round-trips through JSON (as a downloaded file would).
  assert.ok(verifyReceiptSignature(JSON.parse(JSON.stringify(signed))));
  const tampered = structuredClone(signed);
  tampered.receipt.totals.spentUsdc = "0.001";
  assert.equal(verifyReceiptSignature(tampered), false);
  const otherSigner = signReceipt(r, (d) => Buffer.from(Keypair.random().sign(d)), agent.publicKey());
  assert.equal(verifyReceiptSignature(otherSigner), false);
});

test("helpers", () => {
  assert.equal(addUsdc(["0.1", "0.2", "0.0000001"]), "0.3000001");
  assert.equal(addUsdc([]), "0");
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }], u: undefined }), '{"a":[{"c":2,"d":1}],"b":1}');
  assert.equal(txHashOf(`https://stellar.expert/explorer/testnet/tx/${"A".repeat(64)}`), "a".repeat(64));
  assert.equal(txHashOf("voucher tab:G…:3"), undefined);
});
