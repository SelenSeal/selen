// Bridge end to end, no real money: a local Robinhood-like chain (anvil) with the bridge contract and two mock
// tokens (USDG 6 decimals, SELEN 18 decimals), and a fresh beta SELEN node running the bridge service.
//   (cd contracts && forge build) && node tools/bridge-e2e.mjs
// Checks: lock USDG and SELEN → sealed outputs arrive on SELEN; send back with a memo → released on the EVM side;
// a restart pays nothing twice.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import * as L from "../lib/client.mjs";
import { evmMemo } from "../server/bridge.mjs";

L.useNetwork("beta");
const HERE = new URL("..", import.meta.url).pathname;
const EVM_PORT = 8547, NODE_PORT = 9330;
const EVM = `http://127.0.0.1:${EVM_PORT}`, NODE = `http://127.0.0.1:${NODE_PORT}`;
// anvil's well-known development keys (no value anywhere)
const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  operator: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  user: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};
const tmp = mkdtempSync(join(tmpdir(), "selen-bridge-"));
const procs = [];
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15 * 60_000, every = 2000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(every);
  }
}
const api = async (p, opts) => { const r = await fetch(NODE + p, opts); const b = await r.json(); if (!r.ok) throw new Error(b.error || r.status); return b; };
const artifact = (file, name) => JSON.parse(readFileSync(join(HERE, "contracts/out", file, `${name}.json`), "utf8"));

function startNode() {
  const env = {
    ...process.env, NETWORK: "beta", PORT: String(NODE_PORT), DATA_DIR: join(tmp, "data"), GENESIS_FILE: join(tmp, "genesis.json"),
    FAUCET: "0", MINER: "1", MINER_ADDRESS: L.keysFromSeed(new Uint8Array(32).fill(3)).quantum, MINER_DUTY: "1",
    BRIDGE: "1", BRIDGE_RPC: EVM, BRIDGE_CONTRACT: process.env.BRIDGE_ADDR, BRIDGE_TOKENS: process.env.BRIDGE_TOKENS,
    BRIDGE_OPERATOR_KEY_FILE: join(tmp, "operator.key"), BRIDGE_SEED_FILE: join(tmp, "bridge.seed"), BRIDGE_RH_CONFIRMATIONS: "0", BRIDGE_POLL_MS: "1500",
  };
  const p = spawn(process.execPath, ["server.mjs"], { cwd: HERE, env, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => { const s = String(d); if (/\[bridge\]/.test(s)) process.stdout.write("    node: " + s.trim().split("\n").filter((x) => /bridge/.test(x)).join("\n    node: ") + "\n"); });
  p.stderr.on("data", (d) => process.stdout.write("    node!: " + String(d)));
  procs.push(p);
  return p;
}

try {
  // ---- EVM side
  const anvil = spawn("anvil", ["--port", String(EVM_PORT), "--chain-id", "4663", "--silent"], { stdio: "ignore" });
  procs.push(anvil);
  const provider = new ethers.JsonRpcProvider(EVM, undefined, { staticNetwork: true });
  await until(() => provider.getBlockNumber().then(() => true), "anvil", 20_000, 300);
  const owner = new ethers.NonceManager(new ethers.Wallet(KEYS.owner, provider));
  const operator = new ethers.Wallet(KEYS.operator, provider);
  const user = new ethers.NonceManager(new ethers.Wallet(KEYS.user, provider));
  const userAddr = await user.getAddress();
  const mock = artifact("SelenBridge.t.sol", "MockToken"), br = artifact("SelenBridge.sol", "SelenBridge");
  const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode.object, owner).deploy(...args); await c.waitForDeployment(); return c; };
  const usdg = await deploy(mock, "USDG", 6, 0), stoken = await deploy(mock, "SELEN", 18, 0);
  const bridge = await deploy(br, operator.address);
  await (await bridge.setToken(await usdg.getAddress(), true, 1, 1, 1_000_000n * 10n ** 6n, 100_000n * 10n ** 6n)).wait();
  await (await bridge.setToken(await stoken.getAddress(), true, 0, 10n ** 10n, 10n ** 27n, 10n ** 25n)).wait();
  await (await usdg.mint(userAddr, 5_000n * 10n ** 6n)).wait();
  await (await stoken.mint(userAddr, 10_000n * 10n ** 18n)).wait();
  process.env.BRIDGE_ADDR = await bridge.getAddress();
  process.env.BRIDGE_TOKENS = `${await usdg.getAddress()},${await stoken.getAddress()}`;
  ok(true, `EVM: bridge ${process.env.BRIDGE_ADDR.slice(0, 10)}… with mock USDG + SELEN, operator ${operator.address.slice(0, 10)}…`);

  // ---- SELEN side: reserve for the bridge wallet in genesis, then the node with BRIDGE=1
  writeFileSync(join(tmp, "operator.key"), KEYS.operator);
  await new Promise((res, rej) => {
    const g = spawn(process.execPath, ["tools/genesis.mjs", "beta", "--to", "bridge", "--selen", "1000000", "--usdg", "1000000", "--split", "32", "--out", join(tmp, "genesis.json")],
      { cwd: HERE, env: { ...process.env, BRIDGE_SEED_FILE: join(tmp, "bridge.seed") }, stdio: "inherit" });
    g.on("exit", (c) => (c ? rej(new Error("genesis failed")) : res()));
  });
  let node = startNode();
  await until(() => api("/api/bridge"), "node + bridge up", 60_000, 500);
  const cfg = await api("/api/bridge");
  ok(cfg.tokens.length === 2 && cfg.tokens.map((t) => t.symbol).sort().join() === "SELEN,USDG", `bridge config: ${cfg.tokens.map((t) => `${t.symbol}→${t.ticker} (reserve ${L.fmtAsset(t.reserve, t.asset)})`).join(", ")}`);

  // the user's SELEN wallet and its registered destination
  const me = L.keysFromSeed(L.randomBytes(32));
  const { dest } = await api("/api/bridge/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: me.quantum }) });
  await until(async () => (await api("/api/status")).height >= L.PARAMS.maturity, "reserve maturity");

  // ---- Robinhood → SELEN
  const uUsdg = usdg.connect(user), uS = stoken.connect(user), uB = bridge.connect(user);
  await (await uUsdg.approve(process.env.BRIDGE_ADDR, ethers.MaxUint256)).wait();
  await (await uS.approve(process.env.BRIDGE_ADDR, ethers.MaxUint256)).wait();
  await (await uB.lock(await usdg.getAddress(), 250n * 10n ** 6n, dest)).wait();
  await (await uB.lock(await stoken.getAddress(), ethers.parseUnits("1234.5", 18), dest)).wait();
  const mine = async () => {
    const st = await api("/api/status");
    const r = await api(`/api/outputs?from=0&limit=2000`);
    return { st, outs: L.scanBatch(me, r.outputs) };
  };
  const got = await until(async () => { const { outs } = await mine(); return outs.length >= 2 ? outs : null; }, "bridged outputs to arrive");
  const usdgOut = got.find((o) => o.a === 1), selOut = got.find((o) => o.a === 0);
  ok(usdgOut && BigInt(usdgOut.v) === 250n * 10n ** 6n, `250 USDG arrived as a sealed USDG output (${usdgOut && L.fmtAsset(usdgOut.v, 1)})`);
  ok(selOut && BigInt(selOut.v) === 123_450_000_000n, `1,234.5 SELEN arrived with 8 decimals (${selOut && L.fmtAsset(selOut.v, 0)})`);
  const act = await api(`/api/bridge/activity?evm=${userAddr}`);
  ok(act.deposits.length === 2 && act.deposits.every((d) => d.status === "sent"), "both deposits marked sent");

  // ---- SELEN → Robinhood: spend the USDG output to the bridge address with a memo naming the EVM address
  await until(async () => (await api("/api/status")).height >= usdgOut.h + L.PARAMS.maturity, "USDG output maturity");
  const st = await api("/api/status");
  const eligible = st.assets.find((a) => a.id === 1).eligible;
  const ids = L.pickRing(usdgOut.ai, eligible);
  const { members } = await api(`/api/ring?full=1&asset=1&ai=${ids.join(",")}`);
  const row = members.find((m) => m.g === usdgOut.g);
  const own = L.scanOutput(me, L.outFromApi(row));
  const { tx } = L.buildTx({
    inputs: [{ gidx: row.g, v: own.v, mask: own.mask, x: own.x, P: L.hexToBytes(row.P), C: L.hexToBytes(row.C), ring: members.map((m) => ({ gidx: m.g, P: L.hexToBytes(m.P), C: L.hexToBytes(m.C) })) }],
    dests: [{ addr: L.decodeAddress(cfg.bridgeAddress), v: 100n * 10n ** 6n, memo: evmMemo(userAddr) }], change: L.decodeAddress(me.quantum), asset: 1,
  });
  const sent = await api("/api/tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: L.txToJson(tx) }) });
  ok(!!sent.id, `sent 100 USDG to the bridge on SELEN with a sealed memo (${sent.id.slice(0, 12)}…)`);
  const before = await usdg.balanceOf(userAddr);
  const rel = await until(async () => { const a = await api(`/api/bridge/activity?evm=${userAddr}`); const w = a.withdrawals[0]; return w && w.status === "released" ? w : null; }, "release on the EVM side");
  const after = await usdg.balanceOf(userAddr);
  ok(after - before === 100n * 10n ** 6n, `released on Robinhood side: +${ethers.formatUnits(after - before, 6)} USDG (tx ${rel.rhTx?.slice(0, 12)}…)`);
  const info = await bridge.tokenInfo(await usdg.getAddress());
  ok(info.locked === 150n * 10n ** 6n, `contract still owes exactly 150 USDG (${ethers.formatUnits(info.locked, 6)})`);

  // ---- restart: nothing paid twice
  node.kill(); await sleep(1500);
  node = startNode();
  await until(() => api("/api/bridge"), "node back", 60_000, 500);
  await sleep(8000);
  const again = await mine();
  ok(again.outs.filter((o) => o.cb === false && (o.a === 1 ? BigInt(o.v) === 250n * 10n ** 6n : BigInt(o.v) === 123_450_000_000n)).length === 2, "after restart: no second payout on SELEN");
  ok((await usdg.balanceOf(userAddr)) === after, "after restart: no second release on the EVM side");
} catch (e) {
  failed++;
  console.log("✗", e.message);
} finally {
  for (const p of procs) p.kill();
  rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : "all passed");
  process.exit(failed ? 1 : 0);
}
