/**
 * Exact bigint re-implementation of the DBC program's curve and migration arithmetic.
 *
 * Every function mirrors one Rust function of the on-chain program (cited as `PROG/<file>:<lines>` into
 * `/home/user/meteoraag/dynamic-bonding-curve/programs/dynamic-bonding-curve/src`), including its rounding
 * direction and its overflow failure points. `test/math.test.ts` checks the results against the SDK's BN
 * helpers (`@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13), which are themselves a port of the same Rust.
 */
import {
  BASIS_POINT_MAX,
  FEE_DENOMINATOR,
  HOST_FEE_PERCENT,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  ONE_Q64,
  PARTNER_AND_CREATOR_SURPLUS_SHARE,
  PROTOCOL_FEE_PERCENT,
  PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS,
  Q128,
  RESOLUTION,
  SWAP_BUFFER_PERCENTAGE,
  U128_MAX,
  U64_MAX,
} from "./constants.js";

export enum Rounding {
  Up = "Up",
  Down = "Down",
}

/** Thrown where the program would fail with `MathOverflow`, `TypeCastFailed` or `NotEnoughLiquidity`. */
export class DbcMathError extends Error {
  constructor(
    readonly code: "MathOverflow" | "TypeCastFailed" | "NotEnoughLiquidity" | "InvalidInput",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DbcMathError";
  }
}

export interface CurvePoint {
  /** Q64.64 upper sqrt price of the segment. */
  sqrtPrice: bigint;
  /** Constant liquidity of the segment (`L`). */
  liquidity: bigint;
}

// ---------------------------------------------------------------------------------------------
// Integer helpers
// ---------------------------------------------------------------------------------------------

export function assertNonNegative(x: bigint, what: string): void {
  if (x < 0n) throw new DbcMathError("MathOverflow", `${what} is negative`);
}

export function castU64(x: bigint, what: string): bigint {
  if (x < 0n || x > U64_MAX) throw new DbcMathError("TypeCastFailed", `${what} does not fit u64: ${x}`);
  return x;
}

export function castU128(x: bigint, what: string): bigint {
  if (x < 0n || x > U128_MAX) throw new DbcMathError("TypeCastFailed", `${what} does not fit u128: ${x}`);
  return x;
}

/** floor(a*b/d) or ceil(a*b/d) (PROG/math/u128x128_math.rs:74-97 `mul_div_u256`). */
export function mulDiv(a: bigint, b: bigint, d: bigint, rounding: Rounding): bigint {
  if (d === 0n) throw new DbcMathError("MathOverflow", "division by zero");
  const prod = a * b;
  if (rounding === Rounding.Down) return prod / d;
  return (prod + d - 1n) / d;
}

/** Integer square root (floor). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new DbcMathError("InvalidInput", "isqrt of negative");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  // Newton refinement; Number(n) may lose precision for large n, so iterate to the fixed point.
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) {
      // x may still be off by one in either direction after float seeding.
      while (x * x > n) x -= 1n;
      while ((x + 1n) * (x + 1n) <= n) x += 1n;
      return x;
    }
    x = y;
  }
}

// ---------------------------------------------------------------------------------------------
// Price <-> sqrt price (Q64.64)
// ---------------------------------------------------------------------------------------------

/**
 * sqrt price (Q64.64) of a lamport price given as the rational `quoteLamports / baseLamports`:
 * `floor( sqrt(quote / base) * 2^64 ) = isqrt( floor(quote * 2^128 / base) )`.
 * The SDK's `getSqrtPriceFromPrice` (common.ts:235-247) does the same in decimal floating point.
 */
export function sqrtPriceFromRatio(quoteLamports: bigint, baseLamports: bigint): bigint {
  if (baseLamports <= 0n || quoteLamports <= 0n) throw new DbcMathError("InvalidInput", "price must be positive");
  return isqrt((quoteLamports * Q128) / baseLamports);
}

/** Lamport price (quote per base lamport) as a WAD-scaled bigint: `sqrtP^2 * 1e18 / 2^128`. */
export function priceWadFromSqrtPrice(sqrtPrice: bigint): bigint {
  return (sqrtPrice * sqrtPrice * 1_000_000_000_000_000_000n) / Q128;
}

// ---------------------------------------------------------------------------------------------
// Curve deltas (PROG/curve.rs)
// ---------------------------------------------------------------------------------------------

/** `Δb = L (√P_upper − √P_lower) / 2^128` (PROG/curve.rs:109-130). */
export function getDeltaAmountQuote(lower: bigint, upper: bigint, liquidity: bigint, rounding: Rounding): bigint {
  if (upper < lower) throw new DbcMathError("MathOverflow", "upper < lower sqrt price");
  const prod = liquidity * (upper - lower);
  return rounding === Rounding.Up ? (prod + Q128 - 1n) / Q128 : prod / Q128;
}

/** `Δa = L (√P_upper − √P_lower) / (√P_upper √P_lower)` (PROG/curve.rs:62-77). */
export function getDeltaAmountBase(lower: bigint, upper: bigint, liquidity: bigint, rounding: Rounding): bigint {
  if (upper < lower) throw new DbcMathError("MathOverflow", "upper < lower sqrt price");
  const denominator = lower * upper;
  if (denominator <= 0n) throw new DbcMathError("MathOverflow", "zero sqrt price");
  return mulDiv(liquidity, upper - lower, denominator, rounding);
}

/** u64-checked variant (PROG/curve.rs:34-44 / 81-91). */
export function getDeltaAmountBaseU64(lower: bigint, upper: bigint, liquidity: bigint, rounding: Rounding): bigint {
  return castU64(getDeltaAmountBase(lower, upper, liquidity, rounding), "delta base");
}
export function getDeltaAmountQuoteU64(lower: bigint, upper: bigint, liquidity: bigint, rounding: Rounding): bigint {
  return castU64(getDeltaAmountQuote(lower, upper, liquidity, rounding), "delta quote");
}

/** `√P' = √P + Δy·2^128 / L`, rounding down (PROG/curve.rs:266-277). */
export function getNextSqrtPriceFromQuoteIn(sqrtPrice: bigint, liquidity: bigint, amountIn: bigint): bigint {
  if (liquidity <= 0n) throw new DbcMathError("MathOverflow", "zero liquidity");
  return castU128(sqrtPrice + (amountIn << (RESOLUTION * 2n)) / liquidity, "next sqrt price");
}

/** `√P' = √P·L / (L + Δx·√P)`, rounding up (PROG/curve.rs:234-250). */
export function getNextSqrtPriceFromBaseIn(sqrtPrice: bigint, liquidity: bigint, amountIn: bigint): bigint {
  if (amountIn === 0n) return sqrtPrice;
  const denominator = liquidity + amountIn * sqrtPrice;
  return castU128(mulDiv(liquidity, sqrtPrice, denominator, Rounding.Up), "next sqrt price");
}

// ---------------------------------------------------------------------------------------------
// Curve walking (PROG/params/liquidity_distribution.rs)
// ---------------------------------------------------------------------------------------------

/**
 * Base tokens sold when the price moves from `sqrtStart` to `sqrtMigration` along `curve`
 * (PROG/params/liquidity_distribution.rs:32-64; every segment rounds up).
 */
export function getBaseTokenForSwap(sqrtStart: bigint, sqrtMigration: bigint, curve: readonly CurvePoint[]): bigint {
  let total = 0n;
  for (let i = 0; i < curve.length; i++) {
    const point = curve[i]!;
    const lower = i === 0 ? sqrtStart : curve[i - 1]!.sqrtPrice;
    if (point.sqrtPrice > sqrtMigration) {
      total += getDeltaAmountBase(lower, sqrtMigration, point.liquidity, Rounding.Up);
      break;
    }
    total += getDeltaAmountBase(lower, point.sqrtPrice, point.liquidity, Rounding.Up);
  }
  return total;
}

/**
 * The sqrt price at which `migrationThreshold` quote lamports have been absorbed by the curve
 * (PROG/params/liquidity_distribution.rs:66-120). Throws `NotEnoughLiquidity` when the curve is too short.
 */
export function getMigrationThresholdPrice(
  migrationThreshold: bigint,
  sqrtStart: bigint,
  curve: readonly CurvePoint[],
): bigint {
  if (curve.length === 0) throw new DbcMathError("InvalidInput", "curve is empty");
  const first = curve[0]!;
  const totalAmount = getDeltaAmountQuote(sqrtStart, first.sqrtPrice, first.liquidity, Rounding.Up);
  if (totalAmount > migrationThreshold) {
    return getNextSqrtPriceFromQuoteIn(sqrtStart, first.liquidity, migrationThreshold);
  }
  let amountLeft = migrationThreshold - castU64(totalAmount, "segment quote");
  let next = first.sqrtPrice;
  for (let i = 1; i < curve.length; i++) {
    const point = curve[i]!;
    const maxAmount = getDeltaAmountQuote(next, point.sqrtPrice, point.liquidity, Rounding.Up);
    if (maxAmount > amountLeft) {
      next = getNextSqrtPriceFromQuoteIn(next, point.liquidity, amountLeft);
      amountLeft = 0n;
      break;
    }
    amountLeft -= castU64(maxAmount, "segment quote");
    next = point.sqrtPrice;
  }
  if (amountLeft !== 0n) {
    throw new DbcMathError(
      "NotEnoughLiquidity",
      `curve absorbs ${migrationThreshold - amountLeft} of ${migrationThreshold} quote lamports`,
    );
  }
  return next;
}

/** Quote needed to walk from `sqrtStart` to `sqrtTarget` along `curve`, summing rounded-up segment amounts. */
export function getQuoteForPriceMove(sqrtStart: bigint, sqrtTarget: bigint, curve: readonly CurvePoint[]): bigint {
  let total = 0n;
  let current = sqrtStart;
  for (const point of curve) {
    if (current >= sqrtTarget) break;
    const upper = point.sqrtPrice < sqrtTarget ? point.sqrtPrice : sqrtTarget;
    if (upper > current) {
      total += getDeltaAmountQuote(current, upper, point.liquidity, Rounding.Up);
      current = upper;
    }
  }
  return total;
}

/** `min(swap_base * 1.25, max base sellable up to MAX_SQRT_PRICE)` (PROG/state/config.rs:876-894). */
export function getSwapAmountWithBuffer(swapBaseAmount: bigint, sqrtStart: bigint, curve: readonly CurvePoint[]): bigint {
  const swapAmountBuffer = (swapBaseAmount * SWAP_BUFFER_PERCENTAGE) / 100n + swapBaseAmount;
  const maxBaseAmountOnCurve = getBaseTokenForSwap(sqrtStart, MAX_SQRT_PRICE, curve);
  if (swapAmountBuffer < maxBaseAmountOnCurve) return castU64(swapAmountBuffer, "swap amount with buffer");
  return castU64(maxBaseAmountOnCurve, "max base on curve");
}

// ---------------------------------------------------------------------------------------------
// DAMM v2 full-range liquidity (PROG/migration_handler/concentrated_liquidity.rs)
// ---------------------------------------------------------------------------------------------

/** `L = Δb·2^128 / (√P − √P_min)`, rounding down, must fit u128 (concentrated_liquidity.rs:292-303). */
export function getInitialLiquidityFromDeltaQuote(quoteAmount: bigint, sqrtMinPrice: bigint, sqrtPrice: bigint): bigint {
  const priceDelta = sqrtPrice - sqrtMinPrice;
  if (priceDelta <= 0n) throw new DbcMathError("MathOverflow", "sqrt price below min");
  return castU128((quoteAmount << 128n) / priceDelta, "liquidity from quote");
}

/** `L = Δa·√P·√P_max / (√P_max − √P)`, rounding down, U512 (concentrated_liquidity.rs:278-289). */
export function getInitialLiquidityFromDeltaBase(baseAmount: bigint, sqrtMaxPrice: bigint, sqrtPrice: bigint): bigint {
  const priceDelta = sqrtMaxPrice - sqrtPrice;
  if (priceDelta <= 0n) throw new DbcMathError("MathOverflow", "sqrt price above max");
  return (baseAmount * sqrtPrice * sqrtMaxPrice) / priceDelta;
}

/** `min(L_base, L_quote)` (concentrated_liquidity.rs:259-275). */
export function calculateConcentratedInitialLiquidity(baseAmount: bigint, quoteAmount: bigint, sqrtMigrationPrice: bigint): bigint {
  const fromBase = getInitialLiquidityFromDeltaBase(baseAmount, MAX_SQRT_PRICE, sqrtMigrationPrice);
  const fromQuote = getInitialLiquidityFromDeltaQuote(quoteAmount, MIN_SQRT_PRICE, sqrtMigrationPrice);
  return fromBase > fromQuote ? fromQuote : castU128(fromBase, "liquidity from base");
}

// ---------------------------------------------------------------------------------------------
// Migration amounts (PROG/state/config.rs, PROG/migration_handler)
// ---------------------------------------------------------------------------------------------

export interface MigrationAmount {
  /** Quote earmarked for the DAMM v2 pool: `ceil(X·(100−f)/100)` (PROG/state/config.rs:846-858). */
  quoteAmount: bigint;
  /** The configurable partner/creator migration fee: `X − quoteAmount`. */
  fee: bigint;
}

export function getMigrationQuoteAmount(migrationQuoteThreshold: bigint, migrationFeePercentage: number): MigrationAmount {
  const quoteAmount = castU64(
    mulDiv(migrationQuoteThreshold, 100n - BigInt(migrationFeePercentage), 100n, Rounding.Up),
    "migration quote amount",
  );
  return { quoteAmount, fee: migrationQuoteThreshold - quoteAmount };
}

export interface MigrationFeeDistribution {
  creatorMigrationFee: bigint;
  partnerMigrationFee: bigint;
}

/** `creator = floor(fee·c_m/100)`, `partner = fee − creator` (PROG/state/config.rs:860-874). */
export function getMigrationFeeDistribution(fee: bigint, creatorMigrationFeePercentage: number): MigrationFeeDistribution {
  const creatorMigrationFee = mulDiv(fee, BigInt(creatorMigrationFeePercentage), 100n, Rounding.Down);
  return { creatorMigrationFee, partnerMigrationFee: fee - creatorMigrationFee };
}

/**
 * Base deposited into the DAMM v2 pool for a given quote deposit at the migration price
 * (`get_included_protocol_fee_migration_amounts_1`, concentrated_liquidity.rs:190-237).
 */
export function getMigrationBaseThreshold(quoteAmount: bigint, sqrtMigrationPrice: bigint): bigint {
  const liquidity = getInitialLiquidityFromDeltaQuote(quoteAmount, MIN_SQRT_PRICE, sqrtMigrationPrice);
  return castU64(getDeltaAmountBase(sqrtMigrationPrice, MAX_SQRT_PRICE, liquidity, Rounding.Up), "migration base threshold");
}

export interface ProtocolMigrationFee {
  baseFee: bigint;
  quoteFee: bigint;
}

/** 0.2% protocol liquidity migration fee (concentrated_liquidity.rs:147-172). */
export function getProtocolMigrationFees(
  depositQuoteAmount: bigint,
  sqrtMigrationPrice: bigint,
  feeBps: bigint = PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS,
): ProtocolMigrationFee {
  const quoteFee = castU64(mulDiv(depositQuoteAmount, feeBps, BASIS_POINT_MAX, Rounding.Down), "protocol migration quote fee");
  const feeLiquidity = getInitialLiquidityFromDeltaQuote(quoteFee, MIN_SQRT_PRICE, sqrtMigrationPrice);
  const baseFee = castU64(getDeltaAmountBase(sqrtMigrationPrice, MAX_SQRT_PRICE, feeLiquidity, Rounding.Down), "protocol migration base fee");
  return { baseFee, quoteFee };
}

/** `swap_base + migration_base + locked vesting total` (PROG/state/config.rs:896-905). */
export function getTotalTokenSupply(swapBaseAmount: bigint, migrationBaseThreshold: bigint, lockedVestingTotal: bigint): bigint {
  return castU64(swapBaseAmount + migrationBaseThreshold + lockedVestingTotal, "total token supply");
}

// ---------------------------------------------------------------------------------------------
// Surplus and trading fees (PROG/state/virtual_pool.rs:1130-1166; PROG/state/config.rs:139-220)
// ---------------------------------------------------------------------------------------------

export interface SurplusSplit {
  total: bigint;
  partnerAndCreator: bigint;
  creator: bigint;
  partner: bigint;
  protocol: bigint;
}

export function splitSurplus(totalSurplus: bigint, creatorTradingFeePercentage: number): SurplusSplit {
  assertNonNegative(totalSurplus, "surplus");
  const partnerAndCreator = mulDiv(totalSurplus, PARTNER_AND_CREATOR_SURPLUS_SHARE, 100n, Rounding.Down);
  const { creator, partner } = splitPartnerAndCreatorFee(partnerAndCreator, creatorTradingFeePercentage);
  return { total: totalSurplus, partnerAndCreator, creator, partner, protocol: totalSurplus - partnerAndCreator };
}

/** PROG/state/config.rs:1014-1033 */
export function splitPartnerAndCreatorFee(fee: bigint, creatorTradingFeePercentage: number): { partner: bigint; creator: bigint } {
  if (creatorTradingFeePercentage === 0) return { partner: fee, creator: 0n };
  const creator = mulDiv(fee, BigInt(creatorTradingFeePercentage), 100n, Rounding.Down);
  return { partner: fee - creator, creator };
}

export interface FeeOnAmount {
  /** Amount left after the fee. */
  amount: bigint;
  tradingFee: bigint;
  protocolFee: bigint;
  referralFee: bigint;
}

/** Fee taken from an included-fee amount: `ceil(amount·num/1e9)` then 20% protocol (PROG/state/config.rs:139-187). */
export function getFeeOnAmount(tradeFeeNumerator: bigint, amount: bigint, hasReferral: boolean): FeeOnAmount {
  const totalFee = castU64(mulDiv(amount, tradeFeeNumerator, FEE_DENOMINATOR, Rounding.Up), "trading fee");
  const excluded = amount - totalFee;
  let protocolFee = mulDiv(totalFee, PROTOCOL_FEE_PERCENT, 100n, Rounding.Down);
  const tradingFee = totalFee - protocolFee;
  const referralFee = hasReferral ? mulDiv(protocolFee, HOST_FEE_PERCENT, 100n, Rounding.Down) : 0n;
  protocolFee -= referralFee;
  return { amount: excluded, tradingFee, protocolFee, referralFee };
}

/** Gross amount a buyer must send so that `excludedFeeAmount` reaches the reserve (PROG/state/config.rs:189-201). */
export function getIncludedFeeAmount(tradeFeeNumerator: bigint, excludedFeeAmount: bigint): { included: bigint; fee: bigint } {
  const included = castU64(
    mulDiv(excludedFeeAmount, FEE_DENOMINATOR, FEE_DENOMINATOR - tradeFeeNumerator, Rounding.Up),
    "included fee amount",
  );
  return { included, fee: included - excludedFeeAmount };
}

export function bpsToFeeNumerator(bps: number): bigint {
  return (BigInt(bps) * FEE_DENOMINATOR) / BASIS_POINT_MAX;
}

export function feeNumeratorToBps(numerator: bigint): bigint {
  return (numerator * BASIS_POINT_MAX) / FEE_DENOMINATOR;
}

// ---------------------------------------------------------------------------------------------
// Fee scheduler (PROG/base_fee/fee_scheduler.rs, PROG/math/fee_math.rs)
// ---------------------------------------------------------------------------------------------

const MAX_EXPONENTIAL = 0x80000;

/** Q64.64 power (PROG/math/fee_math.rs:34-201). Returns null where the program returns None. */
export function powQ64(base: bigint, exp: number): bigint | null {
  if (exp === 0) return ONE_Q64;
  let invert = exp < 0;
  const e = Math.abs(exp);
  if (e >= MAX_EXPONENTIAL) return null;
  let squaredBase = base;
  let result = ONE_Q64;
  if (squaredBase >= result) {
    if (squaredBase === 0n) return null;
    squaredBase = U128_MAX / squaredBase;
    invert = !invert;
  }
  const mulShr = (a: bigint, b: bigint): bigint | null => {
    const p = a * b;
    if (p > U128_MAX) return null;
    return p >> 64n;
  };
  let bit = 1;
  for (let i = 0; i < 19; i++) {
    if (i > 0) {
      const sq = mulShr(squaredBase, squaredBase);
      if (sq === null) return null;
      squaredBase = sq;
    }
    if (e & bit) {
      const r = mulShr(result, squaredBase);
      if (r === null) return null;
      result = r;
    }
    bit <<= 1;
  }
  if (result === 0n) return null;
  if (invert) result = U128_MAX / result;
  return result;
}

/** `cliff·(1 − reduction/10_000)^period` (PROG/math/fee_math.rs:13-32). */
export function getFeeInPeriod(cliffFeeNumerator: bigint, reductionFactor: bigint, passedPeriod: number): bigint {
  const bps = (reductionFactor << 64n) / BASIS_POINT_MAX;
  if (bps > ONE_Q64) throw new DbcMathError("MathOverflow", "reduction factor above 100%");
  const base = ONE_Q64 - bps;
  const result = powQ64(base, passedPeriod);
  if (result === null) throw new DbcMathError("MathOverflow", "pow overflow");
  const prod = result * cliffFeeNumerator; // u128 `safe_mul` in the program: overflow is an error, not a wrap
  if (prod > U128_MAX) throw new DbcMathError("MathOverflow", "fee in period overflow");
  return castU64(prod >> 64n, "fee in period");
}

export interface FeeScheduler {
  cliffFeeNumerator: bigint;
  numberOfPeriod: number;
  periodFrequency: bigint;
  reductionFactor: bigint;
  linear: boolean;
}

/** Base fee numerator after `period` periods (PROG/base_fee/fee_scheduler.rs:42-62). */
export function getFeeSchedulerNumeratorByPeriod(s: FeeScheduler, period: number): bigint {
  const p = Math.min(period, s.numberOfPeriod);
  if (s.linear) {
    const fee = s.cliffFeeNumerator - s.reductionFactor * BigInt(p);
    if (fee < 0n) throw new DbcMathError("MathOverflow", "linear fee scheduler underflow");
    return fee;
  }
  return getFeeInPeriod(s.cliffFeeNumerator, s.reductionFactor, p);
}

export function getFeeSchedulerMinNumerator(s: FeeScheduler): bigint {
  return getFeeSchedulerNumeratorByPeriod(s, s.numberOfPeriod);
}
