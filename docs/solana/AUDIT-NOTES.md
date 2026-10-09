# Solana audit notes (Track B, SPEC v1.1)

Notes for reviewers of `solana/`: what the programs trust, who can do what, how SPEC §12 is met,
how it is tested and what remains open. Interpretations and SPEC defects are listed in
`docs/assumptions/track-b.md`; interfaces in `INTERFACES.md`; events in `EVENTS.md`; costs in
`MEASUREMENTS.md`.

## Scope and build

| Item | Value |
| --- | --- |
| Programs | `merces_registry` (immutable), `merces_hook`, `merces_protocol`, `mock_usdg_hook` (devnet mock) |
| External programs (curve mode) | Meteora DBC `dbcij3LW…aqN` 0.2.1, DAMM v2 `cpamdpZC…1sGG`, Jupiter locker `LocpQguc…Qqjn` (read or called by `merces_protocol::curve`; tests run the SDK 1.5.13 DBC fixture build, sha256 `71e06857b67882bff19d9c57134b150530a168973eea30c75edc7ceec4eaf401`) |
| Shared crates | `crates/merces-common` (pure `no_std` math, no syscalls), `crates/merces-onchain` (keccak, secp256k1 recovery, Poseidon syscalls, hook-aware `transfer_checked`, transfer-fee assertion) |
| Toolchain | Anchor 1.2.1, Agave 3.1.10, platform-tools v1.52, SBPF v0, rustc 1.97.1 (`solana/rust-toolchain.toml`) |
| Key dependencies (locked in `solana/Cargo.lock`) | `spl-token-2022` 11.1.0, `spl-tlv-account-resolution` 0.11.4, `groth16-solana` 0.2.0, `pyth-solana-receiver-sdk` 2.0.0, `solana-secp256k1-recover` 3.3.0, `solana-poseidon` 3.1 |
| Release profile | `overflow-checks = true`, `lto = "fat"`, `codegen-units = 1` |
| Build | `bash solana/scripts/build.sh`: no warnings, no "overwrites values in the frame" stack warnings; the binaries are reproducible (identical `sha256` across rebuilds, recorded as `soSha256` in `solana/deployments/localnet.json`) |
| Hygiene | `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings` clean |

## Trust model and roles

| Actor | Can | Cannot |
| --- | --- | --- |
| Protocol admin (registry `admin`, two-step transfer) | register/revoke attestor and report-verifier keys (forward-only, never the last key), register/deactivate issuers, create FX pairs (write-once) and change their cross-check feed (from the next period), set flags (pause **new** raises, windows, tier 4), set defaults for **future** series, rotate the allowlist manager, fee collector and early-draw approver | touch a live series' terms or fees, move treasury / vault / escrow / router funds, block claims, releases, redemption or deliveries. Pinned by `charter.rs::admin_cannot_move_funds`, the IDL signer audit and instruction-surface snapshot in `charter_c11.rs` |
| Allowlist manager | add/remove wallets | anything else; removal never strands funds already owned (claims and returns are exempt; a buyer removed before its window fill is refunded in full) |
| Fee collector | receive fees (its ATA is only ever a destination) | — |
| Early-draw approver | co-sign an issuer's `request_early_draw` (unset = disabled) | draw alone |
| Attestors (secp256k1 keys) | approve pauses, amendments (issuer-favourable only), true-ups, tier-3 reports, FX fallback rates; two distinct attestors extinguish a series | move funds to themselves; every message is domain-separated (§1.4) and nonce- or state-bound |
| Report-verifier keys | sign tier-2 (zkTLS) attestations | — |
| Issuer | create series, set its contract hash in Draft, open/cancel raises, prepare and activate a curve series (binding its DBC pool while the curve runs), report, pay, request/withdraw/end pauses, redeem, claim vested releases, pause its own releases | change terms after opening (except attested cap reductions), withdraw escrow or vault funds |
| Keepers (anyone) | settlement and window proposals and tallies, processing and delivery, claims pushed to holders' own ATAs, snapshots, routing, status cranks, retire-if-capped, extinguish (with signatures); curve mode: `complete_curve`, `sync_curve_units`, `collect_curve_proceeds` | reset another keeper's round in progress, redirect any payment (destinations are the owner's ATAs, derivation-checked) |
| Upgrade authorities | `merces_protocol` and `merces_hook`: multisig + timelock (`deploy.sh --protocol-upgrade-authority`), the EVM side's timelock equivalent | `merces_registry`: none — revoked by the deploy script, verified in the deployment record (`upgradeAuthority: null`) |

External trust:

- **Stablecoin issuers** (USDC: SPL Token; USDG: Token-2022). A freeze of a protocol token account
  would stop movements from it; a non-zero transfer fee (older **or** newer fee in the
  `TransferFeeConfig`) makes every transfer revert `TransferFeeNotZero` (checked on each transfer,
  so accounting can never silently lose value). Both are recipient/issuer-side failures the
  protocol cannot prevent; nothing else depends on them.
- **Pyth** (`PriceUpdateV2`, owned by the receiver program, `VerificationLevel::Full`, staleness and
  confidence bounds from the defaults). A missing or stale feed only means no snapshot that day;
  a quarter with too few snapshots (or a deviation flag) needs an attestor-signed fallback rate.
  The admin's cross-check feed choice can force that fallback for a period (a stale cross-check
  update makes that day's `snapshot_fx` revert); it never blocks a report.
- **Meteora (curve mode only).** The DBC program holds the raise until completion and its layouts
  are read at fixed offsets (`curve::layout`, program 0.2.1; owner, discriminator and length are
  checked first): a DBC upgrade that moves fields would make `activate_curve` / `complete_curve` /
  `collect_curve_proceeds` refuse or misread, so the offsets must be re-verified against every
  Meteora release before a protocol upgrade. Proceeds reach the treasury only through DBC's own
  `withdraw_migration_fee` / surplus instructions signed by `curve_authority`; the protocol never
  trusts a reported amount and books the treasury balance difference. The census trusts that only
  the DBC pool authority can create DAMM v2 pools on configs whose `pool_creator_authority` is that
  authority (one pool per base mint, created at migration), and that the locker escrow is
  `PDA(["escrow", PDA(["base_locker", dbc_pool], DBC)], locker)`. Meteora's own base fee and the
  issuer's vested units count as outstanding once they leave protocol-held accounts.
- **Groth16 setup.** `src/zk/vk.rs` comes from the development ceremony of `circuits/` (fixed
  entropy, **not for production** per SPEC §8); a production ceremony must replace the key before
  mainnet (a protocol upgrade).

## Account validation (SPEC §12)

- Every account is an Anchor typed account (owner + discriminator), a PDA with seeds (and the
  stored bump where the account stores one), a `Signer`, an `address =` constraint against a value
  recorded at creation (stablecoin mint, stablecoin program, unit mint, escrow ATAs in the
  registry `Series`), or an `UncheckedAccount` with a `/// CHECK:` reason that the handler then
  validates (ATA derivation via `require_ata`, owner checks for optional PDAs such as `Holder`,
  `AllowlistEntry`, FX checkpoints).
- The token program is always the mint's own program (`Series.stablecoin_program` is taken from the
  mint's owner at `create_series`; units are Token-2022 only).
- Transfer-hook extra accounts (both the Merces hook and a stablecoin's) are resolved and checked by
  `spl_token_2022::onchain::invoke_transfer_checked`; the Merces hook re-checks the resolved list
  against the mint's `ExtraAccountMetaList` (`check_account_infos`) and validates `EscrowArm` by
  address and owner.
- Curve mode: DBC `PoolConfig` / `VirtualPool` accounts are checked by owner (DBC program),
  discriminator and length, then by the addresses the registry recorded at activation
  (`dbc_config`, `dbc_pool`, `base_mint`); DBC vaults must equal the pool's `base_vault` /
  `quote_vault`; DBC CPIs pass the fixed pool authority, event authority and program ids. The census
  accounts are derived (DAMM v2 pool and vault PDAs, locker escrow ATA, leftover ATA of
  `curve_authority`) and token accounts must be of the base mint; the stake vault must be
  `ATA(curve_stake, base_mint)` under Token-2022.
- Accounts that may legitimately not exist (a buyer's allowlist entry, a holder account before the
  first allocation, FX checkpoints) are passed at their derived address and read only when
  initialised, so a caller can neither forge them nor gain anything by omitting them.

## Arithmetic

Checked arithmetic everywhere (`checked_*` with `MathOverflow`, plus `overflow-checks` in release),
`u128` intermediates for every product, nested `mul_div` forms as SPEC §1.1, exact WAD carries
(`carry_wad`, `tail_carry_wad`, `final_carry_wad`, each `< N`). The pure math lives in
`merces-common` with unit tests and `proptest` property tests (vault conservation and cap, final
distribution exactness, unpaused-time laws, status monotonicity, pauses never worsen status, late
accrual bounds, redemption bounds, year ring, vesting, FX averages and normalisation, period laws,
unique window clearing price, incremental window settlement equal to the reference algorithm on
random books). Curve-mode series account in base lamports with `Ledger.unit_scale = 10^6`; the
cap per accounting unit is `cap_per_unit × WAD / unit_scale` (checked division; `unit_scale` must
divide WAD) and the scaled redemption equals the unscaled one (property test). Curve properties:
staking never pays more than the net receipts over random stake / unstake / receipt / claim /
transfer sequences, wallet tenders never exceed the redemption deposit, and the balance-reading
scheme of CURVE_MODE §5 double-pays (a regression test that documents why staking was chosen).

Curve-mode invariant: `staked_total ≤ units_outstanding` at every receipt (stakes are bounded by
the last census; a census below the stake is refused), so `Σ stake × Δacc ≤ net`. Trading around a
`sync_curve_units` (selling unstaked units into the DAMM v2 pool before it and buying back after)
can lower `units_outstanding` and raise the per-unit payout, but only toward the share of units that
were not staked anyway; it never lets payouts exceed a receipt.

## Liveness (SPEC §12)

| Risk | Design |
| --- | --- |
| A keeper resets or blocks a settlement in progress | a new proposal is accepted only when no round is open or the last round was rejected; `finalize_*` never reverts on a wrong proposal (rejection events); applies to the auction, the window clearing price and the window take-back threshold |
| A bidder's account blocks the raise | `process_bid` only moves money into protocol accounts (treasury, fee collector, auction escrow); `deliver_bid` pushes to the bidder and may fail and be retried forever; mint finalisation depends only on every bid being processed (`raise_paths.rs::undeliverable_winner_blocks_nothing`) |
| A window participant blocks the window | `process_order` is accounting plus the fee; `deliver_order` pushes units and stablecoin, per order, retryable (`window_settlement.rs::frozen_recipient_never_blocks_other_orders`) |
| Allowlist omission griefing | the buyer's `AllowlistEntry` PDA is a required, address-checked account (a missing entry reads as not allowed), so a keeper can neither cancel nor force a fill by omitting it |
| Unbounded loops | every per-order/per-bid pass is paged (≤ 24 accounts per instruction); the take-back below `p*` uses a keeper-proposed threshold verified by a paged tally instead of sorting on chain |
| FX data missing | reports for a quarter without snapshots go through the attestor fallback; the end-of-quarter totals cannot be hidden (the end checkpoint is read whenever it exists) |
| Tier-1 router stranded | `init_router` works at any time (earlier periods read 0); receipts of a failed/cancelled raise or a terminal series pass through to the issuer |
| Dead raises | a raise with no valid bid fails; failed raises finalise an empty mint (authority revoked) so nothing waits forever |
| Releases | `claim_release` is blocked only by the issuer's own pause, derived `Late`, or lateness masked by a pause (C11 §1) |
| Curve completion and proceeds | `complete_curve` and `collect_curve_proceeds` are permissionless and read DBC state only; `collect_curve_proceeds` skips what DBC already marked withdrawn, so it is idempotent and cannot be front-run into a loss (withdrawals can only go to the treasury token account, signed by the PDA) |
| Curve census | `sync_curve_units` is permissionless; accounts that do not exist yet count 0; the snapshot must postdate the period before its report (`CurveUnitsNotSynced`), which any keeper can provide |
| Curve holders | `unstake_units` is never blocked (any status, no allowlist), settling pending payouts and the final share first; tenders of staked units are always covered (reserved at redemption); wallet tenders are first-come within `units_at_redemption − tendered − staked` |

## Tests (all green)

| Suite | Count | What |
| --- | ---: | --- |
| `merces-common` unit + property tests | 75 | pure math, window settlement model checks, curve units / staking / tender properties |
| `merces_protocol` unit tests | 5 | Groth16 key vs vector proofs (host), G1 negation, zero income commitment, key-grace rules, ledger layout |
| `tests/vectors.rs` | 21 | every SPEC §11 parity vector on the SPL mock USDC, with SPEC §3.3 charter byte snapshots after every step |
| `tests/token2022_stablecoin.rs` | 21 | the same 21 vectors on the Token-2022 mock USDG (transfer hook, zero fee) |
| `tests/charter.rs` | 5 | charter immutability, registry write interface, hook rules, §6.3 vault invariants over four lifecycles, no admin money path |
| `tests/charter_c11.rs` | 7 | one test per Autonomy Charter rule C11 §1–§7 |
| `tests/curve_mode.rs` | 7 | curve mode against the real DBC program: full lifecycle (activate → complete → collect → sync → report with a real proof → gated claims → redeem → tender), activation validation, census before/after a byte-exact mocked migration, staking rules, extinguishment, retirement without burns, PDA creator |
| `tests/known_answers.rs` | 5 | SPEC §1.4 known answers (keccak, Poseidon, domains, commitments, signatures incl. low-s, periods, year ring, fixed point) |
| `tests/raise_paths.rs` | 5 | no-bid failure, cancellation, undeliverable winner, early draw, dead-raise router |
| `tests/window_settlement.rs` | 3 | take-back below / at `p*`, frozen recipient liveness |
| `tests/fx_paths.rs` | 2 | cross-check change semantics (incl. disabled pair), quarter without snapshots |
| `tests/roles.rs` | 3 | two-step admin transfer, role rotation, issuer release pause |
| `tests/idl_export.rs` | 1 | committed IDLs equal the build |
| `tests/measure.rs` | 1 | compute units per instruction, transaction sizes |

The harness asserts on every transaction that it fits a 1,232-byte legacy packet.

## Deployment rehearsal

`solana/scripts/deploy.sh localnet --skip-build --keypair <deployer> --protocol-upgrade-authority
<multisig>` against `solana-test-validator` 3.1.10: deploys the four programs at their fixed ids,
creates the mock USDC (SPL) and USDG (Token-2022: transfer hook → `mock_usdg_hook`, fee 0/0,
metadata pointer), calls `init_protocol` with the SPEC §1.6 defaults and the curve quote mint
(`--curve-quote-mint`, default the mock USDC), revokes the registry's
upgrade authority, hands the protocol and hook upgrade authorities to the multisig key, then
re-reads everything from chain (`deploy-init.ts --verify`) and writes
`solana/deployments/localnet.json`. `scripts/smoke.ts` then registers an issuer, creates a series,
opens its raise (unit mint extensions, hook list and registry mapping checked) and commits a bid.
Devnet was unreachable from the build environment, so no devnet record exists yet.

## Open items

- Production Groth16 ceremony and verifying key (protocol upgrade before mainnet).
- Compute-unit variance from bump searches (`MEASUREMENTS.md`): storing canonical bumps for the
  per-series PDAs would make costs nearly constant; clients must set compute limits meanwhile.
- `Bid`, `Order`, `Report` and `Holder` accounts are never closed (rent stays locked; the records
  remain readable for audit). A later version may add rent reclamation after a series ends.
- Curve mode: DAMM v2 and the locker are mocked byte-exactly in LiteSVM (only DBC runs); a
  local-validator run with the real `cp_amm.so` / `locker.so` migration would close the gap. The
  DBC layout offsets are tied to program 0.2.1. Policy items for Kunal: the migration-fee route
  (Q3; activation enforces the partner route or the PDA creator), unclaimed shares of unstaked units
  (stay in the vault), issuer-held units counted as outstanding, the creator trading-fee share
  (`docs/assumptions/track-b.md` B-C4, B-C5, B-C11, B-C12).
- `Holder` accounts of curve series are never closed either; the stake vault stays open after the
  last unstake.
