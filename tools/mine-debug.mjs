// Debug the browser miner: start 2 threads on /mine and print worker messages/errors.
import puppeteer from "puppeteer-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
const BASE = process.env.BASE || "http://127.0.0.1:9310";
const d = `${homedir()}/.cache/puppeteer/chrome`;
const exe = `${d}/${readdirSync(d).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await puppeteer.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
page.on("console", (m) => console.log("page:", m.type(), m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("requestfailed", (r) => console.log("failed:", r.url(), r.failure()?.errorText));
page.on("response", (r) => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); });
page.on("workercreated", (w) => { console.log("worker created", w.url()); w.on("console", (m) => console.log("worker:", m.text().slice(0, 300))); });
await page.goto(BASE + "/mine", { waitUntil: "networkidle2" });
await page.$eval("#addr", (e, v) => (e.value = v), process.argv[2] || "");
await page.click('#threads button[data-n="2"]');
await page.click("#go");
for (let k = 0; k < 14; k++) { await new Promise((r) => setTimeout(r, 1000)); console.log("t", k + 1, "rate", await page.$eval("#rate", (e) => e.textContent)); }
console.log("rate", await page.$eval("#rate", (e) => e.textContent), "log", await page.$eval("#log", (e) => e.innerText.slice(0, 400)));
await browser.close();
