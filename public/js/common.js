// Shared chrome for every SELEN page: glass pill nav, footer card, CA chip, helpers.
const S = (window.SITE ||= {});
export const API = "";

// ---------- helpers ----------
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export async function api(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
  return j;
}
export const COIN = 100000000n;
export function coin(atomic, digits = 4) {
  const v = BigInt(atomic ?? 0);
  const whole = v / COIN;
  const frac = (v % COIN).toString().padStart(8, "0").slice(0, digits).replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}
export const num = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
export const short = (h, a = 8, b = 6) => (h && h.length > a + b + 1 ? `${h.slice(0, a)}…${h.slice(-b)}` : h || "");
export function ago(t) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function hashrate(h) {
  if (h == null) return "—";
  if (h >= 1e6) return (h / 1e6).toFixed(2) + " MH/s";
  if (h >= 1e3) return (h / 1e3).toFixed(2) + " kH/s";
  return h.toFixed(0) + " H/s";
}
let toastT;
export function toast(msg) {
  let t = $(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.append(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), 2400);
}
export async function copy(text, what = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(what); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand("copy"); toast(what); } catch { toast("Copy failed"); }
    ta.remove();
  }
}

// ---------- icons (drawn for SELEN; no emoji) ----------
export const ICON = {
  arrow: '<svg class="arr" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8h10M9 4l4 4-4 4"/></svg>',
  out: '<svg class="arr" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 11l6-6M6 5h5v5"/></svg>',
  copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="5" width="8" height="8" rx="2"/><path d="M3 11V4a1 1 0 0 1 1-1h7"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 1.2h3.7l-8 9.2 9.4 12.4h-7.4l-5.8-7.6-6.6 7.6H.5l8.6-9.8L.1 1.2h7.6l5.2 6.9 6-6.9Zm-1.3 19.4h2L6.5 3.3H4.3l13.3 17.3Z"/></svg>',
  gh: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 .2a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.4 7.4 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.8-3.6 4 .3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 .2Z"/></svg>',
};

// ---------- the S mark (logo A: chrome S with a dotted lattice face) ----------
export function MARK(size = 24) {
  const src = size > 64 ? "/img/mark-512.webp" : "/img/mark.webp";
  return `<img class="mk-img" src="${src}" width="${size}" height="${size}" alt="" draggable="false">`;
}
let badgeN = 0;
export function BADGE(size, text = "SEALED AFTER Q-DAY · SEALED AFTER Q-DAY · ") {
  const id = `bdg${++badgeN}`;
  return `<span class="badge" style="width:${size}px;height:${size}px"><svg class="spin" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"><defs><path id="${id}" d="M50 50m-40 0a40 40 0 1 1 80 0a40 40 0 1 1-80 0"/></defs><text font-family="Geist Mono,monospace" font-size="7.6" letter-spacing="1.5" fill="currentColor"><textPath href="#${id}">${esc(text)}</textPath></text></svg><span class="mk">${MARK(Math.round(size * 0.36))}</span></span>`;
}
export const markSvg = () => MARK(24);

// ---------- CA chip (full address, copyable) ----------
export function caChip() {
  const ca = S.ca || "", t = esc(S.ticker || "SELEN");
  return ca
    ? `<span class="ca" data-copy="${esc(ca)}" title="Copy the $${t} contract address (${esc(S.chain || "Robinhood Chain")})"><span class="cap">$${t}</span><code>${esc(ca)}</code></span>`
    : `<span class="ca" title="The token contract is published at launch"><span class="cap">$${t}</span><code>Contract announced at launch</code></span>`;
}

const NAV = [["/explorer", "Explorer"], ["/wallet", "Wallet"], ["/mine", "Mine"], ["/docs", "Docs"], ["/whitepaper", "Whitepaper"]];

function header() {
  const here = location.pathname.replace(/\/$/, "") || "/";
  const on = (p) => (here === p || (p === "/explorer" && /^\/(block|tx)\//.test(here)) ? "on" : "");
  const el = document.querySelector("header.top");
  if (!el) return;
  el.innerHTML = `
    <a class="logo" href="/" aria-label="SELEN home">${MARK(26)}<span>selen</span></a>
    <nav id="nav">${NAV.map(([h, t]) => `<a href="${h}" class="${on(h)}">${t}</a>`).join("")}</nav>
    ${S.github ? `<a class="pbtn xbtn" href="${esc(S.github)}" target="_blank" rel="noopener" aria-label="SELEN source on GitHub">${ICON.gh}</a>` : ""}
    ${S.x ? `<a class="pbtn xbtn" href="${esc(S.x)}" target="_blank" rel="noopener" aria-label="SELEN on X">${ICON.x}</a>` : ""}
    <a class="pbtn go" href="/wallet">Open wallet</a>
    <button class="pbtn burger" aria-label="Menu" aria-controls="nav">Menu</button>`;
  el.querySelector(".burger").onclick = () => el.classList.toggle("open");
}

function footer() {
  const el = document.querySelector("footer.foot");
  if (!el) return;
  const soon = (t) => `<a class="soon" aria-disabled="true">${t} · soon</a>`;
  el.innerHTML = `<div class="card">
    <div class="f-top">
      <div class="f-brand">
        <a class="logo" href="/" style="font-size:30px">${MARK(40)}<span>selen</span></a>
        <p class="f-tag">A private proof-of-work chain. Receivers and amounts sealed with lattices from the first block.</p>
        <div class="fca">${caChip()}</div>
      </div>
      <div class="cols">
        <div><h5>Network</h5><a href="/explorer">Explorer</a><a href="/wallet">Wallet</a><a href="/wallet#faucet">Faucet</a><a href="/mine">Mine</a></div>
        <div><h5>Learn</h5><a href="/docs">Documentation</a><a href="/whitepaper">Whitepaper</a><a href="/#lifecycle">How a payment works</a></div>
        <div><h5>Project</h5><a href="/#roadmap">Roadmap</a><a href="/#faq">FAQ</a><a href="/docs#api">Node API</a></div>
        <div><h5>Elsewhere</h5>${S.x ? `<a href="${esc(S.x)}" target="_blank" rel="noopener">X</a>` : soon("X")}${S.github ? `<a href="${esc(S.github)}" target="_blank" rel="noopener">GitHub</a>` : soon("GitHub")}</div>
      </div>
    </div>
    <div class="f-bot"><span>SELEN is a public testnet. tSELEN has no value. $SELEN is the ${esc(S.chain || "Robinhood Chain")} token that carries the project to mainnet.</span><span>Open source · BSD-3-Clause</span></div>
  </div>`;
}

function reveal() {
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.15 });
  $$(".rv").forEach((el) => io.observe(el));
}

document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-copy]");
  if (c) { e.preventDefault(); copy(c.dataset.copy, "Contract address copied"); }
});
addEventListener("scroll", () => document.body.classList.toggle("scrolled", scrollY > 30), { passive: true });

header();
footer();
reveal();

// ---------- live chain feed (SSE with polling fallback) ----------
const subs = new Set();
let lastStats = null, es = null;
export function onChain(fn) {
  subs.add(fn);
  if (lastStats) fn({ type: "stats", stats: lastStats });
  if (!es) startFeed();
  return () => subs.delete(fn);
}
function emit(ev) { if (ev.stats) lastStats = ev.stats; subs.forEach((f) => f(ev)); }
function startFeed() {
  try {
    es = new EventSource("/api/events");
    es.addEventListener("hello", (m) => emit({ type: "stats", stats: JSON.parse(m.data) }));
    es.addEventListener("block", (m) => emit(JSON.parse(m.data)));
    es.addEventListener("rollback", (m) => emit(JSON.parse(m.data)));
    es.addEventListener("mempool", (m) => emit(JSON.parse(m.data)));
  } catch {}
  setInterval(async () => {
    if (es && es.readyState === 1) return;
    try { const st = await api("/api/status"); emit({ type: "stats", stats: st }); } catch {}
  }, 15000);
}
