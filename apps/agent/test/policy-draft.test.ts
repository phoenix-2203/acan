import { test } from "node:test";
import assert from "node:assert/strict";
import type { Chat, Turn } from "../src/llm.js";
import { draftPolicy, normalizeDraft, type MerchantInfo } from "../src/policy-draft.js";

const M: MerchantInfo[] = [
  { url: "http://localhost:4021", name: "Northwind Data", payTo: "GNORTH", products: [{ path: "/api/ledger", price: "$0.01" }] },
  { url: "http://localhost:4022", name: "Southgate Data", payTo: "GSOUTH", products: [{ path: "/api/ledger", price: "$0.005" }] },
];

const once = (turns: Turn[]): Chat => ({
  label: "scripted",
  async next() {
    return turns.shift()!;
  },
  results() {},
  say() {},
});

test("“$5 for the next 24 hours” becomes a reviewable allowance with derived risk tiers", async () => {
  const d = await draftPolicy("Give my research agent $5 for the next 24 hours, small purchases only", M, {
    chatFactory: () =>
      once([
        { text: "", calls: [] }, // first answer forgets the tool: it is asked again
        {
          text: "",
          calls: [
            {
              id: "1",
              name: "propose_policy",
              input: {
                agentName: "ResearchBot",
                budgetUsdc: "$5",
                periodHours: 24,
                expiresInHours: 24,
                merchants: [{ url: "http://localhost:4021/" }, { url: "http://localhost:4022", capUsdc: "2" }, { url: "http://evil.example" }],
                maxPerPaymentUsdc: "0.50",
                summary: "ResearchBot may spend 5 USDC over 24 hours on data APIs.",
              },
            },
          ],
        },
      ]),
  });
  assert.equal(d.agentName, "ResearchBot");
  assert.equal(d.budgetUsdc, "5");
  assert.equal(d.expiresInHours, 24);
  assert.deepEqual(
    d.merchants.map((m) => [m.name, m.address, m.capUsdc]),
    [
      ["Northwind Data", "GNORTH", null],
      ["Southgate Data", "GSOUTH", "2"],
    ],
  );
  assert.equal(d.maxPerPaymentUsdc, "0.50");
  assert.match(d.notes.join(" "), /unknown merchant/);
  assert.match(d.tiers.auto, /up to 0.50 USDC per payment, to Northwind Data and Southgate Data, within 5 USDC per day/);
  assert.match(d.tiers.ask, /0.50 USDC in one payment, a merchant's cap, the 5 USDC budget/);
  assert.match(d.tiers.block, /any address not listed, and everything after 24 h/);
});

test("validation clamps what the model gets wrong", () => {
  const vault = { address: "GVAULT", name: "Agent's private vault" };
  const d = normalizeDraft(
    { budgetUsdc: "5000", periodHours: -3, expiresInHours: 99999, merchants: [], maxPerPaymentUsdc: "9000", privateMode: true },
    M,
    vault,
  );
  assert.equal(d.budgetUsdc, "100");
  assert.equal(d.periodHours, 24);
  assert.equal(d.expiresInHours, 720);
  assert.equal(d.maxPerPaymentUsdc, null);
  assert.deepEqual(d.merchants.map((m) => m.address), ["GVAULT"], "private mode allows the vault for top-ups");
  assert.match(d.notes.join(" "), /capped at 100/);
  assert.match(d.notes.join(" "), /No merchant matched/);
  assert.equal(normalizeDraft({ budgetUsdc: "abc" }, M).budgetUsdc, "1");
});
