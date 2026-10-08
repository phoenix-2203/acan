/**
 * The sandbox's AI agent, running in the visitor's browser.
 *
 * The model (behind ACAN's relay, which holds the API key) only talks and
 * proposes. Its tools run here: it reads the demo shops, reads the allowance
 * from the visitor's own smart account, and offers choices. When the visitor
 * picks one, the payment is signed in this browser with the visitor's own
 * agent key and the smart account's policies decide. Prices on the buttons
 * come from the shop catalog below, never from the model.
 */

export interface ShopItem {
  id: string;
  title: string;
  priceXlm: string;
}

export interface DemoShop {
  name: string;
  address: string;
  items: ShopItem[];
}

export type PayResult =
  | { ok: true; tx: string }
  | { ok: false; refused: boolean; code: number | null; reason: string; title?: string; policy?: string };

/** What the agent needs from the page. */
export interface AgentHost {
  shops(): DemoShop[];
  allowance(): Promise<{ limitXlm: string; spentXlm: string; leftXlm: string } | null>;
  /** Pay from the visitor's smart account under the agent's rule. The page shows the full result card. */
  pay(to: string, stroops: bigint, label: string): Promise<PayResult>;
}

export type AiAction =
  | { kind: "buy"; shop: string; address: string; item: ShopItem }
  | { kind: "send"; to: string; amountXlm: string; recipient: string }
  | { kind: "say"; text: string };

export interface AiOption {
  id: string;
  label: string;
  detail?: string;
  action: AiAction;
}

export type AiEvent = { seq: number } & (
  | { type: "user" | "agent" | "activity" | "error"; text: string }
  | { type: "options"; id: string; question: string; options: AiOption[] }
  | { type: "chosen"; label: string }
  | { type: "payment"; ok: boolean; text: string; tx?: string }
);
type NewEvent = AiEvent extends infer E ? (E extends AiEvent ? Omit<E, "seq"> : never) : never;

interface Msg {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export const xlmToStroops = (s: string): bigint => {
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 10_000_000n + BigInt((f + "0000000").slice(0, 7));
};

const shortAddr = (a: string) => `${a.slice(0, 5)}…${a.slice(-4)}`;

export class SandboxAgent {
  events: AiEvent[] = [];
  pending?: { id: string; options: AiOption[] };
  busy = false;
  /** Messages the relay still allows this visitor today, once known. */
  messagesLeft?: number;
  onChange?: () => void;
  private messages: Msg[] = [];
  private seq = 0;
  private optionSets = 0;

  constructor(
    private readonly relayUrl: string,
    private readonly host: AgentHost,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  /** The visitor types something. */
  async send(text: string): Promise<void> {
    const t = text.trim().slice(0, 1000);
    if (!t || this.busy) return;
    await this.exclusive(async () => {
      this.pending = undefined;
      this.emit({ type: "user", text: t });
      this.messages.push({ role: "user", content: t });
      await this.loop();
    });
  }

  /** The visitor picks one of the offered options. */
  async choose(optionId: string): Promise<void> {
    if (this.busy) return;
    const option = this.pending?.options.find((o) => o.id === optionId);
    if (!option) return;
    await this.exclusive(async () => {
      this.pending = undefined;
      this.emit({ type: "chosen", label: option.label });
      const a = option.action;
      if (a.kind === "say") {
        this.messages.push({ role: "user", content: a.text });
        return this.loop();
      }
      const [to, amountXlm, what] =
        a.kind === "buy" ? [a.address, a.item.priceXlm, `${a.item.title} from ${a.shop}`] : [a.to, a.amountXlm, `${a.amountXlm} XLM to ${a.recipient}`];
      const r = await this.host.pay(to, xlmToStroops(amountXlm), what);
      if (r.ok) this.emit({ type: "payment", ok: true, text: `Paid ${amountXlm} XLM: ${what}`, tx: r.tx });
      else
        this.emit({
          type: "payment",
          ok: false,
          text: r.refused
            ? `Blocked by your smart account: ${r.title ?? r.reason}${r.code !== null ? ` (#${r.code})` : ""}. No funds moved.`
            : `Not sent: ${r.reason}`,
        });
      const result = r.ok
        ? { paidXlm: amountXlm, tx: r.tx }
        : { status: r.refused ? "blocked by the smart account" : "not sent", rule: r.policy, reason: r.title ?? r.reason, code: r.code };
      this.messages.push({ role: "user", content: `I picked "${option.label}". Result: ${JSON.stringify(result)}` });
      await this.loop();
    });
  }

  /** Start a new conversation. */
  reset(): void {
    if (this.busy) return;
    this.messages = [];
    this.events = [];
    this.pending = undefined;
    this.changed();
  }

  private async exclusive(fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.changed();
    try {
      await fn();
    } catch (e) {
      this.emit({ type: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  /** Model steps until it answers in text or offers options. */
  private async loop(): Promise<void> {
    for (let step = 0; step < 6; step++) {
      const m = await this.next();
      this.messages.push(m);
      if (m.content.trim()) this.emit({ type: "agent", text: m.content.trim() });
      if (!m.tool_calls?.length) return;
      let waiting = false;
      for (const call of m.tool_calls) {
        let input: any = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* treated as empty */
        }
        const out = await this.tool(call.function.name, input);
        if (out.waiting) waiting = true;
        this.messages.push({ role: "tool", tool_call_id: call.id, content: out.output });
      }
      if (waiting) return;
    }
    this.emit({ type: "error", text: "The agent took too many steps and stopped. Try asking again." });
  }

  private async next(): Promise<Msg> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.relayUrl}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: this.messages }),
      });
    } catch {
      throw new Error("Could not reach the AI service. Check your connection and try again.");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `AI service error (HTTP ${res.status})`);
    if (typeof body.messagesLeftToday === "number") this.messagesLeft = body.messagesLeftToday;
    const m = body.message ?? {};
    return { role: "assistant", content: m.content ?? "", ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) };
  }

  private async tool(name: string, input: any): Promise<{ output: string; waiting?: boolean }> {
    if (name === "list_shops") {
      this.emit({ type: "activity", text: "Read the shop catalogs" });
      return {
        output: JSON.stringify(
          this.host.shops().map((s) => ({ shop: s.name, address: s.address, items: s.items.map((i) => ({ item: i.id, title: i.title, priceXlm: i.priceXlm })) })),
        ),
      };
    }
    if (name === "check_allowance") {
      const a = await this.host.allowance();
      this.emit({ type: "activity", text: a ? `Allowance: ${a.leftXlm} of ${a.limitXlm} XLM left today` : "No allowance found" });
      return { output: JSON.stringify(a ?? { error: "the agent has no allowance (none granted, revoked or expired)" }) };
    }
    if (name === "offer_options") {
      const question = String(input.question ?? "Pick one").slice(0, 200);
      const options: Omit<AiOption, "id">[] = [];
      const dropped: string[] = [];
      for (const o of (Array.isArray(input.options) ? input.options : []).slice(0, 5)) {
        const label = String(o?.label ?? "").slice(0, 80) || "Option";
        const r = this.toOption(label, o);
        if ("error" in r) dropped.push(`${label}: ${r.error}`);
        else options.push(r);
      }
      if (options.length === 0) return { output: JSON.stringify({ error: "no valid options", dropped }) };
      const id = `o${++this.optionSets}`;
      this.pending = { id, options: options.map((o, i) => ({ ...o, id: `${id}.${i + 1}` })) };
      this.emit({ type: "options", id, question, options: this.pending.options });
      return {
        output: JSON.stringify({ shown: options.length, ...(dropped.length ? { dropped } : {}), note: "The visitor picks; the result arrives as their next message." }),
        waiting: true,
      };
    }
    return { output: JSON.stringify({ error: `unknown tool ${name}` }) };
  }

  private toOption(label: string, o: any): Omit<AiOption, "id"> | { error: string } {
    const shops = this.host.shops();
    if (o?.to) {
      const to = String(o.to).trim();
      if (!/^G[A-Z2-7]{55}$/.test(to)) return { error: "not a Stellar account address" };
      const amountXlm = String(o.amountXlm ?? "").trim();
      if (!/^\d+(\.\d{1,7})?$/.test(amountXlm) || Number(amountXlm) <= 0 || Number(amountXlm) > 100) return { error: "amount must be between 0 and 100 XLM" };
      const shop = shops.find((s) => s.address === to);
      const recipient = shop ? shop.name : `${shortAddr(to)} (not a listed shop)`;
      return { label, detail: `${amountXlm} XLM · to ${recipient}`, action: { kind: "send", to, amountXlm, recipient } };
    }
    if (o?.shop || o?.item) {
      const shop = shops.find((s) => s.name.toLowerCase() === String(o.shop ?? "").trim().toLowerCase());
      if (!shop) return { error: `unknown shop "${o.shop}"` };
      const item = shop.items.find((i) => i.id === String(o.item ?? "").trim());
      if (!item) return { error: `${shop.name} has no item "${o.item}"` };
      return { label, detail: `${item.priceXlm} XLM · ${shop.name}`, action: { kind: "buy", shop: shop.name, address: shop.address, item } };
    }
    return { label, action: { kind: "say", text: String(o?.reply ?? label).slice(0, 300) } };
  }

  private emit(e: NewEvent): void {
    this.events = [...this.events, { ...e, seq: ++this.seq } as AiEvent].slice(-200);
    this.changed();
  }

  private changed(): void {
    this.onChange?.();
  }
}
