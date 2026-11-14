// End-to-end: fresh keys → faucet → mined → scanned → send back half to a classic address.
import { keysFromSeed, randomBytes, decodeAddress, hexToBytes } from "../lib/crypto.mjs";
import { scanBatch } from "../lib/client.mjs";
import { buildTx, txToJson } from "../lib/tx.mjs";
import { pickRing } from "../lib/ring.mjs";
const BASE = process.env.BASE || "http://127.0.0.1:9310";
const j = async (p, o) => { const r = await fetch(BASE + p, o); const b = await r.json(); if (!r.ok) throw new Error(p + " " + JSON.stringify(b)); return b; };
const post = (p, body) => j(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const me = keysFromSeed(randomBytes(32)), friend = keysFromSeed(randomBytes(32));
const f = await post("/api/faucet", { address: me.quantum });
console.log("faucet tx", f.id, "fee", f.fee);
const waitFor = async (cond, label) => { for (let i = 0; i < 600; i++) { const r = await cond(); if (r) return r; await new Promise((r) => setTimeout(r, 2000)); } throw new Error("timeout " + label); };
const scan = async (keys) => { const all = []; let from = 0; for (;;) { const r = await j(`/api/outputs?from=${from}&limit=1000`); if (!r.outputs.length) break; all.push(...scanBatch(keys, r.outputs)); from = r.outputs.at(-1).g + 1; } return all; };
const mine = await waitFor(async () => { const t = await j(`/api/tx/${f.id}`); return t.inMempool ? null : t; }, "faucet confirm");
console.log("confirmed in block", mine.block.height);
const owned = await scan(me);
console.log("wallet found", owned.map((o) => `${o.g}:${o.v}`));
// wait for maturity
const st0 = await j("/api/status");
await waitFor(async () => (await j("/api/status")).eligibleOutputs > owned[0].g, "maturity");
const st = await j("/api/status");
const ringIds = pickRing(owned[0].g, st.eligibleOutputs);
const { members } = await j(`/api/ring?ids=${ringIds.join(",")}`);
const L = await import("../lib/crypto.mjs");
const out = (await j(`/api/outputs?from=${owned[0].g}&limit=1`)).outputs[0];
const { outFromApi } = await import("../lib/client.mjs");
const opened = L.scanOutput(me, outFromApi(out));
const inputs = [{ gidx: owned[0].g, v: opened.v, mask: opened.mask, x: opened.x, P: hexToBytes(out.P), C: hexToBytes(out.C), ring: members.map((m) => ({ gidx: m.g, P: hexToBytes(m.P), C: hexToBytes(m.C) })) }];
const { tx, fee } = buildTx({ inputs, dests: [{ addr: decodeAddress(friend.classic), v: opened.v / 2n }], change: decodeAddress(me.quantum) });
const sent = await post("/api/tx", { tx: txToJson(tx) });
console.log("sent", sent.id, "fee", fee.toString());
// double-spend must fail
try { const again = buildTx({ inputs, dests: [{ addr: decodeAddress(friend.classic), v: 1000n }], change: decodeAddress(me.quantum) }); await post("/api/tx", { tx: txToJson(again.tx) }); console.log("DOUBLE SPEND ACCEPTED — BUG"); }
catch (e) { console.log("double spend rejected:", e.message.slice(0, 90)); }
await waitFor(async () => { const t = await j(`/api/tx/${sent.id}`); return t.inMempool ? null : t; }, "send confirm");
const got = await scan(friend);
console.log("friend received", got.map((o) => o.v), "classic outputs:", got.every((o) => !o.q));
