/**
 * The confidential-token client SDK, vendored from
 * brozorec/stellar-confidential-token-demo (MIT) under vendor/ctd-demo.
 * Build it once with `npm run ct:build` (see the README).
 *
 * The SDK has its own @stellar/stellar-sdk copy; ACAN never passes XDR
 * objects between the two, only strings and bigints.
 */
export * from "../../../vendor/ctd-demo/packages/sdk/dist/index.js";
export { JsonFileStore } from "../../../vendor/ctd-demo/packages/sdk/dist/state/json-store.js";
export { loadCircuit } from "../../../vendor/ctd-demo/packages/sdk/dist/proving/artifacts.js";
