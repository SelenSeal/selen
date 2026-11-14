// Server-side wallet (the testnet faucet). Seed lives outside the repo, chmod 600.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { keysFromSeed, scanOutput, decodeAddress, hexToBytes, bytesToHex, randomBytes, keyImage } from "../lib/crypto.mjs";
import { buildTx, txToJson } from "../lib/tx.mjs";
import { pickRing } from "../lib/ring.mjs";
import { PARAMS, asset as assetInfo } from "../lib/params.mjs";

export function loadSeed(file) {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytesToHex(randomBytes(32)) + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return hexToBytes(readFileSync(file, "utf8").trim());
}

export const rowToOut = (o) => ({
  P: hexToBytes(o.P), C: hexToBytes(o.C), vt: o.vt,
  R: o.R ? hexToBytes(o.R) : undefined, kem: o.kem ? hexToBytes(o.kem) : undefined,
  ek: o.ek ? hexToBytes(o.ek) : undefined, amount: o.amount ?? undefined, m: o.m ? hexToBytes(o.m) : undefined,
});

export class NodeWallet {
  // several wallets can live on one node (faucet, bridge reserve): each gets its own table and scan cursor;
  // the unnamed one is the faucet and keeps the original table
  constructor(chain, seed, { log = console.log, name = "", onReceive } = {}) {
    this.chain = chain;
    this.keys = keysFromSeed(seed);
    this.log = log;
    this.onReceive = onReceive; // (output) => void, for every output this wallet finds while scanning
    const T = name ? `wallet_outputs_${name.replace(/\W/g, "")}` : "wallet_outputs";
    this.scanKey = name ? `scan:${name}` : "scan";
    const db = chain.db;
    db.exec(`CREATE TABLE IF NOT EXISTS ${T} (gidx INTEGER PRIMARY KEY, height INTEGER NOT NULL, v TEXT NOT NULL, ki TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`);
    const wcols = db.prepare(`PRAGMA table_info(${T})`).all().map((c) => c.name);
    if (!wcols.includes("asset")) db.exec(`ALTER TABLE ${T} ADD COLUMN asset INTEGER NOT NULL DEFAULT 0`);
    if (!wcols.includes("memo")) db.exec(`ALTER TABLE ${T} ADD COLUMN memo TEXT`);
    this.q = {
      ins: db.prepare(`INSERT OR IGNORE INTO ${T} (gidx, height, v, ki, asset, memo) VALUES (?,?,?,?,?,?)`),
      all: db.prepare(`SELECT * FROM ${T} ORDER BY gidx`),
      getMeta: db.prepare("SELECT v FROM meta WHERE k = ?"),
      setMeta: db.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)"),
      dropAbove: db.prepare(`DELETE FROM ${T} WHERE height > ?`),
    };
    this.catchUp();
    chain.on((ev) => {
      if (ev.type === "block") this.catchUp();
      if (ev.type === "rollback") {
        this.q.dropAbove.run(ev.height);
        this.q.setMeta.run(this.scanKey, String(chain.outputsUpTo(ev.height)));
      }
    });
  }
  get address() { return this.keys.quantum; }

  catchUp() {
    let from = Number(this.q.getMeta.get(this.scanKey)?.v || 0);
    for (;;) {
      const rows = this.chain.outputsFrom(from, 500);
      if (!rows.length) break;
      for (const o of rows) {
        const got = scanOutput(this.keys, rowToOut(o));
        if (got) {
          this.q.ins.run(o.gidx, o.height, got.v.toString(), bytesToHex(keyImage(got.x, hexToBytes(o.P)).toBytes()), o.asset || 0, got.memo ? bytesToHex(got.memo) : null);
          this.onReceive?.({ gidx: o.gidx, height: o.height, txid: o.txid, pos: o.pos, v: got.v, asset: o.asset || 0, memo: got.memo || null });
        }
        from = o.gidx + 1;
      }
    }
    this.q.setMeta.run(this.scanKey, String(from));
  }

  balances(asset = 0) {
    const pending = this.chain.pendingKeyImages();
    const cutoff = this.chain.matureCutoff(this.chain.tip().height + 1);
    let unlocked = 0n, locked = 0n, count = 0;
    for (const o of this.q.all.all()) {
      if ((o.asset || 0) !== asset) continue;
      if (this.chain.keyImageSpent(o.ki) || pending.has(o.ki)) continue;
      count++;
      if (o.height <= cutoff) unlocked += BigInt(o.v); else locked += BigInt(o.v);
    }
    return { unlocked, locked, count };
  }

  /** Pay `amount` atomic units of `asset` to `to` (address string). Returns { id, fee }. */
  send(to, amount, asset = 0, { memo } = {}) {
    const dest = decodeAddress(to);
    const pending = this.chain.pendingKeyImages();
    const cutoff = this.chain.matureCutoff(this.chain.tip().height + 1);
    const spendable = this.q.all.all()
      .filter((o) => (o.asset || 0) === asset && o.height <= cutoff && !this.chain.keyImageSpent(o.ki) && !pending.has(o.ki))
      .sort((a, b) => Number(BigInt(b.v) - BigInt(a.v)));
    const picked = [];
    let sum = 0n;
    const reserve = (PARAMS.multiAsset ? assetInfo(asset).feePerKB : PARAMS.feePerKB) * 40n;
    for (const o of spendable) {
      picked.push(o); sum += BigInt(o.v);
      if (sum >= amount + reserve) break;
    }
    if (sum < amount + reserve) throw new Error("faucet is refilling: not enough mature funds yet");
    // decoys come from the same asset: pick positions inside the asset, then look up their global indices
    const eligible = this.chain.eligibleCount(undefined, asset);
    const inputs = picked.map((o) => {
      const row = this.chain.getOutput(o.gidx);
      const got = scanOutput(this.keys, rowToOut(row));
      const ring = pickRing(row.aidx ?? row.gidx, eligible).map((ai) => {
        const r = this.chain.outputByAidx(asset, ai);
        return { gidx: r.gidx, P: hexToBytes(r.P), C: hexToBytes(r.C) };
      });
      return { gidx: o.gidx, v: got.v, mask: got.mask, x: got.x, P: hexToBytes(row.P), C: hexToBytes(row.C), ring };
    });
    const { tx, fee } = buildTx({ inputs, dests: [{ addr: dest, v: amount, ...(memo ? { memo } : {}) }], change: decodeAddress(this.keys.quantum), asset });
    const res = this.chain.addToMempool(txToJson(tx));
    return { id: res.id, fee: fee.toString() };
  }
}
