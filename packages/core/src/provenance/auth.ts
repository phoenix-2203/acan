/**
 * Soroban authorization helpers for a rule with more than one signer.
 *
 * The co-signer never signs a digest it is handed: it takes the whole
 * authorization entry, decodes what it really does, and computes the signature
 * payload itself, exactly as the network will.
 */
import { Buffer } from "buffer";
import { Address, buildAuthorizationEntryPreimage, hash, scValToNative, xdr } from "@stellar/stellar-sdk";
import { buildAuthDigest } from "../agent-signer.js";



function addressCredentials(entry: xdr.SorobanAuthorizationEntry) {
  const c = entry.credentials();
  switch (c.switch().name) {
    case "sorobanCredentialsAddress":
      return c.address();
    case "sorobanCredentialsAddressV2":
      return c.addressV2();
    case "sorobanCredentialsAddressWithDelegates":
      return c.addressWithDelegates().addressCredentials();
    default:
      throw new Error(`not an address credential: ${c.switch().name}`);
  }
}

/** sha256 of the HashIdPreimage the network checks, from the entry's own nonce and expiration. */
export function signaturePayloadOf(entry: xdr.SorobanAuthorizationEntry, networkPassphrase: string): Buffer {
  const creds = addressCredentials(entry);
  const preimage = buildAuthorizationEntryPreimage(entry, creds.signatureExpirationLedger(), networkPassphrase);
  return hash(preimage.toXDR());
}

export interface DecodedTransfer {
  /** Address whose authorization this entry carries. */
  account: string;
  contract: string;
  fn: string;
  from: string;
  to: string;
  amount: bigint;
  subInvocations: number;
  expirationLedger: number;
}

/** What the entry really authorizes (never what the requester says it does). */
export function decodeTransfer(entry: xdr.SorobanAuthorizationEntry): DecodedTransfer {
  const creds = addressCredentials(entry);
  const root = entry.rootInvocation();
  const f = root.function();
  if (f.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") throw new Error("not a contract call");
  const call = f.contractFn();
  const args = call.args();
  if (args.length !== 3) throw new Error(`expected 3 arguments, got ${args.length}`);
  const amount = scValToNative(args[2]);
  if (typeof amount !== "bigint") throw new Error("amount is not an integer");
  return {
    account: Address.fromScAddress(creds.address()).toString(),
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    fn: call.functionName().toString(),
    from: String(scValToNative(args[0])),
    to: String(scValToNative(args[1])),
    amount,
    subInvocations: root.subInvocations().length,
    expirationLedger: creds.signatureExpirationLedger(),
  };
}

export interface ExternalSignature {
  verifier: string;
  /** 32-byte ed25519 public key */
  publicKey: Buffer;
  /** 64-byte signature over the auth digest */
  signature: Buffer;
}

function signerKey(s: ExternalSignature): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(s.verifier).toScAddress()),
    xdr.ScVal.scvBytes(s.publicKey),
  ]);
}

/**
 * `AuthPayload { context_rule_ids, signers }` with several signers. The host
 * rejects a map whose keys are not in its sort order. For External signers that
 * share a verifier, the keys differ only in the 32-byte key, so they sort by
 * those bytes (fixed length, so a byte compare is the host order).
 */
export function authPayloadMulti(contextRuleIds: number[], sigs: ExternalSignature[]): xdr.ScVal {
  const verifiers = new Set(sigs.map((s) => s.verifier));
  if (verifiers.size !== 1) throw new Error("this helper sorts same-verifier signers only");
  for (const s of sigs) {
    if (s.publicKey.length !== 32) throw new Error("public key must be 32 bytes");
    if (s.signature.length !== 64) throw new Error("signature must be 64 bytes");
  }
  const sorted = [...sigs].sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].publicKey.equals(sorted[i].publicKey)) throw new Error("duplicate signer");
  }
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap(sorted.map((s) => new xdr.ScMapEntry({ key: signerKey(s), val: xdr.ScVal.scvBytes(s.signature) }))),
    }),
  ]);
}

/** A copy of the entry with the combined signature attached. */
export function withSignature(entry: xdr.SorobanAuthorizationEntry, signature: xdr.ScVal): xdr.SorobanAuthorizationEntry {
  const copy = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  addressCredentials(copy).signature(signature);
  return copy;
}

/** Build an unsigned `token.transfer(from, to, amount)` entry for `from` (tests and demos). */
export function transferEntry(opts: {
  account: string;
  token: string;
  to: string;
  amount: bigint;
  nonce: bigint;
  expirationLedger: number;
  fn?: string;
  from?: string;
  subInvocations?: xdr.SorobanAuthorizedInvocation[];
}): xdr.SorobanAuthorizationEntry {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(opts.token).toScAddress(),
        functionName: opts.fn ?? "transfer",
        args: [
          Address.fromString(opts.from ?? opts.account).toScVal(),
          Address.fromString(opts.to).toScVal(),
          xdr.ScVal.scvI128(
            new xdr.Int128Parts({
              hi: xdr.Int64.fromString((opts.amount >> 64n).toString()),
              lo: xdr.Uint64.fromString((opts.amount & 0xffffffffffffffffn).toString()),
            }),
          ),
        ],
      }),
    ),
    subInvocations: opts.subInvocations ?? [],
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(opts.account).toScAddress(),
        nonce: xdr.Int64.fromString(opts.nonce.toString()),
        signatureExpirationLedger: opts.expirationLedger,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation,
  });
}
