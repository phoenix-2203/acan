import { Buffer } from "buffer";
import { xdr } from "@stellar/stellar-sdk";
import { SmartAccountAgentSigner, buildAuthDigest, entryAddress, type AgentSignerOptions } from "../agent-signer.js";
import { authPayloadMulti, signaturePayloadOf, withSignature, type ExternalSignature } from "./auth.js";
import { ProvenanceEscalation, setExpiration, type CosignFn } from "./transfer.js";

/**
 * An agent signer for a provenance-gated rule: before signing any entry it
 * hands the exact entry to the provenance co-signer, and signs only together
 * with it. Drop-in for SmartAccountAgentSigner (x402 payments, transfers).
 * Throws ProvenanceEscalation when the co-signer will not sign.
 */
export class GatedAgentSigner extends SmartAccountAgentSigner {
  constructor(
    opts: AgentSignerOptions,
    private readonly cosign: CosignFn,
  ) {
    super(opts);
  }

  override async signEntry(entry: xdr.SorobanAuthorizationEntry, validUntilLedgerSeq: number): Promise<xdr.SorobanAuthorizationEntry> {
    if (entryAddress(entry) !== this.smartAccount) throw new Error(`Auth entry is not for the smart account ${this.smartAccount}`);
    const e = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    setExpiration(e, validUntilLedgerSeq);
    const c = await this.cosign(e.toXDR("base64"));
    if (!c.ok) throw new ProvenanceEscalation(c.why, c.verdict);
    if (Buffer.compare(c.signature.publicKey, this.agentPublicKey) === 0) throw new Error("co-signer key equals the agent key");
    const digest = buildAuthDigest(signaturePayloadOf(e, this.networkPassphrase), [this.contextRuleId]);
    const mine: ExternalSignature = { verifier: this.ed25519Verifier, publicKey: this.agentPublicKey, signature: this.signDigest(digest) };
    return withSignature(e, authPayloadMulti([this.contextRuleId], [mine, c.signature]));
  }
}

/** A CosignFn that asks a co-signer service over HTTP (apps/cosigner). */
export function remoteCosigner(url: string, caseFor: () => Record<string, unknown> | undefined, fetchImpl: typeof fetch = fetch): CosignFn {
  return async (authEntry) => {
    const c = caseFor();
    if (!c) return { ok: false, verdict: "reject", why: ["no signed task: ask the guardian to sign one first"] };
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...c, authEntry }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, verdict: "reject", why: [d?.error ?? `co-signer error ${res.status}`] };
    if (d.verdict === "cosign") {
      return { ok: true, signature: { verifier: d.signature.verifier, publicKey: Buffer.from(d.signature.publicKey, "hex"), signature: Buffer.from(d.signature.signature, "hex") } };
    }
    return { ok: false, verdict: d.verdict === "escalate" ? "escalate" : "reject", why: d.why ?? [d.reason ?? "refused"] };
  };
}

/**
 * The plan for a task an AI client (for example over MCP) runs under a signed
 * request: the item and, optionally, the merchant come from the request; the
 * price and recipient from the pinned catalog (cheapest match). The client's
 * own choices only decide when to buy, never what or how much.
 */
export function taskPlan(withMerchant: boolean) {
  return [
    { let: "product", op: "request", field: "product" },
    { let: "cat", op: "catalog" },
    ...(withMerchant
      ? [
          { let: "merchant", op: "request", field: "merchant" },
          { let: "theirs", op: "filter", list: "cat", key: "merchant", equals: "merchant" },
          { let: "matches", op: "filter", list: "theirs", key: "product", equals: "product" },
        ]
      : [{ let: "matches", op: "filter", list: "cat", key: "product", equals: "product" }]),
    { let: "best", op: "cheapest", list: "matches" },
    { let: "to", op: "field", from: "best", key: "payTo" },
    { let: "amount", op: "field", from: "best", key: "price" },
    { op: "pay", to: "to", amount: "amount" },
  ] as const;
}
