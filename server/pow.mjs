// Argon2id proof of work (native in Node >= 24.7; the browser miner uses hash-wasm, same output).
import { argon2Sync } from "node:crypto";
import { PARAMS } from "../lib/params.mjs";

const SALT = Buffer.from(PARAMS.argon.salt);
export function powHash(headerBytes) {
  return new Uint8Array(argon2Sync("argon2id", {
    message: Buffer.from(headerBytes), nonce: SALT, parallelism: PARAMS.argon.parallelism,
    tagLength: PARAMS.argon.tagLength, memory: PARAMS.argon.memory, passes: PARAMS.argon.passes,
  }));
}
