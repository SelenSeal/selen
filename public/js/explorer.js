import { $, $$, api, esc, num, coin, short, ago, hashrate, onChain, copy } from "/js/common.js";

const view = $("#view");
const path = location.pathname;

function head(title, sub, side = "") {
  return `<div class="page-head"><div><span class="cap">SELEN testnet · explorer</span><h1 class="h-l" style="margin-top:14px">${title}</h1>${sub ? `<p class="lead">${sub}</p>` : ""}</div><div class="side">${side}</div></div>`;
}
const searchBox = `<form class="search" id="sf"><input class="input" name="q" placeholder="Block height, block hash, tx id or key image" autocomplete="off" spellcheck="false"><button class="btn solid">Search</button></form><p class="note" id="sfmsg" style="margin-top:8px"></p>`;
function bindSearch() {
  const f = $("#sf");
  if (!f) return;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const q = f.q.value.trim();
    if (!q) return;
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (r.type === "block") location.href = `/block/${r.id}`;
      else if (r.type === "tx") location.href = `/tx/${r.id}`;
      else $("#sfmsg").textContent = r.note || "No match.";
    } catch (err) { $("#sfmsg").textContent = err.message; }
  };
}

// ---------------- home ----------------
async function home() {
  view.innerHTML = head("Blocks without<br><em>a single name.</em>", "Every block, every transfer, every proof. There is no sender, receiver or amount here to read, because the chain never had them in the clear.", `<span class="pill-live" id="livepill">live</span>${searchBox}`) + `
    <div class="cells minis" id="minis"></div>
    <div class="row2" style="gap:40px;margin-top:40px">
      <div><div class="blockhead"><h3>Latest blocks</h3><span class="r cap" id="tipinfo"></span></div><div class="scroll-x"><table class="tbl"><thead><tr><th>Height</th><th>Block</th><th>Age</th><th>Txs</th><th>Size</th><th>Reward</th></tr></thead><tbody id="blocks"></tbody></table></div><div style="margin-top:14px"><button class="btn sm" id="more">Older blocks</button></div></div>
      <div><div class="blockhead"><h3>Private transfers</h3><span class="r cap">mempool + confirmed</span></div><div class="scroll-x"><table class="tbl"><thead><tr><th>Transfer</th><th>Where</th><th>In / Out</th><th>Fee</th></tr></thead><tbody id="txs"></tbody></table></div></div>
    </div>`;
  bindSearch();
  let oldest = null;
  const row = (b, isNew) => `<tr class="${isNew ? "new" : ""}"><td class="hi"><a href="/block/${b.height}">${num(b.height)}</a></td><td><a href="/block/${b.id}">${short(b.id, 10, 6)}</a></td><td>${ago(b.time)}</td><td>${b.ntx}</td><td>${(b.size / 1000).toFixed(1)} kB</td><td>${coin(BigInt(b.reward) + BigInt(b.fees), 2)}</td></tr>`;
  async function loadBlocks(before, append, fresh) {
    const r = await api(`/api/blocks?limit=15${before != null ? `&before=${before}` : ""}`);
    const html = r.blocks.map((b, i) => row(b, fresh && i === 0)).join("");
    $("#blocks").innerHTML = append ? $("#blocks").innerHTML + html : html;
    oldest = r.blocks.at(-1)?.height;
    $("#more").style.display = oldest > 0 ? "" : "none";
  }
  async function loadTxs() {
    const r = await api("/api/txs?limit=14");
    const all = [...r.mempool.map((t) => ({ ...t, where: `<span class="tag live">pending</span>` })), ...r.recent.map((t) => ({ ...t, where: `<a href="/block/${t.height}">#${num(t.height)}</a>` }))];
    $("#txs").innerHTML = all.length ? all.map((t) => `<tr><td class="hi"><a href="/tx/${t.id}">${short(t.id, 10, 6)}</a> ${t.quantum ? '<span class="tag q">q</span>' : ""}</td><td>${t.where}</td><td>${t.nin} / ${t.nout}</td><td>${coin(t.fee, 5)}</td></tr>`).join("")
      : `<tr><td colspan="4" class="empty">No private transfers yet. Rings need ${16} mature outputs, then the faucet and wallets start moving coins.</td></tr>`;
  }
  function minis(st) {
    $("#minis").innerHTML = [
      ["Height", num(st.height)], ["Avg block", st.avgBlockTime ? st.avgBlockTime.toFixed(1) + " s" : "—"], ["Hashrate", hashrate(st.hashrate)],
      ["Outputs", num(st.outputs)], ["Quantum outputs", num(st.quantumOutputs)], ["Key images", num(st.keyImages)],
    ].map(([k, v]) => `<div><span class="cap">${k}</span><b>${v}</b></div>`).join("");
    $("#tipinfo").textContent = `difficulty ${num(st.difficulty)}`;
  }
  $("#more").onclick = () => loadBlocks(oldest - 1, true);
  await Promise.all([loadBlocks(), loadTxs(), api("/api/status").then(minis)]);
  onChain((ev) => {
    if (ev.stats) minis(ev.stats);
    if (ev.type === "block" || ev.type === "rollback") { loadBlocks(null, false, true); loadTxs(); }
    if (ev.type === "mempool") loadTxs();
  });
}

// ---------------- block ----------------
async function block(id) {
  let b;
  try { b = await api(`/api/block/${id}`); }
  catch (e) { view.innerHTML = head("Block not found", esc(e.message), searchBox); bindSearch(); return; }
  const h = b.header;
  view.innerHTML = head(`Block <em>#${num(b.height)}</em>`, `${b.ntx} transaction${b.ntx === 1 ? "" : "s"} · sealed ${ago(b.time)} · ${num(b.confirmations)} confirmations`,
    `<div style="display:flex;gap:8px">${b.height > 0 ? `<a class="btn sm" href="/block/${b.height - 1}">← ${num(b.height - 1)}</a>` : ""}${b.next ? `<a class="btn sm" href="/block/${b.height + 1}">${num(b.height + 1)} →</a>` : ""}</div>${searchBox}`) + `
    <div class="page"><div class="kv">
      <div>Block id</div><div>${esc(b.id)}</div>
      <div>Previous</div><div>${b.height > 0 ? `<a href="/block/${esc(b.prev)}">${esc(b.prev)}</a>` : "none · genesis"}</div>
      <div>Time</div><div>${new Date(b.time * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC</div>
      <div>Difficulty</div><div>${num(b.diff)}</div>
      <div>Argon2id hash</div><div>${esc(b.pow)}</div>
      <div>Nonce</div><div>${num(h.nonce)}</div>
      <div>Merkle root</div><div>${esc(h.root)}</div>
      <div>Size</div><div>${num(b.size)} bytes</div>
      <div>Reward + fees</div><div>${coin(b.reward, 8)} + ${coin(b.fees, 8)} tSELEN <span class="dim2">(paid to a one-time key)</span></div>
      <div>Cumulative work</div><div>${num(b.work)}</div>
    </div>
    <div class="blockhead" style="margin-top:34px"><h3>Transactions</h3></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>Tx</th><th>Kind</th><th>In / Out</th><th>Fee</th></tr></thead><tbody>
    ${b.txs.length ? b.txs.map((t) => `<tr><td class="hi"><a href="/tx/${t.id}">${short(t.id, 14, 8)}</a></td><td>${t.coinbase ? `<span class="tag">${b.height === 0 ? "reserve" : "coinbase"}</span>` : `<span class="tag">private</span>${t.ticker && t.asset ? ` <span class="tag live">${esc(t.ticker)}</span>` : ""}`} ${t.quantum ? '<span class="tag q">ML-KEM</span>' : ""}</td><td>${t.nin} / ${t.nout}</td><td>${t.asset ? "paid in " + esc(t.ticker) : coin(t.fee, 6)}</td></tr>`).join("") : `<tr><td colspan="4" class="empty">Genesis carries no transactions, only this note committed in its root: <br>"${esc((window.GENESIS_NOTE || "SELEN testnet genesis"))}"</td></tr>`}
    </tbody></table></div></div>`;
  bindSearch();
}

// ---------------- tx ----------------
async function tx(id) {
  let d;
  try { d = await api(`/api/tx/${id}`); }
  catch (e) { view.innerHTML = head("Transaction not found", esc(e.message), searchBox); bindSearch(); return; }
  const t = d.tx;
  // amounts in each asset's own decimals (one asset on the testnet, SELEN + USDG on the beta network)
  const AS = d.assets || [{ id: 0, ticker: "tSELEN", decimals: 8 }];
  const aOf = (id) => AS.find((a) => a.id === (id ?? 0)) || AS[0];
  const fmtA = (v, id) => { const { decimals: dc } = aOf(id), one = 10n ** BigInt(dc), x = BigInt(v ?? 0), fr = (x % one).toString().padStart(dc, "0").replace(/0+$/, ""); return (x / one).toLocaleString("en-US") + (fr ? "." + fr : ""); };
  const multiA = AS.length > 1;
  const where = d.inMempool ? `<span class="tag live">pending in mempool</span>` : `in <a class="ac" href="/block/${d.block.height}">block #${num(d.block.height)}</a> · ${num(d.confirmations)} confirmations`;
  const ins = t.in.map((i, k) => `<div class="inp"><span class="lbl">Input ${k} · key image</span><div class="ki">${esc(i.ki)}</div>
      <span class="lbl">Ring of ${i.ring.length} (global output index)</span><div class="ringgrid">${i.ring.map((g, j) => `<a href="/tx/${d.ring[k][j].txid}" title="output ${g}">${g}</a>`).join("")}</div>
      <span class="lbl">Pseudo commitment</span><div class="ki dim">${esc(i.pc)}</div></div>`).join("");
  const outs = t.out.map((o, k) => `<div class="outp"><span class="lbl">Output ${k}${d.outputGidx[k] != null ? ` · index ${d.outputGidx[k]}` : ""} ${multiA ? `<span class="tag live" style="margin-left:6px">${esc(aOf(o.a).ticker)}</span>` : ""}${o.kem ? '<span class="tag q" style="margin-left:6px">ML-KEM-768</span>' : '<span class="tag" style="margin-left:6px">classic</span>'}</span>
      <div class="pk">${esc(o.P)}</div>
      <span class="lbl">Commitment</span><div class="pk dim">${esc(o.C)}</div>
      <span class="lbl">${o.kem ? "Capsule" : "Ephemeral key"}</span><div class="pk dim">${o.kem ? `${esc(o.kem.slice(0, 64))}… <span class="dim2">(${o.kem.length / 2} bytes)</span>` : esc(o.R)}</div>
      <span class="lbl">Amount</span><div class="hiddenval">${d.coinbase ? `${fmtA(o.amount, o.a)} ${esc(aOf(o.a).ticker)} · ${t.cb === 0 ? "genesis reserve" : (o.a ?? 0) === 0 ? "block reward" : "fees collected in this asset"}, public by design` : "sealed · commitment + 48-bit range proof"}</div></div>`).join("");
  view.innerHTML = head(`${d.coinbase ? (t.cb === 0 ? "Genesis reserve" : "Coinbase") : multiA ? `Private ${aOf(d.asset).ticker} transfer` : "Private transfer"}`, `<span class="mono" style="font-size:14px;overflow-wrap:anywhere">${esc(id)}</span>`, `<div>${where}</div>${searchBox}`) + `
    <div class="page">
      <div class="kv">
        <div>Size</div><div>${num(d.size)} bytes</div>
        <div>Fee</div><div>${fmtA(d.fee, d.asset)} ${esc(aOf(d.asset).ticker)}</div>
        <div>Inputs / outputs</div><div>${t.in.length} / ${t.out.length}</div>
        <div>Sender</div><div class="hiddenval">hidden in ${t.in.length ? "a ring of " + t.in[0].ring.length : "nothing · new coins"}</div>
        <div>Receiver</div><div class="hiddenval">one-time key${t.out.some((o) => o.kem) ? " · ML-KEM-768 capsule" : ""}</div>
      </div>
      ${d.coinbase ? "" : `<div class="verify" id="verify"><div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:center"><div><span class="cap">Don't trust the node</span><p class="body" style="margin-top:6px;font-size:14px">Re-run every ring signature, range proof and the balance equation on your own machine.</p></div><button class="btn acc sm" id="vbtn">Verify in your browser</button></div><div class="vlist" id="vlist"></div></div>`}
      <div class="io"><div><h4><span>Inputs</span><span>${t.in.length}</span></h4>${ins || '<p class="empty">Coinbase: newly minted coins, no inputs.</p>'}</div><div><h4><span>Outputs</span><span>${t.out.length}</span></h4>${outs}</div></div>
    </div>`;
  bindSearch();
  const vb = $("#vbtn");
  if (vb) vb.onclick = async () => {
    vb.disabled = true; vb.textContent = "Verifying…";
    const list = $("#vlist");
    list.innerHTML = `<div>loading verifier and ring members…</div>`;
    try {
      const L = await import("/vendor/selen.js");
      if (d.network) L.useNetwork(d.network);
      const parsed = L.parseTx(t);
      const members = d.ring.map((ring) => ring.map((m) => ({ P: L.hexToBytes(m.P), C: L.hexToBytes(m.C) })));
      list.innerHTML = `<div class="ok">tx id recomputed: ${L.txId(parsed) === id ? "matches" : "MISMATCH"}</div>`;
      await new Promise((r) => setTimeout(r, 30));
      const t0 = performance.now();
      const res = L.verifyTxCrypto(parsed, members, { onProgress: (c) => { list.insertAdjacentHTML("beforeend", `<div class="${c.ok ? "ok" : "bad"}">${esc(c.name)}: ${c.ok ? "valid" : "INVALID"}</div>`); } });
      list.insertAdjacentHTML("beforeend", `<div class="${res.ok ? "ok" : "bad"}"><b>${res.ok ? "All checks passed" : "Verification failed"}</b>&nbsp;in ${((performance.now() - t0) / 1000).toFixed(2)} s, on this device</div>`);
      vb.textContent = res.ok ? "Verified" : "Failed";
    } catch (e) {
      list.insertAdjacentHTML("beforeend", `<div class="bad">${esc(e.message)}</div>`);
      vb.disabled = false; vb.textContent = "Retry";
    }
  };
}

const m = path.match(/^\/(block|tx)\/([0-9a-f]+|\d+)$/);
if (m && m[1] === "block") block(m[2]);
else if (m && m[1] === "tx") tx(m[2]);
else home();
