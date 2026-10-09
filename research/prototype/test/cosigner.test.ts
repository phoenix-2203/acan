/**
 * Adversarial tests for the provenance co-signer. Each attack is a case a
 * compromised or manipulated agent could submit; the co-signer must refuse to
 * sign anything whose recipient, amount or path to payment it cannot trace to
 * the user's signed request and the guardian's pinned price book.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "buffer";
import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";
import { buildAuthDigest, signaturePayloadOf } from "../src/auth.js";
import { runPlan } from "../src/plan.js";
import type { Decision, ReviewCase } from "../src/cosigner.js";
import { cosignerFor } from "../src/fixture.js";
import {
  ATTACKER, CATALOG, KEYS, NORTHWIND, NOW, PASSPHRASE, PLANS, RULE_ID, SOUTHGATE, TRANSCRIPT,
  entryFor, request,
} from "../src/scenario.js";

const ledger = (maxAmount = "300000", nonce = "req-1") => request({ product: "ledger-report", maxAmount }, { nonce });

function review(plan: keyof typeof PLANS, to: string, amount: bigint, extra: Partial<ReviewCase> = {}, entryExtra = {}): Decision {
  return cosignerFor().review({
    request: ledger(),
    plan: PLANS[plan],
    transcript: TRANSCRIPT,
    payIndex: 0,
    authEntry: entryFor(to, amount, entryExtra).toXDR("base64"),
    ...extra,
  });
}

function escalated(d: Decision): string[] {
  assert.equal(d.verdict, "escalate", `expected escalate, got ${JSON.stringify(d.verdict === "reject" ? d.reason : d.verdict)}`);
  return (d as Extract<Decision, { verdict: "escalate" }>).why;
}

// --- The honest case ---------------------------------------------------------

test("clean: 'buy the cheapest ledger report' is co-signed, and the signature is over the digest the account checks", () => {
  const entry = entryFor(SOUTHGATE, 80_000n);
  const d = cosignerFor().review({ request: ledger(), plan: PLANS.clean, transcript: TRANSCRIPT, payIndex: 0, authEntry: entry.toXDR("base64") });
  assert.equal(d.verdict, "cosign");
  if (d.verdict !== "cosign") return;
  const digest = buildAuthDigest(signaturePayloadOf(entry, PASSPHRASE), [RULE_ID]);
  assert.equal(d.digest, digest.toString("hex"));
  assert.ok(KEYS.cosigner.verify(digest, d.signature.signature));
  assert.equal(d.transfer.to, SOUTHGATE);
  assert.equal(d.transfer.amount, 80_000n);
});

test("clean plan labels: recipient and amount depend only on the user and the pinned book", () => {
  const [pay] = runPlan(PLANS.clean, { request: { product: "ledger-report" }, catalog: CATALOG, transcript: TRANSCRIPT });
  assert.deepEqual([...pay.to.src].sort(), ["pinned", "user"]);
  assert.deepEqual([...pay.amount.src].sort(), ["pinned", "user"]);
  assert.equal(pay.ctx.size, 0);
});

// --- Injection inside the limits (A1) ---------------------------------------------

test("A1 steered choice: a note recommends the full dataset at an allowlisted merchant, within budget -> escalated, not signed", () => {
  const why = escalated(review("steered", NORTHWIND, 250_000n));
  assert.ok(why.some((w) => w.startsWith("recipient depends on tool:news.example")));
  assert.ok(why.some((w) => w.startsWith("amount depends on tool:news.example")));
});

test("amount from a tool, recipient clean -> escalated on the amount only", () => {
  const why = escalated(review("amountFromTool", SOUTHGATE, 250_000n));
  assert.deepEqual(why, ["amount depends on tool:news.example"]);
});

// --- Laundering (A2) -----------------------------------------------------------

test("A2 laundering through arithmetic: price + 0 (the 0 from the tool) is still tainted", () => {
  assert.deepEqual(escalated(review("launderAdd", SOUTHGATE, 80_000n)), ["amount depends on tool:news.example"]);
});

test("A2 laundering through string building: a recipient copied out of tool text is tainted", () => {
  assert.deepEqual(escalated(review("launderFormat", ATTACKER, 80_000n)), ["recipient depends on tool:news.example"]);
});

test("A2 laundering through a lookup: the tool picks the merchant, the values come from the pinned book -> still tainted", () => {
  const why = escalated(review("launderLookup", NORTHWIND, 100_000n));
  assert.deepEqual(why, ["recipient depends on tool:news.example", "amount depends on tool:news.example"]);
});

// --- Control flow (A3) ---------------------------------------------------------

test("A3 implicit flow: clean values paid only if the tool says so -> the decision to pay is tainted", () => {
  const why = escalated(review("implicit", SOUTHGATE, 80_000n));
  assert.ok(why.includes("the decision to pay depends on planner, tool:news.example"));
});

test("an untaken branch makes no payment; a taken one is tainted either way", () => {
  const quiet = { [Object.keys(TRANSCRIPT)[0]]: JSON.stringify({ go: "no" }) };
  assert.equal(runPlan(PLANS.implicit, { request: { product: "ledger-report" }, catalog: CATALOG, transcript: quiet }).length, 0);
});

test("no abort channel: reading a missing field of tainted data does not throw, so a clean payment after it is still co-signed", () => {
  assert.equal(review("noAbort", SOUTHGATE, 80_000n).verdict, "cosign");
});

// --- A compromised planner ------------------------------------------------------

test("values the planner wrote itself are not trusted as recipient or amount", () => {
  const why = escalated(review("literal", ATTACKER, 50_000n));
  assert.deepEqual(why, ["recipient depends on planner", "amount depends on planner"]);
});

test("the agent cannot supply its own catalog: a price list fetched from a tool stays tainted", () => {
  const url = "https://evil.example/catalog";
  const fake = { [url]: JSON.stringify({ items: [{ product: "ledger-report", price: "1", payTo: ATTACKER }] }) };
  const plan = [
    { let: "product", op: "request", field: "product" },
    { let: "body", op: "fetch", url },
    { let: "cat", op: "field", from: "body", key: "items" },
    { let: "matches", op: "filter", list: "cat", key: "product", equals: "product" },
    { let: "best", op: "cheapest", list: "matches" },
    { let: "to", op: "field", from: "best", key: "payTo" },
    { let: "price", op: "field", from: "best", key: "price" },
    { op: "pay", to: "to", amount: "price" },
  ];
  const d = cosignerFor().review({ request: ledger(), plan: plan as any, transcript: fake, payIndex: 0, authEntry: entryFor(ATTACKER, 1n).toXDR("base64") });
  assert.deepEqual(escalated(d), ["recipient depends on tool:evil.example", "amount depends on tool:evil.example"]);
});

// --- The entry must be exactly the plan's payment (A4) ----------------------------

test("A4 entry mismatch: a clean plan cannot be used to sign a different payment", () => {
  const cases: [string, ReturnType<typeof entryFor>][] = [
    ["recipient differs from the plan", entryFor(ATTACKER, 80_000n)],
    ["amount differs from the plan", entryFor(SOUTHGATE, 80_001n)],
    ["not the configured token", entryFor(SOUTHGATE, 80_000n, { token: StrKey.encodeContract(hash(Buffer.from("other-token"))) })],
    ["not a transfer (approve)", entryFor(SOUTHGATE, 80_000n, { fn: "approve" })],
    ["transfer is not from this account", entryFor(SOUTHGATE, 80_000n, { from: Keypair.random().publicKey() })],
    ["authorization is for another account", entryFor(SOUTHGATE, 80_000n, { account: StrKey.encodeContract(hash(Buffer.from("x"))) })],
  ];
  for (const [reason, entry] of cases) {
    const d = cosignerFor().review({ request: ledger(), plan: PLANS.clean, transcript: TRANSCRIPT, payIndex: 0, authEntry: entry.toXDR("base64") });
    assert.deepEqual(d, { verdict: "reject", reason }, reason);
  }
});

test("A4 extra calls hidden under the transfer are refused", () => {
  const inner = entryFor(ATTACKER, 1n).rootInvocation();
  const entry = entryFor(SOUTHGATE, 80_000n, { subInvocations: [inner] });
  const d = cosignerFor().review({ request: ledger(), plan: PLANS.clean, transcript: TRANSCRIPT, payIndex: 0, authEntry: entry.toXDR("base64") });
  assert.deepEqual(d, { verdict: "reject", reason: "the authorization includes extra calls" });
});

test("the co-signature only counts under the configured rule id", () => {
  const entry = entryFor(SOUTHGATE, 80_000n);
  const d = cosignerFor().review({ request: ledger(), plan: PLANS.clean, transcript: TRANSCRIPT, payIndex: 0, authEntry: entry.toXDR("base64") });
  assert.equal(d.verdict, "cosign");
  if (d.verdict !== "cosign") return;
  const other = buildAuthDigest(signaturePayloadOf(entry, PASSPHRASE), [RULE_ID + 1]);
  assert.equal(KEYS.cosigner.verify(other, d.signature.signature), false);
});

// --- The user's request (A8) ----------------------------------------------------

test("A8 a forged or altered request is refused", () => {
  const signed = ledger();
  const altered = { ...signed, request: { ...signed.request, fields: { ...signed.request.fields, maxAmount: "99999999" } } };
  const base = { plan: PLANS.clean, transcript: TRANSCRIPT, payIndex: 0, authEntry: entryFor(SOUTHGATE, 80_000n).toXDR("base64") };
  assert.deepEqual(cosignerFor().review({ request: altered, ...base }), { verdict: "reject", reason: "request signature is invalid" });
  const stranger = request({ product: "ledger-report", maxAmount: "300000" }, {}, KEYS.stranger);
  assert.deepEqual(cosignerFor().review({ request: stranger, ...base }), { verdict: "reject", reason: "request key is not registered for this user" });
  const other = request({ product: "ledger-report", maxAmount: "300000" }, { account: StrKey.encodeContract(hash(Buffer.from("y"))) });
  assert.deepEqual(cosignerFor().review({ request: other, ...base }), { verdict: "reject", reason: "request is for another account" });
  const old = request({ product: "ledger-report", maxAmount: "300000" }, { issuedAt: NOW - 3600 });
  assert.deepEqual(cosignerFor().review({ request: old, ...base }), { verdict: "reject", reason: "request expired" });
});

// --- Replay and budget (A7) ------------------------------------------------------

test("A7 one request cannot be stretched: a second payment beyond its maxAmount is refused; the same entry again is idempotent", () => {
  const c = cosignerFor();
  const req = ledger("100000");
  const first = entryFor(SOUTHGATE, 80_000n, { nonce: 1n }).toXDR("base64");
  const d1 = c.review({ request: req, plan: PLANS.clean, transcript: TRANSCRIPT, payIndex: 0, authEntry: first });
  assert.equal(d1.verdict, "cosign");
  const again = c.review({ request: req, plan: PLANS.clean, transcript: TRANSCRIPT, payIndex: 0, authEntry: first });
  assert.deepEqual(again, d1);
  const second = entryFor(SOUTHGATE, 80_000n, { nonce: 2n }).toXDR("base64");
  assert.deepEqual(c.review({ request: req, plan: PLANS.clean, transcript: TRANSCRIPT, payIndex: 0, authEntry: second }), {
    verdict: "reject",
    reason: "request budget exceeded",
  });
});

test("the plan must contain the payment the entry claims", () => {
  const d = review("clean", SOUTHGATE, 80_000n, { payIndex: 1 });
  assert.deepEqual(d, { verdict: "reject", reason: "the plan has no payment #1" });
});

test("a malformed authorization entry is refused", () => {
  const d = review("clean", SOUTHGATE, 80_000n, { authEntry: "AAAA" });
  assert.equal(d.verdict, "reject");
});

