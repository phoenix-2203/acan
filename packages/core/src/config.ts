/**
 * Stellar testnet constants used across ACAN.
 *
 * Every contract address below was verified against its upstream source:
 * - USDC SAC: derived from the testnet USDC issuer (GBBD47...LLFLA5) and
 *   identical to `USDC_TESTNET_ADDRESS` exported by @x402/stellar.
 * - OpenZeppelin smart-account contracts: stellar/smart-account-kit
 *   docs/deployments-protocol-27-2026-07-09.md (testnet table).
 * - Relayer proxy: stellar/smart-account-kit demo/.env.example.
 */
export const TESTNET = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  /** CAIP-2 id used by x402 */
  x402Network: "stellar:testnet",
  /** Coinbase-operated public x402 facilitator (supports stellar:testnet). */
  facilitatorUrl: "https://www.x402.org/facilitator",
  /** SDF-hosted relayer proxy used by smart-account-kit for fee sponsoring. */
  relayerUrl: "https://smart-account-relayer-proxy.sdf-ecosystem.workers.dev",
} as const;

export const ASSETS = {
  usdc: {
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    sac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    /** Stellar assets use 7 decimals (1 USDC = 10_000_000 stroops). */
    decimals: 7,
  },
  xlm: {
    sac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    decimals: 7,
  },
} as const;

export const OZ_SMART_ACCOUNT = {
  accountWasmHash: "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a",
  webauthnVerifier: "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F",
  ed25519Verifier: "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4",
  spendingLimitPolicy: "CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G",
  thresholdPolicy: "CB3FATQKCIRIQOCYRUPCQ2KREQ7T4RPKS7EAEOZWPEPUKWEDRVROBCEG",
} as const;

/** Stellar closes a ledger roughly every 5 seconds. */
export const LEDGERS_PER_DAY = 17_280;
export const LEDGERS_PER_HOUR = 720;

/** Convert a human USDC amount ("0.05") to stroops (7 decimals). */
export function usdcToStroops(amount: string | number): bigint {
  const s = String(amount).trim();
  if (!/^\d+(\.\d{1,7})?$/.test(s)) throw new Error(`Invalid USDC amount: ${amount}`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0"));
}

/** Convert stroops to a human-readable USDC string. */
export function stroopsToUsdc(stroops: bigint | number | string): string {
  const v = BigInt(stroops);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
