// Browser mining thread: Argon2id over the block header, nonce in the last 8 bytes.
import { argon2id } from "/vendor/argon2.js";
let job = null, hashes = 0, running = false;
const fromHex = (h) => { const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out; };
onmessage = (e) => {
  const m = e.data;
  if (m.type === "job") {
    job = { ...m, buf: fromHex(m.blob), target: BigInt("0x" + m.target), nonce: m.start, salt: new TextEncoder().encode(m.argon.salt) };
    if (!running) loop();
  }
  if (m.type === "stop") job = null;
};
setInterval(() => { postMessage({ type: "rate", hashes }); hashes = 0; }, 1000);
function setNonce(buf, n) {
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) { buf[buf.length - 8 + i] = Number(v & 0xffn); v >>= 8n; }
}
// argon2id resolves on microtasks only, so without an explicit macrotask break the loop would
// starve this worker's event queue: no rate reports and, worse, no fresh jobs after a new block.
const breathe = () => new Promise((r) => setTimeout(r, 0));
async function loop() {
  running = true;
  let last = performance.now();
  while (job) {
    if (performance.now() - last > 150) { await breathe(); last = performance.now(); if (!job) break; }
    const j = job;
    const n = j.nonce++;
    setNonce(j.buf, n);
    const h = await argon2id({ password: j.buf, salt: j.salt, parallelism: j.argon.parallelism, iterations: j.argon.passes, memorySize: j.argon.memory, hashLength: 32, outputType: "binary" });
    hashes++;
    let v = 0n;
    for (const b of h) v = (v << 8n) | BigInt(b);
    if (v <= j.target && job === j) { postMessage({ type: "found", job: j.job, nonce: n }); job = null; }
  }
  running = false;
}
