# Parity report

Vector-by-vector results of the shared parity vectors (`packages/vectors`) on each stack and network. "Local" is
LiteSVM (Solana) and Foundry's EVM (Monad settings: `cancun`, chain id 10143 in the deploy config). Devnet and
testnet columns are filled when the deployment scripts are run from a machine with network access (the build
container cannot reach either RPC; see `ASSUMPTIONS.md` U5).

As of 9 October 2026: 25 shared vectors (the 14 from brief F1, 5 added by the spec audit, 4 added by the hard
security review). All pass on the reference, on Solana local (LiteSVM, SPL USDC and Token-2022 USDG) and on
Monad local (Foundry). Devnet/testnet columns await a networked run (RPCs blocked here; ASSUMPTIONS U5).

Status legend: ✅ all `expect` steps match to the base unit · ❌ mismatch (details below) · ⏳ not yet run · — not applicable.

| # | Vector | Brief F1 | Reference | Solana local | Monad local | Solana devnet | Monad testnet |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | happy path: raise, four quarterly payments, claims | 1 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 02 | failed auction: below minimum raise, full refunds, no fee | 2 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 03 | auction edge cases: tie at the margin, over-collateralised bids, unrevealed bid, bid above wallet cap | 3 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 04 | zero-payment quarters, then crossing the threshold mid-year (YTD method) | 4 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 05 | cap hit: truncated final payment, refund, retirement, burn | 5 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 06 | redemption decided by remaining cap / hurdle / payout multiple | 6 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 07 | late payment: grace, accrual, release pause, recovery | 7 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 08 | hardship pause across a deadline | 8 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 09 | tail clause after redemption, including the no-tail case | 9 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 10 | transfer window clearing, wallet-cap and lockup rejections | 10 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 11 | extinguishment with unreleased treasury funds | 11 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 12 | multi-series issuer and tier-1 split reconciliation | 12 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 13 | FX: normal quarter, low-coverage fallback, deviation fallback | 13 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 14 | favourable amendment accepted; unfavourable rejected; cap lowered below paid → retire | 14 | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 15 | zero valid bids: every proposal fails the raise, full refunds, non-reveal charge | audit | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 16 | demand-limited window clearing and a NO_MATCH window | audit | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 17 | winner leaves the allowlist after reveal: finalization and releases unaffected, late delivery | audit | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 18 | report, pay, release, redeem before mint finalization → revert; router income held then routed | audit | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |
| 19 | hardship pause approved while Late: releases stay blocked, later clocks unshifted | audit | ✅ | ✅ (USDC and USDG) | ✅ | ⏳ | ⏳ |

## Invariant and fuzz runs (brief F2)

| Invariant | Reference (fast-check) | Solana (proptest / LiteSVM) | EVM (forge fuzz / invariant) |
| --- | --- | --- | --- |
| No unit receives more than its cap (payments + redemption + tail) | ✅ | ✅ | ✅ |
| Total claims ≤ vault balance | ✅ (exact WAD carry; see SPEC §13.18) | ✅ | ✅ |
| Refunds + proceeds + fees == escrow | ✅ | ✅ | ✅ |
| No fee ever taken from an issuer | ✅ | ✅ | ✅ |
| Charter fields immutable after open | ✅ (model level) | ✅ (byte snapshot after every vector step) | ✅ (invariant) |
| No admin path moves treasury or vault funds | ✅ (model) | ✅ (roles tests) | ✅ (invariant) |
| Sealed-bid units never move outside the window, burns and redemption | ✅ (model) | ✅ (hook tests) | ✅ (invariant) |
| C11 charter rules (7 dedicated tests) | ✅ (model) | ✅ (7 tests) | ✅ (8 tests) |

## Mismatches and resolutions

Both stacks replay the same 21 vectors from `packages/reference` and match the reference to the base unit, on
local validators (Solana LiteSVM on SPL USDC and Token-2022 USDG; EVM Foundry on an ERC-20 USDC). Where the
on-chain reality forced a choice the SPEC left open, the reference was aligned so all three agree; the few
remaining intentional differences are:

- **Window post-clearing accrual (C-S4).** If a payout lands between a window's clearing and an order's
  processing, the reference (atomic) pays the sold units' share to the seller, the chains to the buyer. Both
  stacks are solvent and agree on every vector (no payout falls in that interval in any vector). SPEC §7 now
  specifies the chains' rule.
- **True-up year anchor (B-S14).** Reference, Solana and EVM all bucket a true-up payment by
  `deadline(period_of(trueup_attested_at))`; no vector distinguishes the alternatives.

Devnet and testnet columns stay ⏳: both RPC endpoints are blocked from the build container (`ASSUMPTIONS.md`
U5), so the scripted deploys were rehearsed on a local validator and on anvil and must be run from a networked
machine to fill those columns.

## How to reproduce

```bash
pnpm vectors                              # regenerate from the reference implementation
cd evm && forge test --match-path 'test/parity/*' -vv
cd solana && cargo test --release parity
```
Network runs: `solana/scripts/README.md` and `evm/script/README.md`.
