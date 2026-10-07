/**
 * ACAN AI agent: a language model decides what to buy, from whom, and when to
 * stop. It can only spend through the guardian's smart account rule, so the
 * on-chain allowance bounds it no matter what the model decides.
 *
 * Usage:
 *   npm run agent:ai                         # default task, public payments
 *   npm run agent:ai -- --private            # pay with tab vouchers, settle confidentially
 *   npm run agent:ai -- "your task here" [--private]
 *
 * Model: GROQ_API_KEY (Groq), ANTHROPIC_API_KEY (Claude) or OLLAMA_MODEL (local) in .env.
 */
import { loadEnv } from "@acan/core";
import { createChat, type Tool, type ToolCall } from "./llm.js";
import { AgentWallet, type Mode } from "./wallet.js";

loadEnv();

const args = process.argv.slice(2);
const mode: Mode = args.includes("--private") ? "private" : "public";
const taskArg = args.filter((a) => !a.startsWith("--")).join(" ").trim();
const MERCHANTS = (process.env.MERCHANT_URLS ?? "http://localhost:4021,http://localhost:4022")
  .split(",")
  .map((u) => u.trim().replace(/\/$/, ""))
  .filter(Boolean);
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 12);

const TASK =
  taskArg ||
  `Find out (1) the latest Stellar testnet ledger sequence and (2) the USDC balance of account ${
    process.env.TREASURY_ADDRESS ?? "<TREASURY_ADDRESS>"
  }. Buy each piece of data from whichever merchant sells it cheapest, and report what you spent.`;

const SYSTEM = `You are a purchasing agent for a person (your guardian). You buy data from paid APIs that use the x402 payment protocol on Stellar.

Rules:
- Your money comes from your guardian's smart account. You can only spend within an allowance the guardian set; the account itself refuses anything beyond it.
- Spend as little as possible. Compare merchants' catalogs and buy each item from the cheapest one that sells it.
- Only buy what the task needs. Never buy the same item twice unless a purchase failed.
- If a purchase is blocked because the allowance is used up, do not retry it. If that item is essential to the task, you may call request_approval once for it, with a one-sentence reason the guardian will read; the guardian approves or rejects it with their passkey. Otherwise stop and explain.
- When done, call finish with a short answer to the task, and list each purchase with its merchant and price.

Payment mode for this run: ${mode === "private" ? "private (signed tab vouchers per request, settled later in confidential transfers whose amounts are hidden on-chain)" : "public (one on-chain USDC transfer per request)"}.`;

const TOOLS: Tool[] = [
  {
    name: "list_merchants",
    description: "List the known merchants with their catalogs: product paths, descriptions and prices in USDC.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "check_budget",
    description: "Check how much of the guardian's allowance is left in the current period.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "buy",
    description:
      "Buy one product from one merchant. Pays automatically over x402 and returns the data. For /api/balance pass the account as the query.",
    parameters: {
      type: "object",
      properties: {
        merchant: { type: "string", description: "Merchant base URL exactly as listed, e.g. http://localhost:4021" },
        path: { type: "string", description: "Product path, e.g. /api/ledger" },
        query: { type: "string", description: "Optional query string without '?', e.g. account=G..." },
      },
      required: ["merchant", "path"],
    },
  },
  {
    name: "request_approval",
    description:
      "Ask the guardian to approve one specific purchase that your allowance blocked. Waits up to 4 minutes for their decision, then pays if approved.",
    parameters: {
      type: "object",
      properties: {
        merchant: { type: "string", description: "Merchant base URL exactly as listed" },
        path: { type: "string", description: "Product path, e.g. /api/balance" },
        query: { type: "string", description: "Optional query string without '?'" },
        reason: { type: "string", description: "One sentence for the guardian: why this purchase is needed" },
      },
      required: ["merchant", "path", "reason"],
    },
  },
  {
    name: "finish",
    description: "End the task with the final answer for the guardian.",
    parameters: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
  },
];

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const ts = () => new Date().toISOString().slice(11, 19);
const log = (s: string) => console.log(`${dim(ts())} ${s}`);

const wallet = new AgentWallet(mode, (l) => log(l));
const spent: { merchant: string; path: string; price: string; receipt?: string }[] = [];
const merchantsUsed = new Set<string>();
let approvalsAsked = 0;
/** URLs whose purchase the smart account refused: the only ones approval may be asked for. */
const blocked = new Set<string>();
let catalogs: Record<string, any> = {};

async function runTool(call: ToolCall): Promise<{ output: string; done?: string }> {
  switch (call.name) {
    case "list_merchants": {
      const list = await Promise.all(
        MERCHANTS.map(async (url) => {
          try {
            const c = await (await fetch(url)).json();
            catalogs[url] = c;
            return { merchant: url, name: c.name, products: c.products, schemes: c.schemes };
          } catch {
            return { merchant: url, error: "unreachable" };
          }
        }),
      );
      for (const m of list) {
        if ("products" in m && m.products) {
          log(`   ${m.name} (${m.merchant}): ${m.products.map((p: any) => `${p.path} ${p.price}`).join(", ")}`);
        }
      }
      return { output: JSON.stringify(list) };
    }
    case "check_budget": {
      const a = await wallet.allowance();
      const vault = await wallet.vaultSpendable();
      log(`   allowance left ${a.remainingUsdc} of ${a.limitUsdc} USDC${vault ? `, private vault ${vault} USDC` : ""}`);
      return { output: JSON.stringify({ ...a, privateVaultUsdc: vault }) };
    }
    case "buy":
    case "request_approval": {
      const merchant = String(call.input.merchant ?? "").replace(/\/$/, "");
      const path = String(call.input.path ?? "");
      const query = String(call.input.query ?? "").replace(/^\?/, "");
      // The model's arguments are untrusted: only listed merchants and plain product paths.
      if (!MERCHANTS.includes(merchant)) {
        log(`   ${bold("REJECTED")} unknown merchant ${JSON.stringify(merchant)} (not paid)`);
        return { output: JSON.stringify({ error: `unknown merchant ${merchant}; use a URL exactly as listed` }) };
      }
      if (!/^\/api\/[a-z-]+$/.test(path)) {
        log(`   ${bold("REJECTED")} invalid path ${JSON.stringify(path)} (not paid)`);
        return { output: JSON.stringify({ error: `invalid path ${path}` }) };
      }
      if (mode === "private" && !merchantsUsed.has(merchant)) await wallet.syncTab(merchant);
      const url = `${merchant}${path}${query ? `?${query}` : ""}`;
      if (call.name === "request_approval") {
        // Enforced here, not left to the prompt: approval is only for a purchase
        // the allowance actually refused, and only once per run.
        if (!blocked.has(url)) {
          log(`   ${bold("REJECTED")} approval request for ${path}: buy it first; ask only if the allowance blocks it`);
          return { output: JSON.stringify({ error: "request_approval is only allowed after buy was blocked for this exact purchase; call buy first" }) };
        }
        if (approvalsAsked++ > 0) {
          log(`   ${bold("REJECTED")} second approval request (one per run)`);
          return { output: JSON.stringify({ error: "only one approval request per run" }) };
        }
      }
      const r =
        call.name === "buy"
          ? await wallet.buy(url)
          : await wallet.requestApproval(url, String(call.input.reason ?? "").slice(0, 300) || "(no reason given)");
      const name = catalogs[merchant]?.name ?? merchant;
      if (r.ok) {
        if (r.scheme !== "exact (guardian-approved)") merchantsUsed.add(merchant);
        spent.push({ merchant: name, path, price: r.priceUsdc ?? "?", receipt: r.receipt });
        log(`   ${bold("PAID")} ${r.priceUsdc} USDC to ${name} for ${path}  ${dim(r.receipt ?? "")}`);
      } else {
        if (r.status === "blocked") blocked.add(url);
        log(`   ${bold(r.status.toUpperCase())} ${path} at ${name}: ${r.reason}`);
      }
      return { output: JSON.stringify(r.ok ? { paidUsdc: r.priceUsdc, data: r.data } : { status: r.status, reason: r.reason }) };
    }
    case "finish":
      return { output: "ok", done: String(call.input.answer ?? "") };
    default:
      return { output: JSON.stringify({ error: `unknown tool ${call.name}` }) };
  }
}

async function main() {
  const chat = createChat(SYSTEM, TOOLS);
  console.log(bold(`ACAN AI agent  (${chat.label}, ${mode} payments)`));
  console.log(`smart account ${wallet.smartAccount}, rule ${wallet.ruleId}`);
  const a = await wallet.allowance();
  console.log(`allowance left ${a.remainingUsdc} of ${a.limitUsdc} USDC this period\n`);
  console.log(`${bold("Task:")} ${TASK}\n`);
  chat.say(TASK);

  let answer: string | undefined;
  let failure: unknown;
  try {
    for (let step = 1; step <= MAX_STEPS && answer === undefined; step++) {
      const turn = await chat.next();
      if (turn.text.trim()) log(`${bold("agent:")} ${turn.text.trim()}`);
      if (turn.calls.length === 0) {
        chat.say("Continue: use a tool, or call finish when done.");
        continue;
      }
      const results = [];
      for (const call of turn.calls) {
        const args = Object.keys(call.input).length ? ` ${dim(JSON.stringify(call.input))}` : "";
        log(`-> ${call.name}${args}`);
        const r = await runTool(call);
        if (r.done !== undefined) answer = r.done;
        results.push({ call, output: r.output });
      }
      chat.results(results);
    }
  } catch (e) {
    // The model or its API failed mid-run. Purchases already made are real:
    // still settle what is owed and report it, then exit with the error.
    failure = e;
    console.error(`\n${bold("Model error:")} ${e instanceof Error ? e.message : e}`);
  }
  try {
    if (mode === "private") {
      for (const m of merchantsUsed) await wallet.closeTab(m);
    }
  } finally {
    await wallet.close();
  }

  console.log(`\n${bold("Answer:")} ${answer ?? "(the agent stopped without finishing)"}`);
  const total = spent.reduce((s, p) => s + Number(p.price), 0);
  console.log(`\n${bold("Spent")} ${total.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")} USDC in ${spent.length} purchase(s):`);
  for (const p of spent) console.log(`  ${p.price.padEnd(7)} ${p.merchant.padEnd(16)} ${p.path}`);
  if (mode === "private") {
    console.log(
      `${wallet.settlements.length} confidential settlement transfer(s) on-chain; amounts hidden. ` +
        "The guardian can decrypt them with `npm run audit`.",
    );
  }
  const after = await wallet.allowance();
  console.log(`allowance left ${after.remainingUsdc} of ${after.limitUsdc} USDC`);
  if (failure) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(`\nAI AGENT FAILED: ${e instanceof Error ? e.stack ?? e.message : e}`);
  await wallet.close().catch(() => undefined);
  process.exit(1);
});
