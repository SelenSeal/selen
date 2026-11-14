import { $, $$, api, esc, num, coin, short, hashrate, onChain, toast } from "/js/common.js";
import { isAddress } from "/vendor/selen.js";

const cores = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));
let threads = Math.max(1, Math.floor(cores / 2));
let workers = [], rates = [], job = null, mining = false, found = 0, accepted = 0, total = 0;
const saved = (() => { try { return localStorage.getItem("selen.mine.addr") || ""; } catch { return ""; } })();
$("#addr").value = saved;
if (saved) $("#addrnote").textContent = "Filled in from your wallet in this browser.";

$("#threads").innerHTML = Array.from({ length: cores }, (_, i) => `<button data-n="${i + 1}">${i + 1}</button>`).join("");
const paintThreads = () => $$("#threads button").forEach((b) => b.classList.toggle("on", +b.dataset.n === threads));
$$("#threads button").forEach((b) => (b.onclick = () => { threads = +b.dataset.n; paintThreads(); if (mining) { stop(); start(); } }));
paintThreads();
$("#cores").innerHTML = "<i></i>".repeat(cores);

const log = (html) => { const l = $("#log"); if (l.firstElementChild?.classList.contains("dim2")) l.innerHTML = ""; l.insertAdjacentHTML("afterbegin", `<div>${html}</div>`); };
function stats() {
  $("#mstats").innerHTML = [
    ["Job height", job ? num(job.height) : "—"], ["Difficulty", job ? num(job.diff) : "—"],
    ["Reward per block", job ? coin(job.reward, 4) + " tSELEN" : "—"], ["Hashes this session", num(total)],
    ["Blocks found", `${found} (${accepted} accepted)`],
  ].map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join("");
}
stats();

const addrValue = () => $("#addr").value.trim().replace(/\s+/g, "");
async function fetchJob() {
  job = await api(`/api/mining/job?address=${encodeURIComponent(addrValue())}`);
  workers.forEach((w, i) => w.postMessage({ type: "job", job: job.job, blob: job.blob, target: job.target, argon: job.argon, start: Math.floor(Math.random() * 2 ** 40) + i * 2 ** 44 }));
  stats();
}

function start() {
  const address = addrValue();
  if (!isAddress(address)) return toast("Paste a valid SELEN address first");
  try { localStorage.setItem("selen.mine.addr", address); } catch {}
  mining = true;
  $("#go").disabled = true; $("#stop").disabled = false;
  rates = new Array(threads).fill(0);
  workers = Array.from({ length: threads }, (_, i) => {
    const w = new Worker("/js/mine-worker.js", { type: "module" });
    w.onmessage = async (e) => {
      const m = e.data;
      if (m.type === "rate") { rates[i] = m.hashes; total += m.hashes; $("#rate").textContent = rates.reduce((a, b) => a + b, 0).toLocaleString(); stats(); }
      if (m.type === "found" && job && m.job === job.job) {
        found++;
        const j = job;
        try {
          const r = await api("/api/mining/submit", { method: "POST", body: JSON.stringify({ job: j.job, nonce: m.nonce }) });
          accepted++;
          log(`<b>block ${num(r.height)}</b> sealed · <a class="ac" href="/block/${r.id}">${short(r.id, 8, 6)}</a> · ${coin(j.reward, 2)} tSELEN to your address`);
        } catch (err) { log(`block rejected: ${esc(err.message)}`); }
        fetchJob().catch(() => {});
      }
    };
    return w;
  });
  $$("#cores i").forEach((c, k) => c.classList.toggle("run", k < threads));
  log(`started ${threads} thread${threads > 1 ? "s" : ""}`);
  fetchJob().catch((e) => { toast(e.message); stop(); });
}
function stop() {
  workers.forEach((w) => w.terminate());
  workers = []; mining = false;
  $("#go").disabled = false; $("#stop").disabled = true;
  $("#rate").textContent = "0";
  $$("#cores i").forEach((c) => c.classList.remove("run"));
  log("stopped");
}
$("#go").onclick = start;
$("#stop").onclick = stop;
setInterval(() => { if (mining) fetchJob().catch(() => {}); }, 20000);
onChain((ev) => {
  if (ev.stats) { $("#netpill").textContent = `block ${num(ev.stats.height)}`; $("#netinfo").textContent = `network ${hashrate(ev.stats.hashrate)}`; }
  if (ev.type === "block" && mining && job && ev.height >= job.height) fetchJob().catch(() => {});
});
