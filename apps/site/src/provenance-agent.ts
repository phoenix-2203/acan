/**
 * The autonomous agent for provenance-gated allowances (after CaMeL).
 *
 * 1. A planner model (behind ACAN's relay) sees only what the user typed and
 *    the guardian's pinned catalog, never any fetched content, and writes a
 *    small plan.
 * 2. The user confirms the request; a key on their device signs it.
 * 3. This page runs the plan. Content it reads (the Tidewire note) is labelled
 *    untrusted, and every value derived from it carries that label.
 * 4. Each payment goes to the provenance co-signer, which re-runs the plan and
 *    signs only if recipient, amount and the decision to pay trace back to the
 *    signed request and the pinned catalog. The smart account requires that
 *    signature next to the agent's.
 */
import { runPlan, untrusted, type PayIntent, type PricedItem, type Step } from "@acan/core/browser";
import { xlmToStroops } from "./ai-agent";
import { MERCHANTS, TIDEWIRE_NOTE, TIDEWIRE_URL } from "./merchants";

export interface PlanReply {
  say: string;
  fields: Record<string, string>;
  plan: Step[];
}

/** The guardian's pinned price book: every item of every allowed shop, price in stroops. */
export function pinnedCatalog(allowed: string[]): PricedItem[] {
  return MERCHANTS.filter((m) => allowed.includes(m.address)).flatMap((m) =>
    m.items.map((i) => ({ merchant: m.name, product: i.id, price: xlmToStroops(i.priceXlm).toString(), payTo: m.address })),
  );
}

/** What the agent may read, and what it gets back (fixed demo content). */
export const SOURCES: Record<string, string> = { [TIDEWIRE_URL]: TIDEWIRE_NOTE };

export async function plan(relay: string, task: string, catalog: PricedItem[]): Promise<PlanReply> {
  const res = await fetch(`${relay}/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task,
      catalog: catalog.map((c) => ({ merchant: c.merchant, product: c.product, priceXlm: (Number(c.price) / 1e7).toString() })),
      sources: Object.keys(SOURCES),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `planner error ${res.status}`);
  return { say: String(body.say ?? ""), fields: cleanFields(body.fields), plan: Array.isArray(body.plan) ? body.plan : [] };
}

/** Only the fields a request can carry; maxXlm becomes maxAmount in stroops. */
export function cleanFields(f: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!f || typeof f !== "object") return out;
  const x = f as Record<string, unknown>;
  if (typeof x.product === "string" && /^[a-z0-9-]{1,40}$/.test(x.product)) out.product = x.product;
  if (typeof x.merchant === "string" && x.merchant.length <= 60) out.merchant = x.merchant;
  if (typeof x.maxXlm === "string" && /^\d+(\.\d{1,7})?$/.test(x.maxXlm)) out.maxAmount = xlmToStroops(x.maxXlm).toString();
  return out;
}

/** The transcript of what the plan reads (the sources' fixed content). */
export function transcriptFor(steps: Step[]): Record<string, string> {
  const t: Record<string, string> = {};
  const walk = (b: Step[]) => {
    for (const s of b) {
      if (s.op === "fetch" && SOURCES[s.url] !== undefined) t[s.url] = SOURCES[s.url];
      if (s.op === "if") {
        walk(s.then);
        walk(s.else ?? []);
      }
    }
  };
  walk(steps);
  return t;
}

export interface Preview {
  pays: PayIntent[];
  /** Untrusted sources per payment, empty when clean. */
  taint: string[][];
  error?: string;
}

/** Dry-run the plan the way the co-signer will, to show what will happen before anyone signs. */
export function preview(steps: Step[], fields: Record<string, string>, catalog: PricedItem[]): Preview {
  try {
    const pays = runPlan(steps, { request: fields, catalog, transcript: transcriptFor(steps) });
    return { pays, taint: pays.map((p) => [...new Set([...untrusted(p.to.src), ...untrusted(p.amount.src), ...untrusted(p.ctx)])]) };
  } catch (e) {
    return { pays: [], taint: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** A plan for a payment the user picked themselves (assisted mode): every value is theirs. */
export function pickPlan(): Step[] {
  return [
    { let: "to", op: "request", field: "to" },
    { let: "amount", op: "request", field: "amount" },
    { op: "pay", to: "to", amount: "amount" },
  ];
}

/** Plain words for a label. */
export function sourceName(s: string): string {
  if (s === "planner") return "values the AI wrote itself";
  if (s.startsWith("tool:")) return `content from ${s.slice(5)}`;
  return s;
}
