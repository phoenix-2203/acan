/**
 * The provenance co-signer as a service. It holds the co-signer key, the
 * guardian's pinned catalog and the user's registered device keys, and answers
 * one question: will you sign this exact authorization, given this request,
 * plan and what the agent read? No language model runs here.
 *
 *   POST /review   {request, plan, transcript, payIndex, authEntry} -> decision
 *   GET  /health   public key, account, rule id, pinned catalog
 */
import { createServer, type Server } from "node:http";
import { ProvenanceCosigner, type CosignerConfig, type ReviewCase } from "@acan/core";

export function createCosignerService(cfg: CosignerConfig): Server {
  const cosigner = new ProvenanceCosigner(cfg);
  const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  return createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      return send(res, 200, {
        ok: true,
        cosigner: cosigner.publicKey.toString("hex"),
        account: cfg.account,
        ruleId: cfg.ruleId,
        deviceKeys: cfg.deviceKeys,
        catalog: cfg.catalog,
      });
    }
    if (req.method !== "POST" || path !== "/review") return send(res, 404, { error: "not found" });
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 256_000) return send(res, 413, { error: "case too large" });
    }
    let c: ReviewCase;
    try {
      c = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "body must be JSON" });
    }
    const d = cosigner.review(c);
    const at = new Date().toISOString();
    if (d.verdict === "cosign") {
      console.log(`${at} CO-SIGNED ${d.transfer.amount} to ${d.transfer.to} (case ${d.caseHash.slice(0, 12)})`);
      return send(res, 200, {
        verdict: "cosign",
        signature: { verifier: d.signature.verifier, publicKey: d.signature.publicKey.toString("hex"), signature: d.signature.signature.toString("hex") },
        digest: d.digest,
        caseHash: d.caseHash,
      });
    }
    if (d.verdict === "escalate") {
      console.log(`${at} HELD ${d.transfer.amount} to ${d.transfer.to}: ${d.why.join("; ")}`);
      return send(res, 200, { verdict: "escalate", why: d.why, caseHash: d.caseHash });
    }
    console.log(`${at} REJECTED: ${d.reason}`);
    return send(res, 200, { verdict: "reject", reason: d.reason, why: [d.reason] });
  });
}
