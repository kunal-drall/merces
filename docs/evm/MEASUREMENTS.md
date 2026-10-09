# EVM measurements

Foundry 1.7.1, solc 0.8.30 via-IR, optimizer 200 runs, `evm_version = cancun`, default profile (the deployment
build). Gas figures are execution gas of the external call as reported by `forge test --gas-report` over the
whole suite (unit, charter, fuzz, invariant and the 21 SPEC §11 vectors) — they exclude the 21,000 intrinsic and
calldata cost of a transaction. Money contracts are called through their ERC-1967 proxies (≈ +2.6k per call for
the delegatecall hop, included). Regenerate with `cd evm && forge test --gas-report` and
`forge build --sizes`.

## Contract sizes (EIP-170 limit 24,576 B)

| Contract | Runtime (B) | Margin (B) | Initcode (B) |
| --- | ---: | ---: | ---: |
| `MercesWindow` | 23,992 | 584 | 24,259 |
| `MercesVault` | 23,433 | 1,143 | 23,700 |
| `MercesIncome` | 23,077 | 1,499 | 23,344 |
| `MercesRegistry` | 20,486 | 4,090 | 24,449 |
| `MercesAuction` | 18,905 | 5,671 | 19,172 |
| `MercesRouter` | 9,338 | 15,238 | 9,605 |
| `MercesTokenFactory` (0.8.17) | 8,420 | 16,156 | 9,105 |
| `MercesTreasury` | 8,384 | 16,192 | 8,651 |
| `MercesFxAccumulator` | 7,693 | 16,883 | 7,960 |
| `MercesComplianceModule` (0.8.17) | 2,328 | 22,248 | 2,360 |
| `Groth16Verifier` | 1,857 | 22,719 | 1,883 |
| `FeeCollector` | 741 | 23,835 | 986 |
| `MercesRouterReceiver` | 397 | 24,179 | 526 |
| `MercesTokenGovernor` | 183 | 24,393 | 207 |

Every deployable fits; `MercesWindow`, `MercesVault` and `MercesIncome` only through the IR pipeline (the
`dev` profile's legacy codegen exceeds the limit and lifts it for tests only). `MercesWindow` has the smallest
margin: any addition there should be paid for by moving views out.

## Gas per operation

Min / median / max over every call in the suite (median is the typical case; max is the heaviest path
exercised, e.g. a capping payment, a 200-entry tally page or the first touch of cold storage).

| Operation | Function | Min | Median | Max |
| --- | --- | ---: | ---: | ---: |
| Create a series | `MercesRegistry.createSeries` | 29,970 | 359,865 | 483,420 |
| Favourable amendment | `MercesRegistry.amendTerms` | 29,173 | 50,778 | 174,426 |
| Allowlist a wallet (first time: ONCHAINID + identity registry) | `MercesRegistry.setAllowed` | 6,530 | 80,396 | 520,968 |
| Open a raise (deploys token + compliance proxies) | `MercesAuction.openRaise` | 31,587 | 1,453,262 | 1,453,262 |
| Commit a bid | `MercesAuction.commitBid` | 7,908 | 160,966 | 195,166 |
| Reveal a bid | `MercesAuction.revealBid` | 5,062 | 48,671 | 65,771 |
| Propose a clearing price | `MercesAuction.beginSettlement` | 2,920 | 80,330 | 97,445 |
| Tally page (≤ 200 bids) | `MercesAuction.tallyBids` | 2,919 | 44,467 | 513,520 |
| Finalize settlement | `MercesAuction.finalizeSettlement` | 5,834 | 48,440 | 158,238 |
| Process a bid (mint, cost → treasury, fee) | `MercesAuction.processBid` | 8,150 | 185,601 | 456,075 |
| Deliver a bid | `MercesAuction.deliverBid` | 7,750 | 106,318 | 226,990 |
| Claim a release | `MercesTreasury.claimRelease` | 11,656 | 49,504 | 196,777 |
| Submit a report (Groth16 + attestation) | `MercesIncome.submitReport` | 29,639 | 177,731 | 559,056 |
| Pay a due (into the vault, fee, cap) | `MercesIncome.pay` | 34,290 | 188,634 | 336,891 |
| Submit / pay a true-up | `submitTrueUp` / `payTrueUp` | 24,122 / 34,214 | 38,060 / 176,822 | 90,926 / 206,529 |
| Approve a hardship pause | `MercesIncome.approvePause` | 993 | 14,715 | 134,840 |
| Crank status | `MercesIncome.crankStatus` | 9,139 | 12,149 | 85,970 |
| Route tier-1 income | `MercesRouter.route` | 31,346 | 247,153 | 482,294 |
| Close a router period | `MercesRouter.closeRouterPeriod` | 26,352 | 59,614 | 133,666 |
| FX snapshot | `MercesFxAccumulator.snapshot` | 22,857 | 57,935 | 197,305 |
| Claim payouts | `MercesVault.claim` | 13,051 | 133,148 | 261,595 |
| Redeem (issuer) | `MercesVault.redeem` | 32,079 | 156,832 | 269,465 |
| Claim redemption / tail / final | `claimRedemption` / `claimTail` / `claimFinal` | — | — | 262,897 / 316,113 / 298,498 |
| Extinguish (two signatures, treasury → vault) | `MercesVault.extinguish` | 18,010 | 201,516 | 303,364 |
| Retire if capped / burn retired units | `retireIfCapped` / `burnRetired` | 33,894 / 34,217 | 49,375 / 186,035 | 106,464 / 204,535 |
| Open a window | `MercesWindow.openWindow` | 9,340 | 63,226 | 169,260 |
| Commit an ask (armed escrow deposit) / a bid | `commitAsk` / `commitBid` | 12,811 / 15,118 | 408,489 / 167,367 | 476,889 / 235,767 |
| Reveal an order | `MercesWindow.revealOrder` | 7,280 | 99,143 | 231,275 |
| Window tally page (≤ 200 orders) | `MercesWindow.tallyOrders` | 6,397 | 191,625 | 301,889 |
| Finalize a window | `MercesWindow.finalizeWindow` | 9,451 | 47,428 | 100,055 |
| Process an order (accounting, fee) | `MercesWindow.processOrder` | 6,699 | 106,275 | 275,142 |
| Deliver an order | `MercesWindow.deliverOrder` | 12,929 | 90,070 | 227,865 |
| Ask price index (take-back below `p*`) | `MercesWindow.indexAskPrices` | 19,106 | 27,816 | 69,798 |
| **Groth16 verification** | `Groth16Verifier.verifyProof` | 221,384 | 221,384 | 221,384 |

The ProofOfIncome verifier (6 public inputs, BN254 pairing precompiles) costs 221,384 gas per proof. The
`submitReport` median above is pulled down by the fuzz and invariant suites, which install an accept-all
verifier to drive arbitrary amounts; with the real verifier an accepted report costs the verification plus
the report bookkeeping, signature recovery and status sync (heaviest observed path 559,056).

## Settlement at the bid limit

`test_maxBidsPerAuction` fills an auction to `max_bids_per_auction = 4096` wallets and settles it end to end:
21 tally pages of ≤ 200 bids (≤ 513,520 gas each), one finalize, 4,096 `processBid` and `deliverBid`
calls. No step loops over more than one page or one bid, so settlement never approaches the block gas limit.
The same holds for windows (`MAX_ORDERS_PER_WINDOW = 4096`, pages of 200, one order per process / delivery).

## Deployment

See `evm/script/README.md`. The anvil rehearsal of `DeployLocal.s.sol` (chain 31337) records its transactions in
`evm/broadcast/DeployLocal.s.sol/31337/run-latest.json`; totals are in the table below.
