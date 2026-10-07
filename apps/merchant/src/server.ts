/**
 * ACAN demo merchant: paid data APIs protected by the standard x402 Express
 * middleware, settled on Stellar testnet.
 *
 * Two merchant profiles with different prices run from this file, so an agent
 * has a real choice to make:
 *   npm run merchant     profile "a", Northwind Data, port 4021
 *   npm run merchant:b   profile "b", Southgate Data, port 4022
 *
 * Every paid route accepts two x402 schemes:
 *   exact     a USDC transfer per request (any x402 Stellar client can pay)
 *   acan-tab  a signed voucher per request, settled in batches by
 *             confidential transfer (needs `npm run ct:setup`)
 *
 * FACILITATOR=local (the default here) runs the facilitator in-process,
 * paying fees from FACILITATOR_SECRET. Smart-account payers need it: the
 * public facilitator's 50,000-stroop fee ceiling and "only transfer events"
 * rule both reject them (see packages/core/src/facilitator.ts).
 * FACILITATOR=public uses x402.org for `exact` only.
 */
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  paymentIdentifierResourceServerExtension,
} from "@x402/extensions/payment-identifier";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { createEd25519Signer } from "@x402/stellar";
import { rpc } from "@stellar/stellar-sdk";
import { StrKey } from "@stellar/stellar-sdk";
import {
  PaymentIdempotency,
  SmartAccountAwareFacilitator,
  TESTNET,
  TabFacilitatorScheme,
  TabLedger,
  TabServerScheme,
  loadEnv,
  requireEnv,
  tabRequestBinding,
  stroopsToUsdc,
  tabToJson,
  tokenBalance,
  usdcToStroops,
} from "@acan/core";
import { CONFIDENTIAL_TESTNET, ConfidentialAccount, MerchantInbox } from "@acan/confidential";

loadEnv();

interface Product {
  path: string;
  description: string;
  price: string;
}

const PROFILES = {
  a: {
    name: "Northwind Data",
    env: "MERCHANT",
    port: 4021,
    tabs: ".acan/merchant-tabs.json",
    products: [
      { path: "/api/insight", description: "One short fact about Stellar or x402", price: "$0.01" },
      { path: "/api/ledger", description: "Latest Stellar testnet ledger: sequence and protocol version", price: "$0.01" },
      { path: "/api/balance", description: "USDC balance of a Stellar account (?account=G... or C...)", price: "$0.02" },
    ],
  },
  b: {
    name: "Southgate Data",
    env: "MERCHANT_B",
    port: 4022,
    tabs: ".acan/merchant-b-tabs.json",
    products: [
      { path: "/api/insight", description: "One short fact about Stellar or x402", price: "$0.02" },
      { path: "/api/ledger", description: "Latest Stellar testnet ledger: sequence and protocol version", price: "$0.005" },
      { path: "/api/balance", description: "USDC balance of a Stellar account (?account=G... or C...)", price: "$0.03" },
    ],
  },
} satisfies Record<string, { name: string; env: string; port: number; tabs: string; products: Product[] }>;

const PROFILE_ID = (process.env.MERCHANT_PROFILE ?? "a").toLowerCase() as keyof typeof PROFILES;
const profile = PROFILES[PROFILE_ID];
if (!profile) throw new Error(`Unknown MERCHANT_PROFILE ${PROFILE_ID} (use a or b)`);

const PORT = Number(process.env[`${profile.env}_PORT`] ?? profile.port);
const PAY_TO = requireEnv(`${profile.env}_ADDRESS`);
const MODE = (process.env.FACILITATOR ?? "local").toLowerCase();
const CREDIT_LIMIT = usdcToStroops(process.env.TAB_CREDIT_LIMIT_USDC ?? "0.03");
const CT_SK = process.env[`${profile.env}_CT_SK`];
const PRIVATE_ENABLED = MODE === "local" && Boolean(CT_SK);

let tabFacilitator: TabFacilitatorScheme | undefined;
let tabLedger: TabLedger | undefined;

function facilitatorClient(): HTTPFacilitatorClient {
  if (MODE !== "local") {
    return new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL ?? TESTNET.facilitatorUrl });
  }
  const signer = createEd25519Signer(requireEnv("FACILITATOR_SECRET"), TESTNET.x402Network);
  const fac = new x402Facilitator().register(
    TESTNET.x402Network,
    new SmartAccountAwareFacilitator([signer], {
      rpcConfig: { url: TESTNET.rpcUrl },
      // A smart-account payment runs __check_auth, the Ed25519 verifier and
      // the stateful spending-limit policy: its simulated resource fee (~0.23
      // XLM on testnet, mostly refundable) is far above the public
      // facilitator's 50,000-stroop ceiling. Allow up to 1 XLM by default.
      maxTransactionFeeStroops: Number(process.env.FACILITATOR_MAX_FEE_STROOPS ?? 10_000_000),
    }),
  );
  if (PRIVATE_ENABLED) {
    const merchantCt = new ConfidentialAccount({
      secret: requireEnv(`${profile.env}_SECRET`),
      ctSecretHex: CT_SK!,
      statePath: `.acan/ct-${PAY_TO}.json`,
    });
    tabLedger = new TabLedger(profile.tabs);
    tabFacilitator = new TabFacilitatorScheme(tabLedger, new MerchantInbox(merchantCt), PAY_TO);
    fac.register(TESTNET.x402Network, tabFacilitator);
  }
  return fac as unknown as HTTPFacilitatorClient;
}

const app = express();
app.use(express.json());
const facilitator = facilitatorClient();

const accepts = (price: string) => [
  { scheme: "exact", price, network: TESTNET.x402Network, payTo: PAY_TO },
  ...(PRIVATE_ENABLED ? [{ scheme: "acan-tab", price, network: TESTNET.x402Network, payTo: PAY_TO }] : []),
];

// Every paid route declares the x402 payment-identifier extension, so a
// client can retry a paid request safely (see PaymentIdempotency below).
const extensions = { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) };
const routes: Record<string, { accepts: ReturnType<typeof accepts>; description: string; extensions: typeof extensions }> =
  Object.fromEntries(
    profile.products.map((p) => [`GET ${p.path}`, { accepts: accepts(p.price), description: p.description, extensions }]),
  );
// Backwards-compatible alias used by earlier versions of the private agent.
routes["GET /api/insight-private"] = {
  accepts: accepts(profile.products[0].price).filter((a) => a.scheme === "acan-tab"),
  description: profile.products[0].description,
  extensions,
};
if (!PRIVATE_ENABLED) delete routes["GET /api/insight-private"];

/** Free catalog: what this merchant sells and at what price. */
app.get("/", (_req, res) => {
  res.json({
    name: profile.name,
    network: TESTNET.x402Network,
    payTo: PAY_TO,
    schemes: PRIVATE_ENABLED ? ["exact", "acan-tab"] : ["exact"],
    creditLimitUsdc: PRIVATE_ENABLED ? stroopsToUsdc(CREDIT_LIMIT) : undefined,
    products: profile.products,
  });
});

/** A payer's tab as the merchant sees it (unpaid, read-only). */
app.get("/tab/:payer", (req, res) => {
  if (!tabLedger) return void res.status(404).json({ error: "private payments not enabled" });
  res.json(tabToJson(tabLedger.get(req.params.payer)));
});

/** Report a confidential settlement made outside a paid request (closing a tab). */
app.post("/tab/settle", async (req, res) => {
  if (!tabFacilitator) return void res.status(404).json({ error: "private payments not enabled" });
  const { payer, txHash } = (req.body ?? {}) as { payer?: string; txHash?: string };
  if (typeof payer !== "string" || typeof txHash !== "string") {
    return void res.status(400).json({ error: "body must be {payer, txHash}" });
  }
  try {
    res.json(tabToJson(await tabFacilitator.creditSettlement(payer, txHash)));
  } catch (e) {
    res.status(422).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Guards in front of the x402 middleware (packages/core/src/merchant-guards.ts):
// a voucher only pays for the URL it was signed for, and one payment is
// served once (retries get the stored response, concurrent copies wait).
app.use(tabRequestBinding());
app.use(new PaymentIdempotency().middleware());

const resourceServer = new x402ResourceServer(facilitator)
  .register(TESTNET.x402Network, new ExactStellarServer())
  .registerExtension(paymentIdentifierResourceServerExtension);
if (PRIVATE_ENABLED) {
  resourceServer.register(
    TESTNET.x402Network,
    new TabServerScheme({
      confidentialToken: CONFIDENTIAL_TESTNET.contracts.token,
      underlying: CONFIDENTIAL_TESTNET.contracts.underlying,
      decimals: CONFIDENTIAL_TESTNET.decimals,
      creditLimit: CREDIT_LIMIT,
      tabUrl: "/tab",
    }),
  );
}
app.use(paymentMiddleware(routes, resourceServer));

// ---- the data products (served only after payment) ----

const INSIGHTS = [
  "Stellar closes a ledger roughly every 5 seconds.",
  "x402 uses HTTP status 402 (Payment Required) to ask a client for payment.",
  "Soroban auth lets a payer and a fee-sponsor be different accounts.",
  "Settling a tab in one transfer costs one network fee instead of one per request.",
];
let served = 0;
const insight = (_req: express.Request, res: express.Response) => {
  res.json({ merchant: profile.name, insight: INSIGHTS[served++ % INSIGHTS.length], servedAt: new Date().toISOString() });
};
app.get("/api/insight", insight);
app.get("/api/insight-private", insight);

const server = new rpc.Server(TESTNET.rpcUrl);
app.get("/api/ledger", async (_req, res) => {
  try {
    const l = await server.getLatestLedger();
    res.json({ merchant: profile.name, network: "testnet", sequence: l.sequence, protocolVersion: l.protocolVersion });
  } catch (e) {
    res.status(502).json({ error: `RPC unavailable: ${e instanceof Error ? e.message : e}` });
  }
});

app.get("/api/balance", async (req, res) => {
  const account = String(req.query.account ?? "");
  if (!StrKey.isValidEd25519PublicKey(account) && !StrKey.isValidContract(account)) {
    return void res.status(400).json({ error: "pass ?account=G... or C..." });
  }
  try {
    const bal = await tokenBalance(account);
    res.json({ merchant: profile.name, account, asset: "USDC", balance: stroopsToUsdc(bal) });
  } catch (e) {
    res.status(502).json({ error: `lookup failed: ${e instanceof Error ? e.message : e}` });
  }
});

app.listen(PORT, (err?: Error) => {
  // Express 5 reports listen errors (e.g. port already in use) through this callback.
  if (err) {
    console.error(`MERCHANT FAILED TO START on port ${PORT}: ${err.message}`);
    console.error(`Another process is using it. Stop it with:  lsof -ti tcp:${PORT} | xargs kill`);
    process.exit(1);
  }
  console.log(`${profile.name} (merchant ${PROFILE_ID}) on http://localhost:${PORT}  facilitator: ${MODE}`);
  console.log(`pays to ${PAY_TO}`);
  for (const p of profile.products) console.log(`  GET ${p.path.padEnd(14)} ${p.price.padEnd(7)} ${p.description}`);
  console.log(
    PRIVATE_ENABLED
      ? `schemes: exact + acan-tab (settle every ${stroopsToUsdc(CREDIT_LIMIT)} USDC, confidentially)`
      : "schemes: exact only (run `npm run ct:setup` for private payments)",
  );
});
