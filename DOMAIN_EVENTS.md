# DOMAIN_EVENTS.md — canonical domain model v0

Generated from `packages/domain/src/{events,commands}.ts` by `pnpm docs:events`; the machine-readable form is `packages/domain/schema/domain-v0.schema.json` (JSON Schema 2020-12). Live adapters map whatever Stage 1 emits and accepts onto exactly these shapes; differences are recorded in `INTERFACE_DRIFT.md` by `stage1:sync`, never papered over.

## Conventions

- Identifiers are chain-neutral strings: `seriesId = "<chain>:<address>"`, `issuerId = "<chain>:<address>"`. EVM addresses are lowercase; Solana addresses are base58.
- Money is a decimal string in stablecoin base units (6 decimals for USDC and USDG, verified from the mint). Ratios are decimal strings in 1e18 fixed point (WAD). Unit counts are decimal strings. Never floating point.
- Timestamps are unix seconds. Periods are calendar quarters in UTC, written `YYYYQn`.
- Every event is wrapped in an envelope: `chain`, `cursor` (opaque, ordered within a chain), `seq` (monotonic per chain), `blockTime`, `blockRef`, `txId`, `finality` (`finalized` | `confirmed`), `type`, `payload`. Only `finalized` events reach money-bearing read models.
- Events marked **amount-bearing** never appear in the public activity feed with amounts (R28).

## Events

### RouterIncomeHeld

- `seriesId`: string

### RouterIncomeRouted

- `seriesId`: string

### RouterPeriodClosed

- `seriesId`: string
- `periodId`: period id (YYYYQn)

### FxPairSet

- `pairId`: hex32
- `feedId`: hex32
- `inverted`: boolean
- `crosscheck`: string \| null
- `effectivePeriod`: period id (YYYYQn)

### IssuerRegistered

- `issuer`: string

### IssuanceResumed

- `issuer`: string

### IssuanceStopped

- `issuer`: string

### SeriesCreated

- `seriesId`: string
- `issuer`: string
- `terms`: object { routerTerms: object { theta: decimal string (base units / WAD / units), rWad: decimal string (base units / WAD / units), currencyCode: integer, indexingRule: integer, termsSalt: decimal string (base units / WAD / units) }, fxPairId: hex32 \| null, stablecoin: `USDC` \| `USDG`, stablecoinMint: string, unitsOffered: decimal string (base units / WAD / units), reservePrice: decimal string (base units / WAD / units), minimumRaise: decimal string (base units / WAD / units), capMultipleWad: decimal string (base units / WAD / units), lockupSeconds: integer, releaseSchedule: array of object { afterSeconds: integer, bps: integer }, auctionFeeBps: integer, payoutFeeBps: integer, hurdleWad: decimal string (base units / WAD / units), payoutMultipleK: integer, walletCapBps: integer, nonRevealChargeBps: integer, commitDurationSeconds: integer, revealDurationSeconds: integer, windowCommitDuration: integer, windowRevealDuration: integer, windowFeeBps: integer, dueDays: integer, graceDays: integer, formalNoticeDays: integer, contractHash: hex32, termsCommitment: hex32, tierFlags: object { tier1: boolean, tier2: boolean, tier3: boolean, tier4: boolean }, reportingCurrency: string, raiseStyle: `sealed` \| `curve` }

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
- `settledAt`: integer

### AuctionFailed (amount-bearing)

- `seriesId`: string
- `reason`: `NoValidBids` \| `MinRaise`
- `clearingPrice`: decimal string (base units / WAD / units)
- `unitsSold`: decimal string (base units / WAD / units)
- `proceeds`: decimal string (base units / WAD / units)
- `minimumRaise`: decimal string (base units / WAD / units)

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

### NonRevealCharged (amount-bearing)

- `seriesId`: string
- `bidder`: string
- `charge`: decimal string (base units / WAD / units)

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

### TrueUpRecorded (amount-bearing)

- `seriesId`: string
- `year`: integer
- `adjustment`: string
- `deadline`: integer

### TrueUpPaid (amount-bearing)

- `seriesId`: string
- `amount`: decimal string (base units / WAD / units)
- `accrual`: decimal string (base units / WAD / units)

### TrueUpNoticeDue

- `seriesId`: string
- `year`: integer

### FeeTaken (amount-bearing)

- `seriesId`: string
- `kind`: `auction` \| `payout` \| `curveTrading` \| `nonReveal` \| `window`
- `amount`: decimal string (base units / WAD / units)
- `payer`: string

### PayoutClaimed (amount-bearing)

- `seriesId`: string
- `holder`: string
- `amount`: decimal string (base units / WAD / units)
- `burnedUnits`: decimal string (base units / WAD / units)

### TailClaimed (amount-bearing)

- `seriesId`: string
- `holder`: string
- `amount`: decimal string (base units / WAD / units)

### FinalClaimed (amount-bearing)

- `seriesId`: string
- `holder`: string
- `units`: decimal string (base units / WAD / units)
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
- `fromStake?`: decimal string (base units / WAD / units)

### TailPayout (amount-bearing)

- `seriesId`: string
- `periodId`: period id (YYYYQn)
- `perUnit`: decimal string (base units / WAD / units)
- `total`: decimal string (base units / WAD / units)

### PauseRequested

- `seriesId`: string
- `nonce`: decimal string (base units / WAD / units)

### PauseApproved

- `seriesId`: string
- `attestor`: string
- `start`: integer
- `until`: integer

### PauseRequestWithdrawn

- `seriesId`: string
- `nonce`: decimal string (base units / WAD / units)

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

- `routerTerms?`: object { theta: decimal string (base units / WAD / units), rWad: decimal string (base units / WAD / units), currencyCode: integer, indexingRule: integer, termsSalt: decimal string (base units / WAD / units) }
- `seriesId`: string
- `termsCommitment`: hex32
- `previousCommitment`: hex32
- `capMultipleWad`: decimal string (base units / WAD / units)
- `attestor`: string
- `nonce`: decimal string (base units / WAD / units)

### SeriesExtinguished (amount-bearing)

- `seriesId`: string
- `attestors`: array of string
- `returnedToHolders`: decimal string (base units / WAD / units)

### RateSnapshot

- `pair`: string
- `rateWad`: decimal string (base units / WAD / units)
- `confWad`: decimal string (base units / WAD / units)
- `publishTime`: integer
- `dayIndex`: integer
- `sumWad`: decimal string (base units / WAD / units)
- `count`: integer

### FxFallbackFlagged

- `pair`: string
- `periodId`: period id (YYYYQn)
- `reason`: `coverage` \| `deviation`

### ProtocolFlagsSet

- `newRaisesPaused`: boolean
- `windowsEnabled`: boolean
- `tier4Enabled`: boolean

### WindowOrderCommitted (amount-bearing)

- `seriesId`: string
- `windowId`: integer
- `owner`: string
- `side`: `buy` \| `sell`
- `commitment`: hex32
- `escrow`: decimal string (base units / WAD / units)

### WindowOrderRevealed (amount-bearing)

- `seriesId`: string
- `windowId`: integer
- `owner`: string
- `pricePerUnit`: decimal string (base units / WAD / units)
- `quantity`: decimal string (base units / WAD / units)
- `valid`: boolean
- `revealIndex`: integer

### WindowSettlementProposed (amount-bearing)

- `seriesId`: string
- `windowId`: integer
- `clearingPrice`: decimal string (base units / WAD / units) \| null
- `round`: integer

### WindowOrdersTallied

- `seriesId`: string
- `windowId`: integer
- `round`: integer
- `talliedCount`: integer

### WindowSettlementRejected

- `seriesId`: string
- `windowId`: integer
- `round`: integer
- `reason`: string

### WindowOrderProcessed (amount-bearing)

- `seriesId`: string
- `windowId`: integer
- `owner`: string
- `side`: `buy` \| `sell`
- `fill`: decimal string (base units / WAD / units)
- `pricePerUnit`: decimal string (base units / WAD / units)
- `fee`: decimal string (base units / WAD / units)
- `refund`: decimal string (base units / WAD / units)
- `pendingUnits`: decimal string (base units / WAD / units)
- `pendingStable`: decimal string (base units / WAD / units)
- `cancelled`: boolean
- `done`: boolean

### WindowOrderDelivered (amount-bearing)

- `seriesId`: string
- `windowId`: integer
- `owner`: string
- `units`: decimal string (base units / WAD / units)
- `amount`: decimal string (base units / WAD / units)

### TransferWindowOpened

- `seriesId`: string
- `windowId`: integer
- `periodId?`: period id (YYYYQn)
- `commitEndsAt`: integer
- `revealEndsAt`: integer

### TransferWindowCleared (amount-bearing)

- `seriesId`: string
- `windowId`: integer
- `clearingPrice`: decimal string (base units / WAD / units)
- `unitsTransferred`: decimal string (base units / WAD / units)
- `done?`: boolean

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

### AttestorRevoked

- `attestor`: string
- `revokedAt`: integer

### VerifierKeyRegistered

- `verifierKey`: string

### VerifierKeyRevoked

- `verifierKey`: string
- `revokedAt`: integer

### CurveActivated (amount-bearing)

- `seriesId`: string
- `dbcConfig`: string
- `dbcPool`: string
- `baseMint`: string
- `dbcCreator`: string
- `unitsSold`: decimal string (base units / WAD / units)
- `issuePrice`: decimal string (base units / WAD / units)

### CurveGraduated (amount-bearing)

- `seriesId`: string
- `issuePrice`: decimal string (base units / WAD / units)
- `unitsSold`: decimal string (base units / WAD / units)
- `settledAt`: integer

### CurveProceedsCollected (amount-bearing)

- `seriesId`: string
- `migrationFee`: decimal string (base units / WAD / units)
- `surplus`: decimal string (base units / WAD / units)
- `tradingFee`: decimal string (base units / WAD / units)
- `proceeds`: decimal string (base units / WAD / units)

### CurveUnitsSynced

- `seriesId`: string
- `supply`: decimal string (base units / WAD / units)
- `protocolHeld`: decimal string (base units / WAD / units)
- `unitsOutstanding`: decimal string (base units / WAD / units)
- `stakedTotal`: decimal string (base units / WAD / units)

### UnitsStaked

- `seriesId`: string
- `holder`: string
- `units`: decimal string (base units / WAD / units)
- `staked`: decimal string (base units / WAD / units)

### UnitsUnstaked

- `seriesId`: string
- `holder`: string
- `units`: decimal string (base units / WAD / units)
- `staked`: decimal string (base units / WAD / units)

## Commands

User commands are built into unsigned transactions for the user's wallet (`ChainPort.build`). Service commands are submitted by the backend's own low-privilege roles (`ChainPort.submit` as `keeper` or `allowlistManager`). Permissionless commands (Stage 1's sealed-bid settlement, holder registration and the Retired burn) may be sent by anyone: the keeper submits them (`ChainPort.submit`) and any wallet may build and sign them (`ChainPort.build`). Admin commands are built for the protocol multisig. The router command is posted by a registered tier-1 split router contract.

### User commands

- **routeIncome**: `seriesId`: string; `amount`: decimal string (base units / WAD / units)
- **createSeries**: `terms`: object { routerTerms: object { theta: decimal string (base units / WAD / units), rWad: decimal string (base units / WAD / units), currencyCode: integer, indexingRule: integer, termsSalt: decimal string (base units / WAD / units) }, fxPairId: hex32 \| null, stablecoin: `USDC` \| `USDG`, stablecoinMint: string, unitsOffered: decimal string (base units / WAD / units), reservePrice: decimal string (base units / WAD / units), minimumRaise: decimal string (base units / WAD / units), capMultipleWad: decimal string (base units / WAD / units), lockupSeconds: integer, releaseSchedule: array of object { afterSeconds: integer, bps: integer }, auctionFeeBps: integer, payoutFeeBps: integer, hurdleWad: decimal string (base units / WAD / units), payoutMultipleK: integer, walletCapBps: integer, nonRevealChargeBps: integer, commitDurationSeconds: integer, revealDurationSeconds: integer, windowCommitDuration: integer, windowRevealDuration: integer, windowFeeBps: integer, dueDays: integer, graceDays: integer, formalNoticeDays: integer, contractHash: hex32, termsCommitment: hex32, tierFlags: object { tier1: boolean, tier2: boolean, tier3: boolean, tier4: boolean }, reportingCurrency: string, raiseStyle: `sealed` \| `curve` }; `seriesAddressHint?`: string
- **openRaise**: `seriesId`: string
- **cancelRaise**: `seriesId`: string
- **commitBid**: `seriesId`: string; `commitment`: hex32; `deposit`: decimal string (base units / WAD / units)
- **revealBid**: `seriesId`: string; `pricePerUnit`: decimal string (base units / WAD / units); `quantity`: decimal string (base units / WAD / units); `salt`: hex32
- **drawRelease**: `seriesId`: string
- **pauseReleases**: `seriesId`: string; `paused`: boolean
- **submitReport**: `seriesId`: string; `periodId`: period id (YYYYQn); `tier`: `1` \| `2` \| `3` \| `4`; `paymentStable`: decimal string (base units / WAD / units); `priorIncomeCommitment`: hex32; `incomeCommitment`: hex32; `fxBasis?`: `accumulator` \| `attestor` \| `unity`; `fxAvgWad`: decimal string (base units / WAD / units); `pair?`: string \| null; `fxFallback`: object { signer: string, signature: string } \| null; `proof`: object { system: `groth16-bn254`, proof: object { pi_a: array of decimal string (field element), pi_b: array of array of decimal string (field element), pi_c: array of decimal string (field element), protocol: `groth16`, curve: `bn128` }, publicInputs: array of decimal string (field element) } \| object { system: `mock`, proof: string, publicInputs: array of decimal string (field element) }; `attestation`: object { signer: string, signature: string } \| null; `liquidityEvent`: boolean
- **payIn**: `seriesId`: string; `periodId?`: period id (YYYYQn); `amount?`: decimal string (base units / WAD / units)
- **submitTrueUp**: `seriesId`: string; `year`: integer; `adjustment`: string; `attestationTs`: string; `attestor`: string; `signature`: string
- **payTrueUp**: `seriesId`: string
- **claimPayout**: `seriesId`: string
- **claimTail**: `seriesId`: string
- **claimFinal**: `seriesId`: string
- **requestPause**: `seriesId`: string
- **endPause**: `seriesId`: string
- **transferUnits**: `seriesId`: string; `to`: string; `units`: decimal string (base units / WAD / units)
- **withdrawPauseRequest**: `seriesId`: string
- **redeem**: `seriesId`: string; `maxPricePerUnit?`: decimal string (base units / WAD / units)
- **claimRedemption**: `seriesId`: string
- **amendTerms**: `routerTerms?`: object { theta: decimal string (base units / WAD / units), rWad: decimal string (base units / WAD / units), currencyCode: integer, indexingRule: integer, termsSalt: decimal string (base units / WAD / units) }; `seriesId`: string; `termsCommitment`: hex32; `capMultipleWad`: decimal string (base units / WAD / units); `attestor`: string; `signature`: string
- **commitWindowOrder**: `seriesId`: string; `windowId`: integer; `side`: `buy` \| `sell`; `commitment`: hex32; `deposit`: decimal string (base units / WAD / units); `units`: decimal string (base units / WAD / units)
- **revealWindowOrder**: `seriesId`: string; `windowId`: integer; `side`: `buy` \| `sell`; `pricePerUnit`: decimal string (base units / WAD / units); `quantity`: decimal string (base units / WAD / units); `salt`: hex32
- **curveSwap**: `seriesId`: string; `side`: `buy` \| `sell`; `amountIn`: decimal string (base units / WAD / units); `minimumAmountOut`: decimal string (base units / WAD / units)
- **stakeUnits**: `seriesId`: string; `units`: decimal string (base units / WAD / units)
- **unstakeUnits**: `seriesId`: string; `units`: decimal string (base units / WAD / units)
- **tenderUnits**: `seriesId`: string; `fromStake`: decimal string (base units / WAD / units); `fromWallet`: decimal string (base units / WAD / units)
- **resumeIssuance**
- **stopIssuance**

### Service commands (keeper / allowlist manager)

- **snapshotRate**: `pair`: string; `rateWad`: decimal string (base units / WAD / units); `confWad`: decimal string (base units / WAD / units); `publishTime`: integer; `update`: string \| null
- **crankStatus**: `seriesId`: string
- **crankPause**: `seriesId`: string
- **openTransferWindow**: `seriesId`: string; `commitEndsAt`: integer; `revealEndsAt`: integer
- **clearTransferWindow**: `seriesId`: string; `windowId`: integer
- **flagFxFallback**: `pair`: string; `periodId`: period id (YYYYQn); `reason`: `coverage` \| `deviation`
- **setAllowlist**: `wallet`: string; `allowed`: boolean

### Permissionless commands (keeper `submit` or any wallet `build`)

- **sweepRouter**: `seriesId`: string
- **closeRouterPeriod**: `seriesId`: string; `periodId`: period id (YYYYQn)
- **openWindow**: `seriesId`: string; `periodId`: period id (YYYYQn)
- **beginWindowSettlement**: `seriesId`: string; `windowId`: integer; `clearingPrice`: decimal string (base units / WAD / units) \| null
- **tallyWindow**: `seriesId`: string; `windowId`: integer; `maxOrders`: integer
- **finalizeWindow**: `seriesId`: string; `windowId`: integer
- **processOrder**: `seriesId`: string; `windowId`: integer; `owner`: string
- **deliverOrder**: `seriesId`: string; `windowId`: integer; `owner`: string
- **snapshotFx**: `pairId`: hex32; `price`: string; `conf`: string; `expo`: integer; `publishTime`: string; `crosscheckPrice?`: string; `crosscheckExpo?`: integer; `crosscheckPublishTime?`: string; `updates?`: array of string
- **retireIfCapped**: `seriesId`: string
- **beginSettlement**: `seriesId`: string; `clearingPrice`: decimal string (base units / WAD / units); `qAboveClaim`: decimal string (base units / WAD / units); `qAtClaim`: decimal string (base units / WAD / units)
- **tallyBids**: `seriesId`: string; `maxBids?`: integer
- **finalizeSettlement**: `seriesId`: string
- **processBid**: `seriesId`: string; `bidder`: string
- **deliverBid**: `seriesId`: string; `bidder`: string
- **registerHolder**: `seriesId`: string; `wallet`: string
- **burnRetired**: `seriesId`: string; `holder`: string
- **completeCurve**: `seriesId`: string
- **collectCurveProceeds**: `seriesId`: string
- **syncCurveUnits**: `seriesId`: string
- **approvePause**: `seriesId`: string; `pauseEnd`: string; `attestor`: string; `signature`: string
- **extinguish**: `seriesId`: string; `attestorA`: string; `signatureA`: string; `attestorB`: string; `signatureB`: string

### Admin commands (multisig)

- **setFlags**: `newRaisesPaused?`: boolean; `windowsEnabled?`: boolean; `tier4Enabled?`: boolean
- **setFxPair**: `feedId`: hex32; `inverted`: boolean; `crosscheck`: string \| null
- **registerIssuer**: `wallet`: string
- **registerAttestor**: `attestor`: string
- **revokeAttestor**: `attestor`: string
- **rotateAttestor**: `from`: string; `to`: string
- **registerVerifierKey**: `key`: string
- **revokeVerifierKey**: `key`: string
- **rotateVerifierKey**: `from`: string; `to`: string
- **pauseNewRaises**: `paused`: boolean
- **setFeeCollector**: `feeCollector`: string
- **registerSplitRouter**: `seriesId`: string; `router`: string

### Router commands

- **postSplitReceipt**: `seriesId`: string; `amount`: decimal string (base units / WAD / units)

## Additions beyond the Part D2 list

- Events: `IssuanceStopped` (C11.5), `VerifierKeyRegistered` (admin registers report-verifier keys); Stage 1's settlement events with Stage 1's names (S2): `SettlementProposed`, `SettlementRejected`, `UnitsAllocated`, `BidDelivered`, `RaiseMintFinalized`, `HolderRegistered`; Stage 1's claim events (S3): `TailClaimed`, `FinalClaimed`; Stage 1's curve events (S3): `CurveActivated`, `CurveProceedsCollected`, `CurveUnitsSynced`, `UnitsStaked`, `UnitsUnstaked`; Stage 1's key registry (S4): `AttestorRevoked`, `VerifierKeyRevoked`.
- Commands: `registerIssuer`, `stopIssuance`, `pauseReleases` (the issuer's own pause, C11.1), `crankPause`, `flagFxFallback`, `clearTransferWindow`, `commitWindowOrder`, `revealWindowOrder`, `curveSwap` (a Meteora DBC swap on live chains, not a Merces instruction), `registerVerifierKey`, `pauseNewRaises`, `setFeeCollector`, `registerSplitRouter`, `postSplitReceipt`; the permissionless group with Stage 1's names (S2); Stage 1's claims `claimTail` and `claimFinal`, the permissionless `burnRetired`, a curve's permissionless `completeCurve`, `collectCurveProceeds` and `syncCurveUnits`, and its holders' `stakeUnits`, `unstakeUnits` and `tenderUnits` (S3); Stage 1's key registry (S4): `revokeAttestor`, `rotateAttestor`, `revokeVerifierKey`, `rotateVerifierKey` (rotation is one EVM call; on Solana two instructions in one transaction).
- Each addition closes a gap between the D2 list and Part C; Stage 1 wins on names and shapes, recorded in `INTERFACE_DRIFT.md`.

## Meanings on Stage 1 (since S1)

The shapes above are generated; these meanings changed in S1, when the simulator moved to Stage 1's rules (SPEC v1.1.2; Stage 1 wins for onchain behaviour). `ASSUMPTIONS.md` and `STAGE1_INTEGRATION.md` carry the details and the divergences still open.

- **Errors.** Every `ChainError` raised on a Stage 1 path carries `detail.stage1`, Stage 1's error name (SPEC §11); the API returns it with the error.
- **Sealed-bid settlement (S2).** Stage 1's multi-step settlement with its names: `beginSettlement` proposes a clearing price with the proposer's tally claims (`SettlementProposed`; the raise is `Settling`), `tallyBids` tallies pages of revealed bids (at most `ChainInfo.limits.tallyPageMax` each), `finalizeSettlement` settles (`AuctionSettled`), fails (`AuctionFailed`: NoValidBids, or MinRaise with the would-be price, units and proceeds) or rejects the round (`SettlementRejected`, and a new round may be proposed), `processBid` moves each bid's cost and fee to protocol accounts (`UnitsAllocated` for a winner; the last one finalises the mint, `RaiseMintFinalized`) and `deliverBid` pays the bidder its units and refund (`BidDelivered`). `registerHolder` registers an allowlisted wallet as a holder; `HolderRegistered` marks any wallet's first registration (by `registerHolder`, a winning `processBid` or a window purchase). Anyone may send them; `nextSettlementStep` plans them from the stored raise state (`AuctionState.raiseState`). A raise that would sell 0 units fails (MinRaise), as SPEC and both chains do. `BidRevealed.valid` records the validity Stage 1 fixes at reveal (an invalid bid is refunded in full). `AuctionSettled` carries Stage 1's RaiseSettled fields only: each winner's fee and cost move when it is processed (`FeeTaken{kind: auction}` and `TreasuryFunded` per winner). There is no one-step settlement and no pull refund: a bid's refund and units are pushed by `deliverBid` (the keepers deliver every bid; any wallet may deliver one), and no Merces event mints units on a curve (a curve trade is Meteora's). A bid committed and never revealed pays the series' non-reveal charge when the raise settles (Stage 1 `process_bid`: `floor(escrow × nonRevealChargeBps / 10000)` to the protocol fee collector, the rest refunded at delivery): `NonRevealCharged` and `FeeTaken{kind: nonReveal}` when it is above 0; a failed raise and a revealed bid, valid or not, are never charged.
- **Raise phases and `openRaise` (S2).** `commitDurationSeconds` and `revealDurationSeconds` are series terms (Stage 1 bounds a sealed raise to 1 hour–30 days and 1 hour–7 days); `openRaise` takes the series only and sets the commit end to now + the commit duration and the reveal end to the commit end + the reveal duration (Stage 1 `open_raise`). `nonRevealChargeBps` is the series' own non-reveal charge, frozen at creation and bounded to 0–1,000 bps (Stage 1); there is no built-in rate: series built through the terms service take the owner's setting (`MERCES_NON_REVEAL_CHARGE_BPS`), which issuers cannot change, and no sealed series is built while it is unset (S3 follow-up NRC).
- **`SeriesTerms` deadlines.** Counted in unpaused time from the period end: OnTime while the countdown is ≤ `dueDays`, InGrace while ≤ `dueDays + graceDays`, then Late (inclusive bounds). `formalNoticeDays` counts from the **period end** (Stage 1 `formalNoticeDue`; 90 = period end + 90 days).
- **`submitReport`.** Reports are strictly sequential (the next expected period, once ended, with no unpaid due). `priorIncomeCommitment` is the income commitment the report chains from (the previous quarter's in the same year; ZERO at a year start; a series' first report outside Q1 supplies its own, bound only by the attestation, Stage 1 A25); the chain checks the proof against the series' live terms commitment, so the command carries none. `proof` is Stage 1's Groth16 proof (`groth16-bn254`) or, only on a simulator configured for it, the mock digest; either way with Stage 1's six public inputs `[terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd]`. Commitments are Stage 1's Poseidon: terms over (θ, r, currency code, indexing rule, salt), income over (year-to-date figure, salt).
- **Verifier attestation (tier 2).** Since S4 WP6, Stage 1's REPORT signature: the report verifier's secp256k1 key signs `MERCES_REPORT_V1` (the chain's signing domain, the series key, the period, the prior and income commitments, tier 2, `liquidityEvent`; never the income source), and `submitReport.attestation` carries `{signer, signature}` only: the chain rebuilds the digest from its own domain and the series key, recovers the signer and requires a verifier key usable for the period (active, or revoked after the period ended within the 45-day grace), else `InvalidVerifierSignature`. Verifier keys are 20-byte addresses (`registerVerifierKey`, `revokeVerifierKey`, `rotateVerifierKey`).
- **Tier-3 attestation and the FX fallback (S4 WP9).** A tier-3 report carries an attestor key's Stage 1 REPORT signature with tier 3 in `submitReport.attestation` (else `InvalidAttestorSignature`), with the same 45-day grace for a key revoked after the period ended. When the accumulator has no usable average, `submitReport.fxFallback` carries an attestor key's `MERCES_FX_V1` signature over the series key, the period and the report's own `fxAvgWad` (`FxFallbackRequired` without it, `FxFallbackNotAllowed` with one when the average is usable, `InvalidAttestorSignature` for a signature that does not recover to a usable attestor key; both chains give it the report keys' grace, Stage 1's reference does not: DIV-S1I-3). The message binds the series key, so one rate is one signature per series. Nobody co-signs a report: the issuer sends it alone.
- **`ReportAccepted`.** `paymentDue` is the due the report opened (the payment less tier-1 split credit; 0 for a tail report that is not a liquidity event), without accrual; `accrual` is always "0"; `priorIncomeCommitment` is the commitment it chained from.
- **`payIn` and `PaymentReceived`.** `payIn` pays the open due in full: `periodId` names the open due period and `amount` is the due plus Stage 1's lateness accrual when the payment lands; anyone may pay (NothingDue when nothing is open). `PaymentReceived.gross` is what the vault accepted; from a pay-in it carries the final `paymentDue` (due + accrual) and `accrual`; `source: 'tail'` is a tail payment (its own accumulator, outside the payout vault totals); `source: 'extinguishment'` is the unvested treasury returned through the final pool (fee 0, not an issuer payment).
- **Pauses.** `requestPause` and `PauseRequested` carry no end. The private hardship review holds the requested end offchain. A pause ends at its approved end or when its issuer calls `endPause` early, returning unused duration to the lifetime allowance. Since S4 WP10 `approvePause` is Stage 1's `approve_pause`, permissionless: it carries an attestor key's `MERCES_PAUSE_V1` signature over the chain's signing domain, the series key, the series' live pause nonce (`SeriesState.nonces.pause`) and `pauseEnd` (a decimal string), and anyone may send it (the attestor signs on its own device; the keeper relays). The chain refuses an end beyond u64 first (`AmountOutOfRange`), then a signature that does not recover to `attestor` or an attestor key that is not active (`InvalidAttestorSignature`; no grace), then `PauseNotRequested`, then Stage 1's bounds. A request (`PauseRequested{nonce}`) and the issuer's `withdrawPauseRequest` (`PauseRequestWithdrawn{nonce}`, the new nonce; it clears the request) advance the nonce, so a signature over an older request is dead; an approval leaves the nonce and clears the request, so a replay is `PauseNotRequested`. `PauseApproved` names the signing key (not the sender) and the pause's `start`.
- **Amendments (S4 WP11).** `amendTerms` is Stage 1's `amend_terms`, still the issuer's transaction: it carries an attestor key's `MERCES_AMEND_V1` signature over the chain's signing domain, the series key, the series' live amendment nonce (`SeriesState.nonces.amendment`), the new terms commitment and the new cap multiple (the attestor signs on its own device; nobody co-signs). In the EVM's order the chain refuses a sender other than the issuer (`NotIssuer`), a terminal series (`AmendmentAfterTerminal`), a cap beyond u64 (`AmountOutOfRange`, before the signature is read), a signature that does not recover to `attestor` or an attestor key that is not active (`InvalidAttestorSignature`; no grace), then a cap that rises or leaves [2, 3] (`UnfavourableAmendment`). An amendment advances the nonce, so every AMEND signature over the old one is dead. `TermsAmended{attestor, nonce}` names the signing key and the nonce it signed (the value before the increment, as both chains emit it).
- **Claims (S3: Stage 1's claim family).** Every stablecoin amount a claim moves appears in exactly one event amount: `PayoutClaimed` (the net payout; inside a redemption, the pending payout and the tail catch-up), `RedemptionClaimed` (the redemption principal, units × price), `TailClaimed` (the tail), `FinalClaimed` (the pending payout and the final-pool share) and `BidDelivered` (a delivered refund). Claims need a registered holder (HolderNotRegistered), never current allowlist membership. A claim of nothing emits its own event with zeros (`PayoutClaimed{0, burned}`, `TailClaimed{0}`, `FinalClaimed{units, 0}`); the split-out `PayoutClaimed` inside a redemption appears only above 0. The read model never creates a position from a claim and records no money row for a zero amount.
- **`claimPayout`.** Stage 1 `claim`: the net payout (the holder's pending payout) and nothing else, on every status; the tail is `claimTail`'s and the final-pool share `claimFinal`'s. HolderNotRegistered for a wallet that is not a registered holder. It always emits `PayoutClaimed{amount, burnedUnits}`, zeros included (SPEC's zero-amount rule: a claim of nothing succeeds and emits its event). On a Retired series the holder's balance burns, also when nothing is paid (`burnedUnits`, then `UnitsBurned{reason: cap}`); on any other status nothing burns (an Extinguished holder's units are its final-pool weight and burn at `claimFinal`). Inside a redemption, `PayoutClaimed` carries the pending payout and the tail catch-up with `burnedUnits` 0, and is emitted only above 0.
- **`claimTail`.** Stage 1 `claim_tail`: NotRedeemed until the issuer redeemed (the redemption time only, not the status); HolderNotRegistered; a holder that has redeemed nothing and still has units is redeemed first (the redemption body: `PayoutClaimed`, `UnitsBurned`, `RedemptionClaimed`); NoRedeemedUnits when it has still redeemed nothing (a holder registered late with no units). It pays the tail on its redeemed units since its tail cursor and emits `TailClaimed{amount}`, the tail only, also when it is 0.
- **`claimFinal`.** Stage 1 `claim_final`: TerminalStatus unless the series is Extinguished; a pending auction bid is delivered first; HolderNotRegistered. On a series that redeemed, the holder's remaining units are redeemed first and its share is weighed on its redeemed units plus its units held for an uncleared window ask (both Stage 1 chains; Stage 1's TS reference leaves those out: DIV-S1I-1); otherwise on its accrual units (undelivered auction units and window-ask units included). It pays the pending payout plus the share (the share once: a second claim pays 0) and emits `FinalClaimed{units: weight, amount}`, also with zeros, then burns the holder's balance (`UnitsBurned{reason: extinguishment}`).
- **`burnRetired`.** Stage 1 `burn_retired`, permissionless (any wallet or the keeper): TerminalStatus unless the stored status is Retired; a wallet holding no units gives `UnitsBurned{units: 0}` before any registration check, also a wallet that never held units; otherwise HolderNotRegistered, then the holder is settled (its pending payout stays claimable) and its balance burns. It is the only burn command (the keepers send one per holder that still holds units).
- **`extinguish`.** Since S4 WP12 Stage 1's `extinguish`, permissionless: it carries two attestor keys' `MERCES_EXTINGUISH_V1` signatures over the chain's signing domain, the series key and the series' live extinguish nonce (`SeriesState.nonces.extinguish`), and anyone may send it (each attestor signs on its own device; the keeper relays). The chain refuses two equal named keys (`SameAttestor`), then a signature that does not recover to its named key or a key that is not an active attestor (`InvalidAttestorSignature`; no grace), then a raise that has not settled (RaiseNotSettled), a mint not final and an extinguished series (TerminalStatus). The extinguishment advances the nonce. Only the unvested treasury returns to holders, and the issuer's estate may still draw the vested tranches. `SeriesExtinguished.attestors` names the two keys.
- **Curve mode (S3: Stage 1's curve lifecycle; Solana only).** A curve series' units are base lamports (`SeriesState.unitScale` 10^6); prices stay per whole unit. `createSeries` is the curve's activation: P0 = floor(X × 10^6 / swap base) must be at least 1 (CurveThresholdMismatch), then NewRaisesPaused and the issuer's allowlist; it emits `CurveActivated{unitsSold, issuePrice: P0}` and `RaiseOpened{0, 0}`, and the raise is Open. `curveSwap` trades on the curve's venue (Meteora's DBC on live chains; a labelled stand-in in the simulator until S5): no allowlist, no cap, no Merces event; the money sits in the pool, never in the treasury. `completeCurve` (permissionless; CurveNotComplete until the pool filled) settles at the pool's finish time with the P0 and units fixed at activation (`CurveGraduated`, Stage 1 `RaiseSettled` with proceeds 0, and `RaiseMintFinalized{proceeds: 0}`); it takes no census and registers nobody. `collectCurveProceeds` (permissionless, idempotent) moves the partner migration fee and surplus into the treasury and the partner trading fee to the fee collector (`CurveProceedsCollected`, `TreasuryFunded`, `FeeTaken{curveTrading}`). On a curve series the sealed-bid paths refuse with NotSealedBid (the raise, the settlement steps, the window, no cancel), `claimRedemption` with CurveUsesTender and `burnRetired` with CurveModeNoBurn; nothing burns and only staked units earn. **The census (S3 WP9).** `syncCurveUnits` (permissionless; NotCurveMode, RaiseNotOpen unless Open or Settled, TerminalStatus on a stored Retired, Redeemed or Extinguished series, CurveUnitsBelowStake) stores units outstanding = the unit mint's supply less the base lamports in protocol accounts (the DBC pool's base vault, the DAMM v2 pool's base vault, the locker escrow, the leftover receiver; never the stake vault) and its time (`SeriesState.unitsSyncedAt`), and emits `CurveUnitsSynced`; until the first census a curve's units outstanding are 0. The census is the vault's N, the bound on the stakes and the report proof's public input: a regular report needs one taken at or after its period's end, of more than 0 units (CurveUnitsNotSynced); a tail report proves over the units at redemption. `redeem` takes its own census with the DAMM v2 pool's base vault left out (B-C13: the deposit `floor(P × N / 10^6)` covers every unit holders could tender; `CurveUnitsSynced` before `RedemptionOpened`).
- **Curve staking (S3 WP10: Stage 1's `stake_units`, `unstake_units`, `tender_units`; Solana only).** On a curve series only staked units earn: a registered holder (`registerHolder`, the only way a curve holder registers; it needs the allowlist) moves base lamports from its wallet into the series' stake vault with `stakeUnits` (NotCurveMode, RaiseNotOpen unless Open or Settled, TerminalStatus, ZeroUnits, NotAllowlisted: the wallet must be allowlisted now, StakeExceedsOutstanding: the stakes may not pass the last census, then HolderNotRegistered) and is paid on its stake from then on; units in wallets earn nothing and their share stays in the vault. Every stake change and claim settles the holder first at its old stake (the debt pattern; while the series has not redeemed, an extinguishment's final-pool share of the stake is settled into the pending payout too). `unstakeUnits` (in any status, no allowlist check: NotCurveMode, ZeroUnits, InsufficientStake, HolderNotRegistered) returns units to the wallet and credits what they earned into the holder's pending payout without paying it (Stage 1's code; SPEC §9 says "pays"): `claimPayout` pays it at any time, for any registered holder. Events `UnitsStaked{holder, units, staked}` and `UnitsUnstaked{holder, units, staked}` (`staked`: the holder's stake after it; units only). After a redemption a curve is redeemed by tender: `tenderUnits{fromStake, fromWallet}` (NotCurveMode, NotRedeemed, ZeroUnits, InsufficientStake, TenderQuotaExhausted, HolderNotRegistered; no allowlist check) burns the units and pays `floor(P_redeem × units / 10^6)` plus the pending payout; staked units are reserved for their holders and wallet units share what is left of the count taken at redemption. It emits `PayoutClaimed{burnedUnits: 0}` for the pending payout (only when above 0), `UnitsBurned{redemption}` and `RedemptionClaimed{units, amount: principal, fromStake}`; units outstanding stay the count taken at redemption. The claims on a curve: `claimPayout` never burns; `claimRedemption` is CurveUsesTender; `claimTail` pays the pending payout (its own `PayoutClaimed`) and the tail on the tendered units (NoRedeemedUnits without a tender; nothing is redeemed); `claimFinal` weighs the tendered units on a series that redeemed, else the stake (whose share is already in the pending payout), and burns nothing; `burnRetired` is CurveModeNoBurn. On Solana the holder record is an account each of these loads first, so an unregistered wallet fails before every check there (an adapter note).
