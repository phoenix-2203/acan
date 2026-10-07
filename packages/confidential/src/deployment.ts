/**
 * ACAN's confidential-token deployment on Stellar testnet.
 *
 * Deployed with the vendored demo's scripts/deploy.ts (patched so the
 * confidential token wraps testnet USDC instead of native XLM):
 *   CTD_UNDERLYING=<USDC SAC> pnpm deploy:contracts
 * The verifier checks UltraHonk proofs on-chain; every account registers
 * under auditor id 0, whose secret the guardian holds (CT_AUDITOR_SECRET).
 */
export const CONFIDENTIAL_TESTNET = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  deployedAtLedger: 5057317,
  contracts: {
    token: "CDQGQI53TCGCOH7JQ33RWDWMKMADM4CUKLAMB5EEELW4EVNETCZYOLQI",
    verifier: "CA74E63TKFAKKT3J5F63GGSDFVRIO7QBWPNKEVBBJMJBAEHOXM4U25NO",
    auditor: "CAYSSVT3KWNBKMIAMTCDFUTD6GJWL5EJT6TKQCVJQEDBCA5DQBHJNRH4",
    /** Testnet USDC SAC (the public token being wrapped). */
    underlying: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  },
  auditorId: 0,
  /** Same decimals as the underlying USDC. */
  decimals: 7,
} as const;
