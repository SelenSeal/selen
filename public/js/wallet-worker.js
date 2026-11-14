// Wallet worker: holds keys, scans outputs, builds and signs transactions off the main thread.
import * as L from "/vendor/selen.js";
let keys = null;
const j = async (p) => { const r = await fetch(p); const b = await r.json(); if (!r.ok) throw new Error(b.error || r.status); return b; };

onmessage = async (e) => {
  const m = e.data;
  const reply = (o) => postMessage({ ...o, id: m.id });
  try {
    if (m.type === "init") {
      if (m.network) L.useNetwork(m.network);
      keys = L.keysFromSeed(L.hexToBytes(m.seed));
      return reply({ ok: true, classic: keys.classic, quantum: keys.quantum, tag: L.bytesToHex(L.sha256(keys.A.toBytes())).slice(0, 16) });
    }
    if (!keys) throw new Error("wallet locked");
    if (m.type === "scan") return reply({ ok: true, found: L.scanBatch(keys, m.rows) });
    if (m.type === "build") {
      const dest = L.decodeAddress(m.to);
      const asset = Number(m.asset || 0);
      const st = await j("/api/status");
      const eligible = st.assets?.find((a) => a.id === asset)?.eligible ?? st.eligibleOutputs;
      const inputs = [];
      for (const o of m.inputs) {
        // Ask only for the 16 ring members together: the same set the transfer will publish. On a multi-asset
        // network the decoys are positions inside the same asset.
        const ids = L.pickRing(o.ai ?? o.g, eligible);
        const q = L.PARAMS.multiAsset ? `asset=${asset}&ai=${ids.join(",")}` : `ids=${ids.join(",")}`;
        const { members } = await j(`/api/ring?full=1&${q}`);
        const row = members.find((r) => r && r.g === o.g);
        if (!row) throw new Error(`output ${o.g} missing`);
        const got = L.scanOutput(keys, L.outFromApi(row));
        if (!got) throw new Error(`output ${o.g} is not ours`);
        inputs.push({ gidx: o.g, v: got.v, mask: got.mask, x: got.x, P: L.hexToBytes(row.P), C: L.hexToBytes(row.C),
          ring: members.map((r) => ({ gidx: r.g, P: L.hexToBytes(r.P), C: L.hexToBytes(r.C) })) });
      }
      const change = L.decodeAddress(keys.quantum);
      // optional sealed memo for the receiver (the bridge reads the Robinhood address from it)
      const memo = m.memo ? L.hexToBytes(m.memo) : undefined;
      const { tx, fee, size } = L.buildTx({ inputs, dests: [{ addr: dest, v: BigInt(m.amount), ...(memo ? { memo } : {}) }], change, asset });
      // (no `id` key here: reply() puts the request id back, and overwriting it left every send hanging)
      return reply({ ok: true, tx: L.txToJson(tx), fee: fee.toString(), size, txid: L.txId(tx) });
    }
  } catch (err) { reply({ ok: false, error: err.message || String(err) }); }
};
