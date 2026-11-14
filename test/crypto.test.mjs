import test from "node:test";
import assert from "node:assert/strict";
import * as C from "../lib/crypto.mjs";
import { buildTx, parseTx, txToJson, verifyTxCrypto, checkTxShape, txId } from "../lib/tx.mjs";
import { COIN } from "../lib/params.mjs";

const alice = C.keysFromSeed(new Uint8Array(32).fill(1));
const bob = C.keysFromSeed(new Uint8Array(32).fill(2));

test("addresses round-trip", () => {
  assert.ok(alice.classic.startsWith("selen1"));
  assert.ok(alice.quantum.startsWith("selenq1"));
  const q = C.decodeAddress(alice.quantum);
  assert.equal(q.kind, "quantum");
  assert.ok(q.A.equals(alice.A));
  assert.equal(C.decodeAddress(alice.classic).kind, "classic");
  assert.throws(() => C.decodeAddress(alice.classic.slice(0, -1) + "q"));
});

test("outputs open only for their receiver (classic + quantum, coinbase)", () => {
  for (const kind of ["classic", "quantum"]) {
    const { out } = C.makeOutput(C.decodeAddress(alice[kind]), 12345n);
    const got = C.scanOutput(alice, out);
    assert.equal(got.v, 12345n);
    assert.equal(C.scanOutput(bob, out), null);
    const cb = C.makeOutput(C.decodeAddress(alice[kind]), 32n * COIN, { coinbase: true });
    assert.equal(C.scanOutput(alice, cb.out).v, 32n * COIN);
  }
});

test("range proofs accept good and reject tampered", () => {
  const { out, mask, v } = C.makeOutput(C.decodeAddress(alice.quantum), 987654321n);
  const p = C.rangeProve(out.C, v, mask);
  assert.ok(C.rangeVerify(out.C, p));
  const bad = { ...p, s0: [...p.s0] }; bad.s0[3] = C.mod(bad.s0[3] + 1n);
  assert.ok(!C.rangeVerify(out.C, bad));
  const other = C.makeOutput(C.decodeAddress(alice.quantum), 5n).out;
  assert.ok(!C.rangeVerify(other.C, p));
});

test("full transaction: build, wire round-trip, verify, tamper", () => {
  // fake chain: 20 outputs, two of them alice's
  const chain = [];
  const mine = [];
  for (let g = 0; g < 20; g++) {
    const owner = g === 4 || g === 13 ? alice : bob;
    const { out } = C.makeOutput(C.decodeAddress(owner.quantum), 3n * COIN);
    chain.push(out);
    if (owner === alice) mine.push({ gidx: g, ...C.scanOutput(alice, out), P: out.P, C: out.C });
  }
  const ringFor = (g) => {
    const idx = new Set([g]);
    while (idx.size < 16) idx.add(Math.floor(Math.random() * 20));
    return [...idx].sort((a, b) => a - b).map((i) => ({ gidx: i, P: chain[i].P, C: chain[i].C }));
  };
  const inputs = mine.map((o) => ({ ...o, ring: ringFor(o.gidx) }));
  const { tx, size, fee } = buildTx({ inputs, dests: [{ addr: C.decodeAddress(bob.classic), v: 4n * COIN }], change: C.decodeAddress(alice.quantum) });
  assert.ok(size > 1000 && fee > 0n);
  const wire = JSON.parse(JSON.stringify(txToJson(tx)));
  const tx2 = parseTx(wire);
  assert.equal(txId(tx2), txId(tx));
  checkTxShape(tx2);
  const members = tx2.in.map((i) => i.ring.map((g) => ({ P: chain[g].P, C: chain[g].C })));
  const res = verifyTxCrypto(tx2, members);
  assert.ok(res.ok, JSON.stringify(res.checks));
  // receiver finds the payment
  const found = tx2.out.map((o) => C.scanOutput(bob, o)).filter(Boolean);
  assert.equal(found.length, 1);
  assert.equal(found[0].v, 4n * COIN);
  // change back to alice
  const ch = tx2.out.map((o) => C.scanOutput(alice, o)).filter(Boolean);
  assert.equal(ch[0].v, 6n * COIN - 4n * COIN - fee);
  // tamper: raise fee → balance breaks
  const t3 = parseTx({ ...wire, fee: (BigInt(wire.fee) + 1n).toString() });
  assert.ok(!verifyTxCrypto(t3, members).ok);
  // tamper: swap a ring member key → signature breaks
  const m2 = members.map((ms) => ms.map((x) => x));
  m2[0][0] = { P: chain[19].P, C: chain[19].C };
  if (tx2.in[0].ring[0] !== 19) assert.ok(!verifyTxCrypto(tx2, m2).ok);
  // key images are deterministic per output
  assert.equal(C.bytesToHex(C.keyImage(mine[0].x, mine[0].P).toBytes()), C.bytesToHex(tx.in[0].kib));
});
