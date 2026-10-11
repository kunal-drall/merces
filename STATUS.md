# Stage 1 status

Integration correction (2026-10-11): the TypeScript reference's redeemed final claim now includes units still held
in an uncleared ask, matching Solana `claims.rs` and EVM `MercesVault.sol`. The regression fixture
`packages/reference/test/fixtures/26_final_share_open_ask.json` runs 88 steps and proves the vault reaches zero.
The original 25 protocol vectors and all chain sources are unchanged. The backend integration's `pnpm test:stage1`
passes 263 SDK/reference/circuit tests, including this regression. No network deployment is part of this correction.


9 October 2026. Everything below is on branch `claude/sweet-goodall-b7acm3`. Devnet and testnet only; nothing here deploys to a mainnet.

## Done

| Area | State |
| --- | --- |
| Reference, SDK, circuit, vectors (Track A) | `@merces/reference` 171 tests, `@merces/sdk` 80, circuit 3,432 constraints / 11 tests; **25 parity vectors** (14 from brief F1, 5 from the spec audit, 4 from the security review), deterministic |
| Solana programs (Track B) | `merces_registry`, `merces_protocol` (56 ix incl. curve), `merces_hook`; **172 tests**, all 25 vectors on SPL USDC **and** Token-2022 USDG; sealed-bid and Meteora curve mode; deploy rehearsed on a local validator |
| EVM contracts (Track C) | registry, T-REX token factory + Merces compliance/governor, auction, treasury, income+FX, vault, window, fee collector; UUPS behind a timelock; **204 tests** (unit/fuzz/invariant/parity), all 25 vectors; every contract < 24 KB; deploys rehearsed on anvil |
| Meteora off-chain (Track D) | income-anchored DBC config generator, graduation flow, proceeds memo; **82 tests** incl. a real-binary end-to-end graduation |
| Hard security review | `SECURITY_REVIEW.md`: 8 confirmed findings (5 high, 2 medium, 1 low), all fixed on both stacks; 3 refuted; reentrancy/account-validation/unit-custody dimensions clean |
| Documents | README, SPEC (v1.1.2), ARCHITECTURE, EVENTS, INTERFACES, ASSUMPTIONS, VERSIONS, AUDIT_NOTES, PARITY_REPORT, SECURITY_REVIEW, per-stack docs under docs/ |

## Decisions waiting on Kunal (defaults in force, see ASSUMPTIONS.md / docs/meteora/PROCEEDS_OPTIONS.md)

- H1 non-reveal charge (1% of escrow); H2 Pyth/Chainlink deviation band (2%); H3 Meteora max-raise multiple (3×) and the migration-fee custody route (recommend `creator_fee_percentage = 0` into the treasury); H4 extinguishment treatment (counsel); H5 T-REX GPL-3.0 licence acceptance; H6 partial redemption (stretch, not built); H7 durations; H8 hackathon path (not taken).
- S2 curve-redemption residual (A49): the migrated LP is assumed permanently locked and the honest over-deposit leaves pool-base dust in the vault — counsel/Kunal to confirm.

## Not done in this container (needs a networked machine)

- Devnet (Solana) and testnet (Monad, chain 10143) deployments and the parity columns for them: both RPCs are blocked from the build container (ASSUMPTIONS U5). The deploy scripts are written and rehearsed locally; run `solana/scripts/deploy.sh` and `evm/script/DeployMonadTestnet.s.sol` from a networked machine.

## Before mainnet (out of Stage 1 scope)

- Replace the development trusted setup for the circuit with a real ceremony.
- External audits (deferred per the operator instruction; the internal hard review stands in).
