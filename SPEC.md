# Merces Stage 1 — Normative Specification (v1.1, 8 October 2026)

> v1.1 folds in the confirmed findings of the adversarial spec audit (see §13 for the change list). Implementers on
> v1.0 must re-read §5, §6, §7 in full.

This document turns `BUILD_PROMPT.md` (the brief) into a concrete, chain-neutral design that the
Solana programs and the EVM contracts both implement. Where this document chooses a default or
resolves an ambiguity, the choice is also recorded in `ASSUMPTIONS.md`. Where this document and the
brief disagree on money or charter semantics, the brief wins and this document must be fixed.

Everything here is normative for implementers: identical names, identical arithmetic order, identical
rounding, identical events. The TypeScript reference implementation in `packages/reference` is the
executable form of this document and generates the parity vectors in `packages/vectors`.

---

## 0. Repository layout

```
merces/
├── BUILD_PROMPT.md            the brief (authoritative on semantics)
├── SPEC.md                    this document (authoritative on design)
├── ARCHITECTURE.md EVENTS.md INTERFACES.md ASSUMPTIONS.md VERSIONS.md AUDIT_NOTES.md PARITY_REPORT.md
├── packages/
│   ├── reference/             @merces/reference — bigint math, protocol simulator, vector generator (TypeScript)
│   ├── vectors/               generated parity vectors (JSON, checked in)
│   └── sdk/                   @merces/sdk — hashing, commitments, message encodings, PDA helpers, ABI/IDL re-exports
├── circuits/                  circom reference circuit, dev trusted setup, generated verifiers
├── solana/                    Anchor workspace: programs/{merces_registry, merces_hook, merces_protocol, mock_usdg_hook}, tests/ (Rust + LiteSVM), scripts/
├── evm/                       Foundry workspace: src/, test/, script/, lib/
├── scripts/                   cross-cutting scripts (vector regeneration, parity report)
└── docs/research/             research memos (Meteora DBC, Pyth, T-REX)
```

Programs and contracts:

| Module (brief) | Solana program | EVM contract(s) |
| --- | --- | --- |
| D1 charter & terms, D11 registries, fee collector config, governance flags | `merces_registry` (deployed **immutable**: upgrade authority revoked) | `MercesRegistry` (non-upgradeable) |
| D2 unit token | Token-2022 mint per series (created by `merces_protocol`), `merces_hook` transfer hook | T-REX ERC-3643 suite + `MercesComplianceModule` |
| D3 auction, D4 treasury, D5 split router, D6 verifier, D7 vault, D8 exit, D9 window, C9 rate accumulator | `merces_protocol` (one program, upgradeable via multisig + timelock) | `MercesAuction`, `MercesTreasury`, `MercesIncome` (verifier + router + rate accumulator), `MercesVault` (payouts + exit), `MercesWindow`, `Groth16Verifier` (generated), all UUPS proxies owned by a `TimelockController` |
| Fee collector | token accounts owned by the fee-collector authority configured in the registry | `FeeCollector` (pull-only, owner = timelock) |

Rationale for one protocol program on Solana: every money module reads and writes the same per-series
ledger (status, accumulators, due amounts). Keeping them in one program avoids cross-program writes
and keeps invariants checkable in one place. The registry is separate so that charter data has no
upgrade path at all. The hook is separate because Token-2022 calls it by interface.

---

## 1. Shared conventions

### 1.1 Numbers

- `WAD = 10^18`. All ratios (rates, multiples, per-unit accumulators) are WAD fixed point.
- Money amounts are stablecoin base units, unsigned 64-bit everywhere. EVM code uses `uint256` storage but **every amount must fit in `uint64`** (checked where values enter the system) so both stacks share one numeric domain. Intermediates: `u128` on Solana, `uint256` on EVM; the sequence of operations and the rounding points are identical.
- Basis points (`bps`) are `u16` with `10_000 = 100%`.
- Division always rounds **down** unless this document says `ceil`. Where the brief says rounding favours the issuer, the specific rounding is written out below; never improvise.
- `mulDiv(a, b, c) = floor(a × b / c)` computed in 128-bit (Solana) or 256-bit (EVM) without intermediate overflow for the domain above. All arithmetic is checked; overflow reverts. Three-factor products are written as nested `mulDiv` with the rounding point fixed (e.g. `late_accrual = mulDiv(mulDiv(amount, hurdle_rate_wad, WAD), late_days, 365)`); both stacks use the same nesting.
- **Entry-point range rule.** Every externally supplied amount, price, quantity, escrow, `payment_usd`, `fx_avg_wad`, adjustment and timestamp must satisfy `≤ 2^64 − 1` (`i64` for signed); the EVM reverts `AmountOutOfRange`, Solana's types enforce it. Derived dues (`due`, `due + accrual`, `deposit`) must also fit `u64` or the call reverts.
- **Zero-amount rule.** Unit burns and unit/stablecoin transfers are issued only for amounts `> 0`; a zero amount is skipped (no call, no transfer event). A claim whose stablecoin and unit amounts are both zero succeeds as a no-op and emits its claim event with zeros (T-REX reverts zero-value compliance calls; Token-2022 does not — this rule keeps both chains identical).

### 1.2 Time, days and periods

- Timestamps are unix seconds. `DAY = 86_400`. `YEAR = 365 × DAY = 31_536_000` (used for hurdle years, late-accrual denominators and the tail). `MONTH_SECONDS = 2_629_800` (30.4375 days); 18 months = `47_336_400` seconds.
- A **period** is a UTC calendar quarter. `period_id = year × 4 + (quarter − 1)` where `quarter ∈ {1,2,3,4}`. Example: 2026 Q1 → `8104`.
- `period_of(ts)`: civil date from days since epoch (Howard Hinnant's `civil_from_days` algorithm, exact for all unix timestamps ≥ 0); quarter = `(month − 1) / 3 + 1`.
- `period_start(pid)` and `period_end(pid)` are the first second of the quarter and the first second of the next quarter (exclusive end), from `days_from_civil`.
- `days_in_period(pid) = (period_end − period_start) / DAY` (90, 91 or 92).
- `year_of(pid) = pid / 4`, `quarter_index(pid) = pid % 4` (0 = Q1).

### 1.3 Hashing and encodings

- `keccak256` is the only hash used on-chain (Solana: `solana_program::keccak::hashv`). Poseidon (BN254, circomlib parameters) is used **only** inside the zk circuit and off-chain for commitments; chains treat commitments as opaque 32-byte big-endian field elements.
- Byte encodings in hashed messages: integers big-endian fixed width (`u8`, `u16`, `u32`, `u64`, `i64` two's complement); 32-byte values raw; **wallets are 32 bytes**: a Solana pubkey as-is, an EVM address left-padded with 12 zero bytes.
- **Bid / ask commitment**: `keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32)`. Prices are base units per unit; quantities are units.
- **Domain** (per deployment, stored at registry init): `domain = keccak256(chain_kind_u8 ‖ chain_id_u64 ‖ registry_address_32)` with `chain_kind` 1 = Solana, 2 = EVM. `chain_id` on EVM is the EVM chain id (Monad testnet 10143); on Solana it is a cluster tag set at init (mainnet-beta 101, testnet 102, devnet 103, localnet 104).
- **Series identifier in messages**: `series_key_32` = the series PDA address (Solana) or `bytes32(uint256(series_id))` (EVM).

### 1.4 Signatures (attestors and report-verifier keys)

Attestor and report-verifier keys are **secp256k1** keys identified by their 20-byte Ethereum-style address on both chains, so one Stage 2 key works everywhere. Signatures are 65 bytes `(r, s, v)` with `v ∈ {27, 28}`, low-`s` enforced (`s ≤ secp256k1n / 2`). Verification: EVM `ecrecover` via OpenZeppelin `ECDSA.recover`; Solana `secp256k1_recover` syscall, then `keccak256(pubkey_64)[12..32]` must equal the registered address. The signed digest is the raw message hash below (no EIP-191 prefix; the magic string is the domain separation).

| Purpose | `msg = keccak256(` |
| --- | --- |
| Report attestation (tier 2 verifier key, tier 3 attestor) | `"MERCES_REPORT_V1" ‖ domain ‖ series_key ‖ period_u32 ‖ prior_income_commitment_32 ‖ income_commitment_32 ‖ tier_u8 ‖ liquidity_event_u8 )` |
| FX fallback rate (attestor) | `"MERCES_FX_V1" ‖ domain ‖ series_key ‖ period_u32 ‖ fx_rate_wad_u64 )` |
| Favourable amendment (attestor) | `"MERCES_AMEND_V1" ‖ domain ‖ series_key ‖ amendment_nonce_u64 ‖ new_terms_commitment_32 ‖ new_cap_multiple_wad_u64 )` |
| Hardship pause approval (attestor) | `"MERCES_PAUSE_V1" ‖ domain ‖ series_key ‖ pause_nonce_u64 ‖ pause_end_u64 )` (the nonce identifies one request; withdrawing a request advances it) |
| Extinguishment (two distinct attestors) | `"MERCES_EXTINGUISH_V1" ‖ domain ‖ series_key ‖ extinguish_nonce_u64 )` |
| Tier 3 true-up (attestor) | `"MERCES_TRUEUP_V1" ‖ domain ‖ series_key ‖ trueup_nonce_u64 ‖ year_u16 ‖ adjustment_i64 ‖ attestation_ts_u64 )` |

Nonces are per-series counters stored in the ledger and incremented on use, so no signature replays (every attestor message carries one; reports are unique per `(series, period)` and bind the prior commitment, so a report attestation cannot be reused for a different proof).
Tier 4 (self-attestation) uses the issuer's native transaction signature (Solana signer / EVM `msg.sender`) and is accepted only while the protocol flag `tier4_enabled` is true (default false).

**Key revocation is forward-only.** `revoke_attestor` / `revoke_verifier_key` record `revoked_at`. A revoked key still validates a report attestation for a period with `period_end(period) ≤ revoked_at` until `revoked_at + (report_due_days + grace_days) × DAY`, so no in-flight quarter is orphaned. The registry refuses to revoke the last active key of a kind unless a replacement is registered in the same transaction. (Charter: no admin action may manufacture lateness.)

### 1.5 Commitments (off-chain and in-circuit)

- **Income scale.** `theta` and `income_ytd` are amounts in the *income currency* expressed with exactly `stablecoin_decimals` fractional digits (6 for USDC/USDG) — not ISO minor units. `fx_avg_wad` is the unit-less WAD ratio "stablecoin units per one income-currency unit" (1 for stablecoin income), so `payment_usd = floor(payment × fx_avg_wad / WAD)` is directly in stablecoin base units. The Stage 2 verifier and attestors attest `income_commitment` over this representation (INTERFACES.md).
- `terms_commitment = Poseidon(5)(theta, r_wad, currency_code, indexing_rule, terms_salt)`
  - `theta`: annual threshold at income scale (`< 2^64`)
  - `r_wad`: rate per unit, WAD (`< 2^64`); at series creation `r_wad × units_offered ≤ WAD` is enforced for tier-1 series (plaintext known) and is a documented obligation of the Stage 2 term builder for others
  - `currency_code`: ISO-4217 numeric code (`840` = USD); `indexing_rule`: `u32` opaque code (0 = none, 1 = CPI-indexed yearly)
  - `terms_salt`: random field element
- `income_commitment = Poseidon(2)(income_ytd, income_salt)`; `income_ytd` at income scale. **High-water mark rule:** the attested `income_ytd` for period `q` is `max(real YTD through q, income_ytd attested for q−1 in the same year)`; verifiers and attestors enforce it so a report always exists even when a source's YTD figure falls (refunds, royalty adjustments) — such a quarter simply pays zero.
- `ZERO_INCOME_COMMITMENT = Poseidon(2)(0, 0)` is the prior commitment at the start of every reporting year.
- Tier-1 (router) income is public: for tier-1 reports `income_commitment` must equal `Poseidon(2)(router.ytd_at_end[period], 0)` (§6.5), checked on-chain (Solana `sol_poseidon` syscall, EVM Poseidon(2) contract generated from circomlibjs).

### 1.6 Parameters, bounds and defaults

Every number below is a **parameter** held in the registry's `ProtocolConfig` (editable by the protocol admin for *future* series only) and copied into each series at creation, where it becomes immutable. Bounds are enforced at series creation.

| Parameter | Default | Bounds | Notes |
| --- | --- | --- | --- |
| `cap_multiple_wad` (m) | `2.5e18` | `[2.0e18, 3.0e18]` | may only decrease via amendment |
| `hurdle_rate_wad` (h) | `0.08e18` | `[0, 0.25e18]` | |
| `payout_multiple_k` | `5` | `[1, 20]` | |
| `lockup_seconds` | `47_336_400` (18 months) | `[0, 157_680_000]` (5 y) | |
| `wallet_cap_bps` | `1000` | `[100, 10000]` | |
| `auction_fee_bps` | `100` | `[0, 1000]` | fixed per series for life |
| `payout_fee_bps` | `500` | `[0, 2000]` | fixed per series for life |
| `window_fee_bps` | `100` | `[0, 1000]` | fee on cleared window bids (assumption) |
| `non_reveal_charge_bps` | `100` | `[0, 1000]` | H1 for Kunal |
| `commit_duration` | `7 d` | `[1 h, 30 d]` | H7 proposed default |
| `reveal_duration` | `2 d` | `[1 h, 7 d]` | H7 proposed default |
| `window_commit_duration` | `3 d` | `[1 h, 14 d]` | H7 proposed default |
| `window_reveal_duration` | `1 d` | `[1 h, 7 d]` | H7 proposed default |
| `report_due_days` | `30` | fixed by brief | |
| `grace_days` | `15` | fixed by brief | |
| `formal_notice_days` | `90` | fixed by brief | counted from the deadline |
| `trueup_days` | `60` | fixed by brief | |
| `tail_seconds` | `31_536_000` (12 months) | fixed by brief | |
| `fx_min_coverage_bps` | `8000` | `[5000, 10000]` | |
| `fx_max_staleness_seconds` | `3600` | `[60, 86400]` | age of the Pyth update at snapshot time; FX feeds publish only in market hours, so keepers snapshot inside them |
| `fx_max_conf_bps` | `100` | `[1, 1000]` | `conf / price ≤ 1%` |
| `fx_deviation_band_bps` | `200` | `[10, 5000]` | H2 proposed default (2%), used only when a cross-check feed is configured |
| `max_pause_seconds` | `31_536_000` (365 d) | `[2_592_000, 63_072_000]` | one approval |
| `max_cumulative_pause_seconds` | `63_072_000` (730 d) | `[max_pause_seconds, 157_680_000]` | per series lifetime |
| `max_pauses` | `16` | fixed | bounded pause history |
| `max_release_tranches` | `24` | fixed | |
| `max_bids_per_auction` | `4096` (EVM), unbounded by PDA count (Solana) | documented | settlement is paged |

Protocol flags (registry, admin-settable): `new_raises_paused` (default false), `windows_enabled` (default **false**, ships closed), `tier4_enabled` (default **false**), `early_draw_approver` (default **unset**).

Series creation additionally requires `floor(units_offered × wallet_cap_bps / 10000) ≥ 1` (otherwise no bid could ever be valid).

### 1.7 Status machine (C8 §7)

`SeriesStatus ∈ { OnTime=0, InGrace=1, Late=2, Paused=3, Retired=4, Redeemed=5, Extinguished=6 }`.
Raise lifecycle (separate field): `RaiseState ∈ { Draft=0, Open=1, Reveal=2, Settling=3, Settled=4, Failed=5, Cancelled=6 }`.

`OnTime/InGrace/Late/Paused` are **derived** from time and the ledger by `derive_status(now)` (§6.4); the income-module write paths (`submit_report`, `pay`, `pay_trueup`, `submit_trueup`, `route`, `claim_release`, `crank_status`, `approve_pause`, `end_pause`, `open_window`, `redeem`, `extinguish`) call `sync_status(now)`, which recomputes, stores and emits `StatusChanged` if changed; other preconditions read the derived status without storing it; holder claims read the stored status; a permissionless `crank_status` exists so indexers see timely transitions. Treasury release checks use the derived value, never the stored one. `Retired/Redeemed/Extinguished` are terminal and stored.

---

## 2. Roles and access control

| Role | Where held | Powers (exhaustive) |
| --- | --- | --- |
| Protocol admin | registry `ProtocolConfig.admin` (multisig behind a timelock on mainnet; a keypair on devnet/testnet) | set `allowlist_manager`, register/revoke attestor keys and report-verifier keys, set `fee_collector`, set `new_raises_paused`, set `windows_enabled`, set `tier4_enabled`, set `early_draw_approver`, edit default parameters (future series only), configure FX pairs (feed ids, cross-check feeds), transfer admin |
| Allowlist manager | registry | add / remove wallets from the allowlist |
| Attestor | registry key set | sign the messages in §1.4 |
| Report-verifier key | registry key set | sign tier 2 report attestations |
| Issuer | series | create series, set contract hash, open raise, cancel before first bid, claim releases, pause/resume own releases, request early draw, report, pay, request pause, end pause early, stop/resume own issuance, redeem, amend terms (with attestor) |
| Keeper (anyone) | — | commit tally pages, finalize, claim-for (push refunds/mints to their owners), crank status, snapshot FX, burn retired units, close exhausted accounts |
| Upgrade authority (money code only) | Solana: `merces_protocol` upgrade authority = multisig/timelock. EVM: `TimelockController` owns the UUPS proxies and T-REX implementation authority | upgrade after delay; cannot touch registry |

Hard limits (tests required): no role can move treasury or vault funds except through the payment, release, refund, claim and redemption paths defined here; no role can change a live series' terms except `amend_terms`; no role can block `redeem`, `claim`, or `claim_release` (other than Late status / issuer's own pause, both defined by the brief).

---

## 3. Registry (D1 + D11)

### 3.1 State

```
ProtocolConfig {
  admin, pending_admin, allowlist_manager, fee_collector,
  domain: bytes32, chain_id: u64,
  new_raises_paused: bool, windows_enabled: bool, tier4_enabled: bool,
  early_draw_approver: wallet|0,
  defaults: Parameters (all of §1.6),
  protocol_program (Solana) / protocol_contracts (EVM): fixed at `init_protocol`, **no setter**; the only callers of the narrow write interface (§3.3),
  series_count: u64
}
Issuer { wallet, active: bool, issuance_stopped: bool, series_count: u32 }
AllowlistEntry { wallet, allowed: bool, updated_at }
AttestorKey { addr20, active: bool }    VerifierKey { addr20, active: bool }
FxPairConfig { pair_id: bytes32 = keccak256(feed_id ‖ inverted_u8), feed_id: bytes32, inverted: bool, crosscheck: address|0, crosscheck_effective_period: u32, enabled: bool }
  // feed_id and inverted are write-once (the pair id commits to them); `enabled = false` only stops new series from
  // referencing the pair — snapshots stay permissionless; `crosscheck` is set by `set_fx_crosscheck`: from 0 with nothing in force → effective now;
  // otherwise effective from `period_of(now) + 1` while the previous feed (`prev_crosscheck`) keeps applying to the running period.
AttestorKey / VerifierKey also carry `revoked_at: u64` (0 = active), see §1.4.

Series {
  // identity
  series_id: u64, issuer, mode: SealedBid=0 | Curve=1,
  stablecoin: mint/token address, stablecoin_decimals: u8, (Solana) stablecoin_program: Legacy|Token2022,
  unit_mint / unit_token: address (set when the raise opens / curve activates),
  // charter terms (immutable once RaiseState != Draft)
  units_offered: u64, reserve_price: u64, min_raise: u64,
  cap_multiple_wad: u64, hurdle_rate_wad: u64, payout_multiple_k: u16, lockup_seconds: u64, wallet_cap_bps: u16,
  auction_fee_bps: u16, payout_fee_bps: u16, window_fee_bps: u16, non_reveal_charge_bps: u16,
  commit_duration: u64, reveal_duration: u64, window_commit_duration: u64, window_reveal_duration: u64,
  release_schedule: [{ at_offset_seconds: u64, bps: u16 }] (1..24, bps sum 10000, offsets non-decreasing),
  contract_hash: bytes32 (zero until set; required non-zero to open),
  tier_flags: u8 (bit0 tier1 split, bit1 tier2 zkTLS, bit2 tier3 attestor, bit3 tier4 self),
  fx_pair_id: bytes32 (zero = stablecoin income, fx = 1),
  issuer_accepts_public_price: bool (must be true for Curve mode),
  // amendable (only via amend_terms)
  terms_commitment: bytes32, amendment_nonce: u64,
  // raise results (written by the protocol via §3.3)
  raise_state: RaiseState, opened_at: u64, settlement_ts: u64, units_sold: u64, clearing_price: u64 (P0), mint_finalized: bool,
  terminal_status: u8 (0 none, else Retired/Redeemed/Extinguished mirror),
  // Solana only: protocol escrow token accounts for the unit mint, written at open_raise (read by the hook)
  auction_escrow_ata, window_escrow_ata
}
```

### 3.2 Functions

- `init_protocol(admin, allowlist_manager, fee_collector, chain_id, protocol_program|protocol_contracts, defaults)` once. On Solana the write interface requires the signer `registry_authority = create_program_address([b"registry_authority", bump], protocol_program)`.
- Admin: `set_allowlist_manager`, `set_fee_collector`, `set_flags(new_raises_paused, windows_enabled, tier4_enabled)`, `set_early_draw_approver`, `set_defaults(Parameters)` (bounds-checked), `register_attestor(addr20)`, `revoke_attestor`, `register_verifier_key`, `revoke_verifier_key`, `set_fx_pair(...)`, `register_issuer(wallet)`, `deactivate_issuer(wallet)` (blocks *new* series only), `transfer_admin` / `accept_admin` (two-step).
- Allowlist manager: `set_allowed(wallet, bool)`.
- Issuer: `create_series(params, release_schedule, terms_commitment, tier_flags, fx_pair_id, mode, issuer_accepts_public_price)` → Draft; requires `issuer.active && !issuer.issuance_stopped`, issuer wallet allowlisted, bounds OK, `min_raise ≤ reserve_price × units_offered`, `units_offered ≥ 1`, `reserve_price ≥ 1`. `set_contract_hash(series, hash)` (Draft only, non-zero). `stop_issuance()` / `resume_issuance()`. `amend_terms(series, new_terms_commitment, new_cap_multiple_wad, attestor_sig)`: issuer is signer; attestor signature over the §1.4 message with the current nonce; `new_cap_multiple_wad ≤ current` and within bounds; nonce++; emits `TermsAmended`. Allowed while `terminal_status == 0` (never after Retired/Redeemed/Extinguished: the tail cap is fixed at redemption). The protocol reads `cap_multiple_wad` live (§6.3 *effective cap*), so a lowered cap applies to the next distribution with no underflow; if the new cap is already met, the series retires at the next `retire_if_capped` crank or payment. Amended θ/r apply to marginal income from the next accepted report (no retroactive credit for quarters already paid — `ASSUMPTIONS.md` A26).
- Protocol write interface (§3.3): `mark_raise_opened(series, unit_mint, opened_at, auction_escrow_ata, window_escrow_ata)`, `mark_raise_result(series, state ∈ {Settled, Failed, Cancelled}, settlement_ts, units_sold, clearing_price)` (exact values, written once), `mark_mint_finalized(series)`, `mark_terminal(series, status)`. Callable only by the protocol program's signer PDA (Solana) or the registered protocol contracts (EVM).
- Views: everything above; `is_allowed(wallet)`, `is_attestor(addr20)`, `is_verifier_key(addr20)`, `is_transfer_locked(series, now) = raise_state != Settled || now < settlement_ts + lockup_seconds`.

### 3.3 Immutability

After `mark_raise_opened`, every field in the "charter terms" block is frozen: no function writes them. `terms_commitment` and `cap_multiple_wad` change only through `amend_terms` (cap only downwards). Tests assert this by diffing the serialized series before/after every other instruction (F2).

---

## 4. Unit token (D2)

### 4.1 Solana

- One Token-2022 mint per sealed-bid series, created by `merces_protocol::open_raise`: `decimals = 0`; extensions `TransferHook { program_id = merces_hook }`, `PermanentDelegate { delegate = vault_authority PDA of merces_protocol }`, `MetadataPointer` → the mint itself, `TokenMetadata { name = "Merces HEU <series_id>", symbol = "HEU", uri = metadata_uri from create args }`. `mint_authority = auction_authority PDA` (merces_protocol), `freeze_authority = None`. `DefaultAccountState` is **not** used (recorded assumption: the hook plus allowlist checks at mint are sufficient; adding it later is additive).
- `open_raise` also CPIs `merces_hook::initialize_extra_account_meta_list(mint)` so Token-2022 can resolve the hook's extra accounts: `[registry ProtocolConfig, Series (by seed from mint), AllowlistEntry(source_owner), AllowlistEntry(destination_owner)]`, expressed with `spl_tlv_account_resolution` seeds (PDA seeds derived from the source/destination token-account owners read from the transfer accounts).
- Mint authority is revoked (`set_authority(None)`) inside the `process_bid` that makes `bids_processed == bid_count` (§5.2), in the same instruction that emits `RaiseMintFinalized`.
- Protocol escrow token accounts for the unit mint, created in `open_raise` and recorded in the registry `Series`: the **auction escrow** (ATA of `auction_escrow_authority` PDA) that holds minted-but-undelivered units, and the **window escrow** (ATA of `window_escrow_authority` PDA). A small `EscrowArm` PDA of `merces_protocol` (seeds `[b"escrow_arm", mint]`, fields `armed_owner, armed_units`) is written by `commit_ask` immediately before its transfer CPI and cleared after it.
- Extra account metas for the hook (per mint, `spl_tlv_account_resolution`): three **literal** accounts fixed for the mint's lifetime and computed once in `initialize_extra_account_meta_list`: `[ProtocolConfig, Series (the series PDA exists before the mint), EscrowArm = PDA(merces_protocol, [b"escrow_arm", mint])]` (the mint is an account key of `Execute`, not account data, so a seed-derived entry cannot reference it). The hook validates the list with `ExtraAccountMetaList::check_account_infos`, requires `series.unit_mint == mint` and checks `EscrowArm` by address and owner.
- Hook rule (`merces_hook::execute(amount)`), evaluated on **every** transfer (mint and burn do not invoke hooks):
  1. Require the "transferring" flag set by Token-2022 on both token accounts (standard hook safety).
  2. If `series.mode == Curve` → reject (curve mints are not created with this hook anyway).
  3. If the **source** token account is `series.auction_escrow_ata` or `series.window_escrow_ata` → allow (deliveries, fills and returns; the protocol has already applied allowlist and cap rules).
  4. Else if the **destination** is `series.window_escrow_ata` → allow only if `EscrowArm.armed_owner == source_owner && EscrowArm.armed_units == amount` (an armed `commit_ask`), else reject `UnarmedEscrowDeposit`.
  5. Otherwise (wallet-to-wallet, or into the auction escrow): **reject** (`DirectTransferForbidden`). Lockup, allowlist and cap are therefore enforced by construction: only the protocol moves units, and it checks lockup, report acceptance, allowlist and cap itself.
  - Burns via the permanent delegate (vault) never invoke the hook; redemption, retirement and extinguishment burns always work.
- Wallet cap check used by the window: `destination_balance_after ≤ floor(units_outstanding × wallet_cap_bps / 10000)` where `units_outstanding = mint.supply`.

### 4.2 EVM

- T-REX v4 (`@tokenysolutions/t-rex` 4.1.6, GPL-3.0) deployed by the Merces deploy script behind T-REX's own proxies/implementation authority (owner = timelock). One `Token` per sealed-bid series (`decimals = 0`), one shared `IdentityRegistry` (+ storage), `TrustedIssuersRegistry`, `ClaimTopicsRegistry` with **no required claim topics**, one `ModularCompliance` per token with the `MercesComplianceModule` bound.
- **Allowlist vs identity.** `MercesRegistry.isAllowed(w)` is a Merces-maintained flag (`AllowlistEntry.allowed`) on both chains. On EVM, `set_allowed(w, true)` additionally registers `w` once in the shared T-REX `IdentityRegistry` with an ONCHAINID `Identity` from the vendored `IdFactory` (country code 0); **identities are never deleted** (`set_allowed(w, false)` only clears the flag), so T-REX `isVerified(w)` stays true for every wallet that was ever allowlisted and protocol-initiated unit movements (mint, delivery, fill, escrow return) never fail on verification. The flag is checked only where new exposure is created: `commit_bid`, window `commit_bid`, `register_holder`, and the buyer side of `process_order`.
- `MercesComplianceModule.moduleCheck(from, to, value, compliance)` returns true only when: `from == address(0)` (mint — minted to the auction contract only), `to == address(0)` (burn), `from` is the series' `MercesAuction` or `MercesWindow` escrow (deliveries, fills, returns), or `to == MercesWindow` **and** `MercesWindow.armedDeposit(from) == value && value > 0` (a transient value set by `commit_ask` immediately before its `transferFrom` and cleared after it). Everything else is false → direct transfers revert `DirectTransferForbidden`. The module keeps its own per-compliance state (`auction`, `window`) set at token creation.
- **T-REX governance (normative).** Per-series `TokenProxy` + `ModularComplianceProxy` are created by `MercesAuction.open_raise` through `MercesTokenFactory`, which: binds `MercesComplianceModule`; adds exactly `MercesAuction`, `MercesVault`, `MercesWindow` as token agents (mint / burn / escrow movements); calls `unpause()` (T-REX tokens initialise paused); and transfers ownership of both proxies to `MercesTokenGovernor`, a minimal non-upgradeable contract that exposes **no** `addAgent`, `removeAgent`, `setCompliance`, `setIdentityRegistry`, `addModule`, `removeModule`, `pause`, `freeze`, `forcedTransfer` or `recoveryAddress` path (its only function is to forward T-REX implementation-authority version changes from the timelock, which is the money-code upgrade path). The shared `IdentityRegistry` stack is owned by the same governor; `MercesRegistry` is its only agent. `MercesAuction` and `MercesWindow` are registered identities at deployment (they are the only contracts that hold units). The T-REX `TREXImplementationAuthority` is owned by the `TimelockController`.
- Charter fields never live in the token.

---

## 5. Raise path

### 5.1 Auction state (D3)

```
Auction (per series) {
  state (mirrors RaiseState), opened_at, commit_end = opened_at + commit_duration, reveal_end = commit_end + reveal_duration,
  escrow_total: u64, bid_count: u32, revealed_count: u32, valid_count: u32,
  // settlement proposal and tally (one round at a time)
  tally_round: u32, round_rejected: bool,
  clearing_price: u64, q_above_claim: u64, q_at_claim: u64, r_claim: u64,
  q_above: u64, q_at: u64, alloc_sum: u64, min_valid_price: u64, tallied_count: u32,
  // results (exact, written once at finalize)
  units_sold: u64, proceeds: u64, settlement_ts: u64,
  // processing
  bids_processed: u32, units_minted: u64, mint_finalized: bool
}
Bid (per series × bidder; one bid per wallet) {
  bidder, commitment: bytes32, escrow: u64, reveal_index: u32,
  revealed: bool, valid: bool, price: u64, quantity: u64,
  tallied_round: u32, processed: bool, allocation: u64,
  pending_units: u64, pending_refund: u64, delivered: bool
}
```

### 5.2 Functions

- `open_raise(series)` — issuer; requires `raise_state == Draft`, `contract_hash != 0`, issuer allowlisted, `!new_raises_paused`, `series.mode == SealedBid`. Creates the unit mint/token and the protocol escrow accounts (§4), sets `opened_at = now`, state `Open`; registry `mark_raise_opened`. Emits `RaiseOpened`.
- `cancel_raise(series)` — issuer; requires `Open` and `bid_count == 0`. State `Cancelled`; the unit mint authority is revoked (no unit can ever exist); registry updated. Emits `RaiseCancelled`, `MintAuthorityRevoked`.
- `commit_bid(series, commitment, escrow)` — bidder allowlisted (`isAllowed`), `now < commit_end`, no existing bid for this wallet, `escrow > 0`. Pulls `escrow` stablecoin into the auction stablecoin escrow. Emits `BidCommitted(series, bidder, escrow)`.
- `reveal_bid(series, price, quantity, salt)` — `commit_end ≤ now < reveal_end`, bid exists and not revealed; `keccak256(price ‖ quantity ‖ salt ‖ bidder) == commitment`. Sets `revealed = true`, `reveal_index = revealed_count++`. Validity: `valid = price ≥ reserve_price && quantity ≥ 1 && quantity ≤ wallet_cap_units_at_auction && escrow ≥ required_escrow(price, quantity)` where `wallet_cap_units_at_auction = floor(units_offered × wallet_cap_bps / 10000)` (≥ 1 by the creation rule) and `required_escrow(p, q) = p×q + floor(p×q × auction_fee_bps / 10000)`. `valid_count++` when valid. Invalid reveals are refunded in full at processing. A reveal never reverts on a validity failure; it records `valid = false`. Emits `BidRevealed(series, bidder, price, quantity, valid)`.
- `begin_settlement(series, clearing_price, q_above_claim, q_at_claim)` — anyone, `now ≥ reveal_end`, state `Open` or `Settling`. Allowed only when no round is in progress: `tally_round == 0 || round_rejected`. Starts round `tally_round + 1`: stores the claims, `r_claim = min(units_offered − q_above_claim, q_at_claim)` (saturating; `0` if `q_above_claim ≥ units_offered`), resets `q_above = q_at = alloc_sum = tallied_count = 0`, `min_valid_price = u64::MAX`, `round_rejected = false`. State `Settling`. Emits `SettlementProposed(series, clearing_price, round)`. While a round is incomplete, `begin_settlement` reverts `TallyInProgress` — no caller can reset a tally that honest keepers are completing.
- `tally_bids(series, page)` — anyone; for each **revealed** bid in the page not yet tallied in this round: if `valid`: `min_valid_price = min(min_valid_price, price)`; `if price > clearing_price: q_above += quantity; elif price == clearing_price: q_at += quantity; alloc_sum += floor(r_claim × quantity / q_at_claim)` (skipped when `q_at_claim == 0`); mark tallied; `tallied_count++`. Pages: Solana ≤ 24 Bid PDAs as remaining accounts; EVM `tally(fromIndex, toIndex)` with ≤ 200 bids. Unrevealed bids are not tallied (they are counted by `bid_count − revealed_count`).
- `finalize_settlement(series)` — anyone; requires state `Settling` and `tallied_count == revealed_count`. Never reverts on a wrong proposal: an invalid proposal sets `round_rejected = true`, emits `SettlementRejected(series, round, clearing_price, reason)` and leaves the tally in place so a new proposal can be made. Let `N = units_offered`, `p* = clearing_price`.
  1. **No valid bids.** If `valid_count == 0`: state `Failed`, `clearing_price = 0`, `units_sold = proceeds = 0`; registry `mark_raise_result(Failed, …)`; emit `RaiseFailed(series, 0, 0, min_raise)`. (Every bid is then refunded in full under the `Failed` branch; no fee, no non-reveal charge.)
  2. **Claims must match the tally.** `q_above == q_above_claim && q_at == q_at_claim`, else rejected (`ClaimMismatch`).
  3. **Price validity.** Either (a) oversubscribed: `q_at > 0 && q_above < N && q_above + q_at ≥ N`, or (b) undersubscribed: `q_above + q_at < N && min_valid_price == p*` (then `q_at > 0` automatically). Else rejected (`InvalidClearingPrice`). (Proof of uniqueness: `ARCHITECTURE.md` §5.1.)
  4. **Exact results.** `R = r_claim` (`= min(N − q_above, q_at)`); marginal bids receive `floor(R × q_i / q_at)` and their sum is `alloc_sum` from the tally, so `units_sold = q_above + alloc_sum` and `proceeds = p* × units_sold` are exact in one pass.
  5. **Min raise.** If `units_sold == 0` (marginal rounding; only reachable with `min_raise == 0`) or `proceeds < min_raise`: state `Failed`, registry `mark_raise_result(Failed, …)`, emit `RaiseFailed(series, p*, proceeds, min_raise)`. Otherwise state `Settled`, `settlement_ts = now`, registry `mark_raise_result(Settled, now, units_sold, p*)` (exact, written once), emit `RaiseSettled(series, p*, units_sold, proceeds, settlement_ts)`.
- `process_bid(series, bid)` — anyone, once per bid, after `Settled` or `Failed`. **Never depends on the bidder being able to receive anything**: it only moves funds to protocol-owned accounts and records what the bidder is owed.
  - `Failed`: `pending_refund = escrow`, `alloc = 0`.
  - `Settled`, revealed & valid & `price > p*`: `alloc = quantity`. `price == p*`: `alloc = floor(R × quantity / q_at)`. `price < p*`, or revealed & invalid: `alloc = 0`, `pending_refund = escrow`.
  - `Settled`, **unrevealed**: `alloc = 0`, `charge = floor(escrow × non_reveal_charge_bps / 10000)` → fee collector now, `pending_refund = escrow − charge`. Emits `NonRevealCharged`.
  - For `alloc > 0`: `cost = p* × alloc`; `fee = floor(cost × auction_fee_bps / 10000)`; `pending_refund = escrow − cost − fee` (non-negative by validity); transfer `cost` → treasury (`deposit_proceeds`), `fee` → fee collector; **mint `alloc` units to the auction escrow** (Solana: `auction_escrow_ata`; EVM: `token.mint(address(auction), alloc)`); `pending_units = alloc`; `units_minted += alloc`; `register_holder(bidder)` (snapshot of all accumulators, which are still zero — §6.3). Emits `UnitsAllocated(series, bidder, alloc, cost, fee, refund = pending_refund)`.
  - `processed = true`; `bids_processed++`. When `bids_processed == bid_count` (for a `Failed` raise too — it finalises an *empty* mint, emitting `RaiseMintFinalized(series, 0, 0)`; a failed raise with no bid at all is finalised by `finalize_settlement` itself) and, for `Settled`, `units_minted == units_sold` (invariant): set `mint_finalized = true`, revoke the mint authority (Solana `set_authority(None)`; EVM: the factory never grants a second minter and the auction's `mint` path is closed by the flag), registry `mark_mint_finalized`, store `ledger.units_outstanding = units_sold`, emit `RaiseMintFinalized(series, units_sold, proceeds)` and `MintAuthorityRevoked(series)`.
- `deliver_bid(series, bid)` — anyone (or the bidder), after `processed`, not yet `delivered`: transfers `pending_refund` stablecoin to the bidder and moves `pending_units` from the auction escrow to the bidder's token account (hook rule 3 / compliance `from == escrow`), regardless of the bidder's *current* allowlist flag (validity was fixed at reveal; a removed wallet keeps its units and can still claim and sell in a window, C10). Sets `delivered = true`, emits `BidDelivered(series, bidder, units, refund)`. A delivery that fails for recipient-side reasons (frozen stablecoin account, missing token account) can be retried forever; it never affects counters, finalization or treasury releases. Until delivery, the units count toward the bidder's accrual weight (§6.3 `accrual_units`).
- Maximum bids: Solana unlimited in count (each bid is a PDA; tally pages of 24; finalize O(1)); EVM `max_bids_per_auction = 4096` (array; tally pages of ≤ 200). Document CU/gas per page in `AUDIT_NOTES.md`.

### 5.3 Treasury (D4)

```
Treasury (per series) { proceeds: u64, released_total: u64, issuer_paused_releases: bool, tranche_count: u8, extinguished_at: u64 }
```
- `deposit_proceeds` is internal (called from `process_bid`). `proceeds` is exact from `finalize_settlement`; deposits must sum to it when `mint_finalized`.
- `tranche_amount(i) = floor(proceeds × bps_i / 10000)` for `i < last`; last tranche = `proceeds − Σ others`. `vested(now) = Σ_{i : settlement_ts + at_offset_i ≤ now} tranche_amount(i)`; `vested ≤ proceeds` always.
- `claim_release(series)` — issuer; requires `mint_finalized`, `!issuer_paused_releases`, `derive_status(now) != Late`, and `!is_late_underlying(now)` (§6.4: a hardship pause stops the clock but does not lift a release block already in force). `cap = extinguished_at == 0 ? vested(now) : vested(extinguished_at)`; `amount = cap > released_total ? cap − released_total : 0`; require `amount > 0` (`NothingVested`); `released_total += amount`; transfer to the issuer. Emits `ReleaseClaimed(series, amount, released_total)`. Retired and Redeemed series keep releasing on schedule (the raise is the issuer's capital); after extinguishment only what had vested by `extinguished_at` remains claimable by the issuer's wallet (the estate).
- `set_release_pause(series, bool)` — issuer only. Emits `ReleasePauseSet`.
- `request_early_draw(series, amount)` — issuer; requires `mint_finalized`, `early_draw_approver != 0`; Solana: the approver co-signs; EVM: `IEarlyDrawApprover(approver).approveEarlyDraw(seriesId, amount, nonce) == true`; `released_total + amount ≤ proceeds`, `extinguished_at == 0`; transfers; `released_total += amount` (early draws are consumed by later vesting). Emits `EarlyDrawExecuted`. Off by default because the approver is unset.
- On `Extinguished` (§6.9): `unreleased = proceeds − max(vested(now), released_total)` moves to the vault (early draws may have released more than vested); `extinguished_at = now`.

Stablecoin handling on Solana: every transfer uses `transfer_checked` with the mint's own token program; for Token-2022 mints the program resolves transfer-hook extra accounts via `spl_token_2022::onchain::invoke_transfer_checked` with the remaining accounts supplied by the caller, and **asserts** that if a `TransferFeeConfig` extension exists both `transfer_fee_basis_points == 0` and `maximum_fee == 0` for the current and the newer epoch config, else `TransferFeeNotZero`. `stablecoin_decimals` is read from the mint at series creation.

---

## 6. Repayment path

### 6.1 Ledger state (D6/D7/D8 shared, per series)

```
Ledger {
  status: SeriesStatus, first_period: u32, last_accepted_period: u32|none, last_paid_period: u32|none,
  open_due_period: u32|none, open_due_amount: u64,
  router_credit: u64,
  trueup_nonce: u64, trueup_due: u64, trueup_attested_at: u64, trueup_year: u16|none, last_trueup_year: u16|none,
  // pauses (bounded history so countdowns can exclude paused time exactly)
  pause_nonce: u64, pause_requested: bool, pause_requested_at: u64,
  pauses: [{ start: u64, end: u64 }; max_pauses]  (end = pause_end as approved, or the early end), pause_count: u8, paused_total: u64,
  formal_notice_emitted_for: u32|none, trueup_notice_emitted: bool,
  // supply and accumulators
  units_outstanding: u64 (= units_sold at mint finalization; reduced only by burns),
  paid_per_unit_wad: u128, net_acc_wad: u128, carry_wad: u128,
  year_gross: [{ year: u16, gross_wad: u128 }; 4]  (tagged ring, §6.3),
  fee_collected: u64, gross_received: u64, refunded_to_issuer: u64,
  // commitments
  last_income_commitment: bytes32, last_income_period: u32|none,
  // redemption and tail
  redemption_ts: u64, redemption_price: u64, units_at_redemption: u64, tail_cap_per_unit: u64,
  tail_paid_per_unit_wad: u128, tail_acc_wad: u128, tail_carry_wad: u128, tail_exhausted: bool,
  // extinguishment
  extinguished_at: u64, final_acc_wad: u128, final_carry_wad: u128, final_units: u64, extinguish_nonce: u64
}
Holder (per series × wallet) { registered: bool, last_net_acc_wad: u128, pending: u64, redeemed_units: u64, last_tail_acc_wad: u128, last_final_acc_wad: u128 }
Report (per series × period) { accepted_at, payment_usd, fx_avg_wad, fx_fallback: bool, tier, liquidity_event, income_commitment, prior_income_commitment, due, accrual_paid: u64, paid_at }
```

`units_outstanding` is **stored** at mint finalization (`= units_sold`) and decremented only by burns (retirement, redemption, extinguishment); it is the public input of every non-tail proof. `cap_per_unit` is **not stored**: `cap_per_unit() = floor(registry.cap_multiple_wad × P0 / WAD)` is read at every use so favourable amendments apply immediately. First report period `first_period = period_of(settlement_ts)`.

**Accrual weight.** `accrual_units(w) = unit_balance(w) + pending auction units (undelivered, §5.2) + ask-escrow units (open or unprocessed window ask, §7)`. Every `settle_holder` uses this weight, so units sitting in a protocol escrow never strand a distribution.

**Mint-finalization gate.** `submit_report`, `pay`, `pay_trueup`, `submit_trueup`, `route`/`sweep`, `redeem`, `extinguish`, `open_window` and every `vault_receive_*` revert `MintNotFinalized` until `RaiseMintFinalized`. Tier-1 income that arrives before then stays in the router's receiving account and is routed afterwards. Countdowns (§6.4) are unaffected: a period's clock starts at its `period_end` as usual, so finalization is in the keeper's interest.

### 6.2 ProofOfIncome verifier (D6)

`submit_report(series, period, payment_usd, fx_avg_wad, fx_fallback_sig|none, prior_income_commitment, income_commitment, tier, liquidity_event, proof, attestation_sig)`:

1. Caller is the issuer (Solana signer / EVM `msg.sender`). Keepers may **not** submit reports (reports are the issuer's act; C11 §3). `payment_usd ≤ 2^64 − 1`, `fx_avg_wad ≤ 2^64 − 1`.
2. Preconditions, in every status: `mint_finalized`; `status ∉ {Retired, Extinguished}` (`TerminalStatus`); `period == next expected` where next = `first_period` if none accepted else `last_accepted_period + 1`; `now ≥ period_end(period)`; `open_due_amount == 0`; `Report[period]` not yet stored. If `status == Redeemed` additionally: `period_start(period) ≤ redemption_ts + tail_seconds` (`TailEnded`); if `liquidity_event` then `tail_cap_per_unit > 0 && !tail_exhausted` (`NoTailDue`). There are no deadlines after redemption; non-liquidity tail-period reports are accepted with `due = 0` and only advance the commitment chain.
3. `tier ∈ {1, 2, 3, 4}` must be enabled in `series.tier_flags`; tier 4 additionally requires `tier4_enabled`. **Tier 1 is only a valid report tier when `tier_flags == 0b0001`** (pure on-chain income); a series with tier 2/3/4 enabled must report with that tier so the attestation cannot be bypassed.
4. FX: if `series.fx_pair_id == 0`: `fx_avg_wad == WAD`. Else `(ok, avg) = quarter_average(pair, period)` (§6.6): if `ok` → `fx_avg_wad == avg` and no fallback signature; if `!ok` (NeedsFallback) → a valid attestor signature over the FX message for `(series, period, fx_avg_wad)` is required and `fx_fallback = true`.
5. Prior commitment: if `last_income_period == period − 1` and `year_of(last_income_period) == year_of(period)` → `prior_income_commitment` must equal `last_income_commitment`. Else if this is the **first report of the series** and `quarter_index(period) != 0` → the supplied `prior_income_commitment` is accepted as given (it commits to the issuer's YTD income at `period_start(first_period)`, attested together with `income_commitment` in step 7; pre-settlement income in the settlement year is therefore not owed — `ASSUMPTIONS.md` A25, Kunal). Otherwise (start of a year) → must equal `ZERO_INCOME_COMMITMENT`.
6. Groth16 verify with public inputs **in this order**: `[terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd]`, where `units_outstanding = ledger.units_outstanding` (stored), or `units_at_redemption` when `status == Redeemed`. `terms_commitment` is read from the registry.
7. Source binding: tier 2 → signature by an active (or grace-period, §1.4) verifier key over the §1.4 report message; tier 3 → by an attestor; tier 4 → none beyond the issuer's own signature; tier 1 → `income_commitment == Poseidon(2)(router.ytd_at_end[period], 0)` (§6.5; `RouterPeriodNotClosed` if the checkpoint is missing), `prior_income_commitment == Poseidon(2)(router.ytd_at_end[period − 1], 0)` or `ZERO_INCOME_COMMITMENT` at a year start, `fx_avg_wad == WAD` (router income is the stablecoin), `units_outstanding` = the stored value; any supplied attestation is ignored.
8. Effects: store `Report`; `last_accepted_period = period`; `last_income_commitment/period` updated; `credit_used = min(router_credit, payment_usd)`; `router_credit −= credit_used`; `due = payment_usd − credit_used` (0 for non-liquidity tail reports). If `due == 0` → `last_paid_period = period`, emit `ReportAccepted` + `PaymentSettled(…, 0, …)`; else `open_due_period = period`, `open_due_amount = due`. `sync_status(now)`. Emits `ReportAccepted(series, period, payment_usd, fx_avg_wad, fx_fallback, tier, liquidity_event, income_commitment, due)`.

`pay(series)` — issuer (or anyone paying on the issuer's behalf; funds come from the caller): requires `open_due_amount > 0`. `accrual = late_accrual(open_due_period, open_due_amount, now)` (§6.4; 0 while Redeemed). `total = open_due_amount + accrual` (must fit `u64`); pull `total`; if `status == Redeemed` → `vault_receive_tail(total)` (§6.8) else `vault_receive_gross(total, Payment, open_due_period)` (§6.3). `Report.accrual_paid = accrual`, `paid_at = now`; `last_paid_period = open_due_period`; clear `open_due_*`; `sync_status(now)`. Emits `PaymentSettled(series, period, gross = total, accrual, fee, accepted, refunded)`. Partial payments are not supported.

Tier 3 true-up: `submit_trueup(series, year, adjustment_i64, attestation_ts, attestor_sig)` — issuer; `tier_flags` bit2 set; message per §1.4 with `trueup_nonce` (nonce++); at most one true-up per `year` (`last_trueup_year < year`); `year < year_of(period_of(now))` and every period of `year` from `first_period` has an accepted report (vacuous for a year that ended before `first_period`); `trueup_due == 0` (pay the previous one first). `adjustment == 0` is a valid true-up (nonce and year consumed, nothing due). `adjustment > 0` → `trueup_due = adjustment`, `trueup_attested_at = attestation_ts` (no accrual for `trueup_days` of unpaused time, then accrual as for a late payment); `adjustment < 0` → `|adjustment| ≤ Σ payment_usd accepted for that year`, `router_credit += |adjustment|` (credited forward). `pay_trueup(series)` pulls `trueup_due + late_accrual_trueup(now)` into the vault (`vault_receive_gross(…, Payment, period_of(trueup_attested_at))`, so its year anchor is `deadline(period_of(trueup_attested_at))`) and clears `trueup_due`, `trueup_attested_at`, `trueup_year`; `retire()` and `extinguish` clear them too. Emits `TrueUpRecorded`, `TrueUpPaid`.

### 6.3 Payout vault accounting (D7, C6)

`vault_receive_gross(G, source ∈ {Payment, Router}, period_for_year)` with `N = units_outstanding` (`> 0` required: `NoUnitsOutstanding`):

```
cap_wad     = cap_per_unit() × WAD
cap_eff_wad = max(cap_wad, paid_per_unit_wad)              // effective cap: a lowered cap never underflows
inc_wad     = floor(G × WAD / N)
if paid_per_unit_wad + inc_wad < cap_eff_wad:
    accepted = G
else:
    remaining_wad = cap_eff_wad − paid_per_unit_wad
    accepted      = floor(remaining_wad × N / WAD)
    inc_wad       = floor(accepted × WAD / N)
    refund        = G − accepted            → issuer (same tx)
    retire()                                 // status Retired, registry.mark_terminal(Retired), clears open_due_* and trueup_due, emit SeriesRetired
paid_per_unit_wad += inc_wad
year_gross.add(settlement_year(anchor), inc_wad)     // anchor = deadline(period_for_year) for Payment (the period's due date, outside issuer control), now for Router
fee          = floor(accepted × payout_fee_bps / 10000)  → fee collector
net          = accepted − fee
num_wad      = net × WAD + carry_wad                      // carry is the exact WAD-scaled remainder, 0 ≤ carry_wad < N
delta_acc    = floor(num_wad / N)
carry_wad    = num_wad − delta_acc × N
net_acc_wad += delta_acc
gross_received += accepted; fee_collected += fee
emit PayoutDistributed(series, source, gross = G, accepted, fee, net_added = net, delta_acc_wad, paid_per_unit_wad, retired)
```
Why the WAD remainder: a base-unit carry (`net − floor(delta × N / WAD)`) double-counts the fractional part already credited to `net_acc_wad` and lets holders claim more than was paid (N = 3, three payments of 1 → claims of 4). With `carry_wad` the invariant `net_acc_wad × N ≤ Σ net × WAD` holds exactly, so `Σ claims ≤ Σ net`.

`settlement_year(ts) = floor((ts − settlement_ts) / YEAR)`. `year_gross` is a tagged 4-slot ring: slot `y % 4` is zeroed and re-tagged when its `year != y` before adding; readers treat a missing tag as 0. `retire_if_capped(series)` — anyone: if `cap_eff_wad − paid_per_unit_wad == 0` (a lowered cap already met) → `retire()`.

The `Tail` (§6.8) and `Final` (§6.9) sources use their own accumulators and WAD carries (`tail_carry_wad`, `final_carry_wad`) with the identical `accumulate(acc, carry_wad, amount, N)` step; `Final` takes no fee. All three use the same `<` boundary rule.

Holder functions (claim path is behind `IPayoutClaims` on EVM and a dedicated instruction set on Solana so a private implementation can replace it):

- `register_holder(series, wallet)` — anyone may register a wallet that is **allowlisted now**; sets `last_net_acc_wad = net_acc_wad`, `last_tail_acc_wad = tail_acc_wad`, `last_final_acc_wad = final_acc_wad` as they stand (all zero before the first distribution). Winners are registered in `process_bid`; window buyers on fill.
- `settle_holder(series, wallet)` (internal; also callable by keepers): `pending += floor((net_acc_wad − last_net_acc_wad) × accrual_units(wallet) / WAD)`; `last_net_acc_wad = net_acc_wad`. Called before any change of that wallet's accrual units (delivery is not a change; fills, returns and burns are) and inside `claim`.
- `claim(series)` — the registered holder (or anyone pushing to the holder): `settle_holder`; `amount = pending`; `pending = 0`; transfer `amount`. If `status == Retired` and `unit_balance > 0`, burn the balance (permanent delegate / agent burn), `units_outstanding −= balance`. Emits `PayoutClaimed(series, holder, amount, burned_units)`. Claims never require the holder to be *currently* allowlisted (no stranding, C10) and remain available in every terminal status for funds already in the vault.
- `burn_retired(series, holder)` — anyone, `status == Retired`, balance `> 0`: `settle_holder` then burn; the holder's `pending` stays claimable. Emits `UnitsBurned(series, holder, units, reason = Retired)`.

Invariants (tested): `Σ pending + Σ claimable ≤ vault stablecoin balance`; `paid_per_unit_wad ≤ cap_eff_wad`; `fee_collected == Σ floor(accepted × bps / 10000)` per distribution; `Σ accrual_units == units_outstanding` for non-terminal series.

### 6.4 Status derivation, deadlines and accrual

Countdowns run in **unpaused time from their own start**, so a pause stops every running clock without shifting obligations that start later.

```
paused_within(a, b) = Σ over pauses (and the open pause, clipped at min(now, pause_end)) of |[start, end] ∩ [a, b]|
unpaused(a, b)      = (b − a) − paused_within(a, b)                         // b ≥ a
is_paused(now)      = an open pause exists with start ≤ now < end
deadline_s          = report_due_days × DAY ; grace_s = (report_due_days + grace_days) × DAY ; notice_s = formal_notice_days × DAY
countdown(p, now)   = unpaused(period_end(p), now)
earliest_unpaid()   = open_due_period if open_due_amount > 0 else next expected period
trueup_overdue(now) = trueup_due > 0 && unpaused(trueup_attested_at, now) > trueup_days × DAY

derive_status(now):
  if status ∈ {Retired, Redeemed, Extinguished} → status
  if is_paused(now) → Paused
  if trueup_overdue(now) → Late
  p = earliest_unpaid(); c = countdown(p, now)
  if c ≤ deadline_s → OnTime ; elif c ≤ grace_s → InGrace ; else → Late

is_late_underlying(now) = trueup_overdue(now) || countdown(earliest_unpaid(), now) > grace_s     // ignores Paused
late_days(p, now)       = max(0, floor((countdown(p, now) − grace_s) / DAY))
late_accrual(p, amount, now) = mulDiv(mulDiv(amount, hurdle_rate_wad, WAD), late_days(p, now), 365)
late_accrual_trueup(now)     = mulDiv(mulDiv(trueup_due, hurdle_rate_wad, WAD), max(0, floor((unpaused(trueup_attested_at, now) − trueup_days × DAY) / DAY)), 365)
```
`sync_status(now)`: closes an open pause whose `end ≤ now` (nothing else to do: the pause record already holds its end); stores `derive_status`; emits `StatusChanged(series, old, new)` on change; emits `FormalNoticeDue(series, p)` once per period when `countdown(p, now) ≥ notice_s`, and `FormalNoticeDue(series, trueup)` once when `unpaused(trueup_attested_at, now) ≥ trueup_days × DAY + (notice_s − grace_s)`. `crank_status(series)` is the permissionless wrapper.

Hardship pause: `request_pause(series)` — issuer; `pause_requested = true`, `pause_requested_at = now`, `pause_nonce++` (emits `PauseRequested(series, nonce)`); `withdraw_pause_request(series)` — issuer; clears and `pause_nonce++` (invalidating any signature). `approve_pause(series, pause_end, attestor_sig)` — anyone submits the attestor signature (§1.4 with the current nonce): requires `pause_requested`, `!is_paused(now)`, `pause_end > now`, `pause_end − now ≤ max_pause_seconds`, `paused_total + (pause_end − now) ≤ max_cumulative_pause_seconds`, `pause_count < max_pauses`; appends `{start: now, end: pause_end}`, `paused_total += pause_end − now`, `pause_requested = false`; emits `PauseApproved(series, start, end, attestor)`. `end_pause(series)` — issuer, requires `is_paused(now)`: sets the open pause's `end = now`, `paused_total −= (old_end − now)`; emits `PauseEnded`. Pauses do not stop treasury releases (C11 §1) but do not lift a release block already in force (`is_late_underlying`, §5.3).

### 6.5 Tier 1 split router (D5)

Tier-1 series store plaintext `theta` and `r_wad` in the router (public by the issuer's choice), supplied at `create_series` with the salt-free check `Poseidon(5)(theta, r_wad, currency_code, indexing_rule, terms_salt) == terms_commitment` performed off-chain by the term builder and on-chain where Poseidon(5) is available (Solana syscall; EVM Poseidon(5) contract) — recorded in `ASSUMPTIONS.md`. A tier-1 series must have `fx_pair_id == 0` (its income currency is the stablecoin) and `r_wad × units_offered ≤ WAD`.

```
Router { theta: u64, r_wad: u64, ytd_year: u16, ytd_received: u64, held_before_finalization: u64,
         checkpoints: ring of 8 { period: u32, ytd_at_end: u64 } }
```
`init_router` may be called at any time (`init_period` recorded; checkpoints for earlier periods read 0). `route(series, amount)` / `sweep` — anyone; requires `mint_finalized` (before that, receipts accumulate in the receiving account); after a failed or cancelled raise, or once the series is Retired/Redeemed/Extinguished, every receipt passes through to the issuer in full:
```
close_period_if_needed(): if the receiving period of the last receipt < period_of(now): record checkpoint {period: p_prev, ytd_at_end: ytd_received (as of the end of p_prev)} for every period since the last checkpoint (ytd resets to 0 at a year boundary, so a Q4 checkpoint holds the year total and Q1 starts from 0)
if year_of(period_of(now)) != ytd_year: ytd_year = …; ytd_received = 0
below  = max(0, theta − ytd_received)
pass_a = min(amount, below)                 // 100% to the issuer
above  = amount − pass_a
share  = mulDiv(above, r_wad × units_outstanding, WAD)   // r_wad × units ≤ WAD so the product fits u128
share  = min(share, above)
ytd_received += amount
transfer (amount − share) → issuer ; vault_receive_gross(share, Router, period_of(now)) ; router_credit += accepted_share
emit IncomeRouted(series, amount, pass_through = amount − share, routed = share, ytd_received)
```
`close_router_period(series, period)` — anyone, after `period_end(period)`: records the checkpoint for `period` (and any earlier missing ones) so a tier-1 report can be verified even when no receipt arrives in the following period. Routed amounts are credited against the quarter's report (§6.2 step 8); `router_credit` carries forward indefinitely.

### 6.6 Rate accumulator (C9)

```
FxPair { pair_id, feed_id, inverted, crosscheck, crosscheck_effective_period, sum_wad: u128, count: u32, last_day: u32,
         checkpoints: map period_id → { sum_wad, count, deviation_flagged } }
```
`snapshot(pair, pyth_update)` — anyone, once per UTC day (`day = now / DAY`, require `day > last_day`); the staleness, confidence and deviation parameters are the protocol defaults in force (a pair's accumulator is shared by every series that references it):
1. Validate the Pyth price: owner/program check (Solana: `PriceUpdateV2` owned by the Pyth receiver program, `verification_level == Full`; EVM: `IPyth.getPriceNoOlderThan(feed_id, fx_max_staleness_seconds)`), `feed_id` matches, `publish_time ≥ now − fx_max_staleness_seconds`, `price > 0`, `conf × 10000 ≤ price × fx_max_conf_bps`. FX feeds publish only during market hours (Sun 22:00 UTC – Fri 22:00 UTC), so weekend snapshots fail staleness by design.
2. `rate_wad = normalize(price, expo)`: `expo ≤ 0` → `price × 10^(18 + expo)` (requires `expo ≥ −18`), `expo > 0` → `price × 10^18 × 10^expo`; if `inverted`: `rate_wad = floor(WAD × WAD / rate_wad)`.
3. First snapshot in a period: `checkpoints[period_of(now)] = { sum_wad, count, flagged = false }` **before** adding (this closes the previous period).
4. Cross-check: if `crosscheck != 0` and `period_of(now) ≥ crosscheck_effective_period` (EVM `AggregatorV3Interface.latestRoundData`, fresh within staleness), `cl_wad` normalized the same way; if `|rate_wad − cl_wad| × 10000 > cl_wad × fx_deviation_band_bps` → `checkpoints[period_of(now)].flagged = true` and emit `FxDeviationFlagged`.
5. `sum_wad += rate_wad; count += 1; last_day = day`. Emit `FxSnapshot(pair, day, rate_wad, sum_wad, count)`.

`quarter_average(pair, p)`: start = `checkpoints[p]` (missing → `NeedsFallback`, never a revert); end = `checkpoints[p+1]` if present, else — when `now ≥ period_end(p)` and `last_day × DAY < period_start(p+1)` (no snapshot yet in `p+1`, so the live totals are the end-of-`p` totals) — the live `(sum_wad, count)`; otherwise `NeedsFallback`. `n = count_end − count_start`; `ok = n × 10000 ≥ trading_days_in_period(p) × fx_min_coverage_bps && !flagged_p` where `trading_days_in_period(p)` counts the Monday–Friday civil days of `p`; `avg_wad = floor((sum_end − sum_start) / n)`. Returns `(ok, avg_wad)`; `ok == false` means `NeedsFallback` (§6.2 step 4).

(Chainlink runs on EVM; on Solana `crosscheck` is left unset in this version — `ASSUMPTIONS.md` A21.)

### 6.7 Redemption (C7)

`redeem(series)` — issuer only; `mint_finalized`; `derive_status(now) ∈ {OnTime, InGrace, Paused}`; `now ≥ settlement_ts + lockup_seconds`; `open_due_amount == 0 && trueup_due == 0`; and every ended period is reported: `period_of(now) − 1 < first_period || last_accepted_period ≥ period_of(now) − 1` (`UnreportedPeriods`). These are the issuer's own obligations, not a third-party block (`ASSUMPTIONS.md` A15).

```
t          = now − settlement_ts
Y          = floor(t / YEAR)
frac_wad   = floor((t − Y × YEAR) × WAD / YEAR)
P_hurdle   = P0
repeat Y times: P_hurdle = floor(P_hurdle × (WAD + h) / WAD)
P_hurdle   = floor(P_hurdle × (WAD + floor(h × frac_wad / WAD)) / WAD)
paid_units = ceil(paid_per_unit_wad / WAD)
C_rem      = cap_per_unit() > paid_units ? cap_per_unit() − paid_units : 0
if Y ≥ 1: n = min(Y, 3); D_avg = floor(Σ_{y = Y−n}^{Y−1} year_gross[y] / (n × WAD)); floor_term = max(P_hurdle, k × D_avg) else floor_term = P_hurdle
P_redeem   = min(C_rem, floor_term)
deposit    = P_redeem × units_outstanding
```
Pull `deposit` from the issuer into the vault (**no fee**). Set `status = Redeemed`, `redemption_ts = now`, `redemption_price = P_redeem`, `units_at_redemption = units_outstanding`, `tail_cap_per_unit = C_rem − P_redeem`; registry `mark_terminal(Redeemed)`. Emits `SeriesRedeemed(series, P_redeem, P_hurdle, D_avg, C_rem, units, deposit)`. If `C_rem == 0` the series is instead retired (`retire()`), since nothing is owed either way.

`claim_redemption(series)` — holder (or anyone pushing): `settle_holder`; `units = accrual_units(holder)` (deliveries pending in the auction escrow are delivered first); `redeemed_units = units` (recorded once); `amount = pending + P_redeem × units`; `pending = 0`; burn `units` (zero-amount rule); `units_outstanding −= units`; transfer `amount`. Emits `RedemptionClaimed(series, holder, units, amount)`. Available in `Redeemed` and `Extinguished`.

### 6.8 Tail clause

A report accepted while `status == Redeemed` with `liquidity_event == true` (§6.2) creates a due paid with `pay`, routed to `vault_receive_tail(G)`:

```
N = units_at_redemption; cap_wad = tail_cap_per_unit × WAD
inc_wad = floor(G × WAD / N)
if tail_paid_per_unit_wad + inc_wad < cap_wad: accepted = G
else: remaining = cap_wad − tail_paid_per_unit_wad; accepted = floor(remaining × N / WAD); inc_wad = floor(accepted × WAD / N); refund = G − accepted → issuer; tail_exhausted = true
tail_paid_per_unit_wad += inc_wad; fee = floor(accepted × payout_fee_bps / 10000); net = accepted − fee
num_wad = net × WAD + tail_carry_wad; delta = floor(num_wad / N); tail_carry_wad = num_wad − delta × N; tail_acc_wad += delta
```
`claim_tail(series)` — holder with `redeemed_units > 0` (or with units not yet redeemed: `claim_redemption` runs first): `amount = floor((tail_acc_wad − last_tail_acc_wad) × redeemed_units / WAD)`; update; transfer. Emits `TailDistributed`, `TailClaimed`.

### 6.9 Extinguishment (C11 §6)

`extinguish(series, sig_a, sig_b)` — anyone submits two signatures from **two distinct** active attestors over the §1.4 message with `extinguish_nonce`; allowed in **every** status except `Extinguished` (including Retired and Redeemed at any time), `mint_finalized`. Effects: `status = Extinguished`, `extinguished_at = now`; registry `mark_terminal`; `unreleased = proceeds − max(vested(now), released_total)` moves from the treasury to the vault with **no fee** (vested-but-unclaimed tranches stay claimable by the issuer's wallet, §5.3); `final_units = units_outstanding` (for a Redeemed series: `units_at_redemption`); `final_acc_wad += floor((unreleased × WAD + final_carry_wad) / final_units)` with the WAD remainder kept in `final_carry_wad` (`unreleased == 0` or `final_units == 0` → no distribution); all open dues (`open_due_*`, `trueup_due`) are cleared; the tail ends. Emits `SeriesExtinguished(series, unreleased, attestor_a, attestor_b)`.

`claim_final(series)` — holder: weight `w = redemption_ts != 0 ? redeemed_units + unit_balance (after running the `claim_redemption` body for any unredeemed balance, which pays `P_redeem × balance`) : accrual_units(holder)`; `settle_holder`; `amount = pending + floor((final_acc_wad − last_final_acc_wad) × w / WAD)`; burn any remaining balance; transfer. Emits `FinalClaimed(series, holder, units, amount)`. `claim`, `claim_redemption` and `claim_tail` also remain callable for funds already in the vault.

---

## 7. Transfer window (D9)

```
Window (per series × period) { state: Closed|Commit|Reveal|Settling|Settled|NoMatch, opens_at, commit_end, reveal_end,
  order_count, revealed_count, valid_count, escrow_units, escrow_stable,
  tally_round, round_rejected, clearing_price, no_match_proposed: bool,
  d_above, d_at, s_below, s_at, max_bid, min_ask, tallied_count,
  branch: SupplyLimited|DemandLimited, matched_units, marginal_remaining, next_marginal_reveal_index,
  processed_count }
Order (per window × owner; ONE order per wallet per window, on either side) { owner, side: Bid|Ask, commitment, escrow (stable for bids, units for asks),
  reveal_index, revealed, valid, price, quantity, tallied_round, processed, fill }
```
- `open_window(series, period)` — anyone; requires `windows_enabled`, `mint_finalized`, `derive_status(now) ∈ {OnTime, InGrace}`, `now ≥ settlement_ts + lockup_seconds`, the report for `period` accepted and paid (`last_paid_period ≥ period`), `period == period_of(now) − 1`, no window open for the series. `commit_end = now + window_commit_duration`, `reveal_end = commit_end + window_reveal_duration`. Emits `WindowOpened`.
- `commit_ask(series, commitment, units)` — holder; no existing order for this wallet in this window; `settle_holder(owner)` first; **arms** the escrow (`EscrowArm`/`armedDeposit(owner) = units`), moves `units` into the window escrow, clears the arm. The owner's accrual weight is unchanged (ask-escrow units count, §6.1). `commit_bid(series, commitment, escrow)` — allowlisted wallet (`isAllowed`), no existing order; pulls stablecoin.
- `reveal_order(series, price, quantity, salt)` — in the reveal phase; commitment check as §1.3; a validity failure records `valid = false`, it never reverts. Validity: `price ≥ 1`, `quantity ≥ 1`; asks: `quantity ≤ escrow_units`; bids: `escrow ≥ price × quantity + floor(price × quantity × window_fee_bps / 10000)` and `unit_balance(owner) + quantity ≤ wallet_cap_units` where `wallet_cap_units = floor(units_outstanding × wallet_cap_bps / 10000)`. (Because a wallet has at most one order and the only unit movements during a window are this window's fills, the bound is exact and is not re-checked at fill.) Tally fields: `valid_count`, `max_bid`, `min_ask` are updated per the branch rules below only during the tally.
- `begin_window_settlement(series, clearing_price | NO_MATCH)` — anyone, `now ≥ reveal_end`, allowed only when `tally_round == 0 || round_rejected` (`TallyInProgress` otherwise). Resets the tally fields. `tally_orders(page)`: for valid revealed orders: bids `price > p*` → `d_above += q`, `== p*` → `d_at += q`, `max_bid = max(…)`; asks `price < p*` → `s_below += q`, `== p*` → `s_at += q`, `min_ask = min(…)`.
- `finalize_window(series)` — anyone, `tallied_count == revealed_count`; an invalid proposal does not revert: `round_rejected = true`, emit `WindowSettlementRejected(series, period, clearing_price, reason)`. Let `D = d_above + d_at`, `S = s_below + s_at`.
  - `NO_MATCH` proposal: valid iff `valid_count == 0` or `max_bid < min_ask` → state `NoMatch`, emit `WindowNoMatch`.
  - Otherwise `p*` must be a revealed valid price (`d_at > 0 || s_at > 0`) and exactly one branch must hold:
    - **(A) supply-limited:** `S > 0 && d_above < S && S ≤ D` → `matched_units = S`; the *marginal side is the bids at p\**, `marginal_remaining = S − d_above`.
    - **(B) demand-limited:** `D > 0 && s_below ≤ D && D < S` → `matched_units = D`; the *marginal side is the asks at p\**, `marginal_remaining = D − s_below`.
    Both branches maximise matched volume and the accepted `p*` is unique when a crossing exists (`ARCHITECTURE.md` §5.2). State `Settled`, `next_marginal_reveal_index = 0`. Emits `WindowCleared(series, period, p*, matched_units, branch)`.
- `process_order(order)` — anyone, once per order, after `Settled` or `NoMatch`. Order of processing (`OutOfOrder` otherwise): revealed bids in ascending reveal index, then revealed asks in ascending reveal index (`BidsNotProcessed`); unrevealed orders and NO_MATCH windows in any order. `process_order` does the **accounting only** (fee to the collector, fills and refunds recorded); `deliver_order(order)` pushes the recorded units and stablecoin to the owner once, retryable forever (`OrderDelivered`), so no frozen or missing recipient account blocks another order (§12 liveness). Units awaiting delivery count in the owner's `accrual_units`; `claim_redemption`/`claim_final` require nothing pending (`DeliverFirst`). A new window cannot open while any order of the previous one is unprocessed. Exhaustive cases:
  - `NoMatch`, or unrevealed, or revealed & invalid: every order gets its full escrow back (units or stablecoin), no fee, no charge (window non-reveals are uncharged — `ASSUMPTIONS.md` A28).
  - Full side (A: bids with `price > p*`, asks with `price ≤ p*`; B: bids with `price ≥ p*`, asks with `price < p*`): `fill = quantity`.
  - Losing side (A: bids with `price < p*`, asks with `price > p*`; B: bids `< p*`, asks `> p*`): `fill = 0`.
  - **Marginal side** (A: bids at `p*`; B: asks at `p*`): processed **in ascending `reveal_index`** behind the cursor (`reveal_index == next_marginal_reveal_index` among marginal orders, else `OutOfOrder`): `fill = min(quantity, marginal_remaining)`, `marginal_remaining −= fill`, cursor advances to the next marginal order's index. First-come at the margin makes `Σ fills` on each side equal `matched_units` exactly, so no dust exists and the window is always solvent (the brief requires pro rata rounding only for the primary auction — `ASSUMPTIONS.md` A27).
  - Settlement of a filled **bid**: `cost = p* × fill`, `fee = floor(cost × window_fee_bps / 10000)` → fee collector, refund `escrow − cost − fee`; `register_holder(buyer)`; units move escrow → buyer. If `isAllowed(buyer)` is false at fill, the fill is cancelled (`fill = 0`, full refund) and the units it would have bought are taken back from the sell side before asks are settled: from asks at `p*` in **descending** reveal index first, then from asks below `p*` in descending `(price, reveal_index)` (the window keeps `cancelled_units` and reduces ask fills in that order), so sellers' proceeds equal buyers' payments exactly. Because sorting is not possible in bounded compute on Solana, the cut below `p*` is a keeper-proposed threshold verified by a paged tally (`begin_takeback` / `tally_takeback` / `finalize_takeback`, same round rules as settlement, events `WindowTakebackProposed/Rejected/Settled`); the EVM may compute it directly but emits the equivalent `WindowTakebackSettled`.
  - Settlement of a filled **ask**: receives `p* × fill` from the window stablecoin escrow; `settle_holder(seller)` before `escrow_units` leave the escrow accounting; `escrow_units − fill` units return to the seller (returns to the original owner are exempt from allowlist and cap checks: they are not acquisitions). Because buyers pay exactly `p* × Σ fills`, asks are always payable.
  - Money conservation per window: `Σ buyer cost = p* × matched = Σ seller proceeds`; `Σ fees → collector`; all other escrow returns to its owner. Emits `OrderFilled(series, period, owner, side, fill, price, fee, refund)`.
- Direct transfers remain impossible at all times; only this module moves units between wallets.

---

## 8. ZK reference circuit (D6)

`circuits/report.circom` (circom 2.2.x, Groth16, BN254, snarkjs). Public inputs in order `[terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd]`. Private: `theta, r_wad, currency_code, indexing_rule, terms_salt, income_ytd, income_salt, prior_income_ytd, prior_salt`.

Constraints:
1. `terms_commitment === Poseidon(5)(theta, r_wad, currency_code, indexing_rule, terms_salt)`
2. `income_commitment === Poseidon(2)(income_ytd, income_salt)`; `prior_income_commitment === Poseidon(2)(prior_income_ytd, prior_salt)`
3. Range checks: `income_ytd, prior_income_ytd, theta < 2^64`; `r_wad < 2^64`; `units_outstanding < 2^64`; `fx_avg_wad < 2^64`; `payment_usd < 2^64`; `income_ytd ≥ prior_income_ytd` (the high-water mark rule of §1.5 guarantees a witness exists).
4. `excess(x) = x > theta ? x − theta : 0` (comparator + mux); `owed(x) = floor(r_wad × units_outstanding × excess(x) / WAD)` with witness quotient/remainder and `remainder < WAD`, quotient `< 2^128`.
5. `payment = owed(income_ytd) − owed(prior_income_ytd)` (non-negative by monotonicity, enforced).
6. `payment_usd === floor(payment × fx_avg_wad / WAD)` with the same quotient/remainder technique. Units: `payment` is at income scale (§1.5), `fx_avg_wad` is a unit-less WAD ratio, so `payment_usd` is in stablecoin base units.

Deliverables: `circuits/build/report.r1cs`, `report.wasm`, `report_final.zkey`, `verification_key.json` (dev ceremony: local `powersoftau` with fixed entropy strings, **not for production**, stated in `circuits/README.md`), generated `evm/src/zk/Groth16Verifier.sol` and `solana/programs/merces_protocol/src/zk/vk.rs`. The verifier cost on each chain is measured and reported in `AUDIT_NOTES.md`.

---

## 9. Curve mode (D10, Solana only)

See `docs/meteora/CURVE_MODE.md` (design), `docs/research/METEORA_DBC.md` (program facts) and `ARCHITECTURE.md` §8. `Series.mode = Curve` requires `issuer_accepts_public_price == true` and `stablecoin == ProtocolConfig.curve_quote_mint` (USDC); lockup, wallet cap and raise durations are 0; no auction, no transfer hook (the DBC revokes it at graduation). Lifecycle: `prepare_curve` / `activate_curve` record `dbc_config`, `dbc_pool`, `base_mint`, `dbc_creator` and fix `P0 = floor(X × 10^6 / swap_base_amount)` (X = the migration quote threshold); `complete_curve` settles the series at the curve's finish timestamp and opens the treasury and repayment paths. Accounting is **per base lamport** (`unit_scale = 10^6`, 1 HEU = 10^6 base; `unit_scale = 1` for sealed-bid series). A permissionless `sync_curve_units` crank sets `units_outstanding = base_supply − (DBC base vault + DAMM v2 base vault + locker escrow + leftover)` and a report requires a count synced after its period ended. Proceeds reach the issuer only through `collect_curve_proceeds` (DBC `withdraw_migration_fee` into the treasury, following the D4 schedule; `claim_trading_fee` to the fee collector); activation **refuses** any config that could route raised quote anywhere else (so the generator's `creator_fee_percentage` must be 0, not the memo's 100 — `ASSUMPTIONS.md`). Because curve units trade freely, claims are gated by **staking**, not by reading a wallet balance (that could be double-claimed): only units in the protocol stake vault earn (`stake_units` requires an allowlisted holder — this is the claim gate; `unstake_units` is never blocked and pays what is pending, so "claim before selling" is "unstake before selling"). At the cap, claims end and the series is Retired with no forced burn. Redemption is by **tender**: `redeem` deposits `P_redeem × units_outstanding`; `tender_units(units)` pays `P_redeem × units` and the owner burns the units in place (no permanent delegate on a DBC mint), capped at `units_at_redemption − tendered − staked`.

---

## 10. Events (canonical names; identical fields on both chains)

Registry: `ProtocolInitialized`, `AdminTransferStarted`, `AdminTransferred`, `AllowlistManagerSet`, `FeeCollectorSet`, `FlagsSet`, `EarlyDrawApproverSet`, `DefaultsSet`, `AttestorRegistered`, `AttestorRevoked`, `VerifierKeyRegistered`, `VerifierKeyRevoked`, `FxPairSet`, `IssuerRegistered`, `IssuerDeactivated`, `IssuanceStopped`, `IssuanceResumed`, `AllowlistUpdated(wallet, allowed)`, `SeriesCreated(series, issuer, mode, stablecoin, units_offered, reserve_price, min_raise, cap_multiple_wad, hurdle_rate_wad, k, lockup_seconds, wallet_cap_bps, fees…, terms_commitment, tier_flags, fx_pair_id)`, `ContractHashSet(series, hash)`, `TermsAmended(series, nonce, new_terms_commitment, new_cap_multiple_wad, attestor)`, `RaiseStateChanged(series, state)`, `TerminalStatusSet(series, status)`.

Protocol: `RaiseOpened(series, unit_mint, opened_at, commit_end, reveal_end)`, `RaiseCancelled`, `BidCommitted(series, bidder, escrow)`, `BidRevealed(series, bidder, price, quantity, valid)`, `SettlementProposed(series, clearing_price, round)`, `SettlementRejected(series, round, clearing_price, reason)`, `RaiseSettled(series, clearing_price, units_sold, proceeds, settlement_ts)`, `RaiseFailed(series, clearing_price, proceeds, min_raise)`, `UnitsAllocated(series, bidder, units, cost, fee, refund)`, `BidDelivered(series, bidder, units, refund)`, `NonRevealCharged(series, bidder, charge)`, `RaiseMintFinalized(series, units_sold, proceeds)`, `MintAuthorityRevoked(series)`, `ReleaseClaimed(series, amount, released_total)`, `ReleasePauseSet(series, paused)`, `EarlyDrawExecuted(series, amount, approver)`, `ReportAccepted(series, period, payment_usd, fx_avg_wad, fx_fallback, tier, liquidity_event, income_commitment, due)`, `PaymentSettled(series, period, gross, accrual, fee, accepted, refunded)`, `PayoutDistributed(series, source, gross, accepted, fee, net_added, delta_acc_wad, paid_per_unit_wad, retired)`, `PayoutClaimed(series, holder, amount, burned_units)`, `HolderRegistered(series, holder)`, `UnitsBurned(series, holder, units, reason)`, `SeriesRetired(series, paid_per_unit_wad, refund)`, `StatusChanged(series, old, new)`, `FormalNoticeDue(series, period, trueup)` (`period` is the calendar year when `trueup`), `PauseRequested(series, nonce)`, `PauseRequestWithdrawn(series, nonce)`, `PauseApproved(series, start, end, attestor)`, `PauseEnded(series, paused_total)`, `IncomeRouted(series, amount, pass_through, routed, ytd_received)`, `RouterPeriodClosed(series, period, ytd_at_end)`, `TrueUpRecorded(series, year, adjustment, deadline)`, `TrueUpPaid(series, amount, accrual)`, `FxSnapshot(pair, day, rate_wad, sum_wad, count)`, `FxDeviationFlagged(pair, period, rate_wad, crosscheck_wad)`, `SeriesRedeemed(series, price, hurdle, d_avg, cap_remaining, units, deposit)`, `RedemptionClaimed(series, holder, units, amount)`, `TailDistributed(series, period, gross, accepted, fee, refunded)`, `TailClaimed(series, holder, amount)`, `SeriesExtinguished(series, unreleased, attestor_a, attestor_b)`, `FinalClaimed(series, holder, units, amount)`, `WindowOpened(series, period, commit_end, reveal_end)`, `OrderCommitted(series, period, owner, side, escrow)`, `OrderRevealed(series, period, owner, side, price, quantity, valid)`, `WindowSettlementProposed(series, period, clearing_price, round)`, `WindowSettlementRejected(series, period, clearing_price, reason)`, `WindowCleared(series, period, clearing_price, matched_units, branch)`, `WindowNoMatch(series, period)`, `OrderFilled(series, period, owner, side, fill, price, fee, refund)`, `WindowTakebackProposed(series, period, threshold)`, `WindowTakebackRejected(series, period, threshold, reason)`, `WindowTakebackSettled(series, period, cancelled_units)`, `OrderDelivered(series, period, owner, side, units, amount)`.

`EVENTS.md` documents each field for the indexer; Solana events are Anchor `#[event]`s emitted with `emit!` (CPI-less logs) and EVM events carry the same field names in camelCase.

---

## 11. Parity vectors

`packages/vectors/<nn>_<name>.json`:

```json
{
  "name": "01_happy_path", "description": "...", "schema": 1,
  "config": { "parameters": { ...all §1.6 values as decimal strings... }, "chainDomainNote": "hashes are recomputed per chain" },
  "actors": ["issuer", "b1", "b2", "attestor1", "verifier1", "keeper"],
  "steps": [
    { "t": "1767225600", "op": "allowlist", "wallets": ["issuer", "b1", "b2"] },
    { "t": "1767225600", "op": "create_series", "actor": "issuer", "series": "S1", "terms": { ... }, "releaseSchedule": [...], "termsCommitment": "0x..", "contractHash": "0x.." },
    { "t": "...", "op": "open_raise", "actor": "issuer", "series": "S1" },
    { "t": "...", "op": "commit_bid", "actor": "b1", "series": "S1", "price": "1000000", "quantity": "100", "salt": "0x..", "escrow": "101000000" },
    { "t": "...", "op": "reveal_bid", ... }, { "t": "...", "op": "settle", "series": "S1", "clearingPrice": "1000000" },
    { "t": "...", "op": "submit_report", "actor": "issuer", "series": "S1", "period": "8104", "paymentUsd": "...", "fxAvgWad": "1000000000000000000", "tier": 2, "liquidityEvent": false, "incomeCommitment": "0x..", "attestation": "verifier1", "proof": { "pi_a": [...], "pi_b": [...], "pi_c": [...], "publicSignals": [...] } },
    { "t": "...", "op": "pay", "actor": "issuer", "series": "S1" },
    { "t": "...", "op": "claim", "actor": "b1", "series": "S1" },
    { "t": "...", "op": "expect", "series": "S1", "balances": { "b1": { "stable": "...", "units": "..." }, "issuer": {"stable": "..."}, "treasury": "...", "vault": "...", "feeCollector": "..." }, "ledger": { "status": "OnTime", "paidPerUnitWad": "...", "netAccWad": "...", "unitsOutstanding": "..." } },
    { "t": "...", "op": "expect_revert", "actor": "b1", "series": "S1", "call": { "op": "transfer_units", "to": "b2", "units": "1" }, "error": "DirectTransferForbidden" }
  ]
}
```
All integers are decimal strings; hashes/commitments hex. `t` is the block time the harness warps to before the step. Proofs are generated by the reference package with the dev zkey and embedded. Each chain's harness maps actor names to fresh keys, deploys the stack, mints mock stablecoin per `fund` steps, and asserts `expect` steps to the base unit. The harness also recomputes commitments with chain-specific wallet bytes (bid hashes differ per chain; amounts do not).

---

## 12. Security requirements (both stacks)

- Checked arithmetic everywhere; explicit `u64` range checks on EVM inputs.
- Checks-effects-interactions; EVM `ReentrancyGuard` on every external function that moves tokens; pull payments for claims and refunds (push by keepers is allowed only to the rightful owner's own address).
- Solana: every account validated for owner, PDA seeds and bump, signer, mint, token program (the mint's own program), and ATA derivation; no `UncheckedAccount` without a documented reason; remaining accounts for transfer hooks are validated by `spl_token_2022::onchain`.
- No admin path moves treasury/vault/escrow funds. Fee collector only receives.
- Every state transition emits an event; every error has a distinct code.
- Fuzz and invariant tests per F2; the invariant harness tracks ghost sums (escrow, proceeds, fees, refunds, claims).
- Liveness: no permissionless action may reset or block another keeper's in-progress work (settlement rounds), and no recipient-side failure (allowlist removal, frozen stablecoin account, missing token account) may block finalization, treasury releases or other holders' claims.

---

## 13. Changes in v1.1 (8 October 2026)

From the adversarial spec audit (71 findings; nine lenses). Each item names the sections changed.

1. **Auction can always terminate** (§5.2): `valid_count == 0` → `Failed`; series creation requires at least one unit of wallet cap.
2. **No settlement stalls** (§5.2, §7): a new proposal is accepted only when no round is in progress or the completed round was rejected; `finalize_*` on a wrong proposal records `round_rejected` and emits a rejection instead of reverting.
3. **Exact one-pass settlement** (§5.2): the proposer also claims `q_above, q_at`; the tally accumulates marginal allocations against the claimed `R`, so `units_sold`, `proceeds` and the min-raise test are exact and the registry is written once. The "upper bound" rule (old A12) is gone.
4. **Undeliverable bids can't block anything** (§5.2): `process_bid` only moves money to protocol accounts and mints to the auction escrow; `deliver_bid` pushes units/refunds to the bidder and may be retried forever. Mint finalization and releases depend only on `bids_processed`.
5. **Nothing distributes before the mint is final** (§6.1 gate); `units_outstanding` is stored at finalization and is the proof's public input; accrual weight includes escrowed units.
6. **Cap amendments cannot underflow or no-op** (§3.2, §6.3): the cap is read live, the effective cap is `max(cap, paid)`, `retire_if_capped` exists, no amendments after terminal status.
7. **Income scale fixed** (§1.5, §8): θ/income at the stablecoin's decimals; `fx_avg_wad` unit-less; `payment_usd` range-checked in-circuit and on entry.
8. **Tier rules** (§6.2 step 3/7, §6.5): tier 1 is a report tier only for pure tier-1 series and is bound to the router's period checkpoint through Poseidon; any series with tiers 2/3/4 must report with an attested tier.
9. **First-report prior** (§6.2 step 5): attested prior commitment at the first report (Kunal, A25); attestation message binds prior commitment and liquidity flag.
10. **Clock** (§6.4): per-obligation unpaused countdowns (bounded pause history) replace the global effective clock; pause bounds, withdrawable requests, `end_pause` only while paused; a pause never lifts a release block already in force.
11. **True-up** (§6.2, §6.4): nonce, once per year, bounded negative adjustments, visible to the status machine, blocks redemption.
12. **Redemption gate** (§6.7): not Late, nothing due, every ended period reported; `C_rem` saturates; `year_gross` ring indexed by the period's due date.
13. **Tail/final consistency** (§6.8, §6.9): same `<` boundary, separate carries, `tail_exhausted`; extinguishment allowed in every status, estate keeps vested tranches, explicit weights, `claim_final` settles unclaimed redemptions first.
14. **Window** (§7): two-branch clearing (supply- or demand-limited) so a crossing price always exists; first-come fills at the margin (no dust, always solvent); one order per wallet; exhaustive lifecycle; armed escrow deposits; buyer allowlist re-check at fill.
15. **Hook / compliance** (§4.1, §4.2): escrow-based rules with `EscrowArm`/`armedDeposit`; resolvable extra-account list; EVM allowlist is a Merces flag and identities are never deleted; normative T-REX governance (fixed agent set, governor contract, unpause).
16. **Registry** (§3): `protocol_program` fixed at init; FX pairs write-once with forward-only cross-check changes; key revocation forward-only with grace; `mint_finalized`.
17. **Conventions** (§1.1): entry-point range rule, zero-amount rule, nested `mulDiv` forms.
18. **Carry is an exact WAD remainder** (§6.3, §6.8, §6.9): `num_wad = net × WAD + carry_wad; delta = floor(num_wad / N); carry_wad = num_wad − delta × N`. The v1.0 base-unit carry could over-credit holders (found by Track A's conservation tests).
19. **v1.1.1 (9 Oct, from the Solana implementation)**: literal hook extra accounts (§4.1); `units_sold == 0` fails the raise, failed raises finalise an empty mint, cancel revokes the mint authority (§5.2); no early draw after extinguishment and `unreleased = proceeds − max(vested, released)` (§5.3, §6.9); explicit status sync points (§1.7); zero true-ups valid, vacuous year rule, anchor by the attestation period's deadline (§6.2); router init any time and pass-through after dead raises/terminal statuses (§6.5); FX parameters from protocol defaults, missing start checkpoint → fallback, `set_fx_crosscheck` with a previous feed in force (§3.1, §6.6); window processing order, two-step delivery, owned-units cap, take-back order and threshold rounds, new events (§7, §10).
