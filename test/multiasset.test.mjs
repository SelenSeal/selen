// Multi-asset (beta network): genesis reserve, private USDG transfer, per-asset fees in the coinbase, same-asset rings.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNetwork, PARAMS, parseAsset } from "../lib/params.mjs";

useNetwork("beta");
const C = await import("../lib/crypto.mjs");
const T = await import("../lib/tx.mjs");
const { Chain } = await import("../lib/chain.mjs");
const { NodeWallet } = await import("../server/wallet.mjs");
const { pickRing } = await import("../lib/ring.mjs");

const aliceSeed = new Uint8Array(32).fill(7), bobSeed = new Uint8Array(32).fill(8), minerSeed = new Uint8Array(32).fill(9);
const alice = C.keysFromSeed(aliceSeed), bob = C.keysFromSeed(bobSeed), minerK = C.keysFromSeed(minerSeed);
const USDG = 1, SELEN = 0;

// reserve: 20 outputs of each asset to alice, in the genesis block
function reserve() {
  const out = [];
  for (const [a, each] of [[SELEN, parseAsset("1000", SELEN)], [USDG, parseAsset("500", USDG)]])
    for (let k = 0; k < 20; k++) out.push({ a, ...C.makeOutput(C.decodeAddress(alice.quantum), each, { coinbase: true }).out });
  return [T.txToJson({ v: 2, asset: 0, cb: 0, in: [], out, fee: 0n, rp: [], sig: [] })];
}

const dir = mkdtempSync(join(tmpdir(), "selen-beta-"));
const chain = new Chain({ dataDir: dir, pow: () => new Uint8Array(32), log: () => {}, genesis: reserve() });
let clock = Math.floor(Date.now() / 1000) - 60;
const mine = () => {
  const tpl = chain.buildTemplate(minerK.quantum, { time: ++clock });
  return { tpl, res: chain.addBlock({ header: tpl.header, txs: tpl.txs }, { skipPow: true }) };
};
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("genesis reserve: outputs per asset, each indexed inside its asset", () => {
  const st = chain.stats();
  assert.equal(st.assets.find((a) => a.id === USDG).outputs, 20);
  assert.equal(st.assets.find((a) => a.id === SELEN).outputs, 20);
  assert.equal(chain.outputByAidx(USDG, 0).gidx, 20);
  assert.equal(chain.outputByAidx(SELEN, 19).gidx, 19);
});

test("private USDG transfer: one asset per tx, fee in USDG, coinbase pays the USDG fee", () => {
  for (let k = 0; k < PARAMS.maturity; k++) mine();
  assert.equal(chain.eligibleCount(undefined, USDG), 20);
  const wa = new NodeWallet(chain, aliceSeed, { log: () => {}, name: "alice" });
  assert.equal(wa.balances(USDG).unlocked, parseAsset("10000", USDG));
  const sent = wa.send(bob.quantum, parseAsset("25.5", USDG), USDG);
  const m = chain.mempool.get(sent.id);
  assert.equal(m.tx.asset, USDG);
  assert.ok(m.tx.out.every((o) => o.a === USDG));
  // every ring member is a USDG output
  for (const i of m.tx.in) for (const g of i.ring) assert.equal(chain.getOutput(g).asset, USDG);
  const { tpl } = mine();
  const cb = T.parseTx(tpl.txs[0]);
  assert.deepEqual(cb.out.map((o) => o.a), [SELEN, USDG]);
  assert.equal(cb.out[1].amount, BigInt(sent.fee));
  // bob finds a sealed USDG output of 25.5
  const wb = new NodeWallet(chain, bobSeed, { log: () => {}, name: "bob" });
  wb.catchUp();
  for (let k = 0; k < PARAMS.maturity; k++) mine();
  assert.equal(wb.balances(USDG).unlocked, parseAsset("25.5", USDG));
  assert.equal(wb.balances(SELEN).unlocked, 0n);
  // and can pass it on (rings again inside USDG)
  const back = wb.send(alice.quantum, parseAsset("10", USDG), USDG);
  assert.ok(chain.mempool.has(back.id));
  mine();
});

test("SELEN still moves on its own (v2, asset 0)", () => {
  const wa = new NodeWallet(chain, aliceSeed, { log: () => {}, name: "alice" });
  const r = wa.send(bob.quantum, parseAsset("3", SELEN), SELEN);
  assert.equal(chain.mempool.get(r.id).tx.asset, SELEN);
  mine();
});

test("a ring may not mix assets", () => {
  const wa = new NodeWallet(chain, aliceSeed, { log: () => {}, name: "alice" });
  const own = wa.q.all.all().find((o) => o.asset === USDG && !chain.keyImageSpent(o.ki));
  const row = chain.getOutput(own.gidx);
  const got = C.scanOutput(alice, { ...row, P: C.hexToBytes(row.P), C: C.hexToBytes(row.C), kem: row.kem ? C.hexToBytes(row.kem) : undefined, R: row.R ? C.hexToBytes(row.R) : undefined, amount: row.amount ?? undefined, ek: row.ek ? C.hexToBytes(row.ek) : undefined });
  // decoys from SELEN instead of USDG
  const ring = pickRing(5, chain.eligibleCount(undefined, SELEN)).map((ai) => chain.outputByAidx(SELEN, ai));
  ring[0] = row;
  ring.sort((a, b) => a.gidx - b.gidx);
  const members = ring.map((r) => ({ gidx: r.gidx, P: C.hexToBytes(r.P), C: C.hexToBytes(r.C) }));
  const { tx } = T.buildTx({ inputs: [{ gidx: row.gidx, v: got.v, mask: got.mask, x: got.x, P: C.hexToBytes(row.P), C: C.hexToBytes(row.C), ring: members }],
    dests: [{ addr: C.decodeAddress(bob.quantum), v: 1000n }], change: C.decodeAddress(alice.quantum), asset: USDG });
  assert.throws(() => chain.addToMempool(T.txToJson(tx)), /holds another asset/);
});

test("outputs of one transfer must share an asset, v1 is refused, coinbase must pay per-asset fees exactly", () => {
  const { out } = C.makeOutput(C.decodeAddress(bob.quantum), 5n);
  const j = { v: 2, in: [], out: [{ a: 0, ...T.txToJson({ v: 2, asset: 0, cb: 1, in: [], out: [{ a: 0, ...out, amount: 5n }], fee: 0n, rp: [], sig: [] }).out[0] }, { a: 1, ...T.txToJson({ v: 2, asset: 0, cb: 1, in: [], out: [{ a: 1, ...out, amount: 5n }], fee: 0n, rp: [], sig: [] }).out[0] }], fee: "0", rp: [], sig: [] };
  for (const o of j.out) { delete o.amount; o.ek = "00".repeat(8); }
  assert.throws(() => T.parseTx(j), /one asset/);
  assert.throws(() => T.parseTx({ ...j, v: 1 }), /v2/);
  const tpl = chain.buildTemplate(minerK.quantum, { time: ++clock });
  const cb = T.parseTx(tpl.txs[0]);
  const extra = { a: USDG, ...C.makeOutput(C.decodeAddress(minerK.quantum), 1n, { coinbase: true }).out };
  const bad = T.txToJson({ ...cb, out: [...cb.out, extra] });
  const txs = [bad, ...tpl.txs.slice(1)];
  const header = { ...tpl.header, root: T.merkleRoot(txs.map((x) => T.txId(T.parseTx(x)))) };
  assert.throws(() => chain.addBlock({ header, txs }, { skipPow: true }), /coinbase must pay exactly/);
});

test("rollback keeps indices inside each asset consistent", () => {
  const before = chain.stats().assets.find((a) => a.id === USDG).outputs;
  const h = chain.tip().height;
  const wa = new NodeWallet(chain, aliceSeed, { log: () => {}, name: "alice" });
  wa.send(bob.quantum, parseAsset("1", USDG), USDG);
  mine();
  assert.ok(chain.stats().assets.find((a) => a.id === USDG).outputs > before);
  chain.rollbackTo(h);
  assert.equal(chain.stats().assets.find((a) => a.id === USDG).outputs, before);
  mine(); // the transfer returns from the mempool and lands again
  const n = chain.stats().assets.find((a) => a.id === USDG).outputs;
  assert.ok(chain.outputByAidx(USDG, n - 1));
  assert.equal(chain.outputByAidx(USDG, n), undefined);
});
