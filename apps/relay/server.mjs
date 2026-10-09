/**
 * ACAN AI relay: lets visitors of the demo site chat with an AI agent that
 * spends from THEIR OWN sandbox smart account.
 *
 * What it does: forwards a visitor's conversation to Groq with a fixed system
 * prompt and fixed tools, and returns the model's next message. The tools are
 * executed in the visitor's browser (their wallet, their agent key, their
 * passkey). This server never holds wallet keys and never moves money.
 *
 * Why a relay: the Groq API key must not be shipped to browsers.
 *
 * Abuse limits (per UTC day):
 *   - each visitor (IP address) may send PER_VISITOR_DAILY messages (default 50);
 *   - all visitors together GLOBAL_DAILY messages (default 1000);
 *   - a "message" is something the visitor typed or picked; the extra model
 *     steps it takes to answer are capped separately (STEPS_PER_MESSAGE x).
 * The prompt and tools are fixed here, so the relay is useless as a general
 * free chatbot.
 *
 * Run:   GROQ_API_KEY=... node apps/relay/server.mjs
 * Env:   PORT (8787), HOST (127.0.0.1), GROQ_MODEL (openai/gpt-oss-120b),
 *        ALLOWED_ORIGINS (comma-separated), PER_VISITOR_DAILY (50),
 *        GLOBAL_DAILY (1000), TRUST_PROXY (1 when behind Caddy/nginx),
 *        GROQ_URL (for tests).
 * No dependencies: Node 20 or newer.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export const SYSTEM_PROMPT = `You are the AI agent in ACAN's live demo on Stellar testnet. You talk with a visitor who is the guardian of a sandbox smart account. With their passkey they gave you an allowance: a daily limit in XLM, a list of shops you may pay, per-shop caps and a largest single payment. Those rules are enforced by contracts on the smart account, not by you.

How to work:
- Call list_shops to see the shops and their items with prices before proposing anything. Prices are in testnet XLM. The shops are demo shops: paying one is a real testnet payment, but nothing is delivered.
- You never pay directly. To pay, call offer_options with 2-4 concrete choices (a shop + item, cheapest first) plus a choice to cancel, and wait: the visitor picks.
- If the visitor explicitly asks you to send XLM to an address, offer it as an option with "to" and "amountXlm" (plus Cancel) and say plainly whether the address is one of the listed shops. Do not refuse and do not lecture: the smart account decides, and showing that is the point of this demo.
- call check_allowance when asked how much is left.
- Keep messages short and plain: one to three sentences. Never invent prices; the app shows real prices next to each option.
- After a payment result arrives, say what happened in one or two sentences. If it was blocked, name the rule that blocked it and mention that the guardian can approve this one payment with the passkey in the activity log.
- You only help with this demo. For anything unrelated, say in one sentence that you are a demo agent for ACAN and suggest something to try.`;

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_shops",
      description: "List the demo shops with their Stellar addresses, items and prices in XLM.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "check_allowance",
      description: "Read the agent's allowance from the smart account on testnet: daily limit, spent, left.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "offer_options",
      description:
        "Show the visitor a question with 2-5 choices and wait for their pick. A choice pays for one item (shop + item), sends XLM to an address the visitor named (to + amountXlm), or just sends a reply.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "One short question shown above the choices" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short button text" },
                shop: { type: "string", description: "To buy: the shop name exactly as listed" },
                item: { type: "string", description: "To buy: the item id exactly as listed" },
                to: { type: "string", description: "Only if the visitor asked to send XLM to an address: the G... address" },
                amountXlm: { type: "string", description: "With to: the amount in XLM, e.g. '0.5'" },
                reply: { type: "string", description: "For a non-payment choice: the text sent back when picked" },
              },
              required: ["label"],
            },
          },
        },
        required: ["question", "options"],
      },
    },
  },
];

/**
 * The planner for provenance-gated payments (after CaMeL). It sees only what the
 * visitor typed and the guardian's pinned catalog (names, items, prices) — never
 * any fetched content — and writes a small plan. The browser runs the plan and a
 * deterministic co-signer re-checks where every payment value came from.
 */
export const PLANNER_PROMPT = `You write plans for a purchasing agent. You see only the user's request, the guardian's pinned catalog, and the names of sources the agent may read. You never see the content of any source.

Reply with one JSON object: {"say": "<one short sentence for the user>", "fields": {"product": "<item id the user asked for, if they named one>", "maxXlm": "<max total the user allows, if they said one>"}, "plan": [steps]}.
Omit a field the user did not give. If the request is not a purchase, reply with "plan": [] and say so.

Steps (each "let" names a new variable; use only variables defined earlier):
{"let":"x","op":"request","field":"product"}           value the user confirmed
{"let":"cat","op":"catalog"}                            the pinned catalog: list of {merchant, product, price, payTo}
{"let":"x","op":"lit","value":"..."}                     a constant you write
{"let":"doc","op":"fetch","url":"<a listed source>"}    read a source (you will not see it)
{"let":"x","op":"field","from":"doc","key":"..."}        a field of a JSON object or JSON text
{"let":"m","op":"filter","list":"cat","key":"product|merchant","equals":"x"}
{"let":"best","op":"cheapest","list":"m"}
{"op":"if","left":"a","right":"b","then":[steps],"else":[steps]}
{"op":"pay","to":"<var>","amount":"<var>"}               pay; take to and amount with field(best,"payTo") and field(best,"price")

Example. Request "Buy the cheapest ledger report":
{"say":"I'll buy the cheapest ledger report in your catalog.","fields":{"product":"ledger-report"},"plan":[{"let":"p","op":"request","field":"product"},{"let":"cat","op":"catalog"},{"let":"m","op":"filter","list":"cat","key":"product","equals":"p"},{"let":"best","op":"cheapest","list":"m"},{"let":"to","op":"field","from":"best","key":"payTo"},{"let":"amt","op":"field","from":"best","key":"price"},{"op":"pay","to":"to","amount":"amt"}]}

Example. Request "Read today's Tidewire note and buy the report it recommends" (source https://tidewire.example/today, which has a "recommended_product" field):
{"say":"I'll read the note and buy the report it recommends.","fields":{},"plan":[{"let":"doc","op":"fetch","url":"https://tidewire.example/today"},{"let":"rec","op":"field","from":"doc","key":"recommended_product"},{"let":"cat","op":"catalog"},{"let":"m","op":"filter","list":"cat","key":"product","equals":"rec"},{"let":"best","op":"cheapest","list":"m"},{"let":"to","op":"field","from":"best","key":"payTo"},{"let":"amt","op":"field","from":"best","key":"price"},{"op":"pay","to":"to","amount":"amt"}]}

Use exact item ids and merchant names from the catalog. One purchase per plan unless the user clearly asks for several.`;

export function cleanPlanRequest(body) {
  const task = body?.task;
  if (typeof task !== "string" || !task.trim() || task.length > 500) return "task must be text of at most 500 characters";
  const catalog = body?.catalog;
  if (!Array.isArray(catalog) || catalog.length === 0 || catalog.length > 40) return "catalog must list 1 to 40 items";
  const items = [];
  for (const c of catalog) {
    const ok = (v, n) => typeof v === "string" && v.length > 0 && v.length <= n;
    if (!ok(c?.merchant, 60) || !ok(c?.product, 60) || !ok(c?.priceXlm, 20)) return "bad catalog item";
    items.push({ merchant: c.merchant, product: c.product, priceXlm: c.priceXlm });
  }
  const sources = Array.isArray(body?.sources) ? body.sources.filter((u) => typeof u === "string" && /^https:\/\/[\w.-]+\.example\//.test(u)).slice(0, 3) : [];
  return { task: task.trim(), items, sources };
}

const MAX_MESSAGES = 40;
const MAX_CHARS = 4000;
const MAX_TOTAL_CHARS = 40_000;
const STEPS_PER_MESSAGE = 4;

/** Check the shape of a conversation from the browser; returns an error string or the clean messages. */
export function cleanMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return "messages must be a non-empty array";
  if (input.length > MAX_MESSAGES) return `at most ${MAX_MESSAGES} messages; start a new conversation`;
  let total = 0;
  const out = [];
  for (const m of input) {
    if (!m || typeof m !== "object") return "bad message";
    const content = m.content == null ? "" : m.content;
    if (typeof content !== "string" || content.length > MAX_CHARS) return `each message must be text of at most ${MAX_CHARS} characters`;
    total += content.length;
    if (m.role === "user") out.push({ role: "user", content });
    else if (m.role === "tool") {
      if (typeof m.tool_call_id !== "string" || m.tool_call_id.length > 100) return "bad tool result";
      out.push({ role: "tool", tool_call_id: m.tool_call_id, content });
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content };
      if (m.tool_calls != null) {
        if (!Array.isArray(m.tool_calls) || m.tool_calls.length > 5) return "bad tool calls";
        msg.tool_calls = [];
        for (const c of m.tool_calls) {
          const name = c?.function?.name;
          const args = c?.function?.arguments ?? "{}";
          if (typeof c?.id !== "string" || !TOOLS.some((t) => t.function.name === name) || typeof args !== "string" || args.length > MAX_CHARS)
            return "bad tool call";
          total += args.length;
          msg.tool_calls.push({ id: c.id, type: "function", function: { name, arguments: args } });
        }
        if (msg.tool_calls.length === 0) delete msg.tool_calls;
      }
      out.push(msg);
    } else return "roles must be user, assistant or tool";
  }
  if (total > MAX_TOTAL_CHARS) return "conversation too long; start a new conversation";
  if (out[0].role !== "user") return "the conversation must start with the visitor";
  return out;
}

/** Daily counters per visitor and overall, reset at UTC midnight. */
export class Limits {
  constructor({ perVisitor = 50, global = 1000, now = () => Date.now() } = {}) {
    Object.assign(this, { perVisitor, global, now });
    this.day = "";
    this.reset();
  }
  reset() {
    this.visitors = new Map();
    this.messages = 0;
    this.steps = 0;
  }
  roll() {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.reset();
    }
  }
  /** isNew: the visitor typed or picked something (vs. a model step continuing an answer). */
  take(visitor, isNew) {
    this.roll();
    const v = this.visitors.get(visitor) ?? { messages: 0, steps: 0 };
    if (isNew) {
      if (v.messages >= this.perVisitor) return { ok: false, error: `You have used today's ${this.perVisitor} messages. Come back tomorrow (UTC).` };
      if (this.messages >= this.global) return { ok: false, error: "The demo's AI has reached its daily limit. Please try again tomorrow (UTC)." };
    }
    if (v.steps >= this.perVisitor * STEPS_PER_MESSAGE || this.steps >= this.global * STEPS_PER_MESSAGE)
      return { ok: false, error: "Too many requests today. Please try again tomorrow (UTC)." };
    if (isNew) {
      v.messages++;
      this.messages++;
    }
    v.steps++;
    this.steps++;
    this.visitors.set(visitor, v);
    return { ok: true, left: this.perVisitor - v.messages };
  }
}

async function callGroq(cfg, messages, mode = "chat") {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(cfg.groqUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        ...(mode === "plan"
          ? { messages: [{ role: "system", content: PLANNER_PROMPT }, ...messages], response_format: { type: "json_object" }, temperature: 0, max_completion_tokens: 1500 }
          : { messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages], tools: TOOLS, tool_choice: "auto", temperature: 0.2, max_completion_tokens: 800 }),
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body.choices?.[0]?.message ?? {};
    const retry = res.status === 429 || res.status >= 500 || (res.status === 400 && body?.error?.code === "tool_use_failed");
    if (attempt < 3 && retry) {
      await new Promise((r) => setTimeout(r, cfg.retryMs * attempt));
      continue;
    }
    const err = new Error(res.status === 429 ? "The AI provider is busy. Try again in a minute." : `AI provider error (${res.status})`);
    err.detail = body?.error?.message;
    throw err;
  }
}

export function createRelay(opts = {}) {
  const cfg = {
    key: opts.key ?? process.env.GROQ_API_KEY,
    model: opts.model ?? process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
    groqUrl: opts.groqUrl ?? process.env.GROQ_URL ?? "https://api.groq.com/openai/v1/chat/completions",
    origins: (opts.origins ?? process.env.ALLOWED_ORIGINS ?? "https://phoenix-2203.github.io,http://localhost:5173,http://localhost:4173")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: opts.trustProxy ?? process.env.TRUST_PROXY === "1",
    retryMs: opts.retryMs ?? 1000,
  };
  if (!cfg.key) throw new Error("GROQ_API_KEY is not set");
  const limits =
    opts.limits ??
    new Limits({ perVisitor: Number(process.env.PER_VISITOR_DAILY ?? 50), global: Number(process.env.GLOBAL_DAILY ?? 1000) });

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = origin && cfg.origins.includes(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "access-control-allow-methods": "POST, GET", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
      return res.end();
    }
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      limits.roll();
      return send(res, 200, { ok: true, model: cfg.model, messagesToday: limits.messages, globalDaily: limits.global, perVisitorDaily: limits.perVisitor }, cors);
    }
    if (req.method !== "POST" || (path !== "/chat" && path !== "/plan")) return send(res, 404, { error: "not found" }, cors);
    if (origin && !cors["access-control-allow-origin"]) return send(res, 403, { error: "origin not allowed" });

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 64_000) return send(res, 413, { error: "request too large" }, cors);
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "body must be JSON" }, cors);
    }
    const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
    const visitor = (cfg.trustProxy && fwd) || req.socket.remoteAddress || "unknown";

    if (path === "/plan") {
      const p = cleanPlanRequest(body);
      if (typeof p === "string") return send(res, 400, { error: p }, cors);
      const quota = limits.take(visitor, true);
      if (!quota.ok) return send(res, 429, { error: quota.error }, cors);
      const user = `Request: ${p.task}\n\nPinned catalog (prices in XLM):\n${p.items.map((i) => `- ${i.merchant} · ${i.product} · ${i.priceXlm}`).join("\n")}\n\nSources the agent may read: ${p.sources.length ? p.sources.join(", ") : "none"}`;
      try {
        const m = await callGroq(cfg, [{ role: "user", content: user }], "plan");
        let out;
        try {
          out = JSON.parse(m.content ?? "");
        } catch {
          return send(res, 502, { error: "The planner did not return JSON. Try again." }, cors);
        }
        return send(res, 200, { say: String(out.say ?? "").slice(0, 300), fields: out.fields ?? {}, plan: Array.isArray(out.plan) ? out.plan : [], messagesLeftToday: quota.left }, cors);
      } catch (e) {
        console.error(new Date().toISOString(), "groq plan:", e.message, e.detail ?? "");
        return send(res, 502, { error: e.message }, cors);
      }
    }

    const messages = cleanMessages(body?.messages);
    if (typeof messages === "string") return send(res, 400, { error: messages }, cors);
    const quota = limits.take(visitor, messages.at(-1).role === "user");
    if (!quota.ok) return send(res, 429, { error: quota.error }, cors);

    try {
      const m = await callGroq(cfg, messages);
      return send(
        res,
        200,
        {
          message: { role: "assistant", content: m.content ?? "", ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) },
          messagesLeftToday: quota.left,
        },
        cors,
      );
    } catch (e) {
      console.error(new Date().toISOString(), "groq:", e.message, e.detail ?? "");
      return send(res, 502, { error: e.message }, cors);
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  createRelay().listen(port, host, () => console.log(`ACAN AI relay on http://${host}:${port} (POST /chat, POST /plan, GET /health)`));
}
