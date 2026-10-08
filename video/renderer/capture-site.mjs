// Captures the real demo site (apps/site): hero, and the AI chat after a purchase and after an attack.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const base = process.argv[2] ?? "http://localhost:5198";
const out = new URL("../captures/", import.meta.url).pathname;
const fonts = readFileSync(new URL("./fonts.css", import.meta.url), "utf8");
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = async (w, h) => {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: "dark" });
  await p.route("https://fonts.googleapis.com/**", (r) => r.abort());
  await p.route("https://soroban-testnet.stellar.org/**", (r) => r.abort());
  return p;
};
// Hero and the sandbox's first step (no wallet yet).
let p = await page(1440, 900);
await p.goto(`${base}/`);
await p.addStyleTag({ content: fonts });
await p.waitForTimeout(1200);
await p.screenshot({ path: `${out}site-hero.png` });
await p.locator("#try").scrollIntoViewIfNeeded();
await p.locator("#try .steps").screenshot({ path: `${out}site-steps.png` });
await p.close();
// AI chat on the demo site.
p = await page(820, 1000);
await p.goto(`${base}/harness-video.html`);
await p.addStyleTag({ content: fonts });
await p.getByRole("button", { name: "Buy the cheapest report" }).click();
await p.getByRole("button", { name: /Southgate: ledger report/ }).click();
await p.getByText("Done: you paid 0.8 XLM").waitFor();
await p.waitForTimeout(300);
await p.locator("#cap").screenshot({ path: `${out}site-chat-paid.png` });
await p.evaluate(() => window.agent.reset());
await p.getByRole("button", { name: "Try a prompt injection" }).click();
await p.getByRole("button", { name: /Send 0.5 XLM/ }).click();
await p.getByText("Your smart account blocked it").waitFor();
await p.waitForTimeout(300);
await p.locator("#cap").screenshot({ path: `${out}site-chat-blocked.png` });
await b.close();
console.log("site captures done");
