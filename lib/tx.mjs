// SELEN transactions and blocks: wire format (JSON with hex), canonical binary
// encoding for hashing, building (wallet side) and verification (node + browser).
import {
  G, H, Point, mod, randomScalar, commit, mulP, mulS, pt, enc, sc, scFrom, concat, utf8,
  sha256, bytesToHex, hexToBytes, leToNum, numToLe, beToNum, makeOutput, keyImage,
  mlsagSign, mlsagVerify, rangeProve, rangeVerify, RANGE_BITS, MAX_AMOUNT,
} from "./crypto.mjs";
import { PARAMS, minFee, asset as assetInfo } from "./params.mjs";

// ---------- binary writer ----------
class W {
  constructor() { this.parts = []; this.n = 0; }
  bytes(b) { this.parts.push(b); this.n += b.length; return this; }
  u8(x) { return this.bytes(new Uint8Array([x])); }
  varint(x) {
    let v = BigInt(x);
    if (v < 0n) throw new Error("varint < 0");
    const out = [];
    do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
    return this.bytes(new Uint8Array(out));
  }
  done() { return concat(...this.parts); }
}

const hx = (b) => bytesToHex(b);
const hb = (h, len) => {
  if (typeof h !== "string" || !/^[0-9a-f]*$/.test(h)) throw new Error("bad hex");
  const b = hexToBytes(h);
  if (len !== undefined && b.length !== len) throw new Error(`expected ${len} bytes`);
  return b;
};

// ---------- wire <-> internal ----------
// Internal tx: { v, asset, cb?, in: [{ ring:number[], ki:Point, kib:Uint8Array, pc:Point, pcb }],
//   out: [{ a, P, C, vt, R?, kem?, ek?, amount? }] (bytes), fee: bigint, rp: [...], sig: [...] }
// v1: single-asset networks (asset 0 implied). v2: multi-asset networks; every output names its asset, a transfer
// moves exactly one asset (rings, outputs and fee), the coinbase pays at most one output per asset, and the
// genesis reserve (cb 0) may hold many outputs per asset.

export function parseTx(j) {
  if (!j || typeof j !== "object") throw new Error("tx must be an object");
  if (j.v !== 1 && j.v !== 2) throw new Error("unsupported tx version");
  if ((j.v === 2) !== !!PARAMS.multiAsset) throw new Error(PARAMS.multiAsset ? "this network takes v2 transactions" : "unsupported tx version");
  const v2 = j.v === 2;
  const isCb = j.cb !== undefined;
  const tx = { v: j.v, asset: 0, in: [], out: [], fee: 0n, rp: [], sig: [] };
  if (isCb) {
    if (!Number.isInteger(j.cb) || j.cb < 0) throw new Error("bad coinbase height");
    tx.cb = j.cb;
  }
  if (!Array.isArray(j.in) || !Array.isArray(j.out)) throw new Error("in/out must be arrays");
  for (const i of j.in) {
    if (!Array.isArray(i.ring)) throw new Error("ring must be an array");
    const ring = i.ring.map((g) => { if (!Number.isSafeInteger(g) || g < 0) throw new Error("bad ring index"); return g; });
    const kib = hb(i.ki, 32), pcb = hb(i.pc, 32);
    tx.in.push({ ring, kib, ki: pt(kib), pcb, pc: pt(pcb) });
  }
  for (const o of j.out) {
    const out = { a: 0, P: hb(o.P, 32), C: hb(o.C, 32), vt: o.vt };
    if (v2) {
      if (!Number.isInteger(o.a)) throw new Error("output needs an asset id");
      assetInfo(o.a);
      out.a = o.a;
    } else if (o.a !== undefined) throw new Error("v1 outputs carry no asset id");
    if (!Number.isInteger(o.vt) || o.vt < 0 || o.vt > 255) throw new Error("bad view tag");
    pt(out.P); pt(out.C);
    if (o.R !== undefined) { out.R = hb(o.R, 32); pt(out.R); }
    else if (o.kem !== undefined) out.kem = hb(o.kem, 1088);
    else throw new Error("output needs R or kem");
    if (isCb) {
      if (typeof o.amount !== "string" || !/^\d+$/.test(o.amount)) throw new Error("coinbase amount");
      out.amount = BigInt(o.amount);
    } else out.ek = hb(o.ek, 8);
    tx.out.push(out);
  }
  if (typeof j.fee !== "string" || !/^\d+$/.test(j.fee)) throw new Error("bad fee");
  tx.fee = BigInt(j.fee);
  if (v2 && tx.out.length) {
    if (!isCb) {
      if (tx.out.some((o) => o.a !== tx.out[0].a)) throw new Error("a transfer moves one asset: every output must name the same asset");
      tx.asset = tx.out[0].a;
    } else if (tx.cb !== 0 && new Set(tx.out.map((o) => o.a)).size !== tx.out.length) throw new Error("coinbase pays one output per asset");
  }
  if (!isCb) {
    if (!Array.isArray(j.rp) || j.rp.length !== tx.out.length) throw new Error("one range proof per output");
    tx.rp = j.rp.map((p) => ({
      Ci: p.Ci.map((h) => pt(hb(h, 32))),
      e0: p.e0.map((h) => scFrom(hb(h, 32))),
      s0: p.s0.map((h) => scFrom(hb(h, 32))),
      s1: p.s1.map((h) => scFrom(hb(h, 32))),
    }));
    if (!Array.isArray(j.sig) || j.sig.length !== tx.in.length) throw new Error("one signature per input");
    tx.sig = j.sig.map((s, k) => ({
      c0: scFrom(hb(s.c0, 32)),
      s1: s.s1.map((h) => scFrom(hb(h, 32))),
      s2: s.s2.map((h) => scFrom(hb(h, 32))),
      I: tx.in[k].ki,
    }));
  }
  return tx;
}

export function txToJson(tx) {
  const j = { v: tx.v };
  if (tx.cb !== undefined) j.cb = tx.cb;
  j.in = tx.in.map((i) => ({ ring: i.ring, ki: hx(i.kib), pc: hx(i.pcb) }));
  j.out = tx.out.map((o) => {
    const r = tx.v === 2 ? { a: o.a, P: hx(o.P), C: hx(o.C), vt: o.vt } : { P: hx(o.P), C: hx(o.C), vt: o.vt };
    if (o.R) r.R = hx(o.R); else r.kem = hx(o.kem);
    if (tx.cb !== undefined) r.amount = o.amount.toString(); else r.ek = hx(o.ek);
    return r;
  });
  j.fee = tx.fee.toString();
  if (tx.cb === undefined) {
    j.rp = tx.rp.map((p) => ({
      Ci: p.Ci.map((P) => hx(enc(P))), e0: p.e0.map((s) => hx(sc(s))),
      s0: p.s0.map((s) => hx(sc(s))), s1: p.s1.map((s) => hx(sc(s))),
    }));
    j.sig = tx.sig.map((s) => ({ c0: hx(sc(s.c0)), s1: s.s1.map((x) => hx(sc(x))), s2: s.s2.map((x) => hx(sc(x))) }));
  }
  return j;
}

// ---------- canonical encoding ----------
function prefixBytes(tx) {
  const w = new W();
  w.u8(tx.v);
  if (tx.cb !== undefined) w.u8(1).varint(tx.cb); else w.u8(0);
  w.varint(tx.in.length);
  for (const i of tx.in) {
    w.varint(i.ring.length);
    for (const g of i.ring) w.varint(g);
    w.bytes(i.kib).bytes(i.pcb);
  }
  w.varint(tx.out.length);
  for (const o of tx.out) {
    w.u8(o.kem ? 1 : 0);
    if (tx.v === 2) w.varint(o.a);
    w.bytes(o.P).bytes(o.C).u8(o.vt).bytes(o.kem || o.R);
    if (tx.cb !== undefined) w.varint(o.amount); else w.bytes(o.ek);
  }
  w.varint(tx.fee);
  for (const p of tx.rp) {
    for (const P of p.Ci) w.bytes(enc(P));
    for (let k = 0; k < RANGE_BITS; k++) w.bytes(sc(p.e0[k])).bytes(sc(p.s0[k])).bytes(sc(p.s1[k]));
  }
  return w.done();
}

export function txMessage(tx) {
  return sha256(concat(utf8("selen/tx-prefix"), prefixBytes(tx)));
}

export function txBytes(tx) {
  const w = new W().bytes(prefixBytes(tx));
  for (const s of tx.sig) {
    w.bytes(sc(s.c0));
    for (let k = 0; k < s.s1.length; k++) w.bytes(sc(s.s1[k])).bytes(sc(s.s2[k]));
  }
  return w.done();
}

export function txId(tx) {
  return hx(sha256(txBytes(tx)));
}

// ---------- verification ----------
/**
 * Pure cryptographic verification. `members[k]` = array of { P: bytes, C: bytes } for input k's ring.
 * Returns { ok, checks:[{ name, ok, detail? }] } — used by nodes and the in-browser verifier.
 */
export function verifyTxCrypto(tx, members, { onProgress } = {}) {
  const checks = [];
  const push = (name, ok, detail) => { checks.push({ name, ok, detail }); onProgress?.(checks.at(-1)); return ok; };
  if (tx.cb !== undefined) {
    const opens = (o) => !!o && o.amount <= MAX_AMOUNT && enc(commit(1n, o.amount)).every((b, i) => b === o.C[i]);
    if (tx.v === 1) {
      push("coinbase has one output", tx.out.length === 1);
      push("coinbase commitment opens to its public amount", opens(tx.out[0]));
    } else {
      push(tx.cb === 0 ? "genesis reserve has outputs" : "coinbase pays one output per asset", tx.out.length >= 1);
      tx.out.forEach((o, k) => push(`${tx.cb === 0 ? "reserve" : "coinbase"} output ${k} (${assetInfo(o.a).ticker}) opens to its public amount`, opens(o)));
    }
    return { ok: checks.every((c) => c.ok), checks };
  }
  const m = txMessage(tx);
  // range proofs
  tx.out.forEach((o, k) => push(`output ${k}: 48-bit range proof`, rangeVerify(o.C, tx.rp[k])));
  // balance: sum(pseudo) == sum(out) + fee*H
  let lhs = Point.ZERO, rhs = mulP(H, tx.fee);
  for (const i of tx.in) lhs = lhs.add(i.pc);
  for (const o of tx.out) rhs = rhs.add(pt(o.C));
  push("inputs balance outputs plus fee", lhs.equals(rhs));
  // ring signatures
  tx.in.forEach((inp, k) => {
    const ms = members[k];
    if (!ms || ms.length !== inp.ring.length) { push(`input ${k}: ring of ${inp.ring.length}`, false, "ring members missing"); return; }
    const ring = ms.map((mm) => ({ Pb: mm.P, P: pt(mm.P), Cd: pt(mm.C).subtract(inp.pc) }));
    push(`input ${k}: MLSAG over a ring of ${ring.length}`, mlsagVerify(m, ring, tx.sig[k]));
  });
  return { ok: checks.every((c) => c.ok), checks };
}

/** Structural rules that do not need chain state. Throws on failure. */
export function checkTxShape(tx) {
  if (tx.cb !== undefined) throw new Error("coinbase outside a block");
  if (tx.in.length < 1 || tx.in.length > PARAMS.maxInputs) throw new Error("input count");
  if (tx.out.length < 1 || tx.out.length > PARAMS.maxOutputs) throw new Error("output count");
  const kis = new Set();
  for (const i of tx.in) {
    if (i.ring.length !== PARAMS.ringSize) throw new Error(`ring must have ${PARAMS.ringSize} members`);
    for (let k = 1; k < i.ring.length; k++) if (i.ring[k] <= i.ring[k - 1]) throw new Error("ring indices must be strictly ascending");
    if (i.ki.is0()) throw new Error("identity key image");
    const h = hx(i.kib);
    if (kis.has(h)) throw new Error("duplicate key image in tx");
    kis.add(h);
  }
  for (const s of tx.sig) if (s.s1.length !== PARAMS.ringSize || s.s2.length !== PARAMS.ringSize) throw new Error("signature size");
  const size = txBytes(tx).length;
  if (size > PARAMS.maxTxBytes) throw new Error("tx too large");
  if (tx.fee < minFee(size, tx.asset)) throw new Error(`fee too low: need ${minFee(size, tx.asset)} for ${size} bytes`);
  return size;
}

// ---------- building (wallet) ----------
/**
 * inputs: [{ v, mask, x, gidx, P:bytes, C:bytes, ring:[{ gidx, P:bytes, C:bytes }] (sorted, contains own gidx) }]
 * dests: [{ addr (decoded), v }], change: decoded address. Fee is found iteratively.
 */
export function buildTx({ inputs, dests, change, feeHint, asset = 0 }) {
  const v = PARAMS.multiAsset ? 2 : 1;
  if (v === 1 && asset !== 0) throw new Error("this network has one asset");
  assetInfo(asset);
  const totalIn = inputs.reduce((s, i) => s + BigInt(i.v), 0n);
  const pay = dests.reduce((s, d) => s + BigInt(d.v), 0n);
  let fee = feeHint ?? 0n;
  for (let round = 0; round < 6; round++) {
    const left = totalIn - pay - fee;
    if (left < 0n) throw new Error("insufficient funds for amount + fee");
    const made = [...dests.map((d) => makeOutput(d.addr, d.v)), makeOutput(change, left)];
    if (v === 2) for (const o of made) o.out = { a: asset, ...o.out };
    // shuffle so the change position leaks nothing
    for (let k = made.length - 1; k > 0; k--) {
      const r = Number(leToNum(crypto.getRandomValues(new Uint8Array(4))) % BigInt(k + 1));
      [made[k], made[r]] = [made[r], made[k]];
    }
    const outMaskSum = made.reduce((s, o) => mod(s + o.mask), 0n);
    const pm = inputs.map(() => randomScalar());
    pm[pm.length - 1] = mod(outMaskSum - pm.slice(0, -1).reduce((s, x) => s + x, 0n));
    const tx = { v, asset, in: [], out: made.map((o) => o.out), fee, rp: [], sig: [] };
    inputs.forEach((inp, k) => {
      const pc = commit(pm[k], inp.v);
      const ki = keyImage(inp.x, inp.P);
      tx.in.push({ ring: inp.ring.map((r) => r.gidx), ki, kib: enc(ki), pc, pcb: enc(pc) });
    });
    tx.rp = made.map((o) => rangeProve(o.out.C, o.v, o.mask));
    const m = txMessage(tx);
    tx.sig = inputs.map((inp, k) => {
      const pi = inp.ring.findIndex((r) => r.gidx === inp.gidx);
      if (pi < 0) throw new Error("own output missing from ring");
      const ring = inp.ring.map((r) => ({ Pb: r.P, P: pt(r.P), Cd: pt(r.C).subtract(tx.in[k].pc) }));
      const sig = mlsagSign(m, ring, pi, inp.x, mod(inp.mask - pm[k]));
      return sig;
    });
    const size = txBytes(tx).length;
    const need = minFee(size, asset);
    if (fee >= need) return { tx, size, fee };
    fee = need;
  }
  throw new Error("fee did not converge");
}

// ---------- blocks ----------
export function headerBytes(h) {
  const w = new W();
  w.u8(h.v).varint(h.height).bytes(hb(h.prev, 32)).bytes(numToLe(BigInt(h.time), 8))
    .bytes(hb(h.root, 32)).bytes(numToLe(BigInt(h.diff), 16)).bytes(numToLe(BigInt(h.nonce), 8));
  return w.done();
}
export const blockId = (h) => hx(sha256(headerBytes(h)));

export function merkleRoot(ids) {
  if (!ids.length) return hx(sha256(utf8("selen/empty")));
  let level = ids.map((h) => hexToBytes(h));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i], b = level[i + 1] || level[i];
      next.push(sha256(concat(utf8("selen/node"), a, b)));
    }
    level = next;
  }
  return hx(level[0]);
}

const TWO256 = 1n << 256n;
export const powTarget = (diff) => (TWO256 - 1n) / BigInt(diff);
export const powOk = (powBytes, diff) => beToNum(powBytes) <= powTarget(diff);

export { hx, hb };
