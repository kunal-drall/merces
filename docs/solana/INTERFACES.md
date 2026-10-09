# Solana interfaces (SPEC v1.1)

Programs (Anchor 1.2.1, Agave 3.1.10, Token-2022), ids fixed in `solana/Anchor.toml` and
`solana/keys/*-keypair.json`:

| Program | Id | Role | Upgrade authority |
| --- | --- | --- | --- |
| `merces_registry` | `GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi` | charter + registries (D1, D11) | **none** — revoked by `scripts/deploy.sh` right after `init_protocol` |
| `merces_hook` | `2PuKMkGkGLCwsDMLCmm2bcbzjxtabvt9LVJni154ezRt` | Token-2022 transfer hook (D2) | multisig + timelock (`deploy.sh --protocol-upgrade-authority`), like the EVM compliance module |
| `merces_protocol` | `EuaPg2nTXsf3CmmeJMfdiQb4C2hU7AfLfFyDLpD69six` | auction, treasury, verifier, vault, router, FX, exit, window | multisig + timelock (money code) |
| `mock_usdg_hook` | `ALQgHjCyfNAtP5mWxYny5i2eW61pK6etSC8Vx6PpgHhA` | no-op hook of the devnet USDG mock | devnet / localnet only |

IDLs: `solana/idls/*.json` and TypeScript types `solana/idls/types/*.ts`, exported from the build by
`bash solana/scripts/export-idls.sh` (`tests/idl_export.rs` fails when they are stale). Seeds and
account types are exported by the crates (`merces_protocol::state::seeds`,
`merces_onchain::seeds`, `merces_registry::state`). Deployment records:
`solana/deployments/<cluster>.json` (written by `scripts/deploy.sh`).

## Conventions

- Every amount is a `u64` in stablecoin base units; prices are base units per unit; periods are
  `u32` ids (`year × 4 + quarter − 1`); timestamps `u64` unix seconds. Anchor's Borsh decoding
  enforces the §1.1 range rule (a `≥ 2^64` argument cannot be encoded).
- Commitments: `keccak256(price_u64_be ‖ quantity_u64_be ‖ salt_32 ‖ wallet_32)`.
- Signatures: 65-byte `(r, s, v)`, `v ∈ {27, 28}`, low-s; messages per SPEC §1.4 with
  `domain = keccak256(0x01 ‖ chain_id_u64_be ‖ registry_program_id)` and `series_key` = the
  `Series` PDA. Chain ids used by the deploy script: localnet 104, devnet 103, testnet 102.
- Groth16 proofs: 256 bytes `A ‖ B ‖ C`, big-endian EIP-197 layout, **`A` already negated** by the
  prover SDK (`merces_protocol::zk`).
- **Remaining accounts.** Instructions that move a Token-2022 stablecoin take the stablecoin's
  transfer-hook accounts as remaining accounts (`[hook_program, extra_account_meta_list, …extra
  accounts]`); instructions that move units take the Merces hook accounts
  `[merces_hook, extra_account_meta_list(mint), ProtocolConfig, Series, EscrowArm]` first, then the
  stablecoin's. The programs resolve them with `spl_token_2022::onchain::invoke_transfer_checked`,
  so a superset may be passed. The full SPEC §11 vector suite also runs on a Token-2022 stablecoin
  with a transfer hook (`tests/token2022_stablecoin.rs`).
- **ATAs.** Payout destinations are always the owner's associated token account (derivation checked
  on-chain). `deliver_bid` and `deliver_order` create the recipient's ATAs idempotently (the payer
  funds them) so a missing account never strands a delivery; for holder claims the keeper prepends
  the permissionless `create_associated_token_account_idempotent` instruction when needed.
- **Compute budget and size.** Always send `SetComputeUnitLimit` (`submit_report` needs about
  209k CU, above the 200k default; see `MEASUREMENTS.md` for every instruction). Every instruction
  fits a legacy transaction; `prepare_raise` and `open_raise` must be sent as two transactions.
- **Errors.** Every failure has its own code (`merces_registry` 70, `merces_protocol` 137,
  `merces_hook` 9 codes; names and messages in the IDLs' `errors`).

## PDAs

Registry (`merces_registry`):

| Account | Seeds |
| --- | --- |
| `ProtocolConfig` | `["config"]` |
| `Issuer` | `["issuer", wallet]` |
| `AllowlistEntry` | `["allow", wallet]` |
| `AttestorKey` / `VerifierKey` | `["attestor", addr20]` / `["verifier", addr20]` |
| `FxPairConfig` | `["fx", pair_id]` with `pair_id = keccak256(feed_id ‖ inverted_u8)` |
| `Series` | `["series", series_id_u64_le]` |

Protocol (`merces_protocol`), `series` = the registry `Series` key:

| Account | Seeds | Notes |
| --- | --- | --- |
| `registry_authority` (signer) | `["registry_authority"]` | the only key the registry write interface accepts |
| `Auction` / `Treasury` / `Ledger` | `["auction" \| "treasury" \| "ledger", series]` | `Ledger` is zero-copy (784 B + 8) |
| `Bid` | `["bid", series, bidder]` | one per wallet |
| `Holder` | `["holder", series, wallet]` | created on the first allocation, fill or `register_holder` only |
| `Report` | `["report", series, period_u32_le]` | |
| `Router` | `["router", series]` | tier-1 series only |
| `FxPair` / `FxCheckpoint` | `["fxpair", pair_id]` / `["fxcp", pair_id, period_u32_le]` | shared by every series of the pair |
| `Window` / `Order` | `["window", series, period_u32_le]` / `["order", series, period_u32_le, owner]` | one order per wallet per window |
| `unit_mint` | `["unit_mint", series]` | Token-2022 mint, decimals 0 |
| `EscrowArm` | `["escrow_arm", unit_mint]` | read by the hook (`armed_owner` at 8..40, `armed_units` at 40..48) |
| signer PDAs | `["auction_auth" \| "vault_auth" \| "escrow_auth" \| "treasury_auth" \| "router_auth" \| "auction_escrow" \| "window_escrow", series]` | data-less |
| stablecoin accounts | `["escrow_token" \| "treasury_token" \| "vault_token" \| "router_token" \| "window_stable", series]` | token accounts owned by the signer PDAs |
| unit escrows | ATA(`auction_escrow`, unit_mint), ATA(`window_escrow`, unit_mint) | recorded in `Series.auction_escrow_ata / window_escrow_ata` |

Hook: `ExtraAccountMetaList` at `["extra-account-metas", mint]` (hook program).

## Registry instructions

| Instruction | Signer | Arguments | Notes |
| --- | --- | --- | --- |
| `init_protocol(args)` | payer | `admin, allowlist_manager, fee_collector, chain_id, defaults, protocol_program` | once; `protocol_authority = PDA(["registry_authority"], protocol_program)` |
| `set_allowlist_manager`, `set_fee_collector`, `set_flags`, `set_early_draw_approver`, `set_defaults`, `transfer_admin` | admin | | never the zero key; `set_defaults` bounds-checked (§1.6) and applies to future series only |
| `accept_admin` | pending admin | | two-step transfer |
| `register_attestor` / `revoke_attestor` / `register_verifier_key` / `revoke_verifier_key` | admin | `addr20` | revocation records `revoked_at`; the last active key of a kind cannot be revoked |
| `set_fx_pair` | admin | `pair_id, feed_id, inverted, crosscheck, enabled` | create-only (`FxPairImmutable`) |
| `set_fx_crosscheck` | admin | `crosscheck` | from zero (none in force): effective in the current period; otherwise effective from the next period, the feed in force stays for the running period (`prev_crosscheck`) |
| `set_fx_pair_enabled` | admin | `enabled` | gates new series only; snapshots and reports of existing series continue |
| `register_issuer` / `deactivate_issuer` | admin | `wallet` | deactivation blocks new series only |
| `set_allowed` | allowlist manager | `wallet, allowed` | |
| `create_series(args)` | issuer | terms (§1.6 bounds), `release_schedule`, `terms_commitment`, `tier_flags`, `fx_pair_id`, `mode`, `issuer_accepts_public_price`, `metadata_uri`, `tier1_terms: Option<Tier1Terms>` | fees copied from defaults; tier-1 terms checked with Poseidon(5); the stablecoin must have a zero transfer fee |
| `set_contract_hash` | issuer | `hash` | Draft only |
| `stop_issuance` / `resume_issuance` | issuer | | |
| `amend_terms` | issuer | `new_terms_commitment, new_cap_multiple_wad, attestor_addr, attestor_sig` | cap only downwards, within bounds; `terminal_status == 0` |
| `mark_raise_opened` / `mark_raise_result` / `mark_mint_finalized` / `mark_terminal` / `mark_curve_activated` | `registry_authority` PDA | | the protocol's write interface (§3.2); `mark_mint_finalized` accepts Settled and Failed raises |

## Protocol instructions

Raise (§5):

| Instruction | Signer | Arguments | Notes / remaining accounts |
| --- | --- | --- | --- |
| `prepare_raise` | issuer | | creates Auction, Treasury, Ledger, EscrowArm and the four stablecoin PDAs (escrow, treasury, vault, window); own transaction |
| `open_raise` | issuer | | creates the unit mint (TransferHook, PermanentDelegate = `vault_auth`, MetadataPointer + metadata), registry `mark_raise_opened`, hook `initialize_extra_account_meta_list`, the two unit escrow ATAs |
| `cancel_raise` | issuer | | Open and no bids; revokes the mint authority |
| `commit_bid` | bidder | `commitment, escrow` | allowlisted; stablecoin hook accounts |
| `reveal_bid` | bidder | `price, quantity, salt` | |
| `begin_settlement` | anyone | `clearing_price, q_above_claim, q_at_claim` | `TallyInProgress` while a round is open |
| `tally_bids` | anyone | | ≤ 24 `Bid` PDAs (writable) |
| `finalize_settlement` | anyone | | never reverts on a wrong proposal (`SettlementRejected`); a failed raise without bids finalises its empty mint here (accounts include `unit_mint`, `auction_auth`, `token_2022_program`) |
| `process_bid` | anyone | | stablecoin hook accounts; the holder account is created only when units are allocated; the last call finalises the mint (Settled: authority revoked, `units_outstanding` stored; Failed: empty mint) |
| `deliver_bid` | anyone | | unit hook accounts, then stablecoin hook accounts; retryable forever |

Treasury (§5.3): `claim_release` (issuer), `set_release_pause(paused)` (issuer),
`request_early_draw(amount)` (issuer + configured approver co-sign).

Repayment (§6):

- `submit_report(args)` (issuer; `args = {period, payment_usd, fx_avg_wad, fx_fallback_sig?,
  fx_attestor_addr, prior_income_commitment, income_commitment, tier, liquidity_event, proof[256],
  attestation_sig?, attestation_addr}`). Accounts `fx_pair`, `fx_start` (checkpoint `period`) and
  `fx_end` (checkpoint `period + 1`) are **always passed at their PDA addresses**; each is read only
  when it exists, so a quarter without snapshots can still be reported with an attestor fallback
  rate, and the live end totals cannot be hidden. `router` is required for tier-1 reports.
- `pay` (anyone pays the open due; the `Report` of the open due period), `submit_trueup(year,
  adjustment, attestation_ts, attestor_addr, attestor_sig)` (issuer; a zero adjustment is a valid
  true-up), `pay_trueup`, `crank_status`, `retire_if_capped`, `request_pause` /
  `withdraw_pause_request` / `end_pause` (issuer), `approve_pause(pause_end, attestor_addr,
  attestor_sig)` (anyone).

Holders (§6.3, §6.7–§6.9): `register_holder(wallet)` (allowlisted wallet), `claim`,
`claim_redemption`, `claim_tail`, `claim_final` — permissionless pushes to the holder's ATAs
(`HolderClaim` accounts; stablecoin hook accounts as remaining accounts). `burn_retired` takes
`[series, ledger, holder, holder_wallet, holder_unit_ata, vault_auth, unit_mint,
token_2022_program]` (no payer, no stablecoin) and is a no-op emitting `UnitsBurned(0)` for a wallet
without units.

Router (§6.5): `init_router` (anyone, any time; checkpoints before its creation period are exactly
0), `route` (anyone; sweeps the receiving account; holds receipts until the mint is finalised
(`MintNotFinalized`); passes everything through to the issuer when the raise failed or was
cancelled and after a terminal status),
`close_router_period(period)`.

Rate accumulator (§6.6): `init_fx_pair(pair_id)` and `snapshot_fx(period)` are permissionless, also
for a disabled pair. `snapshot_fx` takes a Pyth `PriceUpdateV2` (`VerificationLevel::Full`) and,
when a cross-check feed is in force for the period, the cross-check feed's `PriceUpdateV2` as
`crosscheck_update`.

Exit (§6.7, §6.9): `redeem` (issuer), `extinguish(attestor_a, sig_a, attestor_b, sig_b)` (anyone).

Window (§7), all permissionless except commits and reveals:

| Instruction | Signer | Notes |
| --- | --- | --- |
| `open_window(period)` | anyone | the previous window must have every order processed |
| `commit_ask(commitment, units)` | holder | arms `EscrowArm`, moves units into the window escrow; unit hook accounts |
| `window_commit_bid(commitment, escrow)` | allowlisted wallet | stablecoin hook accounts |
| `reveal_order(price, quantity, salt)` | owner | the owner's `Holder` (may not exist) and unit ATA are read for the wallet cap |
| `begin_window_settlement(clearing_price, no_match)` | anyone | `TallyInProgress` while a round is open; emits `WindowSettlementProposed` |
| `tally_orders` | anyone | ≤ 24 `Order` PDAs (writable) |
| `finalize_window` | anyone | never reverts on a wrong proposal |
| `process_order` | anyone | accounting only (the window fee is paid here): revealed bids in reveal order first (`OutOfOrder`), then revealed asks in reveal order (`BidsNotProcessed` until every revealed bid is done); unrevealed / invalid orders and NO_MATCH windows in any order. The owner's `AllowlistEntry` PDA is always passed (a missing entry reads as not allowed); a buyer no longer allowlisted is cancelled. Stablecoin hook accounts |
| `begin_takeback(price, reveal_index)` | anyone | only when cancelled buyers' units exceed the at-`p*` ask group; proposes the threshold ask below `p*` |
| `tally_takeback` | anyone | ≤ 24 `Order` PDAs; every revealed ask once per round |
| `finalize_takeback` | anyone | accepts iff `Σ_{key > k} q < R ≤ Σ_{key ≥ k} q` (unique); otherwise `WindowTakebackRejected` and a new round may start. Asks below `p*` revert `TakebackRequired` until a threshold is settled |
| `deliver_order` | anyone | after `process_order`, once, retryable forever: pays the recorded stablecoin and moves the recorded units to the owner's ATAs (created idempotently); unit hook accounts, then stablecoin hook accounts |

## Hook instructions

- `initialize_extra_account_meta_list` — the mint authority (the protocol's `auction_auth` PDA)
  signs; requires `Series.unit_mint == mint`; writes the **3-entry literal list**
  `[ProtocolConfig, Series, EscrowArm = PDA(merces_protocol, ["escrow_arm", mint])]` (B-S2).
- `execute(amount)` — called by Token-2022 on every transfer; rules of SPEC §4.1: both accounts in a
  transfer, the resolved accounts equal the list, the series maps the mint, sealed-bid mode;
  allowed only from a protocol escrow (deliveries, fills, returns) or as an armed deposit into the
  window escrow (`armed_owner == source owner`, `armed_units == amount > 0`); everything else is
  `DirectTransferForbidden`. Burns by the permanent delegate do not invoke the hook.

## Off-chain integration notes

- **Raise keepers:** read every `Bid` of the series (program accounts filtered by the `series`
  field), compute `q_above / q_at` for the candidate price and propose with `begin_settlement`;
  tally in pages of ≤ 24; `finalize_settlement`; then `process_bid` for every bid (any order) and
  `deliver_bid` (any order, retry freely).
- **Window keepers:** `begin_window_settlement` → `tally_orders` pages → `finalize_window` →
  `process_order` for revealed bids in `reveal_index` order (`Window.next_bid_index`) → if
  `below_takeback(ask_at_total, cancelled_units) > 0` (`merces_common::window`), find the
  threshold ask `k` over the valid asks below `p*` sorted by `(price, reveal_index)` descending,
  `begin_takeback(k)` → `tally_takeback` pages over every revealed ask → `finalize_takeback` →
  `process_order` for revealed asks in order (`next_ask_index`) → unrevealed orders any time →
  `deliver_order` for every order (any order, retry freely).
- **Reports:** `units_outstanding` for the proof is `Ledger.units_outstanding` (or
  `units_at_redemption` after redemption); tier-1 reports need the router's checkpoints for
  `period` and `period − 1` (`close_router_period` or a routed receipt; periods before
  `Router.init_period` read 0).
- **FX keepers:** one `snapshot_fx` per UTC trading day per pair (weekends fail staleness by
  design); a quarter's average needs `fx_min_coverage_bps` of its Monday–Friday days and no
  deviation flag, otherwise reports use an attestor-signed fallback rate.
