# EVM events (SPEC v1.1 §10)

Every event of SPEC §10 is emitted on EVM under its canonical name, with the SPEC's snake_case fields in
camelCase (`clearing_price` → `clearingPrice`). Conventions for indexers:

- `series` is the `uint256` series id (Solana: the series PDA); in every series-scoped event it is the first
  field and `indexed` (FX events are keyed by `pair` instead).
- Amounts are stablecoin base units carried as `uint64` (SPEC §1.1); WAD accumulators are `uint256`;
  timestamps are unix seconds (`uint64`); `period` is `uint32` = `year × 4 + quarter − 1`.
- Enumerations are `uint8`: `RaiseState` (Draft 0, Open 1, Reveal 2, Settling 3, Settled 4, Failed 5,
  Cancelled 6), `SeriesStatus` (OnTime 0, InGrace 1, Late 2, Paused 3, Retired 4, Redeemed 5,
  Extinguished 6), `PayoutSource` (Payment 0, Router 1, Tail 2, Final 3), window `Side` (Bid 0, Ask 1),
  window `Branch` (None 0, SupplyLimited 1, DemandLimited 2); `UnitsBurned.reason` and
  `TerminalStatusSet.status` use the `SeriesStatus` value (Retired 4, Redeemed 5, Extinguished 6).
- `SettlementRejected.reason`: 1 `ClaimMismatch`, 2 `InvalidClearingPrice`. `WindowSettlementRejected.reason`:
  1 NO_MATCH proposed while a crossing exists, 2 `p*` not a revealed valid price, 3 neither branch holds
  (canonical name `InvalidWindowPrice`).
- `StatusChanged(series, oldStatus, newStatus)`: SPEC's `old`/`new` are reserved words in Solidity.
- `SeriesCreated` carries the charter terms as one `SeriesTerms` tuple (every §3.1 "charter terms" field,
  including all fee rates and durations) instead of a flat field list, so the indexer never reads state for
  terms (docs/assumptions/track-c.md C-S15).
- Raw secp256k1 signer addresses (`attestor`, `attestorA`, `attestorB`, `approver`) are 20-byte addresses,
  the same value Solana carries as `[u8; 20]`.

The tables below are generated from the compiled ABIs (`evm/abis/*.json`); "Emitted by" names the function
(or internal helper) containing the `emit`.

## MercesRegistry

| Event | Fields (`indexed` marked ⁱ) | Emitted by |
| --- | --- | --- |
| `AdminTransferStarted` | pendingAdminⁱ: address | `transferAdmin` |
| `AdminTransferred` | oldAdminⁱ: address, newAdminⁱ: address | `acceptAdmin` |
| `AllowlistManagerSet` | allowlistManagerⁱ: address | `setAllowlistManager` |
| `AllowlistUpdated` | walletⁱ: address, allowed: bool | `setAllowed` |
| `AttestorRegistered` | attestorⁱ: address | `_register` |
| `AttestorRevoked` | attestorⁱ: address, revokedAt: uint64 | `_revoke` |
| `ContractHashSet` | seriesⁱ: uint256, hash: bytes32 | `setContractHash` |
| `DefaultsSet` | defaults: Parameters | `constructor`, `setDefaults` |
| `EarlyDrawApproverSet` | earlyDrawApproverⁱ: address | `setEarlyDrawApprover` |
| `FeeCollectorSet` | feeCollectorⁱ: address | `setFeeCollector` |
| `FlagsSet` | newRaisesPaused: bool, windowsEnabled: bool, tier4Enabled: bool | `setFlags` |
| `FxPairSet` | pairIdⁱ: bytes32, feedId: bytes32, inverted: bool, crosscheck: address, crosscheckEffectivePeriod: uint32, enabled: bool | `_emitFxPair` |
| `IdentityRegistered` | walletⁱ: address, identity: address | `_ensureIdentity` |
| `IssuanceResumed` | issuerⁱ: address | `resumeIssuance` |
| `IssuanceStopped` | issuerⁱ: address | `stopIssuance` |
| `IssuerDeactivated` | issuerⁱ: address | `deactivateIssuer` |
| `IssuerRegistered` | issuerⁱ: address | `registerIssuer` |
| `MintFinalized` | seriesⁱ: uint256 | `markMintFinalized` |
| `ProtocolInitialized` | adminⁱ: address, allowlistManager: address, feeCollector: address, chainId: uint64, domain: bytes32 | `constructor` |
| `RaiseStateChanged` | seriesⁱ: uint256, state: uint8 | `markRaiseOpened`, `markRaiseResult` |
| `SeriesCreated` | seriesⁱ: uint256, issuerⁱ: address, mode: uint8, stablecoin: address, terms: SeriesTerms, termsCommitment: bytes32, tierFlags: uint8, fxPairId: bytes32 | `createSeries` |
| `StablecoinSet` | stablecoinⁱ: address, allowed: bool, decimals: uint8 | `setStablecoin` |
| `TerminalStatusSet` | seriesⁱ: uint256, status: uint8 | `markTerminal` |
| `TermsAmended` | seriesⁱ: uint256, nonce: uint64, newTermsCommitment: bytes32, newCapMultipleWad: uint64, attestorⁱ: address | `amendTerms` |
| `VerifierKeyRegistered` | verifierKeyⁱ: address | `_register` |
| `VerifierKeyRevoked` | verifierKeyⁱ: address, revokedAt: uint64 | `_revoke` |

## MercesAuction

| Event | Fields (`indexed` marked ⁱ) | Emitted by |
| --- | --- | --- |
| `BidCommitted` | seriesⁱ: uint256, bidderⁱ: address, escrow: uint64 | `commitBid` |
| `BidDelivered` | seriesⁱ: uint256, bidderⁱ: address, units: uint64, refund: uint64 | `deliverBid` |
| `BidProcessed` | seriesⁱ: uint256, bidderⁱ: address, units: uint64, refund: uint64 | `_recordRefund` |
| `BidRevealed` | seriesⁱ: uint256, bidderⁱ: address, price: uint64, quantity: uint64, valid: bool | `revealBid` |
| `Initialized` | version: uint64 | (inherited) |
| `MintAuthorityRevoked` | seriesⁱ: uint256 | `cancelRaise`, `_finalizeMint` |
| `NonRevealCharged` | seriesⁱ: uint256, bidderⁱ: address, charge: uint64 | `processBid` |
| `OwnershipTransferred` | previousOwnerⁱ: address, newOwnerⁱ: address | (inherited) |
| `RaiseCancelled` | seriesⁱ: uint256 | `cancelRaise` |
| `RaiseFailed` | seriesⁱ: uint256, clearingPrice: uint64, proceeds: uint64, minRaise: uint64 | `_fail` |
| `RaiseMintFinalized` | seriesⁱ: uint256, unitsSold: uint64, proceeds: uint64 | `_finalizeMint` |
| `RaiseOpened` | seriesⁱ: uint256, unitMint: address, openedAt: uint64, commitEnd: uint64, revealEnd: uint64 | `openRaise` |
| `RaiseSettled` | seriesⁱ: uint256, clearingPrice: uint64, unitsSold: uint64, proceeds: uint64, settlementTs: uint64 | `finalizeSettlement` |
| `SettlementProposed` | seriesⁱ: uint256, clearingPrice: uint64, round: uint32 | `beginSettlement` |
| `SettlementRejected` | seriesⁱ: uint256, round: uint32, clearingPrice: uint64, reason: uint8 | `_reject` |
| `UnitsAllocated` | seriesⁱ: uint256, bidderⁱ: address, units: uint64, cost: uint64, fee: uint64, refund: uint64 | `_allocate` |
| `Upgraded` | implementationⁱ: address | (inherited) |

## MercesTreasury

| Event | Fields (`indexed` marked ⁱ) | Emitted by |
| --- | --- | --- |
| `EarlyDrawExecuted` | seriesⁱ: uint256, amount: uint64, approverⁱ: address | `requestEarlyDraw` |
| `Initialized` | version: uint64 | (inherited) |
| `OwnershipTransferred` | previousOwnerⁱ: address, newOwnerⁱ: address | (inherited) |
| `ProceedsDeposited` | seriesⁱ: uint256, amount: uint64, deposited: uint64 | `depositProceeds` |
| `ProceedsSet` | seriesⁱ: uint256, proceeds: uint64 | `setProceeds` |
| `ReleaseClaimed` | seriesⁱ: uint256, amount: uint64, releasedTotal: uint64 | `claimRelease` |
| `ReleasePauseSet` | seriesⁱ: uint256, paused: bool | `setReleasePause` |
| `UnreleasedMovedToVault` | seriesⁱ: uint256, amount: uint64 | `moveUnreleasedToVault` |
| `Upgraded` | implementationⁱ: address | (inherited) |

## MercesIncome

| Event | Fields (`indexed` marked ⁱ) | Emitted by |
| --- | --- | --- |
| `FormalNoticeDue` | seriesⁱ: uint256, period: uint32, trueup: bool | `_sync` |
| `FxAccumulatorSet` | fxAccumulator: address | `initialize` |
| `Groth16VerifierSet` | verifier: address | `initialize`, `setGroth16Verifier` |
| `Initialized` | version: uint64 | (inherited) |
| `OwnershipTransferred` | previousOwnerⁱ: address, newOwnerⁱ: address | (inherited) |
| `PauseApproved` | seriesⁱ: uint256, start: uint64, end: uint64, attestorⁱ: address | `approvePause` |
| `PauseEnded` | seriesⁱ: uint256, pausedTotal: uint64 | `endPause` |
| `PauseRequestWithdrawn` | seriesⁱ: uint256, nonce: uint64 | `withdrawPauseRequest` |
| `PauseRequested` | seriesⁱ: uint256, nonce: uint64 | `requestPause` |
| `PaymentSettled` | seriesⁱ: uint256, periodⁱ: uint32, gross: uint64, accrual: uint64, fee: uint64, accepted: uint64, refunded: uint64 | `_applyReport`, `pay` |
| `Poseidon2Set` | poseidon2: address | `initialize` |
| `ReportAccepted` | seriesⁱ: uint256, periodⁱ: uint32, paymentUsd: uint64, fxAvgWad: uint64, fxFallback: bool, tier: uint8, liquidityEvent: bool, incomeCommitment: bytes32, due: uint64 | `_emitAccepted` |
| `RouterSet` | router: address | `initialize` |
| `StatusChanged` | seriesⁱ: uint256, oldStatus: uint8, newStatus: uint8 | `_sync` |
| `TrueUpPaid` | seriesⁱ: uint256, amount: uint64, accrual: uint64 | `payTrueUp` |
| `TrueUpRecorded` | seriesⁱ: uint256, year: uint16, adjustment: int64, deadline: uint64 | `submitTrueUp` |
| `Upgraded` | implementationⁱ: address | (inherited) |

## MercesRouter

| Event | Fields (`indexed` marked ⁱ) | Emitted by |
| --- | --- | --- |
| `IncomeHeld` | seriesⁱ: uint256, amount: uint64, held: uint64 | `route` |
| `IncomeRouted` | seriesⁱ: uint256, amount: uint64, passThrough: uint64, routed: uint64, ytdReceived: uint64 | `_route` |
| `IncomeSet` | income: address | `initialize` |
| `Initialized` | version: uint64 | (inherited) |
| `OwnershipTransferred` | previousOwnerⁱ: address, newOwnerⁱ: address | (inherited) |
| `RouterPeriodClosed` | seriesⁱ: uint256, period: uint32, ytdAtEnd: uint64 | `_closeThrough` |
| `RouterReceiverCreated` | seriesⁱ: uint256, receiver: address | `_ensureReceiver` |
| `Upgraded` | implementationⁱ: address | (inherited) |

## MercesFxAccumulator

| Event | Fields (`indexed` marked ⁱ) | Emitted by |
| --- | --- | --- |
| `FxDeviationFlagged` | pairⁱ: bytes32, period: uint32, rateWad: uint256, crosscheckWad: uint256 | `snapshot` |
| `FxSnapshot` | pairⁱ: bytes32, day: uint32, rateWad: uint256, sumWad: uint256, count: uint32 | `snapshot` |
| `Initialized` | version: uint64 | (inherited) |
| `OwnershipTransferred` | previousOwnerⁱ: address, newOwnerⁱ: address | (inherited) |
| `PythSet` | pyth: address | `initialize`, `setPyth` |
| `Upgraded` | implementationⁱ: address | (inherited) |

## MercesVault

| Event | Fields (`indexed` marked ⁱ) | Emitted by |
| --- | --- | --- |
| `FinalClaimed` | seriesⁱ: uint256, holderⁱ: address, units: uint64, amount: uint64 | `_claimFinal` |
| `HolderRegistered` | seriesⁱ: uint256, holderⁱ: address | `registerHolder` |
| `Initialized` | version: uint64 | (inherited) |
| `OwnershipTransferred` | previousOwnerⁱ: address, newOwnerⁱ: address | (inherited) |
| `PayoutClaimed` | seriesⁱ: uint256, holderⁱ: address, amount: uint64, burnedUnits: uint64 | `_claim` |
| `PayoutDistributed` | seriesⁱ: uint256, source: uint8, gross: uint64, accepted: uint64, fee: uint64, netAdded: uint64, deltaAccWad: uint256, paidPerUnitWad: uint256, retired: bool | `_emitDistributed`, `_distributeFinal` |
| `RedemptionClaimed` | seriesⁱ: uint256, holderⁱ: address, units: uint64, amount: uint64 | `_redemptionBody` |
| `SeriesExtinguished` | seriesⁱ: uint256, unreleased: uint64, attestorA: address, attestorB: address | `extinguish` |
| `SeriesRedeemed` | seriesⁱ: uint256, price: uint64, hurdle: uint64, dAvg: uint64, capRemaining: uint64, units: uint64, deposit: uint64 | `redeem` |
| `SeriesRetired` | seriesⁱ: uint256, paidPerUnitWad: uint256, refund: uint64 | `_retire` |
| `SupplyInitialized` | seriesⁱ: uint256, unitsOutstanding: uint64 | `initializeSupply` |
| `TailClaimed` | seriesⁱ: uint256, holderⁱ: address, amount: uint64 | `_claimTail` |
| `TailDistributed` | seriesⁱ: uint256, period: uint32, gross: uint64, accepted: uint64, fee: uint64, refunded: uint64 | `_receiveTail` |
| `UnitsBurned` | seriesⁱ: uint256, holderⁱ: address, units: uint64, reason: uint8 | `burnRetired`, `_burnUnits` |
| `Upgraded` | implementationⁱ: address | (inherited) |

## MercesWindow

| Event | Fields (`indexed` marked ⁱ) | Emitted by |
| --- | --- | --- |
| `Initialized` | version: uint64 | (inherited) |
| `OrderCommitted` | seriesⁱ: uint256, periodⁱ: uint32, ownerⁱ: address, side: uint8, escrow: uint64 | `commitAsk`, `commitBid` |
| `OrderDelivered` | seriesⁱ: uint256, periodⁱ: uint32, ownerⁱ: address, side: uint8, units: uint64, amount: uint64 | `deliverOrder` |
| `OrderFilled` | seriesⁱ: uint256, periodⁱ: uint32, ownerⁱ: address, side: uint8, fill: uint64, price: uint64, fee: uint64, refund: uint64 | `_accountBid`, `_accountAsk` |
| `OrderRevealed` | seriesⁱ: uint256, periodⁱ: uint32, ownerⁱ: address, side: uint8, price: uint64, quantity: uint64, valid: bool | `_recordReveal` |
| `OwnershipTransferred` | previousOwnerⁱ: address, newOwnerⁱ: address | (inherited) |
| `Upgraded` | implementationⁱ: address | (inherited) |
| `WindowCleared` | seriesⁱ: uint256, periodⁱ: uint32, clearingPrice: uint64, matchedUnits: uint64, branch: uint8 | `finalizeWindow` |
| `WindowNoMatch` | seriesⁱ: uint256, periodⁱ: uint32 | `finalizeWindow` |
| `WindowOpened` | seriesⁱ: uint256, periodⁱ: uint32, commitEnd: uint64, revealEnd: uint64 | `openWindow` |
| `WindowSettlementProposed` | seriesⁱ: uint256, periodⁱ: uint32, clearingPrice: uint64, noMatch: bool, round: uint32 | `beginWindowSettlement` |
| `WindowSettlementRejected` | seriesⁱ: uint256, periodⁱ: uint32, clearingPrice: uint64, reason: uint8 | `_reject` |
| `WindowTakebackSettled` | seriesⁱ: uint256, periodⁱ: uint32, cancelledUnits: uint64, belowUnits: uint64 | `indexAskPrices` |

## MercesTokenFactory

| Event | Fields (`indexed` marked ⁱ) | Emitted by |
| --- | --- | --- |
| `UnitTokenCreated` | seriesⁱ: uint256, tokenⁱ: address, compliance: address | `createToken` |

## MercesComplianceModule

| Event | Fields (`indexed` marked ⁱ) | Emitted by |
| --- | --- | --- |
| `ComplianceBound` | _complianceⁱ: address | (inherited) |
| `ComplianceUnbound` | _complianceⁱ: address | (inherited) |
| `EscrowsSet` | complianceⁱ: address, auction: address, window: address | `setEscrows` |

## FeeCollector

| Event | Fields (`indexed` marked ⁱ) | Emitted by |
| --- | --- | --- |
| `FeesWithdrawn` | tokenⁱ: address, toⁱ: address, amount: uint256 | `withdraw` |
| `OwnershipTransferred` | previousOwnerⁱ: address, newOwnerⁱ: address | (inherited) |

## Events beyond SPEC §10

Not in the SPEC §10 list; none replaces a canonical event. The first group exists on Solana with the same name
and fields (Track B parity, `docs/assumptions/track-b.md`); the rest are EVM-only, for operational transparency.

| Event | Contract | Meaning |
| --- | --- | --- |
| `FormalNoticeDue(series, period, trueup)` | income | SPEC lists `(series, period)`; `trueup = true` marks the true-up notice, `period` then carries the calendar year (B-S3) |
| `WindowSettlementProposed(series, period, clearingPrice, noMatch, round)` | window | Keeper proposal; `clearingPrice = 2^64 − 1` for `NO_MATCH` (also in `WindowSettlementRejected`) |
| `WindowTakebackSettled(series, period, cancelledUnits, belowUnits)` | window | Cancelled buyers' units reach below `p*` and the take-back from those asks is settled (B-S12; Solana adds its threshold key) |
| `OrderDelivered(series, period, owner, side, units, amount)` | window | `deliverOrder` pushed a processed order's units and stablecoin to its owner (B-S13) |

| EVM-only event | Contract | Meaning |
| --- | --- | --- |
| `IdentityRegistered(wallet, identity)` | registry | First allowlisting of a wallet created and registered its ONCHAINID in the shared T-REX identity registry (SPEC §4.2) |
| `StablecoinSet(stablecoin, allowed, decimals)` | registry | Stablecoin allowlist for **new** series (existing series keep theirs) |
| `MintFinalized(series)` | registry | Registry mirror of `mint_finalized` (same name as the Solana registry event) |
| `BidProcessed(series, bidder, units, refund)` | auction | A bid was processed: what `deliverBid` will hand over (the split of SPEC §13 item 4) |
| `ProceedsSet` / `ProceedsDeposited` | treasury | Exact proceeds recorded at finalize; cost streamed in at each `processBid` |
| `UnreleasedMovedToVault(series, amount)` | treasury | Extinguishment moved the unvested proceeds to the vault |
| `SupplyInitialized(series, unitsOutstanding)` | vault | `units_outstanding = units_sold` at mint finalization |
| `IncomeHeld` | router | Tier-1 income received before the raise was final, held for the series |
| `RouterReceiverCreated(series, receiver)` | router | Per-series income address deployed |
| `UnitTokenCreated` | token factory | T-REX token + compliance proxies created for a series |
| `ComplianceBound` / `ComplianceUnbound` / `EscrowsSet` | compliance module | Module bound to a series' compliance with its auction/window escrows |
| `FeesWithdrawn` | fee collector | Timelock withdrew collected fees |
| `Groth16VerifierSet`, `FxAccumulatorSet`, `RouterSet`, `IncomeSet`, `Poseidon2Set`, `PythSet` | money contracts | Wiring set at initialization (or changed by the timelock) |
| `Initialized`, `Upgraded`, `OwnershipTransferred` | OpenZeppelin | Proxy initialization, implementation upgrades (timelock only), ownership |
