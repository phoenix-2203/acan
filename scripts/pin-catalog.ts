/**
 * Pin the merchants' catalogs for the provenance co-signer: fetch each
 * merchant's catalog, show every item with its price and payment address, and
 * write .acan/pinned-catalog.json. Running this is the guardian's decision:
 * from then on the co-signer pays only these prices to these addresses, until
 * you pin again.
 *
 * Usage: npm run catalog:pin
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnv, usdcToStroops } from "@acan/core";
import { merchantPins, merchantUrls } from "../apps/agent/src/merchants.js";

loadEnv();
const pins = merchantPins();
const out: { merchant: string; product: string; price: string; payTo: string }[] = [];
for (const url of merchantUrls()) {
  const c = await (await fetch(url)).json();
  const payTo = pins.get(url) ?? c.payTo;
  if (pins.get(url) && c.payTo !== pins.get(url)) throw new Error(`${url} reports payTo ${c.payTo}, but it is pinned to ${pins.get(url)}`);
  for (const p of c.products ?? []) {
    const price = usdcToStroops(String(p.price).replace(/^\$/, "")).toString();
    out.push({ merchant: url, product: p.path, price, payTo });
    console.log(`${c.name.padEnd(16)} ${p.path.padEnd(14)} ${String(p.price).padEnd(7)} → ${payTo}`);
  }
}
mkdirSync(".acan", { recursive: true });
writeFileSync(".acan/pinned-catalog.json", JSON.stringify(out, null, 2) + "\n");
console.log(`\nPinned ${out.length} items in .acan/pinned-catalog.json. The co-signer pays only these.`);
