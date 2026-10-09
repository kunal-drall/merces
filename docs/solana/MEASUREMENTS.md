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

- all 21 parity vectors twice: on the SPL mock USDC and on the Token-2022 mock USDG
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
  two-step admin transfer, a raise cancelled before its first bid.

Every successful transaction's logs are parsed (`solana/tests/src/events.rs::record_instruction_cu`).
"Max CU" is the largest `consumed` value per program instruction over **8 runs** of the corpus;
"Lowest run max" is the smallest per-run maximum, which shows the spread (see "Variance" below).
Rows marked "(CPI)" are inner invocations, already included in the calling instruction's figure.

## Per instruction

| Program | Instruction | Max CU | Lowest run max | Samples |
| --- | --- | ---: | ---: | ---: |
| `merces_hook` | `Execute (CPI)` | 15,108 | 15,108 | 2,344 |
| `merces_hook` | `InitializeExtraAccountMetaList (CPI)` | 24,903 | 24,903 | 528 |
| `merces_protocol` | `ApprovePause` | 45,693 | 45,693 | 48 |
| `merces_protocol` | `BeginSettlement` | 7,168 | 7,168 | 552 |
| `merces_protocol` | `BeginTakeback` | 8,221 | 8,221 | 16 |
| `merces_protocol` | `BeginWindowSettlement` | 15,040 | 15,040 | 168 |
| `merces_protocol` | `BurnRetired` | 37,224 | 28,168 | 80 |
| `merces_protocol` | `CancelRaise` | 41,545 | 41,545 | 8 |
| `merces_protocol` | `Claim` | 99,222 | 72,518 | 1,184 |
| `merces_protocol` | `ClaimFinal` | 83,486 | 63,986 | 64 |
| `merces_protocol` | `ClaimRedemption` | 75,625 | 65,139 | 208 |
| `merces_protocol` | `ClaimRelease` | 95,502 | 68,502 | 464 |
| `merces_protocol` | `ClaimTail` | 81,121 | 61,589 | 64 |
| `merces_protocol` | `CloseRouterPeriod` | 7,925 | 7,925 | 48 |
| `merces_protocol` | `CommitAsk` | 88,116 | 77,616 | 168 |
| `merces_protocol` | `CommitBid` | 87,023 | 60,037 | 2,272 |
| `merces_protocol` | `CrankStatus` | 11,120 | 11,120 | 240 |
| `merces_protocol` | `DeliverBid` | 170,693 | 152,577 | 2,272 |
| `merces_protocol` | `DeliverOrder` | 162,991 | 146,491 | 224 |
| `merces_protocol` | `EndPause` | 11,775 | 11,775 | 16 |
| `merces_protocol` | `Extinguish` | 158,773 | 140,773 | 16 |
| `merces_protocol` | `FinalizeSettlement` | 50,066 | 50,066 | 552 |
| `merces_protocol` | `FinalizeTakeback` | 8,295 | 8,295 | 8 |
| `merces_protocol` | `FinalizeWindow` | 14,980 | 14,980 | 160 |
| `merces_protocol` | `InitFxPair` | 10,574 | 10,574 | 16 |
| `merces_protocol` | `InitRouter` | 37,671 | 37,671 | 48 |
| `merces_protocol` | `OpenRaise` | 183,025 | 183,025 | 528 |
| `merces_protocol` | `OpenWindow` | 26,617 | 26,617 | 72 |
| `merces_protocol` | `Pay` | 177,471 | 127,736 | 1,056 |
| `merces_protocol` | `PayTrueup` | 161,841 | 94,341 | 32 |
| `merces_protocol` | `PrepareRaise` | 128,151 | 128,151 | 528 |
| `merces_protocol` | `ProcessBid` | 203,438 | 149,218 | 2,272 |
| `merces_protocol` | `ProcessOrder` | 109,424 | 85,424 | 224 |
| `merces_protocol` | `Redeem` | 86,577 | 73,077 | 80 |
| `merces_protocol` | `RegisterHolder` | 20,493 | 18,993 | 8 |
| `merces_protocol` | `RequestEarlyDraw` | 35,787 | 35,770 | 8 |
| `merces_protocol` | `RequestPause` | 10,601 | 10,601 | 96 |
| `merces_protocol` | `RetireIfCapped` | 35,930 | 35,930 | 16 |
| `merces_protocol` | `RevealBid` | 11,948 | 11,916 | 2,224 |
| `merces_protocol` | `RevealOrder` | 37,736 | 31,484 | 320 |
| `merces_protocol` | `Route` | 168,558 | 127,736 | 144 |
| `merces_protocol` | `SetReleasePause` | 6,138 | 6,138 | 16 |
| `merces_protocol` | `SnapshotFx` | 21,094 | 21,094 | 3,568 |
| `merces_protocol` | `SubmitReport` | 208,824 | 208,824 | 1,952 |
| `merces_protocol` | `SubmitTrueup` | 51,707 | 51,707 | 48 |
| `merces_protocol` | `TallyBids` | 73,674 | 73,674 | 560 |
| `merces_protocol` | `TallyOrders` | 87,880 | 87,880 | 168 |
| `merces_protocol` | `TallyTakeback` | 80,770 | 80,770 | 16 |
| `merces_protocol` | `WindowCommitBid` | 91,462 | 64,462 | 152 |
| `merces_protocol` | `WithdrawPauseRequest` | 9,531 | 9,531 | 48 |
| `merces_registry` | `AcceptAdmin` | 6,235 | 6,235 | 8 |
| `merces_registry` | `AmendTerms` | 38,451 | 38,451 | 32 |
| `merces_registry` | `CreateSeries` | 29,523 | 29,523 | 528 |
| `merces_registry` | `DeactivateIssuer` | 6,952 | 6,952 | 8 |
| `merces_registry` | `InitProtocol` | 20,703 | 20,703 | 384 |
| `merces_registry` | `MarkMintFinalized (CPI)` | 10,656 | 10,656 | 520 |
| `merces_registry` | `MarkRaiseOpened (CPI)` | 12,908 | 12,908 | 528 |
| `merces_registry` | `MarkRaiseResult (CPI)` | 10,691 | 10,691 | 528 |
| `merces_registry` | `MarkTerminal (CPI)` | 10,645 | 10,645 | 144 |
| `merces_registry` | `RegisterAttestor` | 20,414 | 20,414 | 752 |
| `merces_registry` | `RegisterIssuer` | 33,432 | 15,432 | 384 |
| `merces_registry` | `RegisterVerifierKey` | 17,420 | 17,420 | 376 |
| `merces_registry` | `ResumeIssuance` | 4,032 | 4,032 | 16 |
| `merces_registry` | `RevokeAttestor` | 9,167 | 9,167 | 16 |
| `merces_registry` | `RevokeVerifierKey` | 9,173 | 9,173 | 8 |
| `merces_registry` | `SetAllowed` | 30,603 | 23,103 | 2,328 |
| `merces_registry` | `SetAllowlistManager` | 6,162 | 6,162 | 8 |
| `merces_registry` | `SetContractHash` | 7,879 | 7,879 | 528 |
| `merces_registry` | `SetDefaults` | 6,836 | 6,836 | 8 |
| `merces_registry` | `SetEarlyDrawApprover` | 6,152 | 6,152 | 8 |
| `merces_registry` | `SetFeeCollector` | 6,165 | 6,165 | 8 |
| `merces_registry` | `SetFlags` | 6,087 | 6,087 | 56 |
| `merces_registry` | `SetFxCrosscheck` | 8,670 | 8,670 | 8 |
| `merces_registry` | `SetFxPair` | 12,875 | 12,875 | 24 |
| `merces_registry` | `SetFxPairEnabled` | 7,370 | 7,370 | 8 |
| `merces_registry` | `StopIssuance` | 4,029 | 4,029 | 16 |
| `merces_registry` | `TransferAdmin` | 6,252 | 6,252 | 8 |
| `mock_usdg_hook` | `Execute (CPI)` | 17,018 | 8,018 | 5,856 |
| `mock_usdg_hook` | `InitializeExtraAccountMetaList` | 21,132 | 12,132 | 384 |

`merces_registry::mark_curve_activated` is not reachable yet (curve mode is a later track and
`merces_protocol` has no instruction that calls it). The `mock_usdg_hook` rows are the devnet
stablecoin mock, not Merces code.

## Variance

PDA checks without a stored bump (`seeds = [...], bump`), ATA derivation checks and Token-2022's
resolution of a stablecoin's extra-account list call `find_program_address`, which costs 1,500 CU per
bump candidate tried. The candidate count depends on the keys involved (wallets, mints, series),
which are random in the tests, so the same instruction costs a multiple of 1,500 CU more or less from
run to run; the spread column shows it (e.g. `process_bid` 149,218–203,438 CU). Per-series PDAs are
fixed for a series, so a series whose PDAs need many candidates pays more on every instruction. The
spread never affects results, only cost. Storing canonical bumps for the per-series PDAs would make
these figures nearly constant (open item in `docs/assumptions/track-b.md`).

## Limits and client guidance

- **Set a compute-unit limit on every transaction.** Without `SetComputeUnitLimit` a transaction
  gets 200,000 CU per non-compute-budget instruction. `submit_report` (208,824 CU: Groth16
  verification, a secp256k1 recovery for tier-2/3 attestations, the FX quarter average, the report
  account) always exceeds it, and `process_bid` can exceed it for unlucky keys (max 203,438 CU).
  Recommended limits: 300,000 for `submit_report`; 400,000 for `process_bid`, `deliver_bid`,
  `deliver_order`, `pay`, `pay_trueup`, `route`, `extinguish`, `open_raise`; 250,000 for every
  other instruction — or simulate and add 20 %.
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
| `deliver_bid` | 913 |
| `deliver_order` | 913 |
| `open_raise` | 908 |
| `route` | 896 |
| `pay` | 895 |
| `extinguish` | 884 |
| `prepare_raise` | 875 |
| `pay_trueup` | 863 |
| `process_order` | 854 |
| `create_series` | 830 |

- **Worst-case pages.** `TALLY_PAGE = 24` accounts per tally instruction: `tally_bids` 73,674 CU,
  `tally_orders` 87,880 CU, `tally_takeback` 80,770 CU — far below any limit; the page size is set by
  the transaction size.
- **Token-2022 stablecoins** cost more per transfer: the hooked `transfer_checked` resolves the
  extra-account list and invokes the stablecoin's hook (`mock_usdg_hook::Execute` up to 17k CU per
  transfer). The maxima above include those paths.
- **Unit transfers** always invoke `merces_hook::Execute` (15,108 CU) through Token-2022.

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
