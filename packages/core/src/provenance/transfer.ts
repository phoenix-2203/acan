import { Buffer } from "buffer";
import { Keypair, contract, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { ASSETS, TESTNET } from "../config.js";
import { SmartAccountAgentSigner, buildAuthDigest, entryAddress } from "../agent-signer.js";
import { PaymentRejectedError, describeSimulationError } from "../errors.js";
import { authPayloadMulti, signaturePayloadOf, withSignature, type ExternalSignature } from "./auth.js";

/** The co-signer said no: why, in plain words. Nothing was submitted. */
export class ProvenanceEscalation extends Error {
  constructor(readonly why: string[], readonly verdict: "escalate" | "reject") {
    super(verdict === "escalate" ? `Not co-signed: ${why.join("; ")}` : `Co-signer refused: ${why.join("; ")}`);
    this.name = "ProvenanceEscalation";
  }
}

/** Given the unsigned auth entry (base64 XDR, expiration already set), return the co-signature or say why not. */
export type CosignFn = (authEntry: string) => Promise<{ ok: true; signature: ExternalSignature } | { ok: false; verdict: "escalate" | "reject"; why: string[] }>;

/**
 * Like smartAccountTransfer, for a provenance-gated rule: the agent and the
 * provenance co-signer both sign the same auth digest. The co-signer sees the
 * exact entry first and may refuse; then nothing is signed or sent.
 */
export async function gatedSmartAccountTransfer(opts: {
  signer: SmartAccountAgentSigner;
  source: Keypair;
  to: string;
  amount: bigint;
  cosign: CosignFn;
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
    throw new PaymentRejectedError(describeSimulationError(tx.simulation.error), tx.simulation.error);
  }
  const latest = await new rpc.Server(rpcUrl).getLatestLedger();
  const expiration = latest.sequence + 60;

  const op = tx.built!.operations[0] as unknown as { auth?: xdr.SorobanAuthorizationEntry[] };
  const auth = op.auth ?? [];
  const idx = auth.findIndex((e) => entryAddress(e) === signer.smartAccount);
  if (idx < 0 || auth.filter((e) => entryAddress(e) === signer.smartAccount).length !== 1) {
    throw new Error("Expected one smart-account auth entry");
  }
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(auth[idx].toXDR());
  setExpiration(entry, expiration);

  const c = await opts.cosign(entry.toXDR("base64"));
  if (!c.ok) throw new ProvenanceEscalation(c.why, c.verdict);

  const digest = buildAuthDigest(signaturePayloadOf(entry, networkPassphrase), [signer.contextRuleId]);
  const mine: ExternalSignature = { verifier: signer.ed25519Verifier, publicKey: signer.agentPublicKey, signature: signer.signDigest(digest) };
  if (!c.signature.publicKey.length || Buffer.compare(c.signature.publicKey, mine.publicKey) === 0) throw new Error("co-signer key equals the agent key");
  auth[idx] = withSignature(entry, authPayloadMulti([signer.contextRuleId], [mine, c.signature]));

  await tx.simulate();
  if (rpc.Api.isSimulationError(tx.simulation!)) {
    throw new PaymentRejectedError(describeSimulationError(tx.simulation.error), tx.simulation.error);
  }
  const sent = await tx.signAndSend({ signTransaction: contract.basicNodeSigner(source, networkPassphrase).signTransaction });
  const hash = sent.sendTransactionResponse?.hash;
  if (!hash) throw new Error("Transfer was not submitted");
  return hash;
}

export function setExpiration(entry: xdr.SorobanAuthorizationEntry, ledger: number): void {
  const c = entry.credentials();
  switch (c.switch().name) {
    case "sorobanCredentialsAddress":
      c.address().signatureExpirationLedger(ledger);
      return;
    case "sorobanCredentialsAddressV2":
      c.addressV2().signatureExpirationLedger(ledger);
      return;
    case "sorobanCredentialsAddressWithDelegates":
      c.addressWithDelegates().addressCredentials().signatureExpirationLedger(ledger);
      return;
    default:
      throw new Error(`unexpected credentials ${c.switch().name}`);
  }
}
