# STAGE1_INTEGRATION.md

How Stage 2 works without Stage 1 today, how it catches Stage 1 the moment it appears, and what happens then.
This file is updated at each catch-up with what matched, what changed and what is still open.

## Status (2026-10-10): Stage 1 @1bfc66b pinned, S1, S2 and S3 done; the non-reveal charge modelled (NRC); the curve-port gate (GATE); the S3 review fixes

Stage 1 is the `stage1` git submodule, pinned at `1bfc66b` (branch `claude/sweet-goodall-b7acm3`, SPEC v1.1.2; its
tree is identical to `5eafd41`, the commit the handoff named). Its TypeScript packages (`@merces/sdk`,
`@merces/reference`, `@merces/circuits`) are workspace packages, built from the submodule by the root `postinstall`
(`pnpm stage1:build`). `pnpm stage1:sync` and `pnpm stage1:vectors` find the submodule by themselves; `STAGE1_PATH`
overrides it.

The owner approved section B of the drift review below: **Stage 1 wins for onchain behaviour.** S1 applied its first
part: Stage 1's math (imported, not rewritten), Stage 1's report proof format, and a Stage 1 vector runner that replays
Stage 1's own parity vectors against our simulator. S2 applied the sealed-bid raise: Stage 1's multi-step settlement
(B.1), the raise's own terms (B.8, partly) and `register_holder` (B.3, partly), with the non-reveal charge held at 0 by
the owner until the S3 follow-up NRC modelled it as Stage 1's code does (the rate is the owner's setting). S3 applied
Stage 1's claim family (B.3) and brought curve mode's staking forward as a first-class flow at the owner's direction
(B.11, all of it but the live adapter and Meteora's venue): Stage 1's curve lifecycle, census, staking and tender, in
base lamports, with no wallet cap. "S1 results", "S2 results", "S3 results", "S3 follow-up: the non-reveal charge
(NRC)", "S3 follow-up: the curve-port gate (GATE)" and "S3 review fixes" say what changed; "Owner decisions and
questions" says what was decided and what is still open.

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

| D6 step | Result at @1bfc66b (after S3, NRC and GATE) |
| --- | --- |
| 1. `stage1:sync` | runs end to end with `--no-conformance` |
| detect | ok: `stage1.map.json` (hand-written) over the pinned submodule |
| generate | ok: 4 Anchor IDLs and 28 ABIs rendered to `packages/stage1-sync/generated` |
| diff | drift: **Solana** 3 canonical items without a counterpart, 220 field mismatches, 64 extra Stage 1 items; **Monad testnet** 1 / 207 / 84 (`INTERFACE_DRIFT.md`; after S3: 3 / 220 / 65 and 1 / 207 / 85; after S2: 4 / 249 / 79 and 2 / 210 / 89; after S1: 3 / 261 / 87 and 1 / 222 / 97). S2's settlement commands and events match Stage 1's by name and field, `tallyBids` apart (Solana's accounts, the EVM's index range). S3: the claim family (`claimPayout` = `claim`, `claimTail`, `claimFinal`, `burnRetired`, `PayoutClaimed.burnedUnits`, `TailClaimed`, `FinalClaimed`) matches Stage 1 exactly on both chains (WP1, WP3: 4 / 247 / 75 and 2 / 208 / 85); the curve's buy command and mint event are gone (a curve trade is `curveSwap`, a Meteora DBC `swap2`, which has no Merces counterpart by design) and `completeCurve`, `collectCurveProceeds`, `CurveActivated` and `CurveProceedsCollected` match Stage 1 by name, `issuePrice` and `settledAt` reading Stage 1's `clearing_price` and `settlement_ts` (WP8: 3 / 219 / 72 and 1 / 206 / 85); the census, `syncCurveUnits` and `CurveUnitsSynced`, matches `sync_curve_units` by name and field (WP9: 3 / 219 / 70); staking, `stakeUnits`, `unstakeUnits`, `tenderUnits{fromStake, fromWallet}`, `UnitsStaked` and `UnitsUnstaked`, matches `stake_units`, `unstake_units`, `tender_units`, `UnitsStaked` and `UnitsUnstaked` by name and field, and the one new mismatch on each chain is ours, `RedemptionClaimed.fromStake` (a curve tender's staked part, which the Solana adapter derives from the tender's arguments) (WP10: 3 / 220 / 65 and 1 / 207 / 85; unchanged by WP11-WP13). NRC: the canonical `NonRevealCharged{seriesId, bidder, charge}` matches Stage 1's `NonRevealCharged` by name and field on both chains (3 / 220 / 64 and 1 / 207 / 84). The rest is left to the adapters' mappers (D6.2) and the rest of section B (S4, S5) |
| math | **ok**: Stage 1 math imported at 1bfc66b. `@merces/math` re-exports 45 `@merces/reference` names (the 11 of the auction family since S2) and `@merces/sdk`'s helpers, and all 45 are Stage 1's own function objects. The interim math is left only under `interim.*` for the window cap and the FX family (both S5; S3 WP7: a curve raise has no cap). S3 WP5: beside them, 16 names ported from Stage 1's Rust (merces-common: the unit scale, the vault, tail and redemption at a scale, curve mode's arithmetic), because Stage 1's TypeScript has no `unit_scale`; at scale 1 each calls Stage 1's own function, and the step checks their merces-common items at the pin ("45/45 re-exports are Stage 1's own objects; 16 ported (curve, A-MATH-3)"). Snapshot: `docs/stage1/MATH_PARITY.md` (A-MATH-1, A-MATH-2, A-MATH-3) |
| curve-port | **ok** (S3 follow-up GATE): the ported curve family (A-MATH-3) agrees with Stage 1 on every sync: 55/55 of Stage 1's figures (one table, a citation per row: `curve_config.json` `expected` and `pdaCreator`, `curve_reports.json`, merces-common's `curve.rs`, `vault.rs` and `redemption.rs` tests, `curve_mode.rs`), and 5,883/5,883 cases of a deterministic corpus answered by Stage 1's own Rust (merces-common built into `tools/stage1-oracle` with rustc 1.97.1, Stage 1's pin), refusals included. Any disagreement, a stale citation or a missing cargo fails the sync. Snapshot: `docs/stage1/MATH_PARITY.md` ("The curve-port gate") |
| signatures | **ok** (S4 WP1): Stage 1's signing known answers (`packages/vectors/known_answers.json`) reproduced byte for byte on every sync through what we run, `@merces/math`'s re-exports (30/30 the SDK's own objects; the test-key derivation only on `@merces/math/testing`) and `@merces/domain`'s `signing.ts`: `signatures: ok (20 messages, 2 domains, 2 series keys, 2 bid commitments, 5 keys, 4 wallets, DER path 20/20)` (pre-image, digest, RFC 6979 signature byte-equal, recovery to the signer; since S4 WP3 each known signature also comes back through the KMS DER path: a DER signature with `s` as signed and with `s` forced high, normalised by `@merces/ports`' `signature65FromDer`). A drop without the known answers, or any answer not reproduced, fails the sync |
| vectors | **ok**: reference backend (Stage 1's own simulator) 25/25 PASS with every embedded proof verified (164 distinct, 3 invalid: the deliberate tamper cases); merces backend (our simulator) `OK: 38/42 PASS, 42/42 at expected status (14 prefix runs)`, on both personalities: the 14 targets in full (S1's ten and S2's 02, 03, 15, 17): 02, 03, 04, 06, 07, 09, 11, 15, 17, 19, 23 and 25 PASS, 01 and 05 PASS-WITH-WAIVERS (`retire_if_capped` BLOCKED, the direct unit transfer N/A); 03 PASS in full since NRC (was PASS-WITH-DIVERGENCES on DIV-NRC-1, the S2 non-reveal hold; no vector carries a divergence: the register's rows, DIV-S1I-1 since the S3 review and DIV-S1I-2 since S4 WP5, are met by our scenarios S3l and S4d only); the 7 vectors that need a later milestone, up to their prefix gate (08 #33, 10 #35, 14 #61, 16 #40, 20 #70, 21 #40, 22 #75: PREFIX-PASS); 12, 13, 18 and 24 not replayed (S5). Lockstep agrees step by step on every target, mid-settlement included, 03 in full (b8's charge at #65 agrees since NRC; it parted there as recorded under the hold). 25 vectors, 2,092 steps, 143 expected reverts. S3 WP2: `claim_tail`, `claim_final` and `burn_retired` run directly (`claimTail`, `claimFinal`, `burnRetired`; shims SH-CLM-2, SH-CLM-3 and SH-BRN-1 retired), at the same statuses. S3 WP3: `claim` runs directly too (`claimPayout` is Stage 1's `claim`; SH-CLM-1 retired), at the same statuses. S4 WP6: `register_verifier_key` and `revoke_verifier_key` run directly (`registerVerifierKey` / `revokeVerifierKey` of the vector key's 20-byte address; SH-REG-3 retired) and a tier-2 report carries the named vector key's Stage 1 REPORT signature over the chain's domain and the series key (SH-REP-1 narrowed to tier 3's co-signature and the FX basis), at the same statuses: 04#68 (a tier-2 report signed by `attestor1`) fails InvalidVerifierSignature on its own. Our twelve S3 claim scenarios (the paths no vector takes, on prefixes of 05, 09, 11, 21 and 22) are at their expected status on Stage 1's simulator, on ours and in lockstep, 60/60 runs: (a)-(k) PASS everywhere (55 runs), and (l), added by the S3 review, PASS on Stage 1's simulator and PASS-WITH-DIVERGENCES on ours and in lockstep, on exactly its DIV-S1I-1 entries (a Stage 1-internal difference resolved toward both chains: the final share of an open ask's units, "S3 review fixes"). No shim stands in for a claim or a burn any more; the shims left are the S4 and S5 ones (registrations, report and attestor signatures, `pay`, pauses, windows). S4 WP2: `commit_bid` runs directly with Stage 1's keccak commitment (SH-AUC-2 retired), at the same statuses. S4 WP5: `register_attestor` and `revoke_attestor` run directly as Stage 1's registry (`registerAttestor` / `revokeAttestor` of the vector key's own 20-byte address, forward-only with the 45-day grace and the last-key rule, each personality under its chain's names; SH-REG-2 retired), at the same statuses; our S4 signature scenario S4d (the last active key, DIV-S1I-2) runs on the merces backend only, PASS on both personalities. Curve mode has no Stage 1 vector (its reference simulator has no curve code): its parity is relational, every figure pinned to Stage 1's LiteSVM curve tests (`curve_mode.rs`), merces-common's unit tests and properties and the curve fixtures (`curve_config.json`, `curve_reports.json`, replayed with their own Groth16 proofs); since GATE the curve-port step checks the ported math against those figures and against merces-common itself on every sync. Snapshot with the shim table and the scenarios: `docs/stage1/VECTOR_PARITY.md` |
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
  the units its redemption would redeem (`claim_tail` redeems first), and the vault's dust counts that tail too; since
  S3 WP3 only `claimTail` pays it, and the payout claim builder shows only what `claimPayout` (Stage 1's `claim`)
  pays and burns (A-REV-24). Report-deadline reminders go only to the earliest unpaid period, the one Stage 1's `deriveStatus` counts
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
  transfer window until S5 (A-MATH-1; the curve's went in S3 WP7: no cap).
- **Raise terms (WP2).** `commitDurationSeconds`, `revealDurationSeconds` and `nonRevealChargeBps` are series terms,
  bounded as Stage 1's `create_series` bounds them on a sealed raise (A-TERMS-4; since NRC the non-reveal charge is
  bounded on every series and applied, A-AUC-11); `openRaise{seriesId}` checks Stage 1's order (NotIssuer,
  RaiseNotDraft, ContractHashMissing, NotAllowlisted, NewRaisesPaused) and derives the phase ends from the terms
  (A-AUC-5). Migration 018.
- **Vocabulary (WP3, WP8).** Stage 1's names: the permissionless commands `beginSettlement`, `tallyBids{maxBids?}`,
  `finalizeSettlement`, `processBid`, `deliverBid` and `registerHolder` (the keepers submit them; any wallet may build
  them) and the events `SettlementProposed`, `SettlementRejected`, `UnitsAllocated`, `BidDelivered`,
  `RaiseMintFinalized` and `HolderRegistered`; `BidRevealed.valid`; `AuctionSettled` carries `RaiseSettled`'s fields only
  and `AuctionFailed` `RaiseFailed`'s plus `unitsSold`. The one-step settlement, the pull refund and its event are
  deleted (WP8); the curve buy's mint event went in S3 WP8 (a curve trade is Meteora's DBC swap, no Merces event). `ChainInfo.limits` gives each chain's tally page and bid limit
  (A-AUC-6). One planner (`nextSettlementStep`, from the stored raise state) and one driver (`runSettlement`) serve the
  keepers, the harness, conformance and the API; one helper (`settlementOutcome`) applies D7 (A-AUC-7). The domain
  schema is version 0.2.0: 48 events, 42 commands.
- **Engine (WP4a).** The simulator stores Stage 1's `Auction` and `Bid` records and runs `open_raise`, `commit_bid`,
  `reveal_bid`, `begin_settlement`, paged `tally_bids`, `finalize_settlement`, `process_bid`, `deliver_bid`,
  `cancel_raise` and `register_holder` with Stage 1's checks in Stage 1's order and Stage 1's error names. Validity is
  fixed at reveal (an over-cap bid is invalid and refunded in full, A-AUC-4); a failed raise keeps its would-be price
  and results; money moves bid by bid at processing (`FeeTaken{auction}` and `TreasuryFunded` per winner);
  MintNotFinalized gates every path Stage 1 gates; a winner holds and accrues from processing (A-AUC-8) and the
  redemption and final claims deliver a pending bid first; a bidder removed from the allowlist stays valid (A-REV-2
  withdrawn); the non-reveal hold applied 0 bps and refused any charge (lifted by NRC: the series' own rate applies,
  A-AUC-11). State version 3 (`sim:reset`).
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
  first-class entry (`stage1-vectors/divergences.ts`): DIV-NRC-1 accepted exactly the five fields of 03 the hold
  changed, failed on any other value there, and would fail as stale once the hold lifted (NRC removed it with the hold:
  03 is PASS and the register is empty; the mechanism is tested on a test-only divergence). Prefix gates keep the
  auction prefix of 08, 10, 14, 16, 20, 21 and 22 green; lockstep compares mid-settlement.
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

### S3 results

S3 ran as work packages WP1–WP13, each committed as `S3 WPn: …`, on the S2 review fixes. Part A (WP1–WP4) applied
Stage 1's claim family (B.3). Part B (WP5–WP12) brought curve mode's staking into S3 as a first-class flow, at the
owner's direction, with every curve step a staker's payout depends on (B.11 but the live adapter and Meteora's venue).
WP13 wrote the docs and ran the gate. What changed, by area:

- **Claims (WP1–WP4).** `claimPayout` is Stage 1's `claim` (the net payout only; a Retired balance burns, on no other
  status); `claimTail` and `claimFinal` are `claim_tail` and `claim_final` with their bodies and check orders (the
  reference simulator's and the EVM's); the permissionless `burnRetired{holder}` is `burn_retired`, the only burn
  (`crankBurn` is gone) (A-CLM-1). The zero-amount rule: a claim of nothing emits its own event with zeros, and on a
  Retired series still burns; every stablecoin amount a claim moves is in exactly one event amount (`TailClaimed`,
  `FinalClaimed{units: weight}`, `PayoutClaimed.burnedUnits`), checked by an invariant over every claim in every state
  (A-CLM-2). The indexer never creates a position from a claim or a registration and writes no money row for 0
  (A-REV-10). The API builds every claim (`tail/build-claim` and `final/build-claim` with `redeemsFirst`, `total` and
  `burnsUnits`) and the holder registration (`holders/build-register`), and builds no claim of nothing (409
  `nothing-to-claim` with `claimWith`). The claims are the holder's own: no pushed claims (A-CLM-3).
- **Math (WP5).** Stage 1's TypeScript has no `unit_scale` and no curve code, so `@merces/math` ports 16 names from
  merces-common @1bfc66b as a segregated family (A-MATH-3; approved by the owner): at scale 1 each scale-aware one calls
  Stage 1's own function (tested on seeded grids), every curve figure is pinned to Stage 1's Rust tests and fixtures with
  file and lines, and `stage1:sync`'s math step fingerprints the ported Rust items, so a Stage 1 change to one fails the
  step until it is ported again. The 45 re-exports stay Stage 1's own objects.
- **Simulator state (WP6, WP8).** Version 4: each series' unit scale (1 on a sealed-bid series, 10^6 base lamports on a
  curve), stake and tender totals and census time, each holder's stake, and Stage 1's curve record with the labelled
  stand-in pool. Every money path passes the unit scale to the ported family, which is Stage 1's own function at scale
  1, so sealed-bid figures, the vectors and the lockstep did not move (a white-box rescaled series pays the same money).
  `sim:reset` ran after WP6 and WP8 (RUNBOOK.md).
- **Curve terms and no cap (WP7).** A curve series carries Stage 1's zeros (lockup, wallet cap, raise durations;
  CurveTermsNotZero), a positive target (CurveThresholdZero) and USDC (CurveQuoteMintMismatch), in the Solana registry's
  order; the EVM refuses curve mode (CurveModeUnsupported). No curve path has a wallet cap, and one statement says so
  everywhere (`CURVE_NO_CAP`: every curve read and builder, the series and transfer-window reads, the notice, the docs;
  A-TERMS-4, A-CURVE-2).
- **Curve lifecycle (WP8).** Stage 1's curve mode in base lamports (A-CURVE-4; r per base lamport): creation is the
  activation (P0 = `p0PerUnit(X, unitsOffered × 10^6, 6)`; `CurveActivated`, `RaiseOpened{0, 0}`); `curveSwap` trades
  against a labelled DBC stand-in (constant P0, Stage 1's generated config's 1% fee with 20% to Meteora, a partial fill
  at X, the whole base supply in protocol accounts, the migration, locker and DAMM moves as harness hooks; A-CURVE-1);
  `completeCurve` settles at the pool's finish time (no census, no registration); `collectCurveProceeds` funds the
  treasury, which is 0 until then (tranches at the first collection; `FeeTaken{curveTrading}`; A-CURVE-7); no cancel and
  NotSealedBid on every sealed-bid path, CurveUsesTender, CurveModeNoBurn; the buyer notice (A-CURVE-3, A-CURVE-8).
  Migration 020.
- **Census (WP9).** `syncCurveUnits` (the supply less the DBC, DAMM, locker and leftover balances), the report gate
  (CurveUnitsNotSynced) and `redeem`'s own census without the DAMM pool (B-C13); Stage 1's curve report fixtures replayed
  with their own Groth16 proofs; the issuer's report assembly, the submission builder and the tier-3 path census-aware,
  and no census of Merces' own over an assembled, unsubmitted report (amendment H1; A-CURVE-5).
- **Staking (WP10).** `stakeUnits`, `unstakeUnits` (credits pending and pays nothing: Stage 1's code), `tenderUnits
  {fromStake, fromWallet}`, settlement by stake (`settle_curve_holder`), the curve branch of every claim, registration by
  `registerHolder` only; the indexer's positions from stakes and tenders (holder access from the first stake), stake and
  tender totals; pinned relationally to Stage 1's curve tests and its `curve_staking_never_overpays` property
  (A-CURVE-6).
- **Keepers and notices (WP11).** `curve.lifecycle` (complete, then collect once; the trading fees weekly),
  `curve.sync` (once after completion and once an hour after each period end; held while the issuer's assembled report
  binds the census), `curve.stake-reminders` and `curve.tender-reminders` (linked wallets holding unstaked units, by
  their next step); the chain notices `curve.completed` and `curve.tender-open`; `toHolders` covers `curve.*`; no notice
  names an amount (A-CURVE-9; migration 021). `burn.crank` sends one `burnRetired` per holder still holding units and
  skips curve series.
- **Builders and reads (WP12).** One transaction of several commands (owner direction of 2026-10-10): `ChainPort.build`
  takes an ordered command list and returns one all-or-nothing transaction (`UnsignedTx.commands`), and the unstake
  builder returns ONE transaction, `[unstakeUnits, claimPayout]`, whose claim pays exactly what the unstake credited.
  `build-swap` replaces `build-buy` (a buy needs the acknowledgement of the pre-buy statements, first "Unapproved wallets
  earn nothing and cannot tender."; 422 otherwise); `build-stake` (its registration and census steps), `build-tender`
  and the wallet's curve position read (`stakable` or `stakeBlockedBy`, pending, the tender); the buyer notice's trading
  fee and its split from the pool's config; every per-unit read at the series' unit scale (amendment M4). API.md "Curve
  staking".
- **Vocabulary.** Domain schema 0.3.0: 53 events and 49 commands (S2: 48 and 42). In: `TailClaimed`, `FinalClaimed`,
  `CurveActivated`, `CurveProceedsCollected`, `CurveUnitsSynced`, `UnitsStaked`, `UnitsUnstaked`; `claimTail`,
  `claimFinal`, `burnRetired`, `curveSwap`, `completeCurve`, `collectCurveProceeds`, `syncCurveUnits`, `stakeUnits`,
  `unstakeUnits`, `tenderUnits`. Out: the toy curve's creation and mint events and its buy and graduation commands, and
  `crankBurn`. Solana's and the EVM's own error names (`STAGE1_SOLANA_CODE`, `STAGE1_EVM_CODE`) sit beside
  `@merces/sdk`'s, each checked against the pinned `error.rs` or `MercesErrors.sol`.
- **Vector runner (WP2, WP3).** `claim`, `claim_tail`, `claim_final` and `burn_retired` run directly (SH-CLM-1…3 and
  SH-BRN-1 retired; the runner-atomic mechanism stays, tested on a synthetic row). No expected status moved. Vector 22's
  claim steps (#88–#110) come after its window steps, so its milestone is S5. Our eleven claim scenarios (a)–(k), on
  prefixes of 05, 09, 11, 21 and 22, PASS on Stage 1's simulator, on ours and in lockstep.
- **API.** 161 → 170 operations: the tail, final and registration builders (WP4); the census builder (WP9); the pre-buy
  quote, `build-swap` (in place of `build-buy`), the curve position, `build-stake`, `build-unstake` and `build-tender`
  (WP12).
- **Tests.** Every moved pin names its S3 cause code (S3-CL, -Z, -BU, -TL, -FN, -BR, -IX, -RC, -SH, -SC, -M, -V4, -CT,
  -NC, -UL, -CV, -CN, -ST, -KP, -SW); claim figures were recomputed with Stage 1's own simulator, and curve figures cite
  Stage 1's Rust tests and fixtures by file and line.
- **Privacy.** Claims, burns, stakes, censuses, tenders and proceeds are public onchain and none is income; the new
  amount events are amount-bearing; activity lines name units and statuses only; a zero claim or a registration never
  creates a position; curve notices and reminders carry no amount (PRIVACY.md).

**Left for S5 (curve mode).** The live Solana adapter: the census accounts, the stake vault's token account,
`prepare_curve` and `activate_curve` as the issuer's own steps with the DBC config validation, `issuer_accepts_public_price`,
one transaction from a command list, `RedemptionClaimed.fromStake` and the split-out `PayoutClaimed` decoded, the
Solana-only names ("Adapter notes for claims and curve mode"). Meteora's venue: DBC `swap2` and its quote, Stage 1's
config generator, the DAMM v2 migration and locker cranks, creator trading fees, `withdraw_leftover`. Activation as its
own canonical step; reminders for wallets not linked to an account (a holder index of the mint). Curve units have no
transfer windows and no cap; the sealed-bid transfer window's cap (the interim `walletCapUnits`, A-MATH-1) is S5 work
outside curve mode.

**The S3 gate**, all green at the S3 WP13 commit:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exits 0 |
| `DATABASE_URL=… pnpm vitest run` | 70 files, 566 tests passed |
| `MERCES_TEST_DB=1 pnpm vitest run --project canary` | 2 files, 3 tests passed |
| `CONFORMANCE_CHAIN=simulator` / `simulator:monad` `pnpm vitest run --project conformance` | 20 and 11 tests passed |
| `pnpm stage1:vectors --personality solana,monad` | exits 0: `OK: 36/42 PASS, 42/42 at expected status (14 prefix runs; 2 runs with accepted divergences)` |
| `pnpm stage1:vectors --backend reference` | exits 0: `OK: 25/25 PASS, 25/25 at expected status` |
| `pnpm stage1:vectors --backend lockstep --personality solana,monad` | exits 0: `OK: 36/42 PASS, 42/42 at expected status`; 03 diverges at #65 as recorded (DIV-NRC-1) |
| `pnpm stage1:sync --no-conformance` | math `OK` ("45/45 re-exports are Stage 1's own objects; 16 ported (curve, A-MATH-3)"; the ported items unchanged since the port), vectors `OK` (S3 claim scenarios 55/55 runs PASS on the reference, merces and lockstep backends), diff `WARN` (3 / 220 / 65 and 1 / 207 / 85), conformance skipped; `INTERFACE_DRIFT.md` and `docs/stage1/{MATH,VECTOR}_PARITY.md` regenerated without a change |
| `pnpm openapi:check` | `openapi.yaml matches 170 operations` |
| `pnpm docs:events` | no change to `DOMAIN_EVENTS.md` or the JSON schema |
| `pnpm demo:cycle` | exits 0: `DEMO OK` on both personalities |
| `grep -rnE "\bbuyCurve\b\|\bgraduateCurve\b\|\bcrankBurn\b\|\bUnitsMinted\b\|CurveSeriesCreated\|walletCapView\|CurveWalletCap" packages --include=*.ts --include=*.yaml \| grep -v generated` | empty |
| The buyer notice test (`packages/domain/test/domain.test.ts`) | every clause pinned: "stops paying", "there is no deadline", "if the curve never fills, the issuer receives nothing", "No cap", the fee split from the config; never `/default/i` |
| `MERCES_ALLOW_SIM_RESET=1 pnpm --filter @merces/simulator sim:reset` on dev | exits 0: no persisted simulator chain under the "sim" prefix, nothing to reset (it ran after WP6 and WP8 too) |
| `docs/stage1/VECTOR_PARITY.md` | no SH-CLM-* or SH-BRN-1 row |

### S3 follow-up: the non-reveal charge (NRC)

At the owner's direction of 2026-10-10 the non-reveal charge is modelled exactly as Stage 1's code does, as a per-series
setting, and the rate is the owner's ("Decided (S3 follow-up NRC)"). What Stage 1 does, in all three stacks at 1bfc66b:

| | Reference (TypeScript) | Solana | EVM |
| --- | --- | --- | --- |
| The charge | `math/auction.ts:143-146` `processBid`: an unrevealed bid on a settled raise, `charge = mulDiv(escrow, nonRevealChargeBps, 10000)`, refund the rest | `raise.rs:1016-1019` `process_bid` calls merces-common `auction.rs:118-126` `non_reveal_split` (`floor(escrow × bps / 10000)`, refund the rest) | `MercesAuction.sol:319-324` `processBid`: `charge = escrow.bpsOf(nonRevealChargeBps)`, `_recordRefund(escrow - charge)` |
| Who receives it | the fee collector: `sim/simulator.ts:998` (out of the escrow) and `:1001` (`feeCollector += fee + charge`) | the fee collector: `raise.rs:1059-1069` transfers `fee + charge` to the fee collector's account, checked against `config.fee_collector` at `:1004-1009` | the fee collector: `MercesAuction.sol:325`, `safeTransfer(registry().feeCollector(), charge)` |
| When | at `process_bid`; the rest of the escrow is the bid's refund, paid at `deliver_bid` (`simulator.ts:1014-1028`) | at `process_bid`; the refund at `deliver_bid` (`raise.rs:1238` on) | at `processBid`; the refund at `deliverBid` (`MercesAuction.sol:400-415`) |
| A failed raise | no charge, a full refund (`auction.ts:142`) | no charge, a full refund (`raise.rs:1014-1015`) | no charge, a full refund (`MercesAuction.sol:317-318`) |
| A revealed bid | never charged (invalid or losing: a full refund, `auction.ts:152`) | never charged (`raise.rs:1020-1021`) | never charged (`MercesAuction.sol:326-329`) |
| The event | none (its log line `BidProcessed … charge=`) | `NonRevealCharged{series, bidder, charge}` only when above 0 (`raise.rs:1070-1076`) | `NonRevealCharged(series, bidder, charge)` for every unrevealed bid, 0 included (`MercesAuction.sol:323`) |
| The rate | the series' terms (`simulator.ts:924`), bounded 0–1,000 bps at creation (`:768`, sdk `PARAMETER_BOUNDS`) | copied from the protocol defaults at creation (`merces_registry` lib.rs:550), bounded (params.rs:102-105, lib.rs:562) | copied from the protocol defaults at creation (`MercesRegistry.sol:597`), bounded by `setDefaults` (`:741`) |

What changed, by area:

- **Domain.** `NON_REVEAL_CHARGE_HELD`, `appliedNonRevealChargeBps` and `DEFAULTS.nonRevealChargeBps` are gone;
  `auctionRulesOf` gives Stage 1's `processBid` the series' own rate. `NON_REVEAL_CHARGE_SETTING` and
  `nonRevealChargeSetting` read the owner's setting (whole bps within the bounds, else a startup error naming the setting
  and the bounds). The canonical `NonRevealCharged{seriesId, bidder, charge}` (Stage 1's name and fields; 54 events) and
  the `nonReveal` fee kind; `BidState.nonRevealCharge`. The rate is bounded on every series (a curve's too, as Stage 1
  bounds the default it records there).
- **Simulator.** `applyBidOutcome` takes the charge out of the escrow, credits the fee collector and emits
  `NonRevealCharged` and `FeeTaken{nonReveal}` when it is above 0; the engine's guard is gone. A bid's charge is read off
  what processing left it owed (Stage 1 stores none per bid), so state version 4 is unchanged and no reset is needed.
  The harness's series record an explicit 100 bps; `runRaise` can leave a bid unrevealed.
- **Services and API.** The terms service fills the owner's rate into every new series (`nonRevealChargeOf`): 409 for
  a sealed raise while the setting is unset, 0 for a curve then; issuers cannot set it. Accounting: the `nonReveal` kind
  in the ledger, `byKind`, `bySeries`, the statement's `fees` and `feeRates.nonRevealChargeBps`; reconciliation covers
  it (the fee collector's balance). `/me/bids` `nonRevealCharge`; the bid precheck returns the rate and the charge on the
  deposit. Notices: `bid.non-reveal-charged` to the bidder and a warning in the reveal reminder, no amount. OpenAPI and
  the client regenerated (170 operations).
- **Indexer.** Migration 022 (`bids.non_reveal_charge`); `NonRevealCharged` writes the bid's charge and what it is
  owed; `FeeTaken{nonReveal}` writes the fee row; the feed line names no amount.
- **Vector runner.** DIV-NRC-1 and 03's lockstep parting are deleted; 03 is PASS in full on both personalities and in
  lockstep; the register is empty and the report says so; the divergence mechanism is tested on a test-only divergence
  (03 with the merces backend at 0 bps). `OK: 38/42 PASS, 42/42 at expected status (14 prefix runs)`.
- **Tests.** Moved pins name cause NRC. The simulator pins the charge to the fee collector on a settled raise (b4's
  9.09 USDC of a 909 USDC deposit at 100 bps; the fee collector 49.09, Stage 1's own simulator's figure) and none on a
  failed raise or at 0 bps.

**The NRC gate**, all green at the "S3 follow-up NRC" commit:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exits 0 |
| `DATABASE_URL=… pnpm vitest run` | 70 files, 571 tests passed |
| `MERCES_TEST_DB=1 pnpm vitest run --project canary` | 2 files, 3 tests passed |
| `CONFORMANCE_CHAIN=simulator` / `simulator:monad` `pnpm vitest run --project conformance` | 20 and 11 tests passed |
| `pnpm stage1:vectors --personality solana,monad` | exits 0: `OK: 38/42 PASS, 42/42 at expected status (14 prefix runs)`; 03 PASS 78/78 on both |
| `pnpm stage1:vectors --backend reference` | exits 0: `OK: 25/25 PASS, 25/25 at expected status` |
| `pnpm stage1:vectors --backend lockstep --personality solana,monad` | exits 0: `OK: 38/42 PASS, 42/42 at expected status (14 prefix runs)`; 03 PASS 78/78, no parting |
| `pnpm stage1:vectors --scenarios` | exits 0: `OK: 22/22 PASS, 22/22 at expected status` |
| `pnpm stage1:sync --no-conformance` | math and vectors `OK` ("0 run(s) with accepted divergences"), diff `WARN` (3 / 220 / 64 and 1 / 207 / 84), conformance skipped; `INTERFACE_DRIFT.md` and `docs/stage1/VECTOR_PARITY.md` regenerated |
| `pnpm docs:events` | `DOMAIN_EVENTS.md` and the schema regenerated (`NonRevealCharged`, the `nonReveal` kind) |
| `pnpm openapi:client && pnpm openapi:check` | `openapi.yaml matches 170 operations` |
| `pnpm demo:cycle` | exits 0: `DEMO OK` on both personalities |
| `grep -rnE "NON_REVEAL_CHARGE_HELD\|appliedNonRevealChargeBps\|DEFAULTS\.nonRevealChargeBps" packages --include=*.ts \| grep -v generated` | empty (DIV-NRC-1 is named only in comments and the report's history line) |

### S3 follow-up: the curve-port gate (GATE)

The owner's direction (2026-10-10): "For the curve port, add a gate that runs the ported functions against Stage 1's Rust
fixtures on every sync." `stage1:sync` now has a step `curve-port`, after `math`
(`packages/stage1-sync/src/steps/curve-port.ts`). `math` checks that the ported Rust items are still there and unchanged
(a fingerprint per name); `curve-port` checks what the port computes, against Stage 1 itself, in two parts:

1. **Stage 1's figures: one table** (`packages/stage1-sync/src/curve-port/figures.ts`, 55 rows). Every figure Stage 1
   gives for something the port computes: the curve fixtures (`solana/tests/fixtures/meteora/curve_config.json`
   `expected` and `pdaCreator`: P0, the offer, both migration-fee splits; `curve_reports.json`: the dues of both
   payments, r per base lamport × N base lamports, through Stage 1's own `paymentUsd`), merces-common's unit tests
   (`curve.rs`, `vault.rs` and `redemption.rs`, the latter at scale 1 and per base lamport) and the LiteSVM curve tests
   (`curve_mode.rs`: the census after a migration, a vesting claim and a DAMM trade; the first payment's exact
   accumulator; the past-the-cap payment's capped acceptance and refund; the redemption deposit; the tenders and the
   quota). Each row cites the Stage 1 lines (`solana/…:from-to`) and the text they must still hold (compared without
   whitespace), so a Stage 1 change to a figure fails the row as stale until it is re-cited; fixture rows anchor on the
   keys and read the values, so a regenerated fixture is checked as it stands. Where Stage 1 states a relation (the
   deposit is `scaled_amount(price, n, 10^6)`), the row checks the relation. The figures moved here from
   `packages/math/test/curve.test.ts`, which keeps what is ours (scale 1 equals Stage 1 on seeded grids, our argument
   checks, Stage 1's proptests replayed, the derived figures of the fixture series and our scale invariance).
2. **Stage 1's Rust: an oracle** (`tools/stage1-oracle`): a standalone Cargo crate, its own workspace, with one path
   dependency, the submodule's merces-common, and nothing else, so it builds offline (in about two seconds). It reads
   one JSON case per line and answers with merces-common's functions, plus only the Solana program's own bookkeeping
   around them where the port mirrors a program routine (cited: `common.rs` `receive_gross`/`receive_tail`, `exit.rs`'s
   deposit and tail cap). The gate builds it with Stage 1's toolchain (`solana/rust-toolchain.toml`, 1.97.1, through
   `RUSTUP_TOOLCHAIN`), generates a deterministic corpus (`curve-port/corpus.ts`: edge values, Stage 1's own test and
   fixture inputs, then seeded draws within Stage 1's input ranges: 5,883 cases over 15 entry points, every one of the 16
   ported names covered, which the step checks) and compares every answer exactly, refusals included (Rust's
   `MathError` variants; `NoUnitsOutstanding` where the program refuses before merces-common). For another checkout
   (`STAGE1_PATH`) it builds a copy of the crate against that checkout's merces-common, under the sync's output.

No cargo, no merces-common or fixtures in the drop, or a failed build is a failure, never a skip (the owner wants a
gate); a toolchain other than Stage 1's pin is reported (`warn`, not a blocker: the arithmetic is integer only). The
step's result is printed in the verdict ("ported curve family (curve-port): OK — …") and, when it fails, is a blocker
of every chain; `MATH_PARITY.md` gets a section with the counts per entry point.

What the gate showed. Every figure and every case agrees at @1bfc66b. A seeded mutation fails it: the migration-fee
split with the pool share rounded down instead of up passes all 55 figures (every Stage 1 figure is a round number) and
fails 278 oracle cases; an off-by-one P0 fails both; a Stage 1 Rust change the port did not follow (the same rounding
change made in a copy of merces-common) fails the oracle built against that copy. A sweep of one-line mutations of the
port's own source was caught every time, by 24 to 346 cases each: the pool share's ceiling one off at its edge
(`+ 98` for `+ 99`, 35 cases: the corpus puts `X × (100 − f)` on its rounding edge on purpose), `<=` for `<` at the vault
cap, a floor for the ceiling of `C_remaining`, a ceiling for the deposit's floor, the tail fee taken on the gross, a
four-year `D_avg` window, `<` for `<=` in the tender quota, the census refusing a supply exactly held, a two-unit offer
tolerance, the tail cap one wei high, and a scale check that lets small non-divisors through. Outside Stage 1's input
ranges, and so not in the corpus: a u64 running total or a u128 accumulator past its type (Rust refuses with Overflow;
our bigints do not), and a tail accumulator above the tail cap, which cannot happen (the tail cap is fixed at
redemption and every tail receipt is capped at it), where Rust's `receive_capped` takes the accumulator as the
effective cap and refunds the receipt while Stage 1's TypeScript `tailReceive` (our scale-1 path; our scaled body
mirrors it) has no effective cap and refuses on a negative amount (asked of Stage 1, below).

What changed, by area:

- **Gate.** `tools/stage1-oracle` (`Cargo.toml`, `src/main.rs`, a dependency-free JSON reader in `src/json.rs`; its
  `target/` and `Cargo.lock` are ignored: there is no registry dependency to pin); `packages/stage1-sync/src/curve-port/`
  (`family.ts`: the injectable ported family and how each case runs on our side; `corpus.ts`; `figures.ts`;
  `oracle.ts`: cargo discovery, the toolchain, the build and the run); the step, its place in `runSync` and its line in
  the verdict (`report.ts`).
- **CI.** Both `ci.yml` (the test job, whose `pnpm test` runs the gate's tests and whose last step is
  `pnpm stage1:sync --no-conformance`, on every push) and `stage1-sync.yml` (schedule, dispatch, Stage 1 pushes) install
  Stage 1's pinned toolchain with rustup (`--profile minimal`, read from `stage1/solana/rust-toolchain.toml` after the
  submodule may have moved) and print `cargo --version` and `rustc --version`. `target/` is not cached: the oracle builds
  in seconds.
- **Tests** (cause GATE). `packages/stage1-sync/test/curve-port.test.ts`: the table at the pin (every row, every
  citation); a stale citation and a regenerated fixture fail their rows; the corpus is deterministic and covers the
  family; the crate's one dependency; no cargo fails the step, and so does a drop without Stage 1's Rust; the step is ok
  at the pin and writes its section; a deliberately wrong function (the rounded-down split, an off-by-one P0) fails it
  and blocks the verdict; a Stage 1 Rust change fails the oracle. The oracle tests skip locally without cargo and run in
  CI (`CI` set), where the toolchain is installed. `sync.test.ts` pins the step order and the failure on a drop without
  fixtures.
- **Docs.** `docs/stage1/MATH_PARITY.md` (the gate's section), `VERSIONS.md` (the Rust toolchain), ASSUMPTIONS A-MATH-3,
  this file, README, RUNBOOK and ARCHITECTURE.

**The GATE gate**, all green at the "S3 follow-up GATE" commit:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exits 0 |
| `DATABASE_URL=… pnpm vitest run` | 71 files, 572 tests passed (the curve-port tests ran: cargo 1.97.1 present) |
| `MERCES_TEST_DB=1 pnpm vitest run --project canary` | 2 files, 3 tests passed |
| `CONFORMANCE_CHAIN=simulator` / `simulator:monad` `pnpm vitest run --project conformance` | 20 and 11 tests passed |
| `pnpm stage1:vectors --personality solana,monad` | exits 0: `OK: 38/42 PASS, 42/42 at expected status (14 prefix runs)` |
| `pnpm stage1:vectors --backend reference` | exits 0: `OK: 25/25 PASS, 25/25 at expected status` |
| `pnpm stage1:vectors --backend lockstep --personality solana,monad` | exits 0: `OK: 38/42 PASS, 42/42 at expected status (14 prefix runs)` |
| `pnpm stage1:sync --no-conformance` | exits 0: curve-port `OK` ("55/55 figures, 5,883/5,883 oracle cases against merces-common", built with rustc 1.97.1, Stage 1's pin), and in the verdict; math and vectors `OK`, diff `WARN` (unchanged), conformance skipped; `docs/stage1/MATH_PARITY.md` regenerated (the gate's section), `INTERFACE_DRIFT.md` and `VECTOR_PARITY.md` unchanged |
| The same with a seeded mutation (`+ 98` for `+ 99` in `migrationFeeSplit`) | exits 1: curve-port `FAIL` (35 oracle cases), a blocker of both chains |
| `cargo fmt --check`, `cargo clippy --release --offline -- -D warnings` in `tools/stage1-oracle` | clean |
| `pnpm openapi:check`; `pnpm docs:events` | `openapi.yaml matches 170 operations`; no change (neither touched) |
| `pnpm demo:cycle` | exits 0: `DEMO OK` on both personalities |

### S3 review fixes

The S3 review's confirmed findings, each fixed in its own commit ("S3 review fix: ..."):

1. **A redeemed holder's final share counts its open ask's units (medium; Stage 1 internal, resolved toward both
   chains).** On a series that redeemed and was then extinguished, `claimFinal` by a holder with units in an uncleared
   window ask weighed its share on its redeemed units only, as Stage 1's TS reference does (simulator.ts:1456-1460); the
   escrowed units, redeemed when the window returned them, then got a share of 0, so their share stayed in the vault
   for good. Both Stage 1 chains weigh it on the redeemed units plus the ask's escrow (MercesVault.sol:654-658,
   claims.rs:486-490), and so do we now: the engine's `finalShare`, the claimable final (`finalWeight`) and with it the
   final claim builder's preview. The vector runner records the difference from Stage 1's simulator as DIV-S1I-1, the
   register's one row (a Stage 1-internal difference resolved toward both chains, like the register's "Stage 1
   internal" row below), met by our new scenario S3l (vector 22 #0-#70, S2's window to its reveals #79-#83, then
   redeem, extinguish and claim_final, the window's NoMatch #84-#86 and the final claims): PASS on Stage 1's simulator,
   PASS-WITH-DIVERGENCES on ours and in lockstep, on exactly b1's balance and the vault (1,050 USDC apart; Stage 1's
   simulator ends with 1,050 USDC stranded, ours with 0), parting right after b1's first claim_final. A simulator test
   pins 2,625 USDC for the 100-unit holder with 40 units in the ask (26.25 a unit, as for every other 100-unit holder)
   and an empty vault once all claim; an API test pins the builder's preview and what the relayed claim pays. Reported
   to Stage 1 ("Asked of Stage 1 (S3)", 5). ASSUMPTIONS A-AUC-8, A-REV-16 and A-C11-6 corrected.
2. **A curve holding's yield is on the holding, not the stake (low).** On a curve series the indexed `positions.units`
   is the stake (the accrual weight), and `/me/holdings` took the cost basis from it, so an unstake halved the basis
   (doubling `realisedYieldBps`) and a holder that unstaked everything read 0 although paid. A curve row's basis is now
   `issuePrice × (stakedUnits + walletUnits + burnedUnits) / unitScale`, read live; a sealed-bid row's is unchanged.
   Tests: the yield over a's 39.6 units (19.8 staked, 19.8 in the wallet) is 9,500 bps, and b's stays on its 35.65 units
   when it unstakes them all. OpenAPI (client regenerated) and API.md say how the basis is taken.
3. **No cap and the buyer notice on every curve read and builder (low).** API.md, ASSUMPTIONS A-CURVE-2 and A-CURVE-8
   and the `CurveNoCap` schema promised them on every curve read and builder, but the routes WP12 added, the position
   read and the stake, unstake and tender builders, and the census builder carried neither. Each now carries
   `walletCap: null`, `noCap: true`, `noCapStatement` and the notice rendered from the curve's own figures (its trading
   fee and that fee's split from the pool's config), from one place (`services/src/meteora/notice.ts`), and its OpenAPI
   response includes `CurveNoCap` (client regenerated). The admin monitor, one pass over every curve, carries neither,
   and the docs say so. A test walks every curve route of the OpenAPI document (nine) and checks each 200 carries the
   four fields with the notice of `GET /series/{id}/curve`, its fee split included.
4. **Curve figures cite the right lines of Stage 1's tests (low).** `census.test.ts` cited the wrong `curve_mode.rs`
   lines for its report gate, payment, accumulator, cap and terminal-census pins (the figures were right). Every
   `curve_mode.rs` citation in our code was checked against the pin and re-pointed where it missed: in `census.test.ts`
   the stale census `:282-291` ("stale units" `:285-289`, the sync after the period `:290`), the due `:292-293`, the
   accumulator `:299-303`, the capped receipt `:928-947`, the census refused once retired `:972-976`, the census
   `:239-249`, the migration test `:708-766` and the sandwich test `:1036-1108`; a census on a Redeemed or Extinguished
   series now cites the rule (`curve.rs:948`), as no Stage 1 test takes one (it closes staking once redeemed,
   `:345-350`); `staking.test.ts`'s unstake-then-claim `:892-895` and its other section cites; the engine's and the
   harness's hook and fill cites; the registry and domain tests' curve-term refusals. Its other Stage 1 cites
   (`exit.rs:268-272`, the fixture generator's terms `:36-44` and proof encoding `:77-80`) too.
5. **Admin sessions read and build a wallet's curve position (disputed, low; docs corrected).** PRIVACY.md said only
   the account that linked the wallet reads its curve position, and API.md and A-CURVE-6 that the staking routes take
   one of the caller's wallets, but an admin session may name any wallet there, as on every wallet builder since S1
   (`requireWallet`'s admin bypass). The code stays (the position holds no income data: unit counts, payouts and the
   allowlist flag, all public onchain, read live and never stored; a built transaction needs the wallet's own
   signature; dropping the bypass here alone would set these routes apart from every other wallet builder), and the
   docs say so: PRIVACY.md lists admin as a reader of the row (not audited, as admin's other reads of public chain
   state), API.md "Curve staking", A-CURVE-6, the OpenAPI `wallet` parameter and the service comments. A test pins the
   admin read.

**The S3 review fixes gate**, all green at the fifth "S3 review fix" commit:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | exits 0 |
| `DATABASE_URL=… pnpm vitest run` | 71 files, 577 tests passed (572 before: 3 for the final share, 1 for the yield, 1 for the curve routes' walk) |
| `MERCES_TEST_DB=1 pnpm vitest run --project canary` | 2 files, 3 tests passed |
| `CONFORMANCE_CHAIN=simulator` / `simulator:monad` `pnpm vitest run --project conformance` | 20 and 11 tests passed |
| `pnpm stage1:vectors --personality solana,monad` | exits 0: `OK: 38/42 PASS, 42/42 at expected status (14 prefix runs)` |
| `pnpm stage1:vectors --backend reference` | exits 0: `OK: 25/25 PASS, 25/25 at expected status` |
| `pnpm stage1:vectors --backend lockstep --personality solana,monad` | exits 0: `OK: 38/42 PASS, 42/42 at expected status (14 prefix runs)` |
| `pnpm stage1:vectors --scenarios` (lockstep; also `--backend merces`) | exits 0: `OK: 22/24 PASS, 24/24 at expected status (2 runs with accepted divergences)`: S3l parts at #78 as recorded (DIV-S1I-1); `--backend reference`: `OK: 12/12 PASS` |
| `pnpm stage1:sync --no-conformance` | exits 0: curve-port `OK` (55/55 figures, 5,883/5,883 oracle cases), math and vectors `OK` (S3 claim scenarios 60/60 runs at expected status, 4 PASS-WITH-DIVERGENCES on DIV-S1I-1), diff `WARN` (unchanged), conformance skipped; `docs/stage1/VECTOR_PARITY.md` regenerated (the register's row and S3l), `MATH_PARITY.md` and `INTERFACE_DRIFT.md` unchanged |
| `pnpm openapi:client && pnpm openapi:check`; `pnpm docs:events` | `openapi.yaml matches 170 operations`; `DOMAIN_EVENTS.md` regenerated once (the final claim's weight), no change since |
| `pnpm demo:cycle` | exits 0: `DEMO OK` on both personalities |

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
  canonical event; `RaiseMintFinalized` marks every bid processed. The EVM emits `NonRevealCharged` for every
  unrevealed bid of a settled raise, 0 included (MercesAuction.sol:323); Solana only above 0 (raise.rs:1070). The
  canonical `NonRevealCharged` follows Solana: the EVM adapter drops a charge of 0 and maps the rest (NRC).
- **DeliverFirst.** Solana's `claim_redemption` and `claim_final`, and `claim_tail` while the holder still holds units
  (it redeems them first through the same body, `claims.rs:378-381` → `:300-311`), revert with DeliverFirst while the
  holder has undelivered units; the canonical model delivers inline, as the EVM and Stage 1's reference do, so the
  Solana adapter prepends `deliver_bid` to those transactions.
- **Synthesised events.** `TreasuryFunded` on Solana and `FeeTaken{auction}` on both chains come from each
  `UnitsAllocated` (its `cost` and `fee`); `FeeTaken{nonReveal, payer: bidder}` from each `NonRevealCharged` above 0
  (NRC); `AuctionFailed.unitsSold` and `reason` from `RaiseFailed` (section A).
- **The non-reveal rate on a live chain (NRC).** Stage 1's registries copy the rate into each series from the protocol
  defaults the admin sets (`set_defaults`; Solana `merces_registry` lib.rs:550, EVM `MercesRegistry.sol:597`), not from
  the creating transaction. The adapters read each series' recorded rate back into `SeriesTerms.nonRevealChargeBps`,
  and the operator keeps `MERCES_NON_REVEAL_CHARGE_BPS` equal to the chain's default (RUNBOOK).
- **Deployment and fees.** The Solana fee collector's token account must exist before the first `process_bid`; the
  keepers pay a winner's Holder PDA rent at `process_bid` and the bidder's token accounts at `deliver_bid`, and set a
  compute-unit limit on `process_bid` (A-AUC-10).

### Adapter notes for claims and curve mode (S5)

What the live adapters normalise so the canonical claims and curve mode read the same on both chains (from Stage 1's
programs and contracts at 1bfc66b; the register below lists each as a divergence):

- **Check orders.** On Solana the holder record is an account each holder instruction loads first, so an unregistered
  wallet fails before every other check (`claim`, `claim_redemption`, `claim_tail`, `claim_final`, `stake_units`,
  `unstake_units`, `tender_units`); the canonical model keeps the reference simulator's and the EVM's in-handler order
  (A-CLM-1, A-CURVE-6). The adapter maps Anchor's missing-account error to HolderNotRegistered. Solana's `claim_final`
  says NotExtinguished where the reference and the EVM say TerminalStatus; Solana's `claim_tail` redeems any remaining
  balance first, through `claim_redemption`'s body (`claims.rs:378-381`); so `claim_redemption`, `claim_final` and a
  `claim_tail` over a remaining balance revert with DeliverFirst while units are undelivered (`claims.rs:300-311`), and
  the adapter prepends `deliver_bid` to each.
- **Amounts per event (D3, A-CLM-2).** Stage 1's `RedemptionClaimed.amount` is the total (principal plus pending payout
  plus the tail catch-up) and a tender's is principal plus pending; canonically it is the principal and the rest is a
  split-out `PayoutClaimed{burnedUnits: 0}`, emitted only above 0 (also beside a curve `TailClaimed`). Solana's
  `FinalClaimed` carries the burned units and an amount that includes the redemption; canonically `units` is the weight
  and the redemption is its own events. The claim event comes before its burn (the EVM order). `RedemptionClaimed.fromStake`
  (a tender's staked part) is ours: the Solana adapter takes it from the tender's arguments.
- **Curve accounts and steps.** `sync_curve_units` takes the eight census accounts (`curve.rs:911-931`: the unit
  mint, the DBC pool and its base vault, a DAMM v2 config, its pool and that pool's base vault, and the locker escrow's
  and the leftover receiver's token accounts), and a curve's `redeem` the same eight as remaining accounts
  (`exit.rs:80-92`); staking and tender need the stake vault's token account; the issuer's curve creation is `prepare_curve` then `activate_curve` (with the DBC
  config checks: creator fee 0, the Merces fee claimer, the mint's extensions) and the registry's
  `issuer_accepts_public_price`, which the adapter sets for every curve series ("Open since S3", question 3 below).
- **One transaction from several commands.** The Solana adapter packs an ordered command list (the unstake builder's
  `[unstakeUnits, claimPayout]`) into one transaction's instructions. The EVM adapter builds one command per transaction
  (NotImplemented for a list) until a bundle is needed there: curve mode is Solana only.
- **Names.** Solana-only error names (`STAGE1_SOLANA_CODE`) and the EVM's `CurveModeUnsupported` (`STAGE1_EVM_CODE`) are
  not in `@merces/sdk`'s `ERRORS`; the adapters pass them through as `detail.stage1`.

### Owner decisions and questions

Decided (S1 review):

- **Section B is approved:** Stage 1 wins for onchain behaviour. Import `@merces/reference` instead of rewriting the
  math. Order: math and the report proof format first (vectors 04, 06, 07, 09, 11, 19, 23, 25), then auctions,
  claims, signatures, the rest.
- **Non-reveal charge: not modelled.** Settlement keeps refunding unrevealed bids in full. Vector 03 (b8, charged on a
  settled raise) waits for the owner; no S1 target has a non-revealer. (Superseded: modelled since NRC, "Decided (S3
  follow-up NRC)".)
- **Formal notice mirrors Stage 1** (period end + 90 days): applied in S1.
- **Window fee:** a series parameter, value undecided; not in S1 (S5).
- **Tier-1 public terms:** accepted, with an explicit issuer consent step; not in S1 (tier-1 milestone).
- **Curve:** no wallet cap for curve raises, and "no cap" said everywhere (A-CURVE-2; applied in S3 WP7: one statement,
  `CURVE_NO_CAP`, in every curve read, builder, notice and document); the buyer notice wording; curve staking
  first-class (S3).
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
  accounting row or API field for it (A-AUC-11). Vector 03 shows the five fields this changes (DIV-NRC-1). (Lifted by
  NRC, below.)

Open, with the default S2 uses meanwhile (the non-reveal hold and its 0 bps, open here until NRC, are decided: "Decided
(S3 follow-up NRC)"):

1. **Stage 1's two internal inconsistencies (D7)** are resolved toward SPEC and both chains and should be reported to
   Stage 1: its TS reference settles a round that would sell 0 units (SPEC and both chains fail it), and its simulator's
   `RaiseMintFinalized` on a failed raise carries the would-be units and proceeds (both chains emit 0 and 0) (A-AUC-7).

"S3 decision N" and "plan question N", below and in ASSUMPTIONS.md, number the S3 planning record, which is not kept
in the repository; each is named in full where it is cited.

Decided (S3):

- **The owner's directives for S3.** Curve holders must stake to earn, as a first-class flow (commands, builders,
  reads, notices, keepers: WP10-WP12). No wallet cap for curve raises, and "no cap" stated everywhere (WP7). The buyer
  notice is confirmed: it says the issuer "stops paying", never "defaults", that there is no deadline, and that if the
  curve never fills the issuer receives nothing (WP8, WP12; A-CURVE-8). Stage 1 wins, and its functions are imported.
  The non-reveal charge stays on hold (not modelled; lifted by the owner's NRC direction, below).
- **The segregated curve port (S3 decision 2, A-MATH-3): approved by the owner (2026-10-10).** Stage 1's TypeScript has
  no `unit_scale` (its `vaultReceiveGross`, `tailReceive`, `redemptionQuote` and `isCapped` take whole units only) and
  no curve code, so `@merces/math` ports 16 names from merces-common @1bfc66b (`vault.rs:48-170`,
  `redemption.rs:101-141`, `curve.rs:13-112`) as a segregated family. At scale 1 each scale-aware one calls Stage 1's
  own function (tested on seeded grids), so sealed-bid series run only Stage 1's functions; every curve figure is pinned
  to Stage 1's Rust tests and fixtures. This bends A-MATH-1 ("import, don't rewrite"); the alternative was to block
  curve staking on Stage 1's TypeScript. Since S3 WP6 every money path runs through the family with the series' unit
  scale (simulator state version 4, `SimSeries.unitScale`; 1 on a sealed-bid series, 10^6 base lamports on a curve
  since WP8): the vault receipt, the redemption quote and deposit (the engine's and the lifecycle service's), the
  redemption principal, the tail and `TailPayout.perUnit`. At scale 1 they are Stage 1's own functions, so the vectors,
  the lockstep and every pin are unchanged; a white-box test rescales a series to 10^6 and gets the same money.
  `SeriesState.unitScale` and the API's series read (derived from the raise style) carry it. Asked of Stage 1 (below):
  add `unit_scale` to its TypeScript, so the port becomes an import.
- **Unstake pays through the bundled claim (S3 decision 1, A-CURVE-6): approved by the owner (2026-10-10).** Stage 1's
  `unstake_units` (`curve.rs:1316-1383`) settles what the stake earned into the holder's `pending` and returns the
  units; its accounts hold no stablecoin account, so no stablecoin moves, and Stage 1's own tests unstake, then claim
  (`curve_mode.rs:808-812`; and `:892-895`, where `claim_final` pays the final share the unstake settled). SPEC v1.1.2
  §9 and `CURVE_MODE.md` §10.2 say unstaking "pays what is pending": **the code wins** (S3 WP10 mirrors it:
  `UnitsUnstaked`, no money event), and the disagreement is reported to Stage 1 (below). So that unstaking pays in the
  product, the unstake builder (S3 WP12) returns ONE transaction, `[unstakeUnits, claimPayout]`, all or nothing (owner
  direction of 2026-10-10: the chain port builds an ordered command list as one transaction; the simulator runs it in
  one execution with one rollback; the Solana adapter packs both instructions; curve mode is Solana only, and the EVM
  adapter builds one command per transaction until a bundle is needed there); its claim pays exactly the pending payout
  the unstake credited (tested: both happen or neither). The credit is never lost: if a holder unstakes through another
  tool without claiming, it stays as `pending` on the holder record, because `claim` pays `pending` for any registered
  holder with no status or allowlist check (`claims.rs:182-196`) and holder records are never closed; the wallet's curve
  position read shows it (`pending`).
- **The census desync (S3 decision 4, amendment H1, A-CURVE-5): the resolution is approved by the owner (2026-10-10).**
  Stage 1 binds a curve report's census when the report is submitted (`income.rs:376-381`), and anyone may take a
  census at any time (`sync_curve_units`, `curve.rs:936-963`): a census between the issuer's proof and its submission
  changes the count and the submission fails (InvalidProof). Since S3 WP9 Merces never causes it and says so before the
  issuer signs: assembling a curve report, and opening or signing a tier-3 case, is 409 CurveUnitsNotSynced with the
  sync step while the census predates the period's end; a proof over another count is 409 `census-changed`; building
  the submission is 409 `census-changed` (re-assemble) once a census moved the count; Merces' own census builders
  (`build-sync`, the stake builder's census step, WP12) and the keepers' census (`curve.sync`, once per period end
  before the issuer assembles, WP11) send none while the issuer has an assembled, unsubmitted report for the series'
  next expected period. A third party can still sync; asked of Stage 1 (below).
- **The owner's directions of 2026-10-10 (applied in WP12).** One transaction of several commands, all or nothing (the
  unstake builder above). The buyer notice renders the trading fee and its split among Merces (partner), Meteora
  (protocol) and the issuer (creator, 0 unless configured) from the series' curve config read from the chain (the
  stand-in's pool config today, the DBC `PoolConfig` account live); no notice hard-codes a percentage. Before the buy
  action, not only in the notice: the pre-buy quote returns `beforeYouBuy`, whose first statement is "Unapproved wallets
  earn nothing and cannot tender." (with the wallet's own `earns: false` banner when it is not approved), and
  `build-swap` refuses a buy (422, value-free) unless it carries `acknowledged: true` for that statement list's version.

Decided (S3 follow-up NRC):

- **The non-reveal charge is modelled exactly as Stage 1's code does, as a per-series setting (owner direction,
  2026-10-10: "Model the non-reveal charge exactly as Stage 1's code does, as a per-series setting, so vector 03 passes
  in full. The rate stays my decision.").** The S2 hold is gone (`NON_REVEAL_CHARGE_HELD`, `appliedNonRevealChargeBps`
  and the engine's guard): Stage 1's `processBid` runs with the series' own `nonRevealChargeBps`, the charge goes to the
  protocol fee collector at `processBid` and the rest of the escrow is refunded at `deliverBid`; a failed raise charges
  nothing (A-AUC-11). DIV-NRC-1 is deleted and 03 is PASS in full.
- **The rate is the owner's: there is no built-in default.** New series built through the terms service take the
  deployment setting `MERCES_NON_REVEAL_CHARGE_BPS` (whole bps within Stage 1's bounds, checked at startup); while it is
  unset no sealed series is built (409, naming the setting, never a value) and a curve series records 0; issuers cannot
  set it. Series created under the S2 hold recorded 0 and keep it (frozen charters). The value itself is open: the
  owner sets it (RUNBOOK).

Decided (S3 follow-up GATE):

- **A gate for the curve port (owner direction, 2026-10-10: "For the curve port, add a gate that runs the ported
  functions against Stage 1's Rust fixtures on every sync.").** `stage1:sync`'s `curve-port` step runs the ported
  family against every figure of Stage 1's curve fixtures and Rust tests and against merces-common itself (a Rust
  oracle over a deterministic corpus) and fails the sync on any disagreement, on a stale citation, and when it cannot
  run: a Rust toolchain (Stage 1's pin) is now a requirement of `stage1:sync` (VERSIONS.md), which both CI workflows
  install ("S3 follow-up: the curve-port gate (GATE)", A-MATH-3).

Open since S3, with the default S3 uses meanwhile:

1. **The curve buy builder warns, it does not refuse (S3 decision 3, A-CURVE-2).** Onchain anyone can buy on a curve
   (Meteora's DBC has no allowlist), so the buy builder (`build-swap` since S3 WP12, was `build-buy`) builds the trade
   for any linked wallet and tells one that is not approved `earns: false` with a warning (it can trade, never register,
   stake, tender or earn); the `backer` tier's check is kept for building buys through Merces (WP8), and a sell is open
   to any linked wallet. A buy needs the acknowledgement of the `beforeYouBuy` statements (above). Owner: refuse
   instead?
2. **The curve venue is a stand-in at the constant price P0 (S3 decision 5, A-CURVE-1).** The simulator's DBC stand-in
   sells at P0 throughout (exactly X per swap base), so dev:mock prices look flat; no Merces money rule depends on the
   price path (P0, the proceeds and the census follow from X, the swap base and balances). Stage 1's DBC primitives
   (`solana/meteora/src/math.ts`) arrive with the Meteora port in S5. The stand-in's partial-fill charge is ours (WP8).
3. **`issuer_accepts_public_price` (S3 decision 7).** Stage 1's registry requires it true for a curve series
   (`PublicPriceNotAccepted`, registry lib.rs:501-506). The canonical terms have no such field: choosing a curve raise is
   taken as the consent, and the Solana adapter sets the flag (S5). Owner: an explicit consent field in the terms
   instead?
4. **Pushed claims and keeper sweeps (S3 decision 6, A-CLM-3).** Stage 1 lets anyone claim for a holder (`claimFor` on
   the EVM, any payer on Solana). The canonical claims are the holder's own and the keepers push none: it would change
   the signer and payee of every builder, and no vector uses it. Owner: wanted (S5)?
5. **Staking while the curve still sells (plan question 9, A-CURVE-6).** Stage 1 allows a stake while the raise is Open
   once a census covers it; mirrored. Nothing accrues before the first payment, which needs completion.
6. **The issuer's own units (plan question 10).** Units the issuer claims from the locker count in the census like any
   other wallet's and may be staked by an allowlisted, registered issuer, which then pays itself a share of its own
   payouts, counted against the cap. Stage 1 allows it and leaves it as policy (`CURVE_MODE.md` §4: refusing the
   issuer at `register_holder`, or subtracting its account at `sync_curve_units`, are one-line switches); mirrored,
   nothing treats the issuer apart.
7. **The non-reveal charge on a curve series (plan question 8).** Settled by NRC: Stage 1's Solana registry records
   its protocol default on a curve series too and bounds it (lib.rs:550, :562); ours records the owner's setting (0
   while it is unset) and bounds it on every series. A curve has no bids, so the rate is never applied.

Asked of Stage 1 (S3), beside the two S2 inconsistencies above and the reference `claim_tail` finding in the register:

1. **Unstake: the SPEC and the code disagree.** SPEC v1.1.2 §9 and `CURVE_MODE.md` §10.2 say `unstake_units` pays what
   is pending; the code credits it and moves no stablecoin (`curve.rs:1316-1383`; `curve_mode.rs:808-812`, `:892-895`).
   Fix the SPEC, or pay at unstake (then the bundle's claim pays 0 and stays harmless).
2. **`unit_scale` in the TypeScript reference.** Add the unit scale to `@merces/reference`'s `vaultReceiveGross`,
   `tailReceive`, `redemptionQuote` and `isCapped` (a trailing argument, 1 for sealed bid) and curve mode's arithmetic
   (`p0_per_unit`, `units_outstanding`, `migration_fee_split`, `wallet_tender_fits`, `scaled_amount`), so `@merces/math`
   re-exports them and the port goes (A-MATH-3).
3. **The census a report binds.** Should a curve report bind the census taken at or after its period's end (a
   per-period snapshot) rather than the live one, so a third party's census cannot invalidate an issuer's proof between
   proving and submitting (A-CURVE-5)?
4. **The tail's effective cap in the TypeScript reference (found by the curve-port gate; low).** Rust's tail receipt
   is the vault's `receive_capped`, whose cap is `max(cap_wad, paid)`; `@merces/reference`'s `tailReceive` has no such
   effective cap, so with a tail accumulator above the tail cap Rust refunds the receipt and the TypeScript refuses on a
   negative amount. The state cannot occur (the tail cap is fixed at redemption), so this is only for the two
   references to agree.
5. **The final share of an open ask's units in the TypeScript reference (found by the S3 review; medium).** On a
   series that redeemed and was then extinguished, `claim_final` by a holder with units in an uncleared window ask: the
   EVM weighs the share on `redeemedUnits + escrow` (MercesVault.sol:654-658) and Solana on
   `redeemed_units + ask_escrow_units` (claims.rs:486-490), as Stage 1's own notes say (track-c.md C-S5, track-b.md
   B-S25); `@merces/reference`'s simulator weighs it on the redeemed units only (simulator.ts:1456-1460) and marks the
   share claimed, so the escrowed units, redeemed when the window returns them, never get theirs and it stays in the
   vault (1,050 USDC in our scenario S3l, on vector 22's prefix). We follow both chains (DIV-S1I-1); please align the
   reference, and add a vector with an open ask at a redeemed series' final claim.

Asked of Stage 1 (S4 WP5):

6. **The last-key rule in the TypeScript reference (medium).** Both chains refuse to revoke the last active key of a
   kind (Solana `LastKeyOfKind`, merces_registry lib.rs:239-245, `attestor_count >= 2`; EVM `LastActiveKey`,
   MercesRegistry.sol:331-335); `@merces/reference`'s simulator revokes it (simulator.ts:535-546: `revoke_attestor` and
   `revoke_verifier_key` set the key inactive with no check, and register re-activates with none either), which SPEC
   §1.4 rules out (SPEC.md:96). We follow the SPEC and both chains (DIV-S1I-2), so our scenario S4d runs on our backend only. Please add the rule to the reference, and a vector
   that revokes the last key.
7. **Canonical names for the key registry's refusals.** The chains name the same cases differently and the SDK's
   `ERRORS` has none of them: a zero key (`ZeroAttestorAddress` / `ZeroAddress`), an active key registered again (a
   silent re-emit on Solana / `KeyAlreadyActive` on the EVM), a revoked key revoked again (`KeyAlreadyRevoked` /
   `KeyNotRegistered`), a key never registered (Anchor's `AccountNotInitialized` 3012 / `KeyNotRegistered`), the last
   key (`LastKeyOfKind` / `LastActiveKey`). Each simulator personality raises its chain's name, with one chain-neutral
   code per case (S4 D9); canonical names would let a vector cover them on every backend.

Open since S1, with the same defaults:

1. **Who attests `liquidityEvent` for tier 2?** zkTLS data cannot show a liquidity event. Default: the report
   verifier signs the flag the device declares (A-REV-1).
2. **A lost device-held opening blocks that year's next proof.** The next quarter's proof needs the previous
   quarter's year-to-date figure and salt, which only the issuer's device holds. Default: salts are derived from a
   device secret (`deriveIncomeSalt`), so a reinstalled device rebuilds its openings from its own records; there is
   no server-side copy (PRIVACY.md). A series' first report in mid-year supplies its own prior, which only the
   attestation binds (Stage 1 A25).

Open (S4), with the default S4 uses meanwhile:

1. **Which cloud KMS holds the report-verifier key?** Stage 1 needs a secp256k1 key that signs a 32-byte keccak digest
   as it is. AWS KMS can (key spec `ECC_SECG_P256K1`, `Sign` with `ECDSA_SHA_256` and `MessageType=DIGEST`); GCP Cloud
   KMS has `EC_SIGN_SECP256K1_SHA256` at HSM protection level only, and whether it signs a keccak digest given in
   `digest.sha256` is unverified; HashiCorp Vault transit has no secp256k1 key type (VERSIONS.md "Signing keys and
   KMS", each fact pinned to a vendor source and unconfirmed against the HTML docs, which this environment cannot
   reach). Default: S4 ships the port (`signerAddress`, `signDigest`), the DER normaliser and the provider-neutral
   adapter (`RemoteSecp256k1Kms`, S4 WP3); non-local providers stay refused until one is chosen.

### Divergence register (Stage 1 behaviour knowingly not mirrored after S3 and NRC)

The non-reveal charge's row ("owner hold: not modelled", DIV-NRC-1 in the vector runner) is gone: NRC models the charge
as Stage 1's code does, and vector 03 passes in full on both personalities and in lockstep. The bid commitment's row
(SH-AUC-2) is gone too: since S4 WP2 bid and order commitments are Stage 1's keccak (A-SIG-8). Since S4 WP5 attestor
keys follow Stage 1's registry (register, forward-only revoke with the 45-day grace, rotate, the last-key rule), so the
signature row no longer lists "no revocation grace" for them. Since S4 WP6 the report verifier's keys follow the same
registry and a tier-2 report carries Stage 1's REPORT signature (secp256k1, recovered onchain), so the row lists the
co-signing attestors only. Since S4 WP7 the attestors are 20-byte keys as on both chains; what still differs is that
they co-sign at the key's address instead of signing Stage 1's messages (S4 WP9-WP13).

| Divergence | Milestone |
| --- | --- |
| Stage 1 internal, resolved toward SPEC and both chains (D7, A-AUC-7): a round that would sell 0 units fails the raise (MinRaise), where Stage 1's TS reference (`auction.ts` `finalizeSettlement`) settles it; a failed raise's `RaiseMintFinalized` carries 0 and 0, where Stage 1's simulator emits the would-be units and proceeds; a failed raise's time is `AuctionState.finalizedAt` and `SeriesState.settledAt` stays null. No vector exercises the first. S3: Stage 1's reference `claim_tail` runs the redemption body before its NoRedeemedUnits check, so for a holder whose units are all held for a window ask its simulator pays the holder's pending payout and then raises without restoring it (its own `checkRevert` would flag the state change; the chains revert the transaction, and so does ours; no vector reaches it). S3 review (DIV-S1I-1 in the vector runner): on a series that redeemed and was then extinguished, both chains weigh a holder's final share on its redeemed units plus the units in its uncleared window ask (MercesVault.sol:654-658, claims.rs:486-490), where Stage 1's reference weighs it on the redeemed units only (simulator.ts:1456-1460) and so strands the escrowed units' share in the vault; ours weighs it as both chains do (`claimFinal`, the claimable final, the final claim builder's preview). No vector reaches it; our scenario S3l does (22's prefix with S2's window open: b1 is paid 2,625 USDC where Stage 1's simulator pays 1,575, and its vault keeps 1,050 USDC for good), and is PASS-WITH-DIVERGENCES on the merces and lockstep backends on exactly the recorded fields | reported to Stage 1 |
| Adapter normalisations of the auction (see "Adapter notes for the auction"; the claims' and curve mode's are their own rows below): the EVM's `tallyBids` index range; Solana's cumulative `escrow_total`; Solana's `R` read from `r_claim`; the EVM's `BidProcessed` and `MintAuthorityRevoked` dropped; the EVM's `NonRevealCharged(0)` dropped; Solana's DeliverFirst on the redemption and final claims and on a tail claim over a remaining balance (the canonical model delivers inline, as the EVM and Stage 1's reference do) | S5 (adapters) |
| The EVM's 4,096-bid limit per auction (`TooManyBids`) is not enforced by the simulator's monad personality; `ChainInfo.limits.maxBidsPerAuction` reports it | S5 (adapters) |
| One-step transfer windows; no windows flag, eligibility or fee (B.2) | S5 |
| Canonical claim amounts per pool (S3 D3, A-CLM-2): every stablecoin amount a claim moves is in exactly one canonical event amount. `RedemptionClaimed.amount` is the principal (the chains: the total), the pending payout and the tail catch-up go in a split-out `PayoutClaimed{burnedUnits: 0}` (above 0 only); `FinalClaimed{units: weight, amount: pending + share}` (Solana: the burned units, an amount with the redemption); the claim event comes before its burn (the EVM order; Stage 1's reference simulator burns first). The adapters normalise | S5 (adapters) |
| Solana's claim check orders and names (S3 D2; "Adapter notes for claims and curve mode"): HolderNotRegistered first for every holder claim; `claim_final` NotExtinguished where Stage 1's reference and the EVM say TerminalStatus; Solana's `claim_tail` redeems any remaining balance first; DeliverFirst prepends `deliver_bid` to the redemption and final claims and to a tail claim over a remaining balance; the Solana-only error names (`STAGE1_SOLANA_CODE`) and the EVM's `CurveModeUnsupported` (`STAGE1_EVM_CODE`) are not in `@merces/sdk`'s `ERRORS` | S5 (adapters) |
| No pushed claims: Stage 1 lets anyone claim for a holder (`claimFor`, any payer); the canonical claims are the holder's own (A-CLM-3) | S5 / owner |
| No `retire_if_capped`, `withdraw_pause_request` or `end_pause` commands; `requestPause.until` advisory (B.6) | S5 |
| `payIn` exact-amount and period guards (Stage 1's `pay` takes neither) | S5 (adapters drop them) |
| Curve activation folded into `createSeries` (no `prepare_curve` / `activate_curve` issuer steps, no DBC config validation: creator fee, fee claimer, mint extensions); the adapter sends Stage 1's steps and sets `issuer_accepts_public_price` (S3 WP8, A-ADM-2) | S5 (adapters) |
| The curve's venue is a labelled stand-in for Meteora's DBC: constant price P0, our partial-fill charge, the base supply's split in `curve_config.json`'s proportions; the DAMM migration, the locker and DAMM trades only as harness hooks; `curveSwap` is a venue command, not a Merces instruction; its swap rounding differs from DBC's (Stage 1's fixture buyers hold 99,999,998 base lamports, the stand-in's 100,000,000) | S5 (Meteora port) |
| A curve raise's cancel is refused with NotSealedBid (Stage 1 fails `cancel_raise` on the missing auction account, as it does the other auction steps on a curve) | — (ours) |
| Curve staking's check orders (S3 WP10, A-CURVE-6): Stage 1's in-handler orders for `stake_units`, `unstake_units` and `tender_units`, with HolderNotRegistered where the handler settles the holder; on Solana the holder record is an account each instruction loads first, so an unregistered wallet fails before every check there (Anchor's missing-account error, which the adapter maps to HolderNotRegistered). A short wallet is the token program's refusal (ours: InsufficientFunds, no Stage 1 name) | S5 (adapters) |
| A curve tender's money and events (S3 D3, WP10): Solana's `tender_units` emits `UnitsBurned` and `RedemptionClaimed{units, amount: pending + principal}`; ours splits the pending payout into `PayoutClaimed{burnedUnits: 0}` (above 0 only) and adds `RedemptionClaimed.fromStake` (the staked part, from the tender's arguments); likewise a curve `claim_tail`'s pending payout is its own `PayoutClaimed` beside `TailClaimed`. The adapters normalise | S5 (adapters) |
| Unstake credits pending and pays nothing (Stage 1's code, mirrored; SPEC §9 and `CURVE_MODE.md` §10.2 say "pays"); so that it pays in the product, the unstake builder returns one transaction, `[unstakeUnits, claimPayout]`, all or nothing (S3 decision 1). A holder that unstakes elsewhere keeps the credit as `pending`, claimable later | approved by the owner (2026-10-10); the SPEC/code disagreement reported to Stage 1 |
| Scale-aware math is ported from merces-common @1bfc66b (A-MATH-3, S3 WP5): 16 names in `@merces/math` (`src/curve`), not Stage 1 objects; scale 1 runs Stage 1's own functions; `stage1:sync` fails when one of their merces-common items changes | approved by the owner (2026-10-10); until Stage 1 ships TypeScript counterparts (asked) |
| The curve census at report time (S3 decision 4, A-CURVE-5): mirrored, Stage 1 binds the live census when a report is submitted and anyone may sync at any time, so a third party's census between proving and submitting invalidates the issuer's proof (InvalidProof). Merces' side (amendment H1, approved by the owner): no census of Merces' own (builders, keepers) while the issuer has an assembled, unsubmitted report; the assembly needs a census after the period's end; the submission builder refuses once the count moved (re-assemble) | reported to Stage 1 (bind the census at the period's end?) |
| Tier 1: no router year-to-date binding; split receipts stand in for the router credit | tier-1 milestone |
| True-up, the FX accumulator (trading-day coverage) and the `tier4Enabled` flag (B.6, B.9) | S5 |
| Stage 1 internal, resolved toward both chains (DIV-S1I-2 in the vector runner; S4 WP5, D5): the last active key of a kind cannot be revoked. Both chains refuse it (Solana `LastKeyOfKind`, merces_registry lib.rs:239-245; EVM `LastActiveKey`, MercesRegistry.sol:331-335); Stage 1's TS reference revokes it (simulator.ts:535-546), against SPEC §1.4 (SPEC.md:96: the registry refuses to revoke the last active key of a kind unless a replacement is registered in the same transaction). Ours refuses it as both chains do. No vector revokes the last key; our scenario S4d does, on the merces backend only (the reference has no rule to compare, so it has no lockstep entry), with each personality's `expect_revert` | reported to Stage 1 |
| The key registry's names and re-registration follow the personality (S4 D9): Solana re-emits `AttestorRegistered` for a key that is already active where the EVM reverts `KeyAlreadyActive`; a revoke of a key that is not active is `KeyAlreadyRevoked` (or Anchor's `AccountNotInitialized` for a key never registered) on Solana and `KeyNotRegistered` on the EVM; `ZeroAttestorAddress` / `ZeroAddress`; `LastKeyOfKind` / `LastActiveKey`. The canonical model has no Stage 1 name for these, so each simulator personality raises its chain's, with one chain-neutral code per case, and the admin pre-checks answer one 409 per case on both chains. Rotation is the EVM's `rotateAttestor`; the Solana adapter sends `register_attestor(to)` and `revoke_attestor(from)` in one transaction | reported (canonical names asked); S5 (adapters) |
| Co-signing attestors: tier 3 (attestation v1 as canonical JSON, signed by the attestor's wallet), the FX fallback, pause approval, amendment and extinguishment take the attestor's transaction signature instead of Stage 1's `MERCES_*_V1` signature argument (B.4) | S4 (WP7-WP13) |
| `register_issuer` by the issuer (Stage 1: admin-only, B.7) | S5 |
| The window durations and the window fee are not series terms, so `createSeries` cannot bound them on a sealed raise (Stage 1: ParameterOutOfBounds) nor require Stage 1's 0 on a curve series (CurveTermsNotZero); every other canonical term follows Stage 1's `create_series` rules (A-TERMS-4): since S3 WP7 a curve series takes Stage 1's zeros for the lockup, the wallet cap and the raise durations, a positive threshold and USDC, in the Solana registry's order. The non-reveal charge is a series term bounded on every series (NRC), as Stage 1 bounds the rate it records, a curve's included | S5 |

### Blockers

| Blocker | Needs |
| --- | --- |
| D6.2/3: resolving the remaining drift and replaying the other 11 vectors in full on our simulator (08, 10, 14, 16, 20, 21 and 22 replay up to their prefix gate; 12, 13, 18 and 24 not at all) | the rest of section B (approved): S4 signatures, S5 the rest (S2 auctions and S3 claims done; vector 22's claim steps wait for S5's windows, and 21's zero claims for its u64 pause end, both covered meanwhile by our S3 claim scenarios) |
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
No cap: a curve raise has no wallet cap at any stage, on any path, Merces' own builders included (`CURVE_NO_CAP`).
→ A-CURVE-2 (owner: no cap for curve raises; applied in S3 WP7: curve terms carry Stage 1's 0, and neither the
simulator nor the buy builder caps a wallet).

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
settlement, and the curve mint event ↔ `UnitsAllocated`) are gone, and so are those items (S2 WP8); since S3 WP8 a curve
trade is `curveSwap`, which no Merces event carries (a DBC `swap2`), and `completeCurve` and `collectCurveProceeds` take
Stage 1's names (the graduation alias is gone; `CurveGraduated` keeps its alias `RaiseSettled`). `AuctionSettled` carries Stage 1's `RaiseSettled` fields only (no
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
   1's tally of the same bids. The non-reveal charge is an owner hold and is not modelled (until NRC).
   **S2:** applied (WP1–WP8, "S2 results"): Stage 1's steps with Stage 1's names, check orders and error names; the math
   is Stage 1's (`@merces/math`); a page of `tallyBids` is at most the chain's `tallyPageMax`; a bid's validity is fixed
   at reveal; one bid per wallet; a winner removed from the allowlist is delivered; refunds and units are pushed by
   `deliverBid` (the keepers deliver every bid, any wallet may deliver one); a winner holds from processing. Two Stage 1
   inconsistencies are resolved toward SPEC and the chains (D7, A-AUC-7). The vector runner shims only our bid
   commitment (SH-AUC-2, S4). The non-reveal charge stays an owner hold (0 bps, A-AUC-11; DIV-NRC-1 in 03).
   **S4 WP2:** the commitment is Stage 1's keccak and `commit_bid` runs directly (SH-AUC-2 retired): no op of the raise
   is a shim any more.
   **NRC (S3 follow-up):** the 1% non-reveal charge (H1) applied as Stage 1's code applies it, the rate per series and
   the owner's (A-AUC-11); 03 PASS in full.
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
   paid claim + tail + final in one command and there was no `register_holder` command.
   **S2:** `registerHolder` (Stage 1's `register_holder`: an allowlisted wallet, idempotent) with `HolderRegistered`,
   which both chains emit; a winner is registered when its bid is processed. A registration holds no units and grants
   no holder access (A-AUC-9, A-REV-10). The separate claims are S3.
   **S3 (WP1-WP3):** Stage 1's claim family (A-CLM-1): `claimPayout` is Stage 1's `claim` (the net payout only; a
   Retired balance burns, on no other status), `claimTail` and `claimFinal` are `claim_tail` and `claim_final`, and the
   permissionless `burnRetired{holder}` is `burn_retired` (`crankBurn` is gone; the keepers send one per holder that
   still holds units). The zero-amount rule: a claim of nothing emits its own event with zeros, and on a Retired series
   still burns (A-CLM-2). The indexer never creates a position from a claim and writes no money row for 0 (A-REV-10).
   The vector runner sends `claim`, `claim_tail`, `claim_final` and `burn_retired` directly (SH-CLM-1..3 and SH-BRN-1
   retired); the S3 claim scenarios (a)-(k) cover the paths no vector takes, in lockstep against Stage 1's simulator.
   **S3 WP4:** every claim and `registerHolder` is built through the chain-neutral API: `tail/build-claim`,
   `final/build-claim` (holder tier; Stage 1's refusals in its order with `detail.stage1`; `redeemsFirst` when the claim
   redeems the holder first; `total` and `burnsUnits` are what the relayed transaction pays and burns) and
   `holders/build-register` (account tier, the caller's wallet; NotAllowlisted; idempotent with no transaction). The
   redemption claim previews everything it pays (the redemption and the pending payout). Reads keep `claimable`,
   `pending`, `redemptionClaimable`, `tailClaimable` and `finalClaimable` apart (`PositionView`, `/me/holdings`). 164
   operations.
   **S3 (WP10, WP12) on a curve series** (B.11): registration by `registerHolder` only (allowlisted); the claims' curve
   branches (`claimPayout` never burns, `claimRedemption` is CurveUsesTender, `claimTail` pays on tendered units and
   redeems nothing, `claimFinal` weighs the tendered units or the stake and burns nothing, `burnRetired` is
   CurveModeNoBurn) and the claim builders' curve figures (A-CURVE-6).
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
   **S4 WP2:** bid and order commitments are Stage 1's keccak, `keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖
   wallet_32)` through `@merces/math` (the SDK's own `bidCommitment`), for sealed bids and window orders alike (orders
   moved with the bids: one formula on both chains). They bind neither the series nor the window, so every bid draws a
   fresh 32-byte salt; the u64 refusal stays (21 #19-#20). `stage1:sync`'s signatures step checks our builders against
   Stage 1's known answers; the window rows SH-WIN-2/3 stay S5 shims, hashing their orders the same way (A-SIG-8).
   **S4 WP3:** the KMS port signs a secp256k1 digest in Stage 1's format: `signDigest(keyId, digest)` returns
   `r ‖ s ‖ v` (low s, `v ∈ {27, 28}`) checked to recover to `signerAddress(keyId)`, failing closed; `sign` is ed25519
   only (it used to keccak the input itself and return noble's `recid ‖ r ‖ s`, and chose the algorithm from the key
   id). A cloud KMS's DER signature and DER SPKI go through `@merces/ports`' normaliser (`signature65FromDer`,
   `addressFromSpki`) and the provider-neutral `RemoteSecp256k1Kms`; no provider is wired ("Open (S4)" question 1). The
   report verifier's key stays ed25519 until S4 WP6.
   **S4 WP6:** tier 2 is Stage 1's (A-SIG-5): the report verifier's key is secp256k1 behind the KMS port, its 20-byte
   address registered as a verifier key (`registerVerifierKey`, `revokeVerifierKey`, `rotateVerifierKey`: the attestor
   keys' registry, grace and last-key rule, A-SIG-4) and pinned in the verifier (`REPORT_VERIFIER_ADDRESS`). The
   verifier signs `MERCES_REPORT_V1` (tier 2) over the domain of the series' chain from its own table
   (`MERCES_VERIFIER_CHAINS`, allow-listed, never mainnet; in development each simulator's `ChainInfo.signing`, and the
   standalone verifier's `MERCES_VERIFIER_DEV=true` with its dev seed only over local ids: any other chain, a testnet
   included, stops it at boot, A-REV-9) and the series key, and returns a `ReportAttestationRecord`; `submitReport.attestation` is `{signer, signature}`, which the
   simulated chains recover as both chains do (InvalidVerifierSignature for a malformed signature, another signer or a
   key not usable for the period) and the API checks the same way before it builds. Priors are accepted from the
   current address or a previous one only for quarters that ended by its retirement (amendment D10). Our scenarios
   S4a-S4c (the verifier key's grace, its end and a revocation before the period ended) PASS on the reference, our
   backend and in lockstep. Tier 3 stays the attestor's co-signature until S4 WP9.
   **S4 WP4:** the signing context is on the chain port (A-SIG-3): `ChainInfo.signing` (the domain, derived on read: the
   simulator's from Stage 1's local ids, Solana tag 104 and EVM 31337, with a per-chain-key registry; null on the live
   adapters until S5, whose signing flows answer 409 `signing-domain-unknown`), `SeriesState.seriesKey` (Solana the
   series PDA, EVM `bytes32(uint256(id))`, the simulator's monad pseudo-address left-padded until S5's counter ids) and
   `SeriesState.nonces {pause, amendment, extinguish, trueup}` (the ledger's own, u64 decimal strings; they replace
   `amendmentNonce`, `extinguishNonce` and `pauses.nonce`). `GET /chains` carries the domain and the public
   `GET /series/{seriesId}/signing` reads domain, key and nonces live.
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
   **S4 WP5:** attestor key revocation with its grace is Stage 1's (A-SIG-4): `registerAttestor`, `revokeAttestor`
   (forward-only, `revokedAt` = the chain's time) and `rotateAttestor` (register then revoke, one transaction); a
   revoked key still signs a report (tier 3) or an FX fallback for a period that ended by its revocation until
   `revokedAt` + 45 days (both chains: income.rs:340-356, MercesIncome.sol:168; Stage 1's reference gives the FX
   fallback no grace, simulator.ts:1092, and SPEC §1.4 names a report attestation only: DIV-S1I-3, recorded once FX
   lands in S5), while a pause approval, an amendment and an extinguishment need an active
   key; the last active key cannot be revoked (DIV-S1I-2). Simulator state version 5 holds each key's revocation
   time; the indexer projects `AttestorRegistered` and `AttestorRevoked` with their times (migration 023). Verifier keys
   follow in S4 WP6 (above, item 4): the same registry, a tier-2 attestation of a period that ended by the revocation
   valid until `revokedAt` + 45 days (Stage 1's `reportKeyValid`, which the reference models, so S4a-S4c run in
   lockstep), migration 024 (`verifier_keys`).
   **S4 WP7:** attestors are keys (S4 D4; A-M5-2 revised): a secp256k1 key's 20-byte address is the attestor on every
   chain, as Stage 1's registries hold it (`AttestorKey` PDA by address on Solana, `KeyInfo` by address on the EVM), and
   the registry's commands and events name 20-byte keys only. An account links a key by the key's own EIP-191 proof of a
   one-time challenge (`account_signer_keys`, migration 025), never by a chain wallet or a sign-in; offchain access is per
   key and per chain, read live. The admin proposes, revokes (`/admin/attestors/revoke`) and rotates
   (`/admin/attestors/rotate`, the new key linked to the same account) keys; each chain's registry is public
   (`GET /chains/{chain}/signer-keys`). Until S4 WP9-WP13 the flows that still co-sign (tier 3, the FX fallback,
   `approvePause`, `amendTerms`, `extinguish`) sign at the key's address in the simulator, and the tier-3 and FX texts
   are the key's EIP-191 signatures: transitional, removed flow by flow.
   **S4 WP8:** the attestor's signer (A-SIG-2): Stage 1 signs raw keccak digests with no EIP-191 prefix, which ordinary
   wallets cannot produce, so attestors sign with the Merces attestor tool (`merces-attestor` in `@merces/poi-device`)
   on their own machine: a Web3 Secret Storage v3 keystore at go-ethereum's standard scrypt strength, a pinned network
   table (never mainnet), Stage 1's builders over the request's typed fields (the request's digest is never trusted),
   Stage 1's `signDigest`, and an EIP-191 link proof over the API's key-link challenge only. The flows that hand it
   requests follow in S4 WP9-WP13; reading a nonce from a public RPC on live chains waits for S5's adapters.
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
   **NRC:** the non-reveal bps is bounded on every series and applied; new series take the owner's setting
   (`MERCES_NON_REVEAL_CHARGE_BPS`, no default), as Stage 1's chains copy the admin's protocol default (A-AUC-11).
   **S3 (WP7):** curve series with cap 0: `walletCapBps` may be 0, and a curve series takes Stage 1's zeros for the
   lockup, the wallet cap and the raise durations (CurveTermsNotZero), a positive threshold (CurveThresholdZero) and
   USDC (CurveQuoteMintMismatch), in the Solana registry's order; the EVM refuses curve mode first
   (CurveModeUnsupported). The window durations and fee and the FX pair stay S5.
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
11. *Curve mode.* Solana only; no buy instruction in Merces (a DBC swap; the backend builds the unsigned `curveSwap`); `activate_curve`, `complete_curve`, `collect_curve_proceeds`, `sync_curve_units`, staking and
    tender; no cancel, failure or extinguishment before graduation; units in base lamports (6 decimals). Our Meteora
    service must generate configs with creator fee 0 and the Merces PDA as fee claimer, or activation fails (H3).
   **S1:** only extinguishment (refused before graduation, WP7). The rest is S5; the owner decided curve raises carry
   no wallet cap.
   **S3:** curve staking comes forward (owner). WP7: curve terms carry Stage 1's zeros and no cap remains on any curve
   path (simulator, buy builder, reads; `CURVE_NO_CAP`). WP8: Stage 1's lifecycle: creation is the activation (P0 at
   least 1, CurveThresholdMismatch; `CurveActivated`, `RaiseOpened{0, 0}`; the raise Open), base lamports (unit scale
   10^6; r per base lamport), `curveSwap` on a labelled DBC stand-in (constant P0, 1% fee, partial fill at X, the whole
   base supply in protocol accounts, migration, locker and DAMM moves as harness hooks), `completeCurve` at the pool's
   finish time (no census, no registration), `collectCurveProceeds` (the treasury 0 until then; tranches at the first
   collection; `FeeTaken{curveTrading}`), no cancel, NotSealedBid on every sealed-bid path, CurveUsesTender and
   CurveModeNoBurn, the buyer notice (A-CURVE-1, -3, -4, -7, -8; migration 020). WP9: the census (A-CURVE-5): the
   permissionless `syncCurveUnits` (`CurveUnitsSynced`; supply less the DBC, DAMM, locker and leftover balances;
   CurveUnitsBelowStake, CurveUnitsInconsistent, TerminalStatus), the report gate (CurveUnitsNotSynced) and `redeem`'s
   own census without the DAMM pool (B-C13); the poi assembly, the submission builder and the tier-3 path census-aware,
   and `build-sync` never over an assembled report (H1); Stage 1's curve report fixtures replayed with their own Groth16
   proofs. WP10: staking and tender (A-CURVE-6): `stakeUnits` (the allowlist now, StakeExceedsOutstanding against the
   last census, ZeroUnits), `unstakeUnits` (any status; credits pending and pays nothing, Stage 1's code; unstaking pays
   through the bundled `[unstakeUnits, claimPayout]` transaction, approved by the owner on 2026-10-10: "Decided (S3)"
   above), `tenderUnits{fromStake, fromWallet}` (staked units reserved, wallet units within the quota,
   TenderQuotaExhausted; the mint's supply falls, units outstanding do not), settlement by stake (`settle_curve_holder`,
   with the final share in pending while unredeemed), the curve branches of every claim (claimPayout never burns,
   claimTail pays on tendered units and redeems nothing, claimFinal weighs tendered units or the stake and burns
   nothing), registration only by `registerHolder`; the indexer's positions from stakes and tenders (amendment M3), the
   position read's `stakedUnits` and `walletUnits`, the curve branches of the claim builders; Stage 1's curve tests
   (curve_mode.rs) and its `curve_staking_never_overpays` property pinned relationally; a Solana conformance case (EVM
   refuses a curve). WP11: the curve keepers (A-CURVE-5, -7, -9): `curve.lifecycle` completes a filled curve and
   collects its proceeds once, then the partner's trading fees weekly on the chain's clock (the admin monitor triggers
   the same pass); `curve.sync` takes the census once after completion and once per period end plus an hour, never on a
   terminal series and never while the issuer's assembled report binds the census (H1); `curve.stake-reminders` and
   `curve.tender-reminders` remind linked wallets holding unstaked units by their next step (approve, register, stake or
   tender); the chain notices `curve.completed` and `curve.tender-open`, with `toHolders` covering `curve.*` and a
   status change on a curve naming the tender (amendment M8); no notice names an amount. WP12: the curve builders and
   reads (API.md "Curve staking"): `build-swap` replaces `build-buy` (a buy needs the acknowledgement of the statements
   the pre-buy quote returns, first "Unapproved wallets earn nothing and cannot tender."; a sell is open to any linked
   wallet), `build-stake` (registration and census steps; no census over an assembled report, H1), `build-unstake` (ONE
   transaction, `[unstakeUnits, claimPayout]`, all or nothing: `ChainPort.build` takes an ordered command list, owner
   direction of 2026-10-10), `build-tender`, the wallet's curve position read (`stakable`, `stakeBlockedBy`, pending,
   the tender; amendment M8), the buyer notice's trading fee and split from the pool's config
   (`CurveState.tradingFeeSplitBps`), and every per-unit read at the series' unit scale (amendment M4); OpenAPI 165 →
   170 operations.
12. *Math.* Replace the six disagreeing families with Stage 1's formulas (or import `@merces/reference`), then
    replay the 25 vectors through a Stage 1 op runner on the simulator with full-state expectations.
   **S1:** applied (WP1, WP9a, WP9b): `@merces/reference` is imported through `@merces/math`, and Stage 1's vectors are
   replayed through a Stage 1 op runner with full-state expectations: all 25 on Stage 1's own simulator, the 10 S1
   targets on ours.

**Stage 1 documents that disagree with Stage 1's code** (the code, IDLs and vectors win): `SECURITY_REVIEW.md` on S2;
`EVENTS.md` field lists in several places; `CURVE_MODE.md` §5 (claims are gated by staking); SPEC v1.1.2 §9 and
`CURVE_MODE.md` §10.2 (unstaking "pays" what is pending: `unstake_units` credits it and moves no stablecoin; S3, asked of
Stage 1); the vectors declare
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
   Behavioural parity is the vectors step's job. It also fingerprints the merces-common items of the ported curve family
   (A-MATH-3) and fails when one is missing or changed.
4b. **curve-port** — the ported curve family against Stage 1 itself: every figure of Stage 1's curve fixtures and
   Rust tests (one cited table; a stale citation fails) and a deterministic corpus of 5,883 cases answered by Stage 1's
   own Rust (`tools/stage1-oracle`, merces-common built with Stage 1's toolchain), compared exactly. Any disagreement
   fails the sync, and so does a missing cargo ("S3 follow-up: the curve-port gate (GATE)", above; A-MATH-3).
5. **vectors** — Stage 1's own vector directory is replayed by the Stage 1 vector runner (`pnpm stage1:vectors`,
   `packages/stage1-sync/src/stage1-vectors`): on the reference backend (Stage 1's own simulator; all 25 must pass,
   proofs verified, or the runner or the checkout is broken) and on the merces backend (our simulator, both
   personalities: the S1 and S2 target vectors in full, and the vectors that need a later milestone up to their prefix
   gate, each at its expected status; the default test suite runs the same gate). Known divergences are recorded per
   step and field (`stage1-vectors/divergences.ts`; empty since NRC, which removed DIV-NRC-1, the non-reveal hold in
   03): a recorded difference is accepted (PASS-WITH-DIVERGENCES), another value fails, and an entry that no longer
   occurs fails as stale. Report proofs are verified with the ports' `Groth16ReportVerifier`, the verifier the API and
   the simulated chains run. `VECTOR_PARITY.md` lists the results, the findings with leaf-path diffs, the known
   divergences, the prefix gates, waived steps, runner-atomic reverts, the shims used ("not parity", the calls of
   expected reverts included) and the op inventory. A single JSON file of `scenarios` (the earlier Merces format) is
   replayed through the harness.
6. **conformance** — the H2 suite against each live chain (`CONFORMANCE_CHAIN=solana|evm:<chain>`).
7. **verdict** — per chain: ready for `live` only when no step failed and both **diff** and **conformance** are `ok`
   (drift left to resolve, or conformance skipped or not run, is a blocker); otherwise the blockers.

It runs in CI on every push (`.github/workflows/ci.yml`, with `--no-conformance`), on a six-hour schedule and whenever
`stage1/**`, `stage1.map.json` or `.gitmodules` change (`.github/workflows/stage1-sync.yml`; set the `STAGE1_REPO`
repository variable). Both workflows install Stage 1's pinned Rust toolchain for the curve-port step.

## After Stage 1 lands (D6 checklist)

1. Run `pnpm stage1:sync`; read `INTERFACE_DRIFT.md` first.
2. Resolve drift in the adapters' mappers (`packages/chain-solana/src/mapping.ts`, `packages/chain-evm/src/mapping.ts`).
   Change the canonical model only for a real gap, and record why here.
3. Where Stage 1 contradicts an assumption, Stage 1 wins for onchain behaviour: update the simulator and
   `ASSUMPTIONS.md`. S1 settled A-C8-1/2 (accrual), A-RED-1…4 (redemption, tail, hurdle), A-REP-1/2/3/6 (reporting,
   public inputs, pay-in, tier 1), A-REV-1/3/4/6/17/20 and A-C11-6 (extinguishment, still with counsel); S2 settled
   A-AUC-1/2/3/4 (the auction) and withdrew A-REV-2; S3 settled the claims (A-CLM-1/2), A-CURVE-2 (no cap, applied),
   A-CURVE-3 (where curve buyers' money sits, implemented) and Stage 1's curve mode but its venue (A-CURVE-1, -4…-7);
   still open: A-FX-1/2 (weekends, Chainlink, S5).
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
  B.4 of the review: applied in S4 WP6 (A-SIG-5); the cloud KMS for the key waits for the owner (S4 question 1).
- Curve buyers' money and the wallet cap: answered (see "The two curve questions" above).
- Scale-aware TypeScript math (S3, A-MATH-3): Stage 1's reference math has no `unit_scale`, so `vaultReceiveGross`,
  `tailReceive`, `redemptionQuote` and `isCapped` cannot account a curve series per base lamport, and curve mode's
  arithmetic (`p0_per_unit`, `units_outstanding`, `migration_fee_split`, `wallet_tender_fits`, `scaled_amount`) exists
  only in Rust. Asked: add them to `@merces/reference` (the scale as a trailing argument, 1 for sealed bid), so
  `@merces/math` re-exports them and the port goes.
- The curve census at report time (S3 WP9, A-CURVE-5): a report binds the live census when it is submitted and anyone
  may take one at any time, so a third party's census can invalidate an issuer's proof between proving and submitting.
  Asked: bind the census taken at the period's end instead (a per-period snapshot)? Merces' own senders hold off while
  an issuer's report waits (amendment H1, approved by the owner).
- Unstaking (S3 WP10, A-CURVE-6): SPEC §9 and `CURVE_MODE.md` §10.2 say `unstake_units` pays what is pending; the code
  credits it and moves no stablecoin. Asked: fix the SPEC, or pay at unstake. Meanwhile the unstake builder bundles the
  claim that pays it (one transaction).
- Meteora's DBC math: the DBC program's source is not in the checkout, so swap rounding cannot be checked here; Stage 1's
  TypeScript port of its primitives (`solana/meteora/src/math.ts`) comes in with the Meteora port (S5).
- Devnet and testnet deployments: still missing (blockers above).
