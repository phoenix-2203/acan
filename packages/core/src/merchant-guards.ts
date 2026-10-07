/**
 * Request-level guards for an x402 merchant, mounted in front of the
 * standard x402 middleware. They close gaps that published attacks on x402
 * exploit and that the protocol leaves to each server:
 *
 * - {@link tabRequestBinding}: an acan-tab voucher names the resource it pays
 *   for and is signed by the payer, so the merchant refuses it for any other
 *   path ("cross-resource substitution", arXiv 2605.30998 §I3).
 *
 * - {@link PaymentIdempotency}: one payment is served once. A retry of the
 *   same payment (same payment-identifier, same signed payload, same route)
 *   gets the stored response instead of a second charge or a 402, and
 *   concurrent copies of one payload wait for the first instead of all
 *   running the handler ("service duplication", arXiv 2605.30998 §I4;
 *   "replay across the HTTP-chain boundary", arXiv 2605.11781 attack II).
 *
 * Both are framework-agnostic Connect-style middleware (Express works).
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type Req = IncomingMessage & { originalUrl?: string };
type Next = (err?: unknown) => void;
export type Middleware = (req: Req, res: ServerResponse, next: Next) => void;

/** The x402 payment header of a request (v2 name first, then v1). */
export function paymentHeader(req: IncomingMessage): string | undefined {
  const h = req.headers["payment-signature"] ?? req.headers["x-payment"];
  return Array.isArray(h) ? h[0] : h;
}

/** Decode an x402 payment header (base64 JSON). Returns null when it is not one. */
export function decodePaymentHeader(header: string | undefined): any | null {
  if (!header || header.length > 64_000) return null;
  try {
    const v = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** Path and query of a URL or request target, for comparison ("/api/x?a=1"). */
export function pathAndQuery(urlOrTarget: string): string | null {
  try {
    const u = new URL(urlOrTarget, "http://placeholder.invalid");
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

const target = (req: Req) => req.originalUrl ?? req.url ?? "/";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

/**
 * Refuse an acan-tab voucher presented for a different resource than the one
 * it was signed for. The voucher's `resource` is covered by the payer's
 * signature, so this binds each voucher to one path and query string.
 */
export function tabRequestBinding(scheme = "acan-tab"): Middleware {
  return (req, res, next) => {
    const p = decodePaymentHeader(paymentHeader(req));
    if (p?.accepted?.scheme !== scheme) return next();
    const resource = p?.payload?.voucher?.resource;
    // A malformed voucher is left to the facilitator, which rejects it.
    if (typeof resource !== "string") return next();
    const signedFor = pathAndQuery(resource);
    const requested = pathAndQuery(target(req));
    if (signedFor === null || signedFor !== requested) {
      return sendJson(res, 400, {
        error: "acan_tab_resource_mismatch",
        message: `this voucher was signed for ${signedFor ?? "an invalid URL"}, not ${requested}`,
      });
    }
    next();
  };
}

/** Payment identifier carried in a v2 payload's `payment-identifier` extension. */
export function paymentIdOf(payload: any): string | null {
  const id = payload?.extensions?.["payment-identifier"]?.info?.id;
  return typeof id === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(id) ? id : null;
}

interface Entry {
  state: "pending" | "done";
  /** sha256 of the exact payment header. */
  fingerprint: string;
  /** "GET /api/x?a=1" */
  route: string;
  expires: number;
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer;
}

export interface IdempotencyOptions {
  /** How long a served response can be replayed. Default 15 minutes. */
  ttlMs?: number;
  /** Entries kept at most (oldest dropped first). Default 10,000. */
  maxEntries?: number;
  /** Header names never replayed. */
  dropHeaders?: string[];
}

/**
 * Exactly-once delivery for paid requests.
 *
 * - Payload with a payment identifier, first time: marked pending, passed to
 *   the x402 middleware; a successful paid response (200 with a settlement
 *   header) is stored for `ttlMs`. A failed attempt is forgotten, so the
 *   client can retry.
 * - Same identifier again with the same payload and route: the stored
 *   response is replayed (`x-acan-replay: 1`) — no second charge, and no 402
 *   for a client whose first response was lost in transit.
 * - Same identifier with a different payload or route: 409, never served.
 * - Any payload (with or without identifier) while an identical one is in
 *   flight: 409 `payment_in_progress`, so the handler runs once per payment.
 */
export class PaymentIdempotency {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly drop: Set<string>;

  constructor(opts: IdempotencyOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.drop = new Set(["content-length", "date", "connection", "keep-alive", "transfer-encoding", ...(opts.dropHeaders ?? [])]);
  }

  get size(): number {
    return this.entries.size;
  }

  middleware(): Middleware {
    return (req, res, next) => {
      const header = paymentHeader(req);
      if (!header) return next();
      const payload = decodePaymentHeader(header);
      if (!payload) return next();
      this.prune();

      const fingerprint = createHash("sha256").update(header).digest("hex");
      const route = `${req.method ?? "GET"} ${target(req)}`;
      const id = paymentIdOf(payload);
      const key = id ? `id:${id}` : `fp:${fingerprint}`;
      const existing = this.entries.get(key);

      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.route !== route) {
          return sendJson(res, 409, {
            error: "payment_identifier_conflict",
            message: "this payment identifier was already used for a different payment or resource",
          });
        }
        if (existing.state === "pending") {
          res.setHeader("retry-after", "1");
          return sendJson(res, 409, { error: "payment_in_progress", message: "this payment is already being processed" });
        }
        res.statusCode = existing.status!;
        for (const [k, v] of Object.entries(existing.headers!)) res.setHeader(k, v);
        res.setHeader("x-acan-replay", "1");
        return void res.end(existing.body);
      }

      const entry: Entry = { state: "pending", fingerprint, route, expires: Date.now() + this.ttlMs };
      this.entries.set(key, entry);

      const chunks: Buffer[] = [];
      const write = res.write.bind(res) as (...a: any[]) => boolean;
      const end = res.end.bind(res) as (...a: any[]) => ServerResponse;
      const keep = (chunk: unknown, encoding?: unknown) => {
        if (chunk === undefined || chunk === null || typeof chunk === "function") return;
        chunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk as any, typeof encoding === "string" ? (encoding as BufferEncoding) : undefined),
        );
      };
      (res as any).write = (chunk: unknown, ...rest: any[]) => {
        keep(chunk, rest[0]);
        return write(chunk, ...rest);
      };
      (res as any).end = (chunk?: unknown, ...rest: any[]) => {
        keep(chunk, rest[0]);
        return end(chunk, ...rest);
      };

      let finished = false;
      const settle = () => {
        if (finished) return;
        finished = true;
        const paid = res.statusCode === 200 && res.getHeader("payment-response") !== undefined;
        if (!paid || !id) {
          // Failed, or no identifier to replay by: release the lock.
          if (this.entries.get(key) === entry) this.entries.delete(key);
          return;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.getHeaders())) {
          if (v !== undefined && !this.drop.has(k.toLowerCase())) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        Object.assign(entry, { state: "done", status: res.statusCode, headers, body: Buffer.concat(chunks) });
      };
      res.on("finish", settle);
      res.on("close", settle);
      next();
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, e] of this.entries) {
      if (e.expires < now) this.entries.delete(k);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
