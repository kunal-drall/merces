# Solana measurements (compute units, transaction sizes)

Measured on 9 October 2026 against the release binaries that `bash solana/scripts/build.sh` produces
(Anchor 1.2.1, platform-tools v1.52, SBPF v0, `lto = "fat"`, `overflow-checks = true`; zero
"overwrites values in the frame" warnings). The same binaries were deployed to
`solana-test-validator` 3.1.10 in the deploy rehearsal (`soSha256` in `solana/deployments/localnet.json`).

Reproduce:

```sh
bash solana/scripts/build.sh
cd solana && cargo test --release --test measure -- --nocapture   # writes solana/target/measurements.md
```

## Corpus

`solana/tests/tests/measure.rs` runs, on LiteSVM 0.17 (Agave 3.1 runtime and cost model):

- all 25 parity vectors twice: on the SPL mock USDC and on the Token-2022 mock USDG
  (`TransferHook` → `mock_usdg_hook`, `TransferFeeConfig` 0/0, `MetadataPointer`), so every
  stablecoin movement is also measured with hook resolution through the remaining accounts;
- a 30-bid auction of 1,000 units settled with tally pages of 24 bids (worst-case page);
- the window take-back flow (a cancelled buyer whose units reach below `p*`, threshold round,
  `process_order` and `deliver_order` for every order);
- a `tally_orders` page of exactly 24 orders and a `tally_takeback` page of exactly 24 asks below
  `p*` (synthetic orders written into the window: worst-case pages);
- the admin and keeper paths no vector reaches: early draw with approver co-signature, FX pair
  creation, cross-check change, pair disable, keeper `register_holder`, `set_defaults`, verifier key
  rotation, issuer deactivation, release pause, allowlist-manager and fee-collector rotation, the
  two-step admin transfer, a raise cancelled before its first bid;
- a curve-mode series (SPEC §9) on the real Meteora DBC program (`tests/fixtures/meteora`):
  `prepare_curve`, `activate_curve`, three DBC buys to completion, `complete_curve`,
  `collect_curve_proceeds`, `sync_curve_units`, stake / unstake, a claim, the census-backed `redeem`
  and `tender_units` from stake and wallet.

Every successful transaction's logs are parsed (`solana/tests/src/events.rs::record_instruction_cu`).
"Max CU" is the largest `consumed` value per program instruction over **8 runs** of the corpus;
"Lowest run max" is the smallest per-run maximum, which shows the spread (see "Variance" below).
Rows marked "(CPI)" are inner invocations, already included in the calling instruction's figure.

## Per instruction

| Program | Instruction | Max CU | Lowest run max | Samples |
| --- | --- | ---: | ---: | ---: |
| `merces_hook` | `Execute (CPI)` | 15,231 | 15,231 | 2,344 |
| `merces_hook` | `InitializeExtraAccountMetaList (CPI)` | 25,026 | 25,026 | 528 |
| `merces_protocol` | `ActivateCurve` | 49,217 | 49,217 | 8 |
| `merces_protocol` | `ApprovePause` | 45,816 | 45,816 | 48 |
| `merces_protocol` | `BeginSettlement` | 7,228 | 7,228 | 552 |
| `merces_protocol` | `BeginTakeback` | 8,281 | 8,281 | 16 |
| `merces_protocol` | `BeginWindowSettlement` | 15,100 | 15,100 | 168 |
| `merces_protocol` | `BurnRetired` | 35,783 | 28,283 | 80 |
| `merces_protocol` | `CancelRaise` | 41,836 | 41,836 | 8 |
| `merces_protocol` | `Claim` | 97,877 | 75,682 | 1,192 |
| `merces_protocol` | `ClaimFinal` | 76,127 | 65,627 | 64 |
| `merces_protocol` | `ClaimRedemption` | 85,096 | 64,082 | 208 |
| `merces_protocol` | `ClaimRelease` | 91,062 | 63,126 | 464 |
| `merces_protocol` | `ClaimTail` | 87,547 | 62,047 | 64 |
| `merces_protocol` | `CloseRouterPeriod` | 7,985 | 7,985 | 48 |
| `merces_protocol` | `CollectCurveProceeds` | 58,347 | 58,330 | 8 |
| `merces_protocol` | `CommitAsk` | 86,701 | 79,201 | 168 |
| `merces_protocol` | `CommitBid` | 84,055 | 62,959 | 2,272 |
| `merces_protocol` | `CompleteCurve` | 55,587 | 55,587 | 8 |
| `merces_protocol` | `CrankStatus` | 11,180 | 11,180 | 240 |
| `merces_protocol` | `DeliverBid` | 176,760 | 149,676 | 2,272 |
| `merces_protocol` | `DeliverOrder` | 163,377 | 140,709 | 224 |
| `merces_protocol` | `EndPause` | 11,835 | 11,835 | 16 |
| `merces_protocol` | `Extinguish` | 154,561 | 141,061 | 16 |
| `merces_protocol` | `FinalizeSettlement` | 50,357 | 50,357 | 552 |
| `merces_protocol` | `FinalizeTakeback` | 8,355 | 8,355 | 8 |
| `merces_protocol` | `FinalizeWindow` | 15,048 | 15,048 | 160 |
| `merces_protocol` | `InitFxPair` | 10,574 | 10,574 | 16 |
| `merces_protocol` | `InitRouter` | 37,731 | 37,731 | 48 |
| `merces_protocol` | `OpenRaise` | 183,436 | 183,436 | 528 |
| `merces_protocol` | `OpenWindow` | 26,742 | 26,742 | 72 |
| `merces_protocol` | `Pay` | 170,116 | 128,045 | 1,056 |
| `merces_protocol` | `PayTrueup` | 110,986 | 94,486 | 32 |
| `merces_protocol` | `PrepareCurve` | 56,359 | 56,359 | 8 |
| `merces_protocol` | `PrepareRaise` | 128,227 | 128,227 | 528 |
| `merces_protocol` | `ProcessBid` | 196,251 | 146,779 | 2,272 |
| `merces_protocol` | `ProcessOrder` | 103,605 | 88,605 | 224 |
| `merces_protocol` | `Redeem` | 91,556 | 75,041 | 88 |
| `merces_protocol` | `RegisterHolder` | 26,506 | 20,506 | 16 |
| `merces_protocol` | `RequestEarlyDraw` | 35,942 | 35,893 | 8 |
| `merces_protocol` | `RequestPause` | 10,661 | 10,661 | 96 |
| `merces_protocol` | `RetireIfCapped` | 36,233 | 36,233 | 16 |
| `merces_protocol` | `RevealBid` | 11,976 | 11,976 | 2,224 |
| `merces_protocol` | `RevealOrder` | 35,464 | 30,296 | 320 |
| `merces_protocol` | `Route` | 169,850 | 126,350 | 144 |
| `merces_protocol` | `SetReleasePause` | 6,198 | 6,198 | 16 |
| `merces_protocol` | `SnapshotFx` | 21,154 | 21,154 | 3,568 |
| `merces_protocol` | `StakeUnits` | 63,691 | 50,191 | 8 |
| `merces_protocol` | `SubmitReport` | 208,962 | 208,962 | 1,952 |
| `merces_protocol` | `SubmitTrueup` | 51,830 | 51,830 | 48 |
| `merces_protocol` | `SyncCurveUnits` | 40,116 | 29,615 | 8 |
| `merces_protocol` | `TallyBids` | 73,734 | 73,734 | 560 |
| `merces_protocol` | `TallyOrders` | 87,940 | 87,940 | 168 |
| `merces_protocol` | `TallyTakeback` | 80,830 | 80,830 | 16 |
| `merces_protocol` | `TenderUnits` | 47,556 | 46,056 | 8 |
| `merces_protocol` | `UnstakeUnits` | 26,320 | 24,820 | 8 |
| `merces_protocol` | `WindowCommitBid` | 76,522 | 61,522 | 152 |
| `merces_protocol` | `WithdrawPauseRequest` | 9,591 | 9,591 | 48 |
| `merces_registry` | `AcceptAdmin` | 6,340 | 6,340 | 8 |
| `merces_registry` | `AmendTerms` | 38,757 | 38,757 | 32 |
| `merces_registry` | `CreateSeries` | 29,889 | 29,858 | 536 |
| `merces_registry` | `DeactivateIssuer` | 7,014 | 7,014 | 8 |
| `merces_registry` | `InitProtocol` | 20,880 | 20,880 | 392 |
| `merces_registry` | `MarkCurveActivated (CPI)` | 13,374 | 13,374 | 8 |
| `merces_registry` | `MarkMintFinalized (CPI)` | 10,821 | 10,821 | 528 |
| `merces_registry` | `MarkRaiseOpened (CPI)` | 13,073 | 13,073 | 528 |
| `merces_registry` | `MarkRaiseResult (CPI)` | 10,859 | 10,859 | 536 |
| `merces_registry` | `MarkTerminal (CPI)` | 10,810 | 10,810 | 152 |
| `merces_registry` | `RegisterAttestor` | 20,519 | 20,519 | 752 |
| `merces_registry` | `RegisterIssuer` | 21,494 | 16,994 | 392 |
| `merces_registry` | `RegisterVerifierKey` | 17,525 | 17,525 | 376 |
| `merces_registry` | `ResumeIssuance` | 4,032 | 4,032 | 16 |
| `merces_registry` | `RevokeAttestor` | 9,272 | 9,272 | 16 |
| `merces_registry` | `RevokeVerifierKey` | 9,278 | 9,278 | 8 |
| `merces_registry` | `SetAllowed` | 32,165 | 20,165 | 2,360 |
| `merces_registry` | `SetAllowlistManager` | 6,267 | 6,267 | 8 |
| `merces_registry` | `SetContractHash` | 7,982 | 7,982 | 536 |
| `merces_registry` | `SetDefaults` | 6,941 | 6,941 | 8 |
| `merces_registry` | `SetEarlyDrawApprover` | 6,257 | 6,257 | 8 |
| `merces_registry` | `SetFeeCollector` | 6,270 | 6,270 | 8 |
| `merces_registry` | `SetFlags` | 6,192 | 6,192 | 56 |
| `merces_registry` | `SetFxCrosscheck` | 8,732 | 8,732 | 8 |
| `merces_registry` | `SetFxPair` | 12,937 | 12,937 | 24 |
| `merces_registry` | `SetFxPairEnabled` | 7,432 | 7,432 | 8 |
| `merces_registry` | `StopIssuance` | 4,029 | 4,029 | 16 |
| `merces_registry` | `TransferAdmin` | 6,357 | 6,357 | 8 |
| `mock_usdg_hook` | `Execute (CPI)` | 15,518 | 6,518 | 5,856 |
| `mock_usdg_hook` | `InitializeExtraAccountMetaList` | 19,632 | 12,132 | 392 |

The `mock_usdg_hook` rows are the devnet stablecoin mock, not Merces code. The curve-mode rows
(`*Curve*`, `StakeUnits`, `UnstakeUnits`, `TenderUnits`) come from one lifecycle on the real
Meteora DBC program; `CollectCurveProceeds` includes its CPIs into DBC (`withdraw_migration_fee`,
`claim_trading_fee`), and the curve-mode `redeem` (in the `Redeem` row) its eight-account census.

## Variance

PDA checks without a stored bump (`seeds = [...], bump`), ATA derivation checks and Token-2022's
resolution of a stablecoin's extra-account list call `find_program_address`, which costs 1,500 CU per
bump candidate tried. The candidate count depends on the keys involved (wallets, mints, series),
which are random in the tests, so the same instruction costs a multiple of 1,500 CU more or less from
run to run; the spread column shows it (e.g. `process_bid` 146,779–196,251 CU in this set, 203,438 CU in an earlier one). Per-series PDAs are
fixed for a series, so a series whose PDAs need many candidates pays more on every instruction. The
spread never affects results, only cost. Storing canonical bumps for the per-series PDAs would make
these figures nearly constant (open item in `docs/assumptions/track-b.md`).

## Limits and client guidance

- **Set a compute-unit limit on every transaction.** Without `SetComputeUnitLimit` a transaction
  gets 200,000 CU per non-compute-budget instruction. `submit_report` (about 209k CU: Groth16
  verification, a secp256k1 recovery for tier-2/3 attestations, the FX quarter average, the report
  account) always exceeds it, and `process_bid` can exceed it for unlucky keys (203,438 CU seen).
  Recommended limits: 300,000 for `submit_report`; 400,000 for `process_bid`, `deliver_bid`,
  `deliver_order`, `pay`, `pay_trueup`, `route`, `extinguish`, `open_raise`; 250,000 for every
  other instruction (the curve-mode instructions included) — or simulate and add 20 %.
- **Transaction size.** The harness asserts that every transaction it sends fits one packet as a
  legacy transaction (1,232 bytes); the largest shapes are below. `prepare_raise` and `open_raise`
  together exceed the limit (1,289 bytes), so they are two transactions (as `scripts/smoke.ts`
  sends them). `submit_report` leaves 68 bytes: a `SetComputeUnitPrice` instruction fits (no new
  account key), an additional instruction with new accounts does not. Tally pages of 24 accounts
  fit without address lookup tables.

| Transaction (Merces instructions) | Max bytes |
| --- | ---: |
| `submit_report` | 1,164 |
| `tally_orders` | 1,108 |
| `tally_bids` | 1,075 |
| `tally_takeback` | 1,075 |
| `process_bid` | 1,019 |
| `redeem` | 949 |
| `deliver_bid` | 913 |
| `deliver_order` | 913 |
| `open_raise` | 908 |
| `route` | 896 |
| `pay` | 895 |
| `collect_curve_proceeds` | 884 |
| `extinguish` | 884 |
| `prepare_raise` | 875 |
| `pay_trueup` | 863 |

- **Worst-case pages.** `TALLY_PAGE = 24` accounts per tally instruction: `tally_bids` 73,734 CU,
  `tally_orders` 87,940 CU, `tally_takeback` 80,830 CU — far below any limit; the page size is set by
  the transaction size.
- **Token-2022 stablecoins** cost more per transfer: the hooked `transfer_checked` resolves the
  extra-account list and invokes the stablecoin's hook (`mock_usdg_hook::Execute` up to 15.5k CU per
  transfer). The maxima above include those paths.
- **Unit transfers** always invoke `merces_hook::Execute` (up to 15,231 CU) through Token-2022.

## Cryptographic primitives (isolated)

The exact functions the programs call (`merces_protocol::zk::verify_report_proof`,
`merces_onchain::recover_eth_address`, `merces_onchain::poseidon2/5`) were compiled into a
measurement-only program with the same toolchain and run on `solana-test-validator` 3.1.10 with the
three Groth16 proofs of `packages/vectors/01_happy_path.json` (all verified). Figures are net of the
138-CU empty-program baseline:

| Primitive | CU | Syscall cost inside it (Agave 3.1 cost table) |
| --- | ---: | --- |
| Groth16 verification, 6 public inputs (SPEC §8) | 102,733 | 6 × (G1 mul 3,840 + G1 add 334) + pairing 36,364 + 3 × 12,121 = 97,771 |
| secp256k1 recovery + keccak address (SPEC §1.4) | 25,262 | `secp256k1_recover` 25,000 |
| Poseidon(2) (tier-1 binding, income commitments) | 872 | `sol_poseidon` |
| Poseidon(5) (tier-1 terms at `create_series`) | 2,209 | `sol_poseidon` |

The verifier costs about 103k CU per report on Solana, dominated by the alt_bn128 pairing syscall,
and is constant per proof.
