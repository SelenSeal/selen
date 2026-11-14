// SELEN chain state: SQLite storage, consensus checks, difficulty, mempool.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256, utf8, bytesToHex, hexToBytes, decodeAddress, makeOutput, enc } from "./crypto.mjs";
import {
  parseTx, txToJson, txId, txBytes, verifyTxCrypto, checkTxShape, headerBytes, blockId,
  merkleRoot, powOk, hx,
} from "./tx.mjs";
import { PARAMS, blockReward } from "./params.mjs";

const ZERO32 = "00".repeat(32);

/** Genesis: the note in the root; on multi-asset networks also the reserve tx (cb 0) the bridge releases from. */
export function genesisBlock(reserve = []) {
  const note = bytesToHex(sha256(utf8(PARAMS.genesisNote)));
  const root = reserve.length ? merkleRoot([note, ...reserve.map((j) => txId(parseTx(j)))]) : note;
  const header = { v: 1, height: 0, prev: ZERO32, time: PARAMS.genesisTime, root, diff: PARAMS.initialDifficulty.toString(), nonce: 0 };
  return { header, txs: reserve };
}

export class Chain {
  constructor({ dataDir, pow, log = console.log, genesis = [] }) {
    mkdirSync(dataDir, { recursive: true });
    this.pow = pow; // (headerBytes:Uint8Array) => Uint8Array(32)
    this.log = log;
    this.genesisTxs = genesis;
    this.db = new DatabaseSync(join(dataDir, "chain.db"));
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS blocks (height INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, prev TEXT NOT NULL,
        time INTEGER NOT NULL, diff TEXT NOT NULL, work TEXT NOT NULL, ntx INTEGER NOT NULL, size INTEGER NOT NULL,
        reward TEXT NOT NULL, fees TEXT NOT NULL, pow TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS txs (id TEXT PRIMARY KEY, height INTEGER NOT NULL, pos INTEGER NOT NULL, size INTEGER NOT NULL,
        fee TEXT NOT NULL, nin INTEGER NOT NULL, nout INTEGER NOT NULL, cb INTEGER NOT NULL, quantum INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS txs_h ON txs(height);
      CREATE TABLE IF NOT EXISTS outputs (gidx INTEGER PRIMARY KEY, height INTEGER NOT NULL, txid TEXT NOT NULL, pos INTEGER NOT NULL,
        P TEXT NOT NULL, C TEXT NOT NULL, vt INTEGER NOT NULL, R TEXT, kem TEXT, ek TEXT, amount TEXT, cb INTEGER NOT NULL,
        asset INTEGER NOT NULL DEFAULT 0, aidx INTEGER, m TEXT);
      CREATE INDEX IF NOT EXISTS outputs_h ON outputs(height);
      CREATE INDEX IF NOT EXISTS outputs_tx ON outputs(txid);
      CREATE TABLE IF NOT EXISTS keyimages (ki TEXT PRIMARY KEY, height INTEGER NOT NULL, txid TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ki_h ON keyimages(height);
    `);
    // chains created before multi-asset support: every output is asset 0 and its index within the asset is its gidx
    const cols = this.db.prepare("PRAGMA table_info(outputs)").all().map((c) => c.name);
    if (!cols.includes("asset")) this.db.exec("ALTER TABLE outputs ADD COLUMN asset INTEGER NOT NULL DEFAULT 0; ALTER TABLE outputs ADD COLUMN aidx INTEGER;");
    if (!cols.includes("m")) this.db.exec("ALTER TABLE outputs ADD COLUMN m TEXT;");
    this.db.exec(`UPDATE outputs SET aidx = gidx WHERE aidx IS NULL AND asset = 0;
      CREATE UNIQUE INDEX IF NOT EXISTS outputs_aa ON outputs(asset, aidx);
      CREATE INDEX IF NOT EXISTS outputs_ah ON outputs(asset, height);`);
    this.q = {
      tip: this.db.prepare("SELECT * FROM blocks ORDER BY height DESC LIMIT 1"),
      recent: this.db.prepare("SELECT height,time,diff FROM blocks WHERE height > ? ORDER BY height ASC"),
      byHeight: this.db.prepare("SELECT * FROM blocks WHERE height = ?"),
      byId: this.db.prepare("SELECT * FROM blocks WHERE id = ?"),
      blocksDesc: this.db.prepare("SELECT height,id,time,diff,ntx,size,reward,fees FROM blocks WHERE height <= ? ORDER BY height DESC LIMIT ?"),
      out: this.db.prepare("SELECT * FROM outputs WHERE gidx = ?"),
      outRange: this.db.prepare("SELECT * FROM outputs WHERE gidx >= ? ORDER BY gidx ASC LIMIT ?"),
      outCount: this.db.prepare("SELECT COUNT(*) n FROM outputs"),
      outMature: this.db.prepare("SELECT COUNT(*) n FROM outputs WHERE asset = ? AND height <= ?"),
      outCountAsset: this.db.prepare("SELECT COUNT(*) n FROM outputs WHERE asset = ?"),
      outUpTo: this.db.prepare("SELECT COUNT(*) n FROM outputs WHERE height <= ?"),
      byAidx: this.db.prepare("SELECT * FROM outputs WHERE asset = ? AND aidx = ?"),
      outQuantum: this.db.prepare("SELECT COUNT(*) n FROM outputs WHERE kem IS NOT NULL"),
      outByTx: this.db.prepare("SELECT gidx,pos FROM outputs WHERE txid = ? ORDER BY pos"),
      ki: this.db.prepare("SELECT * FROM keyimages WHERE ki = ?"),
      kiSince: this.db.prepare("SELECT ki,height FROM keyimages WHERE height >= ? ORDER BY height ASC LIMIT ?"),
      kiCount: this.db.prepare("SELECT COUNT(*) n FROM keyimages"),
      tx: this.db.prepare("SELECT * FROM txs WHERE id = ?"),
      txCount: this.db.prepare("SELECT COUNT(*) n, SUM(quantum) q FROM txs WHERE cb = 0"),
      recentTxs: this.db.prepare("SELECT t.*, b.time FROM txs t JOIN blocks b ON b.height = t.height WHERE t.cb = 0 ORDER BY t.height DESC, t.pos DESC LIMIT ?"),
      insBlock: this.db.prepare("INSERT INTO blocks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"),
      insTx: this.db.prepare("INSERT INTO txs VALUES (?,?,?,?,?,?,?,?,?)"),
      insOut: this.db.prepare("INSERT INTO outputs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"),
      insKi: this.db.prepare("INSERT INTO keyimages VALUES (?,?,?)"),
    };
    this.mempool = new Map(); // txid -> { tx, json, size, fee, time, kis:[hex] }
    this.verified = new Set(); // txids whose crypto already passed
    this.listeners = new Set();
    if (!this.q.tip.get()) this._insertGenesis();
    this._loadTip();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(ev) { for (const fn of this.listeners) { try { fn(ev); } catch (e) { this.log("[listener]", e.message); } } }

  _insertGenesis() {
    const g = genesisBlock(this.genesisTxs);
    const id = blockId(g.header);
    const txs = g.txs.map((j) => parseTx(j));
    this.db.exec("BEGIN");
    try {
      this.q.insBlock.run(0, id, g.header.prev, g.header.time, g.header.diff, g.header.diff, txs.length, headerBytes(g.header).length,
        "0", "0", ZERO32, JSON.stringify(g));
      this._insertTxs(0, txs, txs.map((t) => txId(t)));
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  /** Rows for a block's txs, outputs (with their index inside their asset) and key images. */
  _insertTxs(height, txs, ids) {
    let gidx = Number(this.q.outCount.get().n);
    const next = new Map();
    const aidxOf = (a) => {
      if (!next.has(a)) next.set(a, Number(this.q.outCountAsset.get(a).n));
      const v = next.get(a);
      next.set(a, v + 1);
      return v;
    };
    txs.forEach((t, pos) => {
      const isCb = t.cb !== undefined;
      const quantum = t.out.some((o) => o.kem) ? 1 : 0;
      this.q.insTx.run(ids[pos], height, pos, txBytes(t).length, t.fee.toString(), t.in.length, t.out.length, isCb ? 1 : 0, quantum);
      t.out.forEach((o, i) => {
        this.q.insOut.run(gidx++, height, ids[pos], i, hx(o.P), hx(o.C), o.vt, o.R ? hx(o.R) : null,
          o.kem ? hx(o.kem) : null, o.ek ? hx(o.ek) : null, isCb ? o.amount.toString() : null, isCb ? 1 : 0, o.a || 0, aidxOf(o.a || 0), o.m ? hx(o.m) : null);
      });
      for (const inp of t.in) this.q.insKi.run(hx(inp.kib), height, ids[pos]);
    });
  }

  _loadTip() {
    const t = this.q.tip.get();
    this.tipRow = t;
    this.headers = this.q.recent.all(Math.max(-1, t.height - 200)).map((r) => ({ height: r.height, time: r.time, diff: BigInt(r.diff) }));
  }

  tip() {
    const t = this.tipRow;
    return { height: t.height, id: t.id, time: t.time, diff: t.diff, work: t.work };
  }

  // ---------- consensus helpers ----------
  nextDifficulty() {
    const T = PARAMS.targetBlockTime;
    const hs = this.headers;
    const n = Math.min(PARAMS.lwmaWindow, hs.length - 1);
    if (n < 3) return PARAMS.initialDifficulty;
    let weighted = 0n, sumD = 0n;
    for (let i = 1; i <= n; i++) {
      const cur = hs[hs.length - n - 1 + i], prev = hs[hs.length - n - 2 + i];
      let st = cur.time - prev.time;
      if (st < 1) st = 1;
      if (st > 6 * T) st = 6 * T;
      weighted += BigInt(i * st);
      sumD += cur.diff;
    }
    const k = BigInt((n * (n + 1)) / 2);
    let next = (sumD * BigInt(T) * k) / (BigInt(n) * weighted);
    const last = hs[hs.length - 1].diff;
    if (next > last * 2n) next = last * 2n;
    if (next < last / 2n) next = last / 2n;
    if (next < PARAMS.minDifficulty) next = PARAMS.minDifficulty;
    return next;
  }

  medianTime() {
    const ts = this.headers.slice(-PARAMS.medianWindow).map((h) => h.time).sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)];
  }

  /** Outputs created at height <= this are usable in rings of a block at `height`. */
  matureCutoff(height) { return height - PARAMS.maturity; }
  eligibleCount(height = this.tipRow.height + 1, asset = 0) { return Number(this.q.outMature.get(asset, this.matureCutoff(height)).n); }
  outputByAidx(asset, aidx) { return this.q.byAidx.get(asset, aidx); }
  /** Number of outputs created at or below `height` (= the gidx right after that block). */
  outputsUpTo(height) { return Number(this.q.outUpTo.get(height).n); }

  // ---------- lookups ----------
  getOutput(gidx) { return this.q.out.get(gidx); }
  outputsFrom(gidx, limit) { return this.q.outRange.all(gidx, limit); }
  keyImageSpent(kiHex) { return this.q.ki.get(kiHex); }
  keyImagesSince(height, limit) { return this.q.kiSince.all(height, limit); }
  blockAt(height) { const r = this.q.byHeight.get(height); return r ? { ...r, block: JSON.parse(r.json) } : null; }
  blockById(id) { const r = this.q.byId.get(id); return r ? { ...r, block: JSON.parse(r.json) } : null; }
  blocksDesc(fromHeight, limit) { return this.q.blocksDesc.all(fromHeight, limit); }
  txRow(id) { return this.q.tx.get(id); }
  outputsOfTx(id) { return this.q.outByTx.all(id); }
  recentTxs(limit) { return this.q.recentTxs.all(limit); }

  stats() {
    const t = this.tipRow;
    const tx = this.q.txCount.get();
    const window = this.headers.filter((h) => h.height >= 1).slice(-(PARAMS.lwmaWindow + 1));
    let avg = null, hashrate = null;
    if (window.length > 2) {
      const span = window.at(-1).time - window[0].time;
      avg = span / (window.length - 1);
      const work = window.slice(1).reduce((s, h) => s + h.diff, 0n);
      hashrate = span > 0 ? Number(work) / span : null;
    }
    return {
      height: t.height, tip: t.id, tipTime: t.time, difficulty: this.nextDifficulty().toString(),
      outputs: Number(this.q.outCount.get().n), quantumOutputs: Number(this.q.outQuantum.get().n),
      transfers: Number(tx.n || 0), quantumTransfers: Number(tx.q || 0), keyImages: Number(this.q.kiCount.get().n),
      eligibleOutputs: this.eligibleCount(), avgBlockTime: avg, hashrate, mempool: this.mempool.size,
      reward: blockReward(t.height + 1).toString(), cumulativeWork: t.work,
      assets: PARAMS.assets.map((a) => ({ id: a.id, ticker: a.ticker, decimals: a.decimals, outputs: Number(this.q.outCountAsset.get(a.id).n), eligible: this.eligibleCount(undefined, a.id) })),
    };
  }

  // ---------- transaction validation ----------
  ringMembers(tx, height) {
    const cutoff = this.matureCutoff(height);
    return tx.in.map((inp) => inp.ring.map((g) => {
      const o = this.q.out.get(g);
      if (!o) throw new Error(`ring member ${g} does not exist`);
      if (o.height > cutoff) throw new Error(`ring member ${g} is not mature`);
      if ((o.asset || 0) !== tx.asset) throw new Error(`ring member ${g} holds another asset`);
      return { P: hexToBytes(o.P), C: hexToBytes(o.C) };
    }));
  }

  validateTx(tx, { height, spentInBlock } = {}) {
    height ??= this.tipRow.height + 1;
    const size = checkTxShape(tx);
    for (const i of tx.in) {
      const h = hx(i.kib);
      if (this.q.ki.get(h)) throw new Error("key image already spent (double spend)");
      if (spentInBlock?.has(h)) throw new Error("key image spent twice in block");
    }
    const members = this.ringMembers(tx, height);
    const id = txId(tx);
    if (!this.verified.has(id)) {
      const res = verifyTxCrypto(tx, members);
      if (!res.ok) throw new Error("crypto check failed: " + res.checks.filter((c) => !c.ok).map((c) => c.name).join(", "));
      this.verified.add(id);
      if (this.verified.size > 5000) this.verified.delete(this.verified.values().next().value);
    }
    return { id, size };
  }

  addToMempool(json) {
    const tx = parseTx(json);
    const id = txId(tx);
    if (this.mempool.has(id)) return { id, known: true };
    if (this.q.tx.get(id)) throw new Error("already in chain");
    const kis = tx.in.map((i) => hx(i.kib));
    for (const m of this.mempool.values()) for (const k of m.kis) if (kis.includes(k)) throw new Error("key image already pending in mempool");
    const { size } = this.validateTx(tx);
    this.mempool.set(id, { tx, json: txToJson(tx), size, fee: tx.fee, time: Math.floor(Date.now() / 1000), kis });
    this._emit({ type: "mempool", id });
    return { id, size, fee: tx.fee.toString() };
  }

  pendingKeyImages() {
    const s = new Set();
    for (const m of this.mempool.values()) for (const k of m.kis) s.add(k);
    return s;
  }

  // ---------- block templates ----------
  buildTemplate(minerAddress, { time } = {}) {
    const addr = typeof minerAddress === "string" ? decodeAddress(minerAddress) : minerAddress;
    const height = this.tipRow.height + 1;
    const picked = [];
    let bytes = 0;
    const fees = new Map();
    const sorted = [...this.mempool.entries()].sort((a, b) => Number(b[1].fee * 1000n / BigInt(b[1].size) - a[1].fee * 1000n / BigInt(a[1].size)));
    for (const [id, m] of sorted) {
      if (picked.length >= PARAMS.maxBlockTxs - 1 || bytes + m.size > PARAMS.maxBlockBytes - 20_000) break;
      picked.push(m.json);
      bytes += m.size;
      fees.set(m.tx.asset, (fees.get(m.tx.asset) || 0n) + m.fee);
    }
    const cbTx = { v: PARAMS.multiAsset ? 2 : 1, asset: 0, cb: height, in: [], out: [], fee: 0n, rp: [], sig: [] };
    for (const [a, amount] of coinbasePays(height, fees)) {
      const { out } = makeOutput(addr, amount, { coinbase: true });
      cbTx.out.push(PARAMS.multiAsset ? { a, ...out } : out);
    }
    const cbJson = txToJson(cbTx);
    const txs = [cbJson, ...picked];
    const ids = txs.map((j) => txId(parseTx(j)));
    const header = {
      v: 1, height, prev: this.tipRow.id, time: Math.max(time ?? Math.floor(Date.now() / 1000), this.medianTime() + 1),
      root: merkleRoot(ids), diff: this.nextDifficulty().toString(), nonce: 0,
    };
    return { header, txs };
  }

  // ---------- block acceptance ----------
  addBlock(block, { skipPow = false, source = "local" } = {}) {
    const h = block?.header;
    if (!h || h.v !== 1) throw new Error("bad header");
    const tip = this.tipRow;
    if (h.height !== tip.height + 1) throw new Error(h.height <= tip.height ? "stale block" : "block from the future (missing parents)");
    if (h.prev !== tip.id) throw new Error("block does not extend the tip");
    if (!Number.isInteger(h.time) || h.time <= this.medianTime()) throw new Error("timestamp below median of last 11");
    if (h.time > Math.floor(Date.now() / 1000) + PARAMS.futureTimeLimit) throw new Error("timestamp too far in the future");
    const want = this.nextDifficulty();
    if (BigInt(h.diff) !== want) throw new Error(`wrong difficulty (want ${want})`);
    if (!Number.isSafeInteger(h.nonce) || h.nonce < 0) throw new Error("bad nonce");
    const hb = headerBytes(h);
    const powHash = this.pow(hb);
    if (!skipPow && !powOk(powHash, want)) throw new Error("proof of work does not meet difficulty");
    if (!Array.isArray(block.txs) || block.txs.length < 1 || block.txs.length > PARAMS.maxBlockTxs) throw new Error("tx count");

    const txs = block.txs.map((j) => parseTx(j));
    const cb = txs[0];
    if (cb.cb !== h.height) throw new Error("first tx must be the coinbase for this height");
    const ids = txs.map((t) => txId(t));
    if (new Set(ids).size !== ids.length) throw new Error("duplicate tx in block");
    if (merkleRoot(ids) !== h.root) throw new Error("merkle root mismatch");
    let size = hb.length;
    const fees = new Map();
    const spent = new Set();
    for (let k = 1; k < txs.length; k++) {
      if (txs[k].cb !== undefined) throw new Error("extra coinbase");
      if (this.q.tx.get(ids[k])) throw new Error("tx already in chain");
      const { size: s } = this.validateTx(txs[k], { height: h.height, spentInBlock: spent });
      for (const i of txs[k].in) spent.add(hx(i.kib));
      size += s;
      fees.set(txs[k].asset, (fees.get(txs[k].asset) || 0n) + txs[k].fee);
    }
    const cbRes = verifyTxCrypto(cb, []);
    if (!cbRes.ok) throw new Error("coinbase invalid");
    const reward = blockReward(h.height);
    const pays = coinbasePays(h.height, fees);
    if (cb.out.length !== pays.length || pays.some(([a, amount], k) => (cb.out[k].a || 0) !== a || cb.out[k].amount !== amount)) {
      throw new Error(`coinbase must pay exactly ${pays.map(([a, v]) => `${v} of asset ${a}`).join(", ")}`);
    }
    size += txBytes(cb).length;
    if (size > PARAMS.maxBlockBytes) throw new Error("block too large");

    // ---- apply ----
    const id = blockId(h);
    const work = (BigInt(tip.work) + BigInt(h.diff)).toString();
    this.db.exec("BEGIN");
    try {
      this.q.insBlock.run(h.height, id, h.prev, h.time, h.diff, work, txs.length, size, reward.toString(), (fees.get(0) || 0n).toString(),
        bytesToHex(powHash), JSON.stringify({ header: h, txs: block.txs }));
      this._insertTxs(h.height, txs, ids);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this._loadTip();
    // drop included or conflicting mempool txs
    for (const [mid, m] of this.mempool) {
      if (ids.includes(mid) || m.kis.some((k) => spent.has(k))) this.mempool.delete(mid);
    }
    this._emit({ type: "block", height: h.height, id, source, txs: ids });
    return { id, height: h.height };
  }

  /** Remove every block above `height`; their non-coinbase txs go back to the mempool when still valid. */
  rollbackTo(height) {
    if (height < 0) throw new Error("cannot roll back genesis");
    const removed = [];
    for (let hgt = this.tipRow.height; hgt > height; hgt--) {
      const b = this.blockAt(hgt);
      if (b) removed.push(...b.block.txs.slice(1));
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM outputs WHERE height > ?").run(height);
      this.db.prepare("DELETE FROM keyimages WHERE height > ?").run(height);
      this.db.prepare("DELETE FROM txs WHERE height > ?").run(height);
      this.db.prepare("DELETE FROM blocks WHERE height > ?").run(height);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    this._loadTip();
    for (const j of removed) { try { this.addToMempool(j); } catch {} }
    this._emit({ type: "rollback", height });
    return removed.length;
  }
}

/** What the coinbase of `height` pays: [asset, amount] pairs in asset order. Asset 0 always (reward + its fees),
 *  every other asset only when the block collected fees in it. Single-asset networks: one pair. */
export function coinbasePays(height, fees) {
  const pays = [[0, blockReward(height) + (fees.get(0) || 0n)]];
  if (PARAMS.multiAsset) for (const a of PARAMS.assets) if (a.id !== 0 && (fees.get(a.id) || 0n) > 0n) pays.push([a.id, fees.get(a.id)]);
  return pays;
}

export { headerBytes, blockId, powOk, txToJson, parseTx, txId };
