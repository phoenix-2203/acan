import { Buffer } from "buffer";
import { Address, Keypair, authorizeEntry, hash, xdr } from "@stellar/stellar-sdk";
import { OZ_SMART_ACCOUNT } from "./config.js";

/**
 * Signs Soroban authorization entries on behalf of an OpenZeppelin smart
 * account (C-address) using an agent's Ed25519 key.
 *
 * The OZ smart account (stellar-contracts, Protocol 27+) does not accept a
 * plain Ed25519 signature over the auth payload. Its `__check_auth` expects an
 * `AuthPayload` struct:
 *
 *   AuthPayload {
 *     context_rule_ids: Vec<u32>,         // one rule id per auth context
 *     signers: Map<Signer, Bytes>,        // signer -> signature bytes
 *   }
 *
 * and every signer signs the *auth digest*, which binds the selected context
 * rule ids so a signature cannot be replayed under a weaker rule:
 *
 *   signature_payload = sha256(HashIdPreimage)          // standard Soroban payload
 *   auth_digest       = sha256(signature_payload || scvVec(rule_ids).toXDR())
 *
 * This mirrors smart-account-kit's `computeEntryAuthDigest` / `writeAuthPayload`
 * (stellar/smart-account-kit src/kit/auth-payload.ts), reimplemented here so a
 * headless Node agent can sign without the browser-oriented kit.
 *
 * The agent key is registered on the account as
 * `Signer::External(ed25519_verifier, <32-byte public key>)` on a context rule
 * scoped to the USDC contract, with a spending-limit policy attached.
 */
export interface AgentSignerOptions {
  /** The smart account (C...) that holds the funds. */
  smartAccount: string;
  /** The agent's Ed25519 secret key (S...). */
  agentSecret: string;
  /** Id of the context rule that authorizes this agent. */
  contextRuleId: number;
  networkPassphrase: string;
  /** Ed25519 verifier contract registered on the signer. */
  ed25519Verifier?: string;
}

export class SmartAccountAgentSigner {
  readonly smartAccount: string;
  readonly contextRuleId: number;
  readonly networkPassphrase: string;
  readonly ed25519Verifier: string;
  private readonly keypair: Keypair;

  constructor(opts: AgentSignerOptions) {
    if (!/^C[A-Z2-7]{55}$/.test(opts.smartAccount)) {
      throw new Error(`smartAccount must be a contract address (C...), got ${opts.smartAccount}`);
    }
    if (!Number.isInteger(opts.contextRuleId) || opts.contextRuleId < 0) {
      throw new Error(`contextRuleId must be a non-negative integer, got ${opts.contextRuleId}`);
    }
    this.smartAccount = opts.smartAccount;
    this.contextRuleId = opts.contextRuleId;
    this.networkPassphrase = opts.networkPassphrase;
    this.ed25519Verifier = opts.ed25519Verifier ?? OZ_SMART_ACCOUNT.ed25519Verifier;
    this.keypair = Keypair.fromSecret(opts.agentSecret);
  }

  /** The agent key's G-address form (for display only; it holds no funds). */
  get agentAddress(): string {
    return this.keypair.publicKey();
  }

  /** The raw 32-byte Ed25519 public key registered on the smart account. */
  get agentPublicKey(): Buffer {
    return Buffer.from(this.keypair.rawPublicKey());
  }

  /**
   * Sign one authorization entry whose top-level credentials belong to the
   * smart account. Returns a new, signed entry (the input is not mutated).
   */
  async signEntry(
    entry: xdr.SorobanAuthorizationEntry,
    validUntilLedgerSeq: number,
  ): Promise<xdr.SorobanAuthorizationEntry> {
    const credentialAddress = entryAddress(entry);
    if (credentialAddress !== this.smartAccount) {
      throw new Error(
        `Auth entry is for ${credentialAddress}, not the smart account ${this.smartAccount}`,
      );
    }
    return authorizeEntry(
      entry,
      async (_preimage: xdr.HashIdPreimage, payload: Buffer | Uint8Array) => {
        const digest = buildAuthDigest(Buffer.from(payload), [this.contextRuleId]);
        const signature = this.keypair.sign(digest);
        return {
          signatureScVal: buildAuthPayload(
            [this.contextRuleId],
            this.ed25519Verifier,
            this.agentPublicKey,
            signature,
          ),
        };
      },
      validUntilLedgerSeq,
      this.networkPassphrase,
    );
  }
}

/** sha256(signature_payload || scvVec(rule_ids).toXDR()) */
export function buildAuthDigest(signaturePayload: Buffer, contextRuleIds: number[]): Buffer {
  const ruleIdsXdr = xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))).toXDR();
  return hash(Buffer.concat([signaturePayload, ruleIdsXdr]));
}

/**
 * Encode `AuthPayload { context_rule_ids, signers }` as an ScVal map.
 * Map keys must be in host sort order: "context_rule_ids" < "signers".
 * With a single signer the inner map needs no further sorting.
 */
export function buildAuthPayload(
  contextRuleIds: number[],
  verifier: string,
  publicKey: Buffer,
  signature: Buffer,
): xdr.ScVal {
  if (publicKey.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  if (signature.length !== 64) throw new Error("Ed25519 signature must be 64 bytes");
  const signerKey = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(verifier).toScAddress()),
    xdr.ScVal.scvBytes(publicKey),
  ]);
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: signerKey, val: xdr.ScVal.scvBytes(signature) })]),
    }),
  ]);
}

/** Top-level credential address of an auth entry (V1, V2 or with-delegates). */
export function entryAddress(entry: xdr.SorobanAuthorizationEntry): string {
  const creds = entry.credentials();
  switch (creds.switch().name) {
    case "sorobanCredentialsAddress":
      return Address.fromScAddress(creds.address().address()).toString();
    case "sorobanCredentialsAddressV2":
      return Address.fromScAddress(creds.addressV2().address()).toString();
    case "sorobanCredentialsAddressWithDelegates":
      return Address.fromScAddress(creds.addressWithDelegates().addressCredentials().address()).toString();
    default:
      return "";
  }
}
