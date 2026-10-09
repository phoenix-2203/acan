/**
 * A tiny plan language with data-flow labels (after CaMeL, arXiv 2503.18813).
 *
 * Every value carries the set of sources it depends on. Labels propagate
 * through every operation, through lookups (what was looked up with) and
 * through control flow (the condition of an `if` taints everything inside it).
 * Operations never throw on tainted input: they return null with the labels,
 * so whether a payment is reached cannot depend on untrusted data except
 * through an `if`, which is tracked.
 */

export type Source = "user" | "pinned" | "planner" | `tool:${string}`;
export type Labels = ReadonlySet<Source>;

export interface Labeled<T = unknown> {
  v: T;
  src: Labels;
}

export interface PricedItem {
  merchant: string;
  product: string;
  /** Atomic units (7 decimals). */
  price: string;
  payTo: string;
}

export type Step =
  | { let: string; op: "request"; field: string }
  | { let: string; op: "catalog" }
  | { let: string; op: "lit"; value: unknown }
  | { let: string; op: "fetch"; url: string }
  | { let: string; op: "field"; from: string; key: string }
  | { let: string; op: "filter"; list: string; key: string; equals: string }
  | { let: string; op: "cheapest"; list: string }
  | { let: string; op: "add"; a: string; b: string }
  | { let: string; op: "format"; template: string; args: string[] }
  | { op: "if"; left: string; right: string; then: Step[]; else?: Step[] }
  | { op: "pay"; to: string; amount: string };

export interface PayIntent {
  to: Labeled;
  amount: Labeled;
  /** Labels of every condition this payment sits under. */
  ctx: Labels;
}

export interface PlanInputs {
  /** Structured fields of the user's signed request. */
  request: Record<string, string>;
  /** The guardian's pinned price book (the co-signer's own copy, never the agent's). */
  catalog: PricedItem[];
  /** Recorded tool outputs by URL. Untrusted, so their authenticity does not matter. */
  transcript: Record<string, string>;
}

export const TRUSTED: ReadonlySet<Source> = new Set<Source>(["user", "pinned"]);

const MAX_STEPS = 200;

export function union(...sets: Labels[]): Set<Source> {
  const out = new Set<Source>();
  for (const s of sets) for (const x of s) out.add(x);
  return out;
}

export function untrusted(src: Labels): Source[] {
  return [...src].filter((s) => !TRUSTED.has(s)).sort();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || "unknown";
  } catch {
    return "unknown";
  }
}

/** Runs a plan and returns the payments it makes, each with its labels. */
export function runPlan(plan: Step[], inputs: PlanInputs): PayIntent[] {
  const env = new Map<string, Labeled>();
  const pays: PayIntent[] = [];
  let steps = 0;

  const get = (name: string): Labeled => {
    const x = env.get(name);
    if (!x) throw new Error(`unknown variable ${name}`);
    return x;
  };
  const set = (name: string, v: unknown, src: Labels, ctx: Labels) => {
    if (env.has(name)) throw new Error(`variable ${name} assigned twice`);
    env.set(name, { v, src: union(src, ctx) });
  };

  const exec = (block: Step[], ctx: Labels): void => {
    for (const s of block) {
      if (++steps > MAX_STEPS) throw new Error("plan too long");
      switch (s.op) {
        case "request": {
          const v = inputs.request[s.field];
          if (v === undefined) throw new Error(`request has no field ${s.field}`);
          set(s.let, v, new Set(["user"]), ctx);
          break;
        }
        case "catalog":
          set(s.let, inputs.catalog.map((x) => ({ ...x })), new Set(["pinned"]), ctx);
          break;
        case "lit":
          set(s.let, s.value, new Set(["planner"]), ctx);
          break;
        case "fetch": {
          const body = inputs.transcript[s.url];
          set(s.let, body ?? null, new Set([`tool:${hostOf(s.url)}` as Source]), ctx);
          break;
        }
        case "field": {
          const from = get(s.from);
          let v: unknown = null;
          if (typeof from.v === "string") {
            try {
              const parsed = JSON.parse(from.v);
              v = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[s.key] ?? null : null;
            } catch {
              v = null;
            }
          } else if (from.v && typeof from.v === "object") {
            v = (from.v as Record<string, unknown>)[s.key] ?? null;
          }
          set(s.let, v, from.src, ctx);
          break;
        }
        case "filter": {
          const list = get(s.list);
          const eq = get(s.equals);
          const v = Array.isArray(list.v) ? list.v.filter((x) => x && typeof x === "object" && (x as any)[s.key] === eq.v) : null;
          set(s.let, v, union(list.src, eq.src), ctx);
          break;
        }
        case "cheapest": {
          const list = get(s.list);
          let best: any = null;
          if (Array.isArray(list.v)) {
            for (const x of list.v as any[]) {
              if (!x || typeof x.price !== "string" || !/^\d+$/.test(x.price)) continue;
              if (best === null || BigInt(x.price) < BigInt(best.price)) best = x;
            }
          }
          set(s.let, best, list.src, ctx);
          break;
        }
        case "add": {
          const a = get(s.a);
          const b = get(s.b);
          const ok = (x: unknown) => typeof x === "string" && /^\d+$/.test(x);
          const v = ok(a.v) && ok(b.v) ? (BigInt(a.v as string) + BigInt(b.v as string)).toString() : null;
          set(s.let, v, union(a.src, b.src), ctx);
          break;
        }
        case "format": {
          const args = s.args.map(get);
          let i = 0;
          const v = s.template.replace(/\{\}/g, () => String(args[i++]?.v ?? ""));
          set(s.let, v, union(...args.map((x) => x.src)), ctx);
          break;
        }
        case "if": {
          const l = get(s.left);
          const r = get(s.right);
          const cond = l.v !== null && l.v === r.v;
          const inner = union(ctx, l.src, r.src);
          // Both branches run under the condition's labels: either one may be
          // the one taken, so neither may produce an untainted payment.
          exec(cond ? s.then : s.else ?? [], inner);
          break;
        }
        case "pay": {
          const to = get(s.to);
          const amount = get(s.amount);
          pays.push({ to: { v: to.v, src: union(to.src, ctx) }, amount: { v: amount.v, src: union(amount.src, ctx) }, ctx: new Set(ctx) });
          break;
        }
        default:
          throw new Error(`unknown op ${(s as { op: string }).op}`);
      }
    }
  };

  exec(plan, new Set());
  return pays;
}
