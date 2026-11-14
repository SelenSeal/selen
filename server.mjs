// SELEN — node + explorer + wallet + miner in one program.
//   npm start                → http://127.0.0.1:9310
//   PUBLIC=1                 → hides local work pages (/_ref, /_fonts, /_concepts, /_pilihan …)
//   MINER=0 | MINER_THREADS=2 | MINER_DUTY=0.5
//   PEER=https://selen.network   → follow a public node and verify everything locally
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, normalize, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Chain } from "./lib/chain.mjs";
import { powHash } from "./server/pow.mjs";
import { startMiner } from "./server/miner.mjs";
import { NodeWallet, loadSeed } from "./server/wallet.mjs";
import { createApi } from "./server/api.mjs";
import { startSync } from "./server/sync.mjs";
import { siteConfig } from "./server/config.mjs";
import { PARAMS, useNetwork } from "./lib/params.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "public");
const REF = join(HERE, "_ref");
const PORT = +(process.env.PORT || 9310);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = process.env.PUBLIC === "1";
const PEER = process.env.PEER || "";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// NETWORK=testnet (default, the public testnet) | beta (SELEN + USDG). Each network keeps its own data folder.
useNetwork(process.env.NETWORK || "testnet");
const genesisFile = join(HERE, "config", `genesis-${PARAMS.profile}.json`);
const genesis = PARAMS.multiAsset ? (existsSync(genesisFile) ? JSON.parse(readFileSync(genesisFile, "utf8")).txs : []) : [];
const chain = new Chain({ dataDir: process.env.DATA_DIR || join(HERE, PARAMS.profile === "testnet" ? "data" : `data-${PARAMS.profile}`), pow: powHash, log, genesis });
let faucet = null, miner = null, peer = null;
if (!PEER && process.env.FAUCET !== "0") {
  const seed = loadSeed(process.env.FAUCET_SEED_FILE || join(homedir(), ".config", "selen", "faucet.seed"));
  faucet = new NodeWallet(chain, seed, { log });
}
const minerOn = process.env.MINER ? process.env.MINER !== "0" : !PEER;
if (minerOn) {
  const address = process.env.MINER_ADDRESS || faucet?.address;
  if (address) miner = startMiner(chain, { address, threads: +(process.env.MINER_THREADS || 1), duty: +(process.env.MINER_DUTY || 1), log });
}
if (PEER) peer = startSync(chain, PEER, { log });
const api = createApi({ chain, miner, faucet, peer, trustProxy: process.env.TRUST_PROXY === "1", isPublic: PUBLIC, log });

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4", ".glb": "model/gltf-binary", ".ico": "image/x-icon", ".md": "text/plain; charset=utf-8", ".wasm": "application/wasm",
};
const ROUTES = {
  "/": "/index.html", "/explorer": "/explorer.html", "/wallet": "/wallet.html", "/mine": "/mine.html",
  "/docs": "/docs.html", "/whitepaper": "/whitepaper.html", "/faucet": "/wallet.html",
};

function csp(path, data) {
  if (!path.endsWith(".html")) return "frame-ancestors 'self'";
  const hashes = [...data.toString("utf8").matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  return [
    "default-src 'self'", `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}`.trim(), "worker-src 'self' blob:",
    "connect-src 'self' blob:", "img-src 'self' data: blob:", "style-src 'self' 'unsafe-inline'", "font-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'", PUBLIC ? "frame-ancestors 'none'" : "frame-ancestors 'self'",
  ].join("; ");
}
const headers = (type, path, data) => ({
  "content-type": type,
  "cache-control": /\.(html|js|mjs|css|json)$/.test(path) ? "no-cache" : "public, max-age=3600",
  "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin",
  ...(PUBLIC ? { "x-frame-options": "DENY" } : {}),
  "content-security-policy": csp(path, data),
});

async function notFound(req, res) {
  const page = await readFile(join(ROOT, "404.html")).catch(() => null);
  if (page) { res.writeHead(404, headers(TYPES[".html"], "/404.html", page)); res.end(req.method === "HEAD" ? undefined : page); }
  else res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
}
async function sendFile(req, res, file, path) {
  try {
    if (!(await stat(file)).isFile()) throw 0;
    const data = await readFile(file);
    res.writeHead(200, headers(TYPES[extname(file)] || "application/octet-stream", path, data));
    res.end(req.method === "HEAD" ? undefined : data);
  } catch { await notFound(req, res); }
}

async function serve(req, res) {
  const url = new URL(req.url, "http://x");
  if (await api(req, res, url)) return;
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end("Bad request"); return; }
  if (path === "/config.js") {
    const body = `window.SITE=${JSON.stringify(siteConfig(!PUBLIC))};`;
    res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    return res.end(req.method === "HEAD" ? undefined : body);
  }
  const isWork = path.split("/").some((seg) => seg.startsWith("_"));
  if (PUBLIC && isWork) return notFound(req, res);
  if (path === "/_ref" || path.startsWith("/_ref/")) {
    const rel = path.slice(5) || "/";
    if (rel === "/") return sendFile(req, res, join(REF, "index.html"), "/_ref/index.html");
    const file = normalize(join(REF, rel));
    if (!file.startsWith(REF + sep)) { res.writeHead(403).end(); return; }
    return sendFile(req, res, file, rel);
  }
  if (path.length > 1 && path.endsWith("/") && ROUTES[path.slice(0, -1)]) path = path.slice(0, -1);
  if (/^\/(block|tx)\/[0-9a-f]{1,64}$|^\/block\/\d+$/.test(path)) path = "/explorer.html";
  path = ROUTES[path] || path;
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
  return sendFile(req, res, file, path);
}

createServer((req, res) => {
  serve(req, res).catch((e) => {
    log("[serve]", e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal" }));
  });
}).listen(PORT, HOST, () => log(`SELEN node → http://${HOST}:${PORT}${PUBLIC ? " (public)" : ""} · height ${chain.tip().height}`));
