// Browser send, end to end, on a LOCAL node: restores the node's own faucet wallet in the browser (it always has
// mature funds) and sends from the Send tab. Guards the worker round-trip that once left every send hanging.
//   node tools/send-ui-test.mjs                  (testnet :9310, SELEN)
//   BASE=http://127.0.0.1:9311 ASSET=1 node tools/send-ui-test.mjs   (beta, USDG)
import puppeteer from "puppeteer-core";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as L from "../lib/client.mjs";
const BASE = process.env.BASE || "http://127.0.0.1:9311";
const words = L.seedToWords(L.hexToBytes(readFileSync(homedir() + "/.config/selen/faucet.seed", "utf8").trim()));
const d = `${homedir()}/.cache/puppeteer/chrome`;
const exe = `${d}/${readdirSync(d).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 600000 });
const p = await b.newPage(); await p.setViewport({ width: 1366, height: 900 });
p.on("pageerror", (e) => console.log("PAGEERR", e.message));
await p.goto(BASE + "/wallet", { waitUntil: "networkidle2" });
await p.click("#rs"); await p.waitForSelector("#words"); await p.type("#words", words); await p.type("#pw1", "selen-beta-pw"); await p.click("#go");
await p.waitForSelector("#qaddr", { timeout: 20000 });
await p.waitForFunction(() => /in sync/.test(document.querySelector("#syncmsg")?.textContent || ""), { timeout: 120000 });
if (process.env.ASSET) await p.click(`.assetpick button[data-a="${process.env.ASSET}"]`);
await p.click('.tabs button[data-t="send"]');
await p.type("#to", L.keysFromSeed(L.randomBytes(32)).classic);
await p.type("#amt", "1.5");
const t0 = Date.now();
await p.click("#send");
let msg = "";
for (let i = 0; i < 60 && (!msg || /building|signed/.test(msg)); i++) { await new Promise((r) => setTimeout(r, 1000)); msg = await p.$eval("#sendmsg", (e) => e.textContent); }
const ok = /Sent\./.test(msg);
console.log(`${ok ? "✓" : "✗"} browser send in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${msg.slice(0, 120)}`);
await b.close();
process.exit(ok ? 0 : 1);
