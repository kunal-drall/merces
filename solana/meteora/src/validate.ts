/**
 * Off-chain mirror of the DBC program's `create_config` validation (program 0.2.1).
 *
 * Mirrors, in the program's order:
 *  1. `ConfigParameters::validate` (PROG process_create_config.rs:371-516)
 *  2. the derived checks of `process_create_config` (PROG process_create_config.rs:526-690) for the
 *     concentrated-liquidity migration handler (QuoteToken / OutputToken migrated collect-fee modes)
 *  3. the day-one locked-liquidity requirement (PROG process_create_config.rs:707-711)
 *
 * Error codes are the program's `PoolError` variant names (PROG/error.rs) so a rejection here predicts
 * the on-chain rejection. The only checks that cannot be done off-chain are the quote-mint checks
 * (`validate_quote_mint_with_token_badge`, PROG/utils/token.rs:216-267): owner program, zero transfer fee,
 * extension set / token badge. The graduation script asserts those against the live mint before sending.
 *
 * Not mirrored: the `Compounding` migrated collect-fee mode (PROG/migration_handler/compounding_liquidity.rs);
 * the Merces generator never emits it and the validator rejects it with `UnsupportedByValidator`.
 */
import {
  ActivationType,
  BASIS_POINT_MAX,
  BIN_STEP_BPS_DEFAULT,
  BIN_STEP_BPS_U128_DEFAULT,
  BaseFeeMode,
  CollectFeeMode,
  DAMM_V2_FEE_DENOMINATOR,
  DAMM_V2_MAX_FEE_NUMERATOR_V1,
  DAMM_V2_MIN_FEE_NUMERATOR,
  DammV2BaseFeeMode,
  DammV2DynamicFee,
  FEE_DENOMINATOR,
  MAX_CURVE_POINT,
  MAX_FEE_NUMERATOR,
  MAX_LOCK_DURATION_IN_SECONDS,
  MAX_MIGRATED_POOL_FEE_BPS,
  MAX_MIGRATION_FEE_PERCENTAGE,
  MAX_POOL_CREATION_FEE,
  MAX_SQRT_PRICE,
  MAX_TOKEN_DECIMAL,
  MIN_FEE_NUMERATOR,
  MIN_LOCKED_LIQUIDITY_BPS,
  MIN_MIGRATED_POOL_FEE_BPS,
  MIN_POOL_CREATION_FEE,
  MIN_SQRT_PRICE,
  MIN_TOKEN_DECIMAL,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  SECONDS_PER_DAY,
  TokenAuthorityOption,
  TokenType,
  U128_MAX,
  U16_MAX,
  U24_MAX,
  U64_MAX,
} from "./constants.js";
import {
  DbcMathError,
  castU64,
  getBaseTokenForSwap,
  getFeeInPeriod,
  getFeeSchedulerMinNumerator,
  getMigrationBaseThreshold,
  getMigrationQuoteAmount,
  getMigrationThresholdPrice,
  getSwapAmountWithBuffer,
  getTotalTokenSupply,
  mulDiv,
  Rounding,
  type FeeScheduler,
} from "./math.js";
import {
  hasLockedVesting,
  isZeroLiquidityVesting,
  lockedVestingTotal,
  type DbcConfigParameters,
  type LiquidityVestingInfoParams,
  type MigratedPoolFee,
  type MigratedPoolMarketCapFeeSchedulerParams,
} from "./types.js";

export type PoolErrorCode =
  | "TypeCastFailed"
  | "MathOverflow"
  | "InvalidBaseFeeMode"
  | "DeprecatedBaseFeeMode"
  | "InvalidFeeScheduler"
  | "InvalidFee"
  | "ExceedMaxFeeBps"
  | "InvalidInput"
  | "InvalidCreatorTradingFeePercentage"
  | "InvalidMigratorFeePercentage"
  | "InvalidCollectFeeMode"
  | "InvalidMigrationOption"
  | "DeprecatedMigrationOption"
  | "InvalidMigrationFeeOption"
  | "InvalidTokenType"
  | "InvalidMigratedPoolFee"
  | "InvalidFeeMarketCapScheduler"
  | "InvalidVestingParameters"
  | "InvalidTokenAuthorityOption"
  | "InvalidTokenDecimals"
  | "InvalidFeePercentage"
  | "InvalidQuoteThreshold"
  | "InvalidPoolCreationFee"
  | "InvalidCurve"
  | "NotEnoughLiquidity"
  | "InvalidLeftoverAddress"
  | "InvalidTokenSupply"
  | "InvalidMigrationLockedLiquidity"
  | "UnsupportedByValidator";

export class DbcValidationError extends Error {
  constructor(
    readonly code: PoolErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DbcValidationError";
  }
}

function fail(code: PoolErrorCode, message: string): never {
  throw new DbcValidationError(code, message);
}

function require(cond: boolean, code: PoolErrorCode, message: string): void {
  if (!cond) fail(code, message);
}

function isU8(x: number): boolean {
  return Number.isInteger(x) && x >= 0 && x <= 255;
}

export interface ValidationContext {
  /** True when `leftover_receiver` is `Pubkey::default()` (rejected for fixed-supply configs). Default false. */
  leftoverReceiverIsDefault?: boolean;
  /** `create_config_with_transfer_hook` instead of `create_config`. Default false. */
  isTransferHook?: boolean;
  /** Unix seconds used where the program reads `Clock` (liquidity vesting validation). Default: now. */
  currentTimestamp?: number;
}

/** Values the program derives from the parameters and stores in `PoolConfig`. */
export interface DerivedConfig {
  migrationSqrtPrice: bigint;
  swapBaseAmount: bigint;
  migrationQuoteAmount: bigint;
  migrationFee: bigint;
  migrationBaseThreshold: bigint;
  swapBaseAmountWithBuffer: bigint;
  minimumBaseSupplyWithBuffer: bigint;
  minimumBaseSupplyWithoutBuffer: bigint;
  lockedVestingTotal: bigint;
  /** `pre_migration_token_supply` for fixed supply, else the dynamic initial mint (PROG/state/config.rs:907-929). */
  initialBaseSupply: bigint;
  lockedLiquidityBpsAtOneDay: number;
}

// ---------------------------------------------------------------------------------------------
// Fee validation (PROG/params/fee_parameters.rs, PROG/base_fee/fee_scheduler.rs)
// ---------------------------------------------------------------------------------------------

/** `validate_fee_fraction` (PROG/params/fee_parameters.rs:173-179). */
function validateFeeFraction(numerator: bigint, denominator: bigint): void {
  require(denominator !== 0n && numerator < denominator, "InvalidFee", `fee ${numerator}/${denominator} is not a fraction`);
}

function wrapMath<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof DbcMathError) {
      const code: PoolErrorCode =
        e.code === "NotEnoughLiquidity" ? "NotEnoughLiquidity" : e.code === "TypeCastFailed" ? "TypeCastFailed" : "MathOverflow";
      fail(code, e.message);
    }
    throw e;
  }
}

function validateBaseFee(p: DbcConfigParameters): void {
  const b = p.poolFees.baseFee;
  require(isU8(b.baseFeeMode) && b.baseFeeMode <= BaseFeeMode.RateLimiter, "InvalidBaseFeeMode", `base_fee_mode ${b.baseFeeMode}`);
  require(b.baseFeeMode !== BaseFeeMode.RateLimiter, "DeprecatedBaseFeeMode", "RateLimiter is rejected for new configs");
  require(Number.isInteger(b.firstFactor) && b.firstFactor >= 0 && b.firstFactor <= U16_MAX, "TypeCastFailed", "first_factor is u16");
  require(b.secondFactor >= 0n && b.secondFactor <= U64_MAX, "TypeCastFailed", "second_factor is u64");
  require(b.thirdFactor >= 0n && b.thirdFactor <= U64_MAX, "TypeCastFailed", "third_factor is u64");
  require(b.cliffFeeNumerator >= 0n && b.cliffFeeNumerator <= U64_MAX, "TypeCastFailed", "cliff_fee_numerator is u64");
  const s: FeeScheduler = {
    cliffFeeNumerator: b.cliffFeeNumerator,
    numberOfPeriod: b.firstFactor,
    periodFrequency: b.secondFactor,
    reductionFactor: b.thirdFactor,
    linear: b.baseFeeMode === BaseFeeMode.FeeSchedulerLinear,
  };
  // PROG/base_fee/fee_scheduler.rs:78-96
  if (s.periodFrequency !== 0n || s.numberOfPeriod !== 0 || s.reductionFactor !== 0n) {
    require(
      s.numberOfPeriod !== 0 && s.periodFrequency !== 0n && s.reductionFactor !== 0n,
      "InvalidFeeScheduler",
      "a fee scheduler needs number_of_period, period_frequency and reduction_factor all non-zero",
    );
  }
  const minFee = wrapMath(() => getFeeSchedulerMinNumerator(s));
  const maxFee = s.cliffFeeNumerator;
  validateFeeFraction(minFee, FEE_DENOMINATOR);
  validateFeeFraction(maxFee, FEE_DENOMINATOR);
  require(
    minFee >= MIN_FEE_NUMERATOR && maxFee <= MAX_FEE_NUMERATOR,
    "ExceedMaxFeeBps",
    `base fee must stay within [${MIN_FEE_NUMERATOR}, ${MAX_FEE_NUMERATOR}] / 1e9 (got min ${minFee}, max ${maxFee})`,
  );
}

/** `DynamicFeeParameters::validate` (PROG/params/fee_parameters.rs:116-150). */
function validateDynamicFee(p: DbcConfigParameters): void {
  const d = p.poolFees.dynamicFee;
  if (!d) return;
  require(d.binStep === BIN_STEP_BPS_DEFAULT, "InvalidInput", "bin_step must be 1");
  require(d.binStepU128 === BIN_STEP_BPS_U128_DEFAULT, "InvalidInput", "bin_step_u128 must be 1844674407370955");
  require(d.filterPeriod < d.decayPeriod, "InvalidInput", "filter_period must be < decay_period");
  require(d.reductionFactor <= Number(BASIS_POINT_MAX), "InvalidInput", "reduction_factor must be <= 10_000");
  require(d.variableFeeControl <= U24_MAX, "InvalidInput", "variable_fee_control must fit u24");
  require(d.maxVolatilityAccumulator <= U24_MAX, "InvalidInput", "max_volatility_accumulator must fit u24");
}

// ---------------------------------------------------------------------------------------------
// Migrated pool fee (PROG process_create_config.rs:101-228)
// ---------------------------------------------------------------------------------------------

function isMigratedPoolFeeNone(
  fee: MigratedPoolFee,
  compoundingFeeBps: number,
  baseFeeMode: number,
  s: MigratedPoolMarketCapFeeSchedulerParams,
): boolean {
  return (
    fee.collectFeeMode === 0 &&
    fee.dynamicFee === 0 &&
    fee.poolFeeBps === 0 &&
    compoundingFeeBps === 0 &&
    baseFeeMode === 0 &&
    s.numberOfPeriod === 0 &&
    s.sqrtPriceStepBps === 0 &&
    s.schedulerExpirationDuration === 0 &&
    s.reductionFactor === 0n
  );
}

/** `DammV2PodAlignedFeeMarketCapScheduler::validate` (PROG/utils/damm_v2_utils.rs:194-257). */
function validateMarketCapScheduler(cliffFeeNumerator: bigint, mode: number, s: MigratedPoolMarketCapFeeSchedulerParams): void {
  require(s.reductionFactor > 0n, "InvalidFeeMarketCapScheduler", "reduction_factor must be > 0");
  require(s.sqrtPriceStepBps > 0, "InvalidFeeMarketCapScheduler", "sqrt_price_step_bps must be > 0");
  require(s.schedulerExpirationDuration > 0, "InvalidFeeMarketCapScheduler", "scheduler_expiration_duration must be > 0");
  require(s.numberOfPeriod > 0, "InvalidFeeMarketCapScheduler", "number_of_period must be > 0");
  const minFee = wrapMath(() => {
    if (mode === DammV2BaseFeeMode.FeeMarketCapSchedulerLinear) {
      const fee = cliffFeeNumerator - s.reductionFactor * BigInt(s.numberOfPeriod);
      if (fee < 0n) throw new DbcMathError("MathOverflow", "market-cap scheduler underflow");
      return fee;
    }
    return getFeeInPeriod(cliffFeeNumerator, s.reductionFactor, s.numberOfPeriod);
  });
  validateFeeFraction(minFee, DAMM_V2_FEE_DENOMINATOR);
  validateFeeFraction(cliffFeeNumerator, DAMM_V2_FEE_DENOMINATOR);
  require(
    minFee >= DAMM_V2_MIN_FEE_NUMERATOR && cliffFeeNumerator <= DAMM_V2_MAX_FEE_NUMERATOR_V1,
    "ExceedMaxFeeBps",
    "migrated pool market-cap scheduler fee out of DAMM v2 bounds",
  );
}

function validateMigratedPoolFee(p: DbcConfigParameters): void {
  const fee = p.migratedPoolFee;
  require(
    fee.poolFeeBps >= MIN_MIGRATED_POOL_FEE_BPS && fee.poolFeeBps <= MAX_MIGRATED_POOL_FEE_BPS,
    "InvalidMigratedPoolFee",
    `migrated pool_fee_bps must be within [${MIN_MIGRATED_POOL_FEE_BPS}, ${MAX_MIGRATED_POOL_FEE_BPS}]`,
  );
  require(
    isU8(fee.collectFeeMode) && fee.collectFeeMode <= MigratedCollectFeeMode.Compounding,
    "InvalidCollectFeeMode",
    `migrated collect_fee_mode ${fee.collectFeeMode}`,
  );
  if (fee.collectFeeMode === MigratedCollectFeeMode.Compounding) {
    require(
      p.compoundingFeeBps > 0 && p.compoundingFeeBps <= Number(BASIS_POINT_MAX),
      "InvalidMigratedPoolFee",
      "compounding_fee_bps must be within (0, 10_000] in Compounding mode",
    );
  } else {
    require(p.compoundingFeeBps === 0, "InvalidMigratedPoolFee", "compounding_fee_bps must be 0 unless Compounding");
  }
  require(
    fee.dynamicFee === DammV2DynamicFee.Disable || fee.dynamicFee === DammV2DynamicFee.Enable,
    "InvalidMigratedPoolFee",
    `migrated dynamic_fee ${fee.dynamicFee}`,
  );
  const mode = p.migratedPoolBaseFeeMode;
  require(isU8(mode) && mode <= DammV2BaseFeeMode.FeeMarketCapSchedulerExponential, "TypeCastFailed", `migrated base fee mode ${mode}`);
  const s = p.migratedPoolMarketCapFeeSchedulerParams;
  switch (mode) {
    case DammV2BaseFeeMode.FeeTimeSchedulerLinear:
    case DammV2BaseFeeMode.FeeTimeSchedulerExponential:
      require(
        s.numberOfPeriod === 0 && s.sqrtPriceStepBps === 0 && s.schedulerExpirationDuration === 0 && s.reductionFactor === 0n,
        "InvalidMigratedPoolFee",
        "time-scheduler migrated pools take no market-cap scheduler parameters",
      );
      break;
    case DammV2BaseFeeMode.FeeMarketCapSchedulerLinear:
    case DammV2BaseFeeMode.FeeMarketCapSchedulerExponential: {
      const cliff = (BigInt(fee.poolFeeBps) * DAMM_V2_FEE_DENOMINATOR) / BASIS_POINT_MAX; // to_numerator
      validateMarketCapScheduler(cliff, mode, s);
      break;
    }
    default:
      fail("InvalidMigratedPoolFee", "RateLimiter is not a valid migrated pool base fee mode");
  }
}

// ---------------------------------------------------------------------------------------------
// Liquidity vesting (PROG process_create_config.rs:312-367; PROG/state/config.rs:627-712; PROG/utils/damm_v2_utils.rs:98-141)
// ---------------------------------------------------------------------------------------------

interface DammV2VestingParameters {
  cliffPoint: bigint;
  periodFrequency: bigint;
  cliffUnlockLiquidity: bigint;
  liquidityPerPeriod: bigint;
  numberOfPeriod: number;
}

/** `LiquidityVestingInfo::get_damm_v2_vesting_parameters` (PROG/state/config.rs:664-712). */
function dammV2VestingParameters(v: LiquidityVestingInfoParams, totalVestedLiquidity: bigint, now: bigint): DammV2VestingParameters {
  let frequency = v.frequency;
  let numberOfPeriod = v.numberOfPeriods;
  let cliffDuration = v.cliffDurationFromMigrationTime;
  const totalBpsAfterCliff = v.bpsPerPeriod * numberOfPeriod;
  if (totalBpsAfterCliff > U16_MAX) fail("MathOverflow", "bps_per_period * number_of_periods overflows u16");
  const totalAfterCliff = mulDiv(totalVestedLiquidity, BigInt(totalBpsAfterCliff), BASIS_POINT_MAX, Rounding.Down);
  let liquidityPerPeriod = numberOfPeriod > 0 ? totalAfterCliff / BigInt(numberOfPeriod) : 0n;
  if (liquidityPerPeriod === 0n) {
    numberOfPeriod = 0;
    frequency = 0;
    cliffDuration = Math.max(cliffDuration, 1);
    liquidityPerPeriod = 0n;
  }
  const cliffUnlockLiquidity = totalVestedLiquidity - liquidityPerPeriod * BigInt(numberOfPeriod);
  return {
    cliffPoint: now + BigInt(cliffDuration),
    periodFrequency: BigInt(frequency),
    cliffUnlockLiquidity,
    liquidityPerPeriod,
    numberOfPeriod,
  };
}

/** `validate_vesting_parameters` (PROG/utils/damm_v2_utils.rs:98-141). */
function validateDammV2Vesting(vp: DammV2VestingParameters, now: bigint, maxDuration: bigint): void {
  require(vp.cliffPoint >= now, "InvalidVestingParameters", "cliff before now");
  if (vp.cliffPoint === now) require(vp.numberOfPeriod > 0, "InvalidVestingParameters", "cliff == now needs periods");
  if (vp.numberOfPeriod > 0) {
    require(vp.periodFrequency > 0n && vp.liquidityPerPeriod > 0n, "InvalidVestingParameters", "periods need frequency and amount");
  }
  const duration = vp.cliffPoint - now + vp.periodFrequency * BigInt(vp.numberOfPeriod);
  require(duration <= maxDuration, "InvalidVestingParameters", `vesting duration ${duration}s exceeds ${maxDuration}s`);
  require(vp.cliffUnlockLiquidity + vp.liquidityPerPeriod * BigInt(vp.numberOfPeriod) > 0n, "InvalidVestingParameters", "nothing vests");
}

function validateLiquidityVesting(v: LiquidityVestingInfoParams, now: bigint): void {
  if (isZeroLiquidityVesting(v)) return;
  require(isU8(v.vestingPercentage), "TypeCastFailed", "vesting_percentage is u8");
  require(Number.isInteger(v.bpsPerPeriod) && v.bpsPerPeriod >= 0 && v.bpsPerPeriod <= U16_MAX, "TypeCastFailed", "bps_per_period is u16");
  require(Number.isInteger(v.numberOfPeriods) && v.numberOfPeriods >= 0 && v.numberOfPeriods <= U16_MAX, "TypeCastFailed", "number_of_periods is u16");
  // safe_mul_div_cast_u128(u128::MAX, pct, 100) overflows u128 when pct > 100
  if (v.vestingPercentage > 100) fail("TypeCastFailed", "vesting_percentage > 100");
  const totalVested = mulDiv(U128_MAX, BigInt(v.vestingPercentage), 100n, Rounding.Down);
  const params = dammV2VestingParameters(v, totalVested, now);
  validateDammV2Vesting(params, now, BigInt(MAX_LOCK_DURATION_IN_SECONDS));
}

/** `LiquidityVestingInfo::get_liquidity_locked_bps_at_n_seconds` (PROG/state/config.rs:628-662). */
export function lockedLiquidityBpsAtNSeconds(v: LiquidityVestingInfoParams, nSeconds: number): number {
  if (isZeroLiquidityVesting(v)) return 0;
  const totalLiquidity = U128_MAX;
  const totalVested = mulDiv(totalLiquidity, BigInt(v.vestingPercentage), 100n, Rounding.Down);
  const vp = dammV2VestingParameters(v, totalVested, 0n);
  // get_max_unlocked_liquidity_at_current_point (PROG/utils/damm_v2_utils.rs:54-80)
  const current = BigInt(nSeconds);
  let unlocked = 0n;
  if (current >= vp.cliffPoint) {
    if (vp.periodFrequency === 0n) unlocked = vp.cliffUnlockLiquidity;
    else {
      let period = (current - vp.cliffPoint) / vp.periodFrequency;
      if (period > BigInt(vp.numberOfPeriod)) period = BigInt(vp.numberOfPeriod);
      unlocked = vp.cliffUnlockLiquidity + period * vp.liquidityPerPeriod;
    }
  }
  const locked = totalVested - unlocked;
  return Number(mulDiv(locked, BASIS_POINT_MAX, totalLiquidity, Rounding.Down));
}

/** `PoolConfig::get_total_liquidity_locked_bps_at_n_seconds` (PROG/state/config.rs:1046-1065). */
export function totalLockedLiquidityBpsAtNSeconds(p: DbcConfigParameters, nSeconds: number): number {
  return (
    lockedLiquidityBpsAtNSeconds(p.partnerLiquidityVestingInfo, nSeconds) +
    p.partnerPermanentLockedLiquidityPercentage * 100 +
    lockedLiquidityBpsAtNSeconds(p.creatorLiquidityVestingInfo, nSeconds) +
    p.creatorPermanentLockedLiquidityPercentage * 100
  );
}

// ---------------------------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------------------------

export function validateDbcConfigParameters(p: DbcConfigParameters, ctx: ValidationContext = {}): DerivedConfig {
  const now = BigInt(ctx.currentTimestamp ?? Math.floor(Date.now() / 1000));
  const isTransferHook = ctx.isTransferHook ?? false;

  // --- ConfigParameters::validate -----------------------------------------------------------
  require(
    p.activationType === ActivationType.Slot || p.activationType === ActivationType.Timestamp,
    "TypeCastFailed",
    `activation_type ${p.activationType}`,
  );
  validateBaseFee(p);
  validateDynamicFee(p);
  require(isU8(p.creatorTradingFeePercentage) && p.creatorTradingFeePercentage <= 100, "InvalidCreatorTradingFeePercentage", "creator_trading_fee_percentage must be <= 100");
  // MigrationFee::validate (PROG process_create_config.rs:80-99)
  require(isU8(p.migrationFee.feePercentage) && isU8(p.migrationFee.creatorFeePercentage), "TypeCastFailed", "migration fee fields are u8");
  require(p.migrationFee.feePercentage <= MAX_MIGRATION_FEE_PERCENTAGE, "InvalidMigratorFeePercentage", "fee_percentage must be <= 99");
  if (p.migrationFee.feePercentage === 0) {
    require(p.migrationFee.creatorFeePercentage === 0, "InvalidMigratorFeePercentage", "creator_fee_percentage must be 0 when fee_percentage is 0");
  } else {
    require(p.migrationFee.creatorFeePercentage <= 100, "InvalidMigratorFeePercentage", "creator_fee_percentage must be <= 100");
  }
  require(p.collectFeeMode === CollectFeeMode.QuoteToken || p.collectFeeMode === CollectFeeMode.OutputToken, "InvalidCollectFeeMode", `collect_fee_mode ${p.collectFeeMode}`);
  require(p.migrationOption === MigrationOption.MeteoraDamm || p.migrationOption === MigrationOption.DammV2, "InvalidMigrationOption", `migration_option ${p.migrationOption}`);
  require(isU8(p.migrationFeeOption) && p.migrationFeeOption <= MigrationFeeOption.Customizable, "InvalidMigrationFeeOption", `migration_fee_option ${p.migrationFeeOption}`);
  require(p.tokenType === TokenType.SplToken || p.tokenType === TokenType.Token2022, "InvalidTokenType", `token_type ${p.tokenType}`);

  if (p.migrationOption === MigrationOption.MeteoraDamm) fail("DeprecatedMigrationOption", "DAMM v1 migration is rejected for new configs");
  if (p.migrationFeeOption === MigrationFeeOption.Customizable) {
    validateMigratedPoolFee(p);
  } else {
    require(
      isMigratedPoolFeeNone(p.migratedPoolFee, p.compoundingFeeBps, p.migratedPoolBaseFeeMode, p.migratedPoolMarketCapFeeSchedulerParams),
      "InvalidMigratedPoolFee",
      "migrated pool fee fields must all be zero unless migration_fee_option is Customizable",
    );
  }
  validateLiquidityVesting(p.partnerLiquidityVestingInfo, now);
  validateLiquidityVesting(p.creatorLiquidityVestingInfo, now);

  require(isU8(p.tokenUpdateAuthority) && p.tokenUpdateAuthority <= TokenAuthorityOption.PartnerUpdateAndMintAuthority, "InvalidTokenAuthorityOption", `token_update_authority ${p.tokenUpdateAuthority}`);
  const hasMintAuthority =
    p.tokenUpdateAuthority === TokenAuthorityOption.CreatorUpdateAndMintAuthority ||
    p.tokenUpdateAuthority === TokenAuthorityOption.PartnerUpdateAndMintAuthority;
  require(isTransferHook || !hasMintAuthority, "InvalidTokenAuthorityOption", "mint-authority options are only allowed on transfer-hook configs");

  require(Number.isInteger(p.tokenDecimal) && p.tokenDecimal >= MIN_TOKEN_DECIMAL && p.tokenDecimal <= MAX_TOKEN_DECIMAL, "InvalidTokenDecimals", `token_decimal must be within [${MIN_TOKEN_DECIMAL}, ${MAX_TOKEN_DECIMAL}] (0-decimal units are not possible; Merces uses 6 and treats 1 HEU = 10^6 base)`);

  const pcts = [
    p.partnerLiquidityPercentage,
    p.partnerPermanentLockedLiquidityPercentage,
    p.creatorLiquidityPercentage,
    p.creatorPermanentLockedLiquidityPercentage,
    p.partnerLiquidityVestingInfo.vestingPercentage,
    p.creatorLiquidityVestingInfo.vestingPercentage,
  ];
  for (const x of pcts) require(isU8(x), "TypeCastFailed", "liquidity percentages are u8");
  const sum = pcts.reduce((a, b) => a + b, 0);
  require(sum <= 255, "MathOverflow", "liquidity percentage sum overflows u8");
  require(sum === 100, "InvalidFeePercentage", `liquidity percentages must sum to 100 (got ${sum})`);

  require(p.migrationQuoteThreshold > 0n && p.migrationQuoteThreshold <= U64_MAX, "InvalidQuoteThreshold", "migration_quote_threshold must be > 0 (u64)");

  // LockedVestingParams::validate (PROG process_create_config.rs:296-309)
  const lv = p.lockedVesting;
  for (const [name, x] of Object.entries(lv)) require(x >= 0n && x <= U64_MAX, "TypeCastFailed", `locked_vesting.${name} is u64`);
  const vestingTotal = lockedVestingTotal(lv);
  require(vestingTotal <= U64_MAX, "MathOverflow", "locked vesting total overflows u64");
  if (hasLockedVesting(lv)) {
    require(lv.frequency !== 0n && vestingTotal !== 0n, "InvalidVestingParameters", "locked vesting needs frequency != 0 and a non-zero total");
  }

  if (p.poolCreationFee > 0n) {
    require(p.poolCreationFee >= MIN_POOL_CREATION_FEE && p.poolCreationFee <= MAX_POOL_CREATION_FEE, "InvalidPoolCreationFee", "pool_creation_fee must be 0 or within [0.001 SOL, 100 SOL]");
  }

  require(p.sqrtStartPrice >= MIN_SQRT_PRICE && p.sqrtStartPrice < MAX_SQRT_PRICE, "InvalidCurve", "sqrt_start_price out of [MIN_SQRT_PRICE, MAX_SQRT_PRICE)");
  require(p.curve.length > 0 && p.curve.length <= MAX_CURVE_POINT, "InvalidCurve", `curve must have 1..=${MAX_CURVE_POINT} points`);
  const first = p.curve[0]!;
  require(first.sqrtPrice > p.sqrtStartPrice && first.liquidity > 0n && first.sqrtPrice <= MAX_SQRT_PRICE, "InvalidCurve", "curve[0] must be above the start price with positive liquidity");
  for (let i = 1; i < p.curve.length; i++) {
    require(p.curve[i]!.sqrtPrice > p.curve[i - 1]!.sqrtPrice && p.curve[i]!.liquidity > 0n, "InvalidCurve", `curve[${i}] must be strictly increasing with positive liquidity`);
  }
  for (const c of p.curve) require(c.sqrtPrice <= U128_MAX && c.liquidity <= U128_MAX, "TypeCastFailed", "curve points are u128");
  require(p.curve[p.curve.length - 1]!.sqrtPrice <= MAX_SQRT_PRICE, "InvalidCurve", "last curve point above MAX_SQRT_PRICE");

  // --- process_create_config derived checks -----------------------------------------------
  const migrationSqrtPrice = wrapMath(() => getMigrationThresholdPrice(p.migrationQuoteThreshold, p.sqrtStartPrice, p.curve));
  require(migrationSqrtPrice < MAX_SQRT_PRICE, "InvalidCurve", "migration price must be below MAX_SQRT_PRICE");
  const swapBaseAmount = wrapMath(() => castU64(getBaseTokenForSwap(p.sqrtStartPrice, migrationSqrtPrice, p.curve), "swap_base_amount"));

  const migratedCollectFeeMode = p.migratedPoolFee.collectFeeMode;
  if (migratedCollectFeeMode === MigratedCollectFeeMode.Compounding) {
    fail("UnsupportedByValidator", "Compounding migrated pools are not modelled by this validator (Merces never uses them)");
  }
  const { quoteAmount: migrationQuoteAmount, fee: migrationFee } = wrapMath(() =>
    getMigrationQuoteAmount(p.migrationQuoteThreshold, p.migrationFee.feePercentage),
  );
  const migrationBaseThreshold = wrapMath(() => getMigrationBaseThreshold(migrationQuoteAmount, migrationSqrtPrice));
  require(migrationBaseThreshold > 0n && swapBaseAmount > 0n, "InvalidCurve", "curve sells no base or deposits no base at migration");

  const swapBaseAmountWithBuffer = wrapMath(() => getSwapAmountWithBuffer(swapBaseAmount, p.sqrtStartPrice, p.curve));
  const minimumBaseSupplyWithBuffer = wrapMath(() => getTotalTokenSupply(swapBaseAmountWithBuffer, migrationBaseThreshold, vestingTotal));
  const minimumBaseSupplyWithoutBuffer = wrapMath(() => getTotalTokenSupply(swapBaseAmount, migrationBaseThreshold, vestingTotal));

  let initialBaseSupply = minimumBaseSupplyWithBuffer;
  if (p.tokenSupply) {
    const { preMigrationTokenSupply: pre, postMigrationTokenSupply: post } = p.tokenSupply;
    require(pre >= 0n && pre <= U64_MAX && post >= 0n && post <= U64_MAX, "TypeCastFailed", "token supply fields are u64");
    require(!(ctx.leftoverReceiverIsDefault ?? false), "InvalidLeftoverAddress", "fixed supply needs a non-default leftover_receiver");
    require(
      minimumBaseSupplyWithoutBuffer <= post && post <= pre && minimumBaseSupplyWithBuffer <= pre,
      "InvalidTokenSupply",
      `need ${minimumBaseSupplyWithoutBuffer} <= post (${post}) <= pre (${pre}) and ${minimumBaseSupplyWithBuffer} <= pre`,
    );
    initialBaseSupply = pre;
  }

  const lockedLiquidityBpsAtOneDay = totalLockedLiquidityBpsAtNSeconds(p, SECONDS_PER_DAY);
  require(lockedLiquidityBpsAtOneDay >= MIN_LOCKED_LIQUIDITY_BPS, "InvalidMigrationLockedLiquidity", `at least ${MIN_LOCKED_LIQUIDITY_BPS} bps of migrated liquidity must still be locked one day after migration (got ${lockedLiquidityBpsAtOneDay})`);

  return {
    migrationSqrtPrice,
    swapBaseAmount,
    migrationQuoteAmount,
    migrationFee,
    migrationBaseThreshold,
    swapBaseAmountWithBuffer,
    minimumBaseSupplyWithBuffer,
    minimumBaseSupplyWithoutBuffer,
    lockedVestingTotal: vestingTotal,
    initialBaseSupply,
    lockedLiquidityBpsAtOneDay,
  };
}
