# Meteora Dynamic Bonding Curve (DBC) — Integration Research Memo

Status: research memo compiled offline from local clones only (docs.meteora.ag network access was blocked).
Date: 2026-10-07.

## 0. Sources, versions, and path abbreviations

All claims below are cited as `file:line` into these three read-only clones:

| Abbrev | Absolute path | What it is | Version observed |
| --- | --- | --- | --- |
| `DOCS` | `/home/user/meteoraag/docs` | Source of docs.meteora.ag (MDX) | Describes program `0.2.1`, SDK `1.5.12` (`DOCS/developer-guides/dbc/changelog.mdx:14-27`) |
| `PROG` | `/home/user/meteoraag/dynamic-bonding-curve/programs/dynamic-bonding-curve/src` | On-chain Anchor program `dynamic_bonding_curve` | `0.2.1` is the latest entry in `/home/user/meteoraag/dynamic-bonding-curve/CHANGELOG.md:24`; Anchor `1.0.2`, Solana `3.1.10` (`/home/user/meteoraag/dynamic-bonding-curve/Anchor.toml:17-19`) |
| `SDK` | `/home/user/meteoraag/dynamic-bonding-curve-sdk/packages/dynamic-bonding-curve/src` | TypeScript SDK source | `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13` (`/home/user/meteoraag/dynamic-bonding-curve-sdk/packages/dynamic-bonding-curve/package.json:2-3`; CHANGELOG entry dated 2026-09-24 at `.../CHANGELOG.md:5`) |
| `SDKDOC` | `/home/user/meteoraag/dynamic-bonding-curve-sdk/packages/dynamic-bonding-curve/docs.md` | SDK function documentation (5063 lines) | matches 1.5.x |

Naming conventions: Rust/IDL field names are `snake_case`; the SDK exposes the same fields in `camelCase` (Anchor IDL types). Where a field is mentioned, the Rust name is given first and the SDK name in parentheses when they differ beyond casing.

Fee-numerator convention: every on-chain percentage fee numerator is over `FEE_DENOMINATOR = 1_000_000_000` (`PROG/constants.rs:72`). 25 bps = `2_500_000`; 99% = `990_000_000`.

---

## 1. Program IDs, pool authority, clusters

| Program | ID | Source |
| --- | --- | --- |
| DBC `dynamic_bonding_curve` | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | `PROG/lib.rs:29` (`declare_id!`); `SDK/constants.ts:75-77` |
| DAMM v2 `cp_amm` | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | `SDK/constants.ts:84-86`; `/home/user/meteoraag/dynamic-bonding-curve/idls/damm_v2.json:2`; `DOCS/developer-guides/damm-v2/index.mdx:90-95` |
| DAMM v1 (deprecated target) | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` | `SDK/constants.ts:81-83` |
| Jupiter Locker (used by `create_locker`) | `LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn` | `SDK/constants.ts:90-92` |
| Dynamic Vault (DAMM v1 only) | `24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi` | `SDK/constants.ts:87-89` |
| Metaplex Token Metadata (SPL base mints) | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | `SDK/constants.ts:78-80` |
| Protocol fee wrapper program (signer for `claim_protocol_fee2`) | `pFee3tb7qh5z53jRF4PbLwmNd148Q8ypLNZbqsMeinA` | `PROG/constants.rs:129-137` |

Pool authorities (PDAs, seed `b"pool_authority"`, no extra seeds):

| Authority | Address | Source |
| --- | --- | --- |
| DBC pool authority (owns both DBC vaults, signs all CPIs, is `creator`/`payer`/`pool_creator_authority` of the migrated DAMM v2 pool) | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` | derived at compile time `PROG/const_pda.rs:4-14` from seed `PROG/constants.rs:115`; address stated in `DOCS/developer-guides/dbc/index.mdx:59-63` and `DOCS/developer-guides/dbc/program/accounts.mdx:22`; SDK `deriveDbcPoolAuthority()` `SDK/helpers/pda.ts:87-94` |
| DAMM v2 pool authority | `HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC` | `DOCS/developer-guides/damm-v2/index.mdx:97-101`; `idls/damm_v2.json:144`; SDK `deriveDammV2PoolAuthority()` `SDK/helpers/pda.ts:113-120` |
| DBC protocol fee authority (PDA of the protocol-fee program, seed `b"protocol_fee_authority"`) | derived, not printed in clones | `PROG/const_pda.rs:16-26`, `PROG/constants.rs:134-136` |

Cluster identity: the DBC program ID is identical on mainnet-beta and devnet (`DOCS/developer-guides/dbc/index.mdx:50-57`; `/home/user/meteoraag/dynamic-bonding-curve/README.md:98-101`; SDK README `.../README.md:77-80`). The DAMM v2 program ID is identical on mainnet-beta and devnet (`DOCS/developer-guides/damm-v2/index.mdx:90-95`). Because the pool-authority PDAs depend only on the program ID and a constant seed, they are also identical across clusters. The SDK carries one set of constants with no per-cluster switch (`SDK/constants.ts` has no cluster branching).

DAMM v2 "migration fee" config keys (passed as remaining account 0 to `migration_damm_v2`; exported as `DAMM_V2_MIGRATION_FEE_ADDRESS[i]`, `SDK/constants.ts:107-116`; also `DOCS/developer-guides/dbc/index.mdx:129-139`):

| `migration_fee_option` | Graduated pool LP fee | DAMM v2 config key |
| --- | --- | --- |
| 0 `FixedBps25` | 25 bps | `7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd` |
| 1 `FixedBps30` | 30 bps | `2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k` |
| 2 `FixedBps100` | 100 bps | `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` |
| 3 `FixedBps200` | 200 bps | `2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq` |
| 4 `FixedBps400` | 400 bps | `AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD` |
| 5 `FixedBps600` | 600 bps | `DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u` |
| 6 `Customizable` | from `migrated_pool_fee` | `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` |

The docs do not label these keys per cluster; the SDK uses the same array regardless of connection. See §10 for the unverified devnet aspect.

Mainnet migration keepers (mainnet only; `DOCS/core-products/dbc/migration-and-liquidity.mdx:116-144`, `DOCS/developer-guides/dbc/index.mdx:80-108`): `Asi5DTGEeiso6k7ya6ndDabEZ7DRCgfTpCBLPH5E3aQs` and `DeQ8dPv6ReZNQ45NfiWwS5CchWpB2BVq1QMyNV8L2uSW`. They migrate a completed pool when `pool_config.migration_quote_threshold` matches exactly one of: SOL 10, USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) 750, TRUMP 100, JUP 1500, USD1 750, MET 1500, JupUSD 750, VIRTUAL 42000; or the quote is a Stock Token with threshold >= 750 USD equivalent; or the quote token is Jupiter Verified with Organic Score > 50 and the threshold's notional > 750 USD. The keepers run on mainnet; the manual migrator at `https://migrator.meteora.ag` supports mainnet and devnet (`DOCS/developer-guides/dbc/index.mdx:106-108`).

---

## 2. Partner / creator model

Roles are defined by two addresses:

- **Partner** = `PoolConfig.fee_claimer` (`PROG/state/config.rs:503-504`). Fixed at config creation; it is the only authority for partner-side claims (`is_partner_fee_claimer`, `PROG/access_control.rs:25-33`). The partner also receives "update authority" when `token_update_authority` is a Partner option (passed as `config.fee_claimer` in `PROG/instructions/initialize_pool/process_initialize_virtual_pool_with_token2022.rs:90-91,145-146`).
- **Creator** = `PoolState.creator` (`PROG/state/virtual_pool.rs:97-98`), set to the `creator` signer of the pool-initialization instruction (`PROG/instructions/initialize_pool/ix_initialize_virtual_pool_with_spl_token.rs:60,263`). Guard: `is_pool_creator` (`PROG/access_control.rs:35-40`). Transferable via `transfer_pool_creator` (`PROG/instructions/creator/ix_transfer_pool_creator.rs:29-100`) only while `migration_progress` is `PreBondingCurve` or `CreatedPool` (for DAMM v1 pools, only after LP claims/locks are done); `new_creator != creator` (`:23-26`).
- **Protocol** = Meteora; collects via `claim_protocol_fee2` signed by the protocol fee authority PDA (`PROG/instructions/operator/ix_claim_protocol_fee2.rs:41-42,77-80`), and pool-creation fee via an `Operator` with `ClaimProtocolFee` permission (`PROG/lib.rs:55-61`, `PROG/state/operator.rs:20-25`).

Who does what (`DOCS/core-products/dbc/accounts-and-permissions.mdx:54-75`):

| Action | Instruction | Required signer |
| --- | --- | --- |
| Create config (launch template) | `create_config` / `create_config_with_transfer_hook` (`PROG/lib.rs:89-101`) | Any `payer`; the new `config` account must also sign (`DOCS/developer-guides/dbc/typescript-sdk/examples.mdx:126`). `fee_claimer` and `leftover_receiver` are baked in. |
| Create virtual pool + base mint | `initialize_virtual_pool_with_spl_token` / `..._with_token2022` / `..._with_token2022_transfer_hook` (`PROG/lib.rs:144-167`) | `creator` signs; `payer` "can be anyone" (`ix_initialize_virtual_pool_with_spl_token.rs:132-134`); `base_mint` keypair signs (`:62-70`). Pays `pool_creation_fee` lamports if configured (`:244-252`). |
| Claim partner trading fees | `claim_trading_fee(max_amount_a, max_amount_b)` / `claim_trading_fee2(..., TransferHookAccountsInfo)` (`PROG/lib.rs:103-127`) | `fee_claimer` |
| Claim creator trading fees | `claim_creator_trading_fee(max_base_amount, max_quote_amount)` / `claim_creator_trading_fee2` (`PROG/lib.rs:178-202`) | `creator` |
| Partner surplus | `partner_withdraw_surplus` (`PROG/lib.rs:137-142`) | `fee_claimer` |
| Creator surplus | `creator_withdraw_surplus` (`PROG/lib.rs:204-209`) | `creator` |
| Migration fee | `withdraw_migration_fee(flag)` — `flag` 0 = partner, 1 = creator (`PROG/lib.rs:217-221`, `PROG/instructions/migration/ix_withdraw_migration_fee.rs:59-63,99-128`) | `fee_claimer` for flag 0; `creator` for flag 1 (checked in handler) |
| Partner pool-creation fee | `claim_partner_pool_creation_fee` (`PROG/lib.rs:129-135`) | `fee_claimer` (SOL lamports, paid to `fee_receiver`) |
| Leftover base tokens | `withdraw_leftover` (`PROG/lib.rs:264-268`) | Permissionless, but funds go only to `leftover_receiver`'s ATA (`PROG/instructions/migration/withdraw_leftover.rs:26-32,54-59`) |
| Migration steps | `create_locker`, `migration_damm_v2` (`PROG/lib.rs:257-262,311-314`) | Permissionless (`payer` signs; first-position NFT mint keypair signs) |

### 2.1 Trading fee split (bonding phase)

Per swap, the total fee numerator = base fee + dynamic fee, capped at `MAX_FEE_NUMERATOR = 990_000_000` (`PROG/state/config.rs:119-137`). Then (`PROG/state/config.rs:139-172`):

- `protocol_fee = floor(trading_fee * PROTOCOL_FEE_PERCENT / 100)` with `PROTOCOL_FEE_PERCENT = 20` (`PROG/constants.rs:94`).
- If a referral token account is present: `referral_fee = floor(protocol_fee * HOST_FEE_PERCENT / 100)` with `HOST_FEE_PERCENT = 20` (`PROG/constants.rs:96`), subtracted from the protocol fee.
- LP fee = `trading_fee - protocol_fee` is split by `PoolConfig::split_partner_and_creator_fee` (`PROG/state/config.rs:1014-1033`): `creator_fee = floor(fee * creator_trading_fee_percentage / 100)`, `partner_fee = fee - creator_fee`. If `creator_trading_fee_percentage == 0` everything goes to the partner.
- Accrued into `PoolState.partner_base_fee / partner_quote_fee / creator_base_fee / creator_quote_fee / protocol_base_fee / protocol_quote_fee` (`PROG/state/virtual_pool.rs:109-116,143-146`) in `apply_swap_result` (`:960-977`). Fees are **excluded from `quote_reserve` / `base_reserve`** (`:979-994`), so vault balance = reserve + fee buckets.
- Field: `creator_trading_fee_percentage: u8` (`PROG/state/config.rs:543-544`), range 0..=100 (`PROG/instructions/partner/create_config/process_create_config.rs:387-391`). There is no separate "partner fee share" field: partner share = 100 − creator share of the non-protocol fee. The same percentage also splits **surplus** (§4.4).
- Trading fees are claimable at any time (no curve-completion check in `handle_claim_creator_trading_fee`, `PROG/instructions/creator/ix_claim_creator_trading_fee.rs:58-135`), capped by the `max_*` arguments; quote-side claims call `validate_transfer_fee_is_zero` on the quote mint (`:115`).

### 2.2 Pool creation fee (SOL)

`pool_creation_fee: u64` lamports (`PROG/state/config.rs:576-577`), either 0 or in `[1_000_000, 100_000_000_000]` = 0.001–100 SOL (`PROG/constants.rs:102-104`; validation `process_create_config.rs:474-481`). Transferred from the pool `payer` into the pool account at init (`ix_initialize_virtual_pool_with_spl_token.rs:244-252`). Split: protocol `floor(fee * 10 / 100)` (`PROTOCOL_POOL_CREATION_FEE_PERCENT = 10`, `PROG/constants.rs:99`; `config.rs:1035-1044`), partner gets the remainder, each claimable once (`creation_fee_bits`, `virtual_pool.rs:212-213,1219-1241`).

---

## 3. Config parameters (everything in `ConfigParameters`)

The `create_config` argument struct (`PROG/instructions/partner/create_config/process_create_config.rs:39-71`):

```rust
pub struct ConfigParameters {
    pub pool_fees: PoolFeeParameters,                 // base_fee + Option<dynamic_fee>
    pub collect_fee_mode: u8,                         // 0 QuoteToken | 1 OutputToken
    pub migration_option: u8,                         // 0 MeteoraDamm (REJECTED) | 1 DammV2
    pub activation_type: u8,                          // 0 Slot | 1 Timestamp
    pub token_type: u8,                               // 0 SplToken | 1 Token2022
    pub token_decimal: u8,                            // 6..=9
    pub partner_liquidity_percentage: u8,
    pub partner_permanent_locked_liquidity_percentage: u8,
    pub creator_liquidity_percentage: u8,
    pub creator_permanent_locked_liquidity_percentage: u8,
    pub migration_quote_threshold: u64,               // quote lamports
    pub sqrt_start_price: u128,                       // Q64.64
    pub locked_vesting: LockedVestingParams,
    pub migration_fee_option: u8,                     // 0..=6
    pub token_supply: Option<TokenSupplyParams>,      // None = dynamic supply; Some = fixed supply
    pub creator_trading_fee_percentage: u8,           // 0..=100
    pub token_update_authority: u8,                   // TokenAuthorityOption 0..=4
    pub migration_fee: MigrationFee,                  // { fee_percentage: u8, creator_fee_percentage: u8 }
    pub migrated_pool_fee: MigratedPoolFee,           // { collect_fee_mode, dynamic_fee, pool_fee_bps }
    pub pool_creation_fee: u64,                       // lamports
    pub partner_liquidity_vesting_info: LiquidityVestingInfoParams,
    pub creator_liquidity_vesting_info: LiquidityVestingInfoParams,
    pub migrated_pool_base_fee_mode: u8,              // DAMM v2 BaseFeeMode
    pub migrated_pool_market_cap_fee_scheduler_params: MigratedPoolMarketCapFeeSchedulerParams,
    pub enable_first_swap_with_min_fee: bool,
    pub compounding_fee_bps: u16,
    pub padding: [u8; 2],
    pub curve: Vec<LiquidityDistributionParameters>,  // 1..=16 points of { sqrt_price: u128, liquidity: u128 }
}
```

Stored account: `PoolConfig` (1040 bytes + 8 discriminator; `PROG/state/config.rs:498-588`). Transfer-hook variant `ConfigWithTransferHook { config: PoolConfig, transfer_hook_program: Pubkey, padding }` (1120 bytes; `:590-611`).

### 3.1 Curve and price

| Parameter | Field / rule | Citation |
| --- | --- | --- |
| Start price | `sqrt_start_price: u128` (Q64.64), must satisfy `MIN_SQRT_PRICE (4295048016) <= p < MAX_SQRT_PRICE (79226673521066979257578248091)` | `process_create_config.rs:484-487`; `PROG/constants.rs:3-4` |
| Curve points | `curve: Vec<LiquidityDistributionParameters { sqrt_price, liquidity }>`; `1 <= len <= MAX_CURVE_POINT (16)`; `curve[0].sqrt_price > sqrt_start_price`; strictly increasing; every `liquidity > 0`; last `sqrt_price <= MAX_SQRT_PRICE`. Account stores 20 slots (`MAX_CURVE_POINT_CONFIG`) | `process_create_config.rs:488-512`; `PROG/constants.rs:41-43`; `PROG/params/liquidity_distribution.rs:17-21` |
| Segment math | Segment i covers `[curve[i-1].sqrt_price (or start), curve[i].sqrt_price]` with constant liquidity `curve[i].liquidity`. Quote needed through a segment = `L * (sqrtP_upper - sqrtP_lower)`; base sold = `L * (1/sqrtP_lower - 1/sqrtP_upper)` | `DOCS/core-products/dbc/formulas.mdx:29-49`; `/home/user/meteoraag/dynamic-bonding-curve/README.md:56-73` |
| Migration threshold | `migration_quote_threshold: u64 > 0`, in quote-mint base units (lamports) | `process_create_config.rs:466-469`; `PROG/state/config.rs:554-555` |
| Derived at config creation | `migration_sqrt_price` = price reached when `migration_quote_threshold` of quote has been swapped in, walking the curve with Rounding::Up (`get_migration_threshold_price`); error `NotEnoughLiquidity` if the curve cannot absorb the threshold; must be `< MAX_SQRT_PRICE`. `swap_base_amount` = base sold between start and migration price. `migration_base_threshold` = base deposited into the DAMM pool (see §4.2) | `PROG/params/liquidity_distribution.rs:66-120,32-64`; `process_create_config.rs:564-596,686-690` |
| Curve "completes" when | `quote_reserve >= migration_quote_threshold` (`is_curve_complete`) | `PROG/state/virtual_pool.rs:1122-1124` |

### 3.2 Supply

| Parameter | Rule | Citation |
| --- | --- | --- |
| Dynamic supply (`token_supply = None`) | Initial mint = `swap_base_amount * 1.25` (25% `SWAP_BUFFER_PERCENTAGE`, clamped to the max base the curve can sell up to `MAX_SQRT_PRICE`) + `migration_base_threshold` + locked-vesting total | `PROG/state/config.rs:876-929`; `PROG/constants.rs:45` |
| Fixed supply (`token_supply = Some(TokenSupplyParams { pre_migration_token_supply, post_migration_token_supply })`) | `min_without_buffer <= post <= pre` and `min_with_buffer <= pre`; `leftover_receiver != Pubkey::default()`; `fixed_token_supply_flag = 1` | `process_create_config.rs:240-248,621-658`; `PROG/state/config.rs:541-542,562-565` |
| SDK builders | Always emit `tokenSupply: { preMigrationTokenSupply: totalSupply, postMigrationTokenSupply: totalSupply }` (fixed supply) | `SDK/helpers/buildCurve.ts:248-251` |

### 3.3 Migration target and fees

| Parameter | Values | Citation |
| --- | --- | --- |
| `migration_option` | enum `MigrationOption { MeteoraDamm = 0 (deprecated, rejected for new configs/pools), DammV2 = 1 }` | `PROG/state/config.rs:425-430`; rejected `process_create_config.rs:418-421`, `ix_initialize_virtual_pool_with_spl_token.rs:164-170`; error `DeprecatedMigrationOption` 6082 |
| `migration_fee_option` | enum `MigrationFeeOption { FixedBps25=0 (0.25%), FixedBps30=1 (0.3%), FixedBps100=2 (1%), FixedBps200=3 (2%), FixedBps400=4 (4%), FixedBps600=5 (6%), Customizable=6 }`. For fixed options the DAMM v2 config's cliff fee must equal that bps and have no schedule; for Customizable, `migrated_pool_fee` is used | `PROG/state/config.rs:459-496`; `PROG/instructions/migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs:418-496` |
| `migration_fee: MigrationFee { fee_percentage, creator_fee_percentage }` | `fee_percentage <= MAX_MIGRATION_FEE_PERCENTAGE (99)`; if `fee_percentage == 0` then `creator_fee_percentage == 0`, else `creator_fee_percentage <= 100`. Stored as `migration_fee_percentage`, `creator_migration_fee_percentage` | `process_create_config.rs:73-99`; `PROG/constants.rs:58`; `PROG/state/config.rs:547-550` |
| `migrated_pool_fee: MigratedPoolFee { collect_fee_mode: u8, dynamic_fee: u8, pool_fee_bps: u16 }` | Only validated when `migration_fee_option == Customizable`; otherwise all migrated-pool fields must be zero. `pool_fee_bps` in `[MIN_MIGRATED_POOL_FEE_BPS 10, MAX_MIGRATED_POOL_FEE_BPS 1000]` (0.1%–10%). `collect_fee_mode` is `MigratedCollectFeeMode { QuoteToken=0, OutputToken=1, Compounding=2 }` mapped to DAMM v2 `OnlyB(1) / BothToken(0) / Compounding(2)`. `dynamic_fee` is `DammV2DynamicFee { Disable=0, Enable=1 }` | `process_create_config.rs:101-228,422-430`; `PROG/constants.rs:38-39`; `PROG/migration_handler/mod.rs:31-48`; `PROG/utils/damm_v2_utils.rs:24-27` |
| `compounding_fee_bps: u16` | Must be `1..=10_000` iff migrated `collect_fee_mode == Compounding`, else 0 | `process_create_config.rs:157-170` |
| `migrated_pool_base_fee_mode: u8` | DAMM v2 `BaseFeeMode { FeeTimeSchedulerLinear=0, FeeTimeSchedulerExponential=1, RateLimiter=2 (invalid here), FeeMarketCapSchedulerLinear=3, FeeMarketCapSchedulerExponential=4 }`. Time-scheduler modes act as a fixed fee (`pool_fee_bps`); market-cap modes require non-zero scheduler params | `PROG/utils/damm_v2_utils.rs:165-179`; `process_create_config.rs:177-216`; `PROG/state/config.rs:1089-1144` |
| `migrated_pool_market_cap_fee_scheduler_params` | `{ number_of_period: u16, sqrt_price_step_bps: u16, scheduler_expiration_duration: u32, reduction_factor: u64 }`, serialized into `migrated_pool_base_fee_bytes: [u8;16]` | `process_create_config.rs:230-238`; `PROG/state/config.rs:578-579,817-823` |
| Migrated-pool dynamic fee | When enabled, DBC derives DAMM v2 dynamic fee params so max dynamic fee = 20% of the migrated pool's min base fee (`MAX_DYNAMIC_FEE_PERCENT = 20`) | `PROG/utils/damm_v2_utils.rs:30-50`; `PROG/constants.rs:27` |

### 3.4 Locked vesting of base tokens (Jupiter Locker)

`locked_vesting: LockedVestingParams { amount_per_period, cliff_duration_from_migration_time, frequency, number_of_period, cliff_unlock_amount }` (all `u64`; `process_create_config.rs:250-257`). `has_vesting()` = any field non-zero; then `frequency != 0` and total `cliff_unlock_amount + amount_per_period * number_of_period != 0` (`:296-309`). At `create_locker` the escrow is created for `pool.creator` with `vesting_start_time = finish_curve_timestamp`, `cliff_time = finish + cliff_duration_from_migration_time`, `update_recipient_mode = 2` (recipient only), `cancel_mode = 1` (creator only) (`:271-287`; `PROG/instructions/migration/create_locker.rs:99-140`). Stored as `LockedVestingConfig` (`PROG/state/config.rs:336-357`). Vesting tokens are part of the initial mint (§3.2) and never enter the DAMM pool.

### 3.5 Token type, decimals, authority

| Parameter | Rule | Citation |
| --- | --- | --- |
| `token_type` | `TokenType { SplToken=0, Token2022=1 }`; pool `pool_type` mirrors it | `PROG/state/config.rs:443-446`; `PROG/state/virtual_pool.rs:61-64` |
| `token_decimal` | `6 <= d <= 9` (base mint only; quote decimals are unconstrained — SDK 1.5.13 note) | `process_create_config.rs:448-452`; SDK `CHANGELOG.md:5-9` |
| `token_update_authority` (SDK `tokenAuthorityOption`) | `TokenAuthorityOption { CreatorUpdateAuthority=0, Immutable=1, PartnerUpdateAuthority=2, CreatorUpdateAndMintAuthority=3, PartnerUpdateAndMintAuthority=4 }`. Options 3/4 only on transfer-hook configs | `PROG/state/config.rs:371-412`; `process_create_config.rs:439-446` |
| SPL base mint | Metaplex metadata created via CPI; **mint authority always revoked at pool init** (`set_authority(MintTokens, None)`); options 3/4 rejected | `ix_initialize_virtual_pool_with_spl_token.rs:186-242` |
| Token-2022 base mint | Mint created with `metadata_pointer` (authority = pool authority, metadata address = mint itself); `TokenMetadata` initialized with `update_authority = creator`, then metadata-pointer authority and token-metadata update authority set to creator / fee_claimer / None per option; mint authority set to None unless transfer-hook config with option 3/4 | `PROG/instructions/initialize_pool/ix_initialize_virtual_pool_with_token2022.rs:35-46`; `process_initialize_virtual_pool_with_token2022.rs:66-167` |

### 3.6 Quote mint constraints and token badge

Rule (`PROG/utils/token.rs:216-258`):

1. Owner = SPL Token program → always accepted.
2. Owner = Token-2022: the Token-2022 native mint (`So111...112` under Token-2022) is rejected (`UnsupportNativeMintToken2022`); the transfer fee must be zero now and for any scheduled epoch (`is_transfer_fee_zero`, `:172-199`; error `QuoteMintHasNonZeroTransferFee`); the mint is "permissionless-supported" only if every extension is `MetadataPointer` or `TokenMetadata` (a mint with no extensions passes).
3. Otherwise a `TokenBadge` must be supplied at remaining account index 0 and `token_badge.token_mint == quote_mint` (`validate_quote_mint_with_token_badge`, `:246-267`).

Enforced at `create_config` (`process_create_config.rs:377-378`), `create_config_with_transfer_hook`, and all three pool-init instructions (`ix_initialize_virtual_pool_with_spl_token.rs:149`, `ix_initialize_virtual_pool_with_token2022.rs:116`, `..._transfer_hook.rs:115`). `validate_transfer_fee_is_zero` is re-checked on every quote transfer (swaps `process_swap.rs:288`, surplus, migration fee, fee claims, migration `migrate_damm_v2_initialize_pool.rs:553`).

`quote_token_flag: u8` records `TokenProgramFlags { TokenProgram=0, TokenProgram2022=1 }` (`PROG/state/config.rs:529-530`; `PROG/utils/token.rs:29-44`); the SDK uses it to pick the quote token program (`SDK/services/migration.ts:662-665`).

### 3.7 Collect fee mode, activation, base and dynamic fees

| Parameter | Rule | Citation |
| --- | --- | --- |
| `collect_fee_mode` | `CollectFeeMode { QuoteToken=0, OutputToken=1 }`. QuoteToken: buys pay fee from quote input, sells pay fee from quote output. OutputToken: buys pay fee in base output, sells in quote output | `PROG/state/virtual_pool.rs:43-48`; `PROG/state/fee.rs:120-144` |
| `activation_type` | `0` slot, `1` timestamp; drives fee schedules and `activation_point` | `DOCS/developer-guides/dbc/program/accounts.mdx:54`; `SDK/types.ts:124-127` |
| `pool_fees.base_fee: BaseFeeParameters { cliff_fee_numerator: u64, first_factor: u16, second_factor: u64, third_factor: u64, base_fee_mode: u8 }` | `BaseFeeMode { FeeSchedulerLinear=0, FeeSchedulerExponential=1, RateLimiter=2 (rejected: DeprecatedBaseFeeMode 6078) }`. For schedulers: `first_factor = number_of_period`, `second_factor = period_frequency`, `third_factor = reduction_factor`. Fixed fee = all three zero. Min base fee `MIN_FEE_NUMERATOR 2_500_000` (0.25%); total cap `990_000_000` (99%). Linear: `fee = cliff - periods*reduction`; exponential: `fee = cliff*(1-reduction/10_000)^periods` | `PROG/params/fee_parameters.rs:20-57`; `PROG/state/config.rs:54-61,229-238`; `PROG/constants.rs:75-82`; `DOCS/core-products/dbc/fees/fee-scheduler.mdx:41-96` |
| `pool_fees.dynamic_fee: Option<DynamicFeeParameters { bin_step: u16, bin_step_u128: u128, filter_period: u16, decay_period: u16, reduction_factor: u16, max_volatility_accumulator: u32, variable_fee_control: u32 }>` | `bin_step == 1`, `bin_step_u128 == 1844674407370955`, `filter_period < decay_period`, `reduction_factor <= 10_000`, `variable_fee_control`/`max_volatility_accumulator <= 0xffffff`. Fee = `ceil((vol_acc*bin_step)^2 * variable_fee_control / 1e11)` | `PROG/params/fee_parameters.rs:90-150`; `PROG/state/config.rs:309-331`; defaults `PROG/constants.rs:14-34` |
| `enable_first_swap_with_min_fee` | When true, a swap in the same top-level transaction as the pool-init instruction (pool at account index 5), with no referral, pays the minimum base fee; requires instructions sysvar in remaining accounts | `PROG/state/config.rs:573,1214-1216`; `PROG/instructions/swap/process_swap.rs:214-221,500-550` |

### 3.8 Migrated liquidity distribution (the "LP percentage" fields)

Current field names (the README's `partner_lp_percentage`/`partner_locked_lp_percentage`/`creator_lp_percentage`/`creator_locked_lp_percentage` at `README.md:38-41` are legacy names for the same concepts):

| Rust field (`PROG/state/config.rs:531-538`) | SDK field (`SDK/types.ts:346-353`) | Meaning |
| --- | --- | --- |
| `partner_liquidity_percentage: u8` | `partnerLiquidityPercentage` | Partner unlocked DAMM v2 liquidity |
| `partner_permanent_locked_liquidity_percentage: u8` | `partnerPermanentLockedLiquidityPercentage` | Partner permanently locked liquidity |
| `creator_liquidity_percentage: u8` | `creatorLiquidityPercentage` | Creator unlocked |
| `creator_permanent_locked_liquidity_percentage: u8` | `creatorPermanentLockedLiquidityPercentage` | Creator permanently locked |
| `partner_liquidity_vesting_info.vesting_percentage` | `partnerLiquidityVestingInfoParams.vestingPercentage` | Partner vesting-locked |
| `creator_liquidity_vesting_info.vesting_percentage` | `creatorLiquidityVestingInfoParams.vestingPercentage` | Creator vesting-locked |

Rules: the six percentages must sum to exactly 100 (`process_create_config.rs:454-464`, error `InvalidFeePercentage` 6018). At least `MIN_LOCKED_LIQUIDITY_BPS = 1000` (10%) must still be locked one day (`SECONDS_PER_DAY`) after migration, checked at config creation and at every pool init (`process_create_config.rs:707-711`; `ix_initialize_virtual_pool_with_spl_token.rs:153-157`; `PROG/constants.rs:60`; `PROG/state/config.rs:1046-1065`). Vesting: `LiquidityVestingInfoParams { vesting_percentage: u8, bps_per_period: u16, number_of_periods: u16, cliff_duration_from_migration_time: u32, frequency: u32 }` (`process_create_config.rs:312-367`), total duration `<= MAX_LOCK_DURATION_IN_SECONDS = 63_072_000` (2 years; `PROG/constants.rs:64`). Liquidity split at migration: `PoolConfig::get_liquidity_distribution` (`PROG/state/config.rs:951-1012`).

---

## 4. CRITICAL: where the quote tokens go at migration

Notation: `X = migration_quote_threshold` (quote lamports), `f = migration_fee_percentage` (0..=99), `c_m = creator_migration_fee_percentage` (0..=100), `c_t = creator_trading_fee_percentage` (0..=100), `R = quote_reserve` at completion, `S = R - X >= 0` (surplus). All quote-side balances live in the DBC `quote_vault` owned by the pool authority; the only exits are the instructions below.

### 4.1 During the bonding phase

- Buys add quote to `quote_reserve` net of quote-side fees; sells remove quote plus fees (`apply_swap_result`, `PROG/state/virtual_pool.rs:979-994`). Quote-side fees accrue into `partner_quote_fee`, `creator_quote_fee`, `protocol_quote_fee`.
- Neither partner nor creator can withdraw from `quote_reserve` before completion. Only accrued trading fees are claimable (§2.1).
- Once `quote_reserve >= X` the pool is complete: further swaps fail with `PoolIsCompleted` 6013 (`process_swap.rs:224-227`). Exact-in buys that would cross `migration_sqrt_price` fail (`InsufficientLiquidity`, `virtual_pool.rs:596`); `SwapMode::PartialFill` (1) stops at `migration_sqrt_price` and refunds `amount_left` (`:860-938`, `:694-730`). At completion `finish_curve_timestamp` is set and `migration_progress` becomes `PostBondingCurve` (1) if locked vesting is configured, else `LockedVesting` (2) (`process_swap.rs:343-375`).

### 4.2 At `migration_damm_v2` (`PROG/instructions/migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs:498-772`)

Preconditions: remaining account 0 is a DAMM v2 `Config` whose `pool_creator_authority == DBC pool authority`, and for fixed options a non-scheduled time-scheduler cliff equal to the option's bps, full price range, no alpha vault, timestamp activation (`validate_config_key`, `:418-496`); `migration_progress == LockedVesting`; `is_curve_complete`; `migration_option == DammV2`; quote mint transfer fee zero (`:534-553`).

Step 1 — gross quote for the pool (`PoolConfig::get_migration_quote_amount`, `PROG/state/config.rs:846-858`):

```
Q_gross   = ceil( X * (100 - f) / 100 )          // quote earmarked for DAMM v2
MigFee    = X - Q_gross                          // configurable partner/creator migration fee, stays in DBC vault
```

(`get_included_protocol_fee_migration_amounts_2` for concentrated liquidity returns `(base_vault_balance - all base fee buckets, Q_gross)`, `PROG/migration_handler/concentrated_liquidity.rs:128-144`; compounding returns `(migration_base_threshold, Q_gross)`, `compounding_liquidity.rs:145-165`.)

Step 2 — protocol liquidity migration fee, `PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS = 20` (0.2%; `PROG/constants.rs:107`, recorded per pool as `protocol_liquidity_migration_fee_bps`, `virtual_pool.rs:155`):

```
ProtoMigQuote = floor( Q_gross * 20 / 10_000 )
ProtoMigBase  = base equivalent of ProtoMigQuote at migration price (concentrated: via fee liquidity, concentrated_liquidity.rs:36-61;
                compounding: floor(base * 20 / 10_000), compounding_liquidity.rs:51-69)
Q_net = Q_gross - ProtoMigQuote ;  B_net = B_gross - ProtoMigBase
```

Saved into `protocol_migration_quote_fee_amount` / `protocol_migration_base_fee_amount` (`virtual_pool.rs:157-158,1243-1246`); they remain in the DBC vaults and are claimable only by the protocol (§4.5).

Step 3 — pool creation (`:594-644`): concentrated mode uses `sqrt_price = migration_sqrt_price`, `liquidity = min(L_from_base(B_net), L_from_quote(Q_net))` over the full range `[MIN_SQRT_PRICE, MAX_SQRT_PRICE]` (`concentrated_liquidity.rs:148-192`). Compounding mode derives price from `Q_net/B_net` (must be within 1% of `migration_sqrt_price`) and locks `DAMM_V2_COMPOUNDING_DEAD_LIQUIDITY = 100 << 64` in the first position (`compounding_liquidity.rs:14-48,72-90`; `:636-638`). The DBC pool authority is `creator` and `payer` of the DAMM v2 pool; `payer_token_a/b` are the DBC base/quote vaults, so the deposit moves directly vault → DAMM v2 vaults (`:133-249`).

Step 4 — positions (`:603-732`): distributable liquidity is split by `get_liquidity_distribution`; the party with the larger total gets the *first* position (created with the pool), the other gets the *second* position (`create_position` + `add_liquidity` with whatever base/quote remained undeposited, re-measured from vault deltas, `:663-697`). Each position's permanent-lock (`permanent_lock_position`) and vesting-lock (`lock_inner_position`) CPIs run, then the position NFT token account owner is set to `config.fee_claimer` (partner) or `pool.creator` (`set_authority(AccountOwner)`, `:326-346,656-661,726-731`). Any undeposited remainder after the second position is dust left in the DBC vaults (no instruction withdraws it; see §10).

Step 5 — burn (`:736-765`): base left in the vault beyond fee buckets is burned: dynamic supply burns all of it (`get_max_burnable_amount_post_migration = u64::MAX`), fixed supply burns at most `pre_migration_token_supply - post_migration_token_supply` (`PROG/state/config.rs:931-945`). `is_migrated = 1`, `migration_progress = CreatedPool` (3).

Net: **`Q_net ≈ X·(100−f)/100 · 0.998` of the raised quote becomes DAMM v2 liquidity, owned (as position NFTs, subject to locks) by partner and creator — not by traders and not by Meteora.** The DAMM v2 pool holds it; it is withdrawable only via `remove_liquidity` on *unlocked* position liquidity (§9).

### 4.3 Migration fee → partner and creator (`withdraw_migration_fee`)

`PROG/instructions/migration/ix_withdraw_migration_fee.rs:65-148`; split `PROG/state/config.rs:860-874`:

```
CreatorMigFee = floor( MigFee * c_m / 100 )
PartnerMigFee = MigFee - CreatorMigFee
```

- Available as soon as `is_curve_complete` (before or after `migration_damm_v2`), once per side (`migration_fee_withdraw_status` bits `0b010` creator, `0b100` partner; `virtual_pool.rs:135-138,206-207,1184-1189`; error `MigrationFeeHasBeenWithdraw` 6040).
- `flag = 0` requires `sender == config.fee_claimer`; `flag = 1` requires `sender == pool.creator`. Transfer goes to `token_quote_account` (any quote token account the SDK derives as the sender's ATA, `SDK/services/program.ts:940-987`).
- SDK: `client.partner.partnerWithdrawMigrationFee({ pool, sender })`, `client.creator.creatorWithdrawMigrationFee({ pool, sender })` (`SDK/services/partner.ts:651-657`, `SDK/services/creator.ts:635-641`). Event `EvtWithdrawMigrationFee { pool, fee, flag }`.

### 4.4 Surplus → partner, creator, protocol

`PROG/state/virtual_pool.rs:1130-1166`; `PARTNER_AND_CREATOR_SURPLUS_SHARE = 80` (`PROG/constants.rs:47`):

```
S              = quote_reserve - X                        (requires R >= X)
PC_surplus     = floor( S * 80 / 100 )
CreatorSurplus = floor( PC_surplus * c_t / 100 )          (0 if c_t == 0)
PartnerSurplus = PC_surplus - CreatorSurplus
ProtocolSurplus= S - PC_surplus                            (≈ 20%)
```

- `partner_withdraw_surplus` (`ix_withdraw_partner_surplus.rs:46-99`, signer `fee_claimer`) and `creator_withdraw_surplus` (`ix_withdraw_creator_surplus.rs:45-99`, signer `creator`) require `is_curve_complete` only (not `CreatedPool`), one-time flags `is_partner_withdraw_surplus` / `is_creator_withdraw_surplus` (error `SurplusHasBeenWithdraw` 6025).
- Protocol surplus is swept together with protocol quote fees by `claim_protocol_fee2` (`virtual_pool.rs:1073-1089`, flag `is_protocol_withdraw_surplus`).
- Because buys stop exactly at `migration_sqrt_price` (partial fill) and exact-in overshoot is rejected, `S` is typically a rounding-level residual (the threshold price is derived with Rounding::Up, `liquidity_distribution.rs:66-120`); the program nonetheless handles any `S > 0`. Do not design economics around surplus.

### 4.5 Protocol (Meteora) take

`claim_protocol_fee2(max_amount)` (`PROG/instructions/operator/ix_claim_protocol_fee2.rs:77-170`), signer = protocol fee authority PDA, one mint per call. Quote side: `protocol_quote_fee` (20% of trading fees less referral) + `protocol_migration_quote_fee_amount` (0.2% of `Q_gross`) + protocol surplus (`virtual_pool.rs:1056-1089`). Base side: `protocol_base_fee` + `protocol_migration_base_fee_amount` (transfer-hook pools: only after completion, `:117-126`). Pool-creation fee protocol share (10%) via `claim_protocol_pool_creation_fee` (operator).

### 4.6 Leftover (base only)

`withdraw_leftover` (`PROG/instructions/migration/withdraw_leftover.rs:48-120`): requires `migration_progress == CreatedPool`, `fixed_token_supply_flag == 1`, once (`is_withdraw_leftover`). Amount = `base_vault.amount - (partner_base_fee + protocol_base_fee + creator_base_fee) - protocol_migration_base_fee_amount`, sent to `leftover_receiver`'s ATA. There is no quote-side leftover instruction.

### 4.7 Quantified routes for a pool with threshold `X`

| Route | Instruction | Earliest timing | Creator receives | Partner receives | Protocol receives |
| --- | --- | --- | --- | --- | --- |
| Quote trading fees during curve | `claim_creator_trading_fee` / `claim_trading_fee` | any time | `Σ floor(LPfee_q · c_t/100)` | `Σ (LPfee_q − creator part)` | 20% of each trading fee (less 20% referral if any) |
| Migration fee | `withdraw_migration_fee(flag)` | curve complete | `floor((X − ceil(X·(100−f)/100)) · c_m/100)` | `(X − ceil(X·(100−f)/100)) − creator part` | 0 |
| Surplus | `*_withdraw_surplus` / `claim_protocol_fee2` | curve complete | `floor(floor(0.8·S)·c_t/100)` | `floor(0.8·S) − creator part` | `S − floor(0.8·S)` |
| Protocol liquidity migration fee | `claim_protocol_fee2` | after `migration_damm_v2` | 0 | 0 | `floor(ceil(X·(100−f)/100)·20/10000)` quote + base equivalent |
| DAMM v2 liquidity | position NFTs (locks apply) | after `migration_damm_v2` | share of `Q_net` per creator percentages | share of `Q_net` per partner percentages | 0 |
| Pool creation fee (SOL, not quote) | `claim_partner_pool_creation_fee` / operator | after pool init | 0 | 90% of `pool_creation_fee` lamports | 10% |

Worked example, `X = 750 USDC = 750_000_000` (6 decimals):

- `f = 0`: `Q_gross = 750_000_000`; `MigFee = 0`; `ProtoMigQuote = 1_500_000` (1.5 USDC); `Q_net = 748_500_000` (748.5 USDC) → DAMM v2. Partner/creator get quote only via trading fees, surplus, and later DAMM v2 position fees / unlocked liquidity removal.
- `f = 10, c_m = 50`: `Q_gross = ceil(750e6·90/100) = 675_000_000`; `MigFee = 75_000_000` (75 USDC) → creator 37.5 USDC, partner 37.5 USDC; `ProtoMigQuote = floor(675e6·20/10000) = 1_350_000` (1.35 USDC); `Q_net = 673_650_000` (673.65 USDC) → DAMM v2.
- `f = 99, c_m = 100` (maximum extraction): `Q_gross = ceil(750e6·1/100) = 7_500_000` (7.5 USDC); `MigFee = 742_500_000` (742.5 USDC) → all to creator; `ProtoMigQuote = 15_000`; `Q_net = 7_485_000` → DAMM v2.

Therefore the configurable `migration_fee` is the mechanism by which a creator or partner can take raised quote out of the pool; everything else of `X` (less 0.2%) must become DAMM v2 liquidity. The SDK helpers `getMigrationQuoteAmountFromMigrationQuoteThreshold` / `getMigrationQuoteThresholdFromMigrationQuoteAmount` implement `Q = X·(100−f)/100` and its inverse (`SDK/helpers/common.ts:334-358`), and `getProtocolMigrationFee` implements the 0.2% (`:370-411`).

---

## 5. Token-2022 extensions of the base mint at graduation

- **Standard Token-2022 pool** (`initialize_virtual_pool_with_token2022`): mint created with only `MetadataPointer` (pointing at itself) + `TokenMetadata` (`ix_initialize_virtual_pool_with_token2022.rs:35-46`; `process_initialize_virtual_pool_with_token2022.rs:68-79`). No other extensions are ever added. Mint authority is set to `None` at pool initialization (`:145-167`; changelog 0.2.0 breaking change, `/home/user/meteoraag/dynamic-bonding-curve/CHANGELOG.md:73`). Metadata-pointer authority and token-metadata update authority are set at init to creator / partner (`fee_claimer`) / None per `token_update_authority` (`:88-126`). **Nothing about the mint changes at graduation**; the only mint operation during `migration_damm_v2` is the burn of excess base (§4.2 step 5).
- **Transfer-hook pool** (`initialize_virtual_pool_with_token2022_transfer_hook`): mint is created with `transfer_hook::authority = pool_authority` and `transfer_hook::program_id = config.transfer_hook_program` in addition to metadata pointer/metadata (`ix_initialize_virtual_pool_with_token2022_transfer_hook.rs:37-49`). The hook program must be executable and not DBC/SPL Token/Token-2022/default (`DOCS/core-products/dbc/transfer-hook-pools.mdx:29`). **At curve completion (inside the completing swap), DBC revokes the hook**: `transfer_hook::instruction::update(..., None)` sets the hook program id to none, then `set_authority(TransferHookProgramId, None)` removes the hook authority (`PROG/instructions/swap/process_swap.rs:365-367,390-430`). After that the `TransferHook` extension remains present but with both program id and authority unset, which DAMM v2 treats as permissionless (`DOCS/core-products/damm-v2/token-2022-support.mdx:36,50-52`). Event `EvtCurveCompleteWithTransferHook`.
- **Mint authority on transfer-hook pools**: with `CreatorUpdateAndMintAuthority` / `PartnerUpdateAndMintAuthority` (only allowed for transfer-hook configs), mint authority is assigned to creator or partner at init (`process_initialize_virtual_pool_with_token2022.rs:145-167`) and is **not** revoked at graduation (no code path touches `MintTokens` authority after init). Update authority likewise persists per the chosen option. Immutable (`1`) sets both metadata authorities to `None`.
- Protocol-fee base claims on transfer-hook pools are deferred until completion so the hook cannot block them (`ix_claim_protocol_fee2.rs:117-126`).
- DAMM v2 cannot forward transfer-hook extra accounts (`DOCS/core-products/damm-v2/token-2022-support.mdx:118`), which is why the hook must be dead before migration (`ix_initialize_virtual_pool_with_token2022_transfer_hook.rs:21-22`).

---

## 6. Migration sequence, manual migrator, devnet

### 6.1 State machine

`MigrationProgress { PreBondingCurve=0, PostBondingCurve=1, LockedVesting=2, CreatedPool=3 }` (`PROG/state/virtual_pool.rs:66-88`). Without locked vesting: 0 → 2 → 3. With locked vesting: 0 → 1 → (`create_locker`) → 2 → 3.

### 6.2 End-to-end graduation (DAMM v2)

1. Curve completes inside the last swap (`EvtCurveComplete` / `EvtCurveCompleteWithTransferHook`; `finish_curve_timestamp` set; hook revoked if applicable).
2. If `locked_vesting.has_vesting()`: `create_locker` (`PROG/instructions/migration/create_locker.rs:70-152`) — requires `PostBondingCurve`; CPI `locker::create_vesting_escrow_v2` for `pool.creator`; caller must pre-create the escrow ATA (SDK does this, `SDK/services/migration.ts:84-142`); sets `LockedVesting`. SDK: `client.migration.createLocker({ payer, pool })`.
3. `migration_damm_v2` — requires `LockedVesting` and curve complete; remaining account 0 = `DAMM_V2_MIGRATION_FEE_ADDRESS[config.migration_fee_option]`; signers: `payer`, `first_position_nft_mint` (always), `second_position_nft_mint` (optional account; SDK always passes both). SDK: `const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await client.migration.migrateToDammV2({ payer, pool, dammConfig })` (`SDK/services/migration.ts:612-718`; adds a 600_000 CU limit). Sets `CreatedPool`. The `migration_metadata` account is deprecated/unused (`migrate_damm_v2_initialize_pool.rs:38-40`); `migration_damm_v2_create_metadata` is a deprecated no-op since 0.1.7 (`PROG/lib.rs:299-309`; handler `migration_damm_v2_create_metadata.rs:20-24`). **There is no `createDammV2MigrationMetadata` SDK method**; only `deriveDammV2MigrationMetadataAddress` exists and the SDK passes the derived PDA as the unused account (`migration.ts:623,679`). (`createDammV1MigrationMetadata` exists for DAMM v1 only.)
4. Post-migration claims: `withdraw_leftover` (fixed supply; `client.migration.withdrawLeftover({ payer, pool })`), partner/creator `withdraw_migration_fee`, surplus, remaining trading fees; protocol `claim_protocol_fee2`.

Flash rent: `create_locker` and `migration_damm_v2` wrap CPIs in `flash_rent` — the DBC pool authority lends lamports for account rent and the `payer` repays what was consumed (`PROG/instructions/migration/flash_rent.rs:6-25`; comment at `:12`: "Someone have to fund 1 SOL for pool authority"; `FLASH_RENT_FUND = 1 SOL`, `PROG/constants.rs:12`). The `payer` therefore needs enough SOL to cover DAMM v2 pool + positions + locker rent.

DAMM v1 path (existing pools only): `createDammV1MigrationMetadata` → optional `createLocker` → `migrateToDammV1` → optional `lockDammV1LpToken` → optional `claimDammV1LpToken` (SDK README `.../README.md:45-51`).

### 6.3 Manual migrator / keepers / devnet

- Manual Migrator UI: `https://migrator.meteora.ag`, "Compatible with both Mainnet and Devnet pools" (SDK README `.../README.md:73-75`; `DOCS/developer-guides/dbc/index.mdx:106-108`; `DOCS/core-products/dbc/migration-and-liquidity.mdx:142-144`). No API, instruction list, or threshold rules for the UI are in the clones beyond "it migrates to DAMM v1 or v2".
- Keepers run on **mainnet only** with the thresholds listed in §1. There is no documented devnet keeper or devnet "keeper threshold"; on devnet you graduate pools yourself (SDK `migrateToDammV2` or the UI). The docs say the SDK builders are intended for "manual migration, devnet validation, and custom keeper infrastructure" (`DOCS/developer-guides/dbc/typescript-sdk/examples.mdx:270-272`).
- The only devnet-specific statements in the clones are: program ID identical on devnet; migrator supports devnet; faucet link (`DOCS/developer-guides/dbc/typescript-sdk/getting-started.mdx:117-123`).

---

## 7. TypeScript SDK

Package `@meteora-ag/dynamic-bonding-curve-sdk`, version `1.5.13` (`package.json:2-3`); deps `@coral-xyz/anchor ^0.31.0`, `@solana/web3.js ^1.98.0`, `@solana/spl-token ^0.4.13`, `bn.js ^5.2.1`, `decimal.js ^10.5.0` (`package.json:61-67`). ESM + CJS builds. Install: `npm install @meteora-ag/dynamic-bonding-curve-sdk @solana/web3.js @solana/spl-token bn.js`.

### 7.1 Client

```ts
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
const client = DynamicBondingCurveClient.create(connection, 'confirmed')   // or new DynamicBondingCurveClient(connection, commitment)
client.pool: PoolService; client.partner: PartnerService; client.creator: CreatorService;
client.migration: MigrationService; client.state: StateService
```
(`SDK/client.ts:10-38`.) All builders return unsigned `Transaction`s; caller sets blockhash/feePayer, signs, sends.

### 7.2 Config builders (`SDK/helpers/buildCurve.ts`) — all return `ConfigParameters`

| Function | Extra params beyond `BuildCurveBaseParams` | Line |
| --- | --- | --- |
| `buildCurve(params: BuildCurveParams)` | `percentageSupplyOnMigration: number`, `migrationQuoteThreshold: number` | `:45` |
| `buildCurveWithMarketCap(params)` | `initialMarketCap: number`, `migrationMarketCap: number` | `:273` |
| `buildCurveWithTwoSegments(params)` | `initialMarketCap`, `migrationMarketCap`, `percentageSupplyOnMigration` | `:346` |
| `buildCurveWithMidPrice(params)` | `initialMarketCap`, `migrationMarketCap`, `midPrice`, `percentageSupplyOnMigration` | `:627` |
| `buildCurveWithLiquidityWeights(params)` | `initialMarketCap`, `migrationMarketCap`, `liquidityWeights: number[]` | `:889` |
| `buildCurveWithCustomSqrtPrices(params)` | `sqrtPrices: BN[]` (ascending), `liquidityWeights?: number[]` | `:1197` |

`BuildCurveBaseParams` (`SDK/types.ts:363-370`) = `{ token: TokenConfig, fee: FeeConfig, migration: MigrationConfig, liquidityDistribution: LiquidityDistributionConfig, lockedVesting: LockedVestingParams, activationType: ActivationType }`.

Units (verified against the code):

| Input | Type / unit | Evidence |
| --- | --- | --- |
| `token.totalTokenSupply`, `token.leftover` | UI base-token units (converted with `tokenBaseDecimal`) | `buildCurve.ts:147,164` |
| `token.tokenBaseDecimal` | `TokenDecimal` 6–9; `token.tokenQuoteDecimal` any number (e.g. 6 for USDC, 9 for SOL) | `types.ts:266-273`; CHANGELOG 1.5.13 |
| `token.tokenAuthorityOption` | `TokenAuthorityOption` enum → on-chain `tokenUpdateAuthority` | `buildCurve.ts:253` |
| `migrationQuoteThreshold` (buildCurve) | UI quote units, e.g. `750` for 750 USDC; converted with `tokenQuoteDecimal` into `migrationQuoteThreshold` lamports | `buildCurve.ts:159-162,244`; `SDKDOC:1503` |
| `percentageSupplyOnMigration` | percent of total supply (0–100) that is deposited into DAMM v2 | `buildCurve.ts:143-145` |
| `initialMarketCap`, `migrationMarketCap` | in quote-token units (not lamports) for the whole `totalTokenSupply` (`price = marketCap / totalSupply`) | `SDK/helpers/common.ts:277-289`; Invent example `DOCS/invent/launch-pools/dbc-token-launch-pool.mdx:149-150` |
| `fee.baseFeeParams.feeSchedulerParam.{startingFeeBps, endingFeeBps}` | bps; `numberOfPeriod`; `totalDuration` in `activationType` units (slots or seconds) | `common.ts:893-974`; `SDKDOC:1817` |
| `fee.dynamicFeeEnabled` | derives dynamic fee = max 20% of `endingFeeBps`, max price change 1500 bps | `common.ts:1112-1158`; `buildCurve.ts:227-233` |
| `fee.collectFeeMode` | `CollectFeeMode.QuoteToken (0) | OutputToken (1)` | `types.ts:134-137` |
| `fee.creatorTradingFeePercentage` | 0–100 | `types.ts:305` |
| `fee.poolCreationFee` | in SOL (converted with 9 decimals) | `buildCurve.ts:131-134` |
| `migration.migrationOption` | must be `MigrationOption.MET_DAMM_V2 (1)`; `MET_DAMM (0)` throws | `common.ts:1704-1708` |
| `migration.migrationFeeOption` | `MigrationFeeOption 0..6` | `types.ts:179-187` |
| `migration.migrationFee` | `{ feePercentage: 0–99, creatorFeePercentage: 0–100 }` | `types.ts:310-313` |
| `migration.migratedPoolFee?` | `{ collectFeeMode: MigratedCollectFeeMode, dynamicFee: DammV2DynamicFeeMode, poolFeeBps: 10–1000, compoundingFeeBps?, baseFeeMode?: DammV2BaseFeeMode, marketCapFeeSchedulerParams?: { endingBaseFeeBps, numberOfPeriod, priceMultiple, schedulerExpirationDuration } }`; supplying it forces `migrationFeeOption = Customizable` when market-cap params given | `types.ts:315-329`; `common.ts:1689-1775` |
| `liquidityDistribution.*Percentage` | integers summing to 100 incl. `vestingPercentage`s | `types.ts:346-353` |
| `lockedVesting` | `{ totalLockedVestingAmount (UI base units), numberOfVestingPeriod, cliffUnlockAmount (UI base units), totalVestingDuration (seconds), cliffDurationFromMigrationTime (seconds) }`; all zero = none | `types.ts:355-361`; `common.ts:1302-1381` |
| `activationType` | `ActivationType.Slot (0) | Timestamp (1)` | `types.ts:124-127` |

How `buildCurve` derives the curve from a target raise (`buildCurve.ts:143-220`): `migrationBaseSupply = totalSupply·pct/100`; `migrationQuoteAmount = threshold·(100−f)/100`; `migrationPrice = migrationQuoteAmount / migrationBaseSupply` → `migrateSqrtPrice`; `migrationBaseAmount = getMigrationBaseToken(...)` (DAMM v2 full-range math, `common.ts:420-451`); `swapAmount = totalSupply − migrationBaseAmount − vesting − leftover`; `getFirstCurve` solves `sqrtStartPrice = sqrtP_mig · migrationBaseAmount / (swapAmount·(100−f)/100)` and one segment `{ sqrtPrice: migrateSqrtPrice, liquidity }` (`common.ts:503-549`); a final segment to `MAX_SQRT_PRICE` absorbs any remaining supply. `buildCurveWithMarketCap` computes `percentageSupplyOnMigration = sqrt(initMC/migMC)·(100−V−L)/(1+sqrt(initMC/migMC))` (fee-adjusted variant when `f>0`) and `migrationQuoteThreshold = migMC·pct/100 · 100/(100−f)` (`buildCurve.ts:273-341`; `common.ts:788-881`).

Lower-level helpers: `getBaseFeeParams(baseFeeParams): BaseFee` (`common.ts:1564-1581`), `getFeeSchedulerParams(startingBps, endingBps, mode, numberOfPeriod, totalDuration)` (`:893`), `getDynamicFeeParams(baseFeeBps, maxPriceChangeBps = 1500)` (`:1112`), `getLockedVestingParams(...)` (`:1302`), `getLiquidityVestingInfoParams(...)` (`:1383`), `getMigratedPoolFeeParams(migrationOption, migrationFeeOption, migratedPoolFee?, baseFeeParams?)` (`:1689`), `getMigratedPoolMarketCapFeeSchedulerParams(...)` (`:1214`), `getSqrtPriceFromPrice(price, baseDec, quoteDec)` / `getPriceFromSqrtPrice` / `createSqrtPrices` (`:208-267`), `getTokenomics(...)` (`:1627`), `validateConfigParameters(...)` (`SDK/helpers/validation.ts:810`).

### 7.3 Creating a config

```ts
type CreateConfigParams = { config: PublicKey; feeClaimer: PublicKey; leftoverReceiver: PublicKey; quoteMint: PublicKey; payer: PublicKey; tokenBadge?: PublicKey } & ConfigParameters   // types.ts:238-249
client.partner.createConfig(params: CreateConfigParams): Promise<Transaction>                       // partner.ts:39
client.partner.createConfigWithTransferHook(params: CreateConfigParams & { transferHookProgram }): Promise<Transaction>  // partner.ts:64
client.partner.createConfigAndPool(params: CreateConfigParams & { preCreatePoolParam: CreatePoolBaseParams }): Promise<Transaction>   // partner.ts:93
client.partner.createConfigAndPoolWithFirstBuy(params): Promise<{ createConfigTx; createPoolWithFirstBuyTx }>   // partner.ts:198
```
Signers: `payer` and the new `config` keypair. The SDK adds `tokenBadge` as remaining account 0 when provided (`SDK/helpers/pda.ts:535-549`).

### 7.4 Creating a pool

```ts
type CreatePoolParams = { name; symbol; uri; payer; poolCreator; config; baseMint; tokenBadge? }    // types.ts:422-431
client.creator.createPool(params: CreatePoolParams): Promise<Transaction>                            // creator.ts:80 (reads config, rejects RateLimiter/MET_DAMM configs)
client.creator.createPoolWithTransferHook(params: CreatePoolParams & { transferHookProgram })        // creator.ts:95
client.creator.createPoolWithFirstBuy({ createPoolParam: CreatePoolParams, firstBuyParam?: { buyer, receiver?, buyAmount: BN, minimumAmountOut: BN, referralTokenAccount: PublicKey | null } })   // creator.ts:118; types.ts:456-492
client.creator.createPoolWithPartnerAndCreatorFirstBuy({ createPoolParam, partnerFirstBuyParam?, creatorFirstBuyParam? })   // creator.ts:187
```
Signers: `payer`, `poolCreator`, `baseMint` keypair. Pool address: `deriveDbcPoolAddress(quoteMint, baseMint, config)` (`SDK/helpers/pda.ts:129-154`; seeds `["pool", config, max(mints), min(mints)]`).

### 7.5 Swapping and quoting

```ts
client.pool.swap({ owner, pool, amountIn: BN, minimumAmountOut: BN, swapBaseForQuote: boolean, referralTokenAccount, payer? })   // legacy exact-in, pool.ts:49
client.pool.swap2({ owner, pool, swapBaseForQuote, referralTokenAccount, payer?, swapMode: SwapMode.ExactIn | PartialFill, amountIn, minimumAmountOut } | { ..., swapMode: SwapMode.ExactOut, amountOut, maximumAmountIn })   // pool.ts:183; types.ts:534-556
client.pool.swap2WithTransferHook(params: Swap2Params)                                              // pool.ts:330
client.pool.swapQuote({ virtualPool, config, swapBaseForQuote, amountIn, slippageBps?, hasReferral, eligibleForFirstSwapWithMinFee, currentPoint }): SwapQuoteResult   // pool.ts:486
client.pool.swapQuote2({ virtualPool, config, swapBaseForQuote, hasReferral, eligibleForFirstSwapWithMinFee, currentPoint, slippageBps?, swapMode, amountIn | amountOut }): SwapQuote2Result   // pool.ts:513
client.pool.getQuoteFromInputAmount(...) / getQuoteFromOutputAmount(...)   // pre-pool simulation from a buildCurve output, pool.ts:643,690
```
`SwapMode { ExactIn=0, PartialFill=1, ExactOut=2 }` (`types.ts:219-223`). Use `PartialFill` for the final buy. `currentPoint` = slot or unix seconds per `activationType` (`getCurrentPoint(connection, activationType)`, `common.ts:1783`).

### 7.6 State and progress (`SDK/services/state.ts`)

`getPoolConfig(address): Promise<PoolConfig | null>` (`:76`; normalizes `ConfigWithTransferHook`), `getPoolConfigs()`, `getPoolConfigsByOwner(owner)`, `getPool(address): Promise<VirtualPool | null>` (`:126`; fields are under `pool.poolState.*`, e.g. `poolState.quoteReserve`, `poolState.sqrtPrice`, `poolState.migrationProgress`, `poolState.creator`), `getPools()`, `getPoolsByConfig(config)`, `getPoolsByCreator(creator)`, `getPoolByBaseMint(mint)`, `getPoolMigrationQuoteThreshold(pool): Promise<BN>` (`:194`), `getPoolQuoteTokenCurveProgress(pool): Promise<number>` = `clamp(quoteReserve / migrationQuoteThreshold, 0, 1)` (`:209-227`), `getPoolBaseTokenCurveProgress(pool)` (`:232`), `getPoolFeeMetrics(pool)`, `getPoolFeeBreakdown(pool)` → `{ creator: { unclaimedQuoteFee, claimedQuoteFee, totalQuoteFee, ...base }, partner: {...} }` (`:324-419`), `getPoolsFeesByConfig`, `getPoolsFeesByCreator`, `getTokenBadge(mint): Promise<TokenBadge | null>` (`:498`).

### 7.7 Migration and claims

```ts
client.migration.createLocker({ payer, pool }): Promise<Transaction>                                // migration.ts:84
client.migration.withdrawLeftover({ payer, pool }): Promise<Transaction>                            // migration.ts:147
client.migration.migrateToDammV2({ payer, pool, dammConfig }): Promise<{ transaction, firstPositionNftKeypair, secondPositionNftKeypair }>   // migration.ts:612
client.partner.claimPartnerTradingFee({ feeClaimer, payer, pool, maxBaseAmount: BN, maxQuoteAmount: BN, receiver?, tempWSolAcc? })        // partner.ts:374
client.partner.claimPartnerTradingFeeToReceiver({ feeClaimer, payer, pool, maxBaseAmount, maxQuoteAmount, receiver })                     // partner.ts:455
client.partner.claimPartnerTradingFee2(...)   // transfer-hook pools only                                                                    // partner.ts:525
client.partner.partnerWithdrawSurplus({ feeClaimer, pool })                                                                                // partner.ts:598
client.partner.partnerWithdrawMigrationFee({ pool, sender })                                                                               // partner.ts:651
client.partner.claimPartnerPoolCreationFee({ pool, feeReceiver })                                                                          // partner.ts:662
client.creator.claimCreatorTradingFee({ creator, payer, pool, maxBaseAmount, maxQuoteAmount, receiver?, tempWSolAcc? })                   // creator.ts:337
client.creator.claimCreatorTradingFeeToReceiver({ creator, payer, pool, maxBaseAmount, maxQuoteAmount, receiver })                        // creator.ts:409
client.creator.claimCreatorTradingFee2(...)   // transfer-hook pools only                                                                    // creator.ts:471
client.creator.creatorWithdrawSurplus({ creator, pool })                                                                                   // creator.ts:540
client.creator.transferPoolCreator({ pool, creator, newCreator })                                                                          // creator.ts:601
client.creator.creatorWithdrawMigrationFee({ pool, sender })                                                                               // creator.ts:635
```
Use `maxBaseAmount = maxQuoteAmount = new BN('18446744073709551615')` to claim everything (`DOCS/developer-guides/dbc/typescript-sdk/examples.mdx:236-252`). When the quote mint is wSOL the SDK appends an unwrap instruction (`program.ts:967-970`).

### 7.8 Program-level account/PDA helpers

`deriveDbcPoolAuthority()`, `deriveDbcPoolAddress(quote, base, config)`, `deriveDbcTokenVaultAddress`, `deriveDammV2PoolAddress(dammConfig, base, quote)`, `deriveDammV2PoolAuthority()`, `derivePositionAddress(nftMint)`, `derivePositionNftAccount(nftMint)`, `deriveTokenBadgeAddress(mint)` (seeds `["token_badge", mint]`), `getTokenBadgeRemainingAccounts(badge?)`, `deriveBaseKeyForLocker(pool)`, `deriveEscrow(base)` (`SDK/helpers/pda.ts`). Exported constants: all program IDs, `DAMM_V2_MIGRATION_FEE_ADDRESS`, `MIN_SQRT_PRICE`, `MAX_SQRT_PRICE`, fee bounds (`SDK/constants.ts`).

---

## 8. Token badge; USDG

What it is: `TokenBadge { token_mint: Pubkey, _padding: [u8;128] }` (160 bytes + 8; `PROG/state/token_badge.rs:7-14`), PDA seeds `["token_badge", token_mint]` (`PROG/constants.rs:118`; `ix_create_token_badge.rs:15-25`). It is an operator-created allowlist entry that lets a Token-2022 **quote** mint with extensions outside `{MetadataPointer, TokenMetadata}` be used in `create_config*` and `initialize_virtual_pool_*` (remaining account index 0). It does not relax the zero-transfer-fee rule (`ix_create_token_badge.rs:40-44` calls `is_supported_quote_mint`, which enforces zero fee and rejects already-permissionless mints with `CannotCreateTokenBadgeOnSupportedMint` 6079). It applies to quote mints only; base mints are created by the program.

How a quote token gets one: only a Meteora `Operator` account with `OperatorPermission::CreateTokenBadge` (bit 2) can call `create_token_badge`; `CloseTokenBadge` (bit 3) closes it (`PROG/lib.rs:63-71`; `PROG/state/operator.rs:20-49`). Operators are created by the admin (`create_operator_account(permission: u128)`, `PROG/lib.rs:35-41`). The DBC docs describe this as "the path used for Stock Tokens and other Token 2022 quote assets" and say to request review via Meteora (`DOCS/core-products/dbc/token-2022-support.mdx:83-108`); the DAMM v2 page gives the application form `https://forms.gle/59n3zDiGS2C6qMfd7` plus a Discord ticket (`DOCS/core-products/damm-v2/token-2022-support.mdx:92-94`). Closing a badge blocks new configs/pools for that mint but existing pools keep trading (`DOCS/core-products/dbc/token-2022-support.mdx:106-108`). A DBC badge is not a DAMM v2 badge; DBC-used DAMM v2 configs carry `CreatePoolWithoutMintValidation` (`1 << 0`) so badged quote mints still graduate (`migrate_damm_v2_initialize_pool.rs:126-129`; `DOCS/developer-guides/damm-v2/pool-fee-configs.mdx:33`). SDK: `deriveTokenBadgeAddress`, `getTokenBadgeRemainingAccounts`, `client.state.getTokenBadge`, `tokenBadge?` on create params.

USDG (`2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH`): **not mentioned anywhere** in the three clones (grep for the mint address and for "USDG" returned nothing across `DOCS`, the SDK, and the program). Consequences for an integration: (a) whether USDG needs a badge depends solely on its on-chain Token-2022 extension set and transfer-fee config — if it carries anything other than `MetadataPointer`/`TokenMetadata` (e.g. `PermanentDelegate`, `DefaultAccountState`, `Pausable`), `create_config` fails with `InvalidTokenBadge` 6080 until Meteora creates a badge; (b) USDG is not in the mainnet keeper quote list, so auto-migration would depend on the generic "Jupiter Verified, Organic Score > 50, notional > 750 USD" rule, which the clones do not evaluate for any specific token.

---

## 9. DAMM v2 behavior after migration (secondary market)

- Pool identity: DAMM v2 pool PDA = `["pool", dammConfig, max(mints), min(mints)]` (`SDK/helpers/pda.ts:185`; `DOCS/developer-guides/damm-v2/pool-fee-configs.mdx:9-11`); the config is `DAMM_V2_MIGRATION_FEE_ADDRESS[migration_fee_option]`. Created with `activation_point: None` and timestamp activation (`migrate_damm_v2_initialize_pool.rs:161-165,232-236`), so it is tradable immediately after migration.
- Initial price = DBC `migration_sqrt_price` (concentrated) over the full range `[MIN_SQRT_PRICE, MAX_SQRT_PRICE]` (`concentrated_liquidity.rs:19-34`; `migrate_damm_v2_initialize_pool.rs:156-157`). Compounding pools are full-range constant product with dead liquidity.
- Fees: fixed options 25/30/100/200/400/600 bps time-scheduler with no decay (`validate_config_key` requires `period_frequency == reduction_factor == number_of_period == 0`, `:455-461`). Customizable: `migrated_pool_fee_bps` (0.1%–10%) as cliff fee, optional DAMM v2 dynamic fee (max 20% of base), optional market-cap scheduler, optional compounding (`PoolConfig::build_damm_v2_pool_fee_params`, `PROG/state/config.rs:1199-1212`). DAMM v2 protocol fee = 20% of trading fee, referral = 20% of protocol fee (`DOCS/developer-guides/damm-v2/pool-fee-configs.mdx:43-44`); fee cap 99% for current pool version (`DOCS/core-products/damm-v2/fees/overview.mdx:72`). Collect mode mapping from DBC `migrated_collect_fee_mode`: QuoteToken → DAMM `OnlyB` (fees in quote), OutputToken → `BothToken`, Compounding → `Compounding` (`PROG/migration_handler/mod.rs:37-48`). Default when not customizable: `migrated_pool_fee` must be zero and the fixed config decides (collect mode per config key; the clones do not print the collect mode of the six DBC fixed config keys — see §10).
- Liquidity ownership: two position NFTs (Token-2022 NFTs; holder controls the position) owned by `fee_claimer` and `pool.creator`. Each contains `unlocked_liquidity`, `vested_liquidity` (`lock_inner_position`, cliff relative to migration time, <= 2 years), `permanent_locked_liquidity` (`permanent_lock_position`) per the config percentages (`migrate_damm_v2_initialize_pool.rs:251-324`). At least 10% must still be locked on day one (§3.8).
- What locked liquidity can do: locked and vesting liquidity cannot be withdrawn but **still earns LP fees and liquidity-mining rewards**, claimable by the NFT holder via `claim_position_fee` (`DOCS/core-products/damm-v2/nft-positions.mdx:31-41,57-67`; `DOCS/developer-guides/damm-v2/program/instructions.mdx:72`). Unlocked liquidity is removable with `remove_liquidity` (`instructions.mdx:40`). Positions can be split or transferred (`nft-positions.mdx:69-80`). Vested liquidity releases into unlocked per `InnerVesting` (`DOCS/developer-guides/damm-v2/program/accounts.mdx:141-178`).
- Token-2022 base mints: after DBC revokes the hook, DAMM v2 treats the mint as permissionless; DAMM v2 does account for `TransferFeeConfig` on mints that have it (`DOCS/core-products/damm-v2/token-2022-support.mdx:29-38,120-122`) — DBC base mints never have one.
- Secondary-market readers: DBC events `EvtCurveComplete` + `migration_progress == 3` indicate the handoff; afterwards use DAMM v2 pool state/events (`DOCS/developer-guides/dbc/program/events.mdx:95-101`).

---

## 10. Not found / unverified in the clones

1. **USDG** (`2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH`): zero mentions. Its Token-2022 extensions, badge status, and keeper eligibility must be checked on-chain / with Meteora.
2. **Devnet DAMM v2 migration config keys**: the SDK ships one `DAMM_V2_MIGRATION_FEE_ADDRESS` array with no cluster qualifier and the SDK test suite uses `[0]` on a local validator (`.../tests/migration.test.ts:24,155-164`); the docs do not explicitly state these keys exist on devnet. The migrator UI is stated to support devnet, which implies they do, but this is inferred, not documented.
3. **Manual migrator (`migrator.meteora.ag`)** internals: no API, instruction order, or eligibility rules in the clones beyond "supports mainnet and devnet, DAMM v1 or v2". The notion of a "keeper threshold" exists only for the mainnet keepers (§1); no devnet keeper is documented.
4. **DBC pool-authority SOL balance for flash rent on devnet/mainnet**: the program comments say someone must fund 1 SOL to the pool authority (`flash_rent.rs:12`; `FLASH_RENT_FUND`, `constants.rs:12`), and the payer repays consumed lamports. Whether the devnet pool authority is currently funded is not stated.
5. **Collect fee mode / dynamic-fee flags of the six fixed DBC→DAMM v2 config keys** (`7F6d...`, `2nHK...`, etc.): not printed anywhere in the clones; only their cliff fee is enforced by `validate_config_key`. The public static DAMM v2 config list in `pool-fee-configs.mdx` is a different set (indices 0–71) and does not include these keys.
6. **Undeposited quote dust after the second position**: `leftover_migration_quote_amount` that does not fit into the second position remains in the DBC quote vault and no instruction withdraws it (`migrate_damm_v2_initialize_pool.rs:675-732`). Expected to be rounding-level; not quantified in docs.
7. **`ActivationType` enum source** (`PROG/utils/activation_handler.rs`) and `ix_create_config.rs` remaining-account read were not opened line-by-line; values are taken from docs/SDK (0 slot, 1 timestamp) and from `process_create_config.rs:377-378`.
8. **DAMM v2 `Config` struct field list**: the vendored `libs/damm-v2` is `declare_program!(damm_v2)` from `idls/damm_v2.json`; fields (`pool_creator_authority`, `permission`, `sqrt_min_price`, …) are cited from the DAMM v2 docs and the DBC validation code, not from Rust source.
9. **Exact SDK version vs docs**: docs reference SDK `1.5.12` for program `0.2.1`; the clone is `1.5.13` (only change: `tokenQuoteDecimal` accepts any decimals). Docs changelog gives planned mainnet deployment of program 0.2.1 as 2026-09-09 (`DOCS/developer-guides/dbc/changelog.mdx:18-20`); whether that deployment happened is not verifiable offline.
10. **Protocol-fee wrapper program (`pFee3tb7...`)** behavior and who operates it: only the ID and PDA seed are in the clones.
