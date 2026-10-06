import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Tiny .env reader/writer for the local scripts (Node only).
 * Secrets live in `.env` at the repo root, which is git-ignored.
 */
export const ENV_PATH = resolve(process.cwd(), ".env");

export function loadEnv(path = ENV_PATH): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  for (const [k, v] of Object.entries(out)) if (process.env[k] === undefined) process.env[k] = v;
  return out;
}

/** Set or replace keys in .env, preserving other lines. */
export function saveEnv(updates: Record<string, string>, path = ENV_PATH): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] in updates) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) next.push(`${k}=${v}`);
  writeFileSync(path, next.filter((l, i, a) => !(l === "" && i === a.length - 1)).join("\n") + "\n", { mode: 0o600 });
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env. Run the setup step that creates it first.`);
  return v;
}
