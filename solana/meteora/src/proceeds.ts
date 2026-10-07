/**
 * Where the quote tokens (USDC) of a DBC raise go — exact bigint model of every route by which
 * quote can leave the DBC pool, and the depth of the graduated DAMM v2 pool.
 *
 * Program references (`PROG/` = dynamic-bonding-curve/programs/dynamic-bonding-curve/src):
 * - migration fee split: PROG/state/config.rs:846-874, PROG/instructions/migration/ix_withdraw_migration_fee.rs:89-128
 * - protocol liquidity migration fee (0.2%): PROG/constants.rs:107, PROG/migration_handler/concentrated_liquidity.rs:147-172
 * - surplus split: PROG/state/virtual_pool.rs:1130-1166, PROG/constants.rs:47
 * - trading fee split: PROG/state/config.rs:139-187 and 1014-1033, PROG/constants.rs:94-96
 * - DAMM v2 full-range liquidity: PROG/migration_handler/concentrated_liquidity.rs:259-303
 */
import { BASIS_POINT_MAX, MAX_SQRT_PRICE, MIN_SQRT_PRICE, Q128 } from "./constants.js";
import {
  calculateConcentratedInitialLiquidity,
  getDeltaAmountBase,
  getDeltaAmountQuote,
  getIncludedFeeAmount,
  getMigrationBaseThreshold,
  getMigrationFeeDistribution,
  getMigrationQuoteAmount,
  getNextSqrtPriceFromQuoteIn,
  getProtocolMigrationFees,
  isqrt,
  mulDiv,
  Rounding,
  splitPartnerAndCreatorFee,
  splitSurplus,
  type SurplusSplit,
} from "./math.js";

export interface ProceedsInput {
  /** `X`: migration_quote_threshold in quote lamports. */
  migrationQuoteThreshold: bigint;
  /** `f`: migration_fee.fee_percentage (0..=99). */
  migrationFeePercentage: number;
  /** `c_m`: migration_fee.creator_fee_percentage (0..=100). */
  creatorMigrationFeePercentage: number;
  /** `c_t`: creator_trading_fee_percentage (0..=100); also splits surplus. */
  creatorTradingFeePercentage: number;
  /** Fixed base fee numerator over 1e9 (QuoteToken collect mode, no dynamic fee, no referral). */
  tradingFeeNumerator: bigint;
  /** Quote reserve above `X` at completion (normally 0; see memo). */
  surplus?: bigint;
  /** Migration sqrt price, needed for the pool-depth part. */
  sqrtMigrationPrice: bigint;
}

export interface TradingFeeEstimate {
  /** Gross quote buyers must send so that exactly `X` net reaches the reserve (single-swap rounding). */
  grossPaidByBuyers: bigint;
  totalFee: bigint;
  protocol: bigint;
  partner: bigint;
  creator: bigint;
}

export interface PoolDepth {
  /** Concentrated liquidity `L` of the migrated full-range position(s). */
  liquidity: bigint;
  /** Quote actually usable by the pool at the migration price (`L (√P − √P_min) / 2^128`, rounded down). */
  quoteInPool: bigint;
  /** Base actually usable (`L (√P_max − √P) / (√P √P_max)`, rounded down). */
  baseInPool: bigint;
  /** Base left undeposited in the DBC vault (goes to `leftover_receiver` via `withdraw_leftover`). */
  baseLeftover: bigint;
  /** Quote lamports needed to push the pool price up by 10% / 50% / 100%. */
  quoteToMovePriceUp: { bps1000: bigint; bps5000: bigint; bps10000: bigint };
  /** Price impact (bps) of buying with 1,000 / 10,000 quote units (i.e. USDC × 10^6). */
  priceImpactBps: { quote1k: bigint; quote10k: bigint };
}

export interface ProceedsBreakdown {
  migrationQuoteThreshold: bigint;
  /** `Q_gross = ceil(X (100 − f) / 100)` — quote earmarked for DAMM v2 before the protocol's 0.2%. */
  quoteForPoolGross: bigint;
  /** `X − Q_gross` — the configurable migration fee. */
  migrationFeeTotal: bigint;
  creatorMigrationFee: bigint;
  partnerMigrationFee: bigint;
  /** `floor(Q_gross · 20 / 10_000)` — Meteora's protocol liquidity migration fee (quote side). */
  protocolLiquidityMigrationFeeQuote: bigint;
  /** `Q_net = Q_gross − protocol fee` — what actually becomes DAMM v2 liquidity. */
  quoteForPoolNet: bigint;
  surplus: SurplusSplit;
  tradingFees: TradingFeeEstimate;
  /** Base deposited alongside `Q_gross` (migration_base_threshold) and the protocol's base cut. */
  migrationBaseThreshold: bigint;
  protocolLiquidityMigrationFeeBase: bigint;
  pool: PoolDepth;
  /** Totals per party, quote only, excluding DAMM v2 position liquidity (which is not withdrawable when locked). */
  totals: { creator: bigint; partner: bigint; protocol: bigint; pool: bigint };
}

/** Aggregate trading fee for a curve that nets exactly `X` into the reserve, as if paid in one swap. */
export function estimateTradingFees(
  netQuote: bigint,
  tradingFeeNumerator: bigint,
  creatorTradingFeePercentage: number,
): TradingFeeEstimate {
  const { included, fee } = getIncludedFeeAmount(tradingFeeNumerator, netQuote);
  const protocol = mulDiv(fee, 20n, 100n, Rounding.Down);
  const lpFee = fee - protocol;
  const { partner, creator } = splitPartnerAndCreatorFee(lpFee, creatorTradingFeePercentage);
  return { grossPaidByBuyers: included, totalFee: fee, protocol, partner, creator };
}

/** `√P · sqrt(1 + bps/10_000)` in Q64.64 (exact integer sqrt of the Q128 product). */
export function sqrtPriceAfterUpMove(sqrtPrice: bigint, bps: bigint): bigint {
  return isqrt((sqrtPrice * sqrtPrice * (BASIS_POINT_MAX + bps)) / BASIS_POINT_MAX);
}

/** Price change in bps implied by moving from `sqrtFrom` to `sqrtTo`. */
export function priceChangeBps(sqrtFrom: bigint, sqrtTo: bigint): bigint {
  const from = sqrtFrom * sqrtFrom;
  const to = sqrtTo * sqrtTo;
  return ((to - from) * BASIS_POINT_MAX) / from;
}

export function computePoolDepth(baseNet: bigint, quoteNet: bigint, sqrtMigrationPrice: bigint): PoolDepth {
  const liquidity = calculateConcentratedInitialLiquidity(baseNet, quoteNet, sqrtMigrationPrice);
  const quoteInPool = getDeltaAmountQuote(MIN_SQRT_PRICE, sqrtMigrationPrice, liquidity, Rounding.Down);
  const baseInPool = getDeltaAmountBase(sqrtMigrationPrice, MAX_SQRT_PRICE, liquidity, Rounding.Down);
  const move = (bps: bigint): bigint =>
    getDeltaAmountQuote(sqrtMigrationPrice, sqrtPriceAfterUpMove(sqrtMigrationPrice, bps), liquidity, Rounding.Up);
  const impact = (quoteIn: bigint): bigint =>
    liquidity === 0n
      ? 0n
      : priceChangeBps(sqrtMigrationPrice, getNextSqrtPriceFromQuoteIn(sqrtMigrationPrice, liquidity, quoteIn));
  return {
    liquidity,
    quoteInPool,
    baseInPool,
    baseLeftover: baseNet > baseInPool ? baseNet - baseInPool : 0n,
    quoteToMovePriceUp: { bps1000: move(1000n), bps5000: move(5000n), bps10000: move(10000n) },
    priceImpactBps: { quote1k: impact(1_000_000_000n), quote10k: impact(10_000_000_000n) },
  };
}

export function computeProceeds(input: ProceedsInput): ProceedsBreakdown {
  const X = input.migrationQuoteThreshold;
  const { quoteAmount: quoteForPoolGross, fee: migrationFeeTotal } = getMigrationQuoteAmount(X, input.migrationFeePercentage);
  const { creatorMigrationFee, partnerMigrationFee } = getMigrationFeeDistribution(
    migrationFeeTotal,
    input.creatorMigrationFeePercentage,
  );
  const migrationBaseThreshold = getMigrationBaseThreshold(quoteForPoolGross, input.sqrtMigrationPrice);
  const protocolFees = getProtocolMigrationFees(quoteForPoolGross, input.sqrtMigrationPrice);
  const quoteForPoolNet = quoteForPoolGross - protocolFees.quoteFee;
  const baseNet = migrationBaseThreshold - protocolFees.baseFee;
  const surplus = splitSurplus(input.surplus ?? 0n, input.creatorTradingFeePercentage);
  const tradingFees = estimateTradingFees(X, input.tradingFeeNumerator, input.creatorTradingFeePercentage);
  const pool = computePoolDepth(baseNet, quoteForPoolNet, input.sqrtMigrationPrice);
  return {
    migrationQuoteThreshold: X,
    quoteForPoolGross,
    migrationFeeTotal,
    creatorMigrationFee,
    partnerMigrationFee,
    protocolLiquidityMigrationFeeQuote: protocolFees.quoteFee,
    quoteForPoolNet,
    surplus,
    tradingFees,
    migrationBaseThreshold,
    protocolLiquidityMigrationFeeBase: protocolFees.baseFee,
    pool,
    totals: {
      creator: creatorMigrationFee + surplus.creator + tradingFees.creator,
      partner: partnerMigrationFee + surplus.partner + tradingFees.partner,
      protocol: protocolFees.quoteFee + surplus.protocol + tradingFees.protocol,
      pool: pool.quoteInPool,
    },
  };
}

/** Quote lamports per base lamport, WAD-scaled, for a Q64.64 sqrt price. */
export function lamportPriceWad(sqrtPrice: bigint): bigint {
  return (sqrtPrice * sqrtPrice * 1_000_000_000_000_000_000n) / Q128;
}
