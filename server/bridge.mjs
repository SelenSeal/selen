// SELEN Bridge service. Runs inside a multi-asset node (NETWORK=beta BRIDGE=1).
//
// Robinhood Chain → SELEN: every Locked event of the bridge contract (after a few Robinhood confirmations) is paid
//   from the bridge wallet to the SELEN address registered for its `dest` hash, in the same asset, amount / unit.
// SELEN → Robinhood Chain: every output the bridge wallet receives with a memo naming an EVM address is released on
//   the contract after SELEN confirmations, amount × unit. The contract refuses a second release for the same
//   reference, so restarts and retries can never pay twice.
//
// State lives in <dataDir>/bridge.db: registered destinations, deposits, withdrawals and the Robinhood cursor.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ethers } from "ethers";
import { sha256, utf8, bytesToHex, isAddress } from "../lib/crypto.mjs";
import { PARAMS, asset as assetInfo } from "../lib/params.mjs";
import { NodeWallet, loadSeed } from "./wallet.mjs";

export const BRIDGE_ABI = [
  "event Locked(uint256 indexed id, address indexed token, address indexed from, uint256 amount, bytes32 dest)",
  "event Released(bytes32 indexed ref, address indexed token, address indexed to, uint256 amount)",
  "function lock(address token, uint256 amount, bytes32 dest) returns (uint256)",
  "function release(address token, address to, uint256 amount, bytes32 ref)",
  "function released(bytes32) view returns (bool)",
  "function operator() view returns (address)",
  "function paused() view returns (bool)",
  "function tokenInfo(address) view returns (tuple(bool enabled, uint8 asset, uint64 unit, uint128 cap, uint128 locked, uint128 dailyLimit, uint128 windowReleased, uint64 windowStart))",
];
const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];

// memo layout for "send this back to Robinhood Chain": 0x01, the 20-byte EVM address, zeros
export const MEMO_EVM = 1;
export function evmMemo(address) {
  const m = new Uint8Array(32);
  m[0] = MEMO_EVM;
  m.set(ethers.getBytes(ethers.getAddress(address)), 1);
  return m;
}
export function memoToEvm(memo) {
  if (!memo || memo.length !== 32 || memo[0] !== MEMO_EVM || memo.slice(21).some((b) => b)) return null;
  return ethers.getAddress(ethers.hexlify(memo.slice(1, 21)));
}
/** What a holder passes to lock(): sha256 of the receiving SELEN address (lowercase). */
export const destHash = (address) => "0x" + bytesToHex(sha256(utf8(String(address).trim().toLowerCase())));
/** On-chain reference of a SELEN output sent to the bridge. */
export const outputRef = (txid, pos) => ethers.sha256(ethers.toUtf8Bytes(`selen-bridge:${txid}:${pos}`));

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}
async function readJson(req) {
  let n = 0;
  const parts = [];
  for await (const c of req) { n += c.length; if (n > 20_000) throw new Error("body too large"); parts.push(c); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"); } catch { throw new Error("invalid JSON"); }
}

export async function startBridge({
  chain, dataDir, rpc, contract, operatorKey, tokens, seedFile, publicRpc = rpc, explorer = "https://robinhoodchain.blockscout.com",
  rhConfirmations = 3, selenConfirmations = PARAMS.maturity, startBlock = 0, pollMs = 4000, log = console.log,
}) {
  if (!PARAMS.multiAsset) throw new Error("the bridge needs a multi-asset network (NETWORK=beta)");
  const db = new DatabaseSync(join(dataDir, "bridge.db"));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS dests (hash TEXT PRIMARY KEY, address TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS deposits (lock_id INTEGER PRIMARY KEY, rh_tx TEXT NOT NULL, rh_block INTEGER NOT NULL, token TEXT NOT NULL,
      from_addr TEXT NOT NULL, amount_token TEXT NOT NULL, dest TEXT NOT NULL, status TEXT NOT NULL, selen_tx TEXT, error TEXT, updated INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS deposits_from ON deposits(from_addr);
    CREATE TABLE IF NOT EXISTS withdrawals (ref TEXT PRIMARY KEY, txid TEXT NOT NULL, pos INTEGER NOT NULL, gidx INTEGER NOT NULL, height INTEGER NOT NULL,
      asset INTEGER NOT NULL, amount_selen TEXT NOT NULL, to_addr TEXT NOT NULL, status TEXT NOT NULL, rh_tx TEXT, error TEXT, updated INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS withdrawals_to ON withdrawals(to_addr);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`);
  const now = () => Math.floor(Date.now() / 1000);
  const q = {
    getMeta: db.prepare("SELECT v FROM meta WHERE k = ?"),
    setMeta: db.prepare("INSERT OR REPLACE INTO meta VALUES (?, ?)"),
    dest: db.prepare("SELECT * FROM dests WHERE hash = ?"),
    addDest: db.prepare("INSERT OR IGNORE INTO dests VALUES (?, ?, ?)"),
    addDeposit: db.prepare("INSERT OR IGNORE INTO deposits VALUES (?, ?, ?, ?, ?, ?, ?, 'new', NULL, NULL, ?)"),
    openDeposits: db.prepare("SELECT * FROM deposits WHERE status IN ('new', 'waiting-dest', 'retry') ORDER BY lock_id"),
    setDeposit: db.prepare("UPDATE deposits SET status = ?, selen_tx = ?, error = ?, updated = ? WHERE lock_id = ?"),
    depositsOf: db.prepare("SELECT * FROM deposits WHERE from_addr = ? ORDER BY lock_id DESC LIMIT 50"),
    depositsTo: db.prepare("SELECT * FROM deposits WHERE dest = ? ORDER BY lock_id DESC LIMIT 50"),
    addWithdrawal: db.prepare("INSERT OR IGNORE INTO withdrawals VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirming', NULL, NULL, ?)"),
    openWithdrawals: db.prepare("SELECT * FROM withdrawals WHERE status IN ('confirming', 'retry') ORDER BY gidx"),
    setWithdrawal: db.prepare("UPDATE withdrawals SET status = ?, rh_tx = COALESCE(?, rh_tx), error = ?, updated = ? WHERE ref = ?"),
    dropWithdrawals: db.prepare("DELETE FROM withdrawals WHERE height > ? AND status IN ('confirming', 'retry')"),
    withdrawalsTo: db.prepare("SELECT * FROM withdrawals WHERE to_addr = ? ORDER BY gidx DESC LIMIT 50"),
  };

  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const net = await provider.getNetwork();
  const signer = new ethers.Wallet(operatorKey, provider);
  const bridge = new ethers.Contract(contract, BRIDGE_ABI, signer);
  const op = await bridge.operator();
  if (op.toLowerCase() !== signer.address.toLowerCase()) log(`[bridge] warning: contract operator is ${op}, this key is ${signer.address}`);

  // tokens: what the contract maps, checked against the assets this network knows
  const T = new Map();
  for (const addr of tokens) {
    const info = await bridge.tokenInfo(addr);
    if (!info.unit) { log(`[bridge] ${addr} is not set on the contract, skipped`); continue; }
    const a = assetInfo(Number(info.asset));
    const erc = new ethers.Contract(addr, ERC20_ABI, provider);
    const decimals = Number(await erc.decimals());
    if (10n ** BigInt(decimals - a.decimals) !== info.unit) throw new Error(`${addr}: unit ${info.unit} does not map ${decimals} decimals to ${a.ticker}'s ${a.decimals}`);
    T.set(addr.toLowerCase(), { token: ethers.getAddress(addr), symbol: await erc.symbol(), decimals, asset: a.id, ticker: a.ticker, unit: info.unit });
  }
  const byAsset = (id) => [...T.values()].find((t) => t.asset === id);

  // SELEN side: the wallet holding the reserves; outputs with a bridge memo become withdrawals
  const onReceive = (o) => {
    const to = memoToEvm(o.memo);
    if (!to) return; // reserve top-ups and the wallet's own change carry no bridge memo
    q.addWithdrawal.run(outputRef(o.txid, o.pos), o.txid, o.pos, o.gidx, o.height, o.asset, o.v.toString(), to.toLowerCase(), now());
  };
  const wallet = new NodeWallet(chain, loadSeed(seedFile), { log, name: "bridge", onReceive });
  chain.on((ev) => { if (ev.type === "rollback") q.dropWithdrawals.run(ev.height); });

  // ---- Robinhood → SELEN
  async function scanLocks() {
    const head = await provider.getBlockNumber();
    const to = head - rhConfirmations;
    let from = Number(q.getMeta.get("rh_cursor")?.v ?? startBlock - 1) + 1;
    const topic = bridge.interface.getEvent("Locked").topicHash;
    while (from <= to) {
      const end = Math.min(to, from + 4_999);
      const logs = await provider.getLogs({ address: contract, topics: [topic], fromBlock: from, toBlock: end });
      for (const l of logs) {
        const ev = bridge.interface.parseLog(l);
        q.addDeposit.run(Number(ev.args.id), l.transactionHash, l.blockNumber, ev.args.token.toLowerCase(), ev.args.from.toLowerCase(), ev.args.amount.toString(), ev.args.dest.toLowerCase(), now());
      }
      q.setMeta.run("rh_cursor", String(end));
      from = end + 1;
    }
  }
  function payDeposits() {
    for (const d of q.openDeposits.all()) {
      const dest = q.dest.get(d.dest);
      if (!dest) { if (d.status !== "waiting-dest") q.setDeposit.run("waiting-dest", null, "destination not registered yet", now(), d.lock_id); continue; }
      const t = T.get(d.token);
      if (!t) { q.setDeposit.run("unsupported", null, "token not mapped by this node", now(), d.lock_id); continue; }
      try {
        const r = wallet.send(dest.address, BigInt(d.amount_token) / t.unit, t.asset);
        q.setDeposit.run("sent", r.id, null, now(), d.lock_id);
        log(`[bridge] lock #${d.lock_id}: ${ethers.formatUnits(d.amount_token, t.decimals)} ${t.symbol} → SELEN tx ${r.id.slice(0, 12)}`);
      } catch (e) {
        q.setDeposit.run("retry", null, e.message, now(), d.lock_id); // e.g. reserve outputs still maturing
      }
    }
  }

  // ---- SELEN → Robinhood
  async function releaseWithdrawals() {
    const tip = chain.tip().height;
    for (const w of q.openWithdrawals.all()) {
      if (tip < w.height + selenConfirmations) continue;
      const row = chain.getOutput(w.gidx);
      if (!row || row.txid !== w.txid) { q.setWithdrawal.run("dropped", null, "output no longer on chain", now(), w.ref); continue; }
      const t = byAsset(w.asset);
      if (!t) { q.setWithdrawal.run("unsupported", null, "no token mapped to this asset", now(), w.ref); continue; }
      try {
        if (await bridge.released(w.ref)) { q.setWithdrawal.run("released", null, null, now(), w.ref); continue; }
        const tx = await bridge.release(t.token, w.to_addr, BigInt(w.amount_selen) * t.unit, w.ref);
        q.setWithdrawal.run("releasing", tx.hash, null, now(), w.ref);
        const rc = await tx.wait(1);
        q.setWithdrawal.run(rc.status === 1 ? "released" : "retry", tx.hash, rc.status === 1 ? null : "reverted", now(), w.ref);
        log(`[bridge] ${w.amount_selen} ${assetInfo(w.asset).ticker} units → ${w.to_addr.slice(0, 10)}… on Robinhood Chain, tx ${tx.hash.slice(0, 12)}`);
      } catch (e) {
        q.setWithdrawal.run("retry", null, e.shortMessage || e.message, now(), w.ref);
      }
    }
  }

  let busy = false, stopped = false;
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try { await scanLocks(); payDeposits(); await releaseWithdrawals(); }
    catch (e) { log("[bridge]", e.shortMessage || e.message); }
    finally { busy = false; }
  }
  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  tick();
  log(`[bridge] Robinhood chain ${net.chainId} · contract ${contract} · operator ${signer.address} · ${[...T.values()].map((t) => `${t.symbol}→${t.ticker}`).join(", ")} · SELEN address ${wallet.address.slice(0, 16)}…`);

  // ---- HTTP: /api/bridge*
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref?.();
  const tokenView = () => [...T.values()].map((t) => {
    const b = wallet.balances(t.asset);
    return { token: t.token, symbol: t.symbol, decimals: t.decimals, asset: t.asset, ticker: t.ticker, unit: t.unit.toString(), reserve: (b.unlocked + b.locked).toString() };
  });
  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith("/api/bridge")) return false;
    try {
      if (p === "/api/bridge" && req.method === "GET") {
        return send(res, 200, {
          enabled: true, network: PARAMS.network, chainId: Number(net.chainId), rpc: publicRpc, explorer, contract,
          bridgeAddress: wallet.address, rhConfirmations, selenConfirmations, tokens: tokenView(),
        }), true;
      }
      if (p === "/api/bridge/register" && req.method === "POST") {
        const ip = req.socket.remoteAddress || "?";
        hits.set(ip, (hits.get(ip) || 0) + 1);
        if (hits.get(ip) > 60) return send(res, 429, { error: "slow down" }), true;
        const { address } = await readJson(req);
        if (!isAddress(address)) return send(res, 400, { error: "not a SELEN address" }), true;
        const hash = destHash(address);
        q.addDest.run(hash, String(address).trim().toLowerCase(), now());
        return send(res, 200, { dest: hash }), true;
      }
      if (p === "/api/bridge/activity" && req.method === "GET") {
        const evm = (url.searchParams.get("evm") || "").toLowerCase();
        const dest = (url.searchParams.get("dest") || "").toLowerCase();
        const deposits = [...(ethers.isAddress(evm) ? q.depositsOf.all(evm) : []), ...(/^0x[0-9a-f]{64}$/.test(dest) ? q.depositsTo.all(dest) : [])]
          .filter((d, i, a) => a.findIndex((x) => x.lock_id === d.lock_id) === i)
          .map((d) => ({ id: d.lock_id, rhTx: d.rh_tx, token: d.token, symbol: T.get(d.token)?.symbol, amount: d.amount_token, status: d.status, selenTx: d.selen_tx, error: d.error, updated: d.updated }));
        const withdrawals = (ethers.isAddress(evm) ? q.withdrawalsTo.all(evm) : []).map((w) => ({
          ref: w.ref, selenTx: w.txid, height: w.height, asset: w.asset, ticker: assetInfo(w.asset).ticker, amount: w.amount_selen,
          confirmations: Math.max(0, chain.tip().height - w.height + 1), need: selenConfirmations, status: w.status, rhTx: w.rh_tx, error: w.error, updated: w.updated,
        }));
        return send(res, 200, { deposits, withdrawals }), true;
      }
      return send(res, 404, { error: "unknown bridge endpoint" }), true;
    } catch (e) {
      return send(res, 400, { error: e.message }), true;
    }
  }

  return { handle, tick, wallet, stop: () => { stopped = true; clearInterval(timer); }, tokens: T, address: wallet.address };
}
