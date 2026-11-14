// SELEN testnet consensus parameters. Changing any of these forks the chain.
export const COIN = 100_000_000n; // 1 tSELEN = 10^8 atomic units

export const PARAMS = {
  network: "selen-testnet-1",
  ticker: "tSELEN",
  decimals: 8,
  targetBlockTime: 30, // seconds
  ringSize: 16,
  maturity: 10, // confirmations before an output can sit in a ring
  maxInputs: 16,
  maxOutputs: 16,
  feePerKB: 10_000n, // 0.0001 tSELEN per started 1,000 bytes
  baseReward: 32n * COIN,
  halvingInterval: 1_051_200, // about one year of 30 s blocks
  tailReward: COIN / 2n,
  maxBlockTxs: 200,
  maxBlockBytes: 4_000_000,
  maxTxBytes: 250_000,
  lwmaWindow: 45,
  initialDifficulty: 6_000n,
  minDifficulty: 100n,
  medianWindow: 11,
  futureTimeLimit: 120, // seconds a header may run ahead of the node clock
  argon: { memory: 2048, passes: 1, parallelism: 1, salt: "SELEN-POW-v1-tst", tagLength: 32 },
  genesisTime: 1794556800, // 2026-11-13 00:00:00 UTC
  genesisNote: "SELEN testnet genesis / 13 Nov 2026 / receivers and amounts sealed with ML-KEM-768 from block zero",
  multiAsset: false, // v1 transactions only: one asset, the coin itself
  assets: [{ id: 0, ticker: "tSELEN", decimals: 8, feePerKB: 10_000n }],
};

// ---------- networks ----------
// testnet: the running public testnet (single asset, v1 transactions), unchanged.
// beta: SELEN plus bridged assets. Every output carries a visible asset id; amounts stay sealed. Transactions are
// single-asset (rings, outputs and fee all in one asset), the coinbase pays one output per asset it collected fees
// in, and the reserves the bridge releases from are created in the genesis block.
export const NETWORKS = {
  testnet: {},
  beta: {
    network: "selen-beta-1",
    ticker: "SELEN",
    multiAsset: true,
    assets: [
      { id: 0, ticker: "SELEN", decimals: 8, feePerKB: 10_000n },
      { id: 1, ticker: "USDG", decimals: 6, feePerKB: 1_000n },
    ],
    initialDifficulty: 2_000n,
    genesisTime: 1794614400, // 2026-11-14 00:00:00 UTC
    genesisNote: "SELEN beta genesis / 14 Nov 2026 / SELEN and USDG, receivers and amounts sealed with ML-KEM-768",
  },
};
const BASE = { ...PARAMS, assets: PARAMS.assets.map((a) => ({ ...a })) };
/** Switch the process (or the browser bundle) to a network profile, by profile name or by network id. */
export function useNetwork(name) {
  const key = NETWORKS[name] ? name : Object.keys(NETWORKS).find((k) => (NETWORKS[k].network || BASE.network) === name);
  if (!key) throw new Error(`unknown network ${name}`);
  for (const k of Object.keys(PARAMS)) delete PARAMS[k];
  Object.assign(PARAMS, BASE, NETWORKS[key], { profile: key });
  return PARAMS;
}
PARAMS.profile = "testnet";

export function asset(id = 0) {
  const a = PARAMS.assets.find((x) => x.id === Number(id));
  if (!a) throw new Error(`unknown asset ${id}`);
  return a;
}

export function blockReward(height) {
  const halvings = Math.floor(height / PARAMS.halvingInterval);
  const r = halvings > 40 ? 0n : PARAMS.baseReward >> BigInt(halvings);
  return r > PARAMS.tailReward ? r : PARAMS.tailReward;
}

export function minFee(bytes, assetId = 0) {
  return BigInt(Math.ceil(bytes / 1000)) * (PARAMS.multiAsset ? asset(assetId).feePerKB : PARAMS.feePerKB);
}

function fmtUnits(atomic, decimals, digits) {
  const v = BigInt(atomic), one = 10n ** BigInt(decimals);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / one;
  const frac = (a % one).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}
function parseUnits(str, decimals) {
  const s = String(str).trim();
  if (!new RegExp(`^\\d+(\\.\\d{0,${decimals}})?$`).test(s)) throw new Error("bad amount");
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals));
}
export const fmtCoin = (atomic, digits = 8) => fmtUnits(atomic, 8, digits);
export const parseCoin = (str) => parseUnits(str, 8);
/** Amounts of any asset, in that asset's own decimals. */
export const fmtAsset = (atomic, assetId = 0, digits) => { const a = asset(assetId); return fmtUnits(atomic, a.decimals, digits ?? a.decimals); };
export const parseAsset = (str, assetId = 0) => parseUnits(str, asset(assetId).decimals);
