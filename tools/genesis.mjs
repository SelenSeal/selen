// Genesis reserve for a multi-asset network: the outputs the bridge releases from, written into the genesis block.
//   node tools/genesis.mjs beta --to faucet --selen 1000000 --usdg 1000000 --split 64
//   node tools/genesis.mjs beta --to selenq1… --usdg 250000 --split 128
// --to faucet uses the node's faucet seed (~/.config/selen/faucet.seed). Amounts are public (mask 1), like any
// coinbase: anyone can check the reserve. Splitting gives rings enough same-asset decoys from the first blocks.
// Writes config/genesis-<network>.json. Changing it after the network starts forks the chain.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { useNetwork, PARAMS, parseAsset, fmtAsset } from "../lib/params.mjs";
import { makeOutput, decodeAddress, keysFromSeed, hexToBytes, MAX_AMOUNT } from "../lib/crypto.mjs";
import { txToJson, txId, parseTx } from "../lib/tx.mjs";

const [profile = "beta", ...rest] = process.argv.slice(2);
const arg = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
useNetwork(profile);
if (!PARAMS.multiAsset) throw new Error(`${profile} is not a multi-asset network`);

let to = arg("to", "faucet");
if (to === "faucet") {
  const f = join(homedir(), ".config", "selen", "faucet.seed");
  if (!existsSync(f)) throw new Error("no faucet seed yet: start the node once, or pass --to <address>");
  to = keysFromSeed(hexToBytes(readFileSync(f, "utf8").trim())).quantum;
}
const addr = decodeAddress(to);
const split = Number(arg("split", 64));
if (!Number.isInteger(split) || split < 16 || split > 2048) throw new Error("--split between 16 and 2048 (rings need 16 same-asset decoys)");

const out = [], reserves = [];
for (const a of PARAMS.assets) {
  const raw = arg(a.ticker.toLowerCase());
  if (!raw || raw === "0") continue;
  const total = parseAsset(raw, a.id);
  const each = total / BigInt(split);
  if (each < 1n) throw new Error(`${a.ticker}: amount too small to split ${split} ways`);
  if (each + (total % BigInt(split)) > MAX_AMOUNT) throw new Error(`${a.ticker}: raise --split, one output can hold at most ${fmtAsset(MAX_AMOUNT, a.id)}`);
  for (let k = 0; k < split; k++) {
    const v = k === split - 1 ? each + (total % BigInt(split)) : each;
    out.push({ a: a.id, ...makeOutput(addr, v, { coinbase: true }).out });
  }
  reserves.push({ asset: a.id, ticker: a.ticker, amount: total.toString(), display: fmtAsset(total, a.id), outputs: split });
}
if (!out.length) throw new Error("give at least one amount, e.g. --usdg 1000000");
const tx = { v: 2, asset: 0, cb: 0, in: [], out, fee: 0n, rp: [], sig: [] };
const json = txToJson(tx);
parseTx(json); // round-trip check
const file = new URL(`../config/genesis-${profile}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({ network: PARAMS.network, to, reserves, txs: [json] }, null, 1) + "\n");
console.log(`✓ ${file.pathname}\n  reserve tx ${txId(parseTx(json)).slice(0, 16)}…  →  ${to.slice(0, 22)}…`);
for (const r of reserves) console.log(`  ${r.display} ${r.ticker} in ${r.outputs} outputs`);
