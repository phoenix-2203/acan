import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createChat, type Tool } from "../src/llm.js";

const TOOLS: Tool[] = [
  { name: "buy", description: "buy", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
];
const realFetch = globalThis.fetch;
const env = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...env };
});

/** Replace fetch with a script of responses; records each request body. */
function mockFetch(responses: unknown[]) {
  const bodies: any[] = [];
  const urls: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init.body)));
    const next = responses.shift();
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { bodies, urls };
}

test("Groq (OpenAI-compatible): parses tool calls and sends results back by id", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OLLAMA_MODEL;
  process.env.GROQ_API_KEY = "test-key";
  const { bodies, urls } = mockFetch([
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Checking prices.",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "buy", arguments: '{"path":"/api/ledger"}' } }],
          },
        },
      ],
    },
    { choices: [{ message: { role: "assistant", content: "Done." } }] },
  ]);
  const chat = createChat("system prompt", TOOLS);
  assert.match(chat.label, /^Groq \(/);
  chat.say("task");
  const t1 = await chat.next();
  assert.equal(t1.text, "Checking prices.");
  assert.deepEqual(t1.calls, [{ id: "call_1", name: "buy", input: { path: "/api/ledger" } }]);
  chat.results([{ call: t1.calls[0], output: '{"ok":true}' }]);
  const t2 = await chat.next();
  assert.equal(t2.calls.length, 0);

  assert.equal(urls[0], "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(bodies[0].tools[0].function.name, "buy");
  assert.equal(bodies[0].messages[0].role, "system");
  const sent = bodies[1].messages;
  assert.deepEqual(sent[sent.length - 1], { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' });
  assert.equal(sent[sent.length - 2].tool_calls[0].id, "call_1");
});

test("Claude: tool_use blocks become calls; results go back as tool_result", async () => {
  delete process.env.GROQ_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  const { bodies } = mockFetch([
    {
      content: [
        { type: "text", text: "Buying." },
        { type: "tool_use", id: "toolu_1", name: "buy", input: { path: "/api/balance" } },
      ],
      stop_reason: "tool_use",
    },
    { content: [{ type: "text", text: "Finished." }], stop_reason: "end_turn" },
  ]);
  const chat = createChat("system prompt", TOOLS);
  chat.say("task");
  const t1 = await chat.next();
  assert.deepEqual(t1.calls, [{ id: "toolu_1", name: "buy", input: { path: "/api/balance" } }]);
  chat.results([{ call: t1.calls[0], output: "42" }]);
  await chat.next();
  assert.equal(bodies[0].system, "system prompt");
  assert.equal(bodies[0].tools[0].input_schema.type, "object");
  const last = bodies[1].messages[bodies[1].messages.length - 1];
  assert.deepEqual(last.content, [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }]);
});

test("a malformed tool-argument string does not crash the agent", async () => {
  process.env.GROQ_API_KEY = "test-key";
  mockFetch([
    { choices: [{ message: { content: "", tool_calls: [{ id: "c", type: "function", function: { name: "buy", arguments: "{not json" } }] } }] },
  ]);
  const chat = createChat("s", TOOLS);
  chat.say("t");
  const t = await chat.next();
  assert.deepEqual(t.calls[0].input, {});
});

test("no model configured gives a clear error", () => {
  delete process.env.GROQ_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OLLAMA_MODEL;
  assert.throws(() => createChat("s", TOOLS), /No model configured/);
});

test("Groq: retries a generation it could not parse, then succeeds", async () => {
  process.env.GROQ_API_KEY = "test-key";
  process.env.LLM_RETRY_DELAY_MS = "0";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ error: { code: "tool_use_failed", message: "Parsing failed. The model generated output that could not be parsed." } }),
        { status: 400 },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  }) as typeof fetch;
  const chat = createChat("s", TOOLS);
  chat.say("t");
  const t = await chat.next();
  assert.equal(t.text, "ok");
  assert.equal(calls, 2);
});

test("Groq: a real client error is not retried", async () => {
  process.env.GROQ_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 });
  }) as typeof fetch;
  const chat = createChat("s", TOOLS);
  chat.say("t");
  await assert.rejects(chat.next(), /401: Invalid API Key/);
  assert.equal(calls, 1);
});

test("rate limits wait as long as the API asks", async () => {
  const { retryAfterMs } = await import("../src/llm.js");
  const h = (v: string | null) => ({ headers: { get: () => v } });
  assert.equal(retryAfterMs(h("3"), {}), 3000);
  assert.equal(
    retryAfterMs(h(null), { error: { message: "Rate limit reached ... Please try again in 6.359999999s. Need more tokens?" } }),
    6610,
  );
  assert.equal(retryAfterMs(h(null), { error: { message: "try again in 450ms" } }), 700);
  assert.equal(retryAfterMs(h(null), { error: { message: "something else" } }), undefined);
});
