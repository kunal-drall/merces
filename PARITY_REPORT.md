# Parity report

Vector-by-vector results of the shared parity vectors (`packages/vectors`) on each stack and network. "Local" is
LiteSVM (Solana) and Foundry's EVM (Monad settings: `cancun`, chain id 10143 in the deploy config). Devnet and
testnet columns are filled when the deployment scripts are run from a machine with network access (the build
container cannot reach either RPC; see `ASSUMPTIONS.md` U5).

Status legend: ✅ all `expect` steps match to the base unit · ❌ mismatch (details below) · ⏳ not yet run · — not applicable.

| # | Vector | Brief F1 | Reference | Solana local | Monad local | Solana devnet | Monad testnet |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | happy path: raise, four quarterly payments, claims | 1 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 02 | failed auction: below minimum raise, full refunds, no fee | 2 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 03 | auction edge cases: tie at the margin, over-collateralised bids, unrevealed bid, bid above wallet cap | 3 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 04 | zero-payment quarters, then crossing the threshold mid-year (YTD method) | 4 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 05 | cap hit: truncated final payment, refund, retirement, burn | 5 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 06 | redemption decided by remaining cap / hurdle / payout multiple | 6 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 07 | late payment: grace, accrual, release pause, recovery | 7 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 08 | hardship pause across a deadline | 8 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 09 | tail clause after redemption, including the no-tail case | 9 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 10 | transfer window clearing, wallet-cap and lockup rejections | 10 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 11 | extinguishment with unreleased treasury funds | 11 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 12 | multi-series issuer and tier-1 split reconciliation | 12 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 13 | FX: normal quarter, low-coverage fallback, deviation fallback | 13 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| 14 | favourable amendment accepted; unfavourable rejected | 14 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |

## Invariant and fuzz runs (brief F2)

| Invariant | Reference (fast-check) | Solana (proptest / LiteSVM) | EVM (forge fuzz / invariant) |
| --- | --- | --- | --- |
| No unit receives more than its cap (payments + redemption + tail) | ⏳ | ⏳ | ⏳ |
| Total claims ≤ vault balance | ⏳ | ⏳ | ⏳ |
| Refunds + proceeds + fees == escrow | ⏳ | ⏳ | ⏳ |
| No fee ever taken from an issuer | ⏳ | ⏳ | ⏳ |
| Charter fields immutable after open | ⏳ | ⏳ | ⏳ |
| No admin path moves treasury or vault funds | ⏳ | ⏳ | ⏳ |
| Sealed-bid units never move outside the window, burns and redemption | ⏳ | ⏳ | ⏳ |
| C11 charter rules (7 dedicated tests) | ⏳ | ⏳ | ⏳ |

## Mismatches and resolutions

None recorded yet.

## How to reproduce

```bash
pnpm vectors                              # regenerate from the reference implementation
cd evm && forge test --match-path 'test/parity/*' -vv
cd solana && cargo test --release parity
```
Network runs: `solana/scripts/README.md` and `evm/script/README.md`.
