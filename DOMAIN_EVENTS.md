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
- `terms`: object { stablecoin: `USDC` \| `USDG`, stablecoinMint: string, unitsOffered: decimal string (base units / WAD / units), reservePrice: decimal string (base units / WAD / units), minimumRaise: decimal string (base units / WAD / units), capMultipleWad: decimal string (base units / WAD / units), lockupSeconds: integer, releaseSchedule: array of object { afterSeconds: integer, bps: integer }, auctionFeeBps: integer, payoutFeeBps: integer, hurdleWad: decimal string (base units / WAD / units), payoutMultipleK: integer, walletCapBps: integer, nonRevealChargeBps: integer, commitDurationSeconds: integer, revealDurationSeconds: integer, dueDays: integer, graceDays: integer, formalNoticeDays: integer, contractHash: hex32, termsCommitment: hex32, tierFlags: object { tier1: boolean, tier2: boolean, tier3: boolean, tier4: boolean }, reportingCurrency: string, raiseStyle: `sealed` \| `curve` }

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
- `valid`: boolean

### AuctionSettled (amount-bearing)

- `seriesId`: string
- `clearingPrice`: decimal string (base units / WAD / units)
- `unitsSold`: decimal string (base units / WAD / units)
- `proceeds`: decimal string (base units / WAD / units)
- `totalFees?`: decimal string (base units / WAD / units)
- `settledAt`: integer

### AuctionFailed (amount-bearing)

- `seriesId`: string
- `reason`: `NoValidBids` \| `MinRaise`
- `clearingPrice`: decimal string (base units / WAD / units)
- `unitsSold`: decimal string (base units / WAD / units)
- `proceeds`: decimal string (base units / WAD / units)
- `minimumRaise`: decimal string (base units / WAD / units)

### BidRefunded (amount-bearing)

- `seriesId`: string
- `bidder`: string
- `amount`: decimal string (base units / WAD / units)

### UnitsMinted

- `seriesId`: string
- `holder`: string
- `units`: decimal string (base units / WAD / units)

### SettlementProposed (amount-bearing)

- `seriesId`: string
- `clearingPrice`: decimal string (base units / WAD / units)
- `round`: integer

### SettlementRejected (amount-bearing)

- `seriesId`: string
- `round`: integer
- `clearingPrice`: decimal string (base units / WAD / units)
- `reason`: `ClaimMismatch` \| `InvalidClearingPrice`

### UnitsAllocated (amount-bearing)

- `seriesId`: string
- `bidder`: string
- `units`: decimal string (base units / WAD / units)
- `cost`: decimal string (base units / WAD / units)
- `fee`: decimal string (base units / WAD / units)
- `refund`: decimal string (base units / WAD / units)

### BidDelivered (amount-bearing)

- `seriesId`: string
- `bidder`: string
- `units`: decimal string (base units / WAD / units)
- `refund`: decimal string (base units / WAD / units)

### RaiseMintFinalized (amount-bearing)

- `seriesId`: string
- `unitsSold`: decimal string (base units / WAD / units)
- `proceeds`: decimal string (base units / WAD / units)

### HolderRegistered

- `seriesId`: string
- `holder`: string

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
- `issuePrice`: decimal string (base units / WAD / units)

## Commands

User commands are built into unsigned transactions for the user's wallet (`ChainPort.build`). Service commands are submitted by the backend's own low-privilege roles (`ChainPort.submit` as `keeper` or `allowlistManager`). Permissionless commands (Stage 1's sealed-bid settlement and holder registration) may be sent by anyone: the keeper submits them (`ChainPort.submit`) and any wallet may build and sign them (`ChainPort.build`). Admin commands are built for the protocol multisig. The router command is posted by a registered tier-1 split router contract.

### User commands

- **registerIssuer**
- **createSeries**: `terms`: object { stablecoin: `USDC` \| `USDG`, stablecoinMint: string, unitsOffered: decimal string (base units / WAD / units), reservePrice: decimal string (base units / WAD / units), minimumRaise: decimal string (base units / WAD / units), capMultipleWad: decimal string (base units / WAD / units), lockupSeconds: integer, releaseSchedule: array of object { afterSeconds: integer, bps: integer }, auctionFeeBps: integer, payoutFeeBps: integer, hurdleWad: decimal string (base units / WAD / units), payoutMultipleK: integer, walletCapBps: integer, nonRevealChargeBps: integer, commitDurationSeconds: integer, revealDurationSeconds: integer, dueDays: integer, graceDays: integer, formalNoticeDays: integer, contractHash: hex32, termsCommitment: hex32, tierFlags: object { tier1: boolean, tier2: boolean, tier3: boolean, tier4: boolean }, reportingCurrency: string, raiseStyle: `sealed` \| `curve` }; `seriesAddressHint?`: string
- **openRaise**: `seriesId`: string
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

### Permissionless commands (keeper `submit` or any wallet `build`)

- **beginSettlement**: `seriesId`: string; `clearingPrice`: decimal string (base units / WAD / units); `qAboveClaim`: decimal string (base units / WAD / units); `qAtClaim`: decimal string (base units / WAD / units)
- **tallyBids**: `seriesId`: string; `maxBids?`: integer
- **finalizeSettlement**: `seriesId`: string
- **processBid**: `seriesId`: string; `bidder`: string
- **deliverBid**: `seriesId`: string; `bidder`: string
- **registerHolder**: `seriesId`: string; `wallet`: string

### Admin commands (multisig)

- **registerAttestor**: `attestor`: string; `active`: boolean
- **registerVerifierKey**: `keyId`: string; `publicKey`: string; `active`: boolean
- **pauseNewRaises**: `paused`: boolean
- **setFeeCollector**: `feeCollector`: string
- **registerSplitRouter**: `seriesId`: string; `router`: string

### Router commands

- **postSplitReceipt**: `seriesId`: string; `amount`: decimal string (base units / WAD / units)

## Additions beyond the Part D2 list

- Events: `IssuanceStopped` (C11.5), `VerifierKeyRegistered` (admin registers report-verifier keys); Stage 1's settlement events with Stage 1's names (S2): `SettlementProposed`, `SettlementRejected`, `UnitsAllocated`, `BidDelivered`, `RaiseMintFinalized`, `HolderRegistered`.
- Commands: `registerIssuer`, `stopIssuance`, `pauseReleases` (the issuer's own pause, C11.1), `crankPause`, `flagFxFallback`, `clearTransferWindow`, `commitWindowOrder`, `revealWindowOrder`, `buyCurve`, `graduateCurve`, `registerVerifierKey`, `pauseNewRaises`, `setFeeCollector`, `registerSplitRouter`, `postSplitReceipt`; the permissionless group with Stage 1's names (S2).
- Each addition closes a gap between the D2 list and Part C; Stage 1 wins on names and shapes, recorded in `INTERFACE_DRIFT.md`.

## Meanings on Stage 1 (since S1)

The shapes above are generated; these meanings changed in S1, when the simulator moved to Stage 1's rules (SPEC v1.1.2; Stage 1 wins for onchain behaviour). `ASSUMPTIONS.md` and `STAGE1_INTEGRATION.md` carry the details and the divergences still open.

- **Errors.** Every `ChainError` raised on a Stage 1 path carries `detail.stage1`, Stage 1's error name (SPEC §11); the API returns it with the error.
- **Sealed-bid settlement (S2).** Stage 1's multi-step settlement with its names: `beginSettlement` proposes a clearing price with the proposer's tally claims (`SettlementProposed`; the raise is `Settling`), `tallyBids` tallies pages of revealed bids (at most `ChainInfo.limits.tallyPageMax` each), `finalizeSettlement` settles (`AuctionSettled`), fails (`AuctionFailed`: NoValidBids, or MinRaise with the would-be price, units and proceeds) or rejects the round (`SettlementRejected`, and a new round may be proposed), `processBid` moves each bid's cost and fee to protocol accounts (`UnitsAllocated` for a winner; the last one finalises the mint, `RaiseMintFinalized`) and `deliverBid` pays the bidder its units and refund (`BidDelivered`). `registerHolder` registers an allowlisted wallet as a holder; `HolderRegistered` marks any wallet's first registration (by `registerHolder`, a winning `processBid` or a window purchase). Anyone may send them; `nextSettlementStep` plans them from the stored raise state (`AuctionState.raiseState`). A raise that would sell 0 units fails (MinRaise), as SPEC and both chains do. `BidRevealed.valid` records the validity Stage 1 fixes at reveal (an invalid bid is refunded in full). The one-step `settleAuction` and `claimRefund` remain only as deprecated composites over these steps until their callers move (S2).
- **Raise phases and `openRaise` (S2).** `commitDurationSeconds` and `revealDurationSeconds` are series terms (Stage 1 bounds a sealed raise to 1 hour–30 days and 1 hour–7 days); `openRaise` takes the series only and sets the commit end to now + the commit duration and the reveal end to the commit end + the reveal duration (Stage 1 `open_raise`). `nonRevealChargeBps` is recorded at creation (0–1,000 bps on a sealed raise), but the charge is an owner hold: new series record 0, and 0 applies whatever a series records (`NON_REVEAL_CHARGE_HELD`).
- **`SeriesTerms` deadlines.** Counted in unpaused time from the period end: OnTime while the countdown is ≤ `dueDays`, InGrace while ≤ `dueDays + graceDays`, then Late (inclusive bounds). `formalNoticeDays` counts from the **period end** (Stage 1 `formalNoticeDue`; 90 = period end + 90 days).
- **`submitReport`.** Reports are strictly sequential (the next expected period, once ended, with no unpaid due). `priorIncomeCommitment` is the income commitment the report chains from (the previous quarter's in the same year; ZERO at a year start; a series' first report outside Q1 supplies its own, bound only by the attestation, Stage 1 A25); the chain checks the proof against the series' live terms commitment, so the command carries none. `proof` is Stage 1's Groth16 proof (`groth16-bn254`) or, only on a simulator configured for it, the mock digest; either way with Stage 1's six public inputs `[terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd]`. Commitments are Stage 1's Poseidon: terms over (θ, r, currency code, indexing rule, salt), income over (year-to-date figure, salt).
- **Verifier attestation (tier 2).** Attestation v1 over series, period, prior and income commitments, tier and `liquidityEvent`; never the income source.
- **`ReportAccepted`.** `paymentDue` is the due the report opened (the payment less tier-1 split credit; 0 for a tail report that is not a liquidity event), without accrual; `accrual` is always "0"; `priorIncomeCommitment` is the commitment it chained from.
- **`payIn` and `PaymentReceived`.** `payIn` pays the open due in full: `periodId` names the open due period and `amount` is the due plus Stage 1's lateness accrual when the payment lands; anyone may pay (NothingDue when nothing is open). `PaymentReceived.gross` is what the vault accepted; from a pay-in it carries the final `paymentDue` (due + accrual) and `accrual`; `source: 'tail'` is a tail payment (its own accumulator, outside the payout vault totals); `source: 'extinguishment'` is the unvested treasury returned through the final pool (fee 0, not an issuer payment).
- **Pauses.** `requestPause.until` and `PauseRequested.until` are advisory (Stage 1's request has no end); `approvePause` sets the pause end within Stage 1's bounds, and a pause ends by itself at that end.
- **`claimPayout`.** Pays the net payout and, after a redemption or an extinguishment, the tail and the holder's final-pool share (S3 splits them into their own commands). A holder that is not registered is refused; a zero claim succeeds with no transfer, and on a Retired or Extinguished series it still burns the holder's units.
- **`extinguish`.** Refused unless the raise settled (RaiseNotSettled); only the unvested treasury returns to holders, and the issuer's estate may still draw the vested tranches.
