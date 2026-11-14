// node tools/shot.mjs <path> <out.png> [w=1440] [h=900] [dpr=1] [wait=2500] [full=0] [scrollY=0]
import puppeteer from "puppeteer-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
const [p = "/", out = "/tmp/shot.png", w = 1440, h = 900, dpr = 1, wait = 2500, full = 0, sy = 0] = process.argv.slice(2);
const BASE = process.env.BASE || "http://127.0.0.1:9310";
const d = `${homedir()}/.cache/puppeteer/chrome`;
const exe = `${d}/${readdirSync(d).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +h, deviceScaleFactor: +dpr });
const errs = [];
page.on("pageerror", (e) => errs.push("JS " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console " + m.text().slice(0, 200)); });
page.on("requestfailed", (r) => errs.push("failed " + r.url()));
page.on("response", (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url()}`); });
await page.goto(BASE + p, { waitUntil: "networkidle2", timeout: 45000 });
if (+full) {
  await page.evaluate(async () => { const H = document.documentElement.scrollHeight; for (let y = 0; y <= H; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 140)); } scrollTo(0, 0); });
}
if (+sy) await page.evaluate((y) => scrollTo(0, y), +sy);
await new Promise((r) => setTimeout(r, +wait));
await page.screenshot({ path: out, fullPage: Boolean(+full) });
console.log(errs.length ? errs.join("\n") : "no errors");
await browser.close();
