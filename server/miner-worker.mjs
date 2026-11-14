// One CPU mining thread. Receives { job, blob(hex), target(hex), start, duty } and searches nonces.
import { parentPort } from "node:worker_threads";
import { powHash } from "./pow.mjs";

let job = null, running = false, hashes = 0;
parentPort.on("message", (m) => {
  if (m.type === "job") { job = { ...m, buf: Buffer.from(m.blob, "hex"), target: BigInt("0x" + m.target), nonce: m.start }; if (!running) loop(); }
  if (m.type === "stop") job = null;
});
setInterval(() => { parentPort.postMessage({ type: "rate", hashes }); hashes = 0; }, 5000).unref();

async function loop() {
  running = true;
  while (job) {
    const j = job, t0 = performance.now();
    for (let k = 0; k < 32 && job === j; k++) {
      const n = j.nonce++;
      j.buf.writeBigUInt64LE(BigInt(n), j.buf.length - 8);
      const h = powHash(j.buf);
      hashes++;
      if (BigInt("0x" + Buffer.from(h).toString("hex")) <= j.target) {
        parentPort.postMessage({ type: "found", job: j.job, nonce: n });
        job = null;
        break;
      }
    }
    const spent = performance.now() - t0;
    const duty = j.duty ?? 1;
    await new Promise((r) => setTimeout(r, duty >= 1 ? 0 : spent * (1 / duty - 1)));
  }
  running = false;
}
