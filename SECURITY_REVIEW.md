# Security review (internal, hard)

Date 9 October 2026. Method: twelve finder dimensions read the actual Rust and Solidity (not just the spec); every
finding was checked by two independent skeptics who read the cited code; survivors were merged and prioritized.
39 agents, 13 findings raised, 10 confirmed (merged to 8), 3 refuted. No external audit was performed (per the
operator instruction to skip external audits and do a hard internal review instead). The development trusted setup
for the circuit remains out of scope for production and must be replaced before mainnet.

Dimensions that found **nothing exploitable**: EVM reentrancy / CEI / upgrade authority; Solana account, owner,
signer and PDA validation; unit-token custody and transfer gating. These were examined specifically for theft,
account substitution, reentrancy, and unit escape, and came back clean.

Every confirmed finding is a **parity or money/liveness divergence** between the two stacks (or between a stack and
the reference), not a direct theft path. The transfer window ships disabled (`windows_enabled = false`), so the
window-related findings are not reachable in the pilot until the admin enables it, but all are fixed for production.

## Confirmed findings and fixes

| # | Sev | Chain | Finding | Fix | Status |
| --- | --- | --- | --- | --- | --- |
| S1 | high | Solana | `register_holder_now` seeds `last_tail_acc_wad`/`last_final_acc_wad` to the **live** accumulators, not 0, so a wallet registered after a redemption/extinguishment (e.g. a window buyer) is paid 0 of the tail/final pool it is owed; the rest is locked in the vault. EVM zeroes both (C-S20). | Zero both cursors at registration (`common.rs`); EVM already correct. | fixed |
| S2 | high | Solana (curve) | In curve mode `redeem` recomputes the unit census inline from a spot read of the DAMM v2 pool vault; an issuer can sandwich it (swap base in → redeem → swap out) to freeze `units_at_redemption` low, under-deposit, and strand non-staked holders. | Derive the deposit from a source a single-tx swap cannot deflate (mint supply minus provably-locked, or an adversarially-sampled multi-block max). **Needs design review** before coding (the simple TWAP was judged inadequate). Curve mode is Solana-only. | fix designed, not yet coded |
| S3 | high | Solana | `finalize_window` and the window settlement path never check terminal status, so a keeper can clear and force a non-consensual trade on a Redeemed/Extinguished/Retired series while a window is mid-settlement. EVM forces NoMatch once terminal (C-S5). | Force the NoMatch path when the series is terminal (`window.rs`); EVM already correct. | fixed |
| S4 | high | Solana | FX `normalize()` caps the **pre-inversion** rate to u64, so inverted major-currency pairs (USD/JPY, USD/INR, …) overflow and every snapshot reverts, permanently forcing the attestor fallback. EVM keeps the intermediate in 256-bit. | Invert in the u128 domain; apply the u64 cap only to the final inverted rate (`fx.rs`); EVM already correct. | fixed |
| S5 | high | Solana | `amend_terms` never updates the tier-1 split router's θ/r, so a holder-favourable amendment that EVM applies is silently ignored on Solana — the two chains route a different income share afterwards. | Handle the tier-1 plaintext in Solana `amend_terms` and re-sync the router (`lib.rs`, `router.rs`); EVM already correct. | fixed |
| S6 | medium | both | Solana and the TypeScript reference omit the tail catch-up term EVM adds in the redemption body, so units redeemed after an earlier tail claim forfeit their pre-claim tail share (permanently stranded). | Add the catch-up to the reference and Solana (EVM-canonical), regenerate the vectors, add a two-step-redemption-with-tail vector. | fixed |
| S7 | medium | EVM | EVM consumes `router_credit` even when a non-liquidity tail report forces the due to 0, double-charging the issuer on a later tail liquidity event. Solana preserves the credit. | On EVM, skip the credit math when the due is forced to 0 (`MercesIncome.sol`); Solana already correct. | fixed |
| S8 | low | both | EVM's FX-fallback attestor check ignores the forward-only revocation grace that Solana (and EVM's own report-attestation path) honour, so a report Solana accepts can be rejected on EVM, manufacturing lateness. | Apply the grace in EVM `_checkFx` (matches Solana and EVM's report path). | fixed |

## Refuted findings (recorded so they are not re-raised)

- **Auction fee-collector ATA (Solana, claimed high).** `process_bid` needs the fee-collector ATA to exist, but anyone can create it permissionlessly and no actor can prevent it, so nothing locks and the money result is identical to EVM. An ordinary Solana "caller ensures destination ATA" requirement, not a defect. (The deploy script creates it; documented.)
- **FX cross-check revert on Solana (claimed medium).** Reverting a snapshot when a configured cross-check feed is stale is only reachable via an admin action contradicting the shipping config (the Solana cross-check is unset, A21); snapshots are daily and permissionless, so a transient lag is retried, and genuine erosion degrades to the spec-intended attestor fallback. No fund or charter consequence.
- **Curve `sync_curve_units` spot read scales the payment (claimed critical).** `units_outstanding` appears on both sides of the owed-income computation and cancels: per-unit accrual is `r·(x−θ)` regardless of the census, and the `outstanding ≥ staked_total` guard keeps the vault solvent for every claimable amount. Curve income accrues only to staked units and a later staker cannot back-claim, so no staked holder is underpaid. (The distinct **deposit** manipulation at redemption is real and is S2.)
