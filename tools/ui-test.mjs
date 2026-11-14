// Drive the real pages: create wallet → faucet → verify a transfer in-browser → mine for a few seconds.
import puppeteer from "puppeteer-core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
const BASE = process.env.BASE || "http://127.0.0.1:9310";
const d = `${homedir()}/.cache/puppeteer/chrome`;
const exe = `${d}/${readdirSync(d).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await puppeteer.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 900 });
const errs = [];
page.on("pageerror", (e) => errs.push("JS " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console " + m.text().slice(0, 200)); });
let pass = 0, fail = 0;
const ok = (c, msg) => { c ? pass++ : fail++; console.log(c ? "✓" : "✗", msg); };

// wallet
await page.goto(BASE + "/wallet", { waitUntil: "networkidle2" });
await page.click("#mk");
await page.waitForSelector(".words24 span");
ok((await page.$$(".words24 span")).length === 24, "24 seed words shown");
await page.click("#ok1");
await page.type("#pw1", "selen-test-pw");
await page.type("#pw2", "selen-test-pw");
await page.click("#go");
await page.waitForSelector("#qaddr", { timeout: 20000 });
const q = await page.$eval("#qaddr", (e) => e.textContent.trim());
ok(q.startsWith("selenq1") && q.length > 1900, `quantum address ${q.length} chars`);
await page.waitForFunction(() => /in sync/.test(document.querySelector("#syncmsg")?.textContent || ""), { timeout: 60000 });
ok(true, "wallet synced with chain");
await page.click('.tabs button[data-t="faucet"]');
await page.click("#drip");
await page.waitForFunction(() => /On its way|faucet/i.test(document.querySelector("#dripmsg")?.textContent || ""), { timeout: 30000 });
const drip = await page.$eval("#dripmsg", (e) => e.textContent);
ok(/On its way/.test(drip), "faucet: " + drip.slice(0, 80));
// reload → locked → unlock
await page.reload({ waitUntil: "networkidle2" });
await page.waitForSelector("#pw");
await page.type("#pw", "selen-test-pw");
await page.click("#go");
await page.waitForSelector("#qaddr", { timeout: 20000 });
ok((await page.$eval("#qaddr", (e) => e.textContent.trim())) === q, "unlock restores same wallet");

// explorer verify
const { recent } = await (await fetch(BASE + "/api/txs")).json();
const txid = recent[0]?.id;
await page.goto(`${BASE}/tx/${txid}`, { waitUntil: "networkidle2" });
await page.click("#vbtn");
await page.waitForFunction(() => /All checks passed|failed/.test(document.querySelector("#vlist")?.textContent || ""), { timeout: 60000 });
const vtxt = await page.$eval("#vlist", (e) => e.innerText);
ok(/All checks passed/.test(vtxt), "in-browser verify: " + vtxt.split("\n").at(-1));

// explorer home + block page
await page.goto(BASE + "/explorer", { waitUntil: "networkidle2" });
ok((await page.$$("#blocks tr")).length >= 10, "explorer lists blocks");
await page.goto(BASE + "/block/1", { waitUntil: "networkidle2" });
ok(/Block/.test(await page.$eval("h1", (e) => e.textContent)), "block page renders");

// mine
await page.goto(BASE + "/mine", { waitUntil: "networkidle2" });
const filled = await page.$eval("#addr", (e) => e.value);
ok(filled === q, "mine page pre-fills wallet address");
await page.click('#threads button[data-n="2"]');
await page.click("#go");
await new Promise((r) => setTimeout(r, 9000));
const rate = await page.$eval("#rate", (e) => +e.textContent.replace(/,/g, ""));
ok(rate > 0, `browser hashrate ${rate} H/s (2 threads)`);
if (!(rate > 0)) console.log("miner log:", await page.$eval("#log", (e) => e.innerText.slice(0, 500)));
await page.click("#stop");

console.log(errs.length ? "ERRORS:\n" + errs.join("\n") : "no JS errors");
console.log(`${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail || errs.length ? 1 : 0);
