/**
 * Which merchants an agent may use, and the payment address each one is
 * pinned to. Shared by the AI agent (agent-ai.ts) and the MCP server.
 *
 *   MERCHANT_URLS  comma-separated base URLs (default: the two demo merchants)
 *   MERCHANT_PINS  "url=G...,url=G..." known payment addresses
 *
 * The two demo merchants are pinned from .env (MERCHANT_ADDRESS,
 * MERCHANT_B_ADDRESS) unless MERCHANT_URLS is set; any other merchant is
 * pinned to the address its catalog gave on first contact.
 */
export const DEFAULT_MERCHANTS = ["http://localhost:4021", "http://localhost:4022"];

export const normalize = (u: string) => u.trim().replace(/\/$/, "");

export function merchantUrls(env = process.env): string[] {
  return (env.MERCHANT_URLS ?? DEFAULT_MERCHANTS.join(",")).split(",").map(normalize).filter(Boolean);
}

export function merchantPins(env = process.env): Map<string, string> {
  const pins = new Map<string, string>(
    (env.MERCHANT_PINS ?? "")
      .split(",")
      .map((kv) => kv.split("=").map((x) => x.trim()))
      .filter((kv): kv is [string, string] => kv.length === 2 && Boolean(kv[0] && kv[1]))
      .map(([u, a]) => [normalize(u), a]),
  );
  if (!env.MERCHANT_URLS) {
    if (env.MERCHANT_ADDRESS && !pins.has(DEFAULT_MERCHANTS[0])) pins.set(DEFAULT_MERCHANTS[0], env.MERCHANT_ADDRESS);
    if (env.MERCHANT_B_ADDRESS && !pins.has(DEFAULT_MERCHANTS[1])) pins.set(DEFAULT_MERCHANTS[1], env.MERCHANT_B_ADDRESS);
  }
  return pins;
}

/** Product paths an agent may request: plain /api/<name>, nothing else. */
export const PRODUCT_PATH = /^\/api\/[a-z-]+$/;

/**
 * Check a purchase request coming from a model (untrusted). Returns the URL
 * to buy, or an error to hand back to the model.
 */
export function purchaseUrl(
  urls: string[],
  merchantIn: unknown,
  pathIn: unknown,
  queryIn?: unknown,
): { ok: true; merchant: string; path: string; url: string } | { ok: false; error: string } {
  const merchant = normalize(String(merchantIn ?? ""));
  const path = String(pathIn ?? "");
  const query = String(queryIn ?? "").replace(/^\?/, "");
  if (!urls.includes(merchant)) return { ok: false, error: `unknown merchant ${JSON.stringify(merchant)}; use a URL exactly as listed` };
  if (!PRODUCT_PATH.test(path)) return { ok: false, error: `invalid path ${JSON.stringify(path)}` };
  if (query && !/^[A-Za-z0-9_.~=&%-]{1,300}$/.test(query)) return { ok: false, error: "invalid query string" };
  return { ok: true, merchant, path, url: `${merchant}${path}${query ? `?${query}` : ""}` };
}
