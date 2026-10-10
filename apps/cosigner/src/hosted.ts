/**
 * The provenance co-signer as a hosted service for the demo site: one co-signer
 * key, many sandbox wallets. Its key lives on this server, never in a visitor's
 * browser, so the agent's key in the browser can never pay on its own.
 *
 * A wallet is registered per (account, rule). The service accepts a
 * registration only after reading the rule on-chain and finding its own key
 * on it (only the account's passkey can add a signer), and takes the rest from
 * the chain too: the agent keys are the rule's other ed25519 signers, and the
 * pinned price book is the demo catalog limited to the rule's allowed shops.
 * The user's device key (which signs their requests) is the one sent with the
 * first registration for that rule.
 *
 *   GET  /health                          the co-signer's public key
 *   POST /register {account, ruleId, deviceKey}
 *   POST /review   {account, ruleId, request, plan, transcript, payIndex, authEntry, chain?}
 *   POST /cancel   {account, ruleId, id, signature}   signed by the device key
 *   GET  /spent?account=&ruleId=&id=
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { ProvenanceCosigner, cancelMessage, type PricedItem, type ReviewCase } from "@acan/core";

/** A context rule as read from the chain. */
export interface ChainRule {
  /** External signers: verifier contract and raw key bytes (hex). */
  signers: { verifier: string; key: string }[];
  policies: string[];
}

export interface HostedConfig {
  secret: string;
  token: string;
  networkPassphrase: string;
  ed25519Verifier: string;
  /** The gate policy (OZ weighted threshold) that must be on a registered rule. */
  gatePolicy: string;
  /** The merchant budget policy, if any; its recipients limit the price book. */
  merchantPolicy?: string;
  readRule(account: string, ruleId: number): Promise<ChainRule>;
  readRecipients(policy: string, account: string, ruleId: number): Promise<string[]>;
  /** The price book for the allowed shops (all demo shops when `null`). */
  catalogFor(allowed: string[] | null): PricedItem[];
  /** Browser origins allowed to call the service ("*" for any). */
  allowedOrigins: string[];
  /** File that keeps registrations across restarts (optional). */
  statePath?: string;
  now?: () => number;
}

interface Registration {
  account: string;
  ruleId: number;
  deviceKey: string;
  agentKeys: string[];
  catalog: PricedItem[];
}

export { cancelMessage };

const MAX_BODY = 256_000;

export function createHostedCosigner(cfg: HostedConfig): Server & { publicKey: string } {
  const me = Keypair.fromSecret(cfg.secret);
  const myKeyHex = Buffer.from(me.rawPublicKey()).toString("hex");
  const regs = new Map<string, Registration>();
  const cosigners = new Map<string, ProvenanceCosigner>();
  const keyOf = (account: string, ruleId: number) => `${account}:${ruleId}`;

  if (cfg.statePath) {
    try {
      for (const r of JSON.parse(readFileSync(cfg.statePath, "utf8")) as Registration[]) regs.set(keyOf(r.account, r.ruleId), r);
    } catch {
      /* first start */
    }
  }
  const persist = () => {
    if (!cfg.statePath) return;
    const tmp = `${cfg.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify([...regs.values()]));
    renameSync(tmp, cfg.statePath);
  };

  const cosignerFor = (r: Registration): ProvenanceCosigner => {
    const k = keyOf(r.account, r.ruleId);
    let c = cosigners.get(k);
    if (!c) {
      c = new ProvenanceCosigner({
        secret: cfg.secret,
        account: r.account,
        token: cfg.token,
        ruleId: r.ruleId,
        networkPassphrase: cfg.networkPassphrase,
        verifier: cfg.ed25519Verifier,
        deviceKeys: [r.deviceKey],
        catalog: r.catalog,
        agentKeys: r.agentKeys,
        now: cfg.now,
      });
      cosigners.set(k, c);
    }
    return c;
  };

  const cors = (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && (cfg.allowedOrigins.includes("*") || cfg.allowedOrigins.includes(origin))) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type");
    }
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const body = async (req: IncomingMessage): Promise<any> => {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) throw Object.assign(new Error("request too large"), { status: 413 });
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error("body must be JSON"), { status: 400 });
    }
  };
  const target = (b: any): { account: string; ruleId: number } => {
    if (!StrKey.isValidContract(String(b?.account)) || !Number.isInteger(b?.ruleId) || b.ruleId < 0) {
      throw Object.assign(new Error("account (C…) and ruleId are required"), { status: 400 });
    }
    return { account: b.account, ruleId: b.ruleId };
  };
  const registered = (account: string, ruleId: number): Registration => {
    const r = regs.get(keyOf(account, ruleId));
    if (!r) throw Object.assign(new Error("this rule is not registered with the co-signer"), { status: 404 });
    return r;
  };

  async function register(b: any) {
    const { account, ruleId } = target(b);
    const deviceKey = String(b?.deviceKey ?? "");
    if (!StrKey.isValidEd25519PublicKey(deviceKey)) throw Object.assign(new Error("deviceKey (G…) is required"), { status: 400 });
    const existing = regs.get(keyOf(account, ruleId));
    if (existing) {
      if (existing.deviceKey !== deviceKey) throw Object.assign(new Error("this rule is already registered to another device key"), { status: 409 });
      return { ok: true, registered: "already" };
    }
    const rule = await cfg.readRule(account, ruleId).catch(() => {
      throw Object.assign(new Error("could not read this rule on-chain"), { status: 404 });
    });
    const ed = rule.signers.filter((s) => s.verifier === cfg.ed25519Verifier);
    if (!ed.some((s) => s.key === myKeyHex)) throw Object.assign(new Error("this co-signer is not a signer on that rule"), { status: 403 });
    if (!rule.policies.includes(cfg.gatePolicy)) throw Object.assign(new Error("that rule has no provenance gate policy"), { status: 403 });
    const agentKeys = ed.filter((s) => s.key !== myKeyHex).map((s) => StrKey.encodeEd25519PublicKey(Buffer.from(s.key, "hex")));
    if (agentKeys.length === 0) throw Object.assign(new Error("that rule has no agent key"), { status: 403 });
    const allowed =
      cfg.merchantPolicy && rule.policies.includes(cfg.merchantPolicy) ? await cfg.readRecipients(cfg.merchantPolicy, account, ruleId) : null;
    const catalog = cfg.catalogFor(allowed);
    if (catalog.length === 0) throw Object.assign(new Error("none of that rule's shops are in the demo catalog"), { status: 403 });
    regs.set(keyOf(account, ruleId), { account, ruleId, deviceKey, agentKeys, catalog });
    persist();
    return { ok: true, registered: "new", agentKeys, items: catalog.length };
  }

  const server = createServer(async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname.replace(/^\/cosigner/, "") || "/";
    try {
      if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, cosigner: me.publicKey(), registered: regs.size });
      if (req.method === "GET" && path === "/spent") {
        const r = registered(String(url.searchParams.get("account")), Number(url.searchParams.get("ruleId")));
        const id = String(url.searchParams.get("id") ?? "");
        return send(res, 200, { spent: cosignerFor(r).spentUnder(id).toString() });
      }
      if (req.method !== "POST") return send(res, 404, { error: "not found" });
      const b = await body(req);
      if (path === "/register") return send(res, 200, await register(b));
      if (path === "/review") {
        const { account, ruleId } = target(b);
        const c = cosignerFor(registered(account, ruleId));
        const d = c.review(b as ReviewCase);
        if (d.verdict === "cosign") {
          return send(res, 200, {
            verdict: "cosign",
            signature: { verifier: d.signature.verifier, publicKey: d.signature.publicKey.toString("hex"), signature: d.signature.signature.toString("hex") },
            digest: d.digest,
            caseHash: d.caseHash,
          });
        }
        if (d.verdict === "escalate") return send(res, 200, { verdict: "escalate", why: d.why, caseHash: d.caseHash });
        return send(res, 200, { verdict: "reject", reason: d.reason, why: [d.reason] });
      }
      if (path === "/cancel") {
        const { account, ruleId } = target(b);
        const r = registered(account, ruleId);
        const id = String(b?.id ?? "");
        const sig = Buffer.from(String(b?.signature ?? ""), "hex");
        if (!id || sig.length !== 64 || !Keypair.fromPublicKey(r.deviceKey).verify(cancelMessage(account, ruleId, id), sig)) {
          throw Object.assign(new Error("cancel must be signed by the registered device key"), { status: 403 });
        }
        cosignerFor(r).revoke(id);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "not found" });
    } catch (e: any) {
      return send(res, e?.status ?? 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }) as Server & { publicKey: string };
  server.publicKey = me.publicKey();
  return server;
}
