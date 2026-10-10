# STAGE1_INTEGRATION.md

How Stage 2 works without Stage 1 today, how it catches Stage 1 the moment it appears, and what happens then.
This file is updated at each catch-up with what matched, what changed and what is still open.

## Status (2026-10-10): Stage 1 @1bfc66b pinned, S1 and S2 done

Stage 1 is the `stage1` git submodule, pinned at `1bfc66b` (branch `claude/sweet-goodall-b7acm3`, SPEC v1.1.2; its
tree is identical to `5eafd41`, the commit the handoff named). Its TypeScript packages (`@merces/sdk`,
`@merces/reference`, `@merces/circuits`) are workspace packages, built from the submodule by the root `postinstall`
(`pnpm stage1:build`). `pnpm stage1:sync` and `pnpm stage1:vectors` find the submodule by themselves; `STAGE1_PATH`
overrides it.

The owner approved section B of the drift review below: **Stage 1 wins for onchain behaviour.** S1 applied its first
part: Stage 1's math (imported, not rewritten), Stage 1's report proof format, and a Stage 1 vector runner that replays
Stage 1's own parity vectors against our simulator. S2 applied the sealed-bid raise: Stage 1's multi-step settlement
(B.1), the raise's own terms (B.8, partly) and `register_holder` (B.3, partly), with the non-reveal charge held at 0 by
the owner. "S1 results" and "S2 results" say what changed; "Owner decisions and questions" says what is still open.

**What the handoff was missing** (unchanged at 1bfc66b). Stage 1 ships no `handoff/manifest.json`, so
`stage1.map.json` at this repository's root describes it by hand (A-SYNC-2). Missing (also listed in the map's
`missing` field):

- `handoff/manifest.json` itself;
- Solana devnet program ids and RPC (only `solana/deployments/localnet.json` exists);
- Monad testnet contract addresses and RPC (`evm/deployments/monad-testnet-rehearsal.json` is an anvil rehearsal
  with anvil's default deployer, not a testnet deployment);
- a machine-readable events/commands schema (`EVENTS.md` and `INTERFACES.md` are prose; the diff reads the IDLs
  and ABIs instead);
- stablecoin mints and addresses on devnet and testnet;
- the indexer's start slot and start block.

Reports: `INTERFACE_DRIFT.md` (repository root) and snapshots of the two gitignored reports in `docs/stage1/`
(`MATH_PARITY.md`, `VECTOR_PARITY.md`; regenerate with `pnpm stage1:sync --no-conformance`, which writes them to
`packages/stage1-sync/out`).

| D6 step | Result at @1bfc66b (after S2) |
| --- | --- |
| 1. `stage1:sync` | runs end to end with `--no-conformance` |
| detect | ok: `stage1.map.json` (hand-written) over the pinned submodule |
| generate | ok: 4 Anchor IDLs and 28 ABIs rendered to `packages/stage1-sync/generated` |
| diff | drift: **Solana** 4 canonical items without a counterpart, 249 field mismatches, 79 extra Stage 1 items; **Monad testnet** 2 / 210 / 89 (`INTERFACE_DRIFT.md`; after S1: 3 / 261 / 87 and 1 / 222 / 97). S2's settlement commands and events match Stage 1's by name and field, `tallyBids` apart (Solana's accounts, the EVM's index range); the new item without a counterpart on each chain is `UnitsMinted`, now a curve buy only (a Meteora DBC swap). The rest is left to the adapters' mappers (D6.2) and the rest of section B (S3–S5) |
| math | **ok**: Stage 1 math imported at 1bfc66b. `@merces/math` re-exports 45 `@merces/reference` names (the 11 of the auction family since S2) and `@merces/sdk`'s helpers, and all 45 are Stage 1's own function objects. The interim math is left only under `interim.*` for the window and curve cap and the FX family (both S5). Snapshot: `docs/stage1/MATH_PARITY.md` (A-MATH-1, A-MATH-2) |
| vectors | **ok**: reference backend (Stage 1's own simulator) 25/25 PASS with every embedded proof verified (164 distinct, 3 invalid: the deliberate tamper cases); merces backend (our simulator) `OK: 36/42 PASS, 42/42 at expected status`, on both personalities: the 14 targets in full (S1's ten and S2's 02, 03, 15, 17): 02, 04, 06, 07, 09, 11, 15, 17, 19, 23 and 25 PASS, 01 and 05 PASS-WITH-WAIVERS (`retire_if_capped` BLOCKED, the direct unit transfer N/A), 03 PASS-WITH-DIVERGENCES (DIV-NRC-1, the non-reveal hold); the 7 vectors that need a later milestone, up to their prefix gate (08 #33, 10 #35, 14 #61, 16 #40, 20 #70, 21 #40, 22 #75: PREFIX-PASS); 12, 13, 18 and 24 not replayed (S5). Lockstep agrees step by step on every target, mid-settlement included, and parts on 03 at #65 exactly as recorded. 25 vectors, 2,092 steps, 143 expected reverts. S3 WP2: `claim_tail`, `claim_final` and `burn_retired` run directly (`claimTail`, `claimFinal`, `burnRetired`; shims SH-CLM-2, SH-CLM-3 and SH-BRN-1 retired), at the same statuses, and our seven S3 claim scenarios (the paths no vector takes, on prefixes of 05, 09, 11 and 22) pass on Stage 1's simulator, on ours and in lockstep, 35/35 runs. Snapshot with the shim table and the scenarios: `docs/stage1/VECTOR_PARITY.md` |
| conformance | **blocked**: no devnet or testnet deployment |
| verdict | both chains NOT ready (diff drift; conformance not run) |

Stage 1's own reference suite was re-run here against its vectors at @5eafd41: 171/171 pass.

### S1 results

S1 ran as work packages WP0–WP13 and an integration gate (G2), each committed as `S1 WPn: …`. What changed, by area:

- **Math (WP1, WP13).** `@merces/math` is the one gateway to Stage 1's math: named re-exports of `@merces/sdk`
  (fixed point, periods, pauses, the tagged year ring, parameters, error names, Poseidon commitments) and
  `@merces/reference` (status and accrual, the payout vault, redemption, tail and final pool, treasury vesting,
  income), plus the few helpers Stage 1 has no counterpart for (the `"YYYYQn"` codec, decimals, the per-unit rate, a
  value-free payment wrapper, deadline projection, the display cap). Every money path outside the auction and FX, in
  the simulator, services, indexer and keepers, calls them. What was left of the interim math after S1 was the auction
  family (four names; S2 deleted it) and the FX family (`quarterAverageRate`, `coverageOk`, `deviationBps`,
  `withinBand`, `pythToWad`; S5); a test pins that key list.
- **Simulator state (WP0, WP2, WP13).** The engine is split by area. The persisted state is version 2: Stage 1's
  series ledger (its field names), payout vault, tail and final pool sit beside ours, and the version-1 bookkeeping
  they replaced is deleted. A version-1 state is refused; `sim:reset` clears the simulated chains and their offchain
  rows (RUNBOOK.md). Every error on a Stage 1 path carries Stage 1's error name (`ChainError.detail.stage1`).
- **Reports (WP3, WP10).** Stage 1's commitments (terms: Poseidon(5); income: Poseidon(2) with the prior chain), the
  six public inputs and Groth16 proofs (B.4, partly). `submitReport` runs Stage 1's checks in Stage 1's order
  (sequential periods, no unpaid due, tail rules, tier rules, the prior chain, the signals, the proof, then the
  attestation). The issuer's device keeps the income chain and proves on the device; the report verifier attests
  attestation v1 (with the prior and the liquidity flag); the API and every simulated chain verify the Groth16 proof
  (the ports' `Groth16ReportVerifier`). Mock proofs are refused unless a simulator-only process sets
  `MERCES_PROOF_SYSTEM=mock` (SECURITY.md). Tier 3: the device proves and the opening reaches the attestor end to end
  encrypted (migration 017), in a merces-e2e v1 envelope the API parses and otherwise refuses (S1 review; PRIVACY.md).
- **Status and timing (WP4).** Stage 1's derived status (inclusive ≤ 30 / ≤ 45 days of unpaused time), the formal
  notice at period end + 90 days, Stage 1's sync points, hardship pauses with Stage 1's approval bounds (the requested
  end is advisory), releases gated by Stage 1's underlying lateness (B.9, partly). S1 review: the attestor service
  checks a hardship decision with Stage 1's `pauseApprovalError` on the chain's pause record before it records an
  approval; a refusal carries Stage 1's name and leaves the request pending (A-REV-23).
- **Money (WP5–WP8).** Stage 1's vault (`vaultReceiveGross`: the cap read live, the exact WAD carry, the year ring
  tagged by the report deadline); `payIn` without an issuer check and with the accrual computed when it lands; claims
  for registered holders only, a zero claim succeeding; Stage 1's `redeem` preconditions and quote, the tail
  accumulator and its 365-day window; extinguishment of the unvested treasury through the final pool, refused for an
  unsettled raise (M5); amendments that may only lower the cap within [2, 3]; transfer-window escrow that is never
  burned, asks settling the holder first, NoMatch on a terminal series (B.3, B.5 and B.2, partly).
- **Offchain mirrors (WP10, WP11).** The redemption quote, tail and retirement views, accounting (C_remaining, the
  tail pool, the extinguishment line), the indexer's cap per unit and reporting ledger (served on `Series`), the
  keepers' status instants and reminders, and the OpenAPI shapes follow Stage 1. `claimable` stays the net payout;
  the tail and the final share are separate fields (M9). S1 review: a retirement clears the indexed open due on
  every path, as Stage 1's `retire` does (a split receipt that reaches the cap left it open); a graduated curve's issue
  price travels on `CurveGraduated.issuePrice` (a canonical field added for it, recorded in INTERFACE_DRIFT.md) and the
  indexer sets its cap per unit from it, so the statement's C_remaining and later amendments see the chain's cap.
  A position's `tailClaimable` is Stage 1's `claimableTail` view, which counts a holder that has not redeemed yet on
  the units its redemption would redeem (`claim_tail` redeems first), and the vault's dust counts that tail too; the
  payout claim builder leaves it out until the holder has redeemed, since `claimPayout` has no redemption step
  (A-REV-24). Report-deadline reminders go only to the earliest unpaid period, the one Stage 1's `deriveStatus` counts
  from, and name the status the chain derives when they are queued and what is owed (the report or the payment); they
  had reminded every unsettled period with a hard-coded InGrace, so a series Late on an unpaid Q1 was told InGrace about
  a Q2 report the chain could not take (A-REV-25).
- **Vector runner (WP9a, WP9b, WP13).** `pnpm stage1:vectors` (`packages/stage1-sync/src/stage1-vectors`): a
  reference backend (Stage 1's own simulator), a merces backend (our `SimulatorChain` through op translators and the
  shim table, never persisted, real Groth16 verification with the ports' verifier) and a lockstep oracle that names
  the first field where the two disagree. The merces gate runs in the default test suite. S1 review: a waiver covers
  only its own step (the vector's step index, the op as the report names it, so `expect_revert retire_if_capped` is not
  the action, and the shim row of the right kind); an op outside S1 has no row and is never waived, where any of them
  landing on 01#32, 01#34 or 05#42 had been. The `expect_revert` check compares the engine right after the failing
  transaction raised, before the merces world undoes the op; it had compared only afterwards, so a revert that changed
  the state could not fail there. A call the backend carries out as several transactions (`claim_tail`, SH-CLM-2, until
  S3 WP2 made it the direct `claimTail`; no row needs it since, and a test keeps the mechanism on a synthetic row) is
  undone by the runner when a later one reverts: such a revert is reported as runner-atomic, and a shim row not marked
  runner-atomic may send only one transaction. "Used in" counts the shims of calls that reverted as expected
  (`amend_terms` in 05 and 11, `redeem` in 01, 05 and 11).
- **Tests (WP12).** Every pin S1 moved names its cause code; the moved figures were recomputed with Stage 1's own
  simulator.

**The S1 gate**, all green at the S1 commit:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exits 0 |
| `DATABASE_URL=… pnpm vitest run` | 53 files, 324 tests passed |
| `MERCES_TEST_DB=1 pnpm vitest run --project canary` | 2 files, 3 tests passed |
| `pnpm stage1:vectors --personality solana,monad` | exits 0: `OK: 16/20 PASS, 20/20 at expected status` (10 targets × 2 personalities) |
| `pnpm stage1:vectors --backend reference` | exits 0: `OK: 25/25 PASS, 25/25 at expected status` |
| `pnpm stage1:sync --no-conformance` | math and vectors `OK` (diff `WARN`, conformance skipped) |
| `grep -rn "interim\." packages/simulator/src` | only `engine/{auction,fx,window,curve}.ts` |

### S2 results

S2 ran as work packages WP1–WP8 (WP4 in two parts), each committed as `S2 WPn: …`, on the S1 review fixes. It applied
B.1 (auction settlement), the raise's part of B.8 and `register_holder` from B.3. What changed, by area:

- **Math (WP1, WP8).** `@merces/math` re-exports Stage 1's auction family by name (`walletCapUnitsAtAuction`,
  `requiredEscrow`, `isBidValid`, `beginSettlement`, `tallyBids`, `isClearingPriceValid`, `finalizeSettlement`,
  `marginalAllocation`, `processBid`, `claimsFor`, `findClearingPrice`; 45 re-exports in all). Every auction figure in
  the simulator, the services' precheck and preview and the planner's dry run is Stage 1's. The interim auction family
  (greedy clearing, deposit, fee) is deleted; the interim `walletCapUnits` (at least one unit) stays only for the
  transfer window and the curve until S5 (A-MATH-1).
- **Raise terms (WP2).** `commitDurationSeconds`, `revealDurationSeconds` and `nonRevealChargeBps` are series terms,
  bounded as Stage 1's `create_series` bounds them on a sealed raise (A-TERMS-4); `openRaise{seriesId}` checks Stage 1's
  order (NotIssuer, RaiseNotDraft, ContractHashMissing, NotAllowlisted, NewRaisesPaused) and derives the phase ends from
  the terms (A-AUC-5). Migration 018.
- **Vocabulary (WP3, WP8).** Stage 1's names: the permissionless commands `beginSettlement`, `tallyBids{maxBids?}`,
  `finalizeSettlement`, `processBid`, `deliverBid` and `registerHolder` (the keepers submit them; any wallet may build
  them) and the events `SettlementProposed`, `SettlementRejected`, `UnitsAllocated`, `BidDelivered`,
  `RaiseMintFinalized` and `HolderRegistered`; `BidRevealed.valid`; `AuctionSettled` carries `RaiseSettled`'s fields only
  and `AuctionFailed` `RaiseFailed`'s plus `unitsSold`. The one-step settlement, the pull refund and its event are
  deleted (WP8); `UnitsMinted` is a curve buy only. `ChainInfo.limits` gives each chain's tally page and bid limit
  (A-AUC-6). One planner (`nextSettlementStep`, from the stored raise state) and one driver (`runSettlement`) serve the
  keepers, the harness, conformance and the API; one helper (`settlementOutcome`) applies D7 (A-AUC-7). The domain
  schema is version 0.2.0: 48 events, 42 commands.
- **Engine (WP4a).** The simulator stores Stage 1's `Auction` and `Bid` records and runs `open_raise`, `commit_bid`,
  `reveal_bid`, `begin_settlement`, paged `tally_bids`, `finalize_settlement`, `process_bid`, `deliver_bid`,
  `cancel_raise` and `register_holder` with Stage 1's checks in Stage 1's order and Stage 1's error names. Validity is
  fixed at reveal (an over-cap bid is invalid and refunded in full, A-AUC-4); a failed raise keeps its would-be price and
  results; money moves bid by bid at processing (`FeeTaken{auction}` and `TreasuryFunded` per winner); MintNotFinalized
  gates every path Stage 1 gates; a winner holds and accrues from processing (A-AUC-8) and the redemption and final
  claims deliver a pending bid first; a bidder removed from the allowlist stays valid (A-REV-2 withdrawn); the
  non-reveal hold applies 0 bps and refuses any charge (A-AUC-11). State version 3 (`sim:reset`).
- **Callers (WP4b, WP6, WP7).** Every caller runs the steps. Indexer (migration 019): the auction record, settlement
  rounds, each bid's validity, processing and delivery, undelivered units, holder registrations kept apart from
  positions (A-REV-10), the keepers' delivery table. Services: precheck and preview on Stage 1's math,
  `advanceSettlements` and `deliverDue` (from the chain's bids, with a per-bid backoff and stuck alerts, A-AUC-13).
  Keepers: `auction.settle` and `auction.deliver` as separate jobs; a raise with no bid waits 24 hours for the issuer's
  cancel (A-AUC-12); errors carry codes, never messages. Notices: a rejected round, the mint finalised, a bid delivered,
  a stuck delivery or settlement, with no amounts. The services' mint gates (extinguishment, the redemption quote,
  reconciliation). API: `POST /series/{id}/bids/build-deliver` for any wallet, `POST /series/{id}/auction/build-step`,
  the issuer's `raise/build-open` and `raise/build-cancel`, typed auction reads; 161 operations.
- **Vector runner (WP5).** 02, 03, 15 and 17 are targets. SH-AUC-1 and SH-AUC-3…6 are gone (only SH-AUC-2, our bid
  commitment, stays until S4), and the auction, holder and balance views come from the engine. A known divergence is a
  first-class entry (`stage1-vectors/divergences.ts`): DIV-NRC-1 accepts exactly the five fields of 03 the hold changes,
  fails on any other value there, and fails as stale once the hold lifts. Prefix gates keep the auction prefix of 08,
  10, 14, 16, 20, 21 and 22 green; lockstep compares mid-settlement.
- **Tests.** Every moved pin names its S2 cause code (S2-G, -AD, -CR, -E, -VR, -MS, -PR, -FP, -DA, -MF, -PU, -NRC, -RH,
  -V3, and the runner's -NY and -LS); moved figures were recomputed with Stage 1's own simulator.
- **Privacy.** Settlement rounds and results and each bid's processing and delivery are public onchain, and none is
  income. Activity summaries name rounds, reasons and unit counts only; notices name no amount; keeper errors and
  `auction_deliveries` hold codes only; the outbox keeps the events' public onchain amounts (PRIVACY.md).

**The S2 gate**, all green at the S2 WP8 commit:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exits 0 |
| `DATABASE_URL=… pnpm vitest run` | 59 files, 428 tests passed |
| `MERCES_TEST_DB=1 pnpm vitest run --project canary` | 2 files, 3 tests passed |
| `CONFORMANCE_CHAIN=simulator` / `simulator:monad` `pnpm vitest run --project conformance` | 18 and 10 tests passed |
| `pnpm stage1:vectors --personality solana,monad` | exits 0: `OK: 36/42 PASS, 42/42 at expected status (14 prefix runs; 2 runs with accepted divergences)` |
| `pnpm stage1:vectors --backend reference` | exits 0: `OK: 25/25 PASS, 25/25 at expected status` |
| `pnpm stage1:vectors --backend lockstep --personality solana,monad` | exits 0: `OK: 36/42 PASS, 42/42 at expected status`; 03 diverges at #65 as recorded (DIV-NRC-1) |
| `pnpm stage1:sync --no-conformance` | math and vectors `OK` (diff `WARN`, conformance skipped) |
| `pnpm openapi:check` | `openapi.yaml matches 161 operations` |
| `grep -rnE "settleAuction\|claimRefund\|BidRefunded\|clearAuction\|bidDeposit\|\bauctionFee\b" packages --include=*.ts \| grep -v generated` | empty |

### Adapter notes for the auction (S5)

What the live adapters normalise so the canonical settlement reads the same on both chains (from Stage 1's programs and
contracts at 1bfc66b):

- **Tally pages.** The EVM's `tallyBids(seriesId, fromIndex, toIndex)` takes an index range (at most 200 a call and
  4,096 bids an auction, `TooManyBids`); Solana's `tally_bids` takes up to 24 bid accounts as remaining accounts. The
  adapter turns the canonical "next page of at most `maxBids`" into either (A-AUC-6).
- **Escrow total.** Solana's `escrow_total` only grows (the amount ever committed); the EVM and the canonical model keep
  the live balance. The Solana adapter reports the live balance.
- **R.** Solana stores no `R` on the auction: when the raise is Settled the adapter reads the accepted proposal's
  `r_claim`.
- **Dropped events.** The EVM's `BidProcessed` (a bid processed without allocation) and `MintAuthorityRevoked` have no
  canonical event; `RaiseMintFinalized` marks every bid processed. The EVM emits `NonRevealCharged` with 0 for every
  unrevealed bid: while the owner holds the charge the adapter drops it (Solana emits it only above 0, which the hold
  rules out).
- **DeliverFirst.** Solana's `claim_redemption` and `claim_final` revert with DeliverFirst while the holder has
  undelivered units; the canonical model delivers inline, as the EVM and Stage 1's reference do, so the Solana adapter
  prepends `deliver_bid` to those transactions.
- **Synthesised events.** `TreasuryFunded` on Solana and `FeeTaken{auction}` on both chains come from each
  `UnitsAllocated` (its `cost` and `fee`); `AuctionFailed.unitsSold` and `reason` from `RaiseFailed` (section A).
- **Deployment and fees.** The Solana fee collector's token account must exist before the first `process_bid`; the
  keepers pay a winner's Holder PDA rent at `process_bid` and the bidder's token accounts at `deliver_bid`, and set a
  compute-unit limit on `process_bid` (A-AUC-10).

### Owner decisions and questions

Decided (S1 review):

- **Section B is approved:** Stage 1 wins for onchain behaviour. Import `@merces/reference` instead of rewriting the
  math. Order: math and the report proof format first (vectors 04, 06, 07, 09, 11, 19, 23, 25), then auctions,
  claims, signatures, the rest.
- **Non-reveal charge: not modelled.** Settlement keeps refunding unrevealed bids in full. Vector 03 (b8, charged on a
  settled raise) waits for the owner; no S1 target has a non-revealer.
- **Formal notice mirrors Stage 1** (period end + 90 days): applied in S1.
- **Window fee:** a series parameter, value undecided; not in S1 (S5).
- **Tier-1 public terms:** accepted, with an explicit issuer consent step; not in S1 (tier-1 milestone).
- **Curve:** no wallet cap for curve raises, and "no cap" said everywhere (S5, A-CURVE-2); the buyer notice wording;
  curve staking first-class (S3).
- **Extinguishing an unsettled raise** (critique M5): adopt Stage 1 now (RaiseNotSettled); applied in S1 WP7.
- **Persisted simulator data:** no environment holds data worth keeping; `sim:reset` runs before the version-2 build
  is deployed.

Decided (S2):

- **`register_holder` comes into S2**, with the `HolderRegistered` event both chains emit, so vector 17 passes
  (A-AUC-9); the claims around it stay in S3.
- **Non-reveal charge: still held, minimal plumbing only.** The owner was told what Stage 1 does: at `process_bid` on a
  settled raise, Stage 1 keeps `floor(escrow × nonRevealChargeBps / 10000)` of a bid committed and never revealed (100
  bps by default) and pays it to the fee collector; a failed raise charges nothing. S2 keeps the series term (for
  `create_series` parity), applies 0 bps, refuses a non-zero charge in the engine, and adds no event, fee kind, column,
  accounting row or API field for it (A-AUC-11). Vector 03 shows the five fields this changes (DIV-NRC-1).

Open, with the default S2 uses meanwhile:

1. **Non-reveal charge: still on hold.** S2 creates every new series with 0 bps (`DEFAULTS.nonRevealChargeBps`), live
   chains included. What lifting it adds is in the divergence register below and in A-AUC-11.
2. **Series created during the hold keep 0 bps.** Their charters are frozen, so lifting the hold changes new series
   only; a live series created meanwhile never charges a non-revealer.
3. **Stage 1's two internal inconsistencies (D7)** are resolved toward SPEC and both chains and should be reported to
   Stage 1: its TS reference settles a round that would sell 0 units (SPEC and both chains fail it), and its simulator's
   `RaiseMintFinalized` on a failed raise carries the would-be units and proceeds (both chains emit 0 and 0) (A-AUC-7).

Open since S1, with the same defaults:

1. **Who attests `liquidityEvent` for tier 2?** zkTLS data cannot show a liquidity event. Default: the report
   verifier signs the flag the device declares (A-REV-1).
2. **A lost device-held opening blocks that year's next proof.** The next quarter's proof needs the previous
   quarter's year-to-date figure and salt, which only the issuer's device holds. Default: salts are derived from a
   device secret (`deriveIncomeSalt`), so a reinstalled device rebuilds its openings from its own records; there is
   no server-side copy (PRIVACY.md). A series' first report in mid-year supplies its own prior, which only the
   attestation binds (Stage 1 A25).

### Divergence register (Stage 1 behaviour knowingly not mirrored after S2)

| Divergence | Milestone |
| --- | --- |
| **Non-reveal charge (owner hold): not modelled.** Stage 1 keeps `floor(escrow × nonRevealChargeBps / 10000)` of an unrevealed bid's escrow on a settled raise for the fee collector. Ours: `nonRevealChargeBps` is a series term (bounded 0–1,000 bps on a sealed raise); new series record 0, live series included, and keep it (frozen charters); 0 applies whatever a series records (`NON_REVEAL_CHARGE_HELD`, `appliedNonRevealChargeBps`), so an unrevealed bid is refunded in full, and the engine refuses a non-zero charge. The vectors see it as DIV-NRC-1 in 03 only: #67 `feeCollector`, `auctionEscrow`, `auction.escrowTotal` and #77 `balances.b8.stable`, `feeCollector` (b8's 101 USDC); lockstep parts at #65. **Lifting the hold adds:** `NON_REVEAL_CHARGE_HELD = false` (new series default to Stage 1's 100 bps; series created during the hold keep 0); the engine credits Stage 1's charge to the fee collector; the canonical event `NonRevealCharged{seriesId, bidder, charge}` and `FeeTaken{kind: 'nonReveal'}` (`feeKindSchema` gains `nonReveal`); the indexer's `bids.non_reveal_charge` column (an unrevealed bid's indexed pending refund, set at `RaiseMintFinalized`, then nets it) and `BidState.nonRevealCharge`; the fee ledger, reconciliation and accounting `byKind`/`bySeries` rows; the API and OpenAPI fields (accounting `byKind.nonReveal`, the bid's charge, the rate in the bid precheck); notices that name it; the adapters stop dropping `NonRevealCharged`; the vector runner's DIV-NRC-1 entries and 03's lockstep parting go (03 becomes PASS); the docs (A-AUC-11) | after the owner decides |
| Stage 1 internal, resolved toward SPEC and both chains (D7, A-AUC-7): a round that would sell 0 units fails the raise (MinRaise), where Stage 1's TS reference (`auction.ts` `finalizeSettlement`) settles it; a failed raise's `RaiseMintFinalized` carries 0 and 0, where Stage 1's simulator emits the would-be units and proceeds; a failed raise's time is `AuctionState.finalizedAt` and `SeriesState.settledAt` stays null. No vector exercises the first. S3: Stage 1's reference `claim_tail` runs the redemption body before its NoRedeemedUnits check, so for a holder whose units are all held for a window ask its simulator pays the holder's pending payout and then raises without restoring it (its own `checkRevert` would flag the state change; the chains revert the transaction, and so does ours; no vector reaches it) | reported to Stage 1 |
| Adapter normalisations (see "Adapter notes for the auction"): the EVM's `tallyBids` index range; Solana's cumulative `escrow_total`; Solana's `R` read from `r_claim`; the EVM's `BidProcessed` and `MintAuthorityRevoked` dropped; the EVM's `NonRevealCharged(0)` dropped; Solana's DeliverFirst on the redemption and final claims (the canonical model delivers inline, as the EVM and Stage 1's reference do) | S5 (adapters) |
| The EVM's 4,096-bid limit per auction (`TooManyBids`) is not enforced by the simulator's monad personality; `ChainInfo.limits.maxBidsPerAuction` reports it | S5 (adapters) |
| Our bid commitment (SH-AUC-2): `commitBid` carries our commitment, not Stage 1's keccak over the packed price, quantity and salt | S4 |
| One-step transfer windows; no windows flag, eligibility or fee (B.2) | S5 |
| `claimPayout` = claim + tail + final (B.3; `register_holder` exists since S2). Since S3 WP1 the canonical `claimTail`, `claimFinal` and `burnRetired` run Stage 1's bodies, and since WP2 the vector runner sends `claim_tail`, `claim_final` and `burn_retired` as those (SH-CLM-2, SH-CLM-3 and SH-BRN-1 retired; the S3 claim scenarios cover the paths no vector takes, in lockstep); `claim` stays SH-CLM-1 until `claimPayout` becomes Stage 1's `claim` in WP3 | S3 |
| No `retire_if_capped`, `withdraw_pause_request` or `end_pause` commands; `requestPause.until` advisory (B.6) | S5 |
| `payIn` exact-amount and period guards (Stage 1's `pay` takes neither) | S5 (adapters drop them) |
| Tier 1: no router year-to-date binding; split receipts stand in for the router credit | tier-1 milestone |
| True-up, the FX accumulator (trading-day coverage) and the `tier4Enabled` flag (B.6, B.9) | S5 |
| ed25519 signatures with co-signers, attestation v1 as canonical JSON, no revocation grace (B.4) | S4 |
| `register_issuer` by the issuer (Stage 1: admin-only, B.7) | S5 |
| Curve wallet cap enforced while bonding (owner: no cap) | S5 |
| The window durations and the window fee are not series terms, so `createSeries` cannot bound them (Stage 1: ParameterOutOfBounds); the raise durations and the non-reveal charge are terms since S2, bounded on a sealed raise, and unchecked on a curve series (Stage 1 requires 0 there); every canonical term follows Stage 1's `create_series` rules (A-TERMS-4) | S5 |

### Blockers

| Blocker | Needs |
| --- | --- |
| D6.2/3: resolving the remaining drift and replaying the other 11 vectors in full on our simulator (08, 10, 14, 16, 20, 21 and 22 replay up to their prefix gate; 12, 13, 18 and 24 not at all) | the rest of section B (approved): S3 claims, S4 signatures, S5 the rest (S2 auctions done) |
| D6.4: wiring the adapters (`wired = true`) | the adapters' mappers over the remaining drift, then program ids and addresses |
| D6.5: conformance on Solana devnet and Monad testnet | Stage 1 deployed to both (STATUS.md: both RPCs are blocked from Stage 1's build container, U5), funded test wallets |
| D6.6: full raise-to-payout cycle live | D6.5 |
| D6.7: `live` in staging | D6.6 |
| Stage 1's own open items | owner decisions H1–H8; S2 curve-redemption residual (A49); the development trusted setup must be replaced before mainnet (A37). On S2 the code is ahead of `SECURITY_REVIEW.md`, which still says "fix designed, not yet coded": `exit.rs` takes the census without the pool vault (`compute_curve_units(…, true)`), as SPEC v1.1.2 §9, STATUS.md and A49 say |

### The two curve questions, answered from the Stage 1 code

**Where do curve buyers' payments sit before graduation?** In Meteora's DBC pool `quote_vault`, owned by the DBC
pool-authority PDA. Nobody can withdraw it: not Merces, not the issuer (`docs/meteora/CURVE_MODE.md` §8, "Who holds
the raise during the sale"). The series treasury receives money only after graduation: `complete_curve` (anyone,
once `quote_reserve ≥ migration_quote_threshold`) settles the series, then `collect_curve_proceeds` moves the DBC
migration fee (99% of the threshold by default) into the treasury, released on the series schedule; the rest becomes
DAMM v2 liquidity (`solana/programs/merces_protocol/src/curve.rs`). A curve that never graduates stays Open forever:
no cancel, no failure, no deadline, no refund; buyers keep their units and can only sell back into the curve
(SPEC §9). `extinguish` requires a settled raise and a finalised mint (`exit.rs`, `RaiseNotSettled`), so an
ungraduated curve cannot be extinguished and Merces holds nothing to repay. → A-CURVE-3.

**Does the curve program enforce the wallet cap onchain?** No, in neither phase. SPEC §9: curve series store wallet
cap, lockup and raise durations as 0 (`create_series` rejects non-zero values). The DBC base mint has no transfer
hook, freeze authority or permanent delegate, and buys are DBC `swap2` calls sent straight to Meteora's program, so
Merces sees none of them. There is no buy allowlist: the allowlist gates `stake_units`, and only staked units earn.
The backend's cap can only limit buys built through Merces. → A-CURVE-2 (owner: no cap for curve raises, S5).

Other curve facts the model has to absorb: curve mode is Solana only (EVM `createSeries` reverts
`CurveModeUnsupported`); holders earn only on units staked in the series stake vault (`stake_units`,
`unstake_units`); redemption is by tender (`tender_units`, burned in place); `P0 = floor(X × 10^6 / swap_base_amount)`;
accounting is per base lamport (6-decimal units).

### Drift review: resolution (approved by the owner; S1 applied part of it)

The owner approved section B: where Stage 1 and Stage 2 disagree on onchain behaviour, Stage 1 wins. Each item below
says what S1 applied (**S1:**) and which milestone takes the rest; the divergence register above lists what is
knowingly still different.

**A. Adapter-only (no model change).** Names Stage 1 spells differently (`STAGE1_ALIASES`: `drawRelease` ↔
`claim_release`, `AuctionSettled` ↔ `RaiseSettled`, …); the series and holder passed as Solana accounts rather than
args; field renames (`price` → `pricePerUnit`, `old`/`new` → `from`/`to`, `commit_end` → `commitEndsAt`); events the
adapter can synthesise (`TreasuryFunded` on Solana from each `UnitsAllocated.cost` since S2; `FeeTaken` from
`PayoutDistributed.fee` and, for the auction fee, `UnitsAllocated.fee`); the
redemption slippage guard (`maxPricePerUnit`) checked before submitting, since Stage 1's `redeem` takes no bound.
**S2:** the settlement commands and events take Stage 1's own names (`beginSettlement` … `deliverBid`,
`registerHolder`; `SettlementProposed`, `SettlementRejected`, `UnitsAllocated`, `BidDelivered`, `RaiseMintFinalized`,
`HolderRegistered`), so the aliases from the one-step auction's items (its refund event, its pull refund, its one-step
settlement, and `UnitsMinted` ↔ `UnitsAllocated`) are gone, and so are those items (S2 WP8); `UnitsMinted` is a curve
buy only, which has no Merces event (a DBC swap). `AuctionSettled` carries Stage 1's `RaiseSettled` fields only (no
total fees: each winner's fee is a `FeeTaken`). `AuctionFailed` keeps its
approved alias (`RaiseFailed`) with Stage 1's fields plus one of ours: `unitsSold`, which Stage 1's event omits; the
adapters derive it as `proceeds / clearingPrice` when the price is above 0 (exact: proceeds = price × units), else 0,
and `reason` from the price (0: NoValidBids; otherwise MinRaise). The adapters pass a NoValidBids `RaiseFailed`'s price
of 0 through as is; the indexer records that price as null (no bid was valid, so no price was found), as the chain's
auction read and the API's `SeriesAuction.clearingPrice` do.

**B. Canonical model changes (Stage 1 wins).**

1. *Auction settlement.* Stage 1: proposer claims (`begin_settlement`), paged `tally_bids`, `finalize_settlement`
   (a wrong proposal is rejected, not reverted), then per-bid `process_bid` and a retryable `deliver_bid` that pushes
   units and refunds; uniform price with a pro-rata marginal fill `floor(R × q / q_at)` and the remainder unsold; one
   bid per wallet; a bid above the wallet cap is invalid at reveal and refunded in full; 1% non-reveal charge (H1); a
   winner removed from the allowlist after committing still receives units. Ours (before S2): one-step settlement, fill
   by price then commit order, cap applied at allocation, refunds pulled by the bidder, de-allowlisted winners excluded.
   **S1:** not applied (S2). The vector runner shims it (SH-AUC-1…6) and checks our one-step settlement against Stage
   1's tally of the same bids. The non-reveal charge is an owner hold and is not modelled.
   **S2:** applied (WP1–WP8, "S2 results"): Stage 1's steps with Stage 1's names, check orders and error names; the math
   is Stage 1's (`@merces/math`); a page of `tallyBids` is at most the chain's `tallyPageMax`; a bid's validity is fixed
   at reveal; one bid per wallet; a winner removed from the allowlist is delivered; refunds and units are pushed by
   `deliverBid` (the keepers deliver every bid, any wallet may deliver one); a winner holds from processing. Two Stage 1
   inconsistencies are resolved toward SPEC and the chains (D7, A-AUC-7). The vector runner shims only our bid
   commitment (SH-AUC-2, S4). The non-reveal charge stays an owner hold (0 bps, A-AUC-11; DIV-NRC-1 in 03).
2. *Transfer window.* The same multi-step shape (`begin_window_settlement`, `tally_orders`, `finalize_window`,
   `process_order`, `deliver_order`, take-back steps) keyed by period, two-branch clearing with first-come fills at the
   margin, a 100 bps window fee, ask units held in escrow, a terminal series forced to NoMatch (S3). Stage 1 emits
   per-order fills, so the canonical pairwise `UnitsTransferred(from, to)` has no source. **Windows ship disabled**
   (`windows_enabled = false`, A18): the keepers must not open windows until the admin enables them.
   **S1:** the escrow semantics only (WP8): ask units stay escrowed and are never burned, an ask settles the holder
   first, a terminal series clears NoMatch, opening a window during the lockup fails with LockupActive. The multi-step
   shape, the flag, eligibility and the fee (a parameter, value undecided) are S5.
3. *Holder claims.* Separate tail and final accumulators with `claim_tail` and `claim_final`, an explicit
   `register_holder` (cursors start at 0, S1), and a tail catch-up inside the redemption claim (S6). Ours routes the
   tail and extinguishment through the payout accumulator.
   **S1:** Stage 1's accumulators and cursors (WP5–WP7): separate tail and final accumulators whose cursors start at 0,
   holders registered at settlement (or graduation), the tail catch-up inside the redemption claim. `claimPayout` still
   pays claim + tail + final in one command and there is no `register_holder` command (S3).
   **S2:** `registerHolder` (Stage 1's `register_holder`: an allowlisted wallet, idempotent) with `HolderRegistered`,
   which both chains emit; a winner is registered when its bid is processed. A registration holds no units and grants
   no holder access (A-AUC-9, A-REV-10). The separate claims are S3.
4. *Signatures, commitments, proofs.* Attestor and report-verifier keys are **secp256k1** 20-byte addresses on both
   chains, signing Stage 1's `MERCES_*_V1` keccak messages (per-deployment domain, per-series nonces, low-s), and the
   signatures travel as **instruction arguments**; nobody co-signs (our `UnsignedTx.coSigners` and the attestor
   wallet check of A-M5-2 assume otherwise). Ours: ed25519 over canonical JSON. Bid and order commitments are keccak
   over packed integers; terms and income commitments are Poseidon; proofs are Groth16 with public inputs
   `[terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd]`, so
   `submitReport` needs the prior commitment (A25). Ours: sha256 over canonical JSON, a mock prover, our own input
   order. This touches the report verifier's KMS key type, the device prover, the terms vault and the bid flow.
   **S1:** commitments and proofs applied (WP3, WP10): Poseidon terms and income commitments, the prior chain
   (`submitReport.priorIncomeCommitment`), Groth16 with Stage 1's six public inputs, proved on the device and verified
   by the API and the simulated chains; the attestation carries Stage 1's report field set (attestation v1). Signatures
   stay ed25519 with co-signers (S4); bid and order commitments stay ours (bids S4, orders S5).
5. *Extinguishment.* Two distinct attestor signatures with a nonce; only **unvested** proceeds go to holders, vested
   but undrawn tranches stay with the estate (A31, H4); refused unless the raise settled.
   **S1:** applied (WP7): two distinct attestors (co-signing until S4), only the unvested proceeds, through the final
   pool, and refused unless the raise settled (amendment M5).
6. *Missing flows.* The tier-3 true-up is onchain (`submit_trueup`, `pay_trueup`; our A-C8-3 and A-M5-5 assumed it
   was not); the tier-1 income router (`init_router`, `route`, `close_router_period`) is permissionless and keeps θ
   and r in plaintext onchain for tier-1 series (Stage 1 A22: the issuer's choice; our events say θ never goes
   onchain, so this is a privacy decision for the owner); `withdraw_pause_request`; pauses without a requested end;
   key revocation with a 45-day grace (A33); `retire_if_capped`; `resume_issuance`; `request_early_draw`.
   **S1:** a pause request carries no enforced end (`until` is advisory) and approvals use Stage 1's bounds (WP4). S1
   review: the attestor service checks a decision with the same bounds (`pauseApprovalError` on the chain's pause
   record, `@merces/domain` pause-rules.ts) before it records an approval, so it never records one the chain refuses,
   and a refusal leaves the request pending (A-REV-23). The rest is S5 (true-up, router, `withdraw_pause_request`, `retire_if_capped`, `resume_issuance`, `request_early_draw`);
   key revocation with its grace is S4. The router's plaintext θ and r: the owner accepted tier-1 public terms with an
   explicit issuer consent step (tier-1 milestone).
7. *Actors and admin.* `register_issuer` is **admin-only** on both chains (ours is the issuer's own command); there is
   no admin router registration; timelock-only powers need `TimelockController.schedule`/`execute`; the admin
   surface adds `set_flags` (`new_raises_paused`, `windows_enabled`, `tier4_enabled`), `set_fx_pair`, `set_defaults`,
   `set_contract_hash`, admin transfer. One user action can need several transactions (Solana `prepare_raise` then
   `open_raise`), while our builder returns one.
   **S1:** not applied (S5); the vector runner shims `register_issuer` (SH-REG-1).
8. *Series parameters and identity.* `create_series` carries mode, tier flags, FX pair, release schedule (≤ 24
   tranches), `k`, hurdle, fee and non-reveal bps, lockup and wallet cap, and the terms commitment. EVM series ids are
   `uint256` counters, not addresses. Defaults differ: lockup 547.875 days (ours 540), tail 365 days (ours 360). Our
   `walletCapBps` must be positive, which rejects every Stage 1 curve series (cap 0).
   **S1:** the defaults (WP2, WP6): lockup 547.875 days and the 365-day tail come from Stage 1's `DEFAULT_PARAMETERS`.
   S1 review: `createSeries` applies Stage 1's `create_series` rules in Stage 1's order (SIM:756-781): every canonical
   bounded term within `PARAMETER_BOUNDS` (ParameterOutOfBounds), units, reserve, a reachable minimum raise and a wallet
   cap of at least one unit (InvalidTerms), then `validateReleaseSchedule` (InvalidReleaseSchedule); the terms service
   checks drafts with the same rules (`seriesTermsViolations`, A-TERMS-4). The new-raises flag refuses `openRaise` only
   (NewRaisesPaused, SIM:875), no longer `createSeries`, except that creating a curve raise, which starts it, is refused
   as Stage 1 refuses activating a curve (A-ADM-2). The creation shape (mode, FX pair, durations, non-reveal and window
   bps) and curve series with cap 0 are S2 and S5.
   **S2:** the commit and reveal durations and the non-reveal bps are series terms, bounded as Stage 1 bounds them on a
   sealed raise; `openRaise` takes the series only, checks Stage 1's order and derives the phase ends from the terms
   (A-AUC-5). The charge itself stays an owner hold: new series record 0 (A-AUC-11). The window durations and fee, the
   FX pair and curve series with cap 0 are S5.
9. *Status and timing.* The formal notice falls at period end + 90 days (ours + 120); OnTime lasts while the
   countdown is ≤ 30 days and InGrace while ≤ 45 days (ours switches at the boundary); `D_avg` buckets a payment by its
   period's deadline, not by when it arrived; FX coverage counts trading days, and weekend snapshots revert.
   **S1:** applied except FX (WP4, WP5): the formal notice at period end + 90 days, the inclusive ≤ 30 / ≤ 45-day
   bounds, `D_avg` from the year ring tagged by each payment's report deadline. FX trading-day coverage is S5.
10. *Indexer and codecs.* Stage 1 events carry no stream sequence, while our indexer requires a dense `seq` (the
    adapter must keep its own counter, or the indexer accepts a strictly increasing one). Codecs: `period` u32 ↔
    `"YYYYQn"` (and a calendar year for true-up notices), `pair_id` bytes32 ↔ `"EUR/USD"`, base58/hex keys. Some enum
    codes differ between the chains (`UnitsBurned.reason`, `WindowCleared.branch`), event order inside a transaction
    differs between the chains, several canonical events are joins (`PaymentReceived` = `PaymentSettled` +
    `PayoutDistributed`), and the Solana decoder must accept only Merces program frames and skip failed transactions.
   **S1:** the period codec (`toPid`/`fromPid` over Stage 1 period ids) is in `@merces/math`; the rest is adapter work
   (D6.2).
11. *Curve mode.* Solana only; no `buyCurve` in Merces (a DBC swap; the backend could still build the unsigned
    Meteora swap); `activate_curve`, `complete_curve`, `collect_curve_proceeds`, `sync_curve_units`, staking and
    tender; no cancel, failure or extinguishment before graduation; units in base lamports (6 decimals). Our Meteora
    service must generate configs with creator fee 0 and the Merces PDA as fee claimer, or activation fails (H3).
   **S1:** only extinguishment (refused before graduation, WP7). The rest is S5; the owner decided curve raises carry
   no wallet cap.
12. *Math.* Replace the six disagreeing families with Stage 1's formulas (or import `@merces/reference`), then
    replay the 25 vectors through a Stage 1 op runner on the simulator with full-state expectations.
   **S1:** applied (WP1, WP9a, WP9b): `@merces/reference` is imported through `@merces/math`, and Stage 1's vectors are
   replayed through a Stage 1 op runner with full-state expectations: all 25 on Stage 1's own simulator, the 10 S1
   targets on ours.

**Stage 1 documents that disagree with Stage 1's code** (the code, IDLs and vectors win): `SECURITY_REVIEW.md` on S2;
`EVENTS.md` field lists in several places; `CURVE_MODE.md` §5 (claims are gated by staking); the vectors declare
`specVersion "1.1"` while testing v1.1.2 fixes; vector 15's notes say a non-revealer is charged while its expectations
show a full refund (the expectations match SPEC §5.2).

## What we expect from Stage 1

A handoff manifest at `$STAGE1_PATH/handoff/manifest.json` (or `manifest.json` at the root). Every field is optional;
unknown fields are kept:

```json
{
  "version": "…", "commit": "…",
  "math":    { "package": "<path to Stage 1's math package (packages/reference), whose functions @merces/math re-exports>" },
  "vectors": "<path to parity vectors (format below)>",
  "events":  { "doc": "EVENTS.md", "schema": "<JSON schema: {events: {Name: {properties}}, commands: {Name: {properties}}}>" },
  "solana":  { "cluster": "devnet", "rpcUrl": "…", "programs": { "<module>": "<program id>" }, "idlDir": "<dir of Anchor IDL json>", "startSlot": 0 },
  "evm":     [ { "chain": "monad-testnet", "chainId": 10143, "rpcUrl": "…", "startBlock": 0, "contracts": { "<module>": "<address>" }, "abiDir": "<dir of ABI json>" } ],
  "stablecoins": { "solana": { "USDC": "<mint>", "USDG": "<mint>" }, "monad-testnet": { "USDC": "<address>" } }
}
```

If Stage 1 arrives without a manifest, write `stage1.map.json` (same shape) by hand at the Stage 1 root or at this
repository's root; the pipeline accepts either (the repository's copy only for a non-empty `STAGE1_PATH`, and it
reports a checkout at another commit than the map pins). Stage 1 @5eafd41 (and @1bfc66b, the same tree) needed the
hand-written map.

`@merces/math` imports Stage 1's math from the pinned submodule's workspace packages (built by the root `postinstall`);
the math step of `stage1:sync` checks that the checkout is at the pinned commit and that every re-export is Stage 1's
own object (A-MATH-1, A-MATH-2).

### Parity vector format

Stage 1 publishes its own vector directory (`packages/vectors`, `NN_name.json`: SPEC ops, full-state `expect` checks
and `expect_revert` with Stage 1 error names), which the Stage 1 vector runner replays (`pnpm stage1:vectors`). The
earlier Merces format below is still accepted as a single JSON file of `scenarios`, replayed through the harness:

```json
{
  "scenarios": [ {
    "name": "happy-path", "genesis": 1767225600, "personalities": ["solana", "monad"],
    "steps": [
      { "at": 0,  "actor": "issuer",   "command": { "kind": "registerIssuer" } },
      { "at": 10, "actor": "keeper",   "command": { "kind": "finalizeSettlement", "seriesId": "$series0" } },
      { "at": 20, "actor": "backer-1", "command": { "kind": "revealBid", "...": "..." }, "expectError": "WrongPhase" }
    ],
    "expect": { "balances": { "backer-1": { "USDC": "…" } }, "series": { "$series0": { "status": "OnTime", "unitsOutstanding": "500" } } }
  } ]
}
```

Actors: `issuer`, `backer-N`, `attestor-N`, `admin`, `keeper`, `allowlistManager`, `router`. `$seriesN` is the N-th
series created in the scenario. Bigint arguments are decimal strings. Every expected balance must match the simulator
to the base unit; a mismatch means the simulator is wrong and is fixed.

## `pnpm stage1:sync`

1. **detect** — manifest or map through `STAGE1_PATH`, else the pinned `stage1` submodule; "Stage 1 not present"
   otherwise.
2. **generate** — EVM ABIs → `packages/stage1-sync/generated/evm/*.ts` (`as const` for viem); Anchor IDLs →
   `generated/solana/*.ts` (built-in renderer; Codama can replace it once Stage 1 pins an IDL spec version).
3. **diff** — `INTERFACE_DRIFT.md`: every canonical event and command, its Stage 1 counterpart, field-by-field mapping,
   and anything missing, extra or differently shaped. Only exact names (ignoring case, `_` and `-`) map; a look-alike
   (`fee` vs `feeBps`) is listed as an unverified match, and it, extra fields/args and names-only items all count as
   drift. The step is `ok` only when nothing is left to resolve.
4. **math** — `@merces/math` runs Stage 1's functions, so the step checks the pin and the wiring: the Stage 1
   checkout is at the commit the manifest pins, and every re-exported Stage 1 name is Stage 1's own object; it also
   lists the interim families still exported (`MATH_PARITY.md` under `packages/stage1-sync/out`; A-MATH-1, A-MATH-2).
   Behavioural parity is the vectors step's job.
5. **vectors** — Stage 1's own vector directory is replayed by the Stage 1 vector runner (`pnpm stage1:vectors`,
   `packages/stage1-sync/src/stage1-vectors`): on the reference backend (Stage 1's own simulator; all 25 must pass,
   proofs verified, or the runner or the checkout is broken) and on the merces backend (our simulator, both
   personalities: the S1 and S2 target vectors in full, and the vectors that need a later milestone up to their prefix
   gate, each at its expected status; the default test suite runs the same gate). Known divergences are recorded per
   step and field (`stage1-vectors/divergences.ts`, DIV-NRC-1 for the non-reveal hold in 03): a recorded difference is
   accepted (PASS-WITH-DIVERGENCES), another value fails, and an entry that no longer occurs fails as stale. Report
   proofs are verified with the ports' `Groth16ReportVerifier`, the verifier the API and the simulated chains run. `VECTOR_PARITY.md` lists the results,
   the findings with leaf-path diffs, the known divergences, the prefix gates, waived steps, runner-atomic reverts, the
   shims used ("not parity", the calls of expected reverts included) and the op inventory. A single JSON
   file of `scenarios` (the earlier Merces format) is replayed through the harness.
6. **conformance** — the H2 suite against each live chain (`CONFORMANCE_CHAIN=solana|evm:<chain>`).
7. **verdict** — per chain: ready for `live` only when no step failed and both **diff** and **conformance** are `ok`
   (drift left to resolve, or conformance skipped or not run, is a blocker); otherwise the blockers.

It runs in CI on a six-hour schedule and whenever `stage1/**`, `stage1.map.json` or `.gitmodules` change
(`.github/workflows/stage1-sync.yml`; set the `STAGE1_REPO` repository variable).

## After Stage 1 lands (D6 checklist)

1. Run `pnpm stage1:sync`; read `INTERFACE_DRIFT.md` first.
2. Resolve drift in the adapters' mappers (`packages/chain-solana/src/mapping.ts`, `packages/chain-evm/src/mapping.ts`).
   Change the canonical model only for a real gap, and record why here.
3. Where Stage 1 contradicts an assumption, Stage 1 wins for onchain behaviour: update the simulator and
   `ASSUMPTIONS.md`. S1 settled A-C8-1/2 (accrual), A-RED-1…4 (redemption, tail, hurdle), A-REP-1/2/3/6 (reporting,
   public inputs, pay-in, tier 1), A-REV-1/3/4/6/17/20 and A-C11-6 (extinguishment, still with counsel); S2 settled
   A-AUC-1/2/3/4 (the auction) and withdrew A-REV-2; still open: A-FX-1/2 (weekends, Chainlink, S5), A-CURVE-2 (no cap,
   S5).
4. Wire the adapters' reads, event decoding and transaction builders to the generated clients, then set the adapter's
   `wired` flag to `true` (until then `auto` keeps the simulator; explicit `live` is what conformance uses). The
   conformance env for live chains needs funded devnet/testnet wallets (`CONFORMANCE_ISSUER_KEY`, `CONFORMANCE_BACKER_KEYS`,
   `CONFORMANCE_ATTESTOR_KEYS`, `CONFORMANCE_ADMIN_KEY`) and short durations in Stage 1's test deployment.
5. Get the conformance suite green on Solana devnet and Monad testnet.
6. Run the full raise-to-payout cycle on both live chains (`pnpm demo:cycle` against `MERCES_CHAIN_*_MODE=live`).
7. Flip both chains to `live` in the staging configuration; keep `mock` for local development and Stage 3.
8. Update this file: what matched, what changed, what is still open.

## Known gaps that only Stage 1 can close

State at @1bfc66b (the same tree as @5eafd41):

- Groth16 circuit, verifying key and prover artifacts: delivered (`circuits/build`), from a development trusted
  setup that must be replaced before mainnet (A37). Since S1 the services and the simulated chains verify Groth16
  proofs by default; the mock proof system is a development opt-in on simulator-only processes (SECURITY.md).
- Event and instruction names, account layouts and error codes: delivered (IDLs, ABIs, `@merces/sdk` error names);
  the adapters' mappers are filled as the remaining section B work lands (D6.2).
- Pyth receiver accounts and FX feeds: Stage 1 snapshots FX daily per pair (`snapshot_fx`); feed ids for INR, JPY,
  CAD, CHF, BRL, MXN and SGD are still unverified (Stage 1 U3).
- Report-verifier signatures: Stage 1 verifies **secp256k1** report attestations onchain (SPEC §1.4), not ed25519;
  B.4 of the review, S4.
- Curve buyers' money and the wallet cap: answered (see "The two curve questions" above).
- Devnet and testnet deployments: still missing (blockers above).
