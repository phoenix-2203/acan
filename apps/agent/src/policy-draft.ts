/**
 * Plain-language policies: "Give my research agent $5 for the next 24 hours"
 * becomes a concrete, reviewable allowance (budget, period, expiry, allowed
 * merchants and their caps, per-payment limit). The model only drafts it;
 * every number is validated and clamped here, the risk tiers are derived
 * from the numbers (not written by the model), and nothing takes effect
 * until the guardian approves the card with their passkey.
 */
import { usdcToStroops } from "@acan/core";
import { createChat, type Chat, type Tool } from "./llm.js";

export interface MerchantInfo {
  url: string;
  name: string;
  payTo: string;
  products: { path: string; description?: string; price: string }[];
}

export interface PolicyDraft {
  agentName: string;
  /** Spending limit per period, USDC. */
  budgetUsdc: string;
  /** Rolling period of the spending limit, hours. */
  periodHours: number;
  /** Hours until the rule expires on its own; 0 = never. */
  expiresInHours: number;
  merchants: { url: string; name: string; address: string; capUsdc: string | null }[];
  /** Largest single payment the agent may make alone, USDC; null = no limit. */
  maxPerPaymentUsdc: string | null;
  /** Payments per period; 0 = no limit. */
  maxPayments: number;
  /** Pay with private tabs (confidential settlement): the vault must be allowed too. */
  privateMode: boolean;
  /** The model's one-line reading of the request. */
  summary: string;
  /** Derived from the numbers, never from the model. */
  tiers: { auto: string; ask: string; block: string };
  /** Anything the validation changed or dropped. */
  notes: string[];
}

export const LIMITS = { maxBudgetUsdc: 100, maxHours: 24 * 30 };

const TOOL: Tool = {
  name: "propose_policy",
  description: "Propose the allowance that matches the guardian's request.",
  parameters: {
    type: "object",
    properties: {
      agentName: { type: "string", description: "Short name for the agent, e.g. ResearchBot" },
      budgetUsdc: { type: "string", description: "Spending limit per period in USDC, e.g. '5' or '0.20'" },
      periodHours: { type: "number", description: "Length of the spending period in hours (24 for 'per day'; equal to the duration for a one-off budget)" },
      expiresInHours: { type: "number", description: "Hours until the allowance ends on its own; 0 if the user wants no end" },
      merchants: {
        type: "array",
        description: "Merchants the agent may pay (base URLs exactly as listed), each with an optional cap in USDC per period",
        items: {
          type: "object",
          properties: { url: { type: "string" }, capUsdc: { type: "string", description: "Optional per-merchant cap in USDC per period" } },
          required: ["url"],
        },
      },
      maxPerPaymentUsdc: { type: "string", description: "Largest single payment the agent may make without asking, in USDC; omit for no limit" },
      maxPayments: { type: "number", description: "Payments allowed per period; 0 for no limit" },
      privateMode: { type: "boolean", description: "True if the user wants private / confidential payments" },
      summary: { type: "string", description: "One sentence restating the request" },
    },
    required: ["agentName", "budgetUsdc", "periodHours", "expiresInHours", "merchants", "summary"],
  },
};

function system(merchants: MerchantInfo[]): string {
  const list = merchants
    .map((m) => `- ${m.url} (${m.name}): ${m.products.map((p) => `${p.path} ${p.price}${p.description ? ` ${p.description}` : ""}`).join("; ")}`)
    .join("\n");
  return `You turn a guardian's plain-language request into an allowance for their AI agent. Call propose_policy exactly once.

Available merchants (all sell data APIs):
${list}

Rules:
- Use only the merchants listed. If the request names a kind of merchant ("data APIs", "search"), pick the listed merchants that fit; if none fit, pick none.
- "$5 for the next 24 hours" means budgetUsdc "5", periodHours 24, expiresInHours 24. "$1 a day" with no end means periodHours 24, expiresInHours 0.
- Only set maxPerPaymentUsdc, per-merchant caps or maxPayments if the request asks for them, or if a sensible per-payment limit is implied (e.g. "small purchases only").
- Amounts are USDC; "$" means USDC.`;
}

/** Ask the model for a draft, then validate and normalize it. */
export async function draftPolicy(
  request: string,
  merchants: MerchantInfo[],
  opts: { chatFactory?: (system: string, tools: Tool[]) => Chat; vault?: { address: string; name: string } } = {},
): Promise<PolicyDraft> {
  const chat = (opts.chatFactory ?? createChat)(system(merchants), [TOOL]);
  chat.say(request.slice(0, 1000));
  for (let attempt = 0; attempt < 3; attempt++) {
    const turn = await chat.next();
    const call = turn.calls.find((c) => c.name === "propose_policy");
    if (call) return normalizeDraft(call.input, merchants, opts.vault);
    if (turn.calls.length) chat.results(turn.calls.map((c) => ({ call: c, output: JSON.stringify({ error: "call propose_policy" }) })));
    else chat.say("Call propose_policy now.");
  }
  throw new Error("The model did not propose a policy; try rephrasing the request.");
}

const usdc = (v: unknown): string | null => {
  const s = String(v ?? "").trim().replace(/^\$/, "");
  if (!s) return null;
  try {
    return usdcToStroops(s) > 0n ? s : null;
  } catch {
    return null;
  }
};
const hours = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n * 100) / 100, LIMITS.maxHours) : fallback;
};

/** Validate and clamp a model's proposal. Exported for tests. */
export function normalizeDraft(input: Record<string, any>, merchants: MerchantInfo[], vault?: { address: string; name: string }): PolicyDraft {
  const notes: string[] = [];
  let budget = usdc(input.budgetUsdc);
  if (!budget) {
    budget = "1";
    notes.push("No valid budget in the request; set to 1 USDC. Adjust it before approving.");
  }
  if (usdcToStroops(budget) > usdcToStroops(String(LIMITS.maxBudgetUsdc))) {
    notes.push(`Budget capped at ${LIMITS.maxBudgetUsdc} USDC.`);
    budget = String(LIMITS.maxBudgetUsdc);
  }
  let periodHours = hours(input.periodHours, 24);
  if (periodHours <= 0) periodHours = 24;
  const expiresInHours = hours(input.expiresInHours, 0);

  const byUrl = new Map(merchants.map((m) => [m.url.replace(/\/$/, ""), m]));
  const chosen: PolicyDraft["merchants"] = [];
  for (const m of Array.isArray(input.merchants) ? input.merchants : []) {
    const info = byUrl.get(String(m?.url ?? "").replace(/\/$/, ""));
    if (!info) {
      notes.push(`Dropped unknown merchant ${JSON.stringify(m?.url ?? m)}.`);
      continue;
    }
    if (chosen.some((c) => c.url === info.url)) continue;
    chosen.push({ url: info.url, name: info.name, address: info.payTo, capUsdc: usdc(m?.capUsdc) });
  }
  if (chosen.length === 0) notes.push("No merchant matched the request: the agent could not pay anyone. Pick merchants before approving.");

  const privateMode = input.privateMode === true;
  if (privateMode && vault) {
    // Private payments are funded by top-ups into the agent's vault, so the vault must be an allowed recipient.
    chosen.push({ url: "", name: vault.name, address: vault.address, capUsdc: null });
  }

  let maxPerPaymentUsdc = usdc(input.maxPerPaymentUsdc);
  if (maxPerPaymentUsdc && usdcToStroops(maxPerPaymentUsdc) > usdcToStroops(budget)) {
    notes.push("The per-payment limit was above the budget; removed.");
    maxPerPaymentUsdc = null;
  }
  const maxPayments = Number.isInteger(input.maxPayments) && input.maxPayments > 0 ? Math.min(input.maxPayments, 1000) : 0;

  const period = periodHours === 24 ? "per day" : `per ${periodHours} h`;
  const shops = chosen.filter((c) => c.url).map((c) => c.name).join(" and ") || "no merchant";
  const tiers = {
    auto: `Pays on its own: ${maxPerPaymentUsdc ? `up to ${maxPerPaymentUsdc} USDC per payment, ` : ""}to ${shops}, within ${budget} USDC ${period}${
      chosen.some((c) => c.capUsdc) ? " and each merchant's cap" : ""
    }.`,
    ask: `Asks you (passkey): anything over ${[
      maxPerPaymentUsdc ? `${maxPerPaymentUsdc} USDC in one payment` : null,
      chosen.some((c) => c.capUsdc) ? "a merchant's cap" : null,
      `the ${budget} USDC budget`,
    ]
      .filter(Boolean)
      .join(", ")}.`,
    block: `Refused on-chain: any address not listed${expiresInHours ? `, and everything after ${expiresInHours} h` : ""}, or after you revoke it.`,
  };

  return {
    agentName: String(input.agentName ?? "Agent").replace(/[^\w .-]/g, "").slice(0, 40) || "Agent",
    budgetUsdc: budget,
    periodHours,
    expiresInHours,
    merchants: chosen,
    maxPerPaymentUsdc,
    maxPayments,
    privateMode,
    summary: String(input.summary ?? "").slice(0, 300),
    tiers,
    notes,
  };
}
