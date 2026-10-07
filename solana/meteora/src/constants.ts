/**
 * Constants of the Meteora Dynamic Bonding Curve (DBC) program and of the Merces curve mode.
 *
 * Every program constant below is copied from the on-chain source at
 * `/home/user/meteoraag/dynamic-bonding-curve/programs/dynamic-bonding-curve/src` (program 0.2.1)
 * and cross-checked against `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 in `test/constants.test.ts`.
 * File:line references point into that program source (`PROG/`).
 */

// ---------------------------------------------------------------------------------------------
// Program ids and PDAs (PROG/lib.rs:29, SDK constants.ts:75-92)
// ---------------------------------------------------------------------------------------------

export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DAMM_V2_PROGRAM_ID = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export const LOCKER_PROGRAM_ID = "LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn";
/** `b"pool_authority"` PDA of the DBC program; identical on every cluster (PROG/const_pda.rs:4-14). */
export const DBC_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";
/** DAMM v2 pool authority (DOCS developer-guides/damm-v2/index.mdx:97-101). */
export const DAMM_V2_POOL_AUTHORITY = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";

/** Mainnet USDC (brief D10; DOCS core-products/dbc/migration-and-liquidity.mdx keeper table). */
export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** USDC has 6 decimals on Solana (brief C2: verify from the mint, never assume; the generator asserts it). */
export const USDC_DECIMALS = 6;

/**
 * DAMM v2 `Config` accounts that DBC migrations must pass as remaining account 0, indexed by
 * `MigrationFeeOption` (SDK constants.ts:107-116; DOCS developer-guides/dbc/index.mdx:129-139).
 * The SDK ships one list with no cluster qualifier; their existence on devnet is inferred from the
 * manual migrator supporting devnet, not documented (research memo §10.2). The graduation script
 * therefore accepts `--damm-config` to override.
 */
export const DAMM_V2_MIGRATION_FEE_ADDRESS: readonly string[] = [
  "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd", // 0 FixedBps25
  "2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k", // 1 FixedBps30
  "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp", // 2 FixedBps100
  "2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq", // 3 FixedBps200
  "AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD", // 4 FixedBps400
  "DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u", // 5 FixedBps600
  "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck", // 6 Customizable
];

// ---------------------------------------------------------------------------------------------
// Numeric bounds (PROG/constants.rs)
// ---------------------------------------------------------------------------------------------

/** PROG/constants.rs:3-4 — sqrt prices are Q64.64 (`RESOLUTION = 64`, PROG/curve.rs:10). */
export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673521066979257578248091n;
export const RESOLUTION = 64n;
export const ONE_Q64 = 1n << 64n;
export const Q128 = 1n << 128n;

export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const U16_MAX = 65_535;
export const U24_MAX = 0xffffff; // PROG/constants.rs:8
export const U32_MAX = 0xffffffff;

export const BASIS_POINT_MAX = 10_000n; // PROG/constants.rs:6
export const MAX_CURVE_POINT = 16; // PROG/constants.rs:41
export const MAX_CURVE_POINT_CONFIG = 20; // PROG/constants.rs:42 (slots stored in PoolConfig)
export const SWAP_BUFFER_PERCENTAGE = 25n; // PROG/constants.rs:45
export const PARTNER_AND_CREATOR_SURPLUS_SHARE = 80n; // PROG/constants.rs:47
export const MAX_MIGRATION_FEE_PERCENTAGE = 99; // PROG/constants.rs:58
export const MIN_LOCKED_LIQUIDITY_BPS = 1000; // PROG/constants.rs:60 (10% locked one day after migration)
export const MAX_LOCK_DURATION_IN_SECONDS = 63_072_000; // PROG/constants.rs:64 (2 years)
export const SECONDS_PER_DAY = 86_400; // solana_program::clock::SECONDS_PER_DAY
export const MIN_MIGRATED_POOL_FEE_BPS = 10; // PROG/constants.rs:38
export const MAX_MIGRATED_POOL_FEE_BPS = 1000; // PROG/constants.rs:39
export const FLASH_RENT_FUND_LAMPORTS = 1_000_000_000n; // PROG/constants.rs:12 (1 SOL funded to the pool authority)

/** PROG/constants.rs:69-107 (`mod fee`). */
export const FEE_DENOMINATOR = 1_000_000_000n;
export const MAX_FEE_BPS = 9_900;
export const MAX_FEE_NUMERATOR = 990_000_000n;
export const MIN_FEE_BPS = 25;
export const MIN_FEE_NUMERATOR = 2_500_000n;
export const PROTOCOL_FEE_PERCENT = 20n;
export const HOST_FEE_PERCENT = 20n;
export const PROTOCOL_POOL_CREATION_FEE_PERCENT = 10n;
export const MIN_POOL_CREATION_FEE = 1_000_000n;
export const MAX_POOL_CREATION_FEE = 100_000_000_000n;
export const PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS = 20n;

/** PROG/constants.rs:14-33 (`mod dynamic_fee`). */
export const BIN_STEP_BPS_DEFAULT = 1;
export const BIN_STEP_BPS_U128_DEFAULT = 1844674407370955n;
export const DYNAMIC_FEE_FILTER_PERIOD_DEFAULT = 10;
export const DYNAMIC_FEE_DECAY_PERIOD_DEFAULT = 120;
export const DYNAMIC_FEE_REDUCTION_FACTOR_DEFAULT = 5000;
export const MAX_DYNAMIC_FEE_PERCENT = 20n;
export const DYNAMIC_FEE_MAX_VOLATILITY_ACCUMULATOR = 14_460_000;
export const DYNAMIC_FEE_SQUARE_VFA_BIN = 209_091_600_000_000n;

/** Base-mint decimals accepted by `create_config` (PROG process_create_config.rs:448-452). */
export const MIN_TOKEN_DECIMAL = 6;
export const MAX_TOKEN_DECIMAL = 9;

/**
 * DAMM v2 constants used when DBC validates a migrated-pool market-cap fee scheduler
 * (`libs/damm-v2/src/constants.rs` in the DBC clone; checked in `test/constants.test.ts` against `@meteora-ag/cp-amm-sdk`).
 */
export const DAMM_V2_FEE_DENOMINATOR = 1_000_000_000n;
export const DAMM_V2_MIN_FEE_NUMERATOR = 100_000n;
export const DAMM_V2_MAX_FEE_NUMERATOR_V1 = 990_000_000n;

// ---------------------------------------------------------------------------------------------
// Enums (u8 discriminants exactly as the program's `#[repr(u8)]` enums)
// ---------------------------------------------------------------------------------------------

/** PROG/utils/activation_handler.rs:20-23 */
export enum ActivationType {
  Slot = 0,
  Timestamp = 1,
}
/** PROG/state/config.rs:443-446 */
export enum TokenType {
  SplToken = 0,
  Token2022 = 1,
}
/** PROG/state/virtual_pool.rs:43-48 */
export enum CollectFeeMode {
  QuoteToken = 0,
  OutputToken = 1,
}
/** PROG/state/config.rs:425-430 (0 is rejected for new configs, PROG process_create_config.rs:418-421) */
export enum MigrationOption {
  MeteoraDamm = 0,
  DammV2 = 1,
}
/** PROG/state/config.rs:54-61 (RateLimiter = 2 is rejected for new configs) */
export enum BaseFeeMode {
  FeeSchedulerLinear = 0,
  FeeSchedulerExponential = 1,
  RateLimiter = 2,
}
/** PROG/state/config.rs:459-467 */
export enum MigrationFeeOption {
  FixedBps25 = 0,
  FixedBps30 = 1,
  FixedBps100 = 2,
  FixedBps200 = 3,
  FixedBps400 = 4,
  FixedBps600 = 5,
  Customizable = 6,
}
/** LP fee (bps) of the migrated DAMM v2 pool for each fixed option (PROG/state/config.rs:469-496). */
export const MIGRATION_FEE_OPTION_BPS: Readonly<Record<number, number>> = {
  [MigrationFeeOption.FixedBps25]: 25,
  [MigrationFeeOption.FixedBps30]: 30,
  [MigrationFeeOption.FixedBps100]: 100,
  [MigrationFeeOption.FixedBps200]: 200,
  [MigrationFeeOption.FixedBps400]: 400,
  [MigrationFeeOption.FixedBps600]: 600,
};
/** PROG/state/config.rs:371-383 (3 and 4 only on transfer-hook configs) */
export enum TokenAuthorityOption {
  CreatorUpdateAuthority = 0,
  Immutable = 1,
  PartnerUpdateAuthority = 2,
  CreatorUpdateAndMintAuthority = 3,
  PartnerUpdateAndMintAuthority = 4,
}
/** PROG/migration_handler/mod.rs:31-35 */
export enum MigratedCollectFeeMode {
  QuoteToken = 0,
  OutputToken = 1,
  Compounding = 2,
}
/** PROG/utils/damm_v2_utils.rs:24-27 */
export enum DammV2DynamicFee {
  Disable = 0,
  Enable = 1,
}
/** PROG/utils/damm_v2_utils.rs:165-179 */
export enum DammV2BaseFeeMode {
  FeeTimeSchedulerLinear = 0,
  FeeTimeSchedulerExponential = 1,
  RateLimiter = 2,
  FeeMarketCapSchedulerLinear = 3,
  FeeMarketCapSchedulerExponential = 4,
}
/** PROG/state/virtual_pool.rs:66-88 */
export enum MigrationProgress {
  PreBondingCurve = 0,
  PostBondingCurve = 1,
  LockedVesting = 2,
  CreatedPool = 3,
}
/** PROG/instructions/migration/ix_withdraw_migration_fee.rs:59-63 */
export enum MigrationFeeSender {
  Partner = 0,
  Creator = 1,
}
/** PROG/state/virtual_pool.rs:206-207 */
export const CREATOR_MIGRATION_FEE_MASK = 0b010;
export const PARTNER_MIGRATION_FEE_MASK = 0b100;
/** SDK types.ts:219-223 (program `SwapMode`) */
export enum SwapMode {
  ExactIn = 0,
  PartialFill = 1,
  ExactOut = 2,
}

// ---------------------------------------------------------------------------------------------
// Merces conventions (SPEC §1.1, §9; docs/assumptions/track-d.md)
// ---------------------------------------------------------------------------------------------

export const WAD = 1_000_000_000_000_000_000n;
/** Curve-mode base mint decimals: the program forbids 0 (6..=9), so 1 HEU = 10^6 base lamports. */
export const MERCES_CURVE_BASE_DECIMALS = 6;
export const MERCES_BASE_PER_UNIT = 10n ** BigInt(MERCES_CURVE_BASE_DECIMALS);
