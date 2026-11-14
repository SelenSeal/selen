// SELEN node HTTP API. Everything here is read from the running chain; nothing is invented.
import { randomBytes as nodeRandom } from "node:crypto";
import { headerBytes, powTarget, parseTx, txId } from "../lib/tx.mjs";
import { isAddress, decodeAddress } from "../lib/crypto.mjs";
import { PARAMS, COIN, asset as assetInfo, fmtAsset } from "../lib/params.mjs";

const MAX_BODY = 600_000;

function send(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", ...extra });
  res.end(body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { code: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("invalid JSON"), { code: 400 }); }
}

function limiter(perMinute) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (key) => {
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    return n <= perMinute;
  };
}

// faucet drip per asset: 5 of the coin, 100 of a dollar asset
const dripOf = (a) => (assetInfo(a).decimals === 6 ? 100n * 10n ** 6n : 5n * COIN);

export function createApi({ chain, miner, faucet, peer, trustProxy = false, isPublic = false, log = console.log }) {
  const faucetAmount = dripOf(0);
  const ipOf = (req) => (trustProxy && req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress || "?";
  const lim = { tx: limiter(30), job: limiter(120), submit: limiter(240), faucet: limiter(6), block: limiter(120) };
  const jobs = new Map(); // id -> { tpl, at }
  const faucetLog = new Map(); // address|ip -> unix time
  const FAUCET_COOLDOWN = 12 * 3600;
  const sse = new Set();

  setInterval(() => {
    const now = Date.now();
    for (const [k, j] of jobs) if (now - j.at > 180_000) jobs.delete(k);
  }, 30_000).unref();

  chain.on((ev) => {
    if (ev.type === "block" || ev.type === "rollback" || ev.type === "mempool") {
      const data = `event: ${ev.type}\ndata: ${JSON.stringify({ ...ev, ...(ev.type !== "mempool" ? { stats: chain.stats() } : {}) })}\n\n`;
      for (const r of sse) r.write(data);
      if (ev.type === "block" && peer && ev.source !== "peer") peer.forwardBlock(ev.height);
    }
  });
  setInterval(() => { for (const r of sse) r.write(": ping\n\n"); }, 25_000).unref();

  function blockSummary(r) {
    return { height: r.height, id: r.id, time: r.time, diff: r.diff, ntx: r.ntx, size: r.size, reward: r.reward, fees: r.fees };
  }

  function resolveBlock(key) {
    if (/^\d+$/.test(key)) return chain.blockAt(Number(key));
    if (/^[0-9a-f]{64}$/.test(key)) return chain.blockById(key);
    return null;
  }

  function txDetail(id) {
    let row = chain.txRow(id), json, block = null, confirmations = 0, inMempool = false;
    if (row) {
      const b = chain.blockAt(row.height);
      json = b.block.txs[row.pos];
      block = { height: b.height, id: b.id, time: b.time };
      confirmations = chain.tip().height - row.height + 1;
    } else if (chain.mempool.has(id)) {
      const m = chain.mempool.get(id);
      json = m.json; inMempool = true;
      row = { size: m.size, fee: m.fee.toString(), cb: 0, nin: m.tx.in.length, nout: m.tx.out.length };
    } else return null;
    const ring = json.in.map((i) => i.ring.map((g) => {
      const o = chain.getOutput(g);
      return { gidx: g, P: o.P, C: o.C, height: o.height, txid: o.txid };
    }));
    const outs = row && !inMempool ? chain.outputsOfTx(id).map((o) => o.gidx) : [];
    const asset = json.cb === undefined ? (json.out[0]?.a ?? 0) : null;
    return { id, tx: json, block, confirmations, inMempool, size: row.size, fee: json.fee, coinbase: json.cb !== undefined, ring, outputGidx: outs,
      asset, ticker: asset === null ? null : assetInfo(asset).ticker, network: PARAMS.profile,
      assets: PARAMS.assets.map((a) => ({ id: a.id, ticker: a.ticker, decimals: a.decimals })) };
  }

  function makeJob(address) {
    const tpl = chain.buildTemplate(address);
    const id = nodeRandom(9).toString("base64url");
    jobs.set(id, { tpl, at: Date.now() });
    if (jobs.size > 2000) jobs.delete(jobs.keys().next().value);
    const blob = Buffer.from(headerBytes(tpl.header)).toString("hex");
    return {
      job: id, height: tpl.header.height, prev: tpl.header.prev, diff: tpl.header.diff,
      target: powTarget(tpl.header.diff).toString(16).padStart(64, "0"), blob, nonceBytes: 8,
      argon: PARAMS.argon, reward: tpl.txs[0].out[0].amount,
    };
  }

  return async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith("/api/")) return false;
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" }).end();
      return true;
    }
    try {
      // ---------- reads ----------
      if (p === "/api/status" && req.method === "GET") {
        const st = chain.stats();
        const fb = faucet ? faucet.balances() : null;
        return send(res, 200, {
          network: PARAMS.network, profile: PARAMS.profile, ticker: PARAMS.ticker, multiAsset: !!PARAMS.multiAsset, ...st,
          nodeHashrate: miner ? miner.hashrate() : 0,
          params: { ringSize: PARAMS.ringSize, maturity: PARAMS.maturity, targetBlockTime: PARAMS.targetBlockTime, rangeBits: 48, kem: "ML-KEM-768", pow: "Argon2id", argonMemoryKiB: PARAMS.argon.memory, trustedSetup: "none" },
          faucet: fb ? { unlocked: fb.unlocked, locked: fb.locked, amount: faucetAmount,
            assets: PARAMS.assets.map((a) => { const b = faucet.balances(a.id); return { id: a.id, ticker: a.ticker, unlocked: b.unlocked, amount: dripOf(a.id) }; }) } : null,
          peer: peer ? peer.url : null, serverTime: Math.floor(Date.now() / 1000),
        }), true;
      }
      if (p === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write(`event: hello\ndata: ${JSON.stringify(chain.stats())}\n\n`);
        sse.add(res);
        req.on("close", () => sse.delete(res));
        return true;
      }
      if (p === "/api/blocks") {
        const tipH = chain.tip().height;
        const before = Math.min(Number(url.searchParams.get("before") ?? tipH), tipH);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
        return send(res, 200, { tip: tipH, blocks: chain.blocksDesc(before, limit).map(blockSummary) }), true;
      }
      if (p === "/api/chart") {
        const tipH = chain.tip().height;
        const rows = chain.blocksDesc(tipH, 120).reverse();
        return send(res, 200, { blocks: rows.map((r) => ({ h: r.height, t: r.time, d: r.diff, n: r.ntx })) }), true;
      }
      if (p.startsWith("/api/block/")) {
        const b = resolveBlock(decodeURIComponent(p.slice(11)));
        if (!b) return send(res, 404, { error: "block not found" }), true;
        const txs = b.block.txs.map((j, pos) => {
          const t = parseTx(j);
          const a = j.cb === undefined ? (j.out[0]?.a ?? 0) : null;
          return { id: txId(t), coinbase: j.cb !== undefined, nin: j.in.length, nout: j.out.length, fee: j.fee, quantum: j.out.some((o) => o.kem), asset: a, ticker: a === null ? null : assetInfo(a).ticker };
        });
        return send(res, 200, {
          ...blockSummary(b), prev: b.prev, header: b.block.header, pow: b.pow, work: b.work, txs,
          next: chain.blockAt(b.height + 1)?.id || null, confirmations: chain.tip().height - b.height + 1,
        }), true;
      }
      if (p.startsWith("/api/tx/") && req.method === "GET") {
        const id = p.slice(8);
        if (!/^[0-9a-f]{64}$/.test(id)) return send(res, 400, { error: "bad tx id" }), true;
        const d = txDetail(id);
        return d ? send(res, 200, d) : send(res, 404, { error: "transaction not found" }), true;
      }
      if (p === "/api/txs") {
        const rows = chain.recentTxs(Math.min(Number(url.searchParams.get("limit") || 12), 50));
        const pool = [...chain.mempool.entries()].map(([id, m]) => ({ id, size: m.size, fee: m.fee.toString(), nin: m.tx.in.length, nout: m.tx.out.length, time: m.time, pending: true }));
        return send(res, 200, { mempool: pool, recent: rows.map((r) => ({ id: r.id, height: r.height, size: r.size, fee: r.fee, nin: r.nin, nout: r.nout, quantum: !!r.quantum, time: r.time })) }), true;
      }
      if (p === "/api/outputs") {
        const from = Math.max(0, Number(url.searchParams.get("from") || 0));
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 500), 1), 2000);
        const rows = chain.outputsFrom(from, limit).map((o) => {
          const r = { g: o.gidx, h: o.height, P: o.P, C: o.C, vt: o.vt };
          if (o.R) r.R = o.R; if (o.kem) r.kem = o.kem; if (o.ek) r.ek = o.ek; if (o.amount) r.amount = o.amount;
          if (PARAMS.multiAsset) { r.a = o.asset; r.ai = o.aidx; }
          return r;
        });
        return send(res, 200, { tip: chain.tip().height, eligible: chain.eligibleCount(), outputs: rows }), true;
      }
      if (p === "/api/ring") {
        // by global index (ids=) or, for a ring inside one asset, by position within that asset (asset=&ai=)
        const byAi = url.searchParams.has("ai");
        const ids = (url.searchParams.get(byAi ? "ai" : "ids") || "").split(",").filter(Boolean).map(Number);
        if (!ids.length || ids.length > 512 || ids.some((g) => !Number.isSafeInteger(g) || g < 0)) return send(res, 400, { error: "ids" }), true;
        const full = url.searchParams.get("full") === "1";
        const asset = Number(url.searchParams.get("asset") || 0);
        const out = ids.map((k) => {
          const o = byAi ? chain.outputByAidx(asset, k) : chain.getOutput(k);
          if (!o) return null;
          const r = { g: o.gidx, P: o.P, C: o.C, h: o.height };
          if (PARAMS.multiAsset) { r.a = o.asset; r.ai = o.aidx; }
          if (full) { r.vt = o.vt; if (o.R) r.R = o.R; if (o.kem) r.kem = o.kem; if (o.ek) r.ek = o.ek; if (o.amount) r.amount = o.amount; }
          return r;
        });
        return send(res, 200, { members: out }), true;
      }
      if (p === "/api/keyimages") {
        const from = Math.max(0, Number(url.searchParams.get("from") || 0));
        const rows = chain.keyImagesSince(from, 5000);
        return send(res, 200, { tip: chain.tip().height, keyImages: rows.map((r) => [r.ki, r.height]), pending: [...chain.pendingKeyImages()] }), true;
      }
      if (p === "/api/search") {
        const q = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (/^\d+$/.test(q) && chain.blockAt(Number(q))) return send(res, 200, { type: "block", id: q }), true;
        if (/^[0-9a-f]{64}$/.test(q)) {
          if (chain.blockById(q)) return send(res, 200, { type: "block", id: q }), true;
          if (chain.txRow(q) || chain.mempool.has(q)) return send(res, 200, { type: "tx", id: q }), true;
          const ki = chain.keyImageSpent(q);
          if (ki) return send(res, 200, { type: "tx", id: ki.txid, via: "key image" }), true;
        }
        if (q.startsWith("selen")) return send(res, 200, { type: "address", note: "Addresses never appear on chain. Every payment lands on a fresh one-time key." }), true;
        return send(res, 404, { error: "nothing matches" }), true;
      }
      if (p === "/api/sync/blocks") {
        const from = Math.max(1, Number(url.searchParams.get("from") || 1));
        const limit = Math.min(Number(url.searchParams.get("limit") || 20), 50);
        const blocks = [];
        for (let h = from; h < from + limit; h++) { const b = chain.blockAt(h); if (!b) break; blocks.push(b.block); }
        return send(res, 200, { tip: chain.tip(), blocks }), true;
      }
      if (p === "/api/sync/ids") {
        const from = Math.max(0, Number(url.searchParams.get("from") || 0));
        const ids = [];
        for (let h = from; h < from + 200; h++) { const b = chain.blockAt(h); if (!b) break; ids.push([h, b.id, b.work]); }
        return send(res, 200, { ids }), true;
      }

      // ---------- writes ----------
      if (p === "/api/tx" && req.method === "POST") {
        if (!lim.tx(ipOf(req))) return send(res, 429, { error: "slow down" }), true;
        const body = await readJson(req);
        const r = chain.addToMempool(body.tx || body);
        if (peer && !r.known) peer.forwardTx(body.tx || body);
        return send(res, 200, { ok: true, ...r }), true;
      }
      if (p === "/api/mining/job" && req.method === "GET") {
        if (!lim.job(ipOf(req))) return send(res, 429, { error: "slow down" }), true;
        const address = url.searchParams.get("address") || "";
        if (!isAddress(address)) return send(res, 400, { error: "a valid SELEN address is required" }), true;
        return send(res, 200, makeJob(address)), true;
      }
      if (p === "/api/mining/submit" && req.method === "POST") {
        if (!lim.submit(ipOf(req))) return send(res, 429, { error: "slow down" }), true;
        const { job, nonce } = await readJson(req);
        const j = jobs.get(job);
        if (!j) return send(res, 410, { error: "job expired, fetch a new one" }), true;
        if (j.tpl.header.prev !== chain.tip().id) return send(res, 409, { error: "stale: the chain moved on" }), true;
        const n = Number(nonce);
        const r = chain.addBlock({ header: { ...j.tpl.header, nonce: n }, txs: j.tpl.txs }, { source: "remote-miner" });
        jobs.delete(job);
        log(`[api] remote miner sealed block ${r.height}`);
        return send(res, 200, { ok: true, ...r }), true;
      }
      if (p === "/api/block" && req.method === "POST") {
        if (!lim.block(ipOf(req))) return send(res, 429, { error: "slow down" }), true;
        const body = await readJson(req);
        const r = chain.addBlock(body.block || body, { source: "peer" });
        return send(res, 200, { ok: true, ...r }), true;
      }
      if (p === "/api/faucet" && req.method === "POST") {
        if (!faucet) return send(res, 503, { error: "this node runs no faucet" }), true;
        const ip = ipOf(req);
        if (!lim.faucet(ip)) return send(res, 429, { error: "slow down" }), true;
        const { address, asset: wantAsset = 0 } = await readJson(req);
        if (!isAddress(address)) return send(res, 400, { error: "paste a valid SELEN address" }), true;
        const asset = Number(wantAsset);
        try { assetInfo(asset); } catch { return send(res, 400, { error: "unknown asset" }), true; }
        const amount = dripOf(asset);
        const key = decodeAddress(address).A.toHex() + ":" + asset;
        const now = Math.floor(Date.now() / 1000);
        const loopback = !isPublic && /^(127\.|::1$|::ffff:127\.)/.test(ip);
        for (const k of loopback ? [key] : [key, ip + ":" + asset]) {
          const last = faucetLog.get(k);
          if (last && now - last < FAUCET_COOLDOWN) return send(res, 429, { error: `faucet already used, try again in ${Math.ceil((FAUCET_COOLDOWN - (now - last)) / 3600)} h` }), true;
        }
        const r = faucet.send(address, amount, asset);
        faucetLog.set(key, now); faucetLog.set(ip + ":" + asset, now);
        log(`[faucet] ${fmtAsset(amount, asset)} ${assetInfo(asset).ticker} → ${address.slice(0, 14)}… tx ${r.id.slice(0, 12)}`);
        return send(res, 200, { ok: true, ...r, amount, asset, ticker: assetInfo(asset).ticker }), true;
      }
      return send(res, 404, { error: "unknown endpoint" }), true;
    } catch (e) {
      const code = e.code && Number.isInteger(e.code) ? e.code : 400;
      return send(res, code, { error: e.message || String(e) }), true;
    }
  };
}
