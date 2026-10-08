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
 *   POST /budgets               the agent asks for a task budget (amount, duration, merchants)
 *   GET  /budgets               pending and recent budget requests
 *   GET  /budgets/:id           one request's status, with the new rule id once approved
 *   POST /budgets/:id/approve   the dashboard reports the rule it created with the passkey
 *   POST /budgets/:id/reject
 *   POST /freeze                {frozen: boolean} while frozen, agent requests are
 *                               refused and pending ones are rejected
 *
 * The service never signs anything, and never creates rules. Approval happens in the browser with the
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
/** Freeze switch: while on, no agent request reaches the guardian. */
let frozen = false;

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
    frozen,
    allowlistPolicy: process.env.ALLOWLIST_POLICY || null,
    // v0.3 adds the per-payment limit; set by npm run allowlist:deploy.
    allowlistPolicyVersion: process.env.ALLOWLIST_POLICY_VERSION || "0.2",
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

app.post("/freeze", (req, res) => {
  if (typeof req.body?.frozen !== "boolean") return void res.status(400).json({ error: "body must be {frozen: boolean}" });
  frozen = req.body.frozen;
  if (frozen) {
    for (const a of approvals.values()) if (a.status === "pending") a.status = "rejected";
    for (const b of budgets.values()) if (b.status === "pending") b.status = "rejected";
  }
  console.log(frozen ? "FROZEN: agent requests are refused and pending ones were rejected" : "unfrozen: agent requests accepted again");
  res.json({ frozen });
});

/** Refuse agent requests while the guardian has frozen them. */
const refuseIfFrozen = (res: express.Response): boolean => {
  if (!frozen) return false;
  res.status(423).json({ error: "the guardian has frozen agent requests" });
  return true;
};

app.post("/approvals", (req, res) => {
  if (refuseIfFrozen(res)) return;
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

// ---- task budgets ----------------------------------------------------------

interface BudgetRequest {
  id: string;
  createdAt: number;
  status: "pending" | "approved" | "rejected" | "expired";
  /** The agent's public key (the signer for the new rule). */
  agentKey: string;
  /** atomic units, total for the task */
  amount: string;
  amountUsdc: string;
  minutes: number;
  recipients: { address: string; label: string }[];
  task: string;
  reason: string;
  /** The context rule the guardian created for this budget. */
  ruleId?: number;
}
const budgets = new Map<string, BudgetRequest>();
const MAX_BUDGET_MINUTES = 24 * 60;

function expireBudgets() {
  const now = Date.now();
  for (const b of budgets.values()) {
    if (b.status === "pending" && now - b.createdAt > APPROVAL_TTL_MS) b.status = "expired";
  }
}

app.post("/budgets", (req, res) => {
  if (refuseIfFrozen(res)) return;
  const b = req.body ?? {};
  if (typeof b.agentKey !== "string" || !/^G[A-Z2-7]{55}$/.test(b.agentKey)) {
    return void res.status(400).json({ error: "bad agentKey" });
  }
  if (typeof b.amount !== "string" || !/^\d+$/.test(b.amount) || BigInt(b.amount) <= 0n) {
    return void res.status(400).json({ error: "bad amount" });
  }
  if (!Number.isInteger(b.minutes) || b.minutes < 1 || b.minutes > MAX_BUDGET_MINUTES) {
    return void res.status(400).json({ error: `minutes must be 1-${MAX_BUDGET_MINUTES}` });
  }
  if (!Array.isArray(b.recipients) || b.recipients.length === 0 || b.recipients.length > 20) {
    return void res.status(400).json({ error: "recipients must list 1-20 addresses" });
  }
  for (const r of b.recipients) {
    if (typeof r?.address !== "string" || !/^[GC][A-Z2-7]{55}$/.test(r.address)) {
      return void res.status(400).json({ error: "bad recipient address" });
    }
  }
  const req2: BudgetRequest = {
    id: randomUUID(),
    createdAt: Date.now(),
    status: "pending",
    agentKey: b.agentKey,
    amount: b.amount,
    amountUsdc: stroopsToUsdc(b.amount),
    minutes: b.minutes,
    recipients: b.recipients.map((r: any) => ({ address: r.address, label: String(r.label ?? "").slice(0, 80) })),
    task: String(b.task ?? "").slice(0, 500),
    reason: String(b.reason ?? "").slice(0, 500),
  };
  budgets.set(req2.id, req2);
  console.log(`budget requested: ${req2.amountUsdc} USDC for ${req2.minutes} min (${req2.id.slice(0, 8)}) — "${req2.reason}"`);
  res.status(201).json({ id: req2.id });
});

app.get("/budgets", (_req, res) => {
  expireBudgets();
  res.json([...budgets.values()].sort((x, y) => y.createdAt - x.createdAt).slice(0, 20));
});

app.get("/budgets/:id", (req, res) => {
  expireBudgets();
  const b = budgets.get(req.params.id);
  if (!b) return void res.status(404).json({ error: "unknown budget request" });
  res.json(b);
});

app.post("/budgets/:id/approve", (req, res) => {
  const b = budgets.get(req.params.id);
  if (!b || b.status !== "pending") return void res.status(409).json({ error: "not pending" });
  const ruleId = req.body?.ruleId;
  if (!Number.isInteger(ruleId) || ruleId < 0) return void res.status(400).json({ error: "missing ruleId" });
  b.ruleId = ruleId;
  b.status = "approved";
  console.log(`budget approved with the guardian's passkey: rule #${ruleId}, ${b.amountUsdc} USDC for ${b.minutes} min`);
  res.json({ ok: true });
});

app.post("/budgets/:id/reject", (req, res) => {
  const b = budgets.get(req.params.id);
  if (!b || b.status !== "pending") return void res.status(409).json({ error: "not pending" });
  b.status = "rejected";
  console.log(`budget rejected (${b.id.slice(0, 8)})`);
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
