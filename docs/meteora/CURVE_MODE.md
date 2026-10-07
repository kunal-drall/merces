# Curve mode: how the Merces programs should treat a DBC-raised series

**Audience:** Track B (`merces_registry`, `merces_protocol`) and Track A (reference math), for implementation
after this note is accepted. **Scope:** only what the DBC program source supports (program 0.2.1, SDK 1.5.13;
citations as in `PROCEEDS_OPTIONS.md`). Everything here is a proposal recorded in `docs/assumptions/track-d.md`;
money/charter choices are flagged for Kunal.

## 1. Lifecycle and who does what

```
Merces (partner)           Issuer (creator)                     Anyone / keeper
──────────────────────     ───────────────────────────────      ─────────────────────────────
create_config  ──────────► initialize_virtual_pool_with_token2022  (base mint created by DBC)
(fee_claimer, leftover_receiver = Merces PDA)      │
                                                   ▼ buyers swap USDC → units (swap2, PartialFill at the end)
                                            quote_reserve >= X : curve complete, finish_curve_timestamp set
                                                   │
                                   create_locker (if issuer allocation)  → MigrationProgress::LockedVesting
                                   migration_damm_v2 (remaining[0] = DAMM v2 config)  → CreatedPool
withdraw_migration_fee(0) ◄──── fee ────► withdraw_migration_fee(1)
withdraw_leftover (base dust → leftover_receiver)
claim_trading_fee                          claim_creator_trading_fee
```

State machine: `PreBondingCurve (0) → [PostBondingCurve (1) → create_locker →] LockedVesting (2) → CreatedPool (3)`
(PROG/state/virtual_pool.rs:66-88; PROG/instructions/swap/process_swap.rs:343-375).

Everything above happens inside Meteora's programs. The Merces side only needs to (a) know which DBC accounts
belong to a series, (b) fix `P0` for cap accounting, (c) count units for the vault, and (d) gate claims.

## 2. Registry fields for `Series.mode == Curve` (SPEC §3.1, §9)

| Field | Type | Set when | Meaning / source |
| --- | --- | --- | --- |
| `issuer_accepts_public_price` | bool | `create_series` | Must be `true` for Curve mode (SPEC §9). The issuer explicitly accepts a live, public price. |
| `stablecoin` | mint | `create_series` | Must be the configured USDC mint; USDG is not a valid quote (brief D10; research memo §8). Decimals read from the mint (6). |
| `dbc_config` | pubkey | `activate_curve` | The DBC `PoolConfig` account created by Merces as partner. Verify on-chain: `fee_claimer == merces_curve_authority PDA`, `leftover_receiver == same`, `quote_mint == stablecoin`, `migration_option == 1`, `token_decimal == 6`, `fixed_token_supply_flag == 1`. |
| `dbc_pool` | pubkey | `activate_curve` | The `VirtualPool`; PDA `["pool", config, max(base, quote), min(base, quote)]` of the DBC program (SDK helpers/pda.ts:129-154). Verify `pool.config == dbc_config`, `pool.creator == issuer` (or the Merces PDA, see §6). |
| `base_mint` | pubkey | `activate_curve` | `pool.base_mint`; Token-2022 mint with `MetadataPointer` + `TokenMetadata`, mint authority `None` from creation (process_initialize_virtual_pool_with_token2022.rs:145-167). This is the series' `unit_mint`. |
| `units_offered` | u64 | `create_series` | `N_pub`, the public allocation in whole units; must equal `floor(config.swap_base_amount / 10^6)` ± 1 at activation (the generator makes `swap_base_amount = N_pub × 10^6` up to 2 base lamports). |
| `reserve_price` | u64 | `create_series` | Reinterpreted as the **start price per unit** (`config.sqrt_start_price` squared); informational. |
| `min_raise` | u64 | `create_series` | Reinterpreted as `migration_quote_threshold`: a DBC raise either completes at exactly `X` or never completes; there is no partial success. |
| `clearing_price` (`P0`) | u64 | `activate_curve` | Fixed from config fields, §3. |
| `raise_state` | enum | `activate_curve` → `Open`; `mark_curve_complete` → `Settled` | Curve completion is observed, not executed, by Merces: a permissionless `mark_curve_complete(series)` reads `pool.quote_reserve >= config.migration_quote_threshold` and copies `pool.finish_curve_timestamp` into `settlement_ts`. DBC has no cancel and no deadline: a pool that never reaches `X` stays `Open` indefinitely (buyers can always sell back into the curve), so `Failed`/`Cancelled` are unreachable in curve mode and staleness is an off-chain report. |
| `units_sold` | u64 | `mark_curve_complete` | `config.swap_base_amount` (design value) — see §4 for the actual-vs-design distinction. |

No `commit_duration`, `reveal_duration`, `wallet_cap_bps`, `lockup_seconds` semantics apply; store them as 0 and
reject non-zero values for Curve mode in `create_series`.

## 3. Fixing `P0` at activation (SPEC §9 default)

Default: `P0 = migration_quote_threshold / units_sold_on_curve`. Both are known at **config creation**, before any
trade, from the `PoolConfig` account alone — so `P0` can be fixed at `activate_curve`, as SPEC §9 requires, with:

```
P0_per_unit = floor( config.migration_quote_threshold × 10^config.token_decimal / config.swap_base_amount )
```

- `config.migration_quote_threshold` (`u64`, quote lamports) — PROG/state/config.rs:554-555.
- `config.swap_base_amount` (`u64`, base lamports the curve sells between `sqrt_start_price` and `migration_sqrt_price`,
  derived by the program with Rounding::Up) — PROG/state/config.rs:552-553, derived at PROG process_create_config.rs:570-578.
- `config.token_decimal` = 6.

Rounding down favours the issuer (smaller cap `C = m × P0`, C2). The generator reports the same value as
`derived.p0PerUnit` and the state reader as `p0PerUnit`; for the worked series it is exactly 10 USDC.

Why the design value and not the realised average: realised units sold = `initial_supply − base_reserve − base fee
buckets` after completion differs from `swap_base_amount` only by per-swap base rounding (≤ 1 base lamport per swap,
rounding down the output), so the realised average price is marginally **higher** than the design `P0`. Using the
design value is deterministic, available at activation, and never overstates `P0`.

Alternative Kunal may prefer: `P0 = migration price` (what the last buyer paid; 25 USDC in the example) — gives all
holders a cap 2.5× the *highest* price paid. Not recommended: early buyers' cap would be 6.25× what they paid.

## 4. Units and `units_outstanding`

The DBC program forbids 0-decimal base mints (`token_decimal` 6..=9, PROG process_create_config.rs:448-452), so
**1 HEU = 10^6 base lamports** and curve-mode units are divisible on-chain. Where the units live after migration
(all verified in the local end-to-end run, `test/local-validator.e2e.test.ts`, "conservation of base"):

| Holder of base lamports | How many | Counts as outstanding? |
| --- | --- | --- |
| Buyers' wallets (and later secondary-market wallets) | `≈ swap_base_amount` (design value minus ≤ 1 lamport per swap) | **Yes** |
| DAMM v2 pool vault (`token_a_vault` of the graduated pool) | `B_net ≈ migration_base_threshold × 0.998` | No — protocol-held liquidity, owned by locked position NFTs |
| DBC `base_vault` after migration | Meteora's protocol migration base fee (`protocol_migration_base_fee_amount`, ≈ 0.2% of the pool deposit) until Meteora claims it; plus trading-fee base buckets (0 in `QuoteToken` mode) | No (Meteora's); becomes a wallet balance when claimed — see rule below |
| Jupiter locker escrow (`deriveEscrow(deriveBaseKeyForLocker(pool))` ATA) | the issuer's allocation, vesting from `finish_curve_timestamp` | No while in escrow; **yes once claimed into the issuer's wallet** (policy flag below) |
| Merces `leftover_receiver` ATA | base dust: unsold buffer (1 lamport) + per-swap rounding + undeposited pool remainder; ≈ 3 lamports in the local run | No (protocol-held dust) |
| Burned | 0 — the generator sets `pre_migration_token_supply == post_migration_token_supply`, so nothing is burned at migration (PROG/state/config.rs:931-945) | — |

Definition for the vault:

```
protocol_held = damm_v2_token_a_vault.amount + dbc_base_vault.amount + locker_escrow_ata.amount + leftover_receiver_ata.amount
units_outstanding_base = base_mint.supply − protocol_held          // base lamports
```

Two ways to turn that into the `units_outstanding` of C3/C6, for Track A/B to pick (recommendation first):

1. **Account per base lamport** (recommended). Treat the base lamport as the accounting unit for curve-mode series:
   `units_outstanding = units_outstanding_base` (≤ 10^10 for 10,000 units, fits `u64`), `P0_base_wad = X × 1e18 /
   swap_base_amount` (quote lamports per base lamport, WAD), `C_base = m × P0_base_wad`. `paid_per_unit` is already
   WAD-scaled per unit, so nothing else changes; the issuer's share rate `r` in the terms commitment is then per base
   lamport (`r_base = r_unit / 10^6`), which Stage 2 computes off-chain when it builds the commitment. Exact, no floor
   on fractional holdings, and a holder with 0.5 units is paid for 0.5 units.
2. Whole units: `units_outstanding = floor(units_outstanding_base / 10^6)` and `P0` per unit as in §3. Fractional dust
   is never paid; simpler for the circuit's public input but the payout per unit then slightly over-weights whole units.

Reading the four balances needs four token accounts in the instruction that recomputes `units_outstanding`
(a permissionless `sync_curve_units(series)` crank that snapshots them into the ledger before each report is
accepted). Addresses: DAMM v2 pool = `["pool", damm_config, max(mints), min(mints)]` of `cpamdpZ…`
(SDK helpers/pda.ts:185), its vault = `["token_vault", mint, pool]`; DBC vault = `pool.base_vault`; locker escrow =
`["escrow", base]` with `base = ["base_locker", dbc_pool]` (SDK helpers/pda.ts `deriveBaseKeyForLocker`, `deriveEscrow`);
leftover ATA = ATA(`leftover_receiver`, base_mint, Token-2022). Meteora's claim of its base fee moves lamports from
`dbc_base_vault` to a Meteora wallet: by the definition above those lamports become "outstanding". Rule: that is
correct — any wallet-held unit is a unit, and Meteora can only be paid if it registers as an allowlisted holder,
which it will not; the unpaid share rolls over as dust (C2).

**Issuer-held units** (claimed from the locker) are outstanding by the definition above, so the issuer pays
themselves a share of their own payouts and that share counts against the cap. If Kunal prefers to exclude them,
`register_holder` can refuse the issuer wallet and `sync_curve_units` can subtract the issuer's ATA balance; both are
one-line policy switches. Flagged in `track-d.md`.

## 5. Claim gating (brief D10: gate claims, not transfers)

- The base mint has no transfer hook, no freeze authority, no permanent delegate; after graduation anyone can hold
  and trade units on DAMM v2 or anywhere else. Lockup, wallet cap and the window module **do not apply**.
- `register_holder(series, wallet)` requires `is_allowed(wallet)` (SPEC §9); `claim_payout` requires a registered
  holder record. Registration snapshots nothing: the claim path reads the holder's **current** base ATA balance
  (`units = ata.amount` in base lamports, option 1) at claim time and uses the standard reward-per-share accumulator
  with a per-holder `claimed_per_unit` checkpoint. Because units move freely, a holder's checkpoint must be
  **re-based on every balance change** or the accumulator can be gamed (buy before a payout, claim, sell): use the
  "debt" pattern (`debt = units × acc_at_last_sync`) and require `sync_holder` (recompute debt for the new balance,
  crediting pending rewards first) whenever the ATA balance differs from the recorded one. Payouts earned while units
  sat in a non-registered wallet are simply never claimed and roll over.
- Allowlist removal does not strand value (C10): the record persists; claims still work (A19).

## 6. Who is `creator`: issuer wallet or Merces PDA

DBC uses `pool.creator` for three things: the creator migration-fee share (R1), creator trading-fee/surplus claims,
and the **locker escrow recipient** (create_locker.rs:99-140). If the creator is a `merces_protocol` PDA
(`curve_authority` per series, signer by CPI), the protocol can force R1 into the series treasury but then owns the
vesting escrow (the locker's `update_recipient_mode = 2` only lets the recipient change it; the PDA could pass it on by
CPI, extra code). If the creator is the issuer wallet, the escrow is theirs but R1 is withdrawn wherever the issuer
points it. The `PROCEEDS_OPTIONS.md` recommendation sidesteps the conflict: creator = issuer wallet, migration fee
routed to the **partner** (`creator_fee_percentage = 0`), `fee_claimer` = Merces PDA which withdraws straight into
the series treasury by CPI. Pending Kunal (Q3), the registry should store `dbc_creator` explicitly and `mark_curve_complete`
should accept either arrangement.

## 7. Treasury, releases, redemption and retirement

- **Treasury (D4):** the migration-fee withdrawal is the deposit. With the partner route it is a CPI from
  `merces_protocol::collect_curve_proceeds(series)` (permissionless after `mark_curve_complete`) into
  `withdraw_migration_fee(0)` with `token_quote_account = treasury ATA`; releases then follow the series schedule from
  `settlement_ts = finish_curve_timestamp`. Also claim the partner trading fees into the fee collector
  (`claim_trading_fee`, signer = the same PDA).
- **Cap and retirement (C6, D7):** unchanged; at the cap, claims end and the series is `Retired`. There is no forced burn
  (no permanent delegate): retired units simply stop paying; `burn_retired_units` is replaced by nothing. Document on
  the token metadata that units of a retired series are worthless.
- **Redemption by tender (C7):** `redeem_series` deposits `P_redeem × units_outstanding_base / 10^6` (option 1 scaling)
  and sets `Redeemed`; `tender_units(series, amount)` transfers `amount` base lamports from the holder's ATA to a
  `redemption_escrow` ATA owned by the vault PDA and pays `P_redeem × amount / 10^6` quote (rounding down). Tendered units
  are burned by the vault (Token-2022 `burn` on its own ATA needs no permanent delegate). `units_outstanding` for the
  deposit is the snapshot at redemption; units never tendered leave dust in the vault (C2). Tail clause (C7) uses the
  tendered units per holder as "units at redemption".
- **Extinguishment:** unchanged; pro-rata uses the same base-lamport units.
- **Transfer window (D9):** not applicable; DAMM v2 is the secondary market.

## 8. What changes versus sealed-bid mode

| Topic | Sealed-bid (D3) | Curve (D10) |
| --- | --- | --- |
| Primary sale | Commit–reveal auction in `merces_protocol`, uniform clearing price | Meteora DBC bonding curve; price rises from `P_start` to `P_mig`; completion at `X` |
| Who holds the raise during the sale | Merces escrow PDAs | DBC `quote_vault` (pool authority PDA); nobody can withdraw |
| Proceeds to treasury | Settlement moves cleared proceeds to the treasury | `withdraw_migration_fee` moves `f%` of `X` (99% default); the rest is DAMM v2 liquidity |
| Backer fee | 1% of cleared bids to the fee collector | 1% quote trading fee per swap: 0.8% to Merces (partner), 0.2% to Meteora |
| Failed raise | Below `min_raise` → refunds, no fee | Never completes; buyers keep units, can sell back into the curve; no refunds, fees not returned |
| Unit mint | Token-2022 by `merces_protocol`, 0 decimals, TransferHook + PermanentDelegate, mint authority revoked at settlement | Token-2022 by DBC, 6 decimals, MetadataPointer + TokenMetadata only, mint authority `None` from creation |
| `P0` | Clearing price | `floor(X × 10^6 / swap_base_amount)` from the config at activation |
| `units_sold` | Winning quantity | `swap_base_amount` (design) ≈ realised |
| `units_outstanding` | `mint.supply` (whole units) | `supply − pool vault − DBC vault − locker escrow − leftover` (base lamports) |
| Lockup / wallet cap / window-only transfers | Enforced by the hook | None; free trading on DAMM v2 and elsewhere |
| Payout claims | Holder registered at mint/window fill | `register_holder` requires allowlist; claim reads current balance; debt-pattern sync |
| Retirement at cap | Units burned via permanent delegate | Claims end; no burn |
| Redemption | Deposit + burn via permanent delegate | Deposit + holder-initiated tender; vault burns tendered units |
| Transfer window | Required after lockup | Not applicable |
| Issuer allocation | None | Optional, vested via Jupiter locker from graduation |
| Secondary market | Quarterly call auction | DAMM v2 pool (depth = what the issuer did not take) |
| Public price | None until a window clears | Live, public; `issuer_accepts_public_price = true` recorded |
| External dependencies | None | DBC, DAMM v2, Jupiter locker programs; Meteora's DAMM v2 config keys; manual migrator or own keeper on devnet |

## 9. Open items for Track B

1. `activate_curve` account validation list (§2) and the `dbc_creator` choice (§6, Kunal Q3).
2. `sync_curve_units` crank reading the four protocol-held balances (§4) before `accept_report`.
3. Debt-pattern holder sync for freely moving units (§5).
4. `collect_curve_proceeds` CPI into DBC (`withdraw_migration_fee`, `claim_trading_fee`) with the PDA signer, including the
   Token-2022 base/quote program selection (`config.quote_token_flag`, PROG/state/config.rs:529-530).
5. Tender redemption instructions (§7).
