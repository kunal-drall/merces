# VERSIONS.md

Pinned versions and the external facts the code relies on. Every row names its source and the date checked
(2026-10-07 unless stated). Nothing here was invented; "unconfirmed" means the official page could not be reached
from the build environment and the fact must be re-verified before going live.

## Toolchain

| Package | Version | Why |
| --- | --- | --- |
| node | 22.x | runtime |
| pnpm | 10.28.0 | workspace |
| typescript | 5.9.3 | last 5.x line (7.x is the Go port; not adopted yet) |
| vitest | 4.1.11 | tests |
| tsx | 4.23.15 | run TypeScript directly |
| fastify | 5.12.5 | API gateway |
| zod | 4.6.5 | validation + JSON Schema generation (`z.toJSONSchema`) |
| pg | 8.23.1 | Postgres driver |
| pino | 10.4.0 | logging (with payload redaction) |
| openapi-typescript | 7.13.0 | typed client generation from `openapi.yaml` |
| viem | 2.57.3 | EVM adapter (`monadTestnet` chain id 10143 ships in `viem/chains`) |
| @solana/web3.js | 1.99.0 | Solana adapter skeleton (maintenance line; Anza recommends `@solana/kit` 8.x for new code — migrate when Stage 1's clients are generated with Codama) |
| @noble/hashes | 2.4.0 | sha256 |
| bs58 | 6.0.0 | Solana address checks |
| snarkjs | 0.7.6 | offchain Groth16 proving and verification, through Stage 1's `@merces/circuits` (`proveReport`, `verifyReport`; pinned by `stage1/circuits`) |
| Rust (rustc, cargo) | 1.97.1, Stage 1's pin (`stage1/solana/rust-toolchain.toml`, read at run time; checked 2026-10-10) | `stage1:sync`'s curve-port gate builds Stage 1's merces-common into `tools/stage1-oracle` with it (selected through rustup's `RUSTUP_TOOLCHAIN`); both CI workflows install it (`rustup toolchain install 1.97.1 --profile minimal`). Without cargo the gate, and so the sync, fails; another toolchain is reported (`warn`) |

## Stage 1 (imported, not rewritten)

| Item | Value | Why |
| --- | --- | --- |
| `stage1` submodule | `https://github.com/kunal-drall/merces` at `1bfc66b` (branch `claude/sweet-goodall-b7acm3`); tree `aa93160`, identical to `5eafd41` named in the handoff | SPEC v1.1.2, the 25 parity vectors, IDLs and ABIs |
| `@merces/reference` | 0.1.0 from the submodule (`stage1/packages/reference`) | the mechanism math, used directly by `@merces/math` and the simulator |
| `@merces/sdk` | 0.1.0 from the submodule (`stage1/packages/sdk`) | fixed point, periods, Poseidon/keccak commitments, signed messages, canonical error names |
| `@merces/circuits` | 0.1.0 from the submodule (`stage1/circuits`) | the ProofOfIncome circuit, its development verifying key and prover (development trusted setup, Stage 1 A37) |
| merces-common (Rust) | 0.1.0 from the submodule (`stage1/solana/crates/merces-common`) | the only dependency of `tools/stage1-oracle` (a path dependency; no registry crate, so it builds offline and keeps no `Cargo.lock`), which answers for `@merces/math`'s ported curve family in the curve-port gate |
| build | `scripts/stage1-build.mjs` (root `postinstall`) compiles the three with this repository's TypeScript 5.9.3 | they ship TypeScript with `exports` pointing at `dist` |

## Chain tooling (verified from official repos / npm)

| Item | Value | Source |
| --- | --- | --- |
| Anchor TS client | `@anchor-lang/core` 1.2.1 (`@coral-xyz/anchor` frozen at 0.32.1; repo moved to otter-sec/anchor) | npm, github.com/otter-sec/anchor |
| Codama | `codama` 1.11.0, `@codama/nodes-from-anchor` 1.5.6, `@codama/renderers-js` 2.5.0 | npm, github.com/codama-idl/codama |
| Solana devnet RPC | https://api.devnet.solana.com | solana.com docs (clusters) |
| Monad testnet | chain id 10143, RPC https://testnet-rpc.monad.xyz, ~400 ms blocks, finality after 2 blocks; `finalized`/`safe` tags supported | viem/chains, docs.monad.xyz (snippet) |
| Monad mainnet | chain id 143 (refused by the adapter guard) | viem/chains |
| USDC on Monad testnet | 0x534b2f3A21130d7a60830c2Df862319e593943A3 | Circle developer docs (snippet) |
| USDC Solana devnet mint | 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU | Circle developer docs (snippet) |
| USDG Solana devnet mint | 4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7 | Paxos docs (snippet) |
| ERC-3643 | `@erc3643org/erc-3643` 4.1.3 (T-REX 4.1.6 deprecated; ONCHAINID `@onchain-id/solidity` 2.2.1) | github.com/ERC-3643/ERC-3643 |
| Meteora DBC SDK | `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13; program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (mainnet and devnet); token badge needed only for Token-2022 quote mints with extensions | github.com/MeteoraAg |
| Jupiter | Swap API V2 at https://api.jup.ag/swap/v2 (`GET /order` → `POST /execute`, or `GET /quote` + `POST /swap`); `x-api-key` required (free via the Jupiter Portal) | github.com/jup-ag/space-station |
| Groth16 on Solana | Light Protocol `groth16-solana` 0.2.0 over `sol_alt_bn128_group_op` | github.com/Lightprotocol/groth16-solana |
| Groth16 on EVM | snarkjs `zkey export solidityverifier` (alt_bn128 precompiles 0x6/0x7/0x8) | github.com/iden3/snarkjs |

## Oracles

| Item | Value | Source |
| --- | --- | --- |
| Pyth Hermes | https://hermes.pyth.network — `GET /v2/updates/price/latest?ids[]=…&encoding=base64&parsed=true`; `GET /v2/updates/price/{publish_time}`; `GET /v2/price_feeds?asset_type=fx` | github.com/pyth-network/pyth-crosschain (Hermes OpenAPI) |
| `@pythnetwork/hermes-client` | 3.1.0 — `new HermesClient(url)`, `getLatestPriceUpdates(ids, {encoding, parsed})` | npm |
| `@pythnetwork/pyth-solana-receiver` | 0.16.0; receiver program `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`, price-feed program `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT` (mainnet and devnet) | docs.pyth.network source repo |
| Pyth on Monad | IPyth at 0x2880aB155794e7179c9eE2e38200202908C17B43 on Monad testnet and mainnet; `pyth-sdk-solidity` 4.3.1; `updatePriceFeeds(bytes[])` payable, `getUpdateFee`, `getPriceNoOlderThan(id, age)` | docs.pyth.network source repo |
| Pyth FX feed ids (confirmed) | FX.EUR/USD `0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b`; FX.GBP/USD `0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1`; FX.AUD/USD `0x67a6f93030420c1c9e3fe37c1ab6b77966af82f995944a9fefce357a22854a80` | docs.pyth.network data file |
| Pyth FX feed ids (unconfirmed) | USD/JPY, USD/CAD, USD/CHF, USD/SGD, USD/MXN, USD/BRL, USD/INR exist by name (EM pairs are quoted USD/XXX) — the rate keeper resolves ids at startup from `/v2/price_feeds?asset_type=fx` and fails closed when missing | — |
| FX market hours | FX feeds publish Sunday 17:00 ET to Friday 17:00 ET; EM FX from Sunday 18:00 ET; outside hours Hermes serves the last price (gate on `publish_time`) | docs.pyth.network (market hours) |
| Chainlink on Monad | Data Feeds on Monad mainnet only (crypto/exchange-rate feeds); **no FX feeds on Monad**; Data Streams verifier on testnet 0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64 | github.com/smartcontractkit/documentation |

## zkTLS and income sources

| Item | Value | Source |
| --- | --- | --- |
| Reclaim JS SDK | `@reclaimprotocol/js-sdk` 5.8.2 — `ReclaimProofRequest.init(appId, appSecret, providerId)`, `getRequestUrl()`, `getStatusUrl()`, `verifyProof(proofs)`, `transformForOnchain(proof)`; `@reclaimprotocol/zk-fetch` 1.1.0 for server-side fetches | npm, github.com/reclaimprotocol/reclaim-js-sdk |
| Reclaim proof shape | `{identifier, claimData:{provider, parameters, owner, timestampS, context, identifier, epoch}, signatures[], witnesses[{id,url}], extractedParameterValues, publicData?}`; context JSON holds `contextAddress, contextMessage, reclaimSessionId, extractedParameters, providerHash` | reclaimprotocol/docs ("Anatomy of a proof") |
| Hashing extracted values | HTTP provider `responseRedactions[].hash: 'oprf' \| 'oprf-mpc' \| 'oprf-raw'` makes the attestor sign a TOPRF hash of a named regex group instead of the value (attestor-core docs; not on the public docs site) | github.com/reclaimprotocol/attestor-core |
| Reclaim providers | A Stripe provider exists in the Reclaim devtool catalogue (id `acfdeaa9-9250-4acd-afd3-fac7ca03458b`, snippet-confirmed); no Deel or DistroKid provider found — custom HTTP providers needed | dev.reclaimprotocol.org (snippet) |
| Reclaim onchain verifiers | EVM on Ethereum, Base, Arbitrum, Optimism, Polygon and testnets; Solana program `rEcLDWaVLaymz82eGr6cutosPxE6SEzw6q4pbtLuyqf`; **Monad not listed** | github.com/reclaimprotocol/reclaim-solidity-sdk, reclaim-solana-sdk |
| TLSNotary | alpha (v0.1.0-alpha.15); `tlsn-js` deprecated/archived 2026-02; browser extension + `tlsn-wasm`; not production-ready | github.com/tlsnotary/tlsn |
| Stripe | `GET /v1/balance_transactions`, `GET /v1/payouts`, `GET /v1/balance`; test keys `sk_test_…`; Node SDK `stripe` 23.0.0 | github.com/stripe/openapi (2026-09-30) |
| Deel | https://api.letsdeel.com — `GET /rest/v2/invoices`, `GET /rest/v2/payments` (bearer/OAuth2); contractor-side earnings endpoint unconfirmed | developer.deel.com (snippet) |
| DistroKid | no public API found; income must come through a Reclaim HTTP provider over the DistroKid web app or through tier 3 | — (unconfirmed absence) |
