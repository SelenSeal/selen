// SELEN core cryptography — shared by the node (Node.js) and the browser bundle.
// Group: ristretto255 (prime order, no cofactor games). Hashes: SHA-512/256.
// Receivers on quantum addresses are sealed with ML-KEM-768 (FIPS 203).
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { bech32m } from "@scure/base";

export const Point = ristretto255.Point;
export const L = Point.Fn.ORDER;
export const G = Point.BASE;
const te = new TextEncoder();
export const utf8 = (s) => te.encode(s);
export { bytesToHex, hexToBytes, sha256, sha512 };

// ---------- bytes ----------
export function concat(...arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
export function leToNum(b) {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}
export function numToLe(n, len = 32) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
export function beToNum(b) {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

// ---------- scalars & points ----------
export const mod = (n) => ((n % L) + L) % L;
export function randomScalar() {
  for (;;) {
    const s = mod(leToNum(randomBytes(64)));
    if (s !== 0n) return s;
  }
}
/** Hash to scalar with a domain tag. */
export function Hs(domain, ...parts) {
  return mod(leToNum(sha512(concat(utf8(domain), ...parts))));
}
/** Hash to a ristretto255 point (RFC 9380). */
export function Hp(bytes) {
  return ristretto255_hasher.hashToCurve(bytes, { DST: "SELEN-v1-Hp" });
}
/** Second generator for amounts; nobody knows log_G(H). */
export const H = ristretto255_hasher.hashToCurve(utf8("SELEN amount generator"), { DST: "SELEN-v1-H" });

/** Public-value multiply (variable time, accepts 0). */
export function mulP(P, s) {
  s = mod(s);
  return s === 0n ? Point.ZERO : P.multiplyUnsafe(s);
}
/** Secret-value multiply (constant time). */
export function mulS(P, s) {
  s = mod(s);
  return s === 0n ? Point.ZERO : P.multiply(s);
}
export const sc = (s) => numToLe(mod(s), 32);
export function scFrom(bytes) {
  const n = leToNum(bytes);
  if (bytes.length !== 32 || n >= L) throw new Error("non-canonical scalar");
  return n;
}
export const pt = (bytes) => Point.fromBytes(bytes);
export const enc = (P) => P.toBytes();

export function commit(mask, v) {
  return mulS(G, mask).add(mulP(H, BigInt(v)));
}

// ---------- keys & addresses ----------
export const ADDR = { classic: "selen", quantum: "selenq" };

export function keysFromSeed(seed) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error("seed must be 32 bytes");
  const a = Hs("selen/spend", seed);
  const b = Hs("selen/view", seed);
  const kem = ml_kem768.keygen(sha512(concat(utf8("selen/kem"), seed)));
  const A = mulS(G, a), B = mulS(G, b);
  return {
    a, b, A, B, kemPk: kem.publicKey, kemSk: kem.secretKey,
    classic: encodeAddress({ kind: "classic", A, B }),
    quantum: encodeAddress({ kind: "quantum", A, B, kemPk: kem.publicKey }),
  };
}

export function encodeAddress({ kind, A, B, kemPk }) {
  const body = kind === "quantum" ? concat(enc(A), enc(B), kemPk) : concat(enc(A), enc(B));
  return bech32m.encode(ADDR[kind], bech32m.toWords(body), false);
}

export function decodeAddress(str) {
  const s = String(str || "").trim().toLowerCase();
  const { prefix, words } = bech32m.decode(s, false);
  const body = bech32m.fromWords(words);
  if (prefix === ADDR.classic && body.length === 64) {
    return { kind: "classic", A: pt(body.slice(0, 32)), B: pt(body.slice(32, 64)), str: s };
  }
  if (prefix === ADDR.quantum && body.length === 64 + 1184) {
    return { kind: "quantum", A: pt(body.slice(0, 32)), B: pt(body.slice(32, 64)), kemPk: body.slice(64), str: s };
  }
  throw new Error("not a SELEN address");
}
export function isAddress(str) {
  try { decodeAddress(str); return true; } catch { return false; }
}

// ---------- one-time outputs ----------
const amountPad = (shared) => sha256(concat(utf8("selen/amount"), shared)).slice(0, 8);
const viewTag = (shared) => sha256(concat(utf8("selen/tag"), shared))[0];

/**
 * Build an output paying `v` atomic units to `addr` (decoded address).
 * Coinbase outputs use mask 1 and carry their amount in clear (emission is public).
 */
export function makeOutput(addr, v, { coinbase = false } = {}) {
  v = BigInt(v);
  let shared, extra;
  if (addr.kind === "quantum") {
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(addr.kemPk);
    shared = sharedSecret;
    extra = { kem: cipherText };
  } else {
    const r = randomScalar();
    shared = enc(mulS(addr.B, r));
    extra = { R: enc(mulS(G, r)) };
  }
  const s = Hs("selen/key", shared);
  const P = mulS(G, s).add(addr.A);
  const mask = coinbase ? 1n : Hs("selen/mask", shared);
  const C = commit(mask, v);
  const pad = amountPad(shared);
  const vb = numToLe(v, 8);
  const ek = new Uint8Array(8);
  for (let i = 0; i < 8; i++) ek[i] = vb[i] ^ pad[i];
  const out = { P: enc(P), C: enc(C), vt: viewTag(shared), ...extra };
  if (coinbase) out.amount = v;
  else out.ek = ek;
  return { out, mask, v };
}

/**
 * Try to open an output with wallet keys. Returns { v, mask, x } or null.
 * `out` uses raw bytes (P, C, R|kem, ek, vt, amount?).
 */
export function scanOutput(keys, out) {
  let shared;
  try {
    if (out.kem) shared = ml_kem768.decapsulate(out.kem, keys.kemSk);
    else if (out.R) shared = enc(mulP(pt(out.R), keys.b));
    else return null;
  } catch { return null; }
  if (viewTag(shared) !== out.vt) return null;
  const s = Hs("selen/key", shared);
  if (!equalBytes(enc(mulS(G, s).add(keys.A)), out.P)) return null;
  let v, mask;
  if (out.amount !== undefined && out.amount !== null) { v = BigInt(out.amount); mask = 1n; }
  else {
    const pad = amountPad(shared);
    const vb = new Uint8Array(8);
    for (let i = 0; i < 8; i++) vb[i] = out.ek[i] ^ pad[i];
    v = leToNum(vb);
    mask = Hs("selen/mask", shared);
  }
  if (!equalBytes(enc(commit(mask, v)), out.C)) return null;
  return { v, mask, x: mod(s + keys.a) };
}

export const keyImage = (x, Pbytes) => mulS(Hp(Pbytes), x);

// ---------- MLSAG (2 rows: one-time key + commitment difference) ----------
function ringDigest(ring) {
  return sha256(concat(...ring.flatMap((r) => [r.Pb, enc(r.Cd)])));
}
const chal = (m, rd, I, L1, R1, L2) => Hs("selen/mlsag", m, rd, enc(I), enc(L1), enc(R1), enc(L2));

/**
 * ring: [{ Pb: Uint8Array(32), P: Point, Cd: Point }] where Cd = C_j - pseudoC.
 * pi: real index, x: one-time secret, z: commitment-difference secret.
 */
export function mlsagSign(m, ring, pi, x, z) {
  const n = ring.length;
  const hp = ring.map((r) => Hp(r.Pb));
  const I = mulS(hp[pi], x);
  const rd = ringDigest(ring);
  const a1 = randomScalar(), a2 = randomScalar();
  const c = new Array(n), s1 = new Array(n), s2 = new Array(n);
  c[(pi + 1) % n] = chal(m, rd, I, mulS(G, a1), mulS(hp[pi], a1), mulS(G, a2));
  for (let k = 1; k < n; k++) {
    const i = (pi + k) % n;
    s1[i] = randomScalar();
    s2[i] = randomScalar();
    const L1 = mulP(G, s1[i]).add(mulP(ring[i].P, c[i]));
    const R1 = mulP(hp[i], s1[i]).add(mulP(I, c[i]));
    const L2 = mulP(G, s2[i]).add(mulP(ring[i].Cd, c[i]));
    c[(i + 1) % n] = chal(m, rd, I, L1, R1, L2);
  }
  s1[pi] = mod(a1 - c[pi] * x);
  s2[pi] = mod(a2 - c[pi] * z);
  return { I, c0: c[0], s1, s2 };
}

export function mlsagVerify(m, ring, sig) {
  const n = ring.length;
  if (sig.s1.length !== n || sig.s2.length !== n) return false;
  if (sig.I.is0()) return false;
  const rd = ringDigest(ring);
  let c = sig.c0;
  for (let i = 0; i < n; i++) {
    const hp = Hp(ring[i].Pb);
    const L1 = mulP(G, sig.s1[i]).add(mulP(ring[i].P, c));
    const R1 = mulP(hp, sig.s1[i]).add(mulP(sig.I, c));
    const L2 = mulP(G, sig.s2[i]).add(mulP(ring[i].Cd, c));
    c = chal(m, rd, sig.I, L1, R1, L2);
  }
  return c === sig.c0;
}

// ---------- range proofs: 48 bit commitments, each a 1-of-2 ring signature ----------
export const RANGE_BITS = 48;
export const MAX_AMOUNT = (1n << BigInt(RANGE_BITS)) - 1n;
const H2 = Array.from({ length: RANGE_BITS }, (_, i) => mulP(H, 1n << BigInt(i)));
const rpCtx = (Cb, i) => sha256(concat(utf8("selen/range"), Cb, new Uint8Array([i])));
const rpHash = (ctx, P) => Hs("selen/rp", ctx, enc(P));

export function rangeProve(Cb, v, mask) {
  v = BigInt(v);
  if (v < 0n || v > MAX_AMOUNT) throw new Error("amount out of range");
  const r = [];
  let sum = 0n;
  for (let i = 0; i < RANGE_BITS - 1; i++) { r[i] = randomScalar(); sum += r[i]; }
  r[RANGE_BITS - 1] = mod(mask - sum);
  const Ci = [], e0 = [], s0 = [], s1 = [];
  for (let i = 0; i < RANGE_BITS; i++) {
    const bit = Number((v >> BigInt(i)) & 1n);
    const Q0 = mulS(G, r[i]).add(bit ? H2[i] : Point.ZERO);
    const Q1 = Q0.subtract(H2[i]);
    const ctx = rpCtx(Cb, i);
    const k = randomScalar();
    if (bit === 0) {
      const e1 = rpHash(ctx, mulS(G, k));
      s1[i] = randomScalar();
      e0[i] = rpHash(ctx, mulP(G, s1[i]).add(mulP(Q1, e1)));
      s0[i] = mod(k - e0[i] * r[i]);
    } else {
      e0[i] = rpHash(ctx, mulS(G, k));
      s0[i] = randomScalar();
      const e1 = rpHash(ctx, mulP(G, s0[i]).add(mulP(Q0, e0[i])));
      s1[i] = mod(k - e1 * r[i]);
    }
    if (i < RANGE_BITS - 1) Ci.push(Q0);
  }
  return { Ci, e0, s0, s1 };
}

export function rangeVerify(Cb, proof) {
  const { Ci, e0, s0, s1 } = proof;
  if (Ci.length !== RANGE_BITS - 1 || e0.length !== RANGE_BITS || s0.length !== RANGE_BITS || s1.length !== RANGE_BITS) return false;
  const C = pt(Cb);
  let sum = Point.ZERO;
  for (const p of Ci) sum = sum.add(p);
  const all = [...Ci, C.subtract(sum)];
  for (let i = 0; i < RANGE_BITS; i++) {
    const Q0 = all[i], Q1 = Q0.subtract(H2[i]);
    const ctx = rpCtx(Cb, i);
    const e1 = rpHash(ctx, mulP(G, s0[i]).add(mulP(Q0, e0[i])));
    const e0b = rpHash(ctx, mulP(G, s1[i]).add(mulP(Q1, e1)));
    if (e0b !== e0[i]) return false;
  }
  return true;
}

// ---------- seed phrases ----------
export { ml_kem768 };
