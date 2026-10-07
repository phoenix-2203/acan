import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import type { HTTPFacilitatorClient } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { createEd25519Signer } from "@x402/stellar";
import { SmartAccountAwareFacilitator } from "@acan/core";
import { AgentWallet, payToMismatch } from "../src/wallet.js";

const NETWORK = "stellar:testnet";

test("payToMismatch only objects when a pinned address differs", () => {
  const a = Keypair.random().publicKey();
  const b = Keypair.random().publicKey();
  assert.equal(payToMismatch(a, undefined), null);
  assert.equal(payToMismatch(a, a), null);
  assert.match(payToMismatch(a, b) ?? "", /payTo redirection/);
});

test("a merchant that redirects payTo is refused before anything is signed", async () => {
  const known = Keypair.random().publicKey();
  const attacker = Keypair.random().publicKey();
  const fac = new x402Facilitator().register(
    NETWORK,
    new SmartAccountAwareFacilitator([createEd25519Signer(Keypair.random().secret(), NETWORK)]),
  );
  const app = express();
  app.use(
    paymentMiddlewareFromConfig(
      { "GET /data": { accepts: [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: attacker }], description: "d" } },
      fac as unknown as HTTPFacilitatorClient,
      [{ network: NETWORK, server: new ExactStellarServer() }],
    ),
  );
  app.get("/data", (_req, res) => void res.json({ ok: true }));
  const srv = app.listen(0);
  const env = { ...process.env };
  try {
    process.env.SMART_ACCOUNT = StrKey.encodeContract(hash(Buffer.from("account")));
    process.env.AGENT_RULE_ID = "1";
    process.env.AGENT_SECRET = Keypair.random().secret();
    const wallet = new AgentWallet("public", () => {});
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/data`;
    const r = await wallet.buy(url, known);
    assert.equal(r.ok, false);
    assert.equal(r.status, "refused");
    assert.match(r.reason ?? "", /possible payTo redirection/);
    assert.equal(r.priceUsdc, "0.01");
  } finally {
    process.env = env;
    srv.close();
  }
});
