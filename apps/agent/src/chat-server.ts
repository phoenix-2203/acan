/**
 * Agent chat service for the dashboard: the interactive agent (chat-engine.ts)
 * behind a small local API, on this machine only (127.0.0.1).
 *
 *   GET  /chat?after=<seq>   new events, whether the agent is busy, open options
 *   POST /chat/message       {text}               the user types
 *   POST /chat/choose        {optionsId, optionId} the user taps an option
 *   POST /chat/reset         start a new conversation
 *   POST /policy/draft       {text}  turn "give my agent $5 for 24 hours" into a
 *                            reviewable allowance (the dashboard shows it; the
 *                            guardian's passkey is what creates it)
 *
 * The agent's key and the model's API key stay in this process; the browser
 * only sees the conversation. Payments are authorized on-chain under the
 * agent's rule (AGENT_RULE_ID), exactly like the CLI agent.
 *
 * Usage: npm run agent:chat:server   (then open the dashboard: npm run web)
 */
import express from "express";
import { loadEnv } from "@acan/core";
import { ChatEngine } from "./chat-engine.js";
import { merchantPins, merchantUrls } from "./merchants.js";
import { draftPolicy, type MerchantInfo } from "./policy-draft.js";
import { AgentWallet, type Mode } from "./wallet.js";

loadEnv();

const PORT = Number(process.env.AGENT_CHAT_PORT ?? 4040);
const ORIGINS = (process.env.DASHBOARD_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173").split(",");
const mode: Mode = process.env.ACAN_MODE === "private" ? "private" : "public";
const autopilot = process.env.AGENT_AUTOPILOT === "1";

const wallet = new AgentWallet(mode, (l) => console.log(l));
const newEngine = () =>
  new ChatEngine({ wallet, merchants: merchantUrls(), pins: merchantPins(), autopilot });
let engine = newEngine();
// Changes on reset and on restart, so the dashboard knows to reload the conversation.
const started = Date.now().toString(36);
let resets = 0;
const generation = () => `${started}.${resets}`;

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
  }
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

app.get("/chat", (req, res) => {
  const after = Number(req.query.after ?? 0) || 0;
  res.json({
    generation: generation(),
    model: engine.modelLabel,
    mode,
    autopilot,
    busy: engine.busy,
    pending: engine.pendingOptions ?? null,
    events: engine.events.filter((e) => e.seq > after),
  });
});

// Work runs in the background; the dashboard polls GET /chat for progress.
app.post("/chat/message", (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string" || !text.trim()) return void res.status(400).json({ error: "body must be {text}" });
  if (engine.busy) return void res.status(409).json({ error: "the agent is still working" });
  void engine.send(text);
  res.status(202).json({ ok: true });
});

app.post("/chat/choose", (req, res) => {
  const { optionsId, optionId } = req.body ?? {};
  if (typeof optionsId !== "string" || typeof optionId !== "string") {
    return void res.status(400).json({ error: "body must be {optionsId, optionId}" });
  }
  if (engine.busy) return void res.status(409).json({ error: "the agent is still working" });
  if (engine.pendingOptions?.id !== optionsId) return void res.status(409).json({ error: "those options are no longer open" });
  void engine.choose(optionsId, optionId);
  res.status(202).json({ ok: true });
});

app.post("/chat/reset", (_req, res) => {
  if (engine.busy) return void res.status(409).json({ error: "the agent is still working" });
  engine = newEngine();
  resets++;
  res.json({ ok: true, generation: generation() });
});

app.post("/policy/draft", async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string" || !text.trim()) return void res.status(400).json({ error: "body must be {text}" });
  try {
    const pins = merchantPins();
    const merchants: MerchantInfo[] = [];
    for (const url of merchantUrls()) {
      try {
        const c = await (await fetch(url)).json();
        merchants.push({ url, name: String(c.name ?? url), payTo: pins.get(url) ?? String(c.payTo), products: c.products ?? [] });
      } catch {
        /* unreachable merchant: not offered */
      }
    }
    if (merchants.length === 0) return void res.status(503).json({ error: "no merchant is reachable (npm run merchant / merchant:b)" });
    const vault = process.env.AGENT_VAULT_ADDRESS ? { address: process.env.AGENT_VAULT_ADDRESS, name: "Agent's private vault" } : undefined;
    const draft = await draftPolicy(text, merchants, { vault });
    res.json({ draft, agentKey: wallet.signer.agentAddress });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.listen(PORT, "127.0.0.1", (err?: Error) => {
  if (err) {
    console.error(`AGENT CHAT FAILED TO START on port ${PORT}: ${err.message}`);
    console.error(`Stop the other process with:  lsof -ti tcp:${PORT} | xargs kill`);
    process.exit(1);
  }
  console.log(`ACAN agent chat on http://127.0.0.1:${PORT} (${engine.modelLabel}, ${mode} payments, rule #${wallet.ruleId})`);
  console.log(autopilot ? "AUTOPILOT ON: the model may buy without asking" : "the model proposes purchases; you pick them in the dashboard");
});
