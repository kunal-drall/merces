# Merces — Stage 2: integration and backend

Merces lets a person raise capital against a capped share of their future income (the mechanism is **Mercery**; the
onchain unit is the **Human Equity Unit, HEU**). Stage 1 is the onchain layer (Solana programs, Monad contracts), built
in parallel. **This repository is Stage 2**: everything that connects both chains to the outside world (income sources,
legal contracts, identity checks, exchange rates) and the single chain-neutral API Stage 3's apps use. The brief is
`BUILD_PROMPT.md`.

Solana devnet and Monad testnet deployments are connected to the hosted backend for **team-only testnet trials**.
The Solana trial includes a Meteora DBC raise that graduated into DAMM v2 and a finalized holder stake.
Income and identity inputs in this trial are synthetic; it is not a mainnet launch or a completed external income-verification integration.
Deployment manifests and transaction evidence are in [merces-release](https://github.com/kunal-drall/merces-release).
The app and site live in [merces-frontend](https://github.com/kunal-drall/merces-frontend), with documentation in
[merces-docs](https://github.com/kunal-drall/merces-docs).

A **deterministic simulator** remains available behind the same `ChainPort` interface for local development and tests.
Stage 1's code is the pinned `stage1` submodule (SPEC v1.1.2); its math is imported, not rewritten. The simulator follows
Stage 1's rules, checked by replaying its parity vectors (`STAGE1_INTEGRATION.md`). `pnpm stage1:sync` generates typed
clients from the pinned IDLs and ABIs and reports interface differences. The quick start below runs the simulator,
not the hosted testnet environment.

## Quick start

```bash
pnpm install
docker compose up -d postgres            # or any Postgres 16 at $DATABASE_URL
pnpm dev:mock                            # API + indexer + keepers on the simulator, seeded 12-issuer cohort, port 3000
curl localhost:3000/arena | jq .          # Stage 3 can start here
```

```bash
pnpm test                                # unit + integration suites (Postgres needed for the DB-backed ones)
pnpm test:conformance                    # H2: the ChainPort behavioural suite on both simulator personalities
pnpm test:canary                         # H3: income canary and access-tier matrix
pnpm demo:cycle                          # one raise → treasury → 3 quarterly ProofOfIncome reports (Stripe data) → payouts, on Solana and Monad personalities
pnpm stage1:sync --no-conformance       # the catch-up pipeline against the pinned stage1 submodule (STAGE1_PATH overrides); needs cargo (its curve-port gate builds Stage 1's Rust)
pnpm stage1:vectors --backend reference  # replay Stage 1's 25 parity vectors (reference backend = Stage 1's own simulator)
pnpm stage1:vectors                      # the target vectors (and the prefix-gated ones to their gate) on our simulator, both personalities
pnpm openapi:check                       # routes ⇄ openapi.yaml ⇄ access tiers
```

## What is here

| Area | Packages |
| --- | --- |
| Mechanism math | `@merces/math` — the gateway to Stage 1's math (`@merces/sdk`, `@merces/reference` from the `stage1` submodule), plus the interim window cap and FX family (both S5; a curve raise has no cap since S3); the sealed raise runs Stage 1's auction family (S2); the unit-scale and curve family is ported from Stage 1's Rust until its TypeScript has one (S3, A-MATH-3) |
| Canonical model + `ChainPort` | `@merces/domain` — events, commands, state, hashing; `DOMAIN_EVENTS.md` and a JSON schema generated from it |
| Simulator | `@merces/simulator` — two personalities (`solana`: USDC+USDG, base58; `monad`: USDC, EVM), time travel, Postgres persistence |
| Live adapters | `@merces/chain-solana`, `@merces/chain-evm` (config-driven; mainnet refused), `@merces/chains` (mock / live / auto) |
| Read side | `@merces/indexer` (finality-aware, idempotent, resumable), `@merces/api` (Fastify, access tiers, `openapi.yaml`), `@merces/client` |
| Services | `@merces/services`: identity & onboarding (E2), contracts (E3), terms vault (E4), ProofOfIncome (E5), auction (E6), lifecycle (treasury, Stage 1's claims, redemption, windows), Meteora (E14: curve mode, staking and tender), threshold data (E9), attestor (E10), accounting (E11), notifications (E12), admin (E13) |
| Clockwork | `@merces/keepers` (E7 cranks, reminders, outbox; E8 rate keeper) |
| The sensitive one | `@merces/report-verifier` — isolated, no database, no payload logs |
| Device side | `@merces/poi-device` — what runs on the issuer's device for a report (income chain, Stage 1 payment, Groth16 proof), and the attestor's tool `merces-attestor` (`pnpm -s attestor`): a keystore that never leaves the attestor's machine, the signing-request check and Stage 1 signatures (S4 WP8; RUNBOOK "Attestor key setup") |
| Ports | `@merces/ports` — KMS, vault crypto, wallet verification, identity check, e-sign, zkTLS (Reclaim-shaped), proof system, Pyth/Chainlink, Meteora, DEX; every one with a mock |
| Stage 1 catch-up | `@merces/stage1-sync`, `@merces/conformance` |
| Tests and demos | `@merces/privacy-tests`, `@merces/scenarios`, `@merces/fixtures` |

## Documents

`ARCHITECTURE.md` (how the pieces fit), `API.md` (how to use the API), `DOMAIN_EVENTS.md` (the vocabulary),
`STAGE1_INTEGRATION.md` (catching Stage 1), `PRIVACY.md` (every personal data field), `SECURITY.md`, `RUNBOOK.md`,
`ASSUMPTIONS.md` (every default chosen, with the ones to confirm marked ASK), `VERSIONS.md` (pinned versions and the
external facts the code relies on, with sources), `docs/milestones/` (what each milestone built, assumed and left open).

## Ground rules this code keeps

Never mainnet, never real funds or personal data. The backend builds unsigned user transactions. In the current hosted
trial, keeper, approval, and verifier signing keys stay in the local operator's macOS Keychain; the cloud requests
scoped signatures and signer-dependent keeper jobs defer while that operator is offline. KMS is an available port,
not the active signing configuration. Attestor keys stay on the attestors' machines. No raw income at rest, in logs, in queues or in error reports (a canary test proves
it). A chain-neutral API. Money and charter semantics come from the brief; every ambiguity that could change who gets
paid is recorded in `ASSUMPTIONS.md` and flagged for Kunal.
