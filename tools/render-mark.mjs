// node tools/render-mark.mjs → renders /_render/mark.html to art/logo/mark-3d.png (transparent)
import puppeteer from "puppeteer-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
const BASE = process.env.BASE || "http://127.0.0.1:9310";
const d = `${homedir()}/.cache/puppeteer/chrome`;
const exe = `${d}/${readdirSync(d).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
await page.goto(BASE + (process.env.PAGE || "/_render/mark.html") + (process.argv[3] || ""), { waitUntil: "networkidle0" });
await page.waitForFunction("window.done === true", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 300));
const el = await page.$("#c");
await el.screenshot({ path: process.argv[2] || "art/logo/mark-3d.png", omitBackground: true });
await browser.close();
console.log("saved", process.argv[2] || "art/logo/mark-3d.png");
