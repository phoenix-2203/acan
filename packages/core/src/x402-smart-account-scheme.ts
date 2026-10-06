import { Address, TransactionBuilder, contract, nativeToScVal } from "@stellar/stellar-sdk";
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
    validateRequirements(paymentRequirements);

    const payer = this.signer.smartAccount;
    const { network, payTo, asset, amount, extra, maxTimeoutSeconds } = paymentRequirements;
    if (!extra?.areFeesSponsored) {
      throw new Error("Exact scheme requires areFeesSponsored to be true");
    }

    const networkPassphrase = getNetworkPassphrase(network);
    if (networkPassphrase !== this.signer.networkPassphrase) {
      throw new Error(`Network mismatch: server asked for ${network}, signer is for another network`);
    }
    const rpcUrl = getRpcUrl(network, this.rpcConfig);
    const rpcServer = getRpcClient(network, this.rpcConfig);
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

    // Sign the smart account's auth entry in place (same pattern the SDK's
    // own signAuthEntries uses: the decoded op shares the envelope's array).
    const op = tx.built!.operations[0] as unknown as { auth?: any[] };
    const authEntries = op.auth ?? [];
    let signed = 0;
    for (const [i, entry] of authEntries.entries()) {
      if (entryAddress(entry) !== payer) continue;
      authEntries[i] = await this.signer.signEntry(entry, maxLedger);
      signed++;
    }
    if (signed !== 1) throw new Error(`Expected exactly one auth entry for ${payer}, signed ${signed}`);

    // Re-simulate in enforcing mode: this runs the account's __check_auth,
    // including the spending-limit policy. Over-limit payments fail here,
    // before anything is sent to the merchant.
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
    // facilitator pays fees, so the inner fee is set to 1 stroop to stay
    // under the facilitator's fee ceiling. Soroban resource data is kept.
    const built = tx.built!;
    const sorobanData = built.toEnvelope().v1()?.tx()?.ext()?.sorobanData();
    const finalXdr = sorobanData
      ? TransactionBuilder.cloneFrom(built, { fee: "1", sorobanData, networkPassphrase }).build().toXDR()
      : built.toXDR();

    return { x402Version, payload: { transaction: finalXdr } };
  }
}

/** Raised when the smart account's own rules refuse a payment. */
export class PaymentRejectedError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PaymentRejectedError";
  }
}

/**
 * Known OpenZeppelin smart-account contract error codes
 * (smart-account-kit CONTRACT_ERROR_REGISTRY: SpendingLimit 3220-3227).
 */
const KNOWN_CODES: Record<number, string> = {
  3221: "SpendingLimitExceeded: the agent's allowance for this period is used up",
};

export function describeSimulationError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const m = text.match(/Error\(Contract, #(\d+)\)/);
  if (m) {
    const code = Number(m[1]);
    return KNOWN_CODES[code] ?? `Contract error #${code}`;
  }
  return text.split("\n")[0].slice(0, 300);
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
