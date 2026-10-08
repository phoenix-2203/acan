import { test } from "node:test";
import assert from "node:assert/strict";
import { PaymentRejectedError, describeSimulationError, explainRefusal } from "../src/errors.js";

const sim = (code: number) => `HostError: Error(Contract, #${code})\n\nEvent log (newest first): ...`;

test("refusals carry their contract code and a plain explanation", () => {
  const e = new PaymentRejectedError(describeSimulationError(sim(3401)), sim(3401));
  assert.equal(e.code, 3401);
  assert.match(e.message, /RecipientNotAllowed/);
  const r = explainRefusal(e.code);
  assert.equal(r.title, "Recipient is not approved");
  assert.equal(r.policy, "Merchant allowlist");
  assert.equal(r.severity, "high");
  assert.equal(explainRefusal(3408).severity, "medium");
  assert.equal(explainRefusal(sim(3221)).policy, "Spending limit");
  // The token's own refusal (seen on testnet: 2 USDC from an account holding 0.69).
  assert.equal(explainRefusal(sim(10)).title, "Not enough USDC");
  assert.match(describeSimulationError(sim(10)), /BalanceError/);
});

test("unknown or missing codes still explain something", () => {
  assert.equal(explainRefusal(9999).title, "Payment refused");
  assert.match(explainRefusal(9999).reason, /#9999/);
  assert.equal(explainRefusal(null).code, null);
  assert.equal(new PaymentRejectedError("no code here").code, null);
});
