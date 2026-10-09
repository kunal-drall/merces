# Track C assumptions, interpretations and SPEC defects (SPEC v1.1, EVM)

Track C = `evm/`: `MercesRegistry` (D1 + D11), the T-REX token stack (`MercesTokenFactory`,
`MercesComplianceModule`, `MercesTokenGovernor`), `MercesAuction` (D3), `MercesTreasury` (D4),
`MercesIncome` (D6 + C8 status machine + true-up), `MercesRouter` (D5), `MercesFxAccumulator` (C9),
`MercesVault` (D7 + D8), `MercesWindow` (D9), `FeeCollector`, the generated `Groth16Verifier`, the
Poseidon hashers, the Foundry test suites (unit, fuzz, invariant, charter, SPEC §11 vector runner), the
deployment scripts and the EVM documents in `docs/evm/`.

## Gap list against SPEC v1.1 §13 (assessment at hand-over, 9 Oct 2026, before any code change)

State found: `forge build` green, `forge fmt --check` clean, `forge test` **138 passed / 5 failed**
(`Fx.t.sol` ×3 revert `StalePrice()`, `Income.t.sol::test_hardshipPauseStopsTheClock` and
`test_pauseBoundsAndWithdrawal` — tests and code disagree on the pause rules). No vector runner, no fuzz,
invariant or charter suites (`test/{fuzz,invariant,charter,parity}` empty), no runnable deploy script (only
`script/lib/*`), no ABIs, no `docs/evm/*`. Sizes: `MercesIncome` 23,269 B, `MercesVault` 22,480 B,
`MercesRegistry` 20,319 B (EIP-170 limit 24,576 B). Audit of every contract against the v1.1 text and the
reference simulator (`packages/reference/src/sim/simulator.ts`, which the vectors encode):

| §13 item | Status found | Gap / action |
| --- | --- | --- |
| 1 auction always terminates | **partial** | `valid_count == 0 → Failed` implemented; the creation rule `floor(units × wallet_cap_bps / 10000) ≥ 1` uses the protocol default instead of the series' own wallet cap; a `Failed` raise never reaches `mint_finalized` (vectors 02/15 expect it after the last `process_bid`, and at finalize when there is no bid at all) |
| 2 no settlement stalls | implemented | `TallyInProgress` + `round_rejected` in auction and window; window uses `NotSettling` where the canonical name is `WindowNotOpen` |
| 3 exact one-pass settlement | **partial** | claims, `alloc_sum`, registry written once: done. A `Failed` (min-raise) round zeroes `units_sold`/`proceeds` (vectors expect the exact computed values); `escrow_total` only grows (vectors read it as the live escrow); proposal and result share `clearing_price` |
| 4 undeliverable bids | implemented | `processBid` / `deliverBid` split; bids are addressed by array index while SPEC/vectors address a bid by its bidder (`BidNotFound` for a wallet without a bid is unreachable) |
| 5 mint-finalization gate | implemented | stored `units_outstanding`, `accrual_units` (balance + undelivered + ask escrow); check orders differ from the reference in treasury/vault |
| 6 cap amendments | implemented | live cap, `cap_eff`, `retire_if_capped`, no amendment after terminal; attestor signature is checked after the cap bound (reference: before) |
| 7 income scale / entry rule | **partial** | `payment_usd`, `fx_avg_wad`, escrow, price, quantity, `pause_end`, adjustment and timestamps are typed `uint64`/`int64`, so a value ≥ 2^64 fails ABI decoding without the canonical `AmountOutOfRange` |
| 8 tier rules | implemented | pure-tier-1 rule, Poseidon(2) binding, `close_router_period`; non-canonical errors (`IncomeCommitmentMismatch`, `PriorCommitmentMismatch` → `InvalidProof`; `PeriodNotEndedYet` → `ReportTooEarly`); `closeRouterPeriod` before settlement iterates from 1970 Q1 (bug) |
| 9 first-report prior | implemented | attestation digest binds prior commitment and liquidity flag |
| 10 clock | **partial** | bounded pause list, unpaused countdowns, `is_late_underlying`, withdraw, `end_pause` done; `PauseAlreadyRequested` blocks a re-request (reference re-requests and advances the nonce), `request_pause` lacks the `RaiseNotSettled` gate, `approve_pause` check order differs; two failing tests |
| 11 true-up | **partial** | nonce, once per year, bounded negatives, Late, blocks redemption: done. Signature verified after the state checks (vector 20 expects `InvalidAttestorSignature` before `TrueUpOutstanding`); zero adjustment rejected (reference accepts); `trueup_attested_at` not cleared on payment or retirement |
| 12 redemption gate | **partial** | gate implemented, `C_rem` saturates; Late checked after lockup (reference: before); extra `WindowPending` gate lets any holder with an open ask delay redemption (brief C7: never blockable by a holder) |
| 13 tail / final | **partial** | separate carries and `<` boundary done; `extinguish` sets `tail_exhausted` (reference leaves it); `claim_redemption` pays once instead of accumulating later balances; `claim_tail` lacks `NoRedeemedUnits`; `claim_final` blocked by `WindowPending`; `burn_retired` on an empty unregistered wallet reverts (vector 21 expects a no-op); `SeriesNotRetired`/`SeriesNotExtinguished` → `TerminalStatus` |
| 14 window | **partial** | two-branch clearing, one order per wallet, armed deposits, buyer re-check: done. Take-back of a cancelled buyer's units goes to the latest asks in reveal order instead of SPEC's "asks at p\* in descending reveal index, then asks below p\*"; a stablecoin push that fails for a recipient-side reason blocks every later ask; non-canonical errors (`OrderNotFound`, `OrderAlreadyRevealed`, `ZeroUnits`, `NotSettling`, `CommitPhaseClosed`); window phase (`Commit`/`Reveal`/`Done`) not observable |
| 15 hook / compliance | implemented | escrow rules, `armedDeposit`, fixed agent set {auction, vault, window}, unpause at creation, governor without configuration surface, IR stack owned by the governor with the registry as only agent, auction/window identities, implementation authority owned by the timelock. Direct transfers revert with T-REX's string `"Transfer not possible"` instead of `DirectTransferForbidden` |
| 16 registry | **partial** | protocol contracts fixed at construction, `markMintFinalized`, forward-only revocation with grace (+ rotate), amend only while non-terminal, allowlist flag + ONCHAINID registered once: done. FX pairs are not write-once (`setFxPair` rewrites an existing pair; vector 13 expects `FxPairExists`); series wallet cap copied from defaults (vector 03 uses 3,334 bps); non-canonical errors (`IssuerIssuanceStopped`, `IssuerNotAllowlisted`, `ContractHashZero`) |
| 17 conventions | **partial** | zero-amount rule mostly followed; entry-point range rule missing (item 7) |
| 18 exact WAD carry | implemented | `carry_wad`, `tail_carry_wad`, `final_carry_wad` |

Other findings: the FX accumulator refuses snapshots on a disabled pair (SPEC §3.1: snapshots stay
permissionless), does not invert the cross-check of an inverted pair (reference inverts) and flags a period
when Chainlink is merely stale; `MercesTokenGovernor` is correct but undocumented in `docs/evm`.

Missing deliverables: `test/parity/VectorRunner.t.sol`, fuzz/invariant/charter suites, runnable
`script/*.s.sol`, `deployments/<chain>.json`, `script/README.md`, `abis/`, `docs/evm/{EVENTS,INTERFACES,
AUDIT-NOTES,MEASUREMENTS}.md`.

## Status at hand-back

Every §13 item above is implemented; the SPEC §11 vector suite (21 vectors, schema 2) passes in full on the
EVM stack (`test/parity/VectorRunner.t.sol`, default via-IR and `dev` profiles). Item by item:

| §13 item | Resolution |
| --- | --- |
| 1 | wallet cap from the series params; a `Failed` raise reaches `mint_finalized` after the last `process_bid` (at finalize when there is no bid) |
| 2 | canonical `WindowNotOpen`; settlement liveness is an invariant (`RaiseInvariants.afterInvariant`, `LifecycleHandler.windowSettle`) |
| 3 | exact would-be `units_sold`/`proceeds` kept on a min-raise failure; live `escrow_total`; proposal (`proposedPrice`) separate from result (`clearingPrice`) |
| 4 | bids addressed by bidder (`getBid(series, bidder)`, `BidNotFound`) |
| 5 | reference check orders in treasury / vault |
| 6 | signature checked before the cap bound |
| 7 | every entry point takes `uint256` and applies `AmountOutOfRange` (C-S19) |
| 8 | canonical errors; `closeRouterPeriod` before settlement reverts `RaiseNotSettled` |
| 10 | re-request advances the nonce; `request_pause` gated on settlement; reference check order |
| 11 | signature before state checks; zero adjustment accepted; true-up fields cleared on payment and retirement |
| 12 | Late before lockup; no window gate on redemption |
| 13 | `extinguish` leaves `tail_exhausted`; accumulative `redeemed_units`; `NoRedeemedUnits`; `burn_retired` zero-amount no-op; `TerminalStatus` |
| 14 | SPEC take-back order with a verified keeper price index (C-S2); deferred pushes (C-S3); canonical errors; observable `Commit`/`Reveal`/`Done` |
| 15 | canonical `DirectTransferForbidden` / `UnarmedEscrowDeposit` (C-S12) |
| 16 | FX pairs create-only (`FxPairExists`), separate enable/cross-check setters; series wallet cap from params; canonical errors |
| 17, 18 | done |

## Interpretations, deviations and SPEC defects

Numbered `C-S*` (SPEC or reference defect / ambiguity, with the reading implemented) and `C-*` (EVM
interpretation). Each is the most faithful reading of the brief we could find; none changes a vector result.

- **C-S1 (SPEC §6.3, reference defect S1) — exact WAD carry.** A base-unit carry double-counts dust; the vault
  keeps `carry_wad = num − delta × N` with `num = (accepted − fee) × WAD + carry_wad` for the main, tail and
  final accumulators (§13 item 18). Invariant: `netAccWad × N + carryWad == (gross − fee) × WAD`.
- **C-S2 (SPEC §7 take-back order).** "Asks at p\* in descending reveal index, then asks below p\*" needs the
  asks below `p*` in (price, reveal) order, which cannot be sorted on chain in bounded gas. A keeper supplies
  the ascending distinct ask prices below `p*` (`indexAskPrices`, ≤ 200 per call); the window verifies each
  price has valid ask quantity, is strictly ascending and below `p*`, and that the indexed quantities sum to
  `s_below` before any ask below `p*` is settled (`PriceIndexInvalid`, `PriceIndexIncomplete`). Only needed
  when cancelled buyer units exceed the asks at `p*` (`priceIndexRequired`).
- **C-S3 (SPEC §7, §12 liveness) — recipient-side failures in the window.** A stablecoin push that fails for
  the recipient (e.g. a blocked account) is recorded in `owed(series, owner)` (`PaymentDeferred`) and retried
  by anyone with `withdrawOwed` (pays the owner only), so no recipient can block another order or the window.
  Units always move (identities are never deleted, SPEC §4.2).
- **C-S4 (SPEC §6.1 accrual weight vs per-order window processing).** SPEC counts ask-escrow units in the
  seller's weight until the ask is processed; the reference processes a window atomically, but on EVM bids
  are processed (units delivered) before asks, so a payout landing in between would be earned twice (buyer
  balance + seller escrow) and the vault would become insolvent. Implemented: when a window clears with a
  price the vault accumulator is snapshotted (`accAtClear`); the seller's escrow weight stops there; payouts
  after clearing are credited by `creditWindowAccrual` to the **buyer** of a sold unit (from `accAtClear`, at
  its fill) and to the **seller** of an unsold unit (at its ask's processing). Every unit earns for exactly
  one wallet at every moment, so `Σ claims == distributions − dust` (fuzz `WindowFuzz`, invariant
  `invariant_vaultSolventAndExact` incl. the stranded-value bound). Divergence from the reference only when a
  payout lands between `finalize_window` and `process_orders`: the reference pays the sold units' share to the
  seller, the EVM to the buyer (no vector covers it; the trade is economically done at clearing).
  `pendingOf` excludes the not-yet-credited part until the order is processed.
- **C-S5 (SPEC §7) — windows on a series that becomes terminal.** A window opened while the series was live
  whose finalization comes after retirement, redemption or extinguishment is forced to `NoMatch` (every order
  returned). A window that already cleared is processed normally; `claim_final` of a seller with a cleared,
  unprocessed ask reverts `OutOfOrder` until the order is processed (its units are either sold or coming back).
- **C-S6 (SPEC §7 marginal cursor).** SPEC fills the marginal side first-come behind a processing cursor
  (`next_marginal_reveal_index`). On EVM the fill is computed from `samePricePrefix` (the valid quantity at the
  same side and price revealed earlier, fixed at reveal), which gives the identical first-come result in any
  processing order, so one unprocessed order can never block the others. Asks that sell units wait for every
  bid (`OutOfOrder`) because cancelled buyers' units are taken back from them.
- **C-S7 (SPEC §5.2 finalize).** A valid proposal whose computed `units_sold` is 0 is treated like a min-raise
  failure (`Failed`, full refunds) rather than a settled raise with no units.
- **C-S8 (reference `ytdAtEnd`).** For a period before the settlement quarter the EVM returns `(true, 0)`
  (nothing can have been routed for the series yet), so the prior binding of a tier-1 series' first report is
  well defined; the reference answers "not closed" there.
- **C-S9 (SPEC §6.5 true-up year).** The reference accepts a true-up for a year that ended before settlement;
  the EVM rejects it (`TrueUpYearInvalid`): no payment of that year exists to adjust.
- **C-S10 (SPEC §6.5 / §6.3 `year_gross`).** A paid true-up is booked in the `year_gross` slot keyed by the
  report deadline of `period_of(attested_at)`, the same anchor rule as a quarterly payment (SPEC §6.3); the
  reference anchors at `attested_at` itself. The two differ only when `attested_at` and that deadline fall
  in different settlement years.
- **C-S11 (SPEC §6.4 router).** After a terminal status the router passes income through to the issuer;
  amended θ/r apply to marginal income from the next report (A26); router checkpoints are an unbounded
  mapping (one entry per closed period).
- **C-S12 (SPEC §4.2 vs ERC-3643).** `moduleCheck` reverts with `DirectTransferForbidden` /
  `UnarmedEscrowDeposit` instead of returning false, so the canonical error bubbles out of `transfer`.
  Consequence: T-REX `canTransfer` reverts (rather than returning false) for a forbidden transfer.
- **C-S13 (SPEC §3.2 `create_series(params, …)`).** Economic terms (cap multiple, hurdle, k, lockup, wallet
  cap, durations) come from the issuer's params within bounds; the four fee rates are copied from the
  registry defaults at creation (fees are protocol terms; the brief fixes them per series for life). Vectors
  assert the copied fees equal the defaults.
- **C-S14** `StatusChanged(series, oldStatus, newStatus)` — `old`/`new` are reserved in Solidity.
- **C-S15** `SeriesCreated(series, issuer, mode, stablecoin, terms, termsCommitment, tierFlags, fxPairId)` with
  `terms` a `SeriesTerms` tuple (the flat 19-field event does not compile under the legacy pipeline used for
  fast iteration); the tuple carries every charter field.
- **C-S16 (SPEC §6.5)** extra true-up guards: `attestation_ts` in the future → `AttestationInFuture`; a
  terminal series → `TerminalStatus`.
- **C-S17 (SPEC §7)** one window per series per quarter (`period == period_of(now) − 1`, never reopened).
- **C-S18 (SPEC §7)** a window with no orders goes straight to `Done` at finalization.
- **C-S19 (SPEC §1.1 entry rule)** `bidCommitment` / `orderCommitment` and every amount/price/quantity entry
  point take `uint256` and revert `AmountOutOfRange` for values ≥ 2^64 (vector 21).
- **C-S20 (SPEC §6.1 `register_holder`, defect).** SPEC (and the reference) start a new holder's tail and final
  checkpoints at the current accumulators. A buyer registered at its fill after redemption or extinguishment
  (window cleared before) holds units that existed at the snapshot, so it would get no tail / final share and
  that share would strand in the vault. The EVM starts both checkpoints at 0 (only such units can reach a
  late-registered wallet). Test: `Window.t.sol::test_buyerRegisteredAfterExtinguishmentGetsTheFinalShare`.
- **C-11 (SPEC §6.6 cross-check).** A Chainlink answer that is missing, non-positive, older than the FX
  staleness bound or with > 36 decimals is not a comparison and flags nothing (the reference flags a stale
  cross-check). Snapshots stay permissionless on a disabled pair (SPEC §3.1); the cross-check of an inverted
  pair is inverted like the Pyth rate.
- **C-1 (SPEC §6.9) extinguishment with early draws.** `unreleased = proceeds − vested(now)`, capped by the
  treasury balance (early draws may have released more than vested). Tranches vested before extinguishment
  stay claimable by the issuer's wallet (A31).
- **C-2 (SPEC §4.2 governor).** `MercesTokenGovernor` has no function at all: the T-REX implementation
  authority is owned by the timelock directly, so the governor needs no forwarding function.
- **C-3 (SPEC §5.3 early draw).** The approver is called as `approveEarlyDraw(series, amount, nonce)` (view,
  boolean); disabled while unset (default).
- **C-4 timelock-only powers.** Besides upgrades, the timelock owner can replace the Groth16 verifier
  (`MercesIncome.setGroth16Verifier`) and the Pyth address (`MercesFxAccumulator.setPyth`) — upgrade-equivalent
  powers behind the same delay, listed in `docs/evm/AUDIT-NOTES.md`.
- **C-5 indirect admin influence (SPEC-defined).** Revoking every verifier key / attestor, or turning
  `tier4_enabled` off, stops new reports *through that tier* (revocation is forward-only with a grace period
  for ended periods). Releases, claims and redemption are never gated by the admin.

## Vector harness readings (`test/parity/`)

- Fresh deployment per vector through `MercesDeploy` (the deploy scripts' library); admin `__admin`,
  allowlist manager `__allowlistManager`, keeper `keeper`; `config.parameters` become the registry defaults
  (brief-fixed constants are asserted equal to `MercesConstants`).
- Actors with a key sign with `keccak256("MERCES_TEST_KEY" ‖ seed) mod (n − 1) + 1` (checked against the
  vector's `privateKey`/`address`); every other actor is `address(keccak256("merces.vector.actor:" ‖ name))`.
- Signatures are produced over the EVM digests (§1.4 with the EVM domain) with `vm.sign`; proofs come from
  `proofEvm`; a cross-check feed is a `MockChainlinkAggregator` per pair (decimals and answer set by
  `fx_snapshot`).
- `expect_revert` compares the 4-byte selector with the canonical error (`VectorErrors.sol`, generated from
  `packages/sdk/src/errors.ts`); reverted calls leave state unchanged by EVM semantics.
- `expect` checks every listed field to the base unit plus pool consistency: Σ per-series treasury / vault /
  auction / window views equal the contracts' real balances; `status` is `deriveStatus(now)`; `raiseState`
  is `Draft` from the registry, otherwise the auction state; `rejectionReason` 1/2 map to
  `ClaimMismatch`/`InvalidClearingPrice`; window `clearingPrice`/`branch` are null unless the window cleared
  with a price; `holders` must list every registered actor.
