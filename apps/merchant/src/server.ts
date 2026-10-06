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
 * in-process, paying fees from FACILITATOR_SECRET (useful if the public
 * facilitator's fee ceiling rejects smart-account payments).
 */
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { ExactStellarScheme as ExactStellarFacilitator } from "@x402/stellar/exact/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import { TESTNET, loadEnv, requireEnv } from "@acan/core";

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
      new ExactStellarFacilitator([signer], {
        rpcConfig: { url: TESTNET.rpcUrl },
        // Smart-account auth (verifier + policy calls) costs more than a
        // plain G-account transfer; allow up to 0.05 XLM per settlement.
        maxTransactionFeeStroops: 500_000,
      }),
    );
    return fac as unknown as HTTPFacilitatorClient;
  }
  return new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL ?? TESTNET.facilitatorUrl });
}

const app = express();

const INSIGHTS = [
  "USDC liquidity on Stellar testnet is deepest between 12:00 and 16:00 UTC.",
  "Average x402 settlement on Stellar took ~5 seconds in this session.",
  "Agents that batch requests pay less in total fees.",
  "Soroban auth lets a payer and a fee-sponsor be different accounts.",
];
let served = 0;

app.get("/", (_req, res) => {
  res.json({
    name: "ACAN demo merchant",
    paidRoute: "GET /api/insight",
    price: PRICE,
    network: TESTNET.x402Network,
    payTo: PAY_TO,
    facilitator: MODE,
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

app.get("/api/insight", (_req, res) => {
  const insight = INSIGHTS[served++ % INSIGHTS.length];
  res.json({ insight, servedAt: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`ACAN merchant on http://localhost:${PORT}  (price ${PRICE}, facilitator: ${MODE})`);
  console.log(`Paid route: http://localhost:${PORT}/api/insight  ->  pays ${PAY_TO}`);
});
