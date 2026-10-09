# EVM interfaces (SPEC v1.1)

Solidity 0.8.30 (Merces core, via-IR, optimizer 200 runs, `evm_version = cancun`) and 0.8.17 (the vendored
T-REX 4.1.6 / ONCHAINID 2.2.1 unit and the Merces modules that import it), Foundry 1.7.1. No chain-specific
code: the same bytecode targets Monad testnet (chain id 10143) and any EVM chain. ABIs: `evm/abis/*.json`
(exported from the build; `MercesUnitToken.json` is the T-REX `Token` behind every series' unit proxy).
Deployment records: `evm/deployments/<network>.json` (written by `evm/script/*.s.sol`, see
`evm/script/README.md`).

## Contracts, ownership and upgrades

| Contract | Kind | Owner / authority | Role |
| --- | --- | --- | --- |
| `MercesRegistry` | plain contract, **not upgradeable** | `admin` (two-step); `allowlistManager` | charter, terms, registries (D1, D11); holds every charter field |
| `MercesAuction` | UUPS proxy | `TimelockController` | sealed-bid uniform-price raise (D3) |
| `MercesTreasury` | UUPS proxy | timelock | proceeds and the release schedule (D4) |
| `MercesIncome` | UUPS proxy | timelock | reports, payments, status machine, pauses, true-up (D6, C8) |
| `MercesRouter` (+ `MercesRouterReceiver` per series) | UUPS proxy | timelock | tier-1 income split (D5) |
| `MercesFxAccumulator` | UUPS proxy | timelock | daily Pyth snapshots, quarter averages, Chainlink cross-check (C9) |
| `MercesVault` | UUPS proxy | timelock | payouts, cap, redemption, tail, extinguishment (D7, D8) |
| `MercesWindow` | UUPS proxy | timelock | quarterly transfer window (D9) |
| `FeeCollector` | plain contract, **not upgradeable** | timelock (`withdraw` only) | receives every fee |
| `MercesTokenFactory` | plain contract | — (only the auction calls it) | one T-REX `TokenProxy` + `ModularComplianceProxy` per series |
| `MercesComplianceModule` | plain contract (0.8.17) | — | the only transfer rule: mint to the auction, burns, protocol escrow movements, armed window deposits |
| `MercesTokenGovernor` | plain contract, no functions | — | owner of every unit token, compliance and the identity-registry stack: a dead end (no agent, compliance, pause, freeze, forced-transfer or recovery path) |
| `Groth16Verifier` | generated (snarkjs) | — | ProofOfIncome verifier (SPEC §8), installed in `MercesIncome` |
| Poseidon(2), Poseidon(5) | circomlibjs bytecode | — | income commitments (tier 1) and terms commitments |
| T-REX `TREXImplementationAuthority`, ONCHAINID `ImplementationAuthority` | vendored | timelock | the only path to change T-REX / identity implementations |

Every money proxy's `_authorizeUpgrade` is `onlyOwner` (the timelock, delay set at deployment; proposer and
executor = the admin multisig). The registry's protocol-contract set is fixed in its constructor (no setter),
so an upgrade can change money code after the delay but can never reach a charter field, re-point the
registry or move funds outside the defined paths (C11 §7, SPEC §2 hard limits).

## Conventions

- **Entry-point range rule (SPEC §1.1).** Amount, price, quantity, timestamp and WAD arguments are declared
  `uint256` and narrowed with `MercesMath.toU64`; a value `≥ 2^64` reverts with the canonical
  `AmountOutOfRange(value)` (not an ABI-decoding failure). Stored values and event fields are `uint64`.
- **Commitments (SPEC §1.3).** `keccak256(price_u64_be ‖ quantity_u64_be ‖ salt_32 ‖ wallet_32)` with the
  wallet left-padded to 32 bytes; `MercesAuction.bidCommitment` / `MercesWindow.orderCommitment` compute it
  (and apply the range rule).
- **Signed messages (SPEC §1.4).** Raw secp256k1 digests (no EIP-191 prefix), 65-byte `r ‖ s ‖ v`,
  `v ∈ {27, 28}`, low-`s` (OpenZeppelin `ECDSA.tryRecover`; a malformed signature recovers to an
  unregistered address). `domain = keccak256(0x02 ‖ chain_id_u64_be ‖ registry_address_32)`
  (`MercesRegistry.domain()`); `series_key` = the series id as 32 bytes. Magic strings:
  `MERCES_REPORT_V1`, `MERCES_FX_V1`, `MERCES_AMEND_V1`, `MERCES_PAUSE_V1`, `MERCES_EXTINGUISH_V1`,
  `MERCES_TRUEUP_V1` (`src/libraries/MercesMessages.sol`).
- **Groth16 proofs.** `Groth16Proof{uint256[2] a; uint256[2][2] b; uint256[2] c}` in snarkjs
  `exportSolidityCallData` order (`b` coordinates swapped as the EIP-197 precompile expects); public inputs
  `[terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment,
  payment_usd]`.
- **Errors.** Every revert is a custom error with the canonical v1.1 name of `packages/sdk/src/errors.ts`
  (`src/types/MercesErrors.sol`; `IssuanceStopped` is `RegistryErrors.IssuanceStopped` because an event of
  the same name exists). T-REX's own `"Transfer not possible"` string remains only for a transfer to a wallet
  that was never allowlisted (no identity), which no protocol path attempts.
- **Pull payments.** Every token-moving external function is `nonReentrant` and follows
  checks-effects-interactions. Keepers may push only to the rightful owner (`claimFor`, `deliverBid`,
  `processOrder`, `withdrawOwed`); a recipient-side stablecoin failure in the window is deferred to
  `owed(series, owner)` instead of blocking (C-S3).
- **Addressing.** A bid or order is addressed by its owner (`getBid(series, bidder)`,
  `getOrder(series, period, owner)`); index-based getters exist for paging (`getBidAt`, `getOrderAt`).
- **Pages.** `tallyBids(series, from, to)` / `tallyOrders(series, from, to)` take ≤ 200 entries
  (`MAX_TALLY_PAGE`); `max_bids_per_auction = 4096`.

## Functions and access

Generated from the ABIs. "Anyone" functions are the keeper surface (SPEC §2): they never move value to
anyone but its owner.

### MercesRegistry

| Function | Access |
| --- | --- |
| `acceptAdmin()` | pending admin |
| `amendTerms(uint256 seriesId, bytes32 newTermsCommitment, uint256 newCapMultipleWad, bytes attestorSignature, Tier1Terms tier1Terms)` | issuer + attestor signature (§1.4 `MERCES_AMEND_V1`, current nonce); cap only down, never after terminal |
| `createSeries(SeriesParams p, ReleaseTranche[] releaseSchedule, bytes32 termsCommitment, uint8 tierFlags, bytes32 fxPairId_, uint8 mode, bool issuerAcceptsPublicPrice, Tier1Terms tier1Terms)` | registered, active, allowlisted issuer with issuance not stopped |
| `deactivateIssuer(address wallet)` | admin (blocks new series only) |
| `markMintFinalized(uint256 seriesId)` | auction |
| `markRaiseOpened(uint256 seriesId, address unitToken, uint64 openedAt)` | auction |
| `markRaiseResult(uint256 seriesId, uint8 state, uint64 settlementTs, uint64 unitsSold, uint64 clearingPrice)` | auction |
| `markTerminal(uint256 seriesId, uint8 status)` | vault |
| `registerAttestor(address key)` | admin |
| `registerIssuer(address wallet)` | admin |
| `registerProtocolIdentities()` | anyone (idempotent; deploy wiring) |
| `registerVerifierKey(address key)` | admin |
| `resumeIssuance()` | issuer (own switch) |
| `revokeAttestor(address key)` | admin (forward-only, grace for ended periods) |
| `revokeVerifierKey(address key)` | admin (forward-only) |
| `rotateAttestor(address oldKey, address newKey)` | admin |
| `rotateVerifierKey(address oldKey, address newKey)` | admin |
| `setAllowed(address wallet, bool allowed)` | allowlist manager |
| `setAllowlistManager(address manager)` | admin |
| `setContractHash(uint256 seriesId, bytes32 hash)` | issuer, Draft only, write-once non-zero |
| `setDefaults(Parameters defaults)` | admin (future series only) |
| `setEarlyDrawApprover(address approver)` | admin |
| `setFeeCollector(address collector)` | admin |
| `setFlags(bool newRaisesPaused, bool windowsEnabled, bool tier4Enabled)` | admin |
| `setFxPair(bytes32 feedId, bool inverted, address crosscheck)` | admin (create-only) |
| `setFxPairCrosscheck(bytes32 pairId, address crosscheck)` | admin (effective next period) |
| `setFxPairEnabled(bytes32 pairId, bool enabled)` | admin (new series only) |
| `setStablecoin(address token, bool allowed)` | admin (new series only) |
| `stopIssuance()` | issuer (own switch) |
| `transferAdmin(address newAdmin)` | admin (two-step) |

Views: `admin`, `allowlistManager`, `attestorKey`, `chainId`, `domain`, `earlyDrawApprover`, `feeCollector`, `fxPairId`, `getDefaults`, `getFlags`, `getFxPair`, `getIssuer`, `getProtocolContracts`, `getReleaseSchedule`, `getRouterTerms`, `getSeriesCore`, `getSeriesTerms`, `idFactory`, `identityRegistry`, `isAllowed`, `isAttestor`, `isStablecoinAllowed`, `isTransferLocked`, `isVerifierKey`, `pendingAdmin`, `poseidon5`, `seriesCount`, `verifierKey`.

### MercesAuction

| Function | Access |
| --- | --- |
| `beginSettlement(uint256 seriesId, uint256 clearingPrice, uint256 qAboveClaim, uint256 qAtClaim)` | anyone (keeper), after reveal end, no round in progress |
| `cancelRaise(uint256 seriesId)` | issuer, before any bid |
| `commitBid(uint256 seriesId, bytes32 commitment, uint256 escrow)` | allowlisted bidder, commit phase, one bid per wallet |
| `deliverBid(uint256 seriesId, address bidder)` | anyone; pays the bidder only |
| `finalizeSettlement(uint256 seriesId)` | anyone, fully tallied; a wrong proposal is rejected, not reverted |
| `initialize(address owner_, address registry_)` | once, at deployment |
| `openRaise(uint256 seriesId)` | issuer (contract hash set, allowlisted, new raises not paused) |
| `processBid(uint256 seriesId, address bidder)` | anyone; once per bid |
| `revealBid(uint256 seriesId, uint256 price, uint256 quantity, bytes32 salt)` | the bidder, reveal phase; invalid bids are recorded, never reverted |
| `tallyBids(uint256 seriesId, uint256 fromIndex, uint256 toIndex)` | anyone, ≤ 200 bids per page |

Views: `bidCommitment`, `getAuction`, `getBid`, `getBidAt`, `mintFinalized`, `pendingUnitsOf`, `registry`, `requiredEscrow`, `walletCapUnitsAtAuction`.

### MercesTreasury

| Function | Access |
| --- | --- |
| `claimRelease(uint256 seriesId)` | issuer; blocked only by Late status or the issuer's own pause |
| `depositProceeds(uint256 seriesId, uint64 amount)` | auction |
| `initialize(address owner_, address registry_)` | once |
| `moveUnreleasedToVault(uint256 seriesId)` | vault (extinguishment) |
| `requestEarlyDraw(uint256 seriesId, uint256 amountRequested)` | issuer; only with a configured approver |
| `setProceeds(uint256 seriesId, uint64 proceeds)` | auction |
| `setReleasePause(uint256 seriesId, bool paused)` | issuer |

Views: `claimable`, `confirmDeposits`, `getTreasury`, `registry`, `trancheAmount`, `vested`.

### MercesIncome

| Function | Access |
| --- | --- |
| `approvePause(uint256 seriesId, uint256 pauseEnd, bytes attestorSignature)` | anyone submitting the attestor signature (§1.4 `MERCES_PAUSE_V1`) |
| `clearDues(uint256 seriesId)` | vault |
| `crankStatus(uint256 seriesId)` | anyone |
| `endPause(uint256 seriesId)` | issuer |
| `initialize(address owner_, address registry_, address groth16Verifier_, address fxAccumulator_, address router_, address poseidon2_)` | once |
| `pay(uint256 seriesId)` | anyone; funds come from the caller |
| `payTrueUp(uint256 seriesId)` | anyone; funds come from the caller |
| `receiveRouterShare(uint256 seriesId, uint64 share)` | router |
| `requestPause(uint256 seriesId)` | issuer |
| `setGroth16Verifier(address verifier)` | owner (timelock) |
| `submitReport(ReportInput input)` | issuer (tier 2: verifier-key signature, tier 3: attestor signature, tier 1: router binding, tier 4: own tx) |
| `submitTrueUp(uint256 seriesId, uint16 year, int256 adjustment, uint256 attestationTs, bytes sig)` | issuer + attestor signature (§1.4 `MERCES_TRUEUP_V1`) |
| `withdrawPauseRequest(uint256 seriesId)` | issuer |

Views: `ZERO_INCOME_COMMITMENT`, `countdown`, `deriveStatus`, `deriveStatusAt`, `earliestUnpaidPeriod`, `fxAccumulator`, `getLedger`, `getPauses`, `getReport`, `groth16Verifier`, `isLateUnderlying`, `lastPaidPeriod`, `lateAccrual`, `nextExpectedPeriod`, `openDue`, `poseidon2`, `registry`, `router`, `trueupDue`, `unpausedBetween`.

### MercesVault

| Function | Access |
| --- | --- |
| `burnRetired(uint256 seriesId, address holder)` | anyone (Retired series) |
| `claim(uint256 seriesId)` | holder |
| `claimFinal(uint256 seriesId)` | holder (Extinguished) |
| `claimFinalFor(uint256 seriesId, address holder)` | anyone; pays the holder |
| `claimFor(uint256 seriesId, address holder)` | anyone; pays the holder |
| `claimRedemption(uint256 seriesId)` | holder (Redeemed / Extinguished) |
| `claimRedemptionFor(uint256 seriesId, address holder)` | anyone; pays the holder |
| `claimTail(uint256 seriesId)` | holder |
| `claimTailFor(uint256 seriesId, address holder)` | anyone; pays the holder |
| `creditWindowAccrual(uint256 seriesId, address wallet, uint64 units, uint256 fromAccWad)` | window (C-S4) |
| `extinguish(uint256 seriesId, bytes signatureA, bytes signatureB)` | anyone submitting two distinct attestor signatures (§1.4 `MERCES_EXTINGUISH_V1`) |
| `initialize(address owner_, address registry_)` | once |
| `initializeSupply(uint256 seriesId, uint64 unitsSold)` | auction (mint finalization) |
| `receiveGross(uint256 seriesId, uint64 amount, uint8 source, uint32 period)` | income |
| `redeem(uint256 seriesId)` | issuer (lockup over, not Late, nothing due, every ended period reported) |
| `registerHolder(uint256 seriesId, address wallet)` | anyone for an allowlisted wallet; auction and window without the check |
| `retireIfCapped(uint256 seriesId)` | anyone |
| `settleHolder(uint256 seriesId, address wallet)` | anyone |

Views: `accrualUnits`, `capEffWad`, `capPerUnit`, `claimableFinal`, `claimableTail`, `getHolder`, `getLedger`, `netAccWad`, `pendingOf`, `previewRedemption`, `registry`, `unitsOutstanding`, `yearGrossWad`.

### MercesWindow

| Function | Access |
| --- | --- |
| `beginWindowSettlement(uint256 seriesId, uint256 clearingPrice, bool noMatch)` | anyone, after reveal end, no round in progress |
| `commitAsk(uint256 seriesId, bytes32 commitment, uint256 units)` | holder (armed escrow deposit) |
| `commitBid(uint256 seriesId, bytes32 commitment, uint256 escrow)` | allowlisted wallet |
| `finalizeWindow(uint256 seriesId)` | anyone; a wrong proposal is rejected |
| `indexAskPrices(uint256 seriesId, uint64[] prices)` | anyone (keeper price index for the take-back, verified) |
| `initialize(address owner_, address registry_)` | once |
| `openWindow(uint256 seriesId, uint32 period)` | anyone (windows enabled, OnTime/InGrace, lockup over, previous quarter paid) |
| `processOrder(uint256 seriesId, address owner)` | anyone; once per order |
| `revealOrder(uint256 seriesId, uint256 price, uint256 quantity, bytes32 salt)` | the order's owner, reveal phase |
| `tallyOrders(uint256 seriesId, uint256 fromIndex, uint256 toIndex)` | anyone, ≤ 200 orders per page |
| `withdrawOwed(uint256 seriesId, address owner)` | anyone; pays the owner |

Views: `armedDeposit`, `askAccrual`, `askEscrowUnits`, `currentWindow`, `getOrder`, `getOrderAt`, `getWindow`, `orderCommitment`, `owed`, `priceIndexRequired`, `registry`, `requiredBidEscrow`, `walletCapUnits`.

### MercesRouter

| Function | Access |
| --- | --- |
| `closeRouterPeriod(uint256 seriesId, uint32 period)` | anyone (settled tier-1 series, ended period) |
| `createRouterReceiver(uint256 seriesId)` | anyone (tier-1 series) |
| `initialize(address owner_, address registry_, address income_)` | once |
| `route(uint256 seriesId, uint256 amount)` | anyone; routes stablecoin from the caller |
| `sweep(uint256 seriesId)` | anyone (income held before finalization / failed raise) |

Views: `getRouter`, `income`, `registry`, `routerReceiver`, `ytdAtEnd`.

### MercesRouterReceiver

| Function | Access |
| --- | --- |
| `forward(address token, uint256 amount)` | router |

Views: `router`, `seriesId`.

### MercesFxAccumulator

| Function | Access |
| --- | --- |
| `initialize(address owner_, address registry_, address pyth_)` | once |
| `setPyth(address pyth_)` | owner (timelock) |
| `snapshot(bytes32 pairId, bytes[] priceUpdateData)` | anyone; pays the Pyth update fee |

Views: `getFxCheckpoint`, `getFxPair`, `pyth`, `quarterAverage`, `quarterStats`, `registry`.

### FeeCollector

| Function | Access |
| --- | --- |
| `withdraw(address token, address to, uint256 amount)` | owner (timelock) |

### MercesTokenFactory

| Function | Access |
| --- | --- |
| `createToken(uint256 seriesId, string name, string symbol)` | auction (at `openRaise`) |

Views: `auction`, `complianceModule`, `identityRegistry`, `implementationAuthority`, `tokenOf`, `tokenOwner`, `vault`, `window`.

### MercesTokenGovernor


Views: `VERSION`.

### MercesComplianceModule

| Function | Access |
| --- | --- |
| `bindCompliance(address _compliance)` | a ModularCompliance binding the module |
| `moduleBurnAction(address , uint256 )` | the bound compliance |
| `moduleMintAction(address , uint256 )` | the bound compliance |
| `moduleTransferAction(address , address , uint256 )` | the bound compliance |
| `setEscrows(address auction, address window)` | the bound compliance (set once by the token factory) |
| `unbindCompliance(address _compliance)` | the bound compliance |

Views: `canComplianceBind`, `escrowsOf`, `isComplianceBound`, `isPlugAndPlay`, `moduleCheck`, `name`.
