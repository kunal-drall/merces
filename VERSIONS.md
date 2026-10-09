# Pinned toolchain and dependency versions

Recorded on 7 October 2026. Every version below was observed from the package itself (`--version`, `package.json`,
`Cargo.toml` or the crates.io / npm registry index), not assumed.

## Toolchains

| Tool | Version | Source |
| --- | --- | --- |
| Node.js | 22.22.0 | container |
| pnpm | 10.28.0 | container (`packageManager` in `package.json`) |
| Rust (host) | 1.97.1 (pinned in `solana/rust-toolchain.toml`; LiteSVM 0.17's Agave dependencies require it) | rustup |
| Agave / Solana CLI | 3.1.10 (src:7bc9c805) | `solanafoundation/anchor:v1.0.2` Docker image, binaries copied to the host |
| Solana platform-tools | v1.52 (rustc 1.89.0, targets `sbpf-solana-solana` v0..v2) | same image |
| Anchor CLI | 1.2.1 | `cargo install anchor-cli --version 1.2.1 --locked` |
| Foundry (forge, cast, anvil) | 1.7.1 (commit 4072e487, 2026-05-08) | npm `@foundry-rs/forge`, `@foundry-rs/cast`, `@foundry-rs/anvil` 1.7.1 |
| solc | 0.8.30+commit.73712a01 (Merces contracts), 0.8.17+commit.8df45f5f (T-REX / ONCHAINID unit) | `ethereum/solc` Docker images, placed in `~/.svm` |
| circom | 2.2.3 (built from `iden3/circom` @ a100fae) | source |
| snarkjs | 0.7.6 | npm |

## Solana crates (`solana/Cargo.toml` `[workspace.dependencies]`)

| Crate | Version |
| --- | --- |
| anchor-lang / anchor-spl | 1.2.1 |
| spl-token-2022 | 11.1.0 |
| spl-transfer-hook-interface | 2.1.0 |
| spl-tlv-account-resolution | 0.11.4 |
| spl-pod | 0.7.4 |
| spl-token-metadata-interface | 1.0.1 |
| groth16-solana | 0.2.0 |
| pyth-solana-receiver-sdk | 2.0.0 |
| litesvm (tests) | 0.17.0 |

## Solidity dependencies (vendored into `evm/lib` by `evm/scripts/vendor-deps.sh` from the pins in `evm/package.json`)

| Dependency | Version | Notes |
| --- | --- | --- |
| forge-std | 1.17.0 (commit 0258fe87, 2026-10-05) | vendored copy of the git checkout |
| @openzeppelin/contracts | 5.6.1 | Merces contracts |
| @openzeppelin/contracts-upgradeable | 5.6.1 | Merces contracts |
| @openzeppelin/contracts (as `@oz4`) | 4.9.6 | required by T-REX / ONCHAINID |
| @openzeppelin/contracts-upgradeable (as `@oz4-upgradeable`) | 4.9.6 | required by T-REX / ONCHAINID |
| @tokenysolutions/t-rex | 4.1.6 | GPL-3.0; import paths rewritten to `@oz4*` (see `VENDORED.txt`) |
| @onchain-id/solidity | 2.2.1 | GPL-3.0; same rewrite |

## TypeScript packages

| Package | Version |
| --- | --- |
| typescript | 7.0.2 |
| vitest | 5.0.3 |
| tsx | 4.23.15 |
| @noble/hashes, @noble/curves | 2.4.0 |
| poseidon-lite | 0.3.0 |
| circomlib | 2.0.5 |
| circomlibjs | 0.1.7 |
| @anchor-lang/core | 1.2.1 |
| @solana/web3.js | 1.99.0 |
| @solana/spl-token | 0.4.15 |
| @meteora-ag/dynamic-bonding-curve-sdk | 1.5.13 |
| @meteora-ag/cp-amm-sdk | 1.5.1 |
| @pythnetwork/pyth-solana-receiver | 0.16.0 |
| @pythnetwork/hermes-client | 3.1.0 |
| @pythnetwork/pyth-sdk-solidity | 4.3.1 (interface reference; `IPyth` is vendored as an interface) |

## External program and contract addresses used (verified from the cloned official repos; see `docs/research/`)

| Item | Address | Source |
| --- | --- | --- |
| Meteora DBC program (mainnet = devnet) | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | `MeteoraAg/dynamic-bonding-curve` lib.rs |
| Meteora DAMM v2 program | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | same repo |
| Pyth Solana receiver (mainnet = devnet) | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` | `pyth-network/documentation` |
| Pyth EVM contract, Monad testnet (chain id 10143) | `0x2880aB155794e7179c9eE2e38200202908C17B43` | `pyth-network/documentation` evm.mdx |
| Pyth EVM contract, Monad mainnet (chain id 143) | `0x2880aB155794e7179c9eE2e38200202908C17B43` | same |
| Token-2022 program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | spl-token-2022 crate |
| USDG mint (Solana mainnet; **not** used on devnet, mocked instead) | `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` | public token lists (unverified against the issuer's own publication; see ASSUMPTIONS) |
| Monad testnet RPC | `https://testnet-rpc.monad.xyz`, chain id 10143, explorer `https://testnet.monadscan.com` | docs.monad.xyz (via search; site unreachable from the build container) |
