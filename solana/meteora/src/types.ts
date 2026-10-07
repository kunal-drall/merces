/**
 * TypeScript mirror of the program's `ConfigParameters` (PROG process_create_config.rs:39-71) with
 * `bigint` for every u64/u128 field, plus lossless conversion to the SDK's BN-based `ConfigParameters`
 * and a canonical JSON form (bigints as decimal strings) for deterministic config files.
 */
import BN from "bn.js";
import type { ConfigParameters as SdkConfigParameters } from "@meteora-ag/dynamic-bonding-curve-sdk";
import type { CurvePoint } from "./math.js";

export interface BaseFeeParameters {
  cliffFeeNumerator: bigint;
  /** Fee scheduler: number of periods (u16). */
  firstFactor: number;
  /** Fee scheduler: period frequency (u64). */
  secondFactor: bigint;
  /** Fee scheduler: reduction factor (u64). */
  thirdFactor: bigint;
  /** `BaseFeeMode` discriminant (u8). */
  baseFeeMode: number;
}

export interface DynamicFeeParameters {
  binStep: number;
  binStepU128: bigint;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  maxVolatilityAccumulator: number;
  variableFeeControl: number;
}

export interface PoolFeeParameters {
  baseFee: BaseFeeParameters;
  dynamicFee: DynamicFeeParameters | null;
}

export interface LockedVestingParams {
  amountPerPeriod: bigint;
  cliffDurationFromMigrationTime: bigint;
  frequency: bigint;
  numberOfPeriod: bigint;
  cliffUnlockAmount: bigint;
}

export interface TokenSupplyParams {
  preMigrationTokenSupply: bigint;
  postMigrationTokenSupply: bigint;
}

export interface MigrationFee {
  feePercentage: number;
  creatorFeePercentage: number;
}

export interface MigratedPoolFee {
  collectFeeMode: number;
  dynamicFee: number;
  poolFeeBps: number;
}

export interface LiquidityVestingInfoParams {
  vestingPercentage: number;
  bpsPerPeriod: number;
  numberOfPeriods: number;
  cliffDurationFromMigrationTime: number;
  frequency: number;
}

export interface MigratedPoolMarketCapFeeSchedulerParams {
  numberOfPeriod: number;
  sqrtPriceStepBps: number;
  schedulerExpirationDuration: number;
  reductionFactor: bigint;
}

/** Field-for-field mirror of the on-chain `ConfigParameters` (camelCase, as the SDK/IDL spell them). */
export interface DbcConfigParameters {
  poolFees: PoolFeeParameters;
  collectFeeMode: number;
  migrationOption: number;
  activationType: number;
  tokenType: number;
  tokenDecimal: number;
  partnerLiquidityPercentage: number;
  partnerPermanentLockedLiquidityPercentage: number;
  creatorLiquidityPercentage: number;
  creatorPermanentLockedLiquidityPercentage: number;
  migrationQuoteThreshold: bigint;
  sqrtStartPrice: bigint;
  lockedVesting: LockedVestingParams;
  migrationFeeOption: number;
  tokenSupply: TokenSupplyParams | null;
  creatorTradingFeePercentage: number;
  tokenUpdateAuthority: number;
  migrationFee: MigrationFee;
  migratedPoolFee: MigratedPoolFee;
  poolCreationFee: bigint;
  partnerLiquidityVestingInfo: LiquidityVestingInfoParams;
  creatorLiquidityVestingInfo: LiquidityVestingInfoParams;
  migratedPoolBaseFeeMode: number;
  migratedPoolMarketCapFeeSchedulerParams: MigratedPoolMarketCapFeeSchedulerParams;
  enableFirstSwapWithMinFee: boolean;
  compoundingFeeBps: number;
  curve: CurvePoint[];
}

export const ZERO_LOCKED_VESTING: LockedVestingParams = {
  amountPerPeriod: 0n,
  cliffDurationFromMigrationTime: 0n,
  frequency: 0n,
  numberOfPeriod: 0n,
  cliffUnlockAmount: 0n,
};

export const ZERO_LIQUIDITY_VESTING: LiquidityVestingInfoParams = {
  vestingPercentage: 0,
  bpsPerPeriod: 0,
  numberOfPeriods: 0,
  cliffDurationFromMigrationTime: 0,
  frequency: 0,
};

export const ZERO_MIGRATED_POOL_FEE: MigratedPoolFee = { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 0 };

export const ZERO_MARKET_CAP_SCHEDULER: MigratedPoolMarketCapFeeSchedulerParams = {
  numberOfPeriod: 0,
  sqrtPriceStepBps: 0,
  schedulerExpirationDuration: 0,
  reductionFactor: 0n,
};

export function hasLockedVesting(v: LockedVestingParams): boolean {
  return (
    v.amountPerPeriod !== 0n ||
    v.cliffDurationFromMigrationTime !== 0n ||
    v.frequency !== 0n ||
    v.numberOfPeriod !== 0n ||
    v.cliffUnlockAmount !== 0n
  );
}

export function lockedVestingTotal(v: LockedVestingParams): bigint {
  return v.cliffUnlockAmount + v.amountPerPeriod * v.numberOfPeriod;
}

export function isZeroLiquidityVesting(v: LiquidityVestingInfoParams): boolean {
  return (
    v.vestingPercentage === 0 &&
    v.bpsPerPeriod === 0 &&
    v.numberOfPeriods === 0 &&
    v.cliffDurationFromMigrationTime === 0 &&
    v.frequency === 0
  );
}

// ---------------------------------------------------------------------------------------------
// SDK conversion
// ---------------------------------------------------------------------------------------------

const bn = (x: bigint): BN => new BN(x.toString());
const big = (x: BN | number | string | bigint): bigint => (typeof x === "bigint" ? x : BigInt(x.toString()));

/** Lossless conversion to the SDK's `ConfigParameters` (the argument of `client.partner.createConfig`). */
export function toSdkConfigParameters(p: DbcConfigParameters): SdkConfigParameters {
  return {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: bn(p.poolFees.baseFee.cliffFeeNumerator),
        firstFactor: p.poolFees.baseFee.firstFactor,
        secondFactor: bn(p.poolFees.baseFee.secondFactor),
        thirdFactor: bn(p.poolFees.baseFee.thirdFactor),
        baseFeeMode: p.poolFees.baseFee.baseFeeMode,
      },
      dynamicFee: p.poolFees.dynamicFee
        ? {
            binStep: p.poolFees.dynamicFee.binStep,
            binStepU128: bn(p.poolFees.dynamicFee.binStepU128),
            filterPeriod: p.poolFees.dynamicFee.filterPeriod,
            decayPeriod: p.poolFees.dynamicFee.decayPeriod,
            reductionFactor: p.poolFees.dynamicFee.reductionFactor,
            maxVolatilityAccumulator: p.poolFees.dynamicFee.maxVolatilityAccumulator,
            variableFeeControl: p.poolFees.dynamicFee.variableFeeControl,
          }
        : null,
    },
    collectFeeMode: p.collectFeeMode,
    migrationOption: p.migrationOption,
    activationType: p.activationType,
    tokenType: p.tokenType,
    tokenDecimal: p.tokenDecimal,
    partnerLiquidityPercentage: p.partnerLiquidityPercentage,
    partnerPermanentLockedLiquidityPercentage: p.partnerPermanentLockedLiquidityPercentage,
    creatorLiquidityPercentage: p.creatorLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: p.creatorPermanentLockedLiquidityPercentage,
    migrationQuoteThreshold: bn(p.migrationQuoteThreshold),
    sqrtStartPrice: bn(p.sqrtStartPrice),
    lockedVesting: {
      amountPerPeriod: bn(p.lockedVesting.amountPerPeriod),
      cliffDurationFromMigrationTime: bn(p.lockedVesting.cliffDurationFromMigrationTime),
      frequency: bn(p.lockedVesting.frequency),
      numberOfPeriod: bn(p.lockedVesting.numberOfPeriod),
      cliffUnlockAmount: bn(p.lockedVesting.cliffUnlockAmount),
    },
    migrationFeeOption: p.migrationFeeOption,
    tokenSupply: p.tokenSupply
      ? {
          preMigrationTokenSupply: bn(p.tokenSupply.preMigrationTokenSupply),
          postMigrationTokenSupply: bn(p.tokenSupply.postMigrationTokenSupply),
        }
      : null,
    creatorTradingFeePercentage: p.creatorTradingFeePercentage,
    tokenUpdateAuthority: p.tokenUpdateAuthority,
    migrationFee: { feePercentage: p.migrationFee.feePercentage, creatorFeePercentage: p.migrationFee.creatorFeePercentage },
    migratedPoolFee: { ...p.migratedPoolFee },
    poolCreationFee: bn(p.poolCreationFee),
    partnerLiquidityVestingInfo: { ...p.partnerLiquidityVestingInfo },
    creatorLiquidityVestingInfo: { ...p.creatorLiquidityVestingInfo },
    migratedPoolBaseFeeMode: p.migratedPoolBaseFeeMode,
    migratedPoolMarketCapFeeSchedulerParams: {
      numberOfPeriod: p.migratedPoolMarketCapFeeSchedulerParams.numberOfPeriod,
      sqrtPriceStepBps: p.migratedPoolMarketCapFeeSchedulerParams.sqrtPriceStepBps,
      schedulerExpirationDuration: p.migratedPoolMarketCapFeeSchedulerParams.schedulerExpirationDuration,
      reductionFactor: bn(p.migratedPoolMarketCapFeeSchedulerParams.reductionFactor),
    },
    enableFirstSwapWithMinFee: p.enableFirstSwapWithMinFee,
    compoundingFeeBps: p.compoundingFeeBps,
    padding: [],
    curve: p.curve.map((c) => ({ sqrtPrice: bn(c.sqrtPrice), liquidity: bn(c.liquidity) })),
  };
}

/** Inverse of `toSdkConfigParameters` (used to validate SDK-built configs with the program-mirror validator). */
export function fromSdkConfigParameters(s: SdkConfigParameters): DbcConfigParameters {
  return {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: big(s.poolFees.baseFee.cliffFeeNumerator),
        firstFactor: s.poolFees.baseFee.firstFactor,
        secondFactor: big(s.poolFees.baseFee.secondFactor),
        thirdFactor: big(s.poolFees.baseFee.thirdFactor),
        baseFeeMode: s.poolFees.baseFee.baseFeeMode,
      },
      dynamicFee: s.poolFees.dynamicFee
        ? {
            binStep: s.poolFees.dynamicFee.binStep,
            binStepU128: big(s.poolFees.dynamicFee.binStepU128),
            filterPeriod: s.poolFees.dynamicFee.filterPeriod,
            decayPeriod: s.poolFees.dynamicFee.decayPeriod,
            reductionFactor: s.poolFees.dynamicFee.reductionFactor,
            maxVolatilityAccumulator: s.poolFees.dynamicFee.maxVolatilityAccumulator,
            variableFeeControl: s.poolFees.dynamicFee.variableFeeControl,
          }
        : null,
    },
    collectFeeMode: s.collectFeeMode,
    migrationOption: s.migrationOption,
    activationType: s.activationType,
    tokenType: s.tokenType,
    tokenDecimal: s.tokenDecimal,
    partnerLiquidityPercentage: s.partnerLiquidityPercentage,
    partnerPermanentLockedLiquidityPercentage: s.partnerPermanentLockedLiquidityPercentage,
    creatorLiquidityPercentage: s.creatorLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: s.creatorPermanentLockedLiquidityPercentage,
    migrationQuoteThreshold: big(s.migrationQuoteThreshold),
    sqrtStartPrice: big(s.sqrtStartPrice),
    lockedVesting: {
      amountPerPeriod: big(s.lockedVesting.amountPerPeriod),
      cliffDurationFromMigrationTime: big(s.lockedVesting.cliffDurationFromMigrationTime),
      frequency: big(s.lockedVesting.frequency),
      numberOfPeriod: big(s.lockedVesting.numberOfPeriod),
      cliffUnlockAmount: big(s.lockedVesting.cliffUnlockAmount),
    },
    migrationFeeOption: s.migrationFeeOption,
    tokenSupply: s.tokenSupply
      ? {
          preMigrationTokenSupply: big(s.tokenSupply.preMigrationTokenSupply),
          postMigrationTokenSupply: big(s.tokenSupply.postMigrationTokenSupply),
        }
      : null,
    creatorTradingFeePercentage: s.creatorTradingFeePercentage,
    tokenUpdateAuthority: s.tokenUpdateAuthority,
    migrationFee: { feePercentage: s.migrationFee.feePercentage, creatorFeePercentage: s.migrationFee.creatorFeePercentage },
    migratedPoolFee: {
      collectFeeMode: s.migratedPoolFee.collectFeeMode,
      dynamicFee: s.migratedPoolFee.dynamicFee,
      poolFeeBps: s.migratedPoolFee.poolFeeBps,
    },
    poolCreationFee: big(s.poolCreationFee),
    partnerLiquidityVestingInfo: { ...s.partnerLiquidityVestingInfo },
    creatorLiquidityVestingInfo: { ...s.creatorLiquidityVestingInfo },
    migratedPoolBaseFeeMode: s.migratedPoolBaseFeeMode,
    migratedPoolMarketCapFeeSchedulerParams: {
      numberOfPeriod: s.migratedPoolMarketCapFeeSchedulerParams.numberOfPeriod,
      sqrtPriceStepBps: s.migratedPoolMarketCapFeeSchedulerParams.sqrtPriceStepBps,
      schedulerExpirationDuration: s.migratedPoolMarketCapFeeSchedulerParams.schedulerExpirationDuration,
      reductionFactor: big(s.migratedPoolMarketCapFeeSchedulerParams.reductionFactor),
    },
    enableFirstSwapWithMinFee: s.enableFirstSwapWithMinFee,
    compoundingFeeBps: s.compoundingFeeBps,
    curve: s.curve.map((c) => ({ sqrtPrice: big(c.sqrtPrice), liquidity: big(c.liquidity) })),
  };
}

// ---------------------------------------------------------------------------------------------
// Canonical JSON (bigint <-> decimal string)
// ---------------------------------------------------------------------------------------------

/** JSON value where every bigint became a decimal string. */
export type Jsonified<T> = T extends bigint
  ? string
  : T extends (infer U)[]
    ? Jsonified<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonified<T[K]> }
      : T;

export function jsonify<T>(value: T): Jsonified<T> {
  if (typeof value === "bigint") return value.toString() as Jsonified<T>;
  if (Array.isArray(value)) return value.map((v) => jsonify(v)) as Jsonified<T>;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonify(v);
    return out as Jsonified<T>;
  }
  return value as Jsonified<T>;
}

/** Deterministic JSON: key order is insertion order (fixed by construction), bigints are decimal strings, 2-space indent, trailing newline. */
export function toCanonicalJson(value: unknown): string {
  return `${JSON.stringify(jsonify(value), null, 2)}\n`;
}

const BIG_FIELDS = new Set([
  "cliffFeeNumerator",
  "secondFactor",
  "thirdFactor",
  "binStepU128",
  "migrationQuoteThreshold",
  "sqrtStartPrice",
  "amountPerPeriod",
  "cliffDurationFromMigrationTime", // bigint in LockedVestingParams, number in LiquidityVestingInfoParams (handled below)
  "frequency", // same remark
  "numberOfPeriod",
  "cliffUnlockAmount",
  "preMigrationTokenSupply",
  "postMigrationTokenSupply",
  "poolCreationFee",
  "reductionFactor", // bigint in the market-cap scheduler, number in dynamic fee (handled below)
  "sqrtPrice",
  "liquidity",
]);

/** Parse the `configParameters` object of a config file back into bigint form. */
export function configParametersFromJson(j: Jsonified<DbcConfigParameters>): DbcConfigParameters {
  const asBig = (v: string | number): bigint => BigInt(v);
  return {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: asBig(j.poolFees.baseFee.cliffFeeNumerator),
        firstFactor: j.poolFees.baseFee.firstFactor,
        secondFactor: asBig(j.poolFees.baseFee.secondFactor),
        thirdFactor: asBig(j.poolFees.baseFee.thirdFactor),
        baseFeeMode: j.poolFees.baseFee.baseFeeMode,
      },
      dynamicFee: j.poolFees.dynamicFee
        ? { ...j.poolFees.dynamicFee, binStepU128: asBig(j.poolFees.dynamicFee.binStepU128) }
        : null,
    },
    collectFeeMode: j.collectFeeMode,
    migrationOption: j.migrationOption,
    activationType: j.activationType,
    tokenType: j.tokenType,
    tokenDecimal: j.tokenDecimal,
    partnerLiquidityPercentage: j.partnerLiquidityPercentage,
    partnerPermanentLockedLiquidityPercentage: j.partnerPermanentLockedLiquidityPercentage,
    creatorLiquidityPercentage: j.creatorLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: j.creatorPermanentLockedLiquidityPercentage,
    migrationQuoteThreshold: asBig(j.migrationQuoteThreshold),
    sqrtStartPrice: asBig(j.sqrtStartPrice),
    lockedVesting: {
      amountPerPeriod: asBig(j.lockedVesting.amountPerPeriod),
      cliffDurationFromMigrationTime: asBig(j.lockedVesting.cliffDurationFromMigrationTime),
      frequency: asBig(j.lockedVesting.frequency),
      numberOfPeriod: asBig(j.lockedVesting.numberOfPeriod),
      cliffUnlockAmount: asBig(j.lockedVesting.cliffUnlockAmount),
    },
    migrationFeeOption: j.migrationFeeOption,
    tokenSupply: j.tokenSupply
      ? {
          preMigrationTokenSupply: asBig(j.tokenSupply.preMigrationTokenSupply),
          postMigrationTokenSupply: asBig(j.tokenSupply.postMigrationTokenSupply),
        }
      : null,
    creatorTradingFeePercentage: j.creatorTradingFeePercentage,
    tokenUpdateAuthority: j.tokenUpdateAuthority,
    migrationFee: { ...j.migrationFee },
    migratedPoolFee: { ...j.migratedPoolFee },
    poolCreationFee: asBig(j.poolCreationFee),
    partnerLiquidityVestingInfo: { ...j.partnerLiquidityVestingInfo },
    creatorLiquidityVestingInfo: { ...j.creatorLiquidityVestingInfo },
    migratedPoolBaseFeeMode: j.migratedPoolBaseFeeMode,
    migratedPoolMarketCapFeeSchedulerParams: {
      ...j.migratedPoolMarketCapFeeSchedulerParams,
      reductionFactor: asBig(j.migratedPoolMarketCapFeeSchedulerParams.reductionFactor),
    },
    enableFirstSwapWithMinFee: j.enableFirstSwapWithMinFee,
    compoundingFeeBps: j.compoundingFeeBps,
    curve: j.curve.map((c) => ({ sqrtPrice: asBig(c.sqrtPrice), liquidity: asBig(c.liquidity) })),
  };
}

// `BIG_FIELDS` documents which JSON fields carry decimal strings; the typed parser above is authoritative.
export const BIGINT_JSON_FIELDS: ReadonlySet<string> = BIG_FIELDS;
