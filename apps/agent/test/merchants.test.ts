import { test } from "node:test";
import assert from "node:assert/strict";
import { merchantPins, merchantUrls, purchaseUrl } from "../src/merchants.js";

test("merchant list and pins come from the environment", () => {
  assert.deepEqual(merchantUrls({}), ["http://localhost:4021", "http://localhost:4022"]);
  assert.deepEqual(merchantUrls({ MERCHANT_URLS: "https://a.example/, https://b.example" }), ["https://a.example", "https://b.example"]);
  const pins = merchantPins({ MERCHANT_ADDRESS: "GA", MERCHANT_B_ADDRESS: "GB", MERCHANT_PINS: "https://x.example/=GX" });
  assert.equal(pins.get("http://localhost:4021"), "GA");
  assert.equal(pins.get("http://localhost:4022"), "GB");
  assert.equal(pins.get("https://x.example"), "GX");
  // Custom merchant lists do not inherit the demo pins.
  assert.equal(merchantPins({ MERCHANT_URLS: "https://a.example", MERCHANT_ADDRESS: "GA" }).size, 0);
});

test("purchase requests from a model are checked", () => {
  const urls = ["http://localhost:4021"];
  assert.deepEqual(purchaseUrl(urls, "http://localhost:4021/", "/api/balance", "?account=GABC"), {
    ok: true,
    merchant: "http://localhost:4021",
    path: "/api/balance",
    url: "http://localhost:4021/api/balance?account=GABC",
  });
  assert.equal(purchaseUrl(urls, "http://evil.example", "/api/x").ok, false);
  assert.equal(purchaseUrl(urls, urls[0], "/admin").ok, false);
  assert.equal(purchaseUrl(urls, urls[0], "/api/../x").ok, false);
  assert.equal(purchaseUrl(urls, urls[0], "/api/x", "a=1#frag").ok, false);
});
