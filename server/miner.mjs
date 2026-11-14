// Built-in miner: keeps the testnet producing blocks and pays rewards to the node's own private address.
import { Worker } from "node:worker_threads";
import { headerBytes } from "../lib/tx.mjs";
import { powTarget } from "../lib/tx.mjs";

export function startMiner(chain, { address, threads = 1, duty = 1, log = console.log }) {
  const workers = [];
  let current = null, seq = 0, rate = new Map();
  const fresh = () => {
    const tpl = chain.buildTemplate(address);
    const job = `m${++seq}`;
    current = { job, tpl };
    const blob = Buffer.from(headerBytes(tpl.header)).toString("hex");
    const target = powTarget(tpl.header.diff).toString(16).padStart(64, "0");
    workers.forEach((w, i) => w.postMessage({ type: "job", job, blob, target, duty, start: Math.floor(Math.random() * 2 ** 40) + i * 2 ** 44 }));
  };
  for (let i = 0; i < threads; i++) {
    const w = new Worker(new URL("./miner-worker.mjs", import.meta.url));
    w.on("message", (m) => {
      if (m.type === "rate") rate.set(i, m.hashes / 5);
      if (m.type === "found" && current && m.job === current.job) {
        const { tpl } = current;
        current = null;
        try {
          const r = chain.addBlock({ header: { ...tpl.header, nonce: m.nonce }, txs: tpl.txs }, { source: "node-miner" });
          log(`[miner] sealed block ${r.height} ${r.id.slice(0, 12)}…`);
        } catch (e) { log("[miner] block rejected:", e.message); }
        fresh();
      }
    });
    w.on("error", (e) => log("[miner] worker error", e.message));
    workers.push(w);
  }
  const off = chain.on((ev) => { if (ev.type === "block" && ev.source !== "node-miner") fresh(); if (ev.type === "rollback") fresh(); });
  const refresh = setInterval(fresh, 20_000);
  refresh.unref();
  fresh();
  log(`[miner] ${threads} thread(s), duty ${duty}, paying ${address.slice(0, 16)}…`);
  return {
    hashrate: () => [...rate.values()].reduce((s, x) => s + x, 0),
    stop() { off(); clearInterval(refresh); workers.forEach((w) => w.terminate()); },
  };
}
