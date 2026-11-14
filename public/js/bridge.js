// SELEN Bridge page. Robinhood side: the visitor's own wallet (EIP-1193) signs approve + lock. SELEN side: a wallet
// derived from one signature of that same Robinhood account (no extra words to keep), built and signed in the
// wallet worker. The node's bridge service pays deposits out on SELEN and releases withdrawals on Robinhood Chain.
import { $, $$, api, esc, num, short, copy } from "/js/common.js";
import * as L from "/vendor/selen.js";

const app = $("#app");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------- wallet worker (same one the Wallet page uses) ----------
const worker = new Worker("/js/wallet-worker.js", { type: "module" });
let seq = 0;
const pending = new Map();
worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); e.data.ok ? p.res(e.data) : p.rej(new Error(e.data.error)); } };
worker.onerror = (e) => { e.preventDefault?.(); for (const [id, p] of pending) { pending.delete(id); p.rej(new Error(e.message || "wallet worker failed")); } };
const call = (msg) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); worker.postMessage({ ...msg, id }); });

// ---------- Robinhood side, by hand: four calls need no library ----------
const eth = () => window.ethereum;
const word = (h) => String(h).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const enc = { addr: (a) => word(a), uint: (n) => word(BigInt(n).toString(16)), b32: (h) => word(h) };
const SEL = { balanceOf: "0x70a08231", allowance: "0xdd62ed3e", approve: "0x095ea7b3", lock: "0xca3369c6" };
const ethCall = (to, data) => eth().request({ method: "eth_call", params: [{ to, data }, "latest"] });
const balanceOf = async (token, who) => BigInt(await ethCall(token, SEL.balanceOf + enc.addr(who)));
const allowance = async (token, owner, spender) => BigInt(await ethCall(token, SEL.allowance + enc.addr(owner) + enc.addr(spender)));
const sendTx = (to, data) => eth().request({ method: "eth_sendTransaction", params: [{ from: S.evm, to, data }] });
async function waitTx(hash) {
  for (let i = 0; i < 600; i++) {
    const r = await eth().request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (r) { if (r.status !== "0x1") throw new Error("the transaction reverted on Robinhood Chain"); return r; }
    await sleep(1500);
  }
  throw new Error("no receipt yet, check the explorer");
}
function units(v, dec, digits = dec) {
  const one = 10n ** BigInt(dec), x = BigInt(v), fr = (x % one).toString().padStart(dec, "0").slice(0, digits).replace(/0+$/, "");
  return (x / one).toLocaleString("en-US") + (fr ? "." + fr : "");
}

// ---------- state ----------
const S = { cfg: null, st: null, evm: null, dir: "in", token: null, W: null, spent: new Map(), pend: new Set(), timer: 0 };
const tok = () => S.cfg.tokens.find((t) => t.token === S.token) || S.cfg.tokens[0];
const tick = '<span class="tick tl"></span><span class="tick br"></span>';

async function boot() {
  try { S.st = await api("/api/status"); L.useNetwork(S.st.network); $("#netpill").textContent = `block ${num(S.st.height)}`; } catch {}
  try { S.cfg = await api("/api/bridge"); }
  catch {
    $("#netinfo").textContent = S.st ? S.st.network : "";
    app.innerHTML = `<div class="gate">${tick}<span class="cap">Not open on this network yet</span><h2 class="h-m">The bridge opens with SELEN Mainnet Beta.</h2>
      <p class="body">Until then the testnet runs on its own: take tSELEN from the faucet, send private transfers and mine from the browser.</p>
      <div class="btns"><a class="btn solid" href="/wallet">Open the wallet</a><a class="btn" href="/docs">Read the docs</a></div></div>`;
    return;
  }
  S.token = S.cfg.tokens[0]?.token;
  $("#netinfo").textContent = `Robinhood Chain ${S.cfg.chainId} · ${S.cfg.tokens.map((t) => t.symbol).join(" · ")}`;
  connectScreen();
}

function connectScreen() {
  const has = !!eth();
  app.innerHTML = `<div class="gate">${tick}<span class="cap">Step 1 · connect</span><h2 class="h-m">Connect your Robinhood Chain wallet.</h2>
    <p class="body">${has ? "Your SELEN wallet is made from one signature of this account, so there are no extra words to keep. Signing sends nothing and costs nothing." : "This browser has no wallet. Install one that supports Robinhood Chain (for example MetaMask or Rabby), then reload."}</p>
    <div class="btns"><button class="btn solid" id="cn" ${has ? "" : "disabled"}>Connect wallet</button></div><p class="note" id="msg"></p></div>`;
  if (has) $("#cn").onclick = connect;
}

async function ensureChain() {
  const want = "0x" + S.cfg.chainId.toString(16);
  if ((await eth().request({ method: "eth_chainId" })).toLowerCase() === want) return;
  try { await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] }); }
  catch (e) {
    if (e.code !== 4902) throw e;
    await eth().request({ method: "wallet_addEthereumChain", params: [{ chainId: want, chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [S.cfg.rpc], blockExplorerUrls: [S.cfg.explorer] }] });
  }
}

const MESSAGE = (a) => `SELEN wallet\n\nSign to open the SELEN wallet that belongs to this Robinhood Chain account. Signing sends nothing and costs nothing.\n\nAccount: ${a.toLowerCase()}`;
async function signSeed() {
  const hexMsg = "0x" + L.bytesToHex(L.utf8(MESSAGE(S.evm)));
  const sig = await eth().request({ method: "personal_sign", params: [hexMsg, S.evm] });
  return L.sha256(L.concat(L.utf8("selen/evm-wallet/v1"), L.hexToBytes(String(sig).replace(/^0x/, ""))));
}

async function connect() {
  const msg = $("#msg");
  try {
    msg.className = "note"; msg.textContent = "waiting for the wallet…";
    [S.evm] = await eth().request({ method: "eth_requestAccounts" });
    await ensureChain();
    msg.textContent = "sign once to open your SELEN wallet…";
    let seed = await signSeed();
    // some wallets (smart accounts, some hardware) sign differently every time; a wallet made from such a signature
    // could never be opened again, so the first time on this browser the signature is asked twice and compared
    const okKey = `selen.evm.ok.${S.evm.toLowerCase()}`;
    if (!store.get(okKey)) {
      msg.textContent = "sign once more to confirm this wallet signs the same way every time…";
      const again = await signSeed();
      if (L.bytesToHex(again) !== L.bytesToHex(seed)) throw new Error("This wallet gives a different signature each time, so it cannot open a SELEN wallet. Use the Wallet page with 24 words instead.");
      store.set(okKey, true);
    }
    const r = await call({ type: "init", seed: L.bytesToHex(seed), network: S.st.network });
    seed.fill(0);
    S.W = { quantum: r.quantum, tag: r.tag };
    S.W.key = `selen.cache.${L.PARAMS.profile}.${r.tag}`;
    S.W.cache = store.get(S.W.key) || { scanned: 0, outs: [] };
    eth().on?.("accountsChanged", () => location.reload());
    eth().on?.("chainChanged", () => location.reload());
    dashboard();
    await refresh();
    S.timer = setInterval(refresh, 5000);
  } catch (e) { msg.className = "note err"; msg.textContent = e.message || String(e); }
}

// ---------- dashboard ----------
function dashboard() {
  app.innerHTML = `<div class="wl">
    <section>
      <div class="assetpick" id="dir"><button data-d="in" class="on">Robinhood → SELEN</button><button data-d="out">SELEN → Robinhood</button></div>
      <div class="field"><label>Asset</label><div class="assetpick" id="tok" style="margin:0">${S.cfg.tokens.map((t) => `<button data-t="${t.token}" class="${t.token === S.token ? "on" : ""}">${esc(t.symbol)}</button>`).join("")}</div></div>
      <div class="field"><label id="amtlbl">Amount</label><div style="display:flex"><input class="input" id="amt" inputmode="decimal" placeholder="0.00" style="border-right:0"><button class="btn" id="max" type="button">Max</button></div></div>
      <p class="note" id="have"></p>
      <p class="note" id="explain"></p>
      <div><button class="btn acc" id="go">Bridge</button></div>
      <p class="note" id="gomsg"></p>
    </section>
    <section>
      <span class="cap">Your accounts</span>
      <div class="kv" style="grid-template-columns:auto 1fr;margin-top:14px" id="acc"></div>
      <span class="cap" style="display:block;margin-top:26px">Activity</span>
      <div class="hist" id="act" style="margin-top:10px"></div>
    </section>
  </div>`;
  const clear = () => { $("#gomsg").textContent = ""; $("#gomsg").className = "note"; $("#amt").value = ""; };
  $$("#dir button").forEach((b) => (b.onclick = () => { S.dir = b.dataset.d; $$("#dir button").forEach((x) => x.classList.toggle("on", x === b)); clear(); form(); }));
  $$("#tok button").forEach((b) => (b.onclick = () => { S.token = b.dataset.t; $$("#tok button").forEach((x) => x.classList.toggle("on", x === b)); clear(); form(); }));
  $("#max").onclick = max;
  $("#go").onclick = () => (S.dir === "in" ? bridgeIn() : bridgeOut());
  form();
}

const selenSpendable = (asset) => {
  const cutoff = (S.st?.height || 0) + 1 - L.PARAMS.maturity;
  const list = [], waiting = [];
  for (const o of S.W.cache.outs) {
    if ((o.a ?? 0) !== asset || S.spent.has(o.ki) || S.pend.has(o.ki)) continue;
    (o.h <= cutoff ? list : waiting).push(o);
  }
  list.sort((a, b) => Number(BigInt(b.v) - BigInt(a.v)));
  return { list, waiting, sum: list.reduce((s, o) => s + BigInt(o.v), 0n), soon: waiting.reduce((s, o) => s + BigInt(o.v), 0n) };
};

let rhBal = new Map();
function form() {
  const t = tok(), a = L.asset(t.asset);
  $("#amtlbl").textContent = `Amount (${t.symbol})`;
  $("#go").textContent = S.dir === "in" ? "Bridge to SELEN" : "Bridge to Robinhood";
  if (S.dir === "in") {
    const b = rhBal.get(t.token);
    $("#have").textContent = b == null ? "" : `On Robinhood Chain: ${units(b, t.decimals, 6)} ${t.symbol}`;
    $("#explain").textContent = `You approve and lock on Robinhood Chain. After ${S.cfg.rhConfirmations} confirmations the same amount arrives on SELEN as a sealed ${a.ticker} output to your SELEN wallet.`;
  } else {
    const s = selenSpendable(t.asset);
    $("#have").textContent = `On SELEN: ${L.fmtAsset(s.sum, t.asset, 6)} ${a.ticker} spendable${s.soon ? ` · ${L.fmtAsset(s.soon, t.asset, 6)} confirming` : ""}`;
    $("#explain").textContent = `You send ${a.ticker} privately to the bridge with your Robinhood address sealed inside. After ${S.cfg.selenConfirmations} SELEN confirmations (about ${Math.round((S.cfg.selenConfirmations * L.PARAMS.targetBlockTime) / 60)} minutes) the same amount is released to ${short(S.evm, 8, 6)} on Robinhood Chain. The fee on SELEN is paid in ${a.ticker}.`;
  }
}

function max() {
  const t = tok();
  if (S.dir === "in") {
    const b = rhBal.get(t.token) ?? 0n, unit = BigInt(t.unit);
    $("#amt").value = units(b - (b % unit), t.decimals).replace(/,/g, "");
  } else {
    const s = selenSpendable(t.asset), n = Math.min(s.list.length, 16);
    const fee = L.minFee(n * 1250 + 2 * 7600 + 400, t.asset);
    const total = s.list.slice(0, 16).reduce((x, o) => x + BigInt(o.v), 0n);
    $("#amt").value = L.fmtAsset(total > fee ? total - fee : 0n, t.asset).replace(/,/g, "");
  }
}

async function refresh() {
  try {
    S.st = await api("/api/status");
    $("#netpill").textContent = `block ${num(S.st.height)}`;
    // scan new outputs for the SELEN wallet
    let from = S.W.cache.scanned;
    while (from < S.st.outputs) {
      const r = await api(`/api/outputs?from=${from}&limit=800`);
      if (!r.outputs.length) break;
      const { found } = await call({ type: "scan", rows: r.outputs });
      for (const f of found) if (!S.W.cache.outs.some((o) => o.g === f.g)) S.W.cache.outs.push(f);
      from = r.outputs.at(-1).g + 1;
      S.W.cache.scanned = from;
    }
    store.set(S.W.key, S.W.cache);
    const ki = await api("/api/keyimages?from=0");
    S.spent = new Map(ki.keyImages);
    S.pend = new Set(ki.pending);
    for (const t of S.cfg.tokens) rhBal.set(t.token, await balanceOf(t.token, S.evm).catch(() => null));
    accounts();
    form();
    await activity();
  } catch (e) { $("#gomsg").textContent = "refresh failed: " + e.message; }
}

function accounts() {
  const rows = [
    ["Robinhood", `<span class="mono">${esc(short(S.evm, 10, 8))}</span>`],
    ["SELEN", `<span class="mono">${esc(short(S.W.quantum, 12, 8))}</span> <button class="btn sm" id="cpq" style="margin-left:6px">Copy</button>`],
    ...S.cfg.tokens.map((t) => { const s = selenSpendable(t.asset); return [`${t.symbol}`, `${units(rhBal.get(t.token) ?? 0n, t.decimals, 4)} on Robinhood · ${L.fmtAsset(s.sum + s.soon, t.asset, 4)} on SELEN`]; }),
  ];
  $("#acc").innerHTML = rows.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join("");
  $("#cpq").onclick = () => copy(S.W.quantum, "SELEN address copied");
}

async function activity() {
  const dest = S.W.dest || (S.W.dest = (await api("/api/bridge/register", { method: "POST", body: JSON.stringify({ address: S.W.quantum }) })).dest);
  const a = await api(`/api/bridge/activity?evm=${S.evm}&dest=${dest}`);
  const rh = (h) => `<a class="ac" href="${S.cfg.explorer}/tx/${h}" target="_blank" rel="noopener">${short(h, 8, 4)}</a>`;
  const label = { new: "seen", "waiting-dest": "waiting for your SELEN address", retry: "queued", sent: "arrived on SELEN", confirming: "confirming on SELEN", releasing: "releasing", released: "released on Robinhood", unsupported: "not supported", dropped: "dropped" };
  const rows = [
    ...a.deposits.map((d) => { const t = S.cfg.tokens.find((x) => x.token.toLowerCase() === d.token); return { t: d.updated, html: `<span class="tag ${d.status === "sent" ? "q" : ""}">in</span><span>Robinhood → SELEN · ${esc(label[d.status] || d.status)} · ${rh(d.rhTx)}${d.selenTx ? ` → <a class="ac" href="/tx/${d.selenTx}">${short(d.selenTx, 8, 4)}</a>` : ""}</span><span class="amt">+${t ? units(d.amount, t.decimals, 4) : d.amount} <small>${esc(d.symbol || "")}</small></span>` }; }),
    ...a.withdrawals.map((w) => ({ t: w.updated, html: `<span class="tag ${w.status === "released" ? "q" : ""}">out</span><span>SELEN → Robinhood · ${esc(w.status === "confirming" ? `${Math.min(w.confirmations, w.need)} / ${w.need} confirmations` : label[w.status] || w.status)} · <a class="ac" href="/tx/${w.selenTx}">${short(w.selenTx, 8, 4)}</a>${w.rhTx ? ` → ${rh(w.rhTx)}` : ""}</span><span class="amt out">−${L.fmtAsset(w.amount, w.asset, 4)} <small>${esc(w.ticker)}</small></span>` })),
  ].sort((x, y) => y.t - x.t);
  $("#act").innerHTML = rows.length ? rows.map((r) => `<div class="h">${r.html}</div>`).join("") : `<p class="empty">Nothing bridged yet.</p>`;
}

// ---------- the two directions ----------
async function bridgeIn() {
  const msg = $("#gomsg"), t = tok();
  msg.className = "note";
  try {
    const amountSelen = L.parseAsset($("#amt").value || "0", t.asset);
    if (amountSelen <= 0n) throw new Error("Enter an amount.");
    const amount = amountSelen * BigInt(t.unit);
    if ((rhBal.get(t.token) ?? 0n) < amount) throw new Error(`Not enough ${t.symbol} on Robinhood Chain.`);
    $("#go").disabled = true;
    await ensureChain();
    const { dest } = await api("/api/bridge/register", { method: "POST", body: JSON.stringify({ address: S.W.quantum }) });
    S.W.dest = dest;
    if ((await allowance(t.token, S.evm, S.cfg.contract)) < amount) {
      msg.textContent = `approve ${t.symbol} in your wallet…`;
      await waitTx(await sendTx(t.token, SEL.approve + enc.addr(S.cfg.contract) + enc.uint(amount)));
    }
    msg.textContent = "confirm the lock in your wallet…";
    const h = await sendTx(S.cfg.contract, SEL.lock + enc.addr(t.token) + enc.uint(amount) + enc.b32(dest));
    msg.textContent = "locking on Robinhood Chain…";
    await waitTx(h);
    msg.className = "note ok";
    msg.innerHTML = `Locked. ${units(amount, t.decimals, 6)} ${esc(t.symbol)} is on its way to your SELEN wallet: it shows under Activity and arrives after the next blocks.`;
    $("#amt").value = "";
    refresh();
  } catch (e) { msg.className = "note err"; msg.textContent = e.message || String(e); }
  finally { $("#go").disabled = false; }
}

async function bridgeOut() {
  const msg = $("#gomsg"), t = tok();
  msg.className = "note";
  try {
    const amount = L.parseAsset($("#amt").value || "0", t.asset);
    if (amount <= 0n) throw new Error("Enter an amount.");
    const s = selenSpendable(t.asset), picked = [];
    let sum = 0n;
    const room = L.minFee(40_000, t.asset);
    for (const o of s.list) { picked.push(o); sum += BigInt(o.v); if (sum >= amount + room || picked.length >= 16) break; }
    if (sum < amount) throw new Error(`Not enough spendable ${L.asset(t.asset).ticker} on SELEN (new coins need ${L.PARAMS.maturity} confirmations).`);
    $("#go").disabled = true;
    msg.textContent = "building rings and signing…";
    const memo = new Uint8Array(32);
    memo[0] = 1;
    memo.set(L.hexToBytes(S.evm.replace(/^0x/, "").toLowerCase()), 1);
    const b = await call({ type: "build", to: S.cfg.bridgeAddress, amount: amount.toString(), asset: t.asset, memo: L.bytesToHex(memo), inputs: picked.map((o) => ({ g: o.g, ai: o.ai ?? o.g })) });
    const r = await api("/api/tx", { method: "POST", body: JSON.stringify({ tx: b.tx }) });
    msg.className = "note ok";
    msg.innerHTML = `Sent to the bridge in <a class="ac" href="/tx/${r.id}">${short(r.id, 10, 6)}</a>. After ${S.cfg.selenConfirmations} confirmations it is released to ${esc(short(S.evm, 8, 6))} on Robinhood Chain; follow it under Activity.`;
    $("#amt").value = "";
    refresh();
  } catch (e) { msg.className = "note err"; msg.textContent = e.message || String(e); }
  finally { $("#go").disabled = false; }
}

document.addEventListener("visibilitychange", () => { if (!document.hidden && S.W) refresh(); });
boot();
