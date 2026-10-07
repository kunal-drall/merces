# Merces — Stage 1: programs and contracts

Merces lets a person raise capital against a capped share of their future income. This repository is **Stage 1**:
the complete onchain layer, built twice with identical behaviour — Solana programs (Rust, Anchor, Token-2022) and
EVM contracts for Monad (Solidity, Foundry, ERC-3643 via T-REX) — plus a TypeScript reference implementation that
generates the parity vectors both stacks must match to the base unit.

Read in this order: `BUILD_PROMPT.md` (the brief), `SPEC.md` (the normative design), `ARCHITECTURE.md`,
`EVENTS.md`, `INTERFACES.md`, `ASSUMPTIONS.md`, `AUDIT_NOTES.md`, `PARITY_REPORT.md`.

> Devnet and testnet only. Nothing in this repository deploys to a mainnet.

## Layout

| Path | Contents |
| --- | --- |
| `packages/reference` | `@merces/reference`: bigint math, protocol simulator, parity-vector generator |
| `packages/sdk` | `@merces/sdk`: commitments (Poseidon), signed-message encodings, hashing, PDA helpers |
| `packages/vectors` | generated parity vectors (JSON) |
| `circuits` | circom reference circuit, development-only trusted setup, generated verifiers |
| `solana` | Anchor workspace: `merces_registry`, `merces_hook`, `merces_protocol`, `mock_usdg_hook`; Rust LiteSVM tests; deploy scripts |
| `evm` | Foundry workspace: Merces contracts, T-REX integration, unit / fuzz / invariant / parity tests; deploy scripts |
| `docs/research` | research memos on Meteora DBC, Pyth and T-REX written from the official repositories |

## Prerequisites

Pinned versions are listed in `VERSIONS.md`.

- Node 22 and pnpm 10 (`corepack enable`)
- Rust stable, Agave 3.1.10 (`sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.10/install)"`), Anchor CLI 1.2.1 (`cargo install anchor-cli --version 1.2.1 --locked`)
- Foundry 1.7.1 (`foundryup -i 1.7.1` or `npm i -g @foundry-rs/forge@1.7.1 @foundry-rs/cast@1.7.1 @foundry-rs/anvil@1.7.1`)
- solc 0.8.30 and 0.8.17 available to Foundry (`forge` downloads them; offline machines place them in `~/.svm/<ver>/solc-<ver>`)
- circom 2.2.3 (`https://github.com/iden3/circom/releases`)

## Build and test

```bash
pnpm install                     # workspace dependencies
pnpm circuits:build              # circom -> r1cs/wasm/zkey/vk, Solidity verifier, Rust verifying key
pnpm -r --filter './packages/*' test   # reference math + sdk tests
pnpm vectors                     # regenerate packages/vectors from the reference implementation

pnpm evm:build && pnpm evm:test  # Foundry: unit, fuzz, invariant and parity tests
bash solana/scripts/build.sh     # anchor build (platform-tools v1.52, SBPF v0)
cd solana && cargo test --release   # Rust LiteSVM tests incl. parity runner
```

## Deploy

- Solana devnet: `solana/scripts/README.md` (program deploys, registry made immutable, mock stablecoins, protocol init).
- Monad testnet: `evm/script/README.md` (T-REX suite, Merces contracts behind UUPS proxies owned by a timelock).

Both deploy flows are scripted and idempotent; see `PARITY_REPORT.md` for the recorded results.
