// node tools/shots.mjs <outdir> [w] [h] — one browser, many viewport shots down the landing page
// Each stop scrolls an element's top to the viewport top (+ an offset in viewport heights), waits, shoots.
import puppeteer from "puppeteer-core";
import { readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
const [out = "/tmp/shots", w = 1440, h = 900] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const BASE = process.env.BASE || "http://127.0.0.1:9310";
const STOPS = JSON.parse(process.env.STOPS || "null") || [
  ["hero", "#hero", 0, 2500], ["seal", "#seal", 0.12, 3200], ["why", "#why", 0.15, 1200],
  ["life0", "#chamber", 0.05, 2200], ["life1", "#chamber", 1.15, 2200], ["life2", "#chamber", 2.1, 2200],
  ["node", "#node", 0.05, 1500], ["node2", ".fan-cta", -0.25, 3000], ["hidden", "#hidden", 0.05, 1800],
  ["live", "#live", 0.1, 2200], ["compare", "#compare", 0.05, 900], ["road", "#roadmap", 0.05, 2200],
  ["faq", "#faq", 0.05, 600], ["cta", "#start", -0.2, 900],
];
const d = `${homedir()}/.cache/puppeteer/chrome`;
const exe = `${d}/${readdirSync(d).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +h, deviceScaleFactor: 1 });
const errs = [];
page.on("pageerror", (e) => errs.push("JS " + e.message));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errs.push(m.type() + " " + m.text()); });
await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 45000 });
for (const [name, sel, off, wait] of STOPS) {
  await page.evaluate((s, o) => { const el = document.querySelector(s); if (el) scrollTo(0, el.getBoundingClientRect().top + scrollY + o * innerHeight); }, sel, off);
  await new Promise((r) => setTimeout(r, wait));
  await page.screenshot({ path: `${out}/${name}.png` });
}
console.log(errs.length ? errs.join("\n") : "no errors");
await browser.close();
