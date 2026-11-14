// End-to-end in a real browser against a local beta node (NETWORK=beta PORT=9311 node server.mjs):
// wallet → test USDG from the faucet → wait until spendable → private USDG transfer → explorer verify.
//   node tools/beta-ui-test.mjs [shotsDir]
import puppeteer from "puppeteer-core";
import { readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { keysFromSeed, randomBytes } from "../lib/crypto.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:9311";
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const d = `${homedir()}/.cache/puppeteer/chrome`;
const exe = `${d}/${readdirSync(d).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const browser = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 30 * 60_000 });
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 900 });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
let n = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) { n++; } };
const shot = async (name) => shots && page.screenshot({ path: `${shots}/${name}.png` });

await page.goto(BASE + "/wallet", { waitUntil: "networkidle2" });
await page.click("#mk");
await page.waitForSelector("#ok1");
await page.click("#ok1");
await page.type("#pw1", "selen-beta-pw");
await page.type("#pw2", "selen-beta-pw");
await page.click("#go");
await page.waitForSelector("#qaddr", { timeout: 20000 });
await page.waitForFunction(() => /in sync/.test(document.querySelector("#syncmsg")?.textContent || ""), { timeout: 90000 });
const tickers = await page.$$eval(".assetpick button", (bs) => bs.map((b) => b.textContent));
ok(tickers.join(",") === "SELEN,USDG", "asset picker: " + tickers.join(" / "));

await page.click('.tabs button[data-t="faucet"]');
for (const a of [1, 0]) {
  await page.$eval("#dripmsg", (e) => (e.textContent = ""));
  await page.click(`[data-drip="${a}"]`);
  await page.waitForFunction(() => /On its way|faucet|slow|refilling/i.test(document.querySelector("#dripmsg")?.textContent || ""), { timeout: 30000 });
  ok(/On its way/.test(await page.$eval("#dripmsg", (e) => e.textContent)), "faucet: " + (await page.$eval("#dripmsg", (e) => e.textContent)).slice(0, 70));
  await new Promise((r) => setTimeout(r, 1200));
}
await page.click('.assetpick button[data-a="1"]');
const t0 = Date.now();
await page.waitForFunction(() => { const b = document.querySelector("#bal")?.textContent || ""; return /^100(\.|U)/.test(b.trim()); }, { timeout: 15 * 60_000, polling: 3000 });
ok(true, `100 USDG spendable after ${Math.round((Date.now() - t0) / 1000)} s`);
await shot("wallet-usdg");

const friend = keysFromSeed(randomBytes(32));
await page.click('.tabs button[data-t="send"]');
await page.type("#to", friend.classic);
await page.type("#amt", "12.5");
await page.click("#send");
await page.waitForFunction(() => /Sent\.|error|Not enough|fail/i.test(document.querySelector("#sendmsg")?.textContent || ""), { timeout: 120000 });
const sent = await page.$eval("#sendmsg", (e) => e.textContent);
ok(/Sent\./.test(sent), "send: " + sent.slice(0, 90));
const txid = await page.$eval("#sendmsg a", (a) => a.getAttribute("href").split("/").pop());
const det = await (await fetch(`${BASE}/api/tx/${txid}`)).json();
ok(det.asset === 1 && det.ticker === "USDG", `tx ${txid.slice(0, 10)}… is a USDG transfer, fee ${det.fee} (µUSDG)`);

await page.goto(`${BASE}/tx/${txid}`, { waitUntil: "networkidle2" });
await page.waitForSelector("#vbtn");
await page.click("#vbtn");
await page.waitForFunction(() => /All checks passed|Verification failed|INVALID/.test(document.querySelector("#vlist")?.textContent || ""), { timeout: 120000 });
const v = await page.$eval("#vlist", (e) => e.textContent);
ok(/All checks passed/.test(v), "explorer verify in the browser: " + (v.match(/All checks passed[^\n]*/)?.[0] || v.slice(-80)));
ok(/Private USDG transfer/.test(await page.$eval("h1, .h-l", (e) => e.textContent).catch(() => "")), "explorer titles it a private USDG transfer");
await shot("explorer-usdg");

console.log(errs.length ? "JS errors:\n" + errs.join("\n") : "no JS errors");
console.log(n ? `${n} failed` : "all passed");
await browser.close();
process.exit(n || errs.length ? 1 : 0);
