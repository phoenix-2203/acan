/**
 * The user's request, signed by a key on the user's own device. The agent host
 * relays it but cannot forge or alter it.
 */
import { Buffer } from "buffer";
import { Keypair, hash } from "@stellar/stellar-sdk";

export const REQUEST_DOMAIN = "acan-provenance-request-v1";

export interface UserRequest {
  /** Smart account the request is for. */
  account: string;
  /** Unique per request; the co-signer keeps a budget per nonce. */
  nonce: string;
  /** Unix seconds. */
  issuedAt: number;
  ttlSeconds: number;
  /** What the user typed (signed, informational; not interpreted). */
  task: string;
  /** Structured fields the user confirmed, e.g. product, maxAmount (atomic units). */
  fields: Record<string, string>;
}

export interface SignedRequest {
  request: UserRequest;
  /** Device key, G... form. */
  publicKey: string;
  /** Hex ed25519 signature over requestDigest(request). */
  signature: string;
}

/** JSON with sorted keys at every level, so both sides hash the same bytes. */
export function canonicalRequestJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalRequestJson).join(",")}]`;
  if (x && typeof x === "object") {
    const keys = Object.keys(x as object).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalRequestJson((x as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(x);
}

export function requestDigest(r: UserRequest): Buffer {
  return hash(Buffer.from(`${REQUEST_DOMAIN}\n${canonicalRequestJson(r)}`, "utf8"));
}

export function signRequest(device: Keypair, request: UserRequest): SignedRequest {
  return { request, publicKey: device.publicKey(), signature: Buffer.from(device.sign(requestDigest(request))).toString("hex") };
}

export function verifyRequest(s: SignedRequest): boolean {
  try {
    const sig = Buffer.from(s.signature, "hex");
    if (sig.length !== 64) return false;
    return Keypair.fromPublicKey(s.publicKey).verify(requestDigest(s.request), sig);
  } catch {
    return false;
  }
}
