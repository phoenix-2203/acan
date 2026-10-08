// Renders still frames at given times: node stills.mjs 5 9.5 20 ...
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const times = process.argv.slice(2).map(Number);
const dir = new URL("../renders/stills/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto(new URL("./film.html", import.meta.url).href);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(500);
for (const t of times) {
  await p.evaluate((t) => window.seek(t), t);
  await p.screenshot({ path: `${dir}t${String(t).padStart(6, "0")}.png` });
}
await b.close();
console.log("stills", times.length);
