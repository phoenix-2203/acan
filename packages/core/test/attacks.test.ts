/**
 * Regression tests for published attacks on x402, run against an ACAN
 * merchant stack (standard x402 Express middleware + ACAN's facilitator,
 * acan-tab scheme and merchant guards).
 *
 *   [I3]  cross-resource substitution        arXiv 2605.30998 (Free-Riding in the AI Economy)
 *   [I4]  service duplication by concurrency arXiv 2605.30998
 *   [II]  replay across the HTTP-chain gap   arXiv 2605.11781 (Five Attacks on x402)
 *   [III] paid content leaking via caches    arXiv 2605.11781
 *   [I1]  deliver-before-settle (free ride)  arXiv 2605.30998 / 2605.11781 attack I-A
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { HTTPFacilitatorClient } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  paymentIdentifierResourceServerExtension,
} from "@x402/extensions/payment-identifier";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { PaymentIdempotency, tabRequestBinding } from "../src/merchant-guards.js";
import { attachPaymentIdentifier, fetchPaid } from "../src/payment-id.js";
import { TabClientScheme, TabFacilitatorScheme, TabLedger, TabServerScheme } from "../src/tab/index.js";

const NETWORK = "stellar:testnet";
const TOKEN = StrKey.encodeContract(hash(Buffer.from("confidential-usdc")));
const USDC = StrKey.encodeContract(hash(Buffer.from("usdc")));
const LIMIT = 10_000_000n; // 1 USDC of credit: never forces a settlement in these tests

/** A facilitator whose settle step fails, as when the chain or RPC refuses. */
class FailingSettleTab extends TabFacilitatorScheme {
  override async settle(_p: PaymentPayload, r: PaymentRequirements) {
    return { success: false, errorReason: "settlement_failed", errorMessage: "rpc down", transaction: "", network: r.network };
  }
}

async function merchant(opts: { guards: boolean; failSettle?: boolean }) {
  const payee = Keypair.random().publicKey();
  const ledger = new TabLedger();
  const inbox = { lookup: async () => null };
  const Scheme = opts.failSettle ? FailingSettleTab : TabFacilitatorScheme;
  const fac = new x402Facilitator().register(NETWORK, new Scheme(ledger, inbox, payee));
  const server = new x402ResourceServer(fac as unknown as HTTPFacilitatorClient)
    .register(NETWORK, new TabServerScheme({ confidentialToken: TOKEN, underlying: USDC, decimals: 7, creditLimit: LIMIT }))
    .registerExtension(paymentIdentifierResourceServerExtension);
  const route = (description: string) => ({
    accepts: [{ scheme: "acan-tab", price: "$0.01", network: NETWORK, payTo: payee }],
    description,
    extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) },
  });
  const counts = { cheap: 0, secret: 0 };
  const app = express();
  const idem = new PaymentIdempotency();
  if (opts.guards) {
    app.use(tabRequestBinding());
    app.use(idem.middleware());
  }
  app.use(paymentMiddleware({ "GET /cheap": route("cheap"), "GET /secret": route("secret") }, server));
  app.get("/cheap", async (_req, res) => {
    counts.cheap++;
    await new Promise((r) => setTimeout(r, 30)); // a handler that takes a moment
    res.json({ item: "cheap", n: counts.cheap });
  });
  app.get("/secret", (_req, res) => {
    counts.secret++;
    res.json({ item: "secret" });
  });
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, ledger, counts, idem, close: () => srv.close() };
}

function payer() {
  const vault = Keypair.random();
  const scheme = new TabClientScheme({
    vault,
    confidentialToken: TOKEN,
    settler: { settle: async () => "0".repeat(64) },
  });
  const client = new x402Client().register("stellar:*", scheme);
  const http = new x402HTTPClient(client);
  /** A signed payment header for `url`, optionally with a payment identifier. */
  async function pay(url: string, withId = true) {
    const first = await fetch(url);
    assert.equal(first.status, 402);
    const required = http.getPaymentRequiredResponse((n) => first.headers.get(n));
    scheme.setResource(url);
    const payload = await client.createPaymentPayload(required);
    const id = withId ? attachPaymentIdentifier(payload, required) : null;
    return { headers: http.encodePaymentSignatureHeader(payload), id };
  }
  return { vault, scheme, http, pay };
}

test("[I3] a voucher signed for one resource is refused for another of the same price", async () => {
  for (const guards of [false, true]) {
    const m = await merchant({ guards });
    try {
      const p = payer();
      const { headers } = await p.pay(`${m.base}/cheap`);
      const stolen = await fetch(`${m.base}/secret`, { headers });
      if (guards) {
        assert.equal(stolen.status, 400);
        assert.equal((await stolen.json()).error, "acan_tab_resource_mismatch");
        assert.equal(m.counts.secret, 0);
        // The voucher still works where it was meant to be used.
        assert.equal((await fetch(`${m.base}/cheap`, { headers })).status, 200);
      } else {
        // Without the guard, plain x402 matching (scheme, network, price,
        // payee) accepts it: this is the attack the guard closes.
        assert.equal(stolen.status, 200);
      }
    } finally {
      m.close();
    }
  }
});

test("[I4] concurrent copies of one payment run the handler once", async () => {
  for (const guards of [false, true]) {
    const m = await merchant({ guards });
    try {
      const p = payer();
      const { headers } = await p.pay(`${m.base}/cheap`, false);
      const results = await Promise.all(Array.from({ length: 10 }, () => fetch(`${m.base}/cheap`, { headers })));
      const statuses = results.map((r) => r.status);
      // Either way only one copy is paid for and delivered...
      assert.equal(statuses.filter((s) => s === 200).length, 1, `statuses: ${statuses}`);
      assert.equal(m.ledger.get(p.vault.publicKey()).nonce, 1);
      if (guards) {
        assert.equal(m.counts.cheap, 1);
      } else {
        // ...but stock middleware runs the handler for every copy that
        // passed verification before the first one settled.
        assert.ok(m.counts.cheap > 1, `handler ran ${m.counts.cheap} times`);
      }
    } finally {
      m.close();
    }
  }
});

test("[II] a retry after a lost response is replayed, not charged again or refused", async () => {
  const m = await merchant({ guards: true });
  try {
    const p = payer();
    const { headers, id } = await p.pay(`${m.base}/cheap`);
    assert.ok(id && id.startsWith("acan_"));
    const first = await fetch(`${m.base}/cheap`, { headers });
    assert.equal(first.status, 200);
    const body = await first.json(); // pretend this never reached the agent
    const retry = await fetchPaid(`${m.base}/cheap`, headers);
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get("x-acan-replay"), "1");
    assert.deepEqual(await retry.json(), body);
    assert.ok(retry.headers.get("payment-response"), "the receipt is replayed too");
    assert.equal(m.counts.cheap, 1, "handler ran once");
    assert.equal(m.ledger.get(p.vault.publicKey()).owed, 100_000n, "charged once");
  } finally {
    m.close();
  }
});

test("[II] without the guard, the same retry is refused even though it was paid", async () => {
  const m = await merchant({ guards: false });
  try {
    const p = payer();
    const { headers } = await p.pay(`${m.base}/cheap`);
    assert.equal((await fetch(`${m.base}/cheap`, { headers })).status, 200);
    assert.equal((await fetch(`${m.base}/cheap`, { headers })).status, 402);
  } finally {
    m.close();
  }
});

test("[II] a payment identifier reused for a different payment is refused", async () => {
  const m = await merchant({ guards: true });
  try {
    const p = payer();
    const a = await p.pay(`${m.base}/cheap`);
    assert.equal((await fetch(`${m.base}/cheap`, { headers: a.headers })).status, 200);
    p.scheme.commit({ success: true, transaction: "tab:x:1", network: NETWORK, payer: p.vault.publicKey() } as any);
    // A second, different payment that reuses the first one's identifier.
    const first = await fetch(`${m.base}/cheap`);
    const required = p.http.getPaymentRequiredResponse((n) => first.headers.get(n));
    const payload = await new x402Client().register("stellar:*", p.scheme).createPaymentPayload(required);
    attachPaymentIdentifier(payload, required, a.id!);
    const r = await fetch(`${m.base}/cheap`, { headers: p.http.encodePaymentSignatureHeader(payload) });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, "payment_identifier_conflict");
  } finally {
    m.close();
  }
});

test("[III] paid responses are marked private so shared caches do not store them", async () => {
  const m = await merchant({ guards: true });
  try {
    const p = payer();
    const { headers } = await p.pay(`${m.base}/cheap`);
    const r = await fetch(`${m.base}/cheap`, { headers });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control") ?? "", /private|no-store/);
  } finally {
    m.close();
  }
});

test("[I1] when settlement fails, the handler's output is withheld (no free ride)", async () => {
  const m = await merchant({ guards: true, failSettle: true });
  try {
    const p = payer();
    const { headers } = await p.pay(`${m.base}/secret`);
    const r = await fetch(`${m.base}/secret`, { headers });
    assert.equal(r.status, 402);
    assert.doesNotMatch(await r.text(), /secret/);
    // The failed attempt is not cached: nothing to replay.
    assert.equal(m.idem.size, 0);
  } finally {
    m.close();
  }
});
