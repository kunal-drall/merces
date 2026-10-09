# DOMAIN_EVENTS.md — canonical domain model v0

Generated from `packages/domain/src/{events,commands}.ts` by `pnpm docs:events`; the machine-readable form is `packages/domain/schema/domain-v0.schema.json` (JSON Schema 2020-12). Live adapters map whatever Stage 1 emits and accepts onto exactly these shapes; differences are recorded in `INTERFACE_DRIFT.md` by `stage1:sync`, never papered over.

## Conventions

- Identifiers are chain-neutral strings: `seriesId = "<chain>:<address>"`, `issuerId = "<chain>:<address>"`. EVM addresses are lowercase; Solana addresses are base58.
- Money is a decimal string in stablecoin base units (6 decimals for USDC and USDG, verified from the mint). Ratios are decimal strings in 1e18 fixed point (WAD). Unit counts are decimal strings. Never floating point.
- Timestamps are unix seconds. Periods are calendar quarters in UTC, written `YYYYQn`.
- Every event is wrapped in an envelope: `chain`, `cursor` (opaque, ordered within a chain), `seq` (monotonic per chain), `blockTime`, `blockRef`, `txId`, `finality` (`finalized` | `confirmed`), `type`, `payload`. Only `finalized` events reach money-bearing read models.
- Events marked **amount-bearing** never appear in the public activity feed with amounts (R28).

## Events

### IssuerRegistered

- `issuer`: string

### IssuanceStopped

- `issuer`: string

### SeriesCreated

- `seriesId`: string
- `issuer`: string
- `terms`: object { stablecoin: `USDC` \| `USDG`, stablecoinMint: string, unitsOffered: decimal string (base units / WAD / units), reservePrice: decimal string (base units / WAD / units), minimumRaise: decimal string (base units / WAD / units), capMultipleWad: decimal string (base units / WAD / units), lockupSeconds: integer, releaseSchedule: array of object { afterSeconds: integer, bps: integer }, auctionFeeBps: integer, payoutFeeBps: integer, hurdleWad: decimal string (base units / WAD / units), payoutMultipleK: integer, walletCapBps: integer, dueDays: integer, graceDays: integer, formalNoticeDays: integer, contractHash: hex32, termsCommitment: hex32, tierFlags: object { tier1: boolean, tier2: boolean, tier3: boolean, tier4: boolean }, reportingCurrency: string, raiseStyle: `sealed` \| `curve` }

### RaiseOpened

- `seriesId`: string
- `commitEndsAt`: integer
- `revealEndsAt`: integer

### RaiseCancelled

- `seriesId`: string

### BidCommitted (amount-bearing)

- `seriesId`: string
- `bidder`: string
- `commitment`: hex32
- `deposit`: decimal string (base units / WAD / units)
- `order`: integer

### BidRevealed (amount-bearing)

- `seriesId`: string
- `bidder`: string
- `pricePerUnit`: decimal string (base units / WAD / units)
- `quantity`: decimal string (base units / WAD / units)

### AuctionSettled (amount-bearing)

- `seriesId`: string
- `clearingPrice`: decimal string (base units / WAD / units)
- `unitsSold`: decimal string (base units / WAD / units)
- `proceeds`: decimal string (base units / WAD / units)
- `totalFees`: decimal string (base units / WAD / units)
- `settledAt`: integer

### AuctionFailed

- `seriesId`: string
- `reason`: `no-bids` \| `below-minimum-raise`

### BidRefunded (amount-bearing)

- `seriesId`: string
- `bidder`: string
- `amount`: decimal string (base units / WAD / units)

### UnitsMinted

- `seriesId`: string
- `holder`: string
- `units`: decimal string (base units / WAD / units)

### TreasuryFunded (amount-bearing)

- `seriesId`: string
- `amount`: decimal string (base units / WAD / units)

### FundsReleased (amount-bearing)

- `seriesId`: string
- `amount`: decimal string (base units / WAD / units)
- `trancheIndex`: integer

### ReleasesPaused

- `seriesId`: string
- `reason`: `Late` \| `IssuerRequest`

### ReleasesResumed

- `seriesId`: string

### SplitReceipt (amount-bearing)

- `seriesId`: string
- `periodId`: period id (YYYYQn)
- `amount`: decimal string (base units / WAD / units)
- `router`: string

### ReportAccepted (amount-bearing)

- `seriesId`: string
- `periodId`: period id (YYYYQn)
- `tier`: `1` \| `2` \| `3` \| `4`
- `paymentDue`: decimal string (base units / WAD / units)
- `accrual`: decimal string (base units / WAD / units)
- `priorIncomeCommitment`: hex32
- `incomeCommitment`: hex32
- `termsCommitment`: hex32
- `fxBasis`: `accumulator` \| `attestor` \| `unity`
- `fxAvgWad`: decimal string (base units / WAD / units)
- `liquidityEvent`: boolean

### PaymentReceived (amount-bearing)

- `seriesId`: string
- `periodId`: period id (YYYYQn) \| null
- `gross`: decimal string (base units / WAD / units)
- `fee`: decimal string (base units / WAD / units)
- `net`: decimal string (base units / WAD / units)
- `source`: `payIn` \| `split` \| `redemption` \| `tail` \| `extinguishment`
- `paidPerUnitWad`: decimal string (base units / WAD / units)
- `paymentDue?`: decimal string (base units / WAD / units)
- `accrual?`: decimal string (base units / WAD / units)

### PaymentRefunded (amount-bearing)

- `seriesId`: string
- `periodId`: period id (YYYYQn) \| null
- `amount`: decimal string (base units / WAD / units)
- `reason`: `cap` \| `overpayment`

### FeeTaken (amount-bearing)

- `seriesId`: string
- `kind`: `auction` \| `payout`
- `amount`: decimal string (base units / WAD / units)
- `payer`: string

### PayoutClaimed (amount-bearing)

- `seriesId`: string
- `holder`: string
- `amount`: decimal string (base units / WAD / units)

### SeriesRetired

- `seriesId`: string
- `paidPerUnitWad`: decimal string (base units / WAD / units)

### UnitsBurned

- `seriesId`: string
- `holder`: string
- `units`: decimal string (base units / WAD / units)
- `reason`: `cap` \| `redemption` \| `extinguishment`

### RedemptionOpened (amount-bearing)

- `seriesId`: string
- `pricePerUnit`: decimal string (base units / WAD / units)
- `unitsOutstanding`: decimal string (base units / WAD / units)
- `deposit`: decimal string (base units / WAD / units)
- `tailCapPerUnit`: decimal string (base units / WAD / units)
- `tailEndsAt`: integer

### RedemptionClaimed (amount-bearing)

- `seriesId`: string
- `holder`: string
- `units`: decimal string (base units / WAD / units)
- `amount`: decimal string (base units / WAD / units)

### TailPayout (amount-bearing)

- `seriesId`: string
- `periodId`: period id (YYYYQn)
- `perUnit`: decimal string (base units / WAD / units)
- `total`: decimal string (base units / WAD / units)

### PauseRequested

- `seriesId`: string
- `until`: integer

### PauseApproved

- `seriesId`: string
- `attestor`: string
- `until`: integer

### PauseEnded

- `seriesId`: string
- `pausedSeconds`: integer

### StatusChanged

- `seriesId`: string
- `from`: `OnTime` \| `InGrace` \| `Late` \| `Paused` \| `Retired` \| `Redeemed` \| `Extinguished`
- `to`: `OnTime` \| `InGrace` \| `Late` \| `Paused` \| `Retired` \| `Redeemed` \| `Extinguished`

### FormalNoticeDue

- `seriesId`: string
- `periodId`: period id (YYYYQn)

### TermsAmended

- `seriesId`: string
- `termsCommitment`: hex32
- `previousCommitment`: hex32
- `capMultipleWad`: decimal string (base units / WAD / units)
- `attestor`: string

### SeriesExtinguished (amount-bearing)

- `seriesId`: string
- `attestors`: array of string
- `returnedToHolders`: decimal string (base units / WAD / units)

### RateSnapshot

- `pair`: pair (XXX/USD)
- `rateWad`: decimal string (base units / WAD / units)
- `confWad`: decimal string (base units / WAD / units)
- `publishTime`: integer
- `dayIndex`: integer
- `sumWad`: decimal string (base units / WAD / units)
- `count`: integer

### FxFallbackFlagged

- `pair`: pair (XXX/USD)
- `periodId`: period id (YYYYQn)
- `reason`: `coverage` \| `deviation`

### TransferWindowOpened

- `seriesId`: string
- `windowId`: integer
- `commitEndsAt`: integer
- `revealEndsAt`: integer

### TransferWindowCleared (amount-bearing)

- `seriesId`: string
- `windowId`: integer
- `clearingPrice`: decimal string (base units / WAD / units)
- `unitsTransferred`: decimal string (base units / WAD / units)

### UnitsTransferred

- `seriesId`: string
- `from`: string
- `to`: string
- `units`: decimal string (base units / WAD / units)
- `windowId`: integer

### AllowlistUpdated

- `wallet`: string
- `allowed`: boolean

### AttestorRegistered

- `attestor`: string
- `active`: boolean

### VerifierKeyRegistered

- `keyId`: string
- `publicKey`: string
- `active`: boolean

### CurveSeriesCreated

- `seriesId`: string
- `issuer`: string
- `quoteStablecoin`: `USDC` \| `USDG`
- `graduationThreshold`: decimal string (base units / WAD / units)

### CurveGraduated (amount-bearing)

- `seriesId`: string
- `raised`: decimal string (base units / WAD / units)
- `unitsOutstanding`: decimal string (base units / WAD / units)

## Commands

User commands are built into unsigned transactions for the user's wallet (`ChainPort.build`). Service commands are submitted by the backend's own low-privilege roles (`ChainPort.submit` as `keeper` or `allowlistManager`). Admin commands are built for the protocol multisig. The router command is posted by a registered tier-1 split router contract.

### User commands

- **registerIssuer**
- **createSeries**: `terms`: object { stablecoin: `USDC` \| `USDG`, stablecoinMint: string, unitsOffered: decimal string (base units / WAD / units), reservePrice: decimal string (base units / WAD / units), minimumRaise: decimal string (base units / WAD / units), capMultipleWad: decimal string (base units / WAD / units), lockupSeconds: integer, releaseSchedule: array of object { afterSeconds: integer, bps: integer }, auctionFeeBps: integer, payoutFeeBps: integer, hurdleWad: decimal string (base units / WAD / units), payoutMultipleK: integer, walletCapBps: integer, dueDays: integer, graceDays: integer, formalNoticeDays: integer, contractHash: hex32, termsCommitment: hex32, tierFlags: object { tier1: boolean, tier2: boolean, tier3: boolean, tier4: boolean }, reportingCurrency: string, raiseStyle: `sealed` \| `curve` }; `seriesAddressHint?`: string
- **openRaise**: `seriesId`: string; `commitEndsAt`: integer; `revealEndsAt`: integer
- **cancelRaise**: `seriesId`: string
- **commitBid**: `seriesId`: string; `commitment`: hex32; `deposit`: decimal string (base units / WAD / units)
- **revealBid**: `seriesId`: string; `pricePerUnit`: decimal string (base units / WAD / units); `quantity`: decimal string (base units / WAD / units); `salt`: hex32
- **claimRefund**: `seriesId`: string
- **drawRelease**: `seriesId`: string
- **pauseReleases**: `seriesId`: string; `paused`: boolean
- **submitReport**: `seriesId`: string; `periodId`: period id (YYYYQn); `tier`: `1` \| `2` \| `3` \| `4`; `paymentStable`: decimal string (base units / WAD / units); `priorIncomeCommitment`: hex32; `incomeCommitment`: hex32; `fxBasis`: `accumulator` \| `attestor` \| `unity`; `fxAvgWad`: decimal string (base units / WAD / units); `pair`: pair (XXX/USD) \| null; `attestorRate`: object { attestor: string, rateWad: decimal string (base units / WAD / units), pair: pair (XXX/USD) } \| null; `proof`: object { system: `groth16-bn254`, proof: object { pi_a: array of decimal string (field element), pi_b: array of array of decimal string (field element), pi_c: array of decimal string (field element), protocol: `groth16`, curve: `bn128` }, publicInputs: array of decimal string (field element) } \| object { system: `mock`, proof: string, publicInputs: array of decimal string (field element) }; `attestation`: object { keyId: string, seriesId: string, periodId: period id (YYYYQn), priorIncomeCommitment: hex32, incomeCommitment: hex32, tier: `1` \| `2` \| `3` \| `4`, liquidityEvent: boolean, signature: string } \| null; `attestor`: string \| null; `liquidityEvent`: boolean
- **payIn**: `seriesId`: string; `periodId`: period id (YYYYQn); `amount`: decimal string (base units / WAD / units)
- **claimPayout**: `seriesId`: string
- **requestPause**: `seriesId`: string; `until`: integer
- **approvePause**: `seriesId`: string; `until`: integer
- **redeem**: `seriesId`: string; `maxPricePerUnit`: decimal string (base units / WAD / units)
- **claimRedemption**: `seriesId`: string
- **amendTerms**: `seriesId`: string; `termsCommitment`: hex32; `capMultipleWad`: decimal string (base units / WAD / units); `attestor`: string
- **extinguish**: `seriesId`: string; `attestors`: array of string
- **commitWindowOrder**: `seriesId`: string; `windowId`: integer; `side`: `buy` \| `sell`; `commitment`: hex32; `deposit`: decimal string (base units / WAD / units); `units`: decimal string (base units / WAD / units)
- **revealWindowOrder**: `seriesId`: string; `windowId`: integer; `side`: `buy` \| `sell`; `pricePerUnit`: decimal string (base units / WAD / units); `quantity`: decimal string (base units / WAD / units); `salt`: hex32
- **buyCurve**: `seriesId`: string; `amountIn`: decimal string (base units / WAD / units); `minUnitsOut`: decimal string (base units / WAD / units)
- **stopIssuance**

### Service commands (keeper / allowlist manager)

- **settleAuction**: `seriesId`: string
- **snapshotRate**: `pair`: pair (XXX/USD); `rateWad`: decimal string (base units / WAD / units); `confWad`: decimal string (base units / WAD / units); `publishTime`: integer; `update`: string \| null
- **crankStatus**: `seriesId`: string
- **crankBurn**: `seriesId`: string; `holders`: array of string
- **crankPause**: `seriesId`: string
- **openTransferWindow**: `seriesId`: string; `commitEndsAt`: integer; `revealEndsAt`: integer
- **clearTransferWindow**: `seriesId`: string; `windowId`: integer
- **flagFxFallback**: `pair`: pair (XXX/USD); `periodId`: period id (YYYYQn); `reason`: `coverage` \| `deviation`
- **graduateCurve**: `seriesId`: string
- **setAllowlist**: `wallet`: string; `allowed`: boolean

### Admin commands (multisig)

- **registerAttestor**: `attestor`: string; `active`: boolean
- **registerVerifierKey**: `keyId`: string; `publicKey`: string; `active`: boolean
- **pauseNewRaises**: `paused`: boolean
- **setFeeCollector**: `feeCollector`: string
- **registerSplitRouter**: `seriesId`: string; `router`: string

### Router commands

- **postSplitReceipt**: `seriesId`: string; `amount`: decimal string (base units / WAD / units)

## Additions beyond the Part D2 list

- Events: `IssuanceStopped` (C11.5), `VerifierKeyRegistered` (admin registers report-verifier keys).
- Commands: `registerIssuer`, `stopIssuance`, `pauseReleases` (the issuer's own pause, C11.1), `crankPause`, `flagFxFallback`, `clearTransferWindow`, `commitWindowOrder`, `revealWindowOrder`, `buyCurve`, `graduateCurve`, `registerVerifierKey`, `pauseNewRaises`, `setFeeCollector`, `registerSplitRouter`, `postSplitReceipt`.
- Each addition closes a gap between the D2 list and Part C; Stage 1 wins on names and shapes, recorded in `INTERFACE_DRIFT.md`.
