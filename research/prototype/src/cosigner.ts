/**
 * Provenance co-signer: a deterministic service (no language model) whose
 * signature the smart account requires next to the agent's.
 *
 * It co-signs one payment only when:
 *   - the user's request is genuine (device key), current, and for this account;
 *   - re-running the plan itself shows the payment's recipient, amount and the
 *     path to the payment depend only on the user's request and the guardian's
 *     pinned price book (never on tool, merchant or web content, nor on values
 *     the planner made up);
 *   - the authorization entry is exactly that transfer and nothing else;
 *   - the request's budget is not exceeded.
 * Anything tainted is escalated with the reason; anything inconsistent is
 * rejected. The decision is a pure function of the case and the co-signer's
 * state, so anyone holding the case can re-run it.
 */
import { Buffer } from "buffer";
import { Keypair, hash, xdr } from "@stellar/stellar-sdk";
import { buildAuthDigest, decodeTransfer, signaturePayloadOf, type DecodedTransfer, type ExternalSignature } from "./auth.js";
import { runPlan, untrusted, type PricedItem, type Step } from "./plan.js";
import { canonicalJson, verifyRequest, type SignedRequest } from "./request.js";

export interface CosignerConfig {
  secret: string;
  account: string;
  token: string;
  ruleId: number;
  networkPassphrase: string;
  verifier: string;
  /** Device keys (G...) the guardian registered for the user. */
  deviceKeys: string[];
  /** The guardian's pinned price book. */
  catalog: PricedItem[];
  /** Unix seconds (injectable for tests). */
  now?: () => number;
}

export interface ReviewCase {
  request: SignedRequest;
  plan: Step[];
  transcript: Record<string, string>;
  /** Which `pay` of the plan this entry is for. */
  payIndex: number;
  /** Base64 XDR of the unsigned SorobanAuthorizationEntry. */
  authEntry: string;
}

export type Decision =
  | { verdict: "cosign"; signature: ExternalSignature; digest: string; caseHash: string; transfer: DecodedTransfer }
  | { verdict: "escalate"; why: string[]; caseHash: string; transfer: DecodedTransfer }
  | { verdict: "reject"; reason: string };

const ADDRESS = /^[GC][A-Z2-7]{55}$/;

export class ProvenanceCosigner {
  private readonly key: Keypair;
  private readonly spent = new Map<string, bigint>();
  private readonly signed = new Map<string, Extract<Decision, { verdict: "cosign" }>>();

  constructor(private readonly cfg: CosignerConfig) {
    this.key = Keypair.fromSecret(cfg.secret);
  }

  get publicKey(): Buffer {
    return Buffer.from(this.key.rawPublicKey());
  }

  review(c: ReviewCase): Decision {
    const now = (this.cfg.now ?? (() => Math.floor(Date.now() / 1000)))();

    // 1. The user's request.
    const r = c.request.request;
    if (!this.cfg.deviceKeys.includes(c.request.publicKey)) return reject("request key is not registered for this user");
    if (!verifyRequest(c.request)) return reject("request signature is invalid");
    if (r.account !== this.cfg.account) return reject("request is for another account");
    if (now < r.issuedAt || now > r.issuedAt + r.ttlSeconds) return reject("request expired");
    const max = r.fields.maxAmount;
    if (!max || !/^\d+$/.test(max)) return reject("request has no maxAmount");

    // 2. What the entry really does.
    let entry: xdr.SorobanAuthorizationEntry;
    let t: DecodedTransfer;
    try {
      entry = xdr.SorobanAuthorizationEntry.fromXDR(c.authEntry, "base64");
      t = decodeTransfer(entry);
    } catch (e) {
      return reject(`cannot decode the authorization: ${msg(e)}`);
    }

    // 3. Re-run the plan over the co-signer's own price book.
    let pays;
    try {
      pays = runPlan(c.plan, { request: r.fields, catalog: this.cfg.catalog, transcript: c.transcript });
    } catch (e) {
      return reject(`plan failed: ${msg(e)}`);
    }
    const pay = pays[c.payIndex];
    if (!pay) return reject(`the plan has no payment #${c.payIndex}`);

    // 4. The entry must be exactly that payment.
    if (t.account !== this.cfg.account) return reject("authorization is for another account");
    if (t.contract !== this.cfg.token) return reject("not the configured token");
    if (t.fn !== "transfer") return reject(`not a transfer (${t.fn})`);
    if (t.from !== this.cfg.account) return reject("transfer is not from this account");
    if (t.subInvocations !== 0) return reject("the authorization includes extra calls");
    if (typeof pay.to.v !== "string" || !ADDRESS.test(pay.to.v)) return reject("the plan's recipient is not an address");
    if (typeof pay.amount.v !== "string" || !/^\d+$/.test(pay.amount.v) || BigInt(pay.amount.v) <= 0n) {
      return reject("the plan's amount is not a positive integer");
    }
    if (t.to !== pay.to.v) return reject("recipient differs from the plan");
    if (t.amount !== BigInt(pay.amount.v)) return reject("amount differs from the plan");

    const caseHash = hash(Buffer.from(canonicalJson(c), "utf8")).toString("hex");

    // 5. Provenance.
    const why: string[] = [];
    const toBad = untrusted(pay.to.src);
    const amountBad = untrusted(pay.amount.src);
    const ctxBad = untrusted(pay.ctx);
    if (toBad.length) why.push(`recipient depends on ${toBad.join(", ")}`);
    if (amountBad.length) why.push(`amount depends on ${amountBad.join(", ")}`);
    if (ctxBad.length) why.push(`the decision to pay depends on ${ctxBad.join(", ")}`);
    if (why.length) return { verdict: "escalate", why, caseHash, transfer: t };

    // 6. Idempotent for the same entry; otherwise within the request's budget.
    const entryKey = hash(entry.toXDR()).toString("hex");
    const again = this.signed.get(entryKey);
    if (again) return again;
    const used = this.spent.get(r.nonce) ?? 0n;
    if (used + t.amount > BigInt(max)) return reject("request budget exceeded");

    // 7. Sign the digest the smart account will check, for the configured rule only.
    const payload = signaturePayloadOf(entry, this.cfg.networkPassphrase);
    const digest = buildAuthDigest(payload, [this.cfg.ruleId]);
    const decision: Extract<Decision, { verdict: "cosign" }> = {
      verdict: "cosign",
      signature: { verifier: this.cfg.verifier, publicKey: this.publicKey, signature: Buffer.from(this.key.sign(digest)) },
      digest: digest.toString("hex"),
      caseHash,
      transfer: t,
    };
    this.spent.set(r.nonce, used + t.amount);
    this.signed.set(entryKey, decision);
    return decision;
  }
}

function reject(reason: string): Decision {
  return { verdict: "reject", reason };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

