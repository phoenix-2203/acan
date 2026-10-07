/**
 * Guardian service: a small local API the dashboard reads, on the guardian's
 * own machine (binds to 127.0.0.1 only).
 *
 *   GET  /audit                 the agent vault's confidential activity, decrypted
 *                               with the auditor key in .env (CT_AUDITOR_SECRET)
 *   POST /approvals             the agent asks for a one-off payment above its allowance
 *   GET  /approvals             pending and recent requests (the dashboard polls this)
 *   GET  /approvals/:id         one request's status (the agent polls this)
 *   POST /approvals/:id/approve the dashboard posts the passkey-signed auth entry
 *   POST /approvals/:id/reject
 *
 * The service never signs anything. Approval happens in the browser with the
 * guardian's passkey; the smart account checks that signature on-chain.
 *
 * Usage: npm run guardian
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { loadEnv, requireEnv, stroopsToUsdc } from "@acan/core";
import { auditAccount, parseScalar } from "@acan/confidential";

loadEnv();

const PORT = Number(process.env.GUARDIAN_PORT ?? 4030);
const DASHBOARD_ORIGINS = (process.env.DASHBOARD_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173").split(",");
const APPROVAL_TTL_MS = 10 * 60_000;

interface Approval {
  id: string;
  createdAt: number;
  status: "pending" | "approved" | "rejected" | "expired";
  merchant: string;
  url: string;
  payTo: string;
  /** atomic units */
  amount: string;
  amountUsdc: string;
  reason: string;
  /** Unsigned smart-account auth entry (base64 XDR) for the payment. */
  entryXdr: string;
  /** Signature expiration ledger the agent's payment allows. */
  maxLedger: number;
  signedEntryXdr?: string;
}
const approvals = new Map<string, Approval>();

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && DASHBOARD_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
  }
  if (req.method === "OPTIONS") return void res.sendStatus(204);
  next();
});

function expireOld() {
  const now = Date.now();
  for (const a of approvals.values()) {
    if (a.status === "pending" && now - a.createdAt > APPROVAL_TTL_MS) a.status = "expired";
  }
}

/** Addresses and contracts the dashboard offers when authorizing an agent. */
app.get("/config", (_req, res) => {
  const recipients = [
    process.env.MERCHANT_ADDRESS && { address: process.env.MERCHANT_ADDRESS, label: "Northwind Data (merchant A)" },
    process.env.MERCHANT_B_ADDRESS && { address: process.env.MERCHANT_B_ADDRESS, label: "Southgate Data (merchant B)" },
    process.env.AGENT_VAULT_ADDRESS && { address: process.env.AGENT_VAULT_ADDRESS, label: "Agent's private vault (top-ups)" },
  ].filter(Boolean);
  res.json({
    allowlistPolicy: process.env.ALLOWLIST_POLICY || null,
    agentAddress: process.env.AGENT_ADDRESS || null,
    recipients,
  });
});

app.get("/audit", async (_req, res) => {
  try {
    const vault = requireEnv("AGENT_VAULT_ADDRESS");
    const secret = process.env.CT_AUDITOR_SECRET ? parseScalar(process.env.CT_AUDITOR_SECRET) : null;
    const report = await auditAccount(vault, secret);
    const names: Record<string, string> = { [vault]: "Agent vault" };
    if (process.env.MERCHANT_ADDRESS) names[process.env.MERCHANT_ADDRESS] = "Northwind Data (merchant A)";
    if (process.env.MERCHANT_B_ADDRESS) names[process.env.MERCHANT_B_ADDRESS] = "Southgate Data (merchant B)";
    res.json({ ...report, names, auditorKey: secret !== null });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/approvals", (req, res) => {
  const b = req.body ?? {};
  for (const k of ["merchant", "url", "payTo", "amount", "reason", "entryXdr"]) {
    if (typeof b[k] !== "string" || !b[k]) return void res.status(400).json({ error: `missing ${k}` });
  }
  if (!/^\d+$/.test(b.amount) || !Number.isSafeInteger(b.maxLedger)) {
    return void res.status(400).json({ error: "bad amount or maxLedger" });
  }
  const a: Approval = {
    id: randomUUID(),
    createdAt: Date.now(),
    status: "pending",
    merchant: b.merchant.slice(0, 80),
    url: b.url.slice(0, 300),
    payTo: b.payTo,
    amount: b.amount,
    amountUsdc: stroopsToUsdc(b.amount),
    reason: b.reason.slice(0, 500),
    entryXdr: b.entryXdr,
    maxLedger: b.maxLedger,
  };
  approvals.set(a.id, a);
  console.log(`approval requested: ${a.amountUsdc} USDC to ${a.merchant} (${a.id.slice(0, 8)}) — "${a.reason}"`);
  res.status(201).json({ id: a.id });
});

app.get("/approvals", (_req, res) => {
  expireOld();
  res.json([...approvals.values()].sort((x, y) => y.createdAt - x.createdAt).slice(0, 20));
});

app.get("/approvals/:id", (req, res) => {
  expireOld();
  const a = approvals.get(req.params.id);
  if (!a) return void res.status(404).json({ error: "unknown approval" });
  res.json(a);
});

app.post("/approvals/:id/approve", (req, res) => {
  const a = approvals.get(req.params.id);
  if (!a || a.status !== "pending") return void res.status(409).json({ error: "not pending" });
  const signed = req.body?.signedEntryXdr;
  if (typeof signed !== "string" || !signed) return void res.status(400).json({ error: "missing signedEntryXdr" });
  a.signedEntryXdr = signed;
  a.status = "approved";
  console.log(`approved by the guardian's passkey: ${a.amountUsdc} USDC to ${a.merchant} (${a.id.slice(0, 8)})`);
  res.json({ ok: true });
});

app.post("/approvals/:id/reject", (req, res) => {
  const a = approvals.get(req.params.id);
  if (!a || a.status !== "pending") return void res.status(409).json({ error: "not pending" });
  a.status = "rejected";
  console.log(`rejected: ${a.amountUsdc} USDC to ${a.merchant} (${a.id.slice(0, 8)})`);
  res.json({ ok: true });
});

app.listen(PORT, "127.0.0.1", (err?: Error) => {
  if (err) {
    console.error(`GUARDIAN SERVICE FAILED TO START on port ${PORT}: ${err.message}`);
    console.error(`Stop the other process with:  lsof -ti tcp:${PORT} | xargs kill`);
    process.exit(1);
  }
  console.log(`ACAN guardian service on http://127.0.0.1:${PORT} (audit + approvals for the dashboard)`);
  console.log(process.env.CT_AUDITOR_SECRET ? "auditor key loaded: private spending is decrypted locally" : "no CT_AUDITOR_SECRET: private amounts stay hidden");
});
