import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import type { HTTPFacilitatorClient } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import {
  TabClientScheme,
  TabFacilitatorScheme,
  TabLedger,
  TabServerScheme,
  applyVoucher,
  signVoucher,
  verifyVoucherSignature,
  voucherShapeError,
  type ReceivedSettlement,
  type TabVoucher,
} from "../src/tab/index.js";

const NETWORK = "stellar:testnet";
const TOKEN = StrKey.encodeContract(hash(Buffer.from("confidential-usdc")));
const USDC = StrKey.encodeContract(hash(Buffer.from("usdc")));
const PRICE = 100_000n; // 0.01 USDC
const LIMIT = 300_000n; // 0.03 USDC

const voucher = (payer: Keypair, payee: string, nonce: number, cumulative: bigint): TabVoucher => ({
  v: 1,
  network: NETWORK,
  token: TOKEN,
  payer: payer.publicKey(),
  payee,
  nonce,
  amount: PRICE.toString(),
  cumulative: cumulative.toString(),
  resource: "http://x/api",
  issuedAt: Math.floor(Date.now() / 1000),
});

test("voucher signatures bind every field", () => {
  const payer = Keypair.random();
  const v = voucher(payer, Keypair.random().publicKey(), 1, PRICE);
  const sig = signVoucher(v, payer);
  assert.equal(voucherShapeError(v), null);
  assert.ok(verifyVoucherSignature(v, sig));
  assert.ok(!verifyVoucherSignature({ ...v, amount: "1" }, sig));
  assert.ok(!verifyVoucherSignature({ ...v, payer: Keypair.random().publicKey() }, sig));
  assert.throws(() => signVoucher(v, Keypair.random()));
  assert.match(voucherShapeError({ ...v, extra: 1 }) ?? "", /unexpected/);
});

test("ledger enforces nonce chain, cumulative and credit limit", () => {
  const payer = Keypair.random();
  const payee = Keypair.random().publicKey();
  let s = new TabLedger().get(payer.publicKey());
  for (let n = 1; n <= 3; n++) {
    const v = voucher(payer, payee, n, PRICE * BigInt(n));
    const r = applyVoucher(s, v, signVoucher(v, payer), LIMIT);
    assert.ok(r.ok, `voucher ${n}`);
    s = r.next;
  }
  const v4 = voucher(payer, payee, 4, PRICE * 4n);
  const over = applyVoucher(s, v4, signVoucher(v4, payer), LIMIT);
  assert.equal(over.ok, false);
  assert.equal(!over.ok && over.reason, "acan_tab_settlement_required");

  const replay = voucher(payer, payee, 3, PRICE * 4n);
  const r2 = applyVoucher(s, replay, "", LIMIT);
  assert.equal(!r2.ok && r2.reason, "acan_tab_nonce_mismatch");

  const settled = applyVoucher(s, v4, signVoucher(v4, payer), LIMIT, { tx: "a".repeat(64), amount: PRICE * 3n });
  assert.ok(settled.ok);
  assert.equal(settled.ok && settled.next.settled, PRICE * 3n);
  // The same settlement cannot be credited twice.
  const v5 = voucher(payer, payee, 5, PRICE * 5n);
  const again = applyVoucher(settled.ok ? settled.next : s, v5, "", LIMIT, { tx: "a".repeat(64), amount: PRICE * 3n });
  assert.ok(again.ok && again.next.settled === PRICE * 3n);
});

test("x402 end to end: vouchers per request, one settlement per credit window", async () => {
  const merchant = Keypair.random().publicKey();
  const vault = Keypair.random();
  const chain = new Map<string, ReceivedSettlement>();
  let txCounter = 0;

  // Fake confidential rail: the settler "sends" a transfer the inbox can decrypt.
  const settler = {
    async settle(payee: string, amount: bigint) {
      const tx = hash(Buffer.from(`tx${txCounter++}`)).toString("hex");
      chain.set(tx, { tx, from: vault.publicKey(), to: payee, amount });
      return tx;
    },
  };
  const inbox = { async lookup(tx: string) { return chain.get(tx) ?? null; } };

  const ledger = new TabLedger();
  const facilitator = new x402Facilitator().register(NETWORK, new TabFacilitatorScheme(ledger, inbox, merchant));
  const app = express();
  app.use(
    paymentMiddlewareFromConfig(
      { "GET /paid": { accepts: { scheme: "acan-tab", price: "$0.01", network: NETWORK, payTo: merchant }, description: "t" } },
      facilitator as unknown as HTTPFacilitatorClient,
      [{ network: NETWORK, server: new TabServerScheme({ confidentialToken: TOKEN, underlying: USDC, decimals: 7, creditLimit: LIMIT }) }],
    ),
  );
  app.get("/paid", (_req, res) => {
    res.json({ ok: true });
  });
  const srv = app.listen(0);
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/paid`;

  try {
    const events: string[] = [];
    const scheme = new TabClientScheme({
      vault,
      confidentialToken: TOKEN,
      settler,
      onEvent: (e) => events.push(`${e.kind}:${e.amount}`),
    });
    const client = new x402Client().register("stellar:*", scheme);
    const http = new x402HTTPClient(client);

    for (let i = 1; i <= 7; i++) {
      const first = await fetch(url);
      assert.equal(first.status, 402);
      const required = http.getPaymentRequiredResponse((n) => first.headers.get(n));
      assert.equal(required.accepts[0].extra.creditLimit, LIMIT.toString());
      const payload = await client.createPaymentPayload(required);
      const paid = await fetch(url, { headers: http.encodePaymentSignatureHeader(payload) });
      assert.equal(paid.status, 200, `request ${i}: ${paid.headers.get("PAYMENT-REQUIRED") ?? ""}`);
      scheme.commit(http.getPaymentSettleResponse((n) => paid.headers.get(n)));
    }
    // 7 requests at 0.01 with a 0.03 limit: settle 0.03 before #4 and before #7.
    assert.deepEqual(events, ["settling:300000", "settled:300000", "settling:300000", "settled:300000"]);
    const tab = ledger.get(vault.publicKey());
    assert.equal(tab.nonce, 7);
    assert.equal(tab.owed, PRICE * 7n);
    assert.equal(tab.settled, PRICE * 6n);
    assert.equal(tab.credited.length, 2);
    assert.equal(scheme.tab(merchant).settled, PRICE * 6n);

    // A replayed payment header is refused.
    const first = await fetch(url);
    const required = http.getPaymentRequiredResponse((n) => first.headers.get(n));
    const payload = await client.createPaymentPayload(required);
    const header = http.encodePaymentSignatureHeader(payload);
    assert.equal((await fetch(url, { headers: header })).status, 200);
    assert.equal((await fetch(url, { headers: header })).status, 402);

    // A settlement sent by someone else is not credited to this tab.
    const mallory = Keypair.random();
    const fake = hash(Buffer.from("fake")).toString("hex");
    chain.set(fake, { tx: fake, from: mallory.publicKey(), to: merchant, amount: 10n ** 9n });
    const fac = new TabFacilitatorScheme(ledger, inbox, merchant);
    await assert.rejects(fac.creditSettlement(vault.publicKey(), fake), /not the tab's payer/);
  } finally {
    srv.close();
  }
});
