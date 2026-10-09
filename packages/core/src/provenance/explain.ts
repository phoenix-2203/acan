/**
 * Explainable receipts: re-run, from the receipt alone, the provenance
 * co-signer's decision for every payment and every hold, and check that the
 * co-signer really signed each paid transfer.
 *
 * What this proves: given the user's signed request, the plan, what the agent
 * read and the guardian's pinned catalog (all in the receipt), the same
 * deterministic check gives the same verdict; and the co-signer's key signed
 * exactly the transfer the receipt lists. What it does not prove: that the
 * receipt lists every task the agent ran (it is the agent's own record).
 */
import { Buffer } from "buffer";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { buildAuthDigest } from "../agent-signer.js";
import type { ReceiptCheck } from "../receipt-check.js";
import type { SignedReceipt } from "../receipt.js";
import { decodeTransfer, signaturePayloadOf } from "./auth.js";
import { runPlan, untrusted, type PricedItem, type Step } from "./plan.js";
import { verifyRequest, type SignedRequest } from "./request.js";

const units = (atomic: bigint) => {
  const s = atomic.toString().padStart(8, "0");
  const frac = s.slice(-7).replace(/0+$/, "");
  return `${s.slice(0, -7)}${frac ? `.${frac}` : ""}`;
};

/** Plain words for a set of untrusted sources. */
function from(src: string[]): string {
  return src.map((s) => (s === "planner" ? "values the AI wrote" : s.startsWith("tool:") ? `content from ${s.slice(5)}` : s)).join(" and ");
}

export function explainReceipt(signed: SignedReceipt): ReceiptCheck[] {
  const r = signed.receipt;
  const p = r.provenance;
  if (!p) return [];
  const out: ReceiptCheck[] = [];
  const req = p.request as unknown as SignedRequest;
  const code = r.asset?.code ?? "USDC";

  const reqOk = verifyRequest(req) && req.request.account === r.smartAccount;
  out.push({
    status: reqOk ? "ok" : "fail",
    text: reqOk
      ? `The request “${req.request.task}” was signed on the user's device (${req.publicKey.slice(0, 6)}…) for this account`
      : "The user's request signature does not verify, or it is for another account",
  });

  let pays;
  try {
    pays = runPlan(p.plan as Step[], { request: req.request.fields, catalog: p.catalog as PricedItem[], transcript: p.transcript });
  } catch (e) {
    out.push({ status: "fail", text: `The plan does not re-run: ${e instanceof Error ? e.message : String(e)}` });
    return out;
  }

  const validCosigner = StrKey.isValidEd25519PublicKey(p.cosigner);
  for (const [i, pay] of r.payments.entries()) {
    if (pay.payIndex === undefined) continue;
    const intent = pays[pay.payIndex];
    if (!intent) {
      out.push({ status: "fail", payment: i, text: `${pay.merchant}: the plan has no payment #${pay.payIndex}` });
      continue;
    }
    const bad = [...new Set([...untrusted(intent.to.src), ...untrusted(intent.amount.src), ...untrusted(intent.ctx)])];
    const sameValues = intent.to.v === pay.address && /^\d+$/.test(String(intent.amount.v)) && units(BigInt(String(intent.amount.v))) === pay.amountUsdc;
    if (pay.approvedByGuardian) continue; // passkey-approved: the guardian, not the co-signer, decided
    out.push({
      status: bad.length === 0 && sameValues ? "ok" : "fail",
      payment: i,
      text:
        bad.length === 0 && sameValues
          ? `Re-run: ${pay.amountUsdc} ${code} to ${pay.merchant}. Who, how much and whether all trace to the request and the pinned catalog`
          : !sameValues
            ? `Re-run: the plan pays something else than this line (${pay.amountUsdc} ${code} to ${pay.merchant})`
            : `Re-run: this payment depends on ${from(bad)}, so the co-signer should not have signed it`,
    });
    // The co-signer's signature over this exact transfer.
    let sigOk = false;
    let why = "no co-signature in the receipt";
    if (validCosigner && pay.authEntry && pay.cosignature) {
      try {
        const entry = xdr.SorobanAuthorizationEntry.fromXDR(pay.authEntry, "base64");
        const t = decodeTransfer(entry);
        const digest = buildAuthDigest(signaturePayloadOf(entry, p.networkPassphrase), [r.ruleId]);
        const matches = t.to === pay.address && units(t.amount) === pay.amountUsdc && t.from === r.smartAccount && t.subInvocations === 0;
        sigOk = matches && Keypair.fromPublicKey(p.cosigner).verify(digest, Buffer.from(pay.cosignature, "hex"));
        why = matches ? "the co-signature does not verify" : "the authorization is for a different transfer";
      } catch (e) {
        why = `the authorization cannot be read (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    out.push({
      status: sigOk ? "ok" : "fail",
      payment: i,
      text: sigOk ? `The co-signer ${p.cosigner.slice(0, 6)}… signed exactly this transfer under rule #${r.ruleId}` : `${pay.merchant}: ${why}`,
    });
  }

  for (const b of r.blocked) {
    if (!b.held) continue;
    const intent = pays[b.held.payIndex];
    const bad = intent ? [...new Set([...untrusted(intent.to.src), ...untrusted(intent.amount.src), ...untrusted(intent.ctx)])] : [];
    out.push({
      status: intent && bad.length > 0 ? "ok" : "fail",
      text:
        intent && bad.length > 0
          ? `Re-run agrees with the hold: ${b.amountUsdc ?? "?"} ${code} to ${b.recipient} depended on ${from(bad)}`
          : `Re-run disagrees: the held payment to ${b.recipient} ${intent ? "traces to the request" : "is not in the plan"}`,
    });
  }
  return out;
}
