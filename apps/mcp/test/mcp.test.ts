import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import type { HTTPFacilitatorClient } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { createEd25519Signer } from "@x402/stellar";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SmartAccountAwareFacilitator } from "@acan/core";

const NETWORK = "stellar:testnet";
const SERVER = fileURLToPath(new URL("../src/server.ts", import.meta.url));

test("MCP server: tools, input checks, and a redirected payTo refused before signing", async () => {
  const known = Keypair.random().publicKey();
  const attacker = Keypair.random().publicKey();
  const fac = new x402Facilitator().register(
    NETWORK,
    new SmartAccountAwareFacilitator([createEd25519Signer(Keypair.random().secret(), NETWORK)]),
  );
  const app = express();
  app.get("/", (_req, res) => void res.json({ name: "Test Shop", payTo: attacker, products: [{ path: "/api/data", price: "$0.01" }] }));
  app.use(
    paymentMiddlewareFromConfig(
      { "GET /api/data": { accepts: [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: attacker }], description: "d" } },
      fac as unknown as HTTPFacilitatorClient,
      [{ network: NETWORK, server: new ExactStellarServer() }],
    ),
  );
  app.get("/api/data", (_req, res) => void res.json({ ok: true }));
  const srv = app.listen(0);
  const shop = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", SERVER],
    env: {
      ...(process.env as Record<string, string>),
      MERCHANT_URLS: shop,
      MERCHANT_PINS: `${shop}=${known}`,
      SMART_ACCOUNT: StrKey.encodeContract(hash(Buffer.from("account"))),
      AGENT_RULE_ID: "1",
      AGENT_SECRET: Keypair.random().secret(),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["acan_buy", "acan_check_budget", "acan_list_merchants", "acan_request_approval", "acan_settle_tabs"]);

    const listed = await client.callTool({ name: "acan_list_merchants", arguments: {} });
    const list = JSON.parse((listed.content as any)[0].text);
    assert.equal(list[0].name, "Test Shop");
    assert.match(list[0].warning, /payment address changed/);

    const unknown = await client.callTool({ name: "acan_buy", arguments: { merchant: "http://evil.example", path: "/api/data" } });
    assert.equal(unknown.isError, true);
    assert.match((unknown.content as any)[0].text, /unknown merchant/);

    const badPath = await client.callTool({ name: "acan_buy", arguments: { merchant: shop, path: "/../admin" } });
    assert.equal(badPath.isError, true);

    const redirected = await client.callTool({ name: "acan_buy", arguments: { merchant: shop, path: "/api/data" } });
    assert.equal(redirected.isError, true);
    const body = JSON.parse((redirected.content as any)[0].text);
    assert.equal(body.status, "refused");
    assert.match(body.reason, /possible payTo redirection/);

    const early = await client.callTool({
      name: "acan_request_approval",
      arguments: { merchant: shop, path: "/api/data", reason: "need it" },
    });
    assert.equal(early.isError, true);
    assert.match((early.content as any)[0].text, /only allowed after acan_buy was blocked/);
  } finally {
    await client.close();
    srv.close();
  }
});
