/**
 * ACAN demo merchant: a paid API protected by the standard x402 Express
 * middleware, settled in USDC on Stellar testnet.
 *
 * Nothing here is ACAN-specific: any x402 client can pay it. That is the
 * point. ACAN agents pay from a guarded smart account, merchants need no
 * changes.
 *
 * FACILITATOR=public (default) uses the Coinbase-operated facilitator at
 * x402.org. FACILITATOR=local runs the same @x402/stellar facilitator code
 * in-process, paying fees from FACILITATOR_SECRET. Smart-account payments
 * need local mode: the public facilitator's 50,000-stroop fee ceiling and its
 * "only transfer events" rule both reject them (see packages/core/src/facilitator.ts).
 */
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { createEd25519Signer } from "@x402/stellar";
import {
  SmartAccountAwareFacilitator,
  TESTNET,
  TabFacilitatorScheme,
  TabLedger,
  TabServerScheme,
  loadEnv,
  requireEnv,
  tabToJson,
  usdcToStroops,
} from "@acan/core";
import { CONFIDENTIAL_TESTNET, ConfidentialAccount, MerchantInbox } from "@acan/confidential";

loadEnv();

const PORT = Number(process.env.MERCHANT_PORT ?? 4021);
const PAY_TO = requireEnv("MERCHANT_ADDRESS");
const PRICE = process.env.PRICE_USD ?? "$0.01";
const MODE = (process.env.FACILITATOR ?? "public").toLowerCase();

function facilitatorClient() {
  if (MODE === "local") {
    const signer = createEd25519Signer(requireEnv("FACILITATOR_SECRET"), TESTNET.x402Network);
    const fac = new x402Facilitator().register(
      TESTNET.x402Network,
      new SmartAccountAwareFacilitator([signer], {
        rpcConfig: { url: TESTNET.rpcUrl },
        // A smart-account payment runs the account's __check_auth, the
        // Ed25519 verifier and the stateful spending-limit policy, so its
        // simulated resource fee (~0.23 XLM on testnet, mostly refundable
        // rent/write budget) is far above the public facilitator's 50,000
        // stroop ceiling. This facilitator allows up to 1 XLM by default.
        maxTransactionFeeStroops: Number(process.env.FACILITATOR_MAX_FEE_STROOPS ?? 10_000_000),
      }),
    );
    return fac as unknown as HTTPFacilitatorClient;
  }
  return new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL ?? TESTNET.facilitatorUrl });
}

const app = express();

const INSIGHTS = [
  "Stellar closes a ledger roughly every 5 seconds.",
  "x402 uses HTTP status 402 (Payment Required) to ask a client for payment.",
  "Soroban auth lets a payer and a fee-sponsor be different accounts.",
  "Settling a tab in one transfer costs one network fee instead of one per request.",
];
let served = 0;

// ---- Milestone B: private route paid with tab vouchers + confidential settlement ----
const PRIVATE_PRICE = process.env.PRIVATE_PRICE_USD ?? "$0.01";
const CREDIT_LIMIT = usdcToStroops(process.env.TAB_CREDIT_LIMIT_USDC ?? "0.03");
const PRIVATE_ENABLED = Boolean(process.env.MERCHANT_CT_SK);
let tabFacilitator: TabFacilitatorScheme | undefined;
let tabLedger: TabLedger | undefined;

if (PRIVATE_ENABLED) {
  const merchantCt = new ConfidentialAccount({
    secret: requireEnv("MERCHANT_SECRET"),
    ctSecretHex: requireEnv("MERCHANT_CT_SK"),
    statePath: `.acan/ct-${PAY_TO}.json`,
  });
  tabLedger = new TabLedger(".acan/merchant-tabs.json");
  tabFacilitator = new TabFacilitatorScheme(tabLedger, new MerchantInbox(merchantCt), PAY_TO);
  const fac = new x402Facilitator().register(TESTNET.x402Network, tabFacilitator);
  app.use(express.json());
  app.use(
    paymentMiddlewareFromConfig(
      {
        "GET /api/insight-private": {
          accepts: { scheme: "acan-tab", price: PRIVATE_PRICE, network: TESTNET.x402Network, payTo: PAY_TO },
          description: "One market insight, paid on a tab settled confidentially",
        },
      },
      fac as unknown as HTTPFacilitatorClient,
      [
        {
          network: TESTNET.x402Network,
          server: new TabServerScheme({
            confidentialToken: CONFIDENTIAL_TESTNET.contracts.token,
            underlying: CONFIDENTIAL_TESTNET.contracts.underlying,
            decimals: CONFIDENTIAL_TESTNET.decimals,
            creditLimit: CREDIT_LIMIT,
            tabUrl: "/tab",
          }),
        },
      ],
    ),
  );
}

/** A payer's tab as the merchant sees it (unpaid, read-only). */
app.get("/tab/:payer", (req, res) => {
  if (!tabLedger) return void res.status(404).json({ error: "private route not enabled" });
  res.json(tabToJson(tabLedger.get(req.params.payer)));
});

/** Report a confidential settlement made outside a paid request (closing a tab). */
app.post("/tab/settle", async (req, res) => {
  if (!tabFacilitator) return void res.status(404).json({ error: "private route not enabled" });
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

app.get("/", (_req, res) => {
  res.json({
    name: "ACAN demo merchant",
    paidRoute: "GET /api/insight",
    price: PRICE,
    network: TESTNET.x402Network,
    payTo: PAY_TO,
    facilitator: MODE,
    privateRoute: PRIVATE_ENABLED
      ? { route: "GET /api/insight-private", scheme: "acan-tab", price: PRIVATE_PRICE, creditLimit: CREDIT_LIMIT.toString() }
      : "disabled (run npm run ct:setup)",
  });
});

app.use(
  paymentMiddlewareFromConfig(
    {
      "GET /api/insight": {
        accepts: { scheme: "exact", price: PRICE, network: TESTNET.x402Network, payTo: PAY_TO },
        description: "One market insight",
      },
    },
    facilitatorClient(),
    [{ network: TESTNET.x402Network, server: new ExactStellarServer() }],
  ),
);

const serveInsight = (_req: express.Request, res: express.Response) => {
  const insight = INSIGHTS[served++ % INSIGHTS.length];
  res.json({ insight, servedAt: new Date().toISOString() });
};
app.get("/api/insight", serveInsight);
app.get("/api/insight-private", serveInsight);

app.listen(PORT, (err?: Error) => {
  // Express 5 reports listen errors (e.g. port already in use) through this callback.
  if (err) {
    console.error(`MERCHANT FAILED TO START on port ${PORT}: ${err.message}`);
    console.error(`Another process is using it. Stop it with:  lsof -ti tcp:${PORT} | xargs kill`);
    process.exit(1);
  }
  console.log(`ACAN merchant on http://localhost:${PORT}  (price ${PRICE}, facilitator: ${MODE})`);
  console.log(`Paid route: http://localhost:${PORT}/api/insight  ->  pays ${PAY_TO}`);
  if (PRIVATE_ENABLED) {
    console.log(
      `Private route: http://localhost:${PORT}/api/insight-private  (acan-tab, ${PRIVATE_PRICE}, ` +
        `settle every ${process.env.TAB_CREDIT_LIMIT_USDC ?? "0.03"} USDC, confidentially)`,
    );
  } else {
    console.log("Private route disabled: run `npm run ct:setup` first.");
  }
});
