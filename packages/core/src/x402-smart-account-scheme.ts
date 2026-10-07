import { Address, TransactionBuilder, contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  findDefaultAsset,
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  handleSimulationResult,
  isStellarNetwork,
  validateStellarAssetAddress,
  validateStellarDestinationAddress,
  type RpcConfig,
} from "@x402/stellar";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { SmartAccountAgentSigner, entryAddress } from "./agent-signer.js";
import { PaymentRejectedError, describeSimulationError } from "./errors.js";

// Error decoding lives in a browser-safe module; re-exported for existing imports.
export { PaymentRejectedError, describeSimulationError, contractErrorCode } from "./errors.js";

/**
 * x402 "exact" scheme client for payers that are OpenZeppelin smart accounts.
 *
 * Produces exactly the same payload as @x402/stellar's ExactStellarScheme
 * client (a SEP-41 `transfer(from, to, amount)` invocation with a signed
 * address-credential auth entry, fees left to the facilitator), so any
 * standard x402 Stellar facilitator can verify and settle it.
 *
 * The only difference is how the payer's auth entry is signed. The stock
 * client signs with the default Ed25519 authorizer, which cannot sign for a
 * C-address. Here the entry is signed with an OZ `AuthPayload` built by
 * {@link SmartAccountAgentSigner}, so the account's context rule and its
 * spending-limit policy are enforced on-chain at settlement.
 */
export class SmartAccountExactStellarScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  /** Lets x402Client's spend controls recognise USDC as a default asset. */
  readonly findDefaultAsset = findDefaultAsset;

  constructor(
    private readonly signer: SmartAccountAgentSigner,
    private readonly rpcConfig?: RpcConfig,
  ) {}

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    if (getNetworkPassphrase(paymentRequirements.network) !== this.signer.networkPassphrase) {
      throw new Error(`Network mismatch: server asked for ${paymentRequirements.network}, signer is for another network`);
    }
    const prepared = await prepareSmartAccountPayment(this.signer.smartAccount, paymentRequirements, this.rpcConfig);
    const signed = await this.signer.signEntry(prepared.entry(), prepared.maxLedger);
    const transaction = await prepared.finalize(signed);
    return { x402Version, payload: { transaction } };
  }
}

/**
 * An x402 "exact" payment from a smart account, built and simulated but not
 * yet authorized. `entry()` is the smart account's unsigned auth entry; sign
 * it (agent key, or the guardian's passkey for an approved one-off payment)
 * and pass it to `finalize()` to get the payload transaction XDR.
 */
export interface PreparedSmartAccountPayment {
  maxLedger: number;
  entry(): xdr.SorobanAuthorizationEntry;
  finalize(signedEntry: xdr.SorobanAuthorizationEntry): Promise<string>;
}

export async function prepareSmartAccountPayment(
  payer: string,
  paymentRequirements: PaymentRequirements,
  rpcConfig?: RpcConfig,
): Promise<PreparedSmartAccountPayment> {
  validateRequirements(paymentRequirements);
  const { network, payTo, asset, amount, extra, maxTimeoutSeconds } = paymentRequirements;
  if (!extra?.areFeesSponsored) {
    throw new Error("Exact scheme requires areFeesSponsored to be true");
  }
  const networkPassphrase = getNetworkPassphrase(network);
  const rpcUrl = getRpcUrl(network, rpcConfig);
  const rpcServer = getRpcClient(network, rpcConfig);
  const currentLedger = (await rpcServer.getLatestLedger()).sequence;
  const ledgerSeconds = await getEstimatedLedgerCloseTimeSeconds(network);
  const maxLedger = currentLedger + Math.ceil(maxTimeoutSeconds / ledgerSeconds);

  const tx = await contract.AssembledTransaction.build({
    contractId: asset,
    method: "transfer",
    args: [
      nativeToScVal(payer, { type: "address" }),
      nativeToScVal(payTo, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ],
    networkPassphrase,
    rpcUrl,
    parseResultXdr: (result) => result,
  });
  handleSimulationResult(tx.simulation);

  const missing = tx.needsNonInvokerSigningBy();
  if (!missing.includes(payer) || missing.length > 1) {
    throw new Error(`Expected to sign with [${payer}], but got [${missing.join(", ")}]`);
  }
  // The decoded op shares the envelope's auth array (same pattern as the
  // SDK's own signAuthEntries), so entries are replaced in place.
  const op = tx.built!.operations[0] as unknown as { auth?: xdr.SorobanAuthorizationEntry[] };
  const authEntries = op.auth ?? [];
  const index = authEntries.findIndex((e) => entryAddress(e) === payer);
  if (index < 0 || authEntries.filter((e) => entryAddress(e) === payer).length !== 1) {
    throw new Error(`Expected exactly one auth entry for ${payer}`);
  }

  return {
    maxLedger,
    entry: () => authEntries[index],
    async finalize(signedEntry) {
      if (entryAddress(signedEntry) !== payer) throw new Error("Signed entry is not for the payer");
      authEntries[index] = signedEntry;
      // Re-simulate in enforcing mode: this runs the account's __check_auth,
      // including any policy (e.g. the spending limit). A refused payment
      // fails here, before anything is sent to the merchant.
      await tx.simulate();
      try {
        handleSimulationResult(tx.simulation);
      } catch (err) {
        throw new PaymentRejectedError(describeSimulationError(err), err);
      }
      const stillMissing = tx.needsNonInvokerSigningBy();
      if (stillMissing.length > 0) {
        throw new Error(`Unexpected signer(s) required: [${stillMissing.join(", ")}]`);
      }
      // Same adjustment as the official Stellar x402 quickstart client: the
      // facilitator pays fees, so the inner fee is 1 stroop to stay under the
      // facilitator's fee ceiling. Soroban resource data is kept.
      const built = tx.built!;
      const sorobanData = built.toEnvelope().v1()?.tx()?.ext()?.sorobanData();
      return sorobanData
        ? TransactionBuilder.cloneFrom(built, { fee: "1", sorobanData, networkPassphrase }).build().toXDR()
        : built.toXDR();
    },
  };
}

function validateRequirements(req: PaymentRequirements): void {
  const { scheme, network, payTo, asset, amount } = req;
  if (typeof amount !== "string" || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    throw new Error(`Invalid amount: ${amount}. Amount must be a positive integer string.`);
  }
  if (scheme !== "exact") throw new Error(`Unsupported scheme: ${scheme}`);
  if (!isStellarNetwork(network)) throw new Error(`Unsupported Stellar network: ${network}`);
  if (!validateStellarDestinationAddress(payTo)) throw new Error(`Invalid destination: ${payTo}`);
  if (!validateStellarAssetAddress(asset)) throw new Error(`Invalid asset: ${asset}`);
  // Address.fromString throws on malformed addresses; a cheap extra guard.
  Address.fromString(asset);
}
