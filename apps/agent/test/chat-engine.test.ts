import { test } from "node:test";
import assert from "node:assert/strict";
import type { Chat, Turn } from "../src/llm.js";
import { ChatEngine, type ChatWallet } from "../src/chat-engine.js";
import type { Purchase } from "../src/wallet.js";

const A = "http://localhost:4021";
const B = "http://localhost:4022";
const CATALOGS: Record<string, any> = {
  [A]: { name: "Northwind Data", payTo: "GA_NORTH", products: [{ path: "/api/ledger", price: "$0.01" }] },
  [B]: { name: "Southgate Data", payTo: "GB_SOUTH", products: [{ path: "/api/ledger", price: "$0.005" }] },
};
const fakeFetch = (async (url: string) => new Response(JSON.stringify(CATALOGS[url]))) as typeof fetch;

/** A model that plays a fixed script of turns and records what it was told. */
function scripted(turns: Turn[]) {
  const said: string[] = [];
  const results: string[] = [];
  const chat: Chat = {
    label: "scripted",
    async next() {
      const t = turns.shift();
      if (!t) throw new Error("script ran out");
      return t;
    },
    results(r) {
      results.push(...r.map((x) => x.output));
    },
    say(text) {
      said.push(text);
    },
  };
  return { chat, said, results };
}

function wallet(outcome: Purchase["status"] = "paid") {
  const calls: { kind: string; url: string; pin?: string }[] = [];
  const w: ChatWallet = {
    async buy(url, pin) {
      calls.push({ kind: "buy", url, pin });
      return outcome === "paid"
        ? { ok: true, status: "paid", url, priceUsdc: "0.005", receipt: "tx1", data: { sequence: 42 } }
        : { ok: false, status: outcome, url, priceUsdc: "0.005", reason: "SpendingLimitExceeded" };
    },
    async requestApproval(url, _reason, _t, pin) {
      calls.push({ kind: "approve", url, pin });
      return { ok: true, status: "paid", url, priceUsdc: "0.005", receipt: "tx2", data: { sequence: 43 } };
    },
    async allowance() {
      return { limitUsdc: "0.2", spentUsdc: "0.005", remainingUsdc: "0.195", periodLedgers: 17280 };
    },
  };
  return { w, calls };
}

const offerTurn = (extra: any[] = []): Turn => ({
  text: "Two merchants sell it.",
  calls: [
    {
      id: "c2",
      name: "offer_options",
      input: {
        question: "Which one?",
        options: [
          { label: "Southgate: ledger", merchant: B, path: "/api/ledger" },
          { label: "Northwind: ledger", merchant: A, path: "/api/ledger" },
          ...extra,
          { label: "Cancel", reply: "Never mind." },
        ],
      },
    },
  ],
});

test("the model proposes, the user picks, the wallet pays at the pinned address", async () => {
  const s = scripted([
    { text: "", calls: [{ id: "c1", name: "list_merchants", input: {} }] },
    offerTurn([{ label: "Evil", merchant: "http://evil.example", path: "/api/ledger" }]),
    { text: "The latest ledger is 42. You spent 0.005 USDC.", calls: [] },
  ]);
  const { w, calls } = wallet();
  const e = new ChatEngine({ wallet: w, merchants: [A, B], pins: new Map([[B, "GB_PINNED"]]), chatFactory: () => s.chat, fetchImpl: fakeFetch });

  await e.send("latest ledger, cheapest please");
  const offered = e.pendingOptions!;
  assert.equal(offered.options.length, 3, "the unknown merchant was dropped");
  assert.equal(offered.options[0].detail, "0.005 USDC · Southgate Data", "price comes from the catalog");
  assert.equal(calls.length, 0, "nothing is bought before the user picks");
  assert.match(s.results.at(-1)!, /dropped/);

  await e.choose(offered.id, offered.options[0].id);
  assert.deepEqual(calls, [{ kind: "buy", url: `${B}/api/ledger`, pin: "GB_PINNED" }]);
  assert.match(s.said.at(-1)!, /I picked "Southgate: ledger".*untrustedData/);
  const types = e.events.map((x) => x.type);
  assert.deepEqual(types, ["user", "activity", "agent", "options", "chosen", "payment", "agent", "budget"]);
  assert.equal(e.pendingOptions, undefined);
});

test("a refused payment is offered to the guardian for a passkey approval", async () => {
  const s = scripted([
    { text: "", calls: [{ id: "c1", name: "list_merchants", input: {} }] },
    offerTurn(),
    { text: "Approved and bought: ledger 43.", calls: [] },
  ]);
  const { w, calls } = wallet("blocked");
  const e = new ChatEngine({ wallet: w, merchants: [A, B], pins: new Map(), chatFactory: () => s.chat, fetchImpl: fakeFetch });
  await e.send("ledger");
  await e.choose(e.pendingOptions!.id, e.pendingOptions!.options[0].id);
  const approval = e.pendingOptions!;
  assert.equal(approval.options[0].action.kind, "approve");
  await e.choose(approval.id, approval.options[0].id);
  assert.deepEqual(calls.map((c) => c.kind), ["buy", "approve"]);
  assert.equal(calls[1].pin, "GB_SOUTH", "unpinned merchants use the catalog address");
});

test("stale or unknown choices are refused, and the model cannot buy without autopilot", async () => {
  const s = scripted([
    { text: "", calls: [{ id: "c1", name: "buy", input: { merchant: B, path: "/api/ledger" } }] },
    { text: "I need you to pick.", calls: [] },
  ]);
  const { w, calls } = wallet();
  const e = new ChatEngine({ wallet: w, merchants: [A, B], pins: new Map(), chatFactory: () => s.chat, fetchImpl: fakeFetch });
  await e.send("just buy it");
  assert.equal(calls.length, 0);
  assert.match(s.results[0], /autopilot is off/);
  await e.choose("o99", "o99.1");
  assert.match((e.events.at(-1) as any).text, /no longer open/);
});
