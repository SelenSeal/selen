// The Bridge page in a real browser, no real money: anvil (Robinhood-like, chain id 4663) with the bridge contract
// and mock USDG/SELEN, a fresh beta node with BRIDGE=1, and an injected EIP-1193 wallet backed by an anvil key.
//   (cd contracts && forge build) && node tools/bridge-ui-test.mjs [shotsDir]
// Flow: connect (double signature check) → bridge 150 USDG in → it arrives on SELEN → bridge 40 USDG back out →
// released on the EVM side.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import puppeteer from "puppeteer-core";
import * as L from "../lib/client.mjs";

L.useNetwork("beta");
const HERE = new URL("..", import.meta.url).pathname;
const EVM_PORT = 8548, NODE_PORT = 9331;
const EVM = `http://127.0.0.1:${EVM_PORT}`, NODE = `http://127.0.0.1:${NODE_PORT}`;
const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  operator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  user: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "selen-bridge-ui-"));
const procs = [];
let failed = 0, browser;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15 * 60_000, every = 2000) {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await sleep(every); }
}
const api = async (p) => { const r = await fetch(NODE + p); const b = await r.json(); if (!r.ok) throw new Error(b.error || r.status); return b; };
const artifact = (file, name) => JSON.parse(readFileSync(join(HERE, "contracts/out", file, `${name}.json`), "utf8"));

try {
  const anvil = spawn("anvil", ["--port", String(EVM_PORT), "--chain-id", "4663", "--silent"], { stdio: "ignore" });
  procs.push(anvil);
  // no response cache: the injected wallet asks for nonces back to back (approve, then lock)
  const provider = new ethers.JsonRpcProvider(EVM, undefined, { staticNetwork: true, cacheTimeout: -1 });
  await until(() => provider.getBlockNumber().then(() => true), "anvil", 20_000, 300);
  const owner = new ethers.NonceManager(new ethers.Wallet(KEYS.owner, provider));
  const operator = new ethers.Wallet(KEYS.operator, provider);
  const userW = new ethers.Wallet(KEYS.user, provider);
  const userSigner = new ethers.NonceManager(userW);
  const mock = artifact("SelenBridge.t.sol", "MockToken"), br = artifact("SelenBridge.sol", "SelenBridge");
  const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode.object, owner).deploy(...args); await c.waitForDeployment(); return c; };
  const usdg = await deploy(mock, "USDG", 6, 0), stoken = await deploy(mock, "SELEN", 18, 0), bridge = await deploy(br, operator.address);
  await (await bridge.setToken(await usdg.getAddress(), true, 1, 1, 1_000_000n * 10n ** 6n, 100_000n * 10n ** 6n)).wait();
  await (await bridge.setToken(await stoken.getAddress(), true, 0, 10n ** 10n, 10n ** 27n, 10n ** 25n)).wait();
  await (await usdg.mint(userW.address, 1_000n * 10n ** 6n)).wait();

  writeFileSync(join(tmp, "operator.key"), KEYS.operator);
  await new Promise((res, rej) => {
    const g = spawn(process.execPath, ["tools/genesis.mjs", "beta", "--to", "bridge", "--selen", "1000000", "--usdg", "1000000", "--split", "32", "--out", join(tmp, "genesis.json")],
      { cwd: HERE, env: { ...process.env, BRIDGE_SEED_FILE: join(tmp, "bridge.seed") }, stdio: "ignore" });
    g.on("exit", (c) => (c ? rej(new Error("genesis failed")) : res()));
  });
  const node = spawn(process.execPath, ["server.mjs"], {
    cwd: HERE, stdio: "ignore",
    env: { ...process.env, NETWORK: "beta", PORT: String(NODE_PORT), DATA_DIR: join(tmp, "data"), GENESIS_FILE: join(tmp, "genesis.json"), FAUCET: "0", MINER: "1", MINER_THREADS: "2",
      MINER_ADDRESS: L.keysFromSeed(new Uint8Array(32).fill(3)).quantum, BRIDGE: "1", BRIDGE_RPC: EVM, BRIDGE_CONTRACT: await bridge.getAddress(),
      BRIDGE_TOKENS: `${await usdg.getAddress()},${await stoken.getAddress()}`, BRIDGE_OPERATOR_KEY_FILE: join(tmp, "operator.key"),
      BRIDGE_SEED_FILE: join(tmp, "bridge.seed"), BRIDGE_RH_CONFIRMATIONS: "0", BRIDGE_POLL_MS: "1500" },
  });
  procs.push(node);
  await until(() => api("/api/bridge"), "node + bridge", 60_000, 500);
  await until(async () => (await api("/api/status")).height >= L.PARAMS.maturity, "reserve maturity");
  ok(true, "anvil + bridge contract + beta node with BRIDGE=1 running");

  // ---- browser with an injected wallet that signs with the anvil user key
  const d = `${homedir()}/.cache/puppeteer/chrome`;
  const exe = `${d}/${readdirSync(d).sort().pop()}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
  browser = await puppeteer.launch({ executablePath: exe, headless: true, protocolTimeout: 30 * 60_000 });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 1000 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  let signs = 0;
  await page.exposeFunction("__eth", async (method, params = []) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [userW.address];
    if (method === "eth_chainId") return "0x1237";
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "personal_sign") { signs++; return userW.signMessage(ethers.getBytes(params[0])); }
    if (method === "eth_sendTransaction") { const t = params[0]; const r = await userSigner.sendTransaction({ to: t.to, data: t.data }); return r.hash; }
    return provider.send(method, params);
  });
  await page.evaluateOnNewDocument(() => {
    window.ethereum = { isMetaMask: true, request: ({ method, params }) => window.__eth(method, params), on() {} };
  });
  await page.goto(NODE + "/bridge", { waitUntil: "networkidle2" });
  await page.waitForSelector("#cn");
  await page.click("#cn");
  await page.waitForSelector("#dir", { timeout: 60_000 });
  ok(signs === 2, `connected: SELEN wallet made from the account's signature (asked ${signs}×, same both times)`);
  await page.waitForFunction(() => /On Robinhood Chain: 1,000/.test(document.querySelector("#have")?.textContent || ""), { timeout: 60_000 });
  ok(true, "page reads 1,000 USDG on the Robinhood side");
  if (shots) await page.screenshot({ path: `${shots}/bridge-connected.png` });

  await page.type("#amt", "150");
  await page.click("#go");
  await page.waitForFunction(() => /Locked\.|err/i.test(document.querySelector("#gomsg")?.textContent || "") || document.querySelector("#gomsg")?.className.includes("err"), { timeout: 120_000 });
  const inMsg = await page.$eval("#gomsg", (e) => e.textContent);
  ok(/Locked\./.test(inMsg), "bridge in: " + inMsg.slice(0, 90));
  ok((await usdg.balanceOf(userW.address)) === 850n * 10n ** 6n, "850 USDG left on the Robinhood side");
  await page.waitForFunction(() => /arrived on SELEN/.test(document.querySelector("#act")?.textContent || ""), { timeout: 5 * 60_000, polling: 2000 });
  ok(true, "activity: arrived on SELEN");

  // wait until the arrived USDG is spendable, then send 40 back
  await page.click('#dir button[data-d="out"]');
  await page.waitForFunction(() => /On SELEN: 150 USDG spendable/.test(document.querySelector("#have")?.textContent || ""), { timeout: 15 * 60_000, polling: 3000 });
  ok(true, "150 USDG spendable on SELEN");
  if (shots) await page.screenshot({ path: `${shots}/bridge-out-form.png` });
  await page.$eval("#amt", (e) => (e.value = ""));
  await page.type("#amt", "40");
  await page.click("#go");
  await page.waitForFunction(() => /Sent to the bridge|err/i.test(document.querySelector("#gomsg")?.textContent || "") || document.querySelector("#gomsg")?.className.includes("err"), { timeout: 120_000 });
  const outMsg = await page.$eval("#gomsg", (e) => e.textContent);
  ok(/Sent to the bridge/.test(outMsg), "bridge out: " + outMsg.slice(0, 90));
  await page.waitForFunction(() => /released on Robinhood/.test(document.querySelector("#act")?.textContent || ""), { timeout: 15 * 60_000, polling: 3000 });
  ok((await usdg.balanceOf(userW.address)) === 890n * 10n ** 6n, `released: ${ethers.formatUnits(await usdg.balanceOf(userW.address), 6)} USDG on the Robinhood side (850 + 40)`);
  if (shots) await page.screenshot({ path: `${shots}/bridge-done.png`, fullPage: true });
  ok(!errs.length, errs.length ? "JS errors: " + errs.join(" | ") : "no JS errors");
} catch (e) {
  failed++;
  console.log("✗", e.message);
} finally {
  await browser?.close().catch(() => {});
  for (const p of procs) p.kill();
  rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : "all passed");
  process.exit(failed ? 1 : 0);
}
