// Film v2 captures: the real ACAN site (apps/site) and dashboard (apps/web) through
// their film harnesses (harness-film.html), at 2x. See ../README.md for what is staged.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
const SITE = process.argv[2] ?? "http://localhost:5198";
const WEB = process.argv[3] ?? "http://localhost:5199";
const out = new URL("../captures/v2/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const fonts = readFileSync(new URL("./fonts.css", import.meta.url), "utf8");
const CLEAN_TX = "c73563358346d9464145afe3e416cdf2a76ab0aea2dfb36ee792d9d922ff0e5a";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
async function open(path, w = 1440, h = 900) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: "light" });
  p.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 200)));
  await p.route("https://fonts.googleapis.com/**", (r) => r.abort());
  await p.goto(`${SITE}/harness-film.html${path}`);
  await p.addStyleTag({ content: fonts + "\n*{caret-color:transparent!important}" });
  await p.waitForTimeout(1800);
  return p;
}
const shot = async (p, name, el) => { await p.waitForTimeout(700); await (el ? p.locator(el).first().screenshot({ path: `${out}${name}.png` }) : p.screenshot({ path: `${out}${name}.png` })); console.log(name); };

// Landing
let p = await open("#/");
await shot(p, "landing");
await p.close();

// Autopilot: clean task, paid; then its receipt.
p = await open("#/app/autopilot", 1440, 1240);
await p.getByRole("button", { name: /^Buy the cheapest ledger report/ }).click();
await p.getByRole("button", { name: "Sign request and let it run" }).waitFor();
await shot(p, "ap-clean-plan");
await p.evaluate((tx) => (window.film.nextTx = tx), CLEAN_TX);
await p.getByRole("button", { name: "Sign request and let it run" }).click();
await p.getByText("Paid 0.8 XLM to Southgate Data").first().waitFor();
await shot(p, "ap-clean-paid");
await shot(p, "card-plan-clean", 'section.ap-card:has-text("Planner")');
await shot(p, "card-cosign-paid", 'section.ap-card:has-text("Co-signer preview")');
await shot(p, "line-paid", ".line.paid");
await shot(p, "card-plan-clean", 'section.ap-card:has-text("Planner")');
await shot(p, "card-cosign-paid", 'section.ap-card:has-text("Co-signer preview")');
await shot(p, "line-paid", ".line.paid");
await p.getByRole("link", { name: "Open the receipt" }).click();
await p.getByText(/verified/i).first().waitFor({ timeout: 15000 }).catch(() => console.log("no verified text"));
await p.waitForTimeout(1500);
await shot(p, "receipt");
await shot(p, "card-receipt", ".paper");
await shot(p, "card-receipt-layout", ".receipt-layout");
await shot(p, "card-receipt", ".paper");
await shot(p, "card-receipt-layout", ".receipt-layout");
await p.setViewportSize({ width: 1440, height: 2200 });
await shot(p, "receipt-tall");
await p.close();

// Autopilot: the Tidewire task, held; then the agent alone, refused.
p = await open("#/app/autopilot", 1440, 1240);
await p.getByRole("button", { name: /^Read today's Tidewire note/ }).click();
await p.getByRole("button", { name: "Sign request and let it run" }).waitFor();
await shot(p, "ap-tide-plan");
await shot(p, "card-plan-tide", 'section.ap-card:has-text("Planner")');
await shot(p, "card-note", "section.ap-card.untrusted");
await shot(p, "card-wontcosign", 'section.ap-card:has-text("Co-signer preview")');
await shot(p, "card-plan-tide", 'section.ap-card:has-text("Planner")');
await shot(p, "card-note", "section.ap-card.untrusted");
await shot(p, "card-wontcosign", 'section.ap-card:has-text("Co-signer preview")');
await p.getByRole("button", { name: "Sign request and let it run" }).click();
await p.getByText("Let the agent try with its key alone").waitFor();
await shot(p, "ap-tide-held");
await shot(p, "card-held", ".held-card");
await shot(p, "card-held", ".held-card");
await p.getByText("Let the agent try with its key alone").click();
await p.getByText("Payment blocked:").first().waitFor();
await shot(p, "ap-tide-alone");
await shot(p, "activity-alone", ".activity-panel");
await shot(p, "card-3213", ".block-card");
await shot(p, "card-3213", ".block-card");
await p.close();

// AI agent page: a prompt injection to pay a stranger.
p = await open("#/app/agent", 1440, 1100);
await p.getByRole("button", { name: "Try a prompt injection" }).click();
await p.getByRole("button", { name: /Send 0.5 XLM/ }).click();
await p.getByText(/Payment blocked:|Not co-signed/).first().waitFor();
await p.waitForTimeout(2500);
await shot(p, "agent-stranger");
await shot(p, "card-3401", ".block-card");
await shot(p, "agent-chat", ".stage-main");
await shot(p, "card-3401", ".block-card");
await shot(p, "agent-chat", ".stage-main");
await p.close();

// Agent team.
p = await open("#/app/team", 1440, 1240);
await p.getByRole("button", { name: "Sign the task and build the team" }).click();
await shot(p, "team-start");
await shot(p, "card-team-start", "section.ap-card");
await shot(p, "card-team-start", "section.ap-card");
const buy = (who) => p.getByRole("button", { name: new RegExp(`^${who} buys a ledger report`) }).click().then(() => p.waitForTimeout(900));
await buy("Runner");
await buy("Scout");
await shot(p, "team-scout-refused");
await shot(p, "card-team-scout", "section.ap-card");
await shot(p, "card-held-scout", ".held-card");
await shot(p, "card-team-scout", "section.ap-card");
await shot(p, "card-held-scout", ".held-card");
await p.getByRole("button", { name: "Cancel Scout" }).click();
await buy("Runner");
await shot(p, "team-cancelled");
await shot(p, "card-team-cancel", "section.ap-card");
await shot(p, "card-held-cancel", ".held-card");
await shot(p, "card-team-cancel", "section.ap-card");
await shot(p, "card-held-cancel", ".held-card");
await p.close();

// Wallet & allowance: the form for a new allowance.
p = await open("?state=nogrant#/app/wallet", 1440, 1500);
await shot(p, "wallet-form");
await shot(p, "card-allowance", 'li.now');
await shot(p, "card-allowance", 'li.now');
await p.close();

// Private payments replay.
p = await open("#/app/privacy", 1440, 1100);
await p.getByRole("button", { name: "Play" }).click();
await p.waitForTimeout(11500);
await shot(p, "replay-public", ".replay");
await p.getByRole("button", { name: "Your view (auditor key)" }).click();
await shot(p, "replay-auditor", ".replay");
await p.close();

// Dashboard: Tasks to sign.
p = await b.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2, colorScheme: "light" });
await p.route("https://fonts.googleapis.com/**", (r) => r.abort());
await p.goto(`${WEB}/harness-film.html?account=CCV4VQTGJN6GUVNM4LN3JWOWBOOX3E7IGKJ6QUPKZVKMDNV7WEJXVYAQ`);
await p.addStyleTag({ content: fonts });
await p.getByText("Sign this task").waitFor();
await shot(p, "dash-task", ".request");
await shot(p, "dash-tasks-card", "#cap");
await b.close();
console.log("done");
