import { $, $$, api, onChain, num, hashrate, MARK, caChip, esc } from "/js/common.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => { const x = clamp((v - a) / (b - a)); return x * x * (3 - 2 * x); };
// the nav logo stays hidden on the landing until the hero S flies up into it (see dock())
document.body.classList.add("dock");
$("#close-ca").outerHTML = caChip();

function watch(el, fn, margin = "120px") {
  const io = new IntersectionObserver(([e]) => fn(e.isIntersecting), { rootMargin: margin });
  io.observe(el);
}

// ---------- the seal: quantum rain breaks on a lattice dome; every real block sends a wave over it ----------
function shield(canvas, pillEl) {
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, cx = 0, base = 0, R = 0, pts = [], links = [], drops = [], sparks = [], waves = [], vis = false, raf = 0, last = 0, acc = 0, t = 0;
  const TILT = 0.17, SQ = Math.cos(TILT);
  function build() {
    const dpr = Math.min(2, devicePixelRatio);
    W = canvas.clientWidth; H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = pillEl.offsetLeft + pillEl.offsetWidth / 2;
    base = pillEl.offsetTop + pillEl.offsetHeight * 0.56;
    R = Math.max(160, Math.min(W * (W < 640 ? 0.5 : 0.37), base - H * 0.2));
    // a half sphere of lattice points: rings of latitude, each staggered by half a step, linked to neighbours
    pts = []; links = [];
    const rings = W < 640 ? 9 : 13, per = W < 640 ? 26 : 44, start = [];
    for (let j = 0; j < rings; j++) {
      const lat = (j / rings) * (Math.PI / 2), n = Math.max(3, Math.round(per * Math.cos(lat)));
      start.push(pts.length);
      for (let k = 0; k < n; k++) pts.push({ lat, lon: ((k + (j % 2) * 0.5) / n) * Math.PI * 2, j, n, x: 0, y: 0, z: 0, g: 0 });
    }
    start.push(pts.length);
    pts.push({ lat: Math.PI / 2, lon: 0, j: rings, n: 1, x: 0, y: 0, z: 0, g: 0 });
    for (let j = 0; j < rings; j++) {
      const s = start[j], n = pts[s].n, ns = start[j + 1], nn = pts[ns].n;
      for (let k = 0; k < n; k++) {
        links.push([s + k, s + ((k + 1) % n)]);
        const f = ((k + (j % 2) * 0.5) / n) * nn - ((j + 1) % 2) * 0.5;
        links.push([s + k, ns + ((Math.floor(f) % nn) + nn) % nn]);
        if (nn > 1) links.push([s + k, ns + ((Math.ceil(f) % nn) + nn) % nn]);
      }
    }
    if (!raf) raf = requestAnimationFrame(frame);
  }
  const inside = (x, y) => y <= base && ((x - cx) / R) ** 2 + ((base - y) / (R * SQ)) ** 2 <= 1;
  function drop() {
    const x0 = cx + (Math.random() * 2 - 1) * R * 1.55;
    drops.push({ x: x0, y: -40 - Math.random() * 60, vx: (cx - x0) * 0.1 + (Math.random() - 0.5) * 60, vy: 560 + Math.random() * 260, len: 24 + Math.random() * 46, teal: Math.random() < 0.22 });
  }
  function hit(x, y, vx, vy) {
    waves.push({ x, y, age: 0, life: 1.0, speed: 210, band: 26, big: false });
    const nx = (x - cx) / R, ny = (y - base) / R, nl = Math.hypot(nx, ny) || 1, ux = nx / nl, uy = ny / nl, dot = vx * ux + vy * uy;
    for (let i = 0; i < 7; i++) {
      const rx = (vx - 2 * dot * ux) * 0.32 + (Math.random() - 0.5) * 160, ry = (vy - 2 * dot * uy) * 0.32 + (Math.random() - 0.5) * 160;
      sparks.push({ x, y, vx: rx, vy: ry, age: 0, life: 0.35 + Math.random() * 0.35 });
    }
  }
  function pulse() {
    waves.push({ x: cx, y: base - R * SQ, age: 0, life: 2.4, speed: R * 0.75, band: 44, big: true });
    pillEl.classList.add("hit");
    setTimeout(() => pillEl.classList.remove("hit"), 900);
  }
  function frame(now) {
    raf = 0;
    if (!vis || !W) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now; t += dt;
    if (!reduced) { acc += dt * (W < 640 ? 9 : 20); while (acc > 1) { acc -= 1; drop(); } }
    ctx.clearRect(0, 0, W, H);
    // inner light of the shield and its floor
    const gl = ctx.createRadialGradient(cx, base, 0, cx, base, R * 1.05);
    gl.addColorStop(0, "rgba(118,185,0,.16)"); gl.addColorStop(0.55, "rgba(118,185,0,.05)"); gl.addColorStop(1, "rgba(118,185,0,0)");
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.ellipse(cx, base, R, R * SQ, 0, Math.PI, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(cx, base); ctx.scale(1, 0.2); ctx.translate(-cx, -base);
    ctx.beginPath(); ctx.ellipse(cx, base, R * 1.05, R * 1.05, 0, 0, Math.PI); ctx.fill();
    ctx.restore();
    // project the lattice; it turns slowly
    const th = t * 0.05;
    for (const p of pts) {
      const cl = Math.cos(p.lat), a = p.lon + th;
      p.z = cl * Math.cos(a);
      p.x = cx + R * cl * Math.sin(a);
      p.y = base - R * Math.sin(p.lat) * SQ + R * p.z * Math.sin(TILT);
      p.g = 0;
    }
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i]; w.age += dt;
      if (w.age > w.life) { waves.splice(i, 1); continue; }
      const r = w.age * w.speed, fade = 1 - w.age / w.life;
      for (const p of pts) {
        const d = Math.abs(Math.hypot(p.x - w.x, p.y - w.y) - r);
        if (d < w.band) p.g = Math.max(p.g, (1 - d / w.band) * fade * (w.big ? 1 : 0.9));
      }
      if (!w.big && w.age < 0.45) { // a hexagon flash where it struck
        const k = w.age / 0.45, rr = 4 + k * 20;
        ctx.strokeStyle = `rgba(197,240,60,${(1 - k) * 0.9})`; ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let s = 0; s <= 6; s++) { const an = (s / 6) * Math.PI * 2 + Math.PI / 6; s ? ctx.lineTo(w.x + Math.cos(an) * rr, w.y + Math.sin(an) * rr) : ctx.moveTo(w.x + Math.cos(an) * rr, w.y + Math.sin(an) * rr); }
        ctx.stroke();
      }
    }
    // links: the far side faint, the near side brighter, struck cells lit green
    ctx.lineWidth = 0.7;
    for (const front of [false, true]) {
      ctx.strokeStyle = front ? "rgba(228,236,217,.13)" : "rgba(228,236,217,.045)";
      ctx.beginPath();
      for (const [a, b] of links) { const pa = pts[a], pb = pts[b]; if ((pa.z + pb.z > 0) !== front) continue; ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); }
      ctx.stroke();
    }
    ctx.lineWidth = 1.1;
    for (const [a, b] of links) {
      const pa = pts[a], pb = pts[b], g = Math.min(pa.g, pb.g);
      if (g < 0.04) continue;
      ctx.strokeStyle = `rgba(173,232,60,${g * (pa.z + pb.z > 0 ? 0.85 : 0.35)})`;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }
    for (const p of pts) {
      const dep = 0.2 + 0.5 * (p.z + 1) * 0.5;
      if (p.g > 0.04) { ctx.fillStyle = `rgba(214,255,120,${Math.min(1, dep + p.g)})`; const s = 1.6 + p.g * 2.4; ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s); }
      else { ctx.fillStyle = `rgba(228,236,217,${dep * 0.55})`; ctx.fillRect(p.x - 0.8, p.y - 0.8, 1.6, 1.6); }
    }
    // the rim of the dome
    ctx.strokeStyle = "rgba(228,236,217,.12)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(cx, base, R, R * SQ, 0, Math.PI, Math.PI * 2); ctx.stroke();
    // rain: bright heads, fading tails; it stops at the shield
    ctx.lineCap = "round";
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.x += d.vx * dt; d.y += d.vy * dt;
      if (inside(d.x, d.y)) { hit(d.x, d.y, d.vx, d.vy); drops.splice(i, 1); continue; }
      if (d.y > base + 60 || d.y > H) { drops.splice(i, 1); continue; }
      const sp = Math.hypot(d.vx, d.vy), tx = d.x - (d.vx / sp) * d.len, ty = d.y - (d.vy / sp) * d.len;
      const gr = ctx.createLinearGradient(tx, ty, d.x, d.y), c = d.teal ? "95,232,194" : "236,244,226";
      gr.addColorStop(0, `rgba(${c},0)`); gr.addColorStop(1, `rgba(${c},.9)`);
      ctx.strokeStyle = gr; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(d.x, d.y); ctx.stroke();
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]; s.age += dt;
      if (s.age > s.life) { sparks.splice(i, 1); continue; }
      s.vx *= 0.92; s.vy = s.vy * 0.92 + 30 * dt;
      const k = 1 - s.age / s.life;
      ctx.strokeStyle = `rgba(214,255,120,${k * 0.9})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); s.x += s.vx * dt; s.y += s.vy * dt; ctx.lineTo(s.x, s.y); ctx.stroke();
    }
    if (!reduced) raf = requestAnimationFrame(frame);
  }
  build();
  addEventListener("resize", build);
  watch(canvas, (v) => { vis = v; if (v) { setTimeout(() => pillEl.classList.add("on"), 350); if (!raf) { last = 0; raf = requestAnimationFrame(frame); } } });
  return { pulse };
}
const pill = $("#seal-pill");
const seal = shield($("#shield"), pill);

// ---------- why: words light up as they are read ----------
const wordPs = $$("[data-words]");
wordPs.forEach((p) => { p.innerHTML = p.textContent.trim().split(/\s+/).map((w) => `<span class="w">${esc(w)}</span>`).join(" "); });
function wordsScroll() {
  const vh = innerHeight;
  for (const p of wordPs) {
    const r = p.getBoundingClientRect();
    if (r.bottom < -vh || r.top > vh * 2) continue;
    const ws = p.children, k = reduced ? 1 : clamp((vh * 0.86 - r.top) / (r.height + vh * 0.32));
    const n = Math.round(k * ws.length);
    for (let i = 0; i < ws.length; i++) ws[i].classList.toggle("on", i < n);
  }
}

// ---------- lifecycle chamber: scroll position drives the steps and the 3D scene ----------
const chamber = $("#chamber"), steps = $$(".cs");
let lifeP = 0;
function chamberScroll() {
  const r = chamber.getBoundingClientRect(), span = r.height - innerHeight;
  lifeP = clamp(-r.top / Math.max(1, span));
  const i = Math.min(2, Math.floor(lifeP * 3));
  steps.forEach((s, k) => { s.classList.toggle("on", k === i); s.style.setProperty("--p", clamp(lifeP * 3 - k).toFixed(3)); });
}

// ---------- node: two cryptexes. The miner keeps guessing; each real block locks it onto that block's
// hash, the hash crosses the beam, and the node rolls to the same combination and verifies it ----------
const HEX = "0123456789abcdef", STEP = 22.5;
function cryptex(root) {
  const host = $(".vx-rings", root), read = $(".vx-read em", root), code = $(".vx-read code", root);
  host.innerHTML = Array.from({ length: 8 }, () => `<span class="vx-ring"><span class="vx-drum">${[...HEX].map((c, i) => `<b style="--i:${i}">${c}</b>`).join("")}</span></span>`).join("");
  const drums = $$(".vx-drum", host).map((el, i) => ({ el, rot: -Math.floor(Math.random() * 16) * STEP, vel: 0, speed: 300 + ((i * 7) % 5) * 85, anim: null }));
  let spinning = false, fast = 1;
  const face = (d) => HEX[((Math.round(-d.rot / STEP) % 16) + 16) % 16];
  // roll every drum to the given hex digits: left to right, each at least one more full turn,
  // starting from its current speed so nothing jumps
  function roll(hex, slow = 1) {
    spinning = false;
    return Promise.all(drums.map((d, i) => new Promise((res) => {
      const tgt = -HEX.indexOf(hex[i]) * STEP, v0 = d.vel, dur = (0.95 + i * 0.16) * slow;
      let end = tgt;
      while (end < d.rot + Math.max(360, v0 * dur * 0.6)) end += 360;
      d.anim = { from: d.rot, to: end, v0, dur, t: 0, res };
    })));
  }
  function spin() { spinning = true; drums.forEach((d) => (d.anim = null)); }
  function step(dt) {
    for (const d of drums) {
      if (d.anim) {
        const a = d.anim;
        a.t += dt;
        const s = Math.min(1, a.t / a.dur), h10 = s * s * s - 2 * s * s + s, h01 = -2 * s * s * s + 3 * s * s;
        d.rot = a.from + a.v0 * a.dur * h10 + (a.to - a.from) * h01;
        d.vel = a.v0 * (3 * s * s - 4 * s + 1) + ((a.to - a.from) / a.dur) * (6 * s - 6 * s * s);
        if (s >= 1) { d.rot = a.to; d.vel = 0; d.anim = null; a.res(); }
      } else if (spinning) {
        d.vel += (d.speed * fast - d.vel) * (1 - Math.exp(-dt / 0.5));
        d.rot += d.vel * dt;
      }
      d.el.style.setProperty("--rot", `${d.rot.toFixed(2)}deg`);
    }
    if (spinning) code.textContent = drums.map(face).join("");
  }
  return {
    roll, spin, step, drums,
    set fast(v) { fast = v; },
    state(cls, text, hex) {
      for (const c of ["spin", "hit", "ok"]) root.classList.toggle(c, c === cls);
      read.textContent = text;
      if (hex) code.textContent = hex.slice(0, 8);
    },
  };
}
const miner = cryptex($("#vx-miner")), nodeX = cryptex($("#vx-node")), beam = $(".vx-beam");
miner.state("spin", "guessing · argon2id");
miner.spin();
let vaultSeen = false, vaultBusy = false, vaultNext = null, vaultRaf = 0, vaultLast = 0, vaultVis = false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function vaultBlock(st) {
  if (!st?.tip) return;
  if (vaultBusy) { vaultNext = st; return; }
  vaultBusy = true;
  const hex = st.tip.slice(0, 8), h = num(st.height);
  await miner.roll(hex);
  miner.state("hit", `block ${h} found`, hex);
  beam.classList.toggle("go", false); void beam.offsetWidth; beam.classList.toggle("go", true);
  await wait(820);
  nodeX.state("", "checking ring · proof · key image");
  await nodeX.roll(hex, 0.8);
  nodeX.state("ok", `verified · block ${h}`, hex);
  await wait(2600);
  miner.state("spin", "guessing · argon2id");
  miner.spin();
  vaultBusy = false;
  if (vaultNext) { const n = vaultNext; vaultNext = null; vaultBlock(n); }
}
// the node rests on the latest real block, no animation
function nodeShow(st) {
  const hex = st.tip.slice(0, 8);
  nodeX.drums.forEach((d, i) => { d.rot = -HEX.indexOf(hex[i]) * STEP; d.vel = 0; d.anim = null; d.el.style.setProperty("--rot", `${d.rot}deg`); });
  nodeX.state("ok", `verified · block ${num(st.height)}`, hex);
}
function vaultFrame(now) {
  vaultRaf = 0;
  if (!vaultVis) return;
  const dt = vaultLast ? Math.min(0.05, (now - vaultLast) / 1000) : 0.016;
  vaultLast = now;
  miner.step(dt);
  nodeX.step(dt);
  vaultRaf = requestAnimationFrame(vaultFrame);
}
watch($("#vault"), (v) => {
  vaultVis = v;
  if (v && !vaultRaf) { vaultLast = 0; vaultRaf = requestAnimationFrame(vaultFrame); }
  // first look: replay the latest real block so the story plays once without waiting for the next one
  if (v && !vaultSeen && lastStats) { vaultSeen = true; setTimeout(() => vaultBlock(lastStats), 900); }
}, "0px");
const mineBtn = $("#mine-btn");
mineBtn.addEventListener("pointerenter", () => (miner.fast = 2.4));
mineBtn.addEventListener("pointerleave", () => (miner.fast = 1));

// ---------- seven locks on a drifting, draggable rail of lenses ----------
const G = {
  ring: `<svg viewBox="0 0 58 58">${Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2; return `<circle cx="${(29 + Math.cos(a) * 23).toFixed(1)}" cy="${(29 + Math.sin(a) * 23).toFixed(1)}" r="2.2" class="${i === 11 ? "h" : ""}"/>`; }).join("")}<circle cx="29" cy="29" r="8"/></svg>`,
  kem: `<svg viewBox="0 0 58 58"><rect x="6" y="12" width="46" height="34" rx="6"/>${Array.from({ length: 18 }, (_, i) => `<rect x="${12 + (i % 6) * 6}" y="${18 + Math.floor(i / 6) * 7}" width="3" height="3" class="${i === 8 ? "h" : ""}"/>`).join("")}</svg>`,
  key: `<svg viewBox="0 0 58 58"><circle cx="20" cy="29" r="10" class="h"/><path d="M30 29 H52 M44 29 V37 M50 29 V35"/><circle cx="20" cy="29" r="3"/></svg>`,
  commit: `<svg viewBox="0 0 58 58"><path d="M20 10 C8 14 8 44 20 48"/><path d="M38 10 C50 14 50 44 38 48"/>${[0, 1, 2, 3, 4].map((i) => `<path d="M${22 + i * 3.5} ${38 - ((i * 7) % 5) * 4} V40" class="${i === 2 ? "h" : ""}"/>`).join("")}</svg>`,
  image: `<svg viewBox="0 0 58 58"><circle cx="29" cy="29" r="20"/><circle cx="29" cy="29" r="12" class="h"/><path d="M29 5 V53" stroke-dasharray="2 3"/></svg>`,
  argon: `<svg viewBox="0 0 58 58">${[0, 1, 2, 3].map((i) => `<rect x="${8 + i * 3}" y="${10 + i * 9}" width="${42 - i * 6}" height="7" rx="2" class="${i === 3 ? "h" : ""}"/>`).join("")}</svg>`,
  tree: `<svg viewBox="0 0 58 58"><circle cx="29" cy="10" r="4" class="h"/><path d="M29 14 L15 28 M29 14 L43 28 M15 32 L8 46 M15 32 L22 46 M43 32 L36 46 M43 32 L50 46"/>${[[15, 30], [43, 30], [8, 48], [22, 48], [36, 48], [50, 48]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3"/>`).join("")}</svg>`,
};
const LOCKS = [
  ["ring", "sender", "Ring of 16", "The real input signs among fifteen decoys. MLSAG proves one is yours and never says which."],
  ["kem", "receiver", "ML-KEM-768", "selenq1 addresses carry a lattice key. Only the receiver can decapsulate the payment secret."],
  ["key", "receiver", "One-time keys", "Every output sits on a key derived for that payment alone. Two payments share nothing visible."],
  ["commit", "amount", "Commitments + range proofs", "Values are Pedersen commitments. 48-bit proofs rule out negative or wrapped amounts."],
  ["image", "double spend", "Key images", "An output always yields the same key image, so a second spend is refused on sight."],
  ["argon", "consensus", "Argon2id work", "Memory-hard proof of work and no block signer, so there is no key to steal or coerce."],
  ["tree", "next · perigee", "Hash-based spends", "Spend proofs move off elliptic curves and hide each spend among every output."],
];
const lensHTML = LOCKS.map(([g, c, t, p]) => `<div class="lens">${G[g]}<span class="cap">${esc(c)}</span><h4>${esc(t)}</h4><p>${esc(p)}</p></div>`).join("")
  + `<div class="lens zero"><b>0</b><span class="cap">trusted setups</span><p>No secret anyone had to destroy. Every proof checks against public math.</p></div>`;
const rail = $("#lens-rail"), track = $("#lens-track");
track.innerHTML = lensHTML + lensHTML + lensHTML;
let lensX = 0, lensV = 0, lensVis = false, dragging = false, dragX = 0, lensLast = 0, half = 0, lensRaf = 0;
const lenses = () => track.children;
function lensMeasure() { half = track.scrollWidth / 3; }
function lensFrame(now) {
  lensRaf = 0;
  if (!lensVis) return;
  const dt = Math.min(0.05, (now - (lensLast || now)) / 1000); lensLast = now;
  if (!dragging) { lensV += ((reduced ? 0 : -34) - lensV) * Math.min(1, dt * 2.2); lensX += lensV * dt; }
  if (half) { while (lensX <= -half) lensX += half; while (lensX > 0) lensX -= half; }
  track.style.transform = `translate3d(${lensX.toFixed(1)}px,0,0)`;
  const rr = rail.getBoundingClientRect(), cx = rr.left + rr.width / 2, reach = Math.max(300, rr.width * 0.42);
  for (const el of lenses()) {
    const b = el.getBoundingClientRect();
    if (b.right < rr.left - 50 || b.left > rr.right + 50) continue;
    const k = Math.max(0, 1 - Math.abs(b.left + b.width / 2 - cx) / reach) ** 1.4;
    el.style.setProperty("--k", k.toFixed(3));
  }
  lensRaf = requestAnimationFrame(lensFrame);
}
rail.addEventListener("pointerdown", (e) => { dragging = true; dragX = e.clientX; lensV = 0; rail.classList.add("drag"); rail.setPointerCapture(e.pointerId); });
rail.addEventListener("pointermove", (e) => { if (!dragging) return; const d = e.clientX - dragX; dragX = e.clientX; lensX += d; lensV = d * 60; });
const endDrag = () => { dragging = false; rail.classList.remove("drag"); };
rail.addEventListener("pointerup", endDrag); rail.addEventListener("pointercancel", endDrag);
lensMeasure(); addEventListener("resize", lensMeasure);
watch(rail, (v) => { lensVis = v; if (v && !lensRaf) { lensLast = 0; lensRaf = requestAnimationFrame(lensFrame); } });

// ---------- live numbers ----------
const shown = {};
function countTo(el, key, to, fmt) {
  const from = shown[key] ?? 0; shown[key] = to;
  if (reduced || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = from ? 700 : 1400;
  (function step(now) { const k = clamp((now - t0) / dur), e = 1 - (1 - k) ** 3; el.textContent = fmt(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); })(t0);
}
let liveSeen = false, lastStats = null;
function paint(st) {
  lastStats = st;
  const set = (k, v) => $$(`[data-stat="${k}"]`).forEach((el) => (el.textContent = v));
  set("height", num(st.height));
  set("transfers", num(st.transfers));
  set("keyImages", num(st.keyImages));
  set("difficulty", num(st.difficulty));
  set("hashrate", hashrate(st.hashrate));
  $("#net-hr").textContent = hashrate(st.hashrate);
  $("#live-status").textContent = `live · block ${num(st.height)}`;
  $("#live-tip").textContent = st.tip ? `tip ${st.tip.slice(0, 16)}…` : "";
  $("#seal-live").textContent = `block ${num(st.height)} sealed · ${hashrate(st.hashrate)}`;
  if (!vaultBusy && st.tip) {
    if (!vaultVis) nodeShow(st);
    else if (!vaultSeen) { vaultSeen = true; setTimeout(() => vaultBlock(st), 900); }
  }
  if (!liveSeen) return;
  const int = (v) => num(Math.round(v));
  countTo($('[data-count="height"]'), "height", st.height || 0, int);
  countTo($('[data-count="avg"]'), "avg", st.avgBlockTime || 0, (v) => (v ? `${v.toFixed(1)} s` : "—"));
  countTo($('[data-count="outputs"]'), "outputs", st.outputs || 0, int);
  countTo($('[data-count="quantum"]'), "quantum", st.quantumOutputs || 0, int);
}
watch($(".meter"), (v) => { if (v && !liveSeen) { liveSeen = true; if (lastStats) paint(lastStats); pulseGrow(); } }, "0px");

// pulse: seconds between recent blocks as lines of light, the 30 s target dashed across
const pc = $("#pulse"), pctx = pc.getContext("2d"), tip = $("#pulse-tip");
let dts = [], growT0 = 0, pW = 0, pH = 0, pRaf = 0, pVis = false;
function pSize() { const d = Math.min(2, devicePixelRatio); pW = pc.clientWidth; pH = pc.clientHeight; pc.width = pW * d; pc.height = pH * d; pctx.setTransform(d, 0, 0, d, 0, 0); }
function pGeom() {
  const pad = 26, bw = (pW - pad * 2) / Math.max(1, dts.length), max = Math.max(90, ...dts.map((d) => Math.min(d.dt, 180)));
  const base = pH - 22, top = 26, y = (v) => base - (Math.min(v, max) / max) * (base - top);
  return { pad, bw, y, base };
}
function pDraw(now) {
  pRaf = 0;
  if (!pW) pSize();
  pctx.clearRect(0, 0, pW, pH);
  if (!dts.length) return;
  const { pad, bw, y, base } = pGeom(), g = growT0 ? clamp((now - growT0) / 1500) : 0;
  pctx.strokeStyle = "rgba(228,236,217,.08)"; pctx.lineWidth = 1;
  pctx.beginPath(); pctx.moveTo(pad, base + 0.5); pctx.lineTo(pW - pad, base + 0.5); pctx.stroke();
  const lw = Math.max(1.4, Math.min(5, bw * 0.46));
  pctx.lineCap = "round";
  dts.forEach((d, i) => {
    const k = smooth(i / dts.length * 0.6, i / dts.length * 0.6 + 0.4, g);
    if (k <= 0) return;
    const x = pad + i * bw + bw / 2, yt = base - (base - y(d.dt)) * k, ok = d.dt <= 45;
    pctx.strokeStyle = ok ? "rgba(118,185,0,.12)" : "rgba(228,236,217,.05)"; pctx.lineWidth = lw * 3.2;
    pctx.beginPath(); pctx.moveTo(x, base); pctx.lineTo(x, yt); pctx.stroke();
    const gr = pctx.createLinearGradient(0, yt, 0, base);
    if (ok) { gr.addColorStop(0, "#d6ff66"); gr.addColorStop(0.35, "#76b900"); gr.addColorStop(1, "rgba(118,185,0,.08)"); }
    else { gr.addColorStop(0, "rgba(242,247,236,.85)"); gr.addColorStop(1, "rgba(242,247,236,.04)"); }
    pctx.strokeStyle = gr; pctx.lineWidth = lw;
    pctx.beginPath(); pctx.moveTo(x, base); pctx.lineTo(x, yt); pctx.stroke();
  });
  const ty = y(30);
  pctx.setLineDash([4, 5]); pctx.strokeStyle = "rgba(197,240,60,.55)"; pctx.lineWidth = 1;
  pctx.beginPath(); pctx.moveTo(pad, ty); pctx.lineTo(pW - pad, ty); pctx.stroke(); pctx.setLineDash([]);
  // the newest block breathes
  const lx = pad + (dts.length - 0.5) * bw, ly = base - (base - y(dts[dts.length - 1].dt)) * g, pulse = 0.5 + 0.5 * Math.sin(now / 380);
  const rg = pctx.createRadialGradient(lx, ly, 0, lx, ly, 18 + pulse * 10);
  rg.addColorStop(0, "rgba(214,255,102,.9)"); rg.addColorStop(1, "rgba(214,255,102,0)");
  pctx.fillStyle = rg; pctx.beginPath(); pctx.arc(lx, ly, 30, 0, Math.PI * 2); pctx.fill();
  if (pVis && !reduced) pRaf = requestAnimationFrame(pDraw);
}
function pKick() { if (!pRaf) pRaf = requestAnimationFrame(pDraw); }
function pulseGrow() { growT0 = performance.now(); pKick(); }
watch(pc, (v) => { pVis = v; if (v) pKick(); });
addEventListener("resize", () => { pSize(); pKick(); });
$("#pulse-box").addEventListener("pointermove", (e) => {
  if (!dts.length) return;
  const r = pc.getBoundingClientRect(), { pad, bw } = pGeom(), i = clamp(Math.floor((e.clientX - r.left - pad) / bw), 0, dts.length - 1);
  tip.textContent = `#${num(dts[i].h)} · ${dts[i].dt} s`;
  tip.style.left = `${pad + i * bw + bw / 2}px`;
  tip.classList.add("on");
});
$("#pulse-box").addEventListener("pointerleave", () => tip.classList.remove("on"));
async function chart() {
  try {
    const bs = (await api("/api/chart")).blocks.filter((b) => b.h >= 1);
    if (bs.length < 3) return;
    dts = bs.slice(1).map((b, i) => ({ h: b.h, dt: Math.max(1, b.t - bs[i].t) })).slice(-120);
    $("#px-from").textContent = `#${num(dts[0].h)}`;
    $("#px-to").textContent = `#${num(dts[dts.length - 1].h)}`;
    pKick();
  } catch {}
}

// ---------- roadmap rail fills when seen ----------
// the lit part ends on the last running phase
function railFill() {
  const railEl = $("#rail"), line = $(".rail-line", railEl), dots = $$(".rp-dot", railEl), lit = $$(".rp", railEl).map((r) => r.classList.contains("live") || r.classList.contains("now")).lastIndexOf(true);
  if (lit < 0) return;
  const lr = line.getBoundingClientRect(), dr = dots[lit].getBoundingClientRect();
  railEl.style.setProperty("--fill", `${Math.max(0, dr.left + dr.width / 2 - lr.left)}px`);
  railEl.style.setProperty("--fill-v", `${Math.max(0, dr.top + dr.height / 2 - lr.top)}px`);
}
railFill(); addEventListener("resize", railFill);
new IntersectionObserver(([e], o) => { if (e.isIntersecting) { railFill(); $("#rail").classList.add("in"); o.disconnect(); } }, { threshold: 0.4 }).observe($("#rail"));

// ---------- scroll ----------
const hfoot = $(".hfoot"), cue = $(".cue"), ring = $("#pc"), pt = $("#pt");
let sp = 0, dockF = 0;
// the first ~70% of a screen of scroll carries the S from the hero into the nav slot; the slot opens
// late, the flat logo takes over in the last tenth and the wordmark slides in beside it
const root = document.documentElement, topBar = $("header.top");
function dock() {
  dockF = clamp(sp / 0.72);
  const dk = smooth(0.5, 0.86, dockF);
  root.style.setProperty("--dk", dk.toFixed(4));
  root.style.setProperty("--di", smooth(0.9, 1, dockF).toFixed(4));
  root.style.setProperty("--dt", smooth(0.84, 1, dockF).toFixed(4));
  topBar?.classList.toggle("docked", dk >= 1);
}
function onScroll() {
  const vh = innerHeight, max = document.documentElement.scrollHeight - vh, pr = max > 0 ? scrollY / max : 0;
  ring.style.strokeDashoffset = 157.1 * (1 - pr);
  pt.textContent = Math.round(pr * 100) + "%";
  sp = Math.min(1, scrollY / vh);
  const fade = Math.max(0, 1 - sp * 1.7);
  for (const el of [hfoot, cue]) el.style.opacity = fade;
  hfoot.style.pointerEvents = fade < 0.3 ? "none" : "";
  dock();
  wordsScroll();
  chamberScroll();
}
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll);
onScroll();

// ---------- boot ----------
chart();
api("/api/status").then(paint).catch(() => { $("#live-status").textContent = "node unreachable"; $("#seal-live").textContent = "node unreachable"; });
onChain((ev) => {
  if (ev.type === "block" && ev.stats) { seal.pulse(); if (vaultVis) vaultBlock(ev.stats); }
  if (ev.stats) paint(ev.stats);
  if (ev.type === "block" || ev.type === "rollback") chart();
});

// ---------- 3D: chrome S over liquid metal (hero) and the S over a pedestal in the bright chamber ----------
function fallback(canvas, cls) { const d = document.createElement("div"); d.className = cls; d.innerHTML = MARK(512); canvas.replaceWith(d); }
Promise.all([import("/vendor/three.js"), import("/js/smark.js")]).then(([THREE, { kit }]) => {
  const probe = document.createElement("canvas");
  if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) throw new Error("no webgl");
  const K = kit(THREE);
  const mouse = { x: 0, y: 0 };
  addEventListener("pointermove", (e) => { mouse.x = e.clientX / innerWidth - 0.5; mouse.y = e.clientY / innerHeight - 0.5; }, { passive: true });
  function stage(canvas, fov, env = K.studio) {
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    r.setPixelRatio(Math.min(2, devicePixelRatio));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.12;
    const scene = new THREE.Scene();
    scene.environment = env(r);
    const cam = new THREE.PerspectiveCamera(fov, 1, 0.1, 100);
    const fit = () => { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); };
    fit();
    addEventListener("resize", fit);
    let vis = true;
    new IntersectionObserver((e) => (vis = e[0].isIntersecting)).observe(canvas);
    return { r, scene, cam, fit, get vis() { return vis; } };
  }

  // hero: the liquid pool. The S floats on its own layer above the whole page so it can fly into the nav
  const A = stage($("#gl"), 32, () => null);
  A.cam.position.set(0, 0, 13);
  const pool = K.liquid(A.r);
  pool.mesh.position.z = -4;
  pool.sync();
  A.scene.add(pool.mesh);
  const D = stage($("#gl-dock"), 32);
  D.cam.position.set(0, 0, 13);
  const s1 = K.mark();
  D.scene.add(s1);
  // the hero vignette used to sit over the S: repeat it on this layer (it only darkens where the S is
  // drawn, alpha untouched) and let it go as the S leaves the hero
  const vig = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { uK: { value: 1 } }, transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    vertexShader: "varying vec2 vU; void main(){ vU = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `uniform float uK; varying vec2 vU;
      void main(){
        float y = 1.0 - vU.y;
        float d = length(vec2((vU.x - 0.5) / 0.7, (y - 0.44) / 0.62));
        float a1 = 0.72 * clamp((d - 0.45) / 0.55, 0.0, 1.0);
        float a2 = y < 0.22 ? 0.55 * (1.0 - y / 0.22) : (y > 0.62 ? 0.92 * (y - 0.62) / 0.38 : 0.0);
        float a = (1.0 - (1.0 - a1) * (1.0 - a2)) * uK;
        gl_FragColor = vec4(vec3(4.0, 5.0, 3.0) / 255.0 * a, a);
      }`,
  }));
  vig.frustumCulled = false;
  vig.renderOrder = 10;
  D.scene.add(vig);
  // the flat nav logo is this S rendered at scale 1.32, angle (0.1, -0.38), fov 26 from z 13 (/_render/mark.js)
  const LOGO = { s: 1.32, rx: 0.1, ry: -0.38, frame: 2 * 13 * Math.tan((13 * Math.PI) / 180) };
  const qRot = new THREE.Quaternion(), qFace = new THREE.Quaternion(), qPart = new THREE.Quaternion(), eul = new THREE.Euler(), zAx = new THREE.Vector3(0, 0, 1), toCam = new THREE.Vector3();
  const lerp = (a, b, k) => a + (b - a) * k;
  // rotary: scrolling spins the S (2.5 turns over the flight, either way), it coasts a moment after the
  // scroll stops and settles facing front; it always lands facing front
  const TAU = Math.PI * 2, SPIN_PER_F = TAU * 2.5;
  let spin = 0, spinV = 0, fPrev = dockF, lastMove = -1, tPrev = 0;

  // chamber: the chrome S over a pedestal, glass bubbles orbiting it. 01 they fly in on two crossing
  // orbits (the capsule), 02 the orbits merge into one ring of sixteen and the real one turns green,
  // 03 the ring folds into the block, the real one stays lit and the rim glows
  const L = stage($("#gl2"), 30);
  const world = new THREE.Group();
  L.scene.add(world);
  const bright = K.lightStudio(L.r);
  const TOP = -1.3;
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(2.05, 2.05, 9, 160, 1), new THREE.MeshPhysicalMaterial({ color: 0xf8fbf4, roughness: 0.38, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.25, envMap: bright, envMapIntensity: 1.3 }));
  ped.position.y = TOP - 4.5;
  world.add(ped);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.022, 12, 240), new THREE.MeshBasicMaterial({ color: 0x8ad400, transparent: true, opacity: 0 }));
  rim.rotation.x = Math.PI / 2; rim.position.y = TOP + 0.004;
  world.add(rim);
  const wave = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 160), new THREE.MeshBasicMaterial({ color: 0x8ad400, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
  wave.rotation.x = -Math.PI / 2; wave.position.y = TOP + 0.012;
  world.add(wave);
  const shc = document.createElement("canvas"); shc.width = shc.height = 128;
  const sg = shc.getContext("2d"), sgr = sg.createRadialGradient(64, 64, 0, 64, 64, 64);
  sgr.addColorStop(0, "rgba(14,22,6,.6)"); sgr.addColorStop(0.5, "rgba(14,22,6,.2)"); sgr.addColorStop(1, "rgba(14,22,6,0)");
  sg.fillStyle = sgr; sg.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = TOP + 0.008;
  world.add(shadow);
  const s2 = K.mark();
  s2.scale.setScalar(0.66);
  world.add(s2);
  // glass: bright core, a dark refraction band, a green-to-teal rim and one hard highlight
  const glass = (a = 1) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { uA: { value: a }, uCore: { value: new THREE.Color(1, 1, 1) } },
    vertexShader: "varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }",
    fragmentShader: `uniform float uA; uniform vec3 uCore; varying vec3 vN; varying vec3 vV;
      void main(){
        vec3 n = normalize(vN); float f = 1.0 - abs(dot(n, normalize(vV)));
        vec3 rimC = mix(vec3(0.46, 0.73, 0.0), vec3(0.12, 0.78, 0.62), smoothstep(0.75, 1.0, f));
        vec3 col = mix(uCore, rimC, smoothstep(0.35, 0.9, f));
        float band = smoothstep(0.5, 0.62, f) * (1.0 - smoothstep(0.68, 0.8, f));
        col = mix(col, vec3(0.16, 0.22, 0.12), band * 0.55);
        float spec = pow(max(dot(n, normalize(vec3(-0.35, 0.85, 0.45))), 0.0), 36.0);
        col += spec;
        gl_FragColor = vec4(col, (0.14 + 0.82 * pow(f, 1.7) + band * 0.25 + spec * 0.9) * uA);
      }`,
  });
  // what floats inside the bubbles: SELEN's own privacy layers, drawn here (no outside logos)
  const ICONS = ["key", "lock", "ring", "shield", "eye", "lattice", "hash", "coin"];
  function iconTex(kind, real) {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d"), disc = g.createRadialGradient(128, 128, 0, 128, 128, 122);
    if (real) { disc.addColorStop(0, "rgba(176,236,52,1)"); disc.addColorStop(0.68, "rgba(118,185,0,.96)"); disc.addColorStop(1, "rgba(118,185,0,0)"); }
    else { disc.addColorStop(0, "rgba(255,255,255,.96)"); disc.addColorStop(0.64, "rgba(250,253,246,.8)"); disc.addColorStop(1, "rgba(255,255,255,0)"); }
    g.fillStyle = disc;
    g.beginPath(); g.arc(128, 128, 122, 0, Math.PI * 2); g.fill();
    g.strokeStyle = g.fillStyle = real ? "#ffffff" : "#2e5600";
    g.lineWidth = 13; g.lineCap = "round"; g.lineJoin = "round";
    g.translate(128, 128);
    const dot = (x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
    if (kind === "key") { g.beginPath(); g.arc(-32, 0, 25, 0, Math.PI * 2); g.moveTo(-7, 0); g.lineTo(58, 0); g.moveTo(38, 0); g.lineTo(38, 24); g.moveTo(56, 0); g.lineTo(56, 18); g.stroke(); }
    else if (kind === "lock") { g.beginPath(); g.moveTo(-28, 0); g.lineTo(-28, -20); g.arc(0, -20, 28, Math.PI, 0); g.lineTo(28, 0); g.stroke(); g.beginPath(); g.roundRect(-46, 0, 92, 62, 12); g.stroke(); dot(0, 25, 8); g.fillRect(-4, 25, 8, 18); }
    else if (kind === "ring") { for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; dot(Math.cos(a) * 54, Math.sin(a) * 54, i === 2 ? 12 : 7.5); } g.beginPath(); g.arc(0, 0, 15, 0, Math.PI * 2); g.stroke(); }
    else if (kind === "shield") { g.beginPath(); g.moveTo(0, -62); g.lineTo(50, -42); g.lineTo(46, 8); g.quadraticCurveTo(38, 46, 0, 64); g.quadraticCurveTo(-38, 46, -46, 8); g.lineTo(-50, -42); g.closePath(); g.stroke(); g.beginPath(); g.moveTo(-20, 2); g.lineTo(-4, 18); g.lineTo(24, -14); g.stroke(); }
    else if (kind === "eye") { g.beginPath(); g.moveTo(-62, 0); g.quadraticCurveTo(0, -56, 62, 0); g.quadraticCurveTo(0, 56, -62, 0); g.stroke(); dot(0, 0, 16); g.beginPath(); g.moveTo(-48, -48); g.lineTo(48, 48); g.stroke(); }
    else if (kind === "lattice") { g.lineWidth = 6; g.beginPath(); for (let i = -1; i <= 1; i++) { g.moveTo(-42, i * 42); g.lineTo(42, i * 42); g.moveTo(i * 42, -42); g.lineTo(i * 42, 42); } g.moveTo(-42, -42); g.lineTo(42, 42); g.moveTo(0, -42); g.lineTo(42, 0); g.moveTo(-42, 0); g.lineTo(0, 42); g.stroke(); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) dot(i * 42, j * 42, 10); }
    else if (kind === "hash") { g.beginPath(); g.moveTo(-16, -58); g.lineTo(-30, 58); g.moveTo(28, -58); g.lineTo(14, 58); g.moveTo(-54, -20); g.lineTo(58, -20); g.moveTo(-60, 22); g.lineTo(52, 22); g.stroke(); }
    else { g.beginPath(); g.arc(0, 0, 60, 0, Math.PI * 2); g.stroke(); g.font = "700 82px Outfit, system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("S", 0, 6); }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }
  const beads = new THREE.Group();
  beads.rotation.x = 0.28;
  world.add(beads);
  const orbA = new THREE.Group(), orbB = new THREE.Group();
  beads.add(orbA, orbB);
  let introT = 0;
  const bubbleGeo = new THREE.SphereGeometry(0.3, 48, 32), beadGlass = glass(), realGlass = glass(), texs = {};
  const sprite = (map) => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, toneMapped: false })); sp.scale.setScalar(0.42); sp.renderOrder = 1; return sp; };
  const bubbles = Array.from({ length: 16 }, (_, i) => {
    const real = i === 11, g = new THREE.Group(), kind = ICONS[i % 8];
    const icon = sprite(texs[kind] || (texs[kind] = iconTex(kind, false)));
    const shell = new THREE.Mesh(bubbleGeo, real ? realGlass : beadGlass);
    shell.renderOrder = 2;
    g.add(icon, shell);
    const lit = real ? sprite(iconTex("coin", true)) : null;
    if (lit) g.add(lit);
    (i % 2 ? orbB : orbA).add(g);
    return { g, icon, lit, real };
  });

  // close: a horizon of liquid metal with the S hovering above where the ripples start
  const C = stage($("#gl3"), 34);
  C.cam.position.set(0, 1.2, 10);
  C.cam.lookAt(0, 1.05, -6);
  C.scene.fog = new THREE.Fog(0x040503, 14, 36);
  const sea = K.liquid(C.r, { w: 70, h: 50, segX: 320, segY: 240, k: 1.9, env: K.horizon(C.r) });
  sea.mat.envMapIntensity = 0.9;
  sea.mat.color.set(0xaab3a3);
  sea.mesh.rotation.x = -Math.PI / 2;
  sea.mesh.position.set(0, -0.6, -8);
  sea.sync();
  sea.u.uC.value.set(0, 0);
  C.scene.add(sea.mesh);
  const s3 = K.mark();
  s3.scale.setScalar(0.42);
  s3.position.set(0, 3.05, -8);
  C.scene.add(s3);

  const t0 = performance.now();
  (function loop(now) {
    const t = (now - t0) / 1000;
    const dt = Math.min(0.05, t - tPrev);
    tPrev = t;
    if (dt > 0) {
      const df = dockF - fPrev;
      fPrev = dockF;
      if (df !== 0) lastMove = t;
      spinV += ((df / dt) * SPIN_PER_F - spinV) * (1 - Math.exp(-dt / 0.22));
      spin += spinV * dt;
      if (t - lastMove > 0.18) spin += (Math.round(spin / TAU) * TAU - spin) * (1 - Math.exp(-dt / 0.3));
      if (dockF >= 1) spin = spinV = 0;
    }
    if (dockF < 1) {
      // home: floating over the pool, leaning toward the pointer. nav: the logo slot, at the logo's size and angle
      const f = dockF, H = innerHeight, W = innerWidth, upp = (2 * 13 * Math.tan((D.cam.fov * Math.PI) / 360)) / H;
      const fitK = Math.min(1, (7.45 * D.cam.aspect * 0.5) / 3.2);
      const r = $("header.top .logo .mk-img")?.getBoundingClientRect();
      const nx = r ? (r.left + r.width / 2 - W / 2) * upp : -3, ny = r ? (H / 2 - (r.top + r.height / 2)) * upp : 3.4;
      const ns = r ? (LOGO.s * r.height * upp) / LOGO.frame : 0.05;
      const g = clamp(f / 0.9), ey = smooth(0, 0.92, g), ex = smooth(0.06, 1, g), er = smooth(0, 1, g); // lands at 0.9, then the flat logo fades in over it
      const x = lerp(0, nx, ex), y = lerp(Math.sin(t * 0.8) * 0.12 + 0.2, ny, ey);
      s1.position.set(x, y, 0);
      s1.scale.setScalar(fitK * Math.pow(ns / fitK, er));
      // the spin, pulled onto the nearest front face just before it lands; then the logo's angle, and near
      // the corner the camera sees it from the side, so turn it to face the camera like the logo render
      const spun = spin + (Math.round(spin / TAU) * TAU - spin) * smooth(0.74, 0.9, f);
      eul.set(lerp(0.12 + mouse.y * 0.25 + Math.sin(t * 0.5) * 0.05, LOGO.rx, er), lerp(-0.5 + mouse.x * 0.5 + Math.sin(t * 0.35) * 0.24, LOGO.ry, er) + spun, lerp(Math.sin(t * 0.4) * 0.03, 0, er));
      qRot.setFromEuler(eul);
      qFace.setFromUnitVectors(zAx, toCam.set(-x, -y, 13).normalize());
      s1.quaternion.multiplyQuaternions(qPart.identity().slerp(qFace, er), qRot);
      vig.material.uniforms.uK.value = 1 - smooth(0, 0.3, f);
      D.r.render(D.scene, D.cam);
    }
    if (A.vis && sp < 1) {
      pool.u.uTime.value = t;
      pool.u.uC.value.set(s1.position.x * (17 / 13), s1.position.y * (17 / 13));
      pool.u.uAmp.value = 0.9 + 0.12 * Math.sin(t * 0.8);
      A.r.render(A.scene, A.cam);
    }
    if (L.vis) {
      const p = lifeP, e1 = smooth(0.0, 0.26, p), e2 = smooth(0.36, 0.6, p), e3 = smooth(0.7, 0.94, p);
      const wide = L.cam.aspect > 1.15, dist = wide ? 12 : 15.5;
      const vh = 2 * dist * Math.tan((L.cam.fov * Math.PI) / 360), vw = vh * L.cam.aspect;
      world.position.set(wide ? Math.min(vw * 0.21, 3.8) : 0, wide ? -0.15 : -vh * 0.27, 0);
      s2.scale.setScalar(wide ? 0.66 : 0.56);
      L.cam.position.set(mouse.x * 0.7, 1.1 - mouse.y * 0.35, dist);
      L.cam.lookAt(0, 0.05, 0);
      const sy = 1.0 + Math.sin(t * 0.9) * 0.08 - e3 * 0.3;
      s2.position.y = sy;
      s2.rotation.set(0.07, -0.5 + Math.sin(p * Math.PI * 2) * 0.6 + Math.sin(t * 0.45) * 0.16 + mouse.x * 0.3, 0);
      beads.position.y = sy;
      beads.scale.setScalar(wide ? 1 : 0.62);
      orbA.rotation.z = 0.62 * (1 - e2);
      orbB.rotation.z = -0.62 * (1 - e2);
      introT += 1 / 60;
      bubbles.forEach(({ g, icon, lit, real }, i) => {
        const a = (i / 16) * Math.PI * 2 + t * 0.3;
        const k = Math.max(smooth(i * 0.05, i * 0.05 + 0.9, introT), smooth(i * 0.035, i * 0.035 + 0.45, e1)) * (real ? 1 : 1 - e3);
        const R = (2.55 + (1 - k) * 2.2) * (real ? 1 - e3 * 0.06 : 1 - e3 * 0.85);
        g.position.set(Math.cos(a) * R, real ? e3 * 0.9 : 0, Math.sin(a) * R);
        g.scale.setScalar(Math.max(0.001, k * (real ? 1 + e2 * 0.2 + e3 * 0.45 + 0.05 * Math.sin(t * 4) : 1)));
        if (lit) { lit.material.opacity = e2; icon.material.opacity = 1 - e2; }
      });
      realGlass.uniforms.uCore.value.setRGB(1 - e2 * 0.35, 1, 1 - e2 * 0.7);
      rim.material.opacity = e3;
      const ph = (t * 0.6) % 1;
      wave.scale.setScalar(0.3 + ph * 1.9);
      wave.material.opacity = e3 * (1 - ph) * 0.8;
      shadow.material.opacity = 0.75 + e3 * 0.25;
      shadow.scale.setScalar(1 - e3 * 0.12);
      L.r.render(L.scene, L.cam);
    }
    if (C.vis) {
      sea.u.uTime.value = t;
      const narrow = C.cam.aspect < 0.85;
      s3.scale.setScalar(narrow ? 0.3 : 0.42);
      s3.rotation.set(0.08, -0.3 + Math.sin(t * 0.45) * 0.75, 0);
      s3.position.y = (narrow ? 4.1 : 3.05) + Math.sin(t * 0.9) * 0.1;
      C.r.render(C.scene, C.cam);
    }
    requestAnimationFrame(loop);
  })(t0);
}).catch((e) => {
  console.warn("3d", e);
  if ($("#gl")) fallback($("#gl"), "gl-fallback");
  document.body.classList.remove("dock");
  $("#gl-dock")?.remove();
  $(".ch-pin")?.classList.add("no3d");
  $("#gl2")?.remove();
  $("#gl3")?.remove();
});
