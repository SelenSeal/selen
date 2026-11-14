// Browser entry: everything the wallet, explorer verifier and miner need, bundled into /vendor/selen.js.
export * from "./crypto.mjs";
export * from "./tx.mjs";
export * from "./params.mjs";
export { pickRing } from "./ring.mjs";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hexToBytes, bytesToHex, randomBytes, scanOutput, keyImage } from "./crypto.mjs";

export const seedToWords = (seed) => entropyToMnemonic(seed, wordlist);
export function wordsToSeed(words) {
  const w = String(words).trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(w, wordlist)) throw new Error("those 24 words do not form a valid seed");
  return mnemonicToEntropy(w, wordlist);
}
export const newSeed = () => randomBytes(32);

/** API output row → bytes form understood by scanOutput */
export function outFromApi(o) {
  return {
    P: hexToBytes(o.P), C: hexToBytes(o.C), vt: o.vt,
    R: o.R ? hexToBytes(o.R) : undefined, kem: o.kem ? hexToBytes(o.kem) : undefined,
    ek: o.ek ? hexToBytes(o.ek) : undefined, amount: o.amount ?? undefined, a: o.a ?? 0,
  };
}

export function scanBatch(keys, rows) {
  const found = [];
  for (const o of rows) {
    const got = scanOutput(keys, outFromApi(o));
    if (got) found.push({ g: o.g, h: o.h, a: o.a ?? 0, ai: o.ai ?? o.g, v: got.v.toString(), ki: bytesToHex(keyImage(got.x, hexToBytes(o.P)).toBytes()), q: !!o.kem, cb: o.amount !== undefined });
  }
  return found;
}
