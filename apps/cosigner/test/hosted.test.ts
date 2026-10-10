/**
 * The hosted co-signer for the demo site: registration is checked against the
 * rule as read from the chain (a fake reader here), and each registered rule
 * gets its own co-signer with the rule's agent keys and allowed shops.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";
import { cancelMessage, createHostedCosigner, type ChainRule } from "../src/hosted.js";
import { ACCOUNT, CATALOG, KEYS, NOW, PASSPHRASE, PLANS, RULE_ID, SOUTHGATE, NORTHWIND, TOKEN, TRANSCRIPT, VERIFIER, entryFor, request } from "../../../research/prototype/src/scenario.js";

const GATE = "CDFMTQUF5EKXKCXXXN2UYZUXM2CUYMIHXNTJQF33ZNR2OAHWMYFRIOLP";
const MERCHANT_POLICY = "CA2PF5JJR2IO6B6IZ5RDYD2WWZ3DEFQSKY4OJJ4JTNMKNQB6PVY3J2FG";
const hex = (k: Keypair) => Buffer.from(k.rawPublicKey()).toString("hex");

async function setup(rule: Partial<ChainRule> = {}, recipients = [SOUTHGATE, NORTHWIND]) {
  const chainRule: ChainRule = {
    signers: rule.signers ?? [
      { verifier: VERIFIER, key: hex(KEYS.agent) },
      { verifier: VERIFIER, key: hex(KEYS.cosigner) },
    ],
    policies: rule.policies ?? [GATE, MERCHANT_POLICY],
  };
  const srv = createHostedCosigner({
    secret: KEYS.cosigner.secret(),
    token: TOKEN,
    networkPassphrase: PASSPHRASE,
    ed25519Verifier: VERIFIER,
    gatePolicy: GATE,
    merchantPolicy: MERCHANT_POLICY,
    readRule: async (account, ruleId) => {
      if (account !== ACCOUNT || ruleId !== RULE_ID) throw new Error("no such rule");
      return chainRule;
    },
    readRecipients: async () => recipients,
    catalogFor: (allowed) => CATALOG.filter((c) => !allowed || allowed.includes(c.payTo)),
    allowedOrigins: ["https://acan-demo.duckdns.org"],
    now: () => NOW,
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, origin?: string) => {
    const res = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json(), cors: res.headers.get("access-control-allow-origin") };
  };
  return { srv, url, post };
}

const target = { account: ACCOUNT, ruleId: RULE_ID };

test("registration needs the co-signer's own key and the gate policy on the rule, read from the chain", async () => {
  for (const [rule, why] of [
    [{ signers: [{ verifier: VERIFIER, key: hex(KEYS.agent) }] }, /not a signer/],
    [{ policies: [MERCHANT_POLICY] }, /no provenance gate/],
    [{ signers: [{ verifier: VERIFIER, key: hex(KEYS.cosigner) }] }, /no agent key/],
  ] as const) {
    const { srv, post } = await setup(rule);
    try {
      const r = await post("/register", { ...target, deviceKey: KEYS.device.publicKey() });
      assert.equal(r.status, 403);
      assert.match(r.body.error, why);
    } finally {
      srv.close();
    }
  }
  const { srv, post } = await setup();
  try {
    assert.equal((await post("/register", { account: ACCOUNT, ruleId: 99, deviceKey: KEYS.device.publicKey() })).status, 404);
  } finally {
    srv.close();
  }
});

test("a registered rule: the clean task is co-signed, the steered one held, another device key refused", async () => {
  const { srv, post } = await setup();
  try {
    const reg = await post("/register", { ...target, deviceKey: KEYS.device.publicKey() }, "https://acan-demo.duckdns.org");
    assert.equal(reg.status, 200);
    assert.equal(reg.cors, "https://acan-demo.duckdns.org");
    assert.deepEqual(reg.body.agentKeys, [KEYS.agent.publicKey()]);
    // Same device again is fine; a different one is refused (first registration wins).
    assert.equal((await post("/register", { ...target, deviceKey: KEYS.device.publicKey() })).status, 200);
    assert.equal((await post("/register", { ...target, deviceKey: KEYS.stranger.publicKey() })).status, 409);

    const clean = await post("/review", {
      ...target,
      request: request({ product: "ledger-report", maxAmount: "100000" }),
      plan: PLANS.clean,
      transcript: {},
      payIndex: 0,
      authEntry: entryFor(SOUTHGATE, 80_000n).toXDR("base64"),
    });
    assert.equal(clean.body.verdict, "cosign");
    const sig = Buffer.from(clean.body.signature.signature, "hex");
    assert.ok(Keypair.fromPublicKey(KEYS.cosigner.publicKey()).verify(Buffer.from(clean.body.digest, "hex"), sig));

    const steered = await post("/review", {
      ...target,
      request: request({ maxAmount: "300000" }),
      plan: PLANS.steered,
      transcript: TRANSCRIPT,
      payIndex: 0,
      authEntry: entryFor(NORTHWIND, 250_000n).toXDR("base64"),
    });
    assert.equal(steered.body.verdict, "escalate");
    assert.ok(steered.body.why.some((w: string) => w.includes("news.example")));
  } finally {
    srv.close();
  }
});

test("the price book is limited to the rule's allowed shops (read from the merchant policy)", async () => {
  const { srv, post } = await setup({}, [NORTHWIND]);
  try {
    assert.equal((await post("/register", { ...target, deviceKey: KEYS.device.publicKey() })).body.items, 3);
    // Southgate is not allowed on this rule, so its (cheaper) report is not in the book.
    const r = await post("/review", {
      ...target,
      request: request({ product: "ledger-report", maxAmount: "100000" }),
      plan: PLANS.clean,
      transcript: {},
      payIndex: 0,
      authEntry: entryFor(SOUTHGATE, 80_000n).toXDR("base64"),
    });
    assert.notEqual(r.body.verdict, "cosign");
  } finally {
    srv.close();
  }
});

test("reviews need a registration; cancels need the device key's signature", async () => {
  const { srv, url, post } = await setup();
  try {
    const before = await post("/review", { ...target, request: {}, plan: [], transcript: {}, payIndex: 0, authEntry: "" });
    assert.equal(before.status, 404);
    await post("/register", { ...target, deviceKey: KEYS.device.publicKey() });
    const id = "abc123";
    const forged = Buffer.from(KEYS.stranger.sign(cancelMessage(ACCOUNT, RULE_ID, id))).toString("hex");
    assert.equal((await post("/cancel", { ...target, id, signature: forged })).status, 403);
    const real = Buffer.from(KEYS.device.sign(cancelMessage(ACCOUNT, RULE_ID, id))).toString("hex");
    assert.equal((await post("/cancel", { ...target, id, signature: real })).status, 200);
    const spent = await (await fetch(`${url}/spent?account=${ACCOUNT}&ruleId=${RULE_ID}&id=${id}`)).json();
    assert.equal(spent.spent, "0");
  } finally {
    srv.close();
  }
});
