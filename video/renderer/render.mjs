// Renders film.html to video frames piped into ffmpeg: node render.mjs [fps] [from] [to] [out.mp4]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const fps = Number(process.argv[2] ?? 30), from = Number(process.argv[3] ?? 0), to = Number(process.argv[4] ?? 155);
const outFile = process.argv[5] ?? new URL("../renders/film-silent.mp4", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto(new URL("./film.html", import.meta.url).href);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(800);
const ff = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
  "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outFile], { stdio: ["pipe", "inherit", "inherit"] });
const n = Math.round((to - from) * fps);
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const t = from + i / fps;
  await p.evaluate((t) => window.seek(t), t);
  const buf = await p.screenshot({ type: "jpeg", quality: 95 });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % 300 === 0) console.log(`frame ${i}/${n} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
await b.close();
console.log("done", outFile);
