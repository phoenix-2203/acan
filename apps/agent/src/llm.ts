/**
 * Minimal tool-calling chat over three providers, with no SDK dependency:
 *   - Groq (GROQ_API_KEY), OpenAI-compatible API, default model openai/gpt-oss-120b
 *   - Anthropic Messages API (ANTHROPIC_API_KEY), default model Claude Haiku 4.5
 *   - Ollama on this machine (OLLAMA_MODEL, e.g. qwen2.5:7b), free and local
 */
export interface Tool {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Turn {
  text: string;
  calls: ToolCall[];
}

export interface Chat {
  readonly label: string;
  /** Send the conversation so far; returns the model's text and tool calls. */
  next(): Promise<Turn>;
  /** Report tool results for the calls of the last turn. */
  results(results: { call: ToolCall; output: string }[]): void;
  /** Add a user message. */
  say(text: string): void;
}

export function createChat(system: string, tools: Tool[]): Chat {
  if (process.env.GROQ_API_KEY) {
    return new OpenAICompatibleChat(system, tools, {
      label: "Groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
    });
  }
  if (process.env.ANTHROPIC_API_KEY) return new AnthropicChat(system, tools);
  if (process.env.OLLAMA_MODEL) return new OllamaChat(system, tools);
  throw new Error(
    "No model configured. Put GROQ_API_KEY=... (Groq) or ANTHROPIC_API_KEY=... (Claude API) in .env, " +
      "or install Ollama and set OLLAMA_MODEL=qwen2.5:7b (free, local).",
  );
}

class AnthropicChat implements Chat {
  readonly model = process.env.AGENT_MODEL ?? "claude-haiku-4-5-20251001";
  readonly label = `Claude (${this.model})`;
  private messages: any[] = [];

  constructor(
    private readonly system: string,
    private readonly tools: Tool[],
  ) {}

  say(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  async next(): Promise<Turn> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: this.system,
        tools: this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        messages: this.messages,
      }),
    });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
    this.messages.push({ role: "assistant", content: body.content });
    const text = body.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    const calls = body.content
      .filter((b: any) => b.type === "tool_use")
      .map((b: any) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
    return { text, calls };
  }

  results(results: { call: ToolCall; output: string }[]): void {
    this.messages.push({
      role: "user",
      content: results.map((r) => ({ type: "tool_result", tool_use_id: r.call.id, content: r.output })),
    });
  }
}

class OllamaChat implements Chat {
  readonly model = process.env.OLLAMA_MODEL!;
  readonly label = `Ollama (${this.model})`;
  private readonly url = process.env.OLLAMA_URL ?? "http://localhost:11434";
  private messages: any[];
  private counter = 0;

  constructor(
    system: string,
    private readonly tools: Tool[],
  ) {
    this.messages = [{ role: "system", content: system }];
  }

  say(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  async next(): Promise<Turn> {
    const res = await fetch(`${this.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: this.messages,
        tools: this.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
    });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${body?.error ?? JSON.stringify(body).slice(0, 300)}`);
    const msg = body.message ?? {};
    this.messages.push(msg);
    const calls = (msg.tool_calls ?? []).map((c: any) => ({
      id: `call_${++this.counter}`,
      name: c.function?.name,
      input: typeof c.function?.arguments === "string" ? JSON.parse(c.function.arguments) : (c.function?.arguments ?? {}),
    }));
    return { text: msg.content ?? "", calls };
  }

  results(results: { call: ToolCall; output: string }[]): void {
    for (const r of results) this.messages.push({ role: "tool", tool_name: r.call.name, content: r.output });
  }
}

/** Any OpenAI-compatible chat-completions endpoint with function calling (used for Groq). */
class OpenAICompatibleChat implements Chat {
  readonly label: string;
  private messages: any[];

  constructor(
    system: string,
    private readonly tools: Tool[],
    private readonly cfg: { label: string; url: string; key: string; model: string },
  ) {
    this.label = `${cfg.label} (${cfg.model})`;
    this.messages = [{ role: "system", content: system }];
  }

  say(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  async next(): Promise<Turn> {
    const res = await fetch(this.cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.key}` },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: this.messages,
        tools: this.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: "auto",
        temperature: 0.2,
        max_completion_tokens: 1024,
      }),
    });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(`${this.cfg.label} API ${res.status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
    const msg = body.choices?.[0]?.message ?? {};
    // Keep only the fields the API accepts back in the history.
    this.messages.push({
      role: "assistant",
      content: msg.content ?? "",
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    });
    const calls = (msg.tool_calls ?? []).map((c: any) => {
      let input: Record<string, unknown> = {};
      try {
        input = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
      } catch {
        input = {};
      }
      return { id: c.id, name: c.function?.name, input };
    });
    return { text: msg.content ?? "", calls };
  }

  results(results: { call: ToolCall; output: string }[]): void {
    for (const r of results) this.messages.push({ role: "tool", tool_call_id: r.call.id, content: r.output });
  }
}
