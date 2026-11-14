// SELEN command-line miner.
//   node tools/miner.mjs --node https://selen.network --address selenq1… --threads 4
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const NODE = (arg("node", "http://127.0.0.1:9310")).replace(/\/$/, "");
const ADDRESS = arg("address", "");
const THREADS = +arg("threads", Math.max(1, Math.floor(availableParallelism() / 2)));
if (!ADDRESS) { console.error("usage: node tools/miner.mjs --node <url> --address <selen address> [--threads N]"); process.exit(1); }

const get = async (p) => { const r = await fetch(NODE + p); const b = await r.json(); if (!r.ok) throw new Error(b.error || r.status); return b; };
const post = async (p, body) => { const r = await fetch(NODE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const b = await r.json(); if (!r.ok) throw new Error(b.error || r.status); return b; };

let job = null, tip = null;
const rates = new Array(THREADS).fill(0);
const workers = Array.from({ length: THREADS }, (_, i) => {
  const w = new Worker(new URL("../server/miner-worker.mjs", import.meta.url));
  w.on("message", async (m) => {
    if (m.type === "rate") rates[i] = m.hashes / 5;
    if (m.type === "found" && job && m.job === job.job) {
      const j = job;
      job = null;
      try { const r = await post("/api/mining/submit", { job: j.job, nonce: m.nonce }); console.log(`✓ sealed block ${r.height} ${r.id.slice(0, 16)}…`); }
      catch (e) { console.log("✗ rejected:", e.message); }
      refresh();
    }
  });
  return w;
});

async function refresh() {
  try {
    job = await get(`/api/mining/job?address=${encodeURIComponent(ADDRESS)}`);
    tip = job.prev;
    workers.forEach((w, i) => w.postMessage({ type: "job", job: job.job, blob: job.blob, target: job.target, start: Math.floor(Math.random() * 2 ** 40) + i * 2 ** 44 }));
  } catch (e) { console.log("job:", e.message); setTimeout(refresh, 5000); }
}
setInterval(async () => {
  try { const st = await get("/api/status"); if (st.tip !== tip) refresh(); } catch {}
}, 4000);
setInterval(() => console.log(`· ${rates.reduce((a, b) => a + b, 0).toFixed(0)} H/s · ${THREADS} threads · job height ${job?.height ?? "—"}`), 15000);
setInterval(refresh, 20000);
console.log(`SELEN miner → ${NODE} · ${THREADS} threads`);
refresh();
