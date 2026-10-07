import { Keypair, contract, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { ASSETS, TESTNET } from "./config.js";
import { SmartAccountAgentSigner, entryAddress } from "./agent-signer.js";
import { PaymentRejectedError, describeSimulationError } from "./x402-smart-account-scheme.js";

/**
 * Move tokens out of the guardian's smart account using the agent's key.
 *
 * The transfer is authorized exactly like an x402 payment: the agent signs the
 * smart account's auth entry under its context rule, so the account's
 * spending-limit policy is enforced on-chain. `source` is a classic account
 * that only pays the network fee and sequence number.
 *
 * Throws {@link PaymentRejectedError} when the smart account refuses (for
 * example, the allowance for the period is used up).
 */
export async function smartAccountTransfer(opts: {
  signer: SmartAccountAgentSigner;
  source: Keypair;
  to: string;
  amount: bigint;
  token?: string;
  rpcUrl?: string;
}): Promise<string> {
  const { signer, source, to, amount } = opts;
  const token = opts.token ?? ASSETS.usdc.sac;
  const rpcUrl = opts.rpcUrl ?? TESTNET.rpcUrl;
  const networkPassphrase = signer.networkPassphrase;
  if (amount <= 0n) throw new Error("amount must be positive");

  const tx = await contract.AssembledTransaction.build({
    contractId: token,
    method: "transfer",
    args: [
      nativeToScVal(signer.smartAccount, { type: "address" }),
      nativeToScVal(to, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ],
    networkPassphrase,
    rpcUrl,
    publicKey: source.publicKey(),
    parseResultXdr: (r) => r,
  });
  if (rpc.Api.isSimulationError(tx.simulation!)) {
    throw new PaymentRejectedError(describeSimulationError(tx.simulation.error));
  }

  const latest = await new rpc.Server(rpcUrl).getLatestLedger();
  const expiration = latest.sequence + 60; // ~5 minutes

  const op = tx.built!.operations[0] as unknown as { auth?: any[] };
  const auth = op.auth ?? [];
  let signed = 0;
  for (const [i, entry] of auth.entries()) {
    if (entryAddress(entry) !== signer.smartAccount) continue;
    auth[i] = await signer.signEntry(entry, expiration);
    signed++;
  }
  if (signed !== 1) throw new Error(`Expected one smart-account auth entry, signed ${signed}`);

  // Enforcing simulation: runs __check_auth and the spending-limit policy.
  await tx.simulate();
  if (rpc.Api.isSimulationError(tx.simulation!)) {
    throw new PaymentRejectedError(describeSimulationError(tx.simulation.error));
  }

  const sent = await tx.signAndSend({
    signTransaction: contract.basicNodeSigner(source, networkPassphrase).signTransaction,
  });
  const hash = sent.sendTransactionResponse?.hash;
  if (!hash) throw new Error("Transfer was not submitted");
  return hash;
}
