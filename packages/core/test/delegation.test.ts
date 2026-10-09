/**
 * Agents hiring agents: sub-mandates that can only narrow, budgets that add up
 * to the root, and cancellation that cascades. Each test is an attempt a
 * sub-agent (or a compromised parent) could make.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "buffer";
import { Keypair, hash } from "@stellar/stellar-sdk";
import { ProvenanceCosigner } from "../src/provenance/cosigner.js";
import { delegationId, requestId, signDelegation, type Delegation, type SignedDelegation } from "../src/provenance/delegation.js";
import { taskPlan } from "../src/provenance/gated-signer.js";
import { ACCOUNT, CATALOG, KEYS, NOW, PASSPHRASE, RULE_ID, SOUTHGATE, TOKEN, VERIFIER, entryFor, request } from "../../../research/prototype/src/scenario.js";

const sub = Keypair.fromRawEd25519Seed(hash(Buffer.from("acan-test/sub-agent")));
const subsub = Keypair.fromRawEd25519Seed(hash(Buffer.from("acan-test/sub-sub-agent")));
const outsider = Keypair.fromRawEd25519Seed(hash(Buffer.from("acan-test/outsider")));

function cosigner() {
  return new ProvenanceCosigner({
    secret: KEYS.cosigner.secret(),
    account: ACCOUNT,
    token: TOKEN,
    ruleId: RULE_ID,
    networkPassphrase: PASSPHRASE,
    verifier: VERIFIER,
    deviceKeys: [KEYS.device.publicKey()],
    catalog: CATALOG,
    agentKeys: [KEYS.agent.publicKey()],
    now: () => NOW,
  });
}

// The user: "buy ledger reports, up to 0.024 USDC" (three of Southgate's 0.008).
const root = request({ product: "ledger-report", maxAmount: "240000" }, { nonce: "root" });

function link(by: Keypair, parent: string, delegate: Keypair, fields: Record<string, string>, extra: Partial<Delegation> = {}): SignedDelegation {
  return signDelegation(by, { parent, delegate: delegate.publicKey(), task: "fetch the ledger report", fields, nonce: `n-${Math.random()}`, issuedAt: NOW - 5, ttlSeconds: 300, ...extra });
}

let n = 0;
function pay(c: ProvenanceCosigner, chain: SignedDelegation[], amount = 80_000n) {
  return c.review({ request: root, plan: taskPlan(false) as any, transcript: {}, payIndex: 0, authEntry: entryFor(SOUTHGATE, amount, { nonce: BigInt(++n) }).toXDR("base64"), chain });
}

const reason = (d: ReturnType<typeof pay>) => (d.verdict === "reject" ? d.reason : d.verdict);

test("a sub-agent with a narrower mandate pays what traces back through it to the user", () => {
  const c = cosigner();
  const d1 = link(KEYS.agent, requestId(root), sub, { product: "ledger-report", maxAmount: "80000" });
  assert.equal(pay(c, [d1]).verdict, "cosign");
  assert.equal(c.spentUnder(requestId(root)), 80_000n);
  assert.equal(c.spentUnder(delegationId(d1)), 80_000n);
});

test("a sub-mandate cannot widen: more budget, another item, a longer life, or an unknown field", () => {
  const c = cosigner();
  const p = requestId(root);
  assert.equal(reason(pay(c, [link(KEYS.agent, p, sub, { product: "ledger-report", maxAmount: "240001" })])), "sub-mandate 1 asks for more than its parent allows");
  assert.equal(reason(pay(c, [link(KEYS.agent, p, sub, { product: "full-dataset", maxAmount: "80000" })])), "sub-mandate 1 changes “product”, which its parent fixed");
  assert.equal(reason(pay(c, [link(KEYS.agent, p, sub, { product: "ledger-report", maxAmount: "80000" }, { ttlSeconds: 10_000 })])), "sub-mandate 1 outlives its parent");
  assert.equal(reason(pay(c, [link(KEYS.agent, p, sub, { product: "ledger-report", maxAmount: "80000", admin: "yes" })])), "sub-mandate 1 adds an unknown field “admin”");
});

test("a sub-agent cannot spend past its own budget, even when the user's budget has room", () => {
  const c = cosigner();
  const d1 = link(KEYS.agent, requestId(root), sub, { product: "ledger-report", maxAmount: "80000" });
  assert.equal(pay(c, [d1]).verdict, "cosign");
  assert.equal(reason(pay(c, [d1])), "sub-mandate 1 budget exceeded");
});

test("siblings share the parent's budget: together they cannot exceed it", () => {
  const c = cosigner();
  const p = requestId(root);
  const a = link(KEYS.agent, p, sub, { product: "ledger-report", maxAmount: "160000" });
  const b = link(KEYS.agent, p, subsub, { product: "ledger-report", maxAmount: "160000" });
  assert.equal(pay(c, [a]).verdict, "cosign");
  assert.equal(pay(c, [a]).verdict, "cosign");
  assert.equal(pay(c, [b]).verdict, "cosign");
  assert.equal(reason(pay(c, [b])), "request budget exceeded");
});

test("cancelling cascades: the user's task, or one link, stops everything below at the next payment", () => {
  const c = cosigner();
  const d1 = link(KEYS.agent, requestId(root), sub, { product: "ledger-report", maxAmount: "160000" });
  const d2 = link(sub, delegationId(d1), subsub, { product: "ledger-report", maxAmount: "80000" });
  assert.equal(pay(c, [d1, d2]).verdict, "cosign");
  c.revoke(delegationId(d1));
  assert.equal(reason(pay(c, [d1, d2])), "sub-mandate 1 was cancelled");
  assert.equal(reason(pay(c, [d1])), "sub-mandate 1 was cancelled");
  assert.equal(pay(c, []).verdict, "cosign", "the parent agent itself, under the user's request, is unaffected");
  c.revoke(requestId(root));
  assert.equal(reason(pay(c, [])), "the user cancelled this task");
});

test("only the named delegate may delegate further; only registered agents may start a chain", () => {
  const c = cosigner();
  const d1 = link(KEYS.agent, requestId(root), sub, { product: "ledger-report", maxAmount: "160000" });
  assert.equal(reason(pay(c, [d1, link(outsider, delegationId(d1), subsub, { product: "ledger-report", maxAmount: "80000" })])), "sub-mandate 2 was signed by a key that may not delegate here");
  assert.equal(reason(pay(c, [link(outsider, requestId(root), sub, { product: "ledger-report", maxAmount: "80000" })])), "sub-mandate 1 was signed by a key that may not delegate here");
});

test("links must chain and be genuine: wrong parent, forged signature, too deep", () => {
  const c = cosigner();
  const p = requestId(root);
  assert.equal(reason(pay(c, [link(KEYS.agent, "00".repeat(32), sub, { product: "ledger-report", maxAmount: "80000" })])), "sub-mandate 1 does not point at its parent");
  const d1 = link(KEYS.agent, p, sub, { product: "ledger-report", maxAmount: "80000" });
  const forged = { ...d1, delegation: { ...d1.delegation, fields: { ...d1.delegation.fields, maxAmount: "240000" } } };
  assert.equal(reason(pay(c, [forged])), "sub-mandate 1 signature is invalid");
  const keys = [sub, subsub, outsider, KEYS.agent2];
  const chain: SignedDelegation[] = [];
  let by = KEYS.agent;
  let parent = p;
  for (const k of keys) {
    const l = link(by, parent, k, { product: "ledger-report", maxAmount: "80000" });
    chain.push(l);
    parent = delegationId(l);
    by = k;
  }
  assert.equal(reason(pay(c, chain)), "delegation deeper than 3");
});
