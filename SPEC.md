# Merces Stage 1 — Normative Specification (v1.0, 7 October 2026)

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
- `mulDiv(a, b, c) = floor(a × b / c)` computed in 128-bit (Solana) or 256-bit (EVM) without intermediate overflow for the domain above. All arithmetic is checked; overflow reverts.

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
| Report attestation (tier 2 verifier key, tier 3 attestor) | `"MERCES_REPORT_V1" ‖ domain ‖ series_key ‖ period_u32 ‖ income_commitment_32 ‖ tier_u8 )` |
| FX fallback rate (attestor) | `"MERCES_FX_V1" ‖ domain ‖ series_key ‖ period_u32 ‖ fx_rate_wad_u64 )` |
| Favourable amendment (attestor) | `"MERCES_AMEND_V1" ‖ domain ‖ series_key ‖ amendment_nonce_u64 ‖ new_terms_commitment_32 ‖ new_cap_multiple_wad_u64 )` |
| Hardship pause approval (attestor) | `"MERCES_PAUSE_V1" ‖ domain ‖ series_key ‖ pause_nonce_u64 ‖ pause_end_u64 )` |
| Extinguishment (two distinct attestors) | `"MERCES_EXTINGUISH_V1" ‖ domain ‖ series_key ‖ extinguish_nonce_u64 )` |
| Tier 3 true-up (attestor) | `"MERCES_TRUEUP_V1" ‖ domain ‖ series_key ‖ year_u16 ‖ adjustment_i64 ‖ attestation_ts_u64 )` |

Nonces are per-series counters stored in the ledger and incremented on use, so no signature replays.
Tier 4 (self-attestation) uses the issuer's native transaction signature (Solana signer / EVM `msg.sender`) and is accepted only while the protocol flag `tier4_enabled` is true (default false).

### 1.5 Commitments (off-chain and in-circuit)

- `terms_commitment = Poseidon(5)(theta, r_wad, currency_code, indexing_rule, terms_salt)`
  - `theta`: annual threshold in income-currency minor units (`< 2^64`)
  - `r_wad`: rate per unit, WAD (`< 2^64`)
  - `currency_code`: ISO-4217 numeric code (`840` = USD); `indexing_rule`: `u32` opaque code (0 = none, 1 = CPI-indexed yearly)
  - `terms_salt`: random field element
- `income_commitment = Poseidon(2)(income_ytd, income_salt)`; `income_ytd` in income-currency minor units.
- `ZERO_INCOME_COMMITMENT = Poseidon(2)(0, 0)` is the prior commitment at the start of every reporting year.

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
| `fx_max_staleness_seconds` | `3600` | `[60, 86400]` | age of the Pyth update at snapshot time |
| `fx_max_conf_bps` | `100` | `[1, 1000]` | `conf / price ≤ 1%` |
| `fx_deviation_band_bps` | `200` | `[10, 5000]` | H2 proposed default (2%), used only when a cross-check feed is configured |
| `max_release_tranches` | `24` | fixed | |
| `max_bids_per_auction` | `4096` (EVM), unbounded by PDA count (Solana) | documented | settlement is paged |

Protocol flags (registry, admin-settable): `new_raises_paused` (default false), `windows_enabled` (default **false**, ships closed), `tier4_enabled` (default **false**), `early_draw_approver` (default **unset**).

### 1.7 Status machine (C8 §7)

`SeriesStatus ∈ { OnTime=0, InGrace=1, Late=2, Paused=3, Retired=4, Redeemed=5, Extinguished=6 }`.
Raise lifecycle (separate field): `RaiseState ∈ { Draft=0, Open=1, Reveal=2, Settling=3, Settled=4, Failed=5, Cancelled=6 }`.

`OnTime/InGrace/Late/Paused` are **derived** from time and the ledger by `derive_status(now)` (§6.4); every write path calls `sync_status(now)` which recomputes, stores and emits `StatusChanged` if changed, and a permissionless `crank_status` exists so indexers see timely transitions. Treasury release checks use the derived value, never the stored one. `Retired/Redeemed/Extinguished` are terminal and stored.

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
  protocol_program / protocol_contracts: addresses allowed to call the narrow write interface (§3.3),
  series_count: u64
}
Issuer { wallet, active: bool, issuance_stopped: bool, series_count: u32 }
AllowlistEntry { wallet, allowed: bool, updated_at }
AttestorKey { addr20, active: bool }    VerifierKey { addr20, active: bool }
FxPairConfig { pair_id: bytes32, feed_id: bytes32, inverted: bool, crosscheck: address|0, enabled: bool }

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
  raise_state: RaiseState, opened_at: u64, settlement_ts: u64, units_sold: u64, clearing_price: u64 (P0),
  terminal_status: u8 (0 none, else Retired/Redeemed/Extinguished mirror for the hook)
}
```

### 3.2 Functions

- `init_protocol(admin, allowlist_manager, fee_collector, chain_id, defaults)` once.
- Admin: `set_allowlist_manager`, `set_fee_collector`, `set_flags(new_raises_paused, windows_enabled, tier4_enabled)`, `set_early_draw_approver`, `set_defaults(Parameters)` (bounds-checked), `register_attestor(addr20)`, `revoke_attestor`, `register_verifier_key`, `revoke_verifier_key`, `set_fx_pair(...)`, `register_issuer(wallet)`, `deactivate_issuer(wallet)` (blocks *new* series only), `transfer_admin` / `accept_admin` (two-step).
- Allowlist manager: `set_allowed(wallet, bool)`.
- Issuer: `create_series(params, release_schedule, terms_commitment, tier_flags, fx_pair_id, mode, issuer_accepts_public_price)` → Draft; requires `issuer.active && !issuer.issuance_stopped`, issuer wallet allowlisted, bounds OK, `min_raise ≤ reserve_price × units_offered`, `units_offered ≥ 1`, `reserve_price ≥ 1`. `set_contract_hash(series, hash)` (Draft only, non-zero). `stop_issuance()` / `resume_issuance()`. `amend_terms(series, new_terms_commitment, new_cap_multiple_wad, attestor_sig)`: issuer is signer; attestor signature over the §1.4 message with the current nonce; `new_cap_multiple_wad ≤ current` and within bounds; nonce++; emits `TermsAmended`. Allowed in any non-terminal state.
- Protocol write interface (§3.3): `mark_raise_opened(series, unit_mint, opened_at)`, `mark_raise_result(series, state ∈ {Settled, Failed, Cancelled}, settlement_ts, units_sold, clearing_price)`, `mark_terminal(series, status)`. Callable only by the protocol program's signer PDA (Solana) or the registered protocol contracts (EVM).
- Views: everything above; `is_allowed(wallet)`, `is_attestor(addr20)`, `is_verifier_key(addr20)`, `is_transfer_locked(series, now) = raise_state != Settled || now < settlement_ts + lockup_seconds`.

### 3.3 Immutability

After `mark_raise_opened`, every field in the "charter terms" block is frozen: no function writes them. `terms_commitment` and `cap_multiple_wad` change only through `amend_terms` (cap only downwards). Tests assert this by diffing the serialized series before/after every other instruction (F2).

---

## 4. Unit token (D2)

### 4.1 Solana

- One Token-2022 mint per sealed-bid series, created by `merces_protocol::open_raise`: `decimals = 0`; extensions `TransferHook { program_id = merces_hook }`, `PermanentDelegate { delegate = vault_authority PDA of merces_protocol }`, `MetadataPointer` → the mint itself, `TokenMetadata { name = "Merces HEU <series_id>", symbol = "HEU", uri = metadata_uri from create args }`. `mint_authority = auction_authority PDA` (merces_protocol), `freeze_authority = None`. `DefaultAccountState` is **not** used (recorded assumption: the hook plus allowlist checks at mint are sufficient; adding it later is additive).
- `open_raise` also CPIs `merces_hook::initialize_extra_account_meta_list(mint)` so Token-2022 can resolve the hook's extra accounts: `[registry ProtocolConfig, Series (by seed from mint), AllowlistEntry(source_owner), AllowlistEntry(destination_owner)]`, expressed with `spl_tlv_account_resolution` seeds (PDA seeds derived from the source/destination token-account owners read from the transfer accounts).
- Mint authority is revoked (`set_authority(None)`) when `units_minted == units_sold` (last `claim_win`) or by `revoke_mint_authority` once every winning bid is processed.
- Hook rule (`merces_hook::execute(amount)`), evaluated on **every** transfer (mint and burn do not invoke hooks):
  1. Require the "transferring" flag set by Token-2022 on both token accounts (standard hook safety).
  2. Load `Series` by the mint; if `series.mode == Curve` → reject (curve mints are not created with this hook anyway).
  3. If the source **or** destination token account is the series' **window escrow** token account (owned by `window_escrow_authority` PDA of `merces_protocol`, derived from the series), the transfer is a window escrow movement: require destination owner allowlisted when the destination is not the escrow; apply the wallet cap on the destination when it is not the escrow; allow.
  4. Otherwise (wallet-to-wallet): **always reject** (`DirectTransferForbidden`). Lockup, allowlist and cap are therefore enforced by construction: only the window module can move units, and it checks lockup, report acceptance, allowlist and cap itself.
  - Burns via the permanent delegate (vault) never invoke the hook; redemption, retirement and extinguishment burns always work.
- Wallet cap check used by the window: `destination_balance_after ≤ floor(units_outstanding × wallet_cap_bps / 10000)` where `units_outstanding = mint.supply`.

### 4.2 EVM

- T-REX v4 (`@tokenysolutions/t-rex` 4.1.6, GPL-3.0) deployed by the Merces deploy script behind T-REX's own proxies/implementation authority (owner = timelock). One `Token` per sealed-bid series (`decimals = 0`), one shared `IdentityRegistry` (+ storage), `TrustedIssuersRegistry`, `ClaimTopicsRegistry` with **no required claim topics**, one `ModularCompliance` per token with the `MercesComplianceModule` bound.
- Allowlist on EVM **is** identity-registry membership: `MercesRegistry.isAllowed(w) == identityRegistry.isVerified(w)`; the allowlist manager is an agent of the identity registry and registers each wallet with an ONCHAINID `Identity` deployed from `@onchain-id/solidity`'s `IdFactory` (country code 0). Removal = `deleteIdentity`.
- `MercesComplianceModule.moduleCheck(from, to, value, compliance)` returns true only when `from` or `to` is the series' `MercesWindow` escrow address (window escrow movements), or `from == address(0)` (mint) with `to` verified, or `to == address(0)` (burn). Everything else is false → direct transfers revert. `MercesVault` and `MercesWindow` are token agents (needed for `burn` and for escrow bookkeeping); the window applies lockup/report/cap checks itself, mirroring Solana. Wallet cap on the window: `balanceOf(buyer) + fill ≤ totalSupply × wallet_cap_bps / 10000`.
- Charter fields never live in the token.

---

## 5. Raise path

### 5.1 Auction state (D3)

```
Auction (per series) {
  state (mirrors RaiseState), opened_at, commit_end = opened_at + commit_duration, reveal_end = commit_end + reveal_duration,
  escrow_total: u64, bid_count: u32, revealed_count: u32,
  // settlement proposal and tally
  clearing_price: u64, q_above: u64, q_at: u64, tallied_count: u32, tally_round: u32,
  // results
  units_sold: u64, proceeds: u64, remainder_at_margin: u64 (R), units_minted: u64, bids_processed: u32,
  mint_authority_revoked: bool
}
Bid (per series × bidder; one bid per wallet) {
  bidder, commitment: bytes32, escrow: u64, reveal_index: u32,
  revealed: bool, valid: bool, price: u64, quantity: u64,
  tallied_round: u32, processed: bool, allocation: u64
}
```

### 5.2 Functions

- `open_raise(series)` — issuer; requires `raise_state == Draft`, `contract_hash != 0`, issuer allowlisted, `!new_raises_paused`, `series.mode == SealedBid`. Creates the unit mint/token (§4), sets `opened_at = now`, state `Open`; registry `mark_raise_opened`. Emits `RaiseOpened`.
- `cancel_raise(series)` — issuer; requires `Open` and `bid_count == 0`. State `Cancelled`; registry updated. Emits `RaiseCancelled`.
- `commit_bid(series, commitment, escrow)` — bidder allowlisted, `now < commit_end`, no existing bid for this wallet, `escrow > 0`. Pulls `escrow` stablecoin into the auction escrow account. Emits `BidCommitted(series, bidder, escrow)`.
- `reveal_bid(series, price, quantity, salt)` — `commit_end ≤ now < reveal_end`, bid exists and not revealed; `keccak256(price ‖ quantity ‖ salt ‖ bidder) == commitment`. Sets `revealed = true`, `reveal_index = revealed_count++`. Validity: `valid = price ≥ reserve_price && quantity ≥ 1 && quantity ≤ wallet_cap_units_at_auction && escrow ≥ required_escrow(price, quantity)` where `wallet_cap_units_at_auction = floor(units_offered × wallet_cap_bps / 10000)` and `required_escrow(p, q) = p×q + floor(p×q × auction_fee_bps / 10000)`. Invalid reveals are refunded in full at claim time. Emits `BidRevealed(series, bidder, price, quantity, valid)`. (Assumption: validity is evaluated against `units_offered`, the only base known before settlement.)
- `begin_settlement(series, proposed_clearing_price)` — anyone, `now ≥ reveal_end`, state `Open` or `Settling` (re-proposal allowed until finalized; starts a new `tally_round`, resets `q_above = q_at = tallied_count = 0`). State `Settling`.
- `tally_bids(series, page)` — anyone; for each revealed bid in the page not yet tallied in this round: `if valid: if price > clearing_price: q_above += quantity; elif price == clearing_price: q_at += quantity`; mark tallied; `tallied_count++`. Solana: bids are passed as remaining accounts (≤ 24 per instruction); EVM: `tally(fromIndex, toIndex)` over the bid array (≤ 200 per call).
- `finalize_settlement(series)` — anyone; requires `tallied_count == revealed_count`. Let `N = units_offered`, `p* = clearing_price`, `D = q_above + q_at`.
  - Valid proposal iff (a) `q_at > 0` (some bid sits exactly at p*) and (b) `q_above < N` and (c) either `D ≥ N` (oversubscribed: p* is the lowest winning price) or (`D < N` and no valid bid has `price < p*`, i.e. p* is the lowest valid price: enforced by also tracking `min_valid_price` during tally and requiring `min_valid_price == p*`). Otherwise revert `InvalidClearingPrice` (the proposer re-proposes).
  - `R = min(N − q_above, q_at)` (units for the marginal bids). `units_sold = q_above + Σ_marginal floor(R × q_i / q_at)` — computed exactly during claims; to know `units_sold` at finalize without a second pass, finalize stores `R` and `q_at` and computes `units_sold_upper = q_above + R`; the exact `units_sold` is accumulated during `claim_win` as `units_minted`. **Proceeds** are therefore transferred per winner at claim time (`p* × allocation` → treasury), not in bulk, so the treasury receives exactly `p* × units_sold`.
  - Min raise: `provisional_proceeds = p* × (q_above + R)`. Because rounding down at the margin can only reduce proceeds by `< p* × (number of marginal bids)`, and the brief requires a hard test, the check is `p* × (q_above + R) ≥ min_raise` **and** marginal rounding losses are bounded: finalize computes `units_sold_exact` by a second tally pass? — **No.** To keep one pass, marginal allocations are made deterministic without needing all bids: `alloc_i = floor(R × q_i / q_at)`, and finalize stores `R, q_at`. The exact `units_sold` is only known after all marginal bids are processed. The min-raise decision uses the **upper bound** `p* × (q_above + R)` (assumption, recorded; the difference is at most `p* × (#marginal bids − 1)` units of dust). If `p* × (q_above + R) < min_raise` → state `Failed`, `FailedRaise` emitted, all escrow refundable in full, no fees, no units.
  - Otherwise state `Settled`, `settlement_ts = now`, registry `mark_raise_result(Settled, now, units_sold_upper, p*)`; `units_sold` is finalized to the exact minted total when `bids_processed == bid_count` (`finalize_mint`), and the registry is updated again with the exact `units_sold` (registry write interface allows this one correction, only downwards and only before `finalize_mint` completes). Emits `RaiseSettled(series, p*, units_sold_upper, proceeds_upper)` and later `RaiseMintFinalized(series, units_sold, proceeds)`.
- `claim_win(series, bid)` / `process_bid` — anyone may call for any bid (push semantics so no bidder can stall settlement); each bid processed once, after `Settled` or `Failed`:
  - `Failed`: refund `escrow` in full (revealed or not).
  - `Settled`, revealed & valid & `price > p*`: `alloc = quantity`.
  - `Settled`, revealed & valid & `price == p*`: `alloc = floor(R × quantity / q_at)`.
  - `Settled`, revealed & valid & `price < p*`: `alloc = 0`.
  - `Settled`, revealed & invalid: `alloc = 0`.
  - `Settled`, **unrevealed**: `alloc = 0`, `charge = floor(escrow × non_reveal_charge_bps / 10000)` → fee collector, refund `escrow − charge`. Emits `NonRevealCharged`.
  - For `alloc > 0`: `cost = p* × alloc`; `fee = floor(cost × auction_fee_bps / 10000)`; `refund = escrow − cost − fee` (non-negative by the validity rule since `price ≥ p*`); transfer `cost` → treasury, `fee` → fee collector, `refund` → bidder; mint `alloc` units to the bidder (Solana: to the bidder's Token-2022 ATA, created if needed by the caller; EVM: `token.mint(bidder, alloc)`); `units_minted += alloc`. Emits `UnitsAllocated(series, bidder, alloc, cost, fee, refund)`.
  - `bids_processed++`; when `bids_processed == bid_count`: `finalize_mint` semantics (exact `units_sold = units_minted`, `proceeds = p* × units_sold`, revoke mint authority, registry correction). Emits `RaiseMintFinalized`.
- Maximum bids: Solana unlimited in count (each bid is a PDA; tally pages of 24; finalize O(1)); EVM `max_bids_per_auction = 4096` (array; tally pages of ≤ 200). Document CU/gas per page in `AUDIT_NOTES.md`.

### 5.3 Treasury (D4)

```
Treasury (per series) { proceeds_received: u64, released_total: u64, issuer_paused_releases: bool,
                        early_draw_total: u64, tranche_count: u8 }
```
- `deposit_proceeds` is internal (called from `claim_win`).
- `tranche_amount(i) = floor(proceeds × bps_i / 10000)` for `i < last`; last tranche = `proceeds − Σ others`, so the tranches sum exactly to proceeds. `proceeds` here is the **final** proceeds (`p* × units_sold`); releases are blocked until `RaiseMintFinalized` (the exact proceeds must be known). `vested(now) = Σ_{i : settlement_ts + at_offset_i ≤ now} tranche_amount(i)`.
- `claim_release(series)` — issuer; requires `!issuer_paused_releases && derive_status(now) != Late && status not Extinguished`; `amount = vested(now) + early_draw_total_consumed_adjustment − released_total` (early draws count against vesting: `amount = min(vested(now), proceeds) − released_total`, where `released_total` includes early draws); transfers `amount` to the issuer. Emits `ReleaseClaimed(series, amount, released_total)`. Retired/Redeemed series still release on schedule (the raise is the issuer's capital).
- `set_release_pause(series, bool)` — issuer only. Emits `ReleasePauseSet`.
- `request_early_draw(series, amount)` — issuer; requires `early_draw_approver != 0`; Solana: the approver must co-sign the instruction; EVM: `IEarlyDrawApprover(approver).approveEarlyDraw(seriesId, amount, nonce) == true` (view call) — and `released_total + amount ≤ proceeds`; transfers; `released_total += amount`. Emits `EarlyDrawExecuted`. Off by default because the approver is unset.
- On `Extinguished`: `unreleased = proceeds − released_total` is moved to the vault as a final no-fee distribution (§6.9).

Stablecoin handling on Solana: every transfer uses `transfer_checked` with the mint's own token program; for Token-2022 mints the program resolves transfer-hook extra accounts via `spl_token_2022::onchain::invoke_transfer_checked` with the remaining accounts supplied by the caller, and **asserts** that if a `TransferFeeConfig` extension exists both `transfer_fee_basis_points == 0` and `maximum_fee == 0` for the current and the newer epoch config, else `TransferFeeNotZero`. `stablecoin_decimals` is read from the mint at series creation.

---

## 6. Repayment path

### 6.1 Ledger state (D6/D7/D8 shared, per series)

```
Ledger {
  status: SeriesStatus, first_period: u32, last_accepted_period: u32|none, last_paid_period: u32|none,
  open_due_period: u32|none, open_due_amount: u64, open_due_tier: u8,
  router_credit: u64, trueup_due: u64, trueup_deadline: u64, trueup_credit folded into router_credit,
  // pauses
  pause_nonce: u64, pause_requested: bool, pause_start: u64, pause_end: u64, paused_total: u64,
  formal_notice_emitted_for: u32|none,
  // cap and accumulators
  cap_per_unit: u64 (= floor(cap_multiple_wad × P0 / WAD)), paid_per_unit_wad: u128, net_acc_wad: u128, carry: u64 (undistributed dust),
  units_outstanding: u64 (mirrors supply), year_gross_wad: [u128; 64] indexed by settlement year, 
  fee_collected: u64, gross_received: u64, refunded_to_issuer: u64,
  // commitments
  last_income_commitment: bytes32, last_income_period: u32|none,
  // redemption and tail
  redemption_ts: u64, redemption_price: u64, units_at_redemption: u64, tail_cap_per_unit: u64, tail_acc_wad: u128, tail_paid_per_unit_wad: u128,
  // extinguishment
  final_acc_wad: u128, extinguish_nonce: u64, amendment_nonce mirrored from registry
}
Holder (per series × wallet) { registered: bool, last_net_acc_wad: u128, pending: u64, redeemed_units: u64, last_tail_acc_wad: u128, last_final_acc_wad: u128 }
Report (per series × period) { accepted_at, payment_usd, fx_avg_wad, fx_fallback: bool, tier, liquidity_event, income_commitment, accrual_paid: u64, paid_at }
```

`units_outstanding` is `mint.supply` (Solana, read from the mint each time) / `token.totalSupply()` (EVM). First report period `first_period = period_of(settlement_ts)`.

### 6.2 ProofOfIncome verifier (D6)

`submit_report(series, period, payment_usd, fx_avg_wad, fx_fallback_sig|none, income_commitment, tier, liquidity_event, proof, attestation_sig)`:

1. Caller is the issuer (Solana signer / EVM `msg.sender`). Keepers may **not** submit reports (reports are the issuer's act; C11 §3).
2. `status ∉ {Extinguished}`; if `status == Retired` → reports are not accepted (nothing owed). If `status == Redeemed` → accepted only when `liquidity_event == true` and `now ≤ redemption_ts + tail_seconds` (§6.8); otherwise `period == next expected period` where next = `first_period` if none accepted else `last_accepted_period + 1`; and `now ≥ period_end(period)` (no early reports) and no `open_due_amount > 0` (the previous period must be paid first).
3. `tier` must be enabled in `series.tier_flags`; tier 4 additionally requires `tier4_enabled`.
4. FX: if `series.fx_pair_id == 0`: `fx_avg_wad` must equal `WAD`. Else let `(ok, avg) = quarter_average(pair, period)` (§6.6): if `ok` → `fx_avg_wad == avg` and no fallback signature; if `!ok` (NeedsFallback) → a valid attestor signature over the FX message for `(series, period, fx_avg_wad)` is required and `fx_fallback = true`.
5. Prior commitment: `prior = (last_income_period is in the same year_of(period) && last_income_period == period − 1) ? last_income_commitment : ZERO_INCOME_COMMITMENT`. (Because reports are sequential, the only other case is the first quarter of a year or the first report ever.)
6. Groth16 verify with public inputs **in this order**: `[terms_commitment, units_outstanding, fx_avg_wad, prior, income_commitment, payment_usd]` (all as field elements, big-endian). `terms_commitment` is read from the registry.
7. Attestation: tier 2 → signature by an active verifier key; tier 3 → by an active attestor; tier 4 → none (issuer signature is the tx); tier 1 → **none** (tier-1 series still submit the quarterly proof; the onchain router already moved money; see §6.5). Message per §1.4.
8. Effects: store `Report`; `last_accepted_period = period`; `last_income_commitment/period` updated; `credit_used = min(router_credit, payment_usd)`; `router_credit −= credit_used`; `due = payment_usd − credit_used`; if `due == 0` → `last_paid_period = period`, emit `ReportAccepted` + `PaymentSettled(…, 0)`; else `open_due_period = period`, `open_due_amount = due`. `sync_status(now)`. Emits `ReportAccepted(series, period, payment_usd, fx_avg_wad, fx_fallback, tier, liquidity_event, income_commitment, due)`.

`pay(series)` — issuer (or anyone paying on the issuer's behalf; funds come from the caller): requires `open_due_amount > 0`. `accrual = late_accrual(open_due_period, open_due_amount, now)` (§6.4). `total = open_due_amount + accrual`; pull `total` from the payer; `vault_receive_gross(total)` (§6.3); `Report.accrual_paid = accrual`; `last_paid_period = open_due_period`; clear `open_due_*`; `sync_status(now)`. Emits `PaymentSettled(series, period, gross = total, accrual, fee, accepted, refunded)`. Partial payments are not supported (assumption).

Tier 3 true-up: `submit_trueup(series, year, adjustment_i64, attestation_ts, attestor_sig)` — issuer; signature per §1.4; `adjustment > 0` → `trueup_due += adjustment`, `trueup_deadline = attestation_ts + trueup_days × DAY` (no accrual before the deadline; after it, accrual as for a late payment with `grace_end := trueup_deadline`); `adjustment < 0` → `router_credit += |adjustment|` (credited forward). `pay_trueup(series)` pulls `trueup_due + accrual` into the vault like `pay`. Emits `TrueUpRecorded`, `TrueUpPaid`.

### 6.3 Payout vault accounting (D7, C6)

`vault_receive_gross(G, source ∈ {Payment, Router, Tail, Final})` with `N = units_outstanding` (`> 0` required; if `N == 0` the series is already fully burned → revert `NoUnitsOutstanding`):

```
cap_wad     = cap_per_unit × WAD
inc_wad     = floor(G × WAD / N)
if paid_per_unit_wad + inc_wad < cap_wad:
    accepted = G
else:
    remaining_wad = cap_wad − paid_per_unit_wad
    accepted      = floor(remaining_wad × N / WAD)
    inc_wad       = floor(accepted × WAD / N)
    refund        = G − accepted            → issuer (same tx)
    retire()                                 // status Retired, registry.mark_terminal(Retired), emit SeriesRetired
paid_per_unit_wad += inc_wad
year_gross_wad[settlement_year(now)] += inc_wad          // settlement_year = floor((now − settlement_ts) / YEAR)
fee          = floor(accepted × payout_fee_bps / 10000)  → fee collector
net          = accepted − fee + carry
delta_acc    = floor(net × WAD / N)
distributed  = floor(delta_acc × N / WAD)
carry        = net − distributed
net_acc_wad += delta_acc
gross_received += accepted; fee_collected += fee
emit PayoutDistributed(series, source, gross = G, accepted, fee, net_added = net − carry_in, delta_acc_wad, paid_per_unit_wad, retired)
```
The `Tail` and `Final` sources use their own accumulators (§6.8, §6.9) and `Final` takes no fee; the pattern is the same.

Holder functions (claim path is behind `IPayoutClaims` on EVM and a dedicated instruction set on Solana so a private implementation can replace it):

- `register_holder(series, wallet)` — anyone may register any wallet that is **allowlisted now**; sets `last_net_acc_wad = net_acc_wad` (and the tail/final equivalents) if not already registered. Winners are registered automatically in `claim_win` (snapshot taken at that time; the vault has no distributions before settlement, so `last_net_acc_wad = 0`). Window buyers are registered on fill.
- `settle_holder(series, wallet)` (internal; also callable by keepers): `pending += floor((net_acc_wad − last_net_acc_wad) × balance / WAD)`; `last_net_acc_wad = net_acc_wad`. Called before any balance change of that wallet (window fills on both sides, burns) and inside `claim`.
- `claim(series)` — the registered holder (or anyone pushing to the holder): `settle_holder`; `amount = pending`; `pending = 0`; transfer `amount` stablecoin to the holder's wallet. If `status == Retired`, burn the holder's full balance after settling (permanent delegate / agent burn), `units_outstanding -= balance`. Emits `PayoutClaimed(series, holder, amount, burned_units)`. Claims never require the holder to be *currently* allowlisted (no stranding, C10).
- `burn_retired(series, holder)` — anyone, `status == Retired`: `settle_holder` then burn; the holder's `pending` stays claimable. Emits `UnitsBurned(series, holder, units, reason = Retired)`.

Invariants (tested): `Σ pending + Σ claimable ≤ vault stablecoin balance`; `paid_per_unit_wad ≤ cap_wad`; `fee_collected == Σ floor(accepted × bps / 10000)` per distribution.

### 6.4 Status derivation, deadlines and accrual

```
pause_elapsed(now): if pause_start == 0 → 0 else (min(now, pause_end) − pause_start)   // open pause, auto-closes at pause_end
effective_now(now) = now − paused_total − pause_elapsed(now)
is_paused(now)     = pause_start != 0 && now < pause_end
deadline(p)        = period_end(p) + report_due_days × DAY
grace_end(p)       = deadline(p) + grace_days × DAY
earliest_unpaid()  = open_due_period if open_due_amount > 0 else next expected period (first_period or last_accepted_period + 1)

derive_status(now):
  if status ∈ {Retired, Redeemed, Extinguished} → status
  if is_paused(now) → Paused
  p = earliest_unpaid(); e = effective_now(now)
  if e ≤ deadline(p) → OnTime ; elif e ≤ grace_end(p) → InGrace ; else → Late

late_days(p, now)  = max(0, floor((effective_now(now) − grace_end(p)) / DAY))
late_accrual(p, amount, now) = floor(amount × hurdle_rate_wad × late_days(p, now) / (365 × WAD))
```
`sync_status(now)`: when a pause has ended (`pause_start != 0 && now ≥ pause_end`): `paused_total += pause_end − pause_start; pause_start = pause_end = 0` (closing it). Then store `derive_status`; emit `StatusChanged(series, old, new)` on change; if `effective_now ≥ deadline(p) + formal_notice_days × DAY` and `formal_notice_emitted_for != p` → emit `FormalNoticeDue(series, p)` and record. `crank_status(series)` is the permissionless wrapper.

Hardship pause: `request_pause(series)` — issuer, sets `pause_requested = true` (emits `PauseRequested`, no reason stored); `approve_pause(series, pause_end, attestor_sig)` — anyone submits the attestor signature (§1.4 with `pause_nonce`): requires `pause_requested`, `pause_end > now`, not already paused; `pause_start = now`, `pause_end`, `pause_nonce++`, `pause_requested = false`; emits `PauseApproved(series, pause_start, pause_end)`. `end_pause(series)` — issuer may end early: `paused_total += now − pause_start`, clear; emits `PauseEnded`. Pauses do not stop treasury releases (C11 §1).

### 6.5 Tier 1 split router (D5)

Tier-1 series store plaintext `theta` and `r_wad` in the router (public by the issuer's choice). State: `Router { theta: u64, r_wad: u64, ytd_year: u16, ytd_received: u64 }`. Income arrives as stablecoin into the router's receiving account; anyone calls `route(series, amount)` (Solana: the router's token account balance is swept; EVM: payer calls `route(amount)` after approval, or `sweep()` moves tokens already sent):

```
if year_of_now != ytd_year: ytd_year = year_of_now; ytd_received = 0
below  = max(0, theta − ytd_received)
pass_a = min(amount, below)                 // 100% to the issuer
above  = amount − pass_a
share  = floor(r_wad × units_outstanding × above / WAD)     // to the vault (gross)
share  = min(share, above)
ytd_received += amount
transfer (amount − share) → issuer ; vault_receive_gross(share, Router) ; router_credit += accepted_share
emit IncomeRouted(series, amount, pass_through = amount − share, routed = share, ytd_received)
```
Routed amounts are credited against the quarter's report (§6.2 step 8). A tier-1 series also submits quarterly proofs; the credit mechanism reconciles. `router_credit` carries forward indefinitely.

### 6.6 Rate accumulator (C9)

```
FxPair { pair_id, feed_id, inverted, crosscheck, sum_wad: u128, count: u32, last_day: u32,
         checkpoints: map period_id → { sum_wad, count, deviation_flagged } }
```
`snapshot(pair, pyth_update)` — anyone, once per UTC day (`day = now / DAY`, require `day > last_day`):
1. Validate the Pyth price: owner/program check (Solana: `PriceUpdateV2` owned by the Pyth receiver program, `verification_level == Full`; EVM: `IPyth.getPriceNoOlderThan(feed_id, fx_max_staleness_seconds)`), `feed_id` matches, `publish_time ≥ now − fx_max_staleness_seconds`, `price > 0`, `conf × 10000 ≤ price × fx_max_conf_bps`.
2. `rate_wad = normalize(price, expo)` = `price × 10^(18 + expo)` (expo is negative) as WAD; if `inverted`: `rate_wad = floor(WAD × WAD / rate_wad)`.
3. First snapshot in a period: `checkpoints[period_of(now)] = { sum_wad, count, flagged = false }` **before** adding (this closes the previous period).
4. Cross-check: if `crosscheck` is configured (EVM `AggregatorV3Interface.latestRoundData`, fresh within staleness), `cl_wad` normalized the same way; if `|rate_wad − cl_wad| × 10000 > cl_wad × fx_deviation_band_bps` → `checkpoints[period_of(now)].flagged = true` (set for the period being accumulated) and emit `FxDeviationFlagged`.
5. `sum_wad += rate_wad; count += 1; last_day = day`. Emit `FxSnapshot(pair, day, rate_wad, sum_wad, count)`.

`quarter_average(pair, p)`: requires `checkpoints[p]` and `checkpoints[p+1]` to exist, else `NeedsFallback`. `n = count_{p+1} − count_p`; `ok = n × 10000 ≥ days_in_period(p) × fx_min_coverage_bps && !flagged_p`; `avg_wad = floor((sum_{p+1} − sum_p) / n)`. Returns `(ok, avg_wad)`; `ok == false` means `NeedsFallback` and the report must carry an attestor-signed rate (§6.2 step 4).

(Chainlink runs on EVM; on Solana `crosscheck` is left unset in this version and recorded as an assumption.)

### 6.7 Redemption (C7)

`redeem(series)` — issuer only, `status ∈ {OnTime, InGrace, Late, Paused}` (not terminal), `now ≥ settlement_ts + lockup_seconds`, `open_due_amount == 0` (the issuer must be current — assumption: redemption while a payment is outstanding would let the issuer skip a due payment; the brief forbids blocking redemption by *others*, and this is the issuer's own due):

```
t          = now − settlement_ts
Y          = floor(t / YEAR)
frac_wad   = floor((t − Y × YEAR) × WAD / YEAR)
P_hurdle   = P0
repeat Y times: P_hurdle = floor(P_hurdle × (WAD + h) / WAD)
P_hurdle   = floor(P_hurdle × (WAD + floor(h × frac_wad / WAD)) / WAD)
paid_units = ceil(paid_per_unit_wad / WAD)                 // rounds against the holders' remaining cap, i.e. favours the issuer
C_rem      = cap_per_unit − paid_units                      // ≥ 0
if Y ≥ 1: n = min(Y, 3); D_avg = floor(Σ_{y = Y−n}^{Y−1} year_gross_wad[y] / (n × WAD)); floor_term = max(P_hurdle, k × D_avg) else floor_term = P_hurdle
P_redeem   = min(C_rem, floor_term)
deposit    = P_redeem × units_outstanding
```
Pull `deposit` from the issuer into the vault (**no fee**). Set `status = Redeemed`, `redemption_ts = now`, `redemption_price = P_redeem`, `units_at_redemption = units_outstanding`, `tail_cap_per_unit = C_rem − P_redeem`; registry `mark_terminal(Redeemed)`. Emits `SeriesRedeemed(series, P_redeem, P_hurdle, D_avg, C_rem, units, deposit)`.

`claim_redemption(series)` — holder (or anyone pushing): `settle_holder`; `units = balance`; `redeemed_units = units` (recorded once); `amount = pending + P_redeem × units`; `pending = 0`; burn `units`; transfer `amount`. Emits `RedemptionClaimed(series, holder, units, amount)`.

### 6.8 Tail clause

A report accepted while `status == Redeemed` with `liquidity_event == true` and `now ≤ redemption_ts + tail_seconds` (via `submit_report`, proof and attestation as usual; `units_outstanding` public input := `units_at_redemption`) creates a due amount paid with `pay`, routed to `vault_receive_tail(G)`:

```
N = units_at_redemption; cap_wad = tail_cap_per_unit × WAD
inc_wad = floor(G × WAD / N); if tail_paid_per_unit_wad + inc_wad > cap_wad: accepted = floor((cap_wad − tail_paid_per_unit_wad) × N / WAD); inc_wad = floor(accepted × WAD / N); refund G − accepted → issuer else accepted = G
tail_paid_per_unit_wad += inc_wad; fee = floor(accepted × payout_fee_bps / 10000); net = accepted − fee; tail_acc_wad += floor(net × WAD / N); carry handled as in §6.3
```
`claim_tail(series)` — holder with `redeemed_units > 0`: `amount = floor((tail_acc_wad − last_tail_acc_wad) × redeemed_units / WAD)`; update; transfer. If `tail_cap_per_unit == 0` (P_redeem equalled C_rem) tail reports are rejected (`NoTailDue`). Emits `TailDistributed`, `TailClaimed`.

### 6.9 Extinguishment (C11 §6)

`extinguish(series, sig_a, sig_b)` — anyone submits two signatures from **two distinct** active attestors over the §1.4 message with `extinguish_nonce`; `status` not terminal (Redeemed series within the tail may also be extinguished: the tail ends). Effects: `status = Extinguished`; registry `mark_terminal`; `unreleased = proceeds − released_total` moved from the treasury to the vault with **no fee**: `final_acc_wad += floor(unreleased × WAD / N)` with `N = units_outstanding` (or `units_at_redemption` when already redeemed — then `redeemed_units` weights are used), carry as usual; all open dues are cleared (nothing else is owed). Emits `SeriesExtinguished(series, unreleased)`. `claim_final(series)` — holder: `settle_holder` (pending payouts) + `floor((final_acc_wad − last_final_acc_wad) × units / WAD)`; burn units; transfer. Emits `FinalClaimed`.

---

## 7. Transfer window (D9)

```
Window (per series × period) { state: Closed|Commit|Reveal|Settling|Settled|NoMatch, opens_at, commit_end, reveal_end,
  bid_count, ask_count, revealed_bids, revealed_asks, escrow_units, escrow_stable,
  clearing_price, d_above, d_at, s_below, s_at, max_bid, min_ask, tallied, tally_round, matched_units, processed }
Order { owner, side: Bid|Ask, commitment, escrow (stable for bids, units for asks), reveal_index, revealed, valid, price, quantity, tallied_round, processed, fill }
```
- `open_window(series, period)` — anyone; requires `windows_enabled`, `status ∈ {OnTime, InGrace}` (not Late/Paused/terminal), `now ≥ settlement_ts + lockup_seconds`, the report for `period` accepted and paid (`last_paid_period ≥ period`), `period == period_of(now) − 1` (the window follows the just-reported quarter), no window open for the series. `commit_end = now + window_commit_duration`, `reveal_end = commit_end + window_reveal_duration`. Emits `WindowOpened`.
- `commit_ask(series, commitment, units)` — holder; `settle_holder(owner)` first; move `units` into the window escrow token account (Solana: transfer passes the hook because the destination is the escrow; EVM: `token.transferFrom` passes compliance because `to == window`); one ask per wallet. `commit_bid(series, commitment, escrow)` — allowlisted wallet; pulls stablecoin; one bid per wallet.
- `reveal_order(series, price, quantity, salt)` — in the reveal phase; commitment check as §1.3; validity: `price ≥ 1`, `quantity ≥ 1`; asks: `quantity ≤ escrow_units`; bids: `escrow ≥ price × quantity + floor(price × quantity × window_fee_bps / 10000)` and `quantity ≤ wallet_cap_units − balance(owner)` where `wallet_cap_units = floor(units_outstanding × wallet_cap_bps / 10000)`.
- `begin_window_settlement(series, clearing_price | NO_MATCH)`, `tally_orders(page)`: for valid revealed orders: bids `price > p*` → `d_above += q`, `== p*` → `d_at += q`, track `max_bid`; asks `price < p*` → `s_below += q`, `== p*` → `s_at += q`, track `min_ask`.
- `finalize_window(series)`: let `S = s_below + s_at`, `D = d_above + d_at`. If proposal is `NO_MATCH`: require `max_bid < min_ask` (or no valid orders) → state `NoMatch`. Else require `d_above < S ≤ D` and `s_at > 0 || d_at > 0 at the relevant side` — precisely: `S > 0`, `d_above < S`, `S ≤ D`, and (`s_at > 0` or `d_at > 0`) so that p* is a revealed price; this p* is the unique volume-maximizing crossing (proof in `ARCHITECTURE.md`). `matched_units = S`; `R = S − d_above` for bids at p*. State `Settled`. Emits `WindowCleared(series, period, p*, matched_units)`.
- `process_order(order)` — anyone, once per order: asks with `price ≤ p*`: `fill = quantity` (all supply at or below p* is sold), receive `p* × fill` stablecoin, and `quantity − fill` units back (asks with `price > p*`: all units back). Bids `price > p*`: `fill = quantity`; `== p*`: `fill = floor(R × quantity / d_at)`; `< p*`: 0. Buyer pays `cost = p* × fill`, `fee = floor(cost × window_fee_bps / 10000)` → fee collector, refund the rest; `settle_holder(buyer)` then units move from escrow to the buyer (hook/compliance allow escrow → wallet; cap re-checked); buyer registered as holder. Rounding: `Σ bid fills ≤ S`; the unmatched remainder `U = S − Σ fills` (fewer units than marginal bids) is returned to the asks at `p*` in **descending reveal-index order** during a final `return_dust` pass (Solana: the keeper passes the marginal asks; EVM: iterates the marginal asks from the last revealed), so every unit is accounted for. Emits `OrderFilled(series, period, owner, side, fill, price, fee, refund)`.
- Direct transfers remain impossible at all times; only this module moves units between wallets.

---

## 8. ZK reference circuit (D6)

`circuits/report.circom` (circom 2.2.x, Groth16, BN254, snarkjs). Public inputs in order `[terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd]`. Private: `theta, r_wad, currency_code, indexing_rule, terms_salt, income_ytd, income_salt, prior_income_ytd, prior_salt`.

Constraints:
1. `terms_commitment === Poseidon(5)(theta, r_wad, currency_code, indexing_rule, terms_salt)`
2. `income_commitment === Poseidon(2)(income_ytd, income_salt)`; `prior_income_commitment === Poseidon(2)(prior_income_ytd, prior_salt)`
3. Range checks: `income_ytd, prior_income_ytd, theta < 2^64`; `r_wad < 2^64`; `units_outstanding < 2^64`; `fx_avg_wad < 2^64`; `income_ytd ≥ prior_income_ytd`.
4. `excess(x) = x > theta ? x − theta : 0` (comparator + mux); `owed(x) = floor(r_wad × units_outstanding × excess(x) / WAD)` with witness quotient/remainder and `remainder < WAD`, quotient `< 2^128`.
5. `payment = owed(income_ytd) − owed(prior_income_ytd)` (non-negative by monotonicity, enforced).
6. `payment_usd === floor(payment × fx_avg_wad / WAD)` with the same quotient/remainder technique.

Deliverables: `circuits/build/report.r1cs`, `report.wasm`, `report_final.zkey`, `verification_key.json` (dev ceremony: local `powersoftau` with fixed entropy strings, **not for production**, stated in `circuits/README.md`), generated `evm/src/zk/Groth16Verifier.sol` and `solana/programs/merces_protocol/src/zk/vk.rs`. The verifier cost on each chain is measured and reported in `AUDIT_NOTES.md`.

---

## 9. Curve mode (D10, Solana only)

Defined in `docs/research/METEORA_DBC.md` + `ARCHITECTURE.md` §Curve mode after the memo is in. Fixed now: `Series.mode = Curve` requires `issuer_accepts_public_price == true`, `stablecoin = USDC`; no auction, no hook, no lockup, no wallet cap; the registry records `dbc_config`, `dbc_pool`, `base_mint`; payouts use the same vault with **claim gating** (`register_holder` requires allowlist) and `units_outstanding = base_mint.supply − protocol-held units`; redemption by **tender** (`tender_units(units)` pays `P_redeem × units` and burns via the issuer-deposited funds); `P0` for cap purposes is fixed at curve activation (see memo; default = `migration_quote_threshold / units_sold_on_curve`).

---

## 10. Events (canonical names; identical fields on both chains)

Registry: `ProtocolInitialized`, `AdminTransferStarted`, `AdminTransferred`, `AllowlistManagerSet`, `FeeCollectorSet`, `FlagsSet`, `EarlyDrawApproverSet`, `DefaultsSet`, `AttestorRegistered`, `AttestorRevoked`, `VerifierKeyRegistered`, `VerifierKeyRevoked`, `FxPairSet`, `IssuerRegistered`, `IssuerDeactivated`, `IssuanceStopped`, `IssuanceResumed`, `AllowlistUpdated(wallet, allowed)`, `SeriesCreated(series, issuer, mode, stablecoin, units_offered, reserve_price, min_raise, cap_multiple_wad, hurdle_rate_wad, k, lockup_seconds, wallet_cap_bps, fees…, terms_commitment, tier_flags, fx_pair_id)`, `ContractHashSet(series, hash)`, `TermsAmended(series, nonce, new_terms_commitment, new_cap_multiple_wad, attestor)`, `RaiseStateChanged(series, state)`, `TerminalStatusSet(series, status)`.

Protocol: `RaiseOpened(series, unit_mint, opened_at, commit_end, reveal_end)`, `RaiseCancelled`, `BidCommitted(series, bidder, escrow)`, `BidRevealed(series, bidder, price, quantity, valid)`, `SettlementProposed(series, clearing_price, round)`, `RaiseSettled(series, clearing_price, units_sold_upper, proceeds_upper, settlement_ts)`, `RaiseFailed(series, clearing_price, proceeds_upper, min_raise)`, `UnitsAllocated(series, bidder, units, cost, fee, refund)`, `BidRefunded(series, bidder, refund, charge)`, `NonRevealCharged(series, bidder, charge)`, `RaiseMintFinalized(series, units_sold, proceeds)`, `MintAuthorityRevoked(series)`, `ReleaseClaimed(series, amount, released_total)`, `ReleasePauseSet(series, paused)`, `EarlyDrawExecuted(series, amount, approver)`, `ReportAccepted(series, period, payment_usd, fx_avg_wad, fx_fallback, tier, liquidity_event, income_commitment, due)`, `PaymentSettled(series, period, gross, accrual, fee, accepted, refunded)`, `PayoutDistributed(series, source, gross, accepted, fee, net_added, delta_acc_wad, paid_per_unit_wad, retired)`, `PayoutClaimed(series, holder, amount, burned_units)`, `HolderRegistered(series, holder)`, `UnitsBurned(series, holder, units, reason)`, `SeriesRetired(series, paid_per_unit_wad, refund)`, `StatusChanged(series, old, new)`, `FormalNoticeDue(series, period)`, `PauseRequested(series)`, `PauseApproved(series, start, end, attestor)`, `PauseEnded(series, paused_total)`, `IncomeRouted(series, amount, pass_through, routed, ytd_received)`, `TrueUpRecorded(series, year, adjustment, deadline)`, `TrueUpPaid(series, amount, accrual)`, `FxSnapshot(pair, day, rate_wad, sum_wad, count)`, `FxDeviationFlagged(pair, period, rate_wad, crosscheck_wad)`, `SeriesRedeemed(series, price, hurdle, d_avg, cap_remaining, units, deposit)`, `RedemptionClaimed(series, holder, units, amount)`, `TailDistributed(series, period, gross, accepted, fee, refunded)`, `TailClaimed(series, holder, amount)`, `SeriesExtinguished(series, unreleased, attestor_a, attestor_b)`, `FinalClaimed(series, holder, units, amount)`, `WindowOpened(series, period, commit_end, reveal_end)`, `OrderCommitted(series, period, owner, side, escrow)`, `OrderRevealed(series, period, owner, side, price, quantity, valid)`, `WindowCleared(series, period, clearing_price, matched_units)`, `WindowNoMatch(series, period)`, `OrderFilled(series, period, owner, side, fill, price, fee, refund)`.

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
