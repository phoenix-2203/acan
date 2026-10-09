/**
 * Agents hiring agents: a chain of narrowing sub-mandates.
 *
 * The user signs a request (their device key). An agent the guardian
 * registered may hand part of it to a sub-agent: it signs a sub-mandate that
 * points at the request by hash and can only narrow it (same item and
 * merchant if those were set, a smaller budget, an earlier expiry). That
 * sub-agent may do the same, up to a fixed depth. Sub-agents get no key on the
 * smart account: their payments still go through the gated rule, and the
 * co-signer signs only if the whole chain checks out, every link's budget
 * still has room, and no link (or the request itself) was cancelled.
 * Cancelling one link cancels everything below it at the next payment.
 */
import { Buffer } from "buffer";
import { Keypair, hash } from "@stellar/stellar-sdk";
import { canonicalRequestJson, requestDigest, type SignedRequest } from "./request.js";

export const DELEGATION_DOMAIN = "acan-provenance-delegation-v1";
export const MAX_DELEGATION_DEPTH = 3;
/** Fields a sub-mandate must keep equal when its parent set them. */
export const NARROWED_FIELDS = ["product", "merchant", "to"] as const;

export interface Delegation {
  /** Id of the parent: the request (requestId) or the previous sub-mandate (delegationId). */
  parent: string;
  /** The sub-agent's key (G...): the only key that may delegate further from here. */
  delegate: string;
  /** What the sub-agent is for, in words (informational). */
  task: string;
  /** Narrowed fields; maxAmount (atomic units) is required. */
  fields: Record<string, string>;
  nonce: string;
  issuedAt: number;
  ttlSeconds: number;
}

export interface SignedDelegation {
  delegation: Delegation;
  /** Who delegated (G...). */
  signer: string;
  /** Hex ed25519 signature over delegationDigest. */
  signature: string;
}

export function delegationDigest(d: Delegation): Buffer {
  return hash(Buffer.from(`${DELEGATION_DOMAIN}\n${canonicalRequestJson(d)}`, "utf8"));
}

export function requestId(r: SignedRequest): string {
  return requestDigest(r.request).toString("hex");
}

export function delegationId(d: SignedDelegation): string {
  return delegationDigest(d.delegation).toString("hex");
}

export function signDelegation(by: Keypair, d: Delegation): SignedDelegation {
  return { delegation: d, signer: by.publicKey(), signature: Buffer.from(by.sign(delegationDigest(d))).toString("hex") };
}

export interface ChainResult {
  ok: true;
  /** The fields that bind the payment: the last link's (or the request's). */
  fields: Record<string, string>;
  /** Budget keys from the root down, with each one's maxAmount. */
  budgets: { key: string; max: bigint }[];
}

/**
 * Check a chain of sub-mandates under a user's request. `agentKeys` are the
 * keys allowed to delegate first (the guardian's registered agents).
 */
export function checkChain(
  request: SignedRequest,
  chain: SignedDelegation[],
  opts: { agentKeys: string[]; now: number; revoked: ReadonlySet<string> },
): ChainResult | { ok: false; reason: string } {
  const r = request.request;
  const rootId = requestId(request);
  if (opts.revoked.has(rootId)) return { ok: false, reason: "the user cancelled this task" };
  if (chain.length > MAX_DELEGATION_DEPTH) return { ok: false, reason: `delegation deeper than ${MAX_DELEGATION_DEPTH}` };
  const budgets = [{ key: rootId, max: BigInt(r.fields.maxAmount) }];
  let parentId = rootId;
  let fields = r.fields;
  let expiry = r.issuedAt + r.ttlSeconds;
  let allowed = new Set(opts.agentKeys);
  for (const [i, link] of chain.entries()) {
    const d = link.delegation;
    const id = delegationId(link);
    const name = `sub-mandate ${i + 1}`;
    if (!allowed.has(link.signer)) return { ok: false, reason: `${name} was signed by a key that may not delegate here` };
    let sigOk = false;
    try {
      sigOk = Keypair.fromPublicKey(link.signer).verify(delegationDigest(d), Buffer.from(link.signature, "hex"));
    } catch {
      sigOk = false;
    }
    if (!sigOk) return { ok: false, reason: `${name} signature is invalid` };
    if (d.parent !== parentId) return { ok: false, reason: `${name} does not point at its parent` };
    if (opts.revoked.has(id)) return { ok: false, reason: `${name} was cancelled` };
    const max = d.fields.maxAmount;
    if (!max || !/^\d+$/.test(max)) return { ok: false, reason: `${name} has no maxAmount` };
    if (BigInt(max) > BigInt(fields.maxAmount)) return { ok: false, reason: `${name} asks for more than its parent allows` };
    for (const k of NARROWED_FIELDS) {
      if (fields[k] !== undefined && d.fields[k] !== fields[k]) return { ok: false, reason: `${name} changes “${k}”, which its parent fixed` };
    }
    for (const k of Object.keys(d.fields)) {
      if (k !== "maxAmount" && !(NARROWED_FIELDS as readonly string[]).includes(k)) return { ok: false, reason: `${name} adds an unknown field “${k}”` };
    }
    const end = d.issuedAt + d.ttlSeconds;
    if (end > expiry) return { ok: false, reason: `${name} outlives its parent` };
    if (opts.now < d.issuedAt || opts.now > end) return { ok: false, reason: `${name} expired` };
    budgets.push({ key: id, max: BigInt(max) });
    parentId = id;
    fields = d.fields;
    expiry = end;
    allowed = new Set([d.delegate]);
  }
  return { ok: true, fields, budgets };
}
