// Deploy SelenBridge to Robinhood Chain and map its tokens. Dry run by default: prints the plan, balances and cost.
//   node tools/deploy-bridge.mjs                         plan only (creates the deployer/operator keys if missing)
//   node tools/deploy-bridge.mjs --go                    deploy + map USDG
//   node tools/deploy-bridge.mjs --go --selen 0xCA…      … and map $SELEN too (or later: --map-selen 0xCA… --bridge 0x…)
// Keys live in ~/.config/selen (chmod 600): deployer.key (contract owner) and bridge-operator.key (releases; copy it
// to the server). Writes config/bridge-<chainId>.json with the address and start block for the node.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";

const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const RPC = opt("rpc", "https://robinhood-rpc.publicnode.com");
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
// launch limits (raise later with setToken): USDG cap and daily release limit, $SELEN cap = 1 billion
const LIMITS = {
  usdg: { cap: BigInt(opt("usdg-cap", "50000")) * 10n ** 6n, daily: BigInt(opt("usdg-daily", "10000")) * 10n ** 6n },
  selen: { cap: BigInt(opt("selen-cap", "1000000000")) * 10n ** 18n, daily: BigInt(opt("selen-daily", "50000000")) * 10n ** 18n },
};
const CFG = join(homedir(), ".config", "selen");
mkdirSync(CFG, { recursive: true, mode: 0o700 });
function key(name) {
  const f = join(CFG, name);
  if (!existsSync(f)) { writeFileSync(f, ethers.Wallet.createRandom().privateKey + "\n", { mode: 0o600 }); chmodSync(f, 0o600); }
  return readFileSync(f, "utf8").trim();
}

const provider = new ethers.JsonRpcProvider(RPC);
const net = await provider.getNetwork();
const deployer = new ethers.Wallet(key("deployer.key"), provider);
const operator = new ethers.Wallet(key("bridge-operator.key"));
const art = JSON.parse(readFileSync(new URL("../contracts/out/SelenBridge.sol/SelenBridge.json", import.meta.url), "utf8"));
const gasPrice = (await provider.getFeeData()).gasPrice;
const [bal, opBal] = await Promise.all([provider.getBalance(deployer.address), provider.getBalance(operator.address)]);
const initCode = art.bytecode.object + ethers.AbiCoder.defaultAbiCoder().encode(["address"], [operator.address]).slice(2);
const estDeploy = await provider.estimateGas({ from: deployer.address, data: initCode });
const need = (estDeploy + 2n * 130_000n) * gasPrice;
console.log(`chain ${net.chainId} · gas price ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
console.log(`deployer (owner)  ${deployer.address}  balance ${ethers.formatEther(bal)} ETH  · needs ≈ ${ethers.formatEther(need)} ETH (+ margin)`);
console.log(`operator          ${operator.address}  balance ${ethers.formatEther(opBal)} ETH  · each release ≈ ${ethers.formatEther(95_000n * gasPrice)} ETH`);
console.log(`limits: USDG cap ${ethers.formatUnits(LIMITS.usdg.cap, 6)} / day ${ethers.formatUnits(LIMITS.usdg.daily, 6)} · SELEN cap ${ethers.formatUnits(LIMITS.selen.cap, 18)} / day ${ethers.formatUnits(LIMITS.selen.daily, 18)}`);

const selenCa = opt("selen") || opt("map-selen");
async function mapSelen(bridge) {
  const t = new ethers.Contract(selenCa, ["function decimals() view returns (uint8)", "function symbol() view returns (string)"], provider);
  const dec = Number(await t.decimals());
  if (dec < 8) throw new Error(`$SELEN has ${dec} decimals, need at least 8`);
  const unit = 10n ** BigInt(dec - 8);
  await (await bridge.setToken(selenCa, true, 0, unit, LIMITS.selen.cap, LIMITS.selen.daily)).wait();
  console.log(`✓ mapped ${await t.symbol()} ${selenCa} → asset 0 (unit ${unit})`);
}

if (!flag("go")) { console.log("\nplan only. Fund the deployer, then run again with --go."); process.exit(0); }
if (bal < need) throw new Error("deployer balance too low");
const out = new URL(`../config/bridge-${net.chainId}.json`, import.meta.url);
if (opt("map-selen")) {
  const saved = JSON.parse(readFileSync(out, "utf8"));
  await mapSelen(new ethers.Contract(opt("bridge", saved.contract), art.abi, deployer));
  saved.tokens = [...new Set([...saved.tokens, ethers.getAddress(selenCa)])];
  writeFileSync(out, JSON.stringify(saved, null, 1) + "\n");
  process.exit(0);
}
const factory = new ethers.ContractFactory(art.abi, art.bytecode.object, deployer);
const bridge = await factory.deploy(operator.address);
const rc = await bridge.deploymentTransaction().wait();
const addr = await bridge.getAddress();
console.log(`✓ SelenBridge ${addr} (block ${rc.blockNumber}, tx ${rc.hash})`);
await (await bridge.setToken(USDG, true, 1, 1, LIMITS.usdg.cap, LIMITS.usdg.daily)).wait();
console.log("✓ mapped USDG → asset 1");
const tokens = [USDG];
if (opt("selen")) { await mapSelen(bridge); tokens.push(ethers.getAddress(selenCa)); }
writeFileSync(out, JSON.stringify({ chainId: Number(net.chainId), contract: addr, startBlock: rc.blockNumber, owner: deployer.address, operator: operator.address, tokens }, null, 1) + "\n");
console.log(`✓ ${out.pathname}`);
