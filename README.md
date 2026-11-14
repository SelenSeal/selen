# SELEN

Private proof-of-work chain. Every transfer hides sender (ring of 16, MLSAG), receiver (one-time keys; ML-KEM-768 capsules on `selenq1` addresses) and amount (Pedersen commitments + 48-bit range proofs). Argon2id proof of work, no trusted setup, no block signers.

One Node.js program is the node, explorer, browser wallet, faucet and miner.

```
npm install
npm start                                  # http://127.0.0.1:9310 — own chain + built-in miner + faucet
PEER=https://selen.network npm start      # follow a public node, verify every block locally
node tools/miner.mjs --node <url> --address <selen address> --threads 4
```

| Path | What |
|---|---|
| `lib/crypto.mjs` | ristretto255, keys/addresses, one-time outputs, ML-KEM-768, MLSAG, range proofs |
| `lib/tx.mjs` | wire format, canonical encoding, build + verify transfers, block headers |
| `lib/chain.mjs` | SQLite chain state, consensus rules, LWMA difficulty, mempool, rollback |
| `lib/params.mjs` | network profiles (testnet, beta), assets, emission, amount formatting |
| `server/` | HTTP API, built-in miner, faucet wallet, peer sync |
| `public/` | site: landing, explorer, wallet, mine, docs, whitepaper |
| `tools/` | `build.mjs` (browser bundle), `genesis.mjs` (multi-asset reserve), `miner.mjs`, tests below |

## Networks

`NETWORK=testnet` (default) is the public testnet: one asset, tSELEN, v1 transactions.

`NETWORK=beta` adds bridged assets next to SELEN (today: USDG). Every output names its asset in the clear while its
amount and receiver stay sealed. A transfer moves one asset: its ring members, outputs and fee are all of that asset,
and decoys are drawn from that asset's own outputs. The coinbase pays one output per asset it collected fees in. The
reserves a bridge releases from sit in the genesis block with public amounts.

```
node tools/genesis.mjs beta --to faucet --selen 1000000 --usdg 1000000 --split 64   # writes config/genesis-beta.json
NETWORK=beta PORT=9311 npm start                                                     # keeps its chain in data-beta/
```

## Tests

`node --test test/*.test.mjs` (crypto, transfers, multi-asset rules) · `node tools/faucet-test.mjs` (end-to-end on a
running node) · `node tools/ui-test.mjs` and `node tools/send-ui-test.mjs` (real browser) ·
`node tools/beta-ui-test.mjs` (beta: faucet USDG, private USDG transfer, explorer verify) · `WORK=1 node tools/crawl.mjs`.

Environment: `NETWORK`, `PORT`, `DATA_DIR`, `PUBLIC=1` (hide `/_*` work pages), `TRUST_PROXY=1` (behind a proxy), `MINER=0`,
`MINER_THREADS`, `MINER_DUTY`, `MINER_ADDRESS`, `FAUCET=0`, `FAUCET_SEED_FILE` (default `~/.config/selen/faucet.seed`),
`PEER`.

Testnet. tSELEN has no value. Unaudited. BSD-3-Clause, see `LICENSE`.
