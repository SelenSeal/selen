// Crawl every page at desktop / tablet / phone: JS errors, failed requests, broken images, horizontal overflow.
// WORK=1 also crawls the local work pages.
import puppeteer from "puppeteer-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
const BASE = process.env.BASE || "http://127.0.0.1:9310";
const d = `${homedir()}/.cache/puppeteer/chrome`;
const exe = `${d}/${readdirSync(d).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const st = await (await fetch(BASE + "/api/status")).json();
const { recent } = await (await fetch(BASE + "/api/txs")).json();
const PAGES = ["/", "/explorer", `/block/${st.height}`, "/block/0", `/tx/${recent[0]?.id}`, "/wallet", "/mine", "/docs", "/whitepaper", "/nope-404"];
if (process.env.WORK) PAGES.push("/_pilihan/", "/_fonts/", "/_concepts/", "/_ref/");
const SIZES = [[1440, 900], [820, 1180], [390, 844]];
const browser = await puppeteer.launch({ executablePath: exe, headless: true });
let bad = 0, n = 0;
for (const [w, h] of SIZES) for (const p of PAGES) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  const errs = [];
  page.on("pageerror", (e) => errs.push("JS " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/404/.test(m.text())) errs.push("console " + m.text().slice(0, 160)); });
  page.on("requestfailed", (r) => { if (!/\/api\/events/.test(r.url())) errs.push("failed " + r.url()); });
  page.on("response", (r) => { if (r.status() >= 400 && !(p === "/nope-404" && r.url().endsWith(p))) errs.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(BASE + p, { waitUntil: "networkidle2", timeout: 30000 }).catch((e) => errs.push(e.message));
  await page.evaluate(async () => { const H = document.documentElement.scrollHeight; for (let y = 0; y <= H; y += 700) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } });
  await new Promise((r) => setTimeout(r, 400));
  const info = await page.evaluate(() => ({
    over: document.documentElement.scrollWidth - innerWidth,
    broken: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src),
  }));
  if (info.over > 1) errs.push(`horizontal overflow ${info.over}px`);
  if (info.broken.length) errs.push("broken img " + info.broken.join(", "));
  n++;
  if (errs.length) { bad++; console.log(`✗ ${w} ${p}\n   ${errs.join("\n   ")}`); }
  await page.close();
}
console.log(`${n - bad}/${n} clean`);
await browser.close();
process.exit(bad ? 1 : 0);
