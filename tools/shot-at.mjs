// node tools/shot-at.mjs <path> <selector> <out.png> [w] [h] [wait] — scroll an element to the top, then shoot the viewport
import puppeteer from "puppeteer-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
const [p = "/", sel = "body", out = "/tmp/shot.png", w = 1440, h = 900, wait = 3000] = process.argv.slice(2);
const BASE = process.env.BASE || "http://127.0.0.1:9310";
const d = `${homedir()}/.cache/puppeteer/chrome`;
const exe = `${d}/${readdirSync(d).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +h, deviceScaleFactor: 1 });
const errs = [];
page.on("pageerror", (e) => errs.push("JS " + e.message));
await page.goto(BASE + p, { waitUntil: "networkidle2", timeout: 45000 });
await page.evaluate((s) => { const el = document.querySelector(s); if (el) scrollTo(0, el.getBoundingClientRect().top + scrollY); }, sel);
await new Promise((r) => setTimeout(r, +wait));
await page.screenshot({ path: out });
console.log(errs.length ? errs.join("\n") : "no errors");
await browser.close();
