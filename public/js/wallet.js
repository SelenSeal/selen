import { $, $$, api, esc, coin, num, short, ago, toast, copy, onChain } from "/js/common.js";
import * as L from "/vendor/selen.js";

const app = $("#app");
const VAULT = "selen.vault.v1";
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- worker ----------
const worker = new Worker("/js/wallet-worker.js", { type: "module" });
let seq = 0;
const pending = new Map();
worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); e.data.ok ? p.res(e.data) : p.rej(new Error(e.data.error)); } };
const call = (msg) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); worker.postMessage({ ...msg, id }); });
// a crash inside the worker must not leave a send hanging: fail every pending call with the reason
worker.onerror = (e) => { e.preventDefault?.(); for (const [id, p] of pending) { pending.delete(id); p.rej(new Error(e.message || "wallet worker failed")); } };

// ---------- password vault (PBKDF2 + AES-GCM, WebCrypto) ----------
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function deriveKey(pw, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function seal(seed, pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deriveKey(pw, salt), seed));
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}
async function unseal(vault, pw) {
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(vault.iv) }, await deriveKey(pw, unb64(vault.salt)), unb64(vault.ct));
    return new Uint8Array(pt);
  } catch { throw new Error("wrong password"); }
}

// ---------- state ----------
let W = null; // { classic, quantum, tag, cache:{ scanned, outs:[] , sent:[] } }
let chain = { tip: 0, spent: new Map(), pend: new Set(), eligible: 0 };
let syncing = false;
// assets: one on the testnet (tSELEN); SELEN and USDG on the beta network. A = the asset on screen.
let A = 0;
const multi = () => !!L.PARAMS.multiAsset;
const tk = (a = A) => L.asset(a).ticker;
const amt = (v, a = A, d = 4) => L.fmtAsset(v, a, Math.min(d, L.asset(a).decimals));

const tick = '<span class="tick tl"></span><span class="tick br"></span>';

// ---------- gate screens ----------
function gate() {
  const vault = store.get(VAULT);
  if (vault) return unlockScreen();
  app.innerHTML = `<div class="gate">${tick}
    <span class="cap">No wallet in this browser yet</span>
    <h2 class="h-m">Make one, or bring one back.</h2>
    <p class="body">A new wallet is 32 random bytes made right here, written down as 24 words. Restoring needs those same 24 words.</p>
    <div class="btns"><button class="btn solid" id="mk">Create wallet</button><button class="btn" id="rs">Restore from 24 words</button></div></div>`;
  $("#mk").onclick = createScreen;
  $("#rs").onclick = restoreScreen;
}

function createScreen() {
  const seed = L.newSeed();
  const words = L.seedToWords(seed).split(" ");
  app.innerHTML = `<div class="gate">${tick}
    <span class="cap">Step 1 of 2 · your seed</span>
    <h2 class="h-m">Write these 24 words down.</h2>
    <p class="body">They are the wallet. Anyone holding them can spend; losing them loses the funds. SELEN never sees or stores them.</p>
    <div class="words24">${words.map((w, i) => `<span><i>${i + 1}</i>${esc(w)}</span>`).join("")}</div>
    <label class="check"><input type="checkbox" id="ok1"> I wrote the 24 words down somewhere safe, off this computer.</label>
    <div class="field"><label>Password for this browser</label><input class="input" type="password" id="pw1" placeholder="at least 8 characters" autocomplete="new-password"></div>
    <div class="field"><label>Repeat password</label><input class="input" type="password" id="pw2" autocomplete="new-password"></div>
    <p class="note" id="msg"></p>
    <div class="btns"><button class="btn solid" id="go">Create wallet</button><button class="btn" id="back">Back</button></div></div>`;
  $("#back").onclick = gate;
  $("#go").onclick = async () => {
    const pw = $("#pw1").value;
    if (!$("#ok1").checked) return ($("#msg").textContent = "Confirm you wrote the words down first.");
    if (pw.length < 8) return ($("#msg").textContent = "Password needs at least 8 characters.");
    if (pw !== $("#pw2").value) return ($("#msg").textContent = "Passwords do not match.");
    $("#go").disabled = true;
    store.set(VAULT, await seal(seed, pw));
    await open(seed);
  };
}

function restoreScreen() {
  app.innerHTML = `<div class="gate">${tick}
    <span class="cap">Restore</span>
    <h2 class="h-m">Bring a wallet back.</h2>
    <div class="field"><label>24 words</label><textarea class="input" id="words" rows="4" spellcheck="false" autocomplete="off" placeholder="word1 word2 … word24"></textarea></div>
    <div class="field"><label>New password for this browser</label><input class="input" type="password" id="pw1" autocomplete="new-password"></div>
    <p class="note" id="msg"></p>
    <div class="btns"><button class="btn solid" id="go">Restore wallet</button><button class="btn" id="back">Back</button></div></div>`;
  $("#back").onclick = gate;
  $("#go").onclick = async () => {
    try {
      const seed = L.wordsToSeed($("#words").value);
      const pw = $("#pw1").value;
      if (pw.length < 8) throw new Error("Password needs at least 8 characters.");
      store.set(VAULT, await seal(seed, pw));
      await open(seed);
    } catch (e) { $("#msg").textContent = e.message; $("#msg").className = "note err"; }
  };
}

function unlockScreen() {
  app.innerHTML = `<div class="gate">${tick}
    <span class="cap">Locked</span>
    <h2 class="h-m">Unlock your wallet.</h2>
    <form id="uf" class="field"><label>Password</label><input class="input" type="password" id="pw" autocomplete="current-password" autofocus></form>
    <p class="note err" id="msg"></p>
    <div class="btns"><button class="btn solid" id="go">Unlock</button><button class="btn" id="forget">Remove from this browser</button></div></div>`;
  const go = async (e) => {
    e?.preventDefault();
    try { await open(await unseal(store.get(VAULT), $("#pw").value)); } catch (err) { $("#msg").textContent = err.message; }
  };
  $("#uf").onsubmit = go;
  $("#go").onclick = go;
  $("#forget").onclick = () => {
    if (!confirm("Remove the encrypted wallet from this browser? Without your 24 words the funds cannot be recovered.")) return;
    store.del(VAULT);
    gate();
  };
}

// ---------- dashboard ----------
async function open(seed) {
  let network = "testnet";
  try { network = (await api("/api/status")).network; L.useNetwork(network); } catch {}
  const r = await call({ type: "init", seed: L.bytesToHex(seed), network });
  seed.fill(0);
  W = { classic: r.classic, quantum: r.quantum, tag: r.tag };
  try { localStorage.setItem("selen.mine.addr", r.quantum); } catch {}
  W.ckey = L.PARAMS.profile === "testnet" ? `selen.cache.${W.tag}` : `selen.cache.${L.PARAMS.profile}.${W.tag}`;
  W.cache = store.get(W.ckey) || { scanned: 0, outs: [], sent: [] };
  scrollTo(0, 0); // the seed screen is long; open the wallet at its top
  dashboard();
  await sync();
}
const saveCache = () => store.set(W.ckey, W.cache);

function dashboard() {
  app.innerHTML = `
  <div class="wl">
    <section>
      ${multi() ? `<div class="assetpick" role="tablist">${L.PARAMS.assets.map((a) => `<button data-a="${a.id}" class="${a.id === A ? "on" : ""}">${esc(a.ticker)}</button>`).join("")}</div>` : ""}
      <div class="bal"><span class="cap">Spendable</span><b id="bal">—<small>${esc(tk())}</small></b><span class="note" id="bal2"></span>
        <div class="progress" style="margin-top:12px"><i id="prog"></i></div><span class="note" id="syncmsg">syncing…</span></div>
      <div class="tabs" role="tablist">
        <button data-t="receive" class="on">Receive</button><button data-t="send">Send</button><button data-t="faucet">Faucet</button><button data-t="history">History</button><button data-t="keys">Keys</button>
      </div>
      <div class="tabpane on" data-p="receive">
        <div class="field"><label>Quantum address · selenq1 <span class="tag q" style="margin-left:8px">recommended</span></label><div class="addrbox" id="qaddr">${esc(W.quantum)}</div></div>
        <div class="btns" style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn sm solid" data-copyaddr="q">Copy quantum address</button></div>
        <p class="note">Payments to this address carry an ML-KEM-768 capsule, so who received them stays sealed even against a future quantum computer. It is long because it contains a 1,184-byte lattice public key.</p>
        <div class="field" style="margin-top:8px"><label>Classic address · selen1</label><div class="addrbox classic">${esc(W.classic)}</div></div>
        <div><button class="btn sm" data-copyaddr="c">Copy classic address</button></div>
        <p class="note">Shorter, but found with elliptic-curve key exchange. Fine today; not sealed against Q-day.</p>
      </div>
      <div class="tabpane" data-p="send">
        <div class="field"><label>To address</label><textarea class="input" id="to" rows="3" spellcheck="false" placeholder="selenq1… or selen1…"></textarea></div>
        <div class="field"><label id="amtlbl">Amount (${esc(tk())})</label><div style="display:flex"><input class="input" id="amt" inputmode="decimal" placeholder="0.00" style="border-right:0"><button class="btn" id="max" type="button">Max</button></div></div>
        <p class="note" id="sendmsg">${multi() ? "Inputs are signed inside rings of 16 outputs of the same asset. The fee is paid in the asset you send." : "Inputs are signed inside rings of 16. The fee is 0.0001 tSELEN per started kilobyte."}</p>
        <div><button class="btn acc" id="send">Sign and send</button></div>
      </div>
      <div class="tabpane" data-p="faucet" id="faucet">
        <p class="body">${multi() ? "The faucet pays test coins of each asset to your quantum address. They have no value. One request per asset and address every 12 hours." : "The faucet pays testnet coins to your quantum address from the node's own mined rewards. tSELEN has no value. One request per address every 12 hours."}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">${L.PARAMS.assets.map((a, i) => `<button class="btn ${i ? "" : "solid"}"${i ? "" : ' id="drip"'} data-drip="${a.id}">Request ${esc(multi() ? "test " + a.ticker : a.ticker)}</button>`).join("")}</div>
        <p class="note" id="dripmsg"></p>
      </div>
      <div class="tabpane" data-p="history"><div class="hist" id="hist"></div></div>
      <div class="tabpane" data-p="keys">
        <p class="body">Your seed is stored in this browser encrypted with your password. Enter it again to see the 24 words.</p>
        <div class="field"><label>Password</label><input class="input" type="password" id="kpw" autocomplete="current-password"></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn sm" id="show">Show 24 words</button><button class="btn sm" id="lock">Lock wallet</button></div>
        <div id="kwords"></div>
      </div>
    </section>
    <section>
      <span class="cap">This wallet</span>
      <div class="kv" style="grid-template-columns:1fr auto;margin-top:14px" id="side"></div>
      <div class="callout" style="margin-top:22px">Received coins can be spent after ${L.PARAMS.maturity} confirmations, about ${Math.round((L.PARAMS.maturity * L.PARAMS.targetBlockTime) / 60)} minutes. Coinbase rewards follow the same rule.</div>
      <a class="btn sm" href="/mine" style="margin-top:6px">Mine to this wallet</a>
    </section>
  </div>`;
  $$(".tabs button").forEach((b) => (b.onclick = () => tab(b.dataset.t)));
  $$(".assetpick button").forEach((b) => (b.onclick = () => {
    A = Number(b.dataset.a);
    $$(".assetpick button").forEach((x) => x.classList.toggle("on", x === b));
    $("#amtlbl").textContent = `Amount (${tk()})`;
    $("#amt").value = "";
    render();
  }));
  $$("[data-copyaddr]").forEach((b) => (b.onclick = () => copy(b.dataset.copyaddr === "q" ? W.quantum : W.classic, "Address copied")));
  $("#max").onclick = () => {
    const sp = spendable();
    if (!sp.list.length) return toast("Nothing spendable yet");
    const n = Math.min(sp.list.length, 16);
    const est = L.minFee(n * 1250 + 2 * 7450 + 300, A);
    const total = sp.list.slice(0, 16).reduce((s, o) => s + BigInt(o.v), 0n);
    $("#amt").value = L.fmtAsset(total > est ? total - est : 0n, A).replace(/,/g, "");
  };
  $("#send").onclick = send;
  $$("[data-drip]").forEach((b) => (b.onclick = () => drip(Number(b.dataset.drip), b)));
  $("#show").onclick = async () => {
    try { const seed = await unseal(store.get(VAULT), $("#kpw").value); const w = L.seedToWords(seed).split(" "); seed.fill(0);
      $("#kwords").innerHTML = `<div class="words24" style="margin-top:14px">${w.map((x, i) => `<span><i>${i + 1}</i>${esc(x)}</span>`).join("")}</div>`; }
    catch (e) { toast(e.message); }
  };
  $("#lock").onclick = () => location.reload();
  if (location.hash === "#faucet") tab("faucet");
}
function tab(t) {
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  $$(".tabpane").forEach((p) => p.classList.toggle("on", p.dataset.p === t));
}

// ---------- sync ----------
async function sync() {
  if (!W || syncing) return;
  syncing = true;
  try {
    const st = await api("/api/status");
    chain.tip = st.height; chain.eligible = st.eligibleOutputs;
    $("#netpill").textContent = `block ${num(st.height)}`;
    $("#netinfo").textContent = `${num(st.outputs)} outputs on chain`;
    const total = st.outputs;
    let from = W.cache.scanned;
    while (from < total) {
      const r = await api(`/api/outputs?from=${from}&limit=800`);
      if (!r.outputs.length) break;
      const { found } = await call({ type: "scan", rows: r.outputs });
      for (const f of found) if (!W.cache.outs.some((o) => o.g === f.g)) W.cache.outs.push(f);
      from = r.outputs.at(-1).g + 1;
      W.cache.scanned = from;
      $("#prog").style.width = `${Math.round((from / total) * 100)}%`;
      $("#syncmsg").textContent = `scanning outputs ${num(from)} / ${num(total)}`;
    }
    saveCache();
    const ki = await api("/api/keyimages?from=0");
    chain.spent = new Map(ki.keyImages);
    chain.pend = new Set(ki.pending);
    $("#prog").style.width = "100%";
    $("#syncmsg").textContent = `in sync at block ${num(chain.tip)}`;
    render();
  } catch (e) { $("#syncmsg").textContent = "sync failed: " + e.message; }
  finally { syncing = false; }
}

function spendable(a = A) {
  const cutoff = chain.tip + 1 - L.PARAMS.maturity;
  const list = [], locked = [], pend = [];
  for (const o of W.cache.outs) {
    if ((o.a ?? 0) !== a) continue;
    if (chain.spent.has(o.ki)) continue;
    if (chain.pend.has(o.ki)) { pend.push(o); continue; }
    (o.h <= cutoff ? list : locked).push(o);
  }
  list.sort((a, b) => Number(BigInt(b.v) - BigInt(a.v)));
  return { list, locked, pend };
}

function render() {
  const { list, locked, pend } = spendable();
  const sum = (a) => a.reduce((s, o) => s + BigInt(o.v), 0n);
  $("#bal").innerHTML = `${amt(sum(list))}<small>${esc(tk())}</small>`;
  const others = multi() ? L.PARAMS.assets.filter((x) => x.id !== A).map((x) => { const s = spendable(x.id); return ` · ${amt(sum(s.list) + sum(s.locked), x.id)} ${x.ticker}`; }).join("") : "";
  $("#bal2").textContent = `${amt(sum(locked))} confirming · ${amt(sum(pend))} in outgoing transfers${others}`;
  $("#side").innerHTML = [
    ["Outputs owned", num(W.cache.outs.length)], ["Unspent", num(list.length + locked.length + pend.length)],
    ["Quantum outputs", num(W.cache.outs.filter((o) => o.q).length)], ["Chain tip", num(chain.tip)],
  ].map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join("");
  const rows = [
    ...W.cache.outs.map((o) => ({ h: o.h, html: `<span class="tag ${o.q ? "q" : ""}">${o.cb ? (o.h === 0 ? "reserve" : "reward") : "received"}</span><span>${o.q ? "ML-KEM capsule" : "classic"} · block <a class="ac" href="/block/${o.h}">${num(o.h)}</a>${chain.spent.has(o.ki) ? ` · <span class="dim2">spent at ${num(chain.spent.get(o.ki))}</span>` : ""}</span><span class="amt">+${amt(o.v, o.a ?? 0)}${multi() ? ` <small>${esc(tk(o.a ?? 0))}</small>` : ""}</span>` })),
    ...(W.cache.sent || []).map((s) => ({ h: 1e12 + s.t, html: `<span class="tag">sent</span><span>to ${esc(short(s.to, 12, 6))} · <a class="ac" href="/tx/${s.id}">${short(s.id, 8, 4)}</a> · ${ago(s.t)}</span><span class="amt out">−${amt(s.v, s.a ?? 0)}${multi() ? ` <small>${esc(tk(s.a ?? 0))}</small>` : ""}</span>` })),
  ].sort((a, b) => b.h - a.h);
  $("#hist").innerHTML = rows.length ? rows.map((r) => `<div class="h">${r.html}</div>`).join("") : `<p class="empty">Nothing yet. Take tSELEN from the faucet or mine to this wallet.</p>`;
}

// ---------- actions ----------
async function send() {
  const msg = $("#sendmsg");
  msg.className = "note";
  try {
    const to = $("#to").value.trim().replace(/\s+/g, "");
    if (!L.isAddress(to)) throw new Error("That is not a SELEN address.");
    const amount = L.parseAsset($("#amt").value || "0", A);
    if (amount <= 0n) throw new Error("Enter an amount.");
    const { list } = spendable();
    const picked = [];
    let s = 0n;
    const feeRoom = L.minFee(40_000, A);
    for (const o of list) { picked.push(o); s += BigInt(o.v); if (s >= amount + feeRoom || picked.length >= 16) break; }
    if (s < amount) throw new Error(`Not enough spendable ${tk()} (new coins need ${L.PARAMS.maturity} confirmations).`);
    $("#send").disabled = true;
    msg.textContent = `building rings and signing ${picked.length} input${picked.length > 1 ? "s" : ""}…`;
    const b = await call({ type: "build", to, amount: amount.toString(), asset: A, inputs: picked.map((o) => ({ g: o.g, ai: o.ai ?? o.g })) });
    msg.textContent = `signed · ${num(b.size)} bytes · fee ${amt(b.fee, A, 6)} ${tk()} · broadcasting…`;
    const r = await api("/api/tx", { method: "POST", body: JSON.stringify({ tx: b.tx }) });
    (W.cache.sent ||= []).push({ id: r.id, to, v: amount.toString(), a: A, t: Math.floor(Date.now() / 1000) });
    saveCache();
    msg.innerHTML = `Sent. Transfer <a class="ac" href="/tx/${r.id}">${short(r.id, 10, 6)}</a> is in the mempool.`;
    msg.className = "note ok";
    $("#to").value = ""; $("#amt").value = "";
    await sync();
  } catch (e) { msg.textContent = e.message; msg.className = "note err"; }
  finally { $("#send").disabled = false; }
}

async function drip(a = 0, btn) {
  const m = $("#dripmsg");
  if (btn) btn.disabled = true;
  try {
    const r = await api("/api/faucet", { method: "POST", body: JSON.stringify({ address: W.quantum, asset: a }) });
    m.innerHTML = `On its way: ${amt(r.amount, a, 2)} ${esc(tk(a))} in <a class="ac" href="/tx/${r.id}">${short(r.id, 10, 6)}</a>. It shows up after the next block.`;
    m.className = "note ok";
  } catch (e) { m.textContent = e.message; m.className = "note err"; }
  finally { if (btn) btn.disabled = false; }
}

onChain((ev) => { if (ev.type === "block" || ev.type === "rollback") sync(); });
gate();
