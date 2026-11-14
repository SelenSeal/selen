// Optional peer sync: `PEER=https://selen.network npm start` keeps a full local copy,
// re-verifying every block (proof of work, rings, range proofs, balances) before storing it.
export function startSync(chain, url, { log = console.log } = {}) {
  const base = url.replace(/\/$/, "");
  const get = async (p) => { const r = await fetch(base + p); if (!r.ok) throw new Error(`${p} → ${r.status}`); return r.json(); };
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  let busy = false;

  async function findFork() {
    // walk back until our block id matches the peer's at that height
    let h = chain.tip().height;
    while (h > 0) {
      const from = Math.max(0, h - 199);
      const { ids } = await get(`/api/sync/ids?from=${from}`);
      for (let k = ids.length - 1; k >= 0; k--) {
        const [hh, id] = ids[k];
        if (hh > h) continue;
        if (chain.blockAt(hh)?.id === id) return hh;
      }
      h = from - 1;
    }
    return 0;
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const st = await get("/api/status");
      if (BigInt(st.cumulativeWork) <= BigInt(chain.tip().work)) return;
      let from = chain.tip().height + 1;
      for (;;) {
        const { blocks } = await get(`/api/sync/blocks?from=${from}&limit=20`);
        if (!blocks.length) break;
        for (const b of blocks) {
          try { chain.addBlock(b, { source: "peer" }); }
          catch (e) {
            if (/extend the tip|stale/.test(e.message)) {
              const fork = await findFork();
              log(`[sync] peer has a heavier branch, rolling back to ${fork}`);
              chain.rollbackTo(fork);
              from = fork + 1;
              throw Object.assign(new Error("reorg"), { reorg: true });
            }
            throw e;
          }
        }
        from += blocks.length;
        if (blocks.length < 20) break;
      }
    } catch (e) { if (!e.reorg) log("[sync]", e.message); }
    finally { busy = false; }
  }
  const timer = setInterval(tick, 8000);
  tick();
  log(`[sync] following ${base}`);
  return {
    url: base,
    forwardTx: (tx) => post("/api/tx", { tx }),
    forwardBlock: (height) => { const b = chain.blockAt(height); if (b) post("/api/block", { block: b.block }); },
    stop: () => clearInterval(timer),
  };
}
