import { describe, expect, it } from "vitest";
import * as sdk from "@meteora-ag/dynamic-bonding-curve-sdk";
import { Keypair } from "@solana/web3.js";
import {
  BaseFeeMode,
  CollectFeeMode,
  DammV2BaseFeeMode,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  ONE_Q64,
  TokenAuthorityOption,
  TokenType,
  USDC_MINT_MAINNET,
} from "../src/constants.js";
import { buildMercesCurveConfig } from "../src/config.js";
import { isqrt } from "../src/math.js";
import { fromSdkConfigParameters, toSdkConfigParameters, type DbcConfigParameters } from "../src/types.js";
import { DbcValidationError, validateDbcConfigParameters } from "../src/validate.js";

const USDC = 1_000_000n;

function baseline(): DbcConfigParameters {
  return buildMercesCurveConfig({
    trailingAnnualIncome: 40_000n * USDC,
    targetRaise: 100_000n * USDC,
    unitsOnCurve: 10_000n,
    issuerUnits: 1_000n,
    quoteMint: USDC_MINT_MAINNET,
  }).configParameters;
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DbcValidationError);
    expect((e as DbcValidationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("validateDbcConfigParameters mirrors the program's ConfigParameters::validate", () => {
  it("accepts the generator's baseline and derives the stored values", () => {
    const p = baseline();
    const d = validateDbcConfigParameters(p);
    expect(d.migrationSqrtPrice <= p.curve[0]!.sqrtPrice).toBe(true);
    expect(d.swapBaseAmount > 0n).toBe(true);
    expect(d.migrationBaseThreshold > 0n).toBe(true);
    expect(d.lockedLiquidityBpsAtOneDay).toBe(10_000);
    expect(d.initialBaseSupply).toBe(p.tokenSupply!.preMigrationTokenSupply);
  });

  it("activation type", () => expectCode(() => validateDbcConfigParameters({ ...baseline(), activationType: 2 }), "TypeCastFailed"));

  it("base fee mode and scheduler", () => {
    const p = baseline();
    expectCode(() => validateDbcConfigParameters({ ...p, poolFees: { ...p.poolFees, baseFee: { ...p.poolFees.baseFee, baseFeeMode: 7 } } }), "InvalidBaseFeeMode");
    expectCode(() => validateDbcConfigParameters({ ...p, poolFees: { ...p.poolFees, baseFee: { ...p.poolFees.baseFee, baseFeeMode: BaseFeeMode.RateLimiter } } }), "DeprecatedBaseFeeMode");
    // partially specified scheduler
    expectCode(() => validateDbcConfigParameters({ ...p, poolFees: { ...p.poolFees, baseFee: { ...p.poolFees.baseFee, firstFactor: 3 } } }), "InvalidFeeScheduler");
    // below min fee (0.25%) and above max fee (99%)
    expectCode(() => validateDbcConfigParameters({ ...p, poolFees: { ...p.poolFees, baseFee: { ...p.poolFees.baseFee, cliffFeeNumerator: 2_499_999n } } }), "ExceedMaxFeeBps");
    expectCode(() => validateDbcConfigParameters({ ...p, poolFees: { ...p.poolFees, baseFee: { ...p.poolFees.baseFee, cliffFeeNumerator: 990_000_001n } } }), "ExceedMaxFeeBps");
    expectCode(() => validateDbcConfigParameters({ ...p, poolFees: { ...p.poolFees, baseFee: { ...p.poolFees.baseFee, cliffFeeNumerator: 1_000_000_000n } } }), "InvalidFee");
    // a valid linear scheduler whose min is below the floor
    expectCode(
      () =>
        validateDbcConfigParameters({
          ...p,
          poolFees: { ...p.poolFees, baseFee: { cliffFeeNumerator: 100_000_000n, firstFactor: 10, secondFactor: 60n, thirdFactor: 9_800_000n, baseFeeMode: BaseFeeMode.FeeSchedulerLinear } },
        }),
      "ExceedMaxFeeBps",
    );
    // and one that is fine
    validateDbcConfigParameters({
      ...p,
      poolFees: { ...p.poolFees, baseFee: { cliffFeeNumerator: 100_000_000n, firstFactor: 10, secondFactor: 60n, thirdFactor: 9_000_000n, baseFeeMode: BaseFeeMode.FeeSchedulerLinear } },
    });
  });

  it("dynamic fee", () => {
    const p = baseline();
    const dyn = { binStep: 1, binStepU128: 1844674407370955n, filterPeriod: 10, decayPeriod: 120, reductionFactor: 5000, maxVolatilityAccumulator: 1000, variableFeeControl: 1000 };
    validateDbcConfigParameters({ ...p, poolFees: { ...p.poolFees, dynamicFee: dyn } });
    expectCode(() => validateDbcConfigParameters({ ...p, poolFees: { ...p.poolFees, dynamicFee: { ...dyn, binStep: 2 } } }), "InvalidInput");
    expectCode(() => validateDbcConfigParameters({ ...p, poolFees: { ...p.poolFees, dynamicFee: { ...dyn, filterPeriod: 120 } } }), "InvalidInput");
    expectCode(() => validateDbcConfigParameters({ ...p, poolFees: { ...p.poolFees, dynamicFee: { ...dyn, variableFeeControl: 0x1000000 } } }), "InvalidInput");
  });

  it("creator trading fee percentage", () => expectCode(() => validateDbcConfigParameters({ ...baseline(), creatorTradingFeePercentage: 101 }), "InvalidCreatorTradingFeePercentage"));

  it("migration fee", () => {
    const p = baseline();
    expectCode(() => validateDbcConfigParameters({ ...p, migrationFee: { feePercentage: 100, creatorFeePercentage: 0 } }), "InvalidMigratorFeePercentage");
    expectCode(() => validateDbcConfigParameters({ ...p, migrationFee: { feePercentage: 0, creatorFeePercentage: 1 } }), "InvalidMigratorFeePercentage");
    expectCode(() => validateDbcConfigParameters({ ...p, migrationFee: { feePercentage: 10, creatorFeePercentage: 101 } }), "InvalidMigratorFeePercentage");
    // a lower migration fee deposits more base into DAMM v2, so the fixed supply of the baseline is too small...
    expectCode(() => validateDbcConfigParameters({ ...p, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } }), "InvalidTokenSupply");
    // ...but with dynamic supply the fee change alone is fine
    validateDbcConfigParameters({ ...p, tokenSupply: null, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } });
  });

  it("enum discriminants", () => {
    const p = baseline();
    expectCode(() => validateDbcConfigParameters({ ...p, collectFeeMode: 2 }), "InvalidCollectFeeMode");
    expectCode(() => validateDbcConfigParameters({ ...p, migrationOption: 2 }), "InvalidMigrationOption");
    expectCode(() => validateDbcConfigParameters({ ...p, migrationOption: MigrationOption.MeteoraDamm }), "DeprecatedMigrationOption");
    expectCode(() => validateDbcConfigParameters({ ...p, migrationFeeOption: 7 }), "InvalidMigrationFeeOption");
    expectCode(() => validateDbcConfigParameters({ ...p, tokenType: 2 }), "InvalidTokenType");
    expectCode(() => validateDbcConfigParameters({ ...p, tokenUpdateAuthority: 5 }), "InvalidTokenAuthorityOption");
    expectCode(() => validateDbcConfigParameters({ ...p, tokenUpdateAuthority: TokenAuthorityOption.CreatorUpdateAndMintAuthority }), "InvalidTokenAuthorityOption");
    validateDbcConfigParameters({ ...p, tokenUpdateAuthority: TokenAuthorityOption.CreatorUpdateAndMintAuthority }, { isTransferHook: true });
  });

  it("migrated pool fee must be zero unless Customizable, and valid when Customizable", () => {
    const p = baseline();
    expectCode(() => validateDbcConfigParameters({ ...p, migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 100 } }), "InvalidMigratedPoolFee");
    const custom = { ...p, migrationFeeOption: MigrationFeeOption.Customizable };
    expectCode(() => validateDbcConfigParameters({ ...custom, migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 9 } }), "InvalidMigratedPoolFee");
    expectCode(() => validateDbcConfigParameters({ ...custom, migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 1001 } }), "InvalidMigratedPoolFee");
    expectCode(() => validateDbcConfigParameters({ ...custom, migratedPoolFee: { collectFeeMode: 3, dynamicFee: 0, poolFeeBps: 100 } }), "InvalidCollectFeeMode");
    expectCode(() => validateDbcConfigParameters({ ...custom, migratedPoolFee: { collectFeeMode: 0, dynamicFee: 2, poolFeeBps: 100 } }), "InvalidMigratedPoolFee");
    expectCode(() => validateDbcConfigParameters({ ...custom, migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 100 }, compoundingFeeBps: 5 }), "InvalidMigratedPoolFee");
    expectCode(() => validateDbcConfigParameters({ ...custom, migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.Compounding, dynamicFee: 0, poolFeeBps: 100 } }), "InvalidMigratedPoolFee");
    expectCode(() => validateDbcConfigParameters({ ...custom, migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 100 }, migratedPoolBaseFeeMode: DammV2BaseFeeMode.RateLimiter }), "InvalidMigratedPoolFee");
    expectCode(() => validateDbcConfigParameters({ ...custom, migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 100 }, migratedPoolMarketCapFeeSchedulerParams: { numberOfPeriod: 1, sqrtPriceStepBps: 0, schedulerExpirationDuration: 0, reductionFactor: 0n } }), "InvalidMigratedPoolFee");
    validateDbcConfigParameters({ ...custom, migratedPoolFee: { collectFeeMode: 0, dynamicFee: 1, poolFeeBps: 100 } });
    // market-cap scheduler: needs every field > 0 and a floor above DAMM v2's min fee
    const mc = { ...custom, migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 200 }, migratedPoolBaseFeeMode: DammV2BaseFeeMode.FeeMarketCapSchedulerLinear };
    expectCode(() => validateDbcConfigParameters({ ...mc, migratedPoolMarketCapFeeSchedulerParams: { numberOfPeriod: 10, sqrtPriceStepBps: 100, schedulerExpirationDuration: 3600, reductionFactor: 0n } }), "InvalidFeeMarketCapScheduler");
    expectCode(() => validateDbcConfigParameters({ ...mc, migratedPoolMarketCapFeeSchedulerParams: { numberOfPeriod: 10, sqrtPriceStepBps: 100, schedulerExpirationDuration: 3600, reductionFactor: 2_000_000n } }), "ExceedMaxFeeBps");
    validateDbcConfigParameters({ ...mc, migratedPoolMarketCapFeeSchedulerParams: { numberOfPeriod: 10, sqrtPriceStepBps: 100, schedulerExpirationDuration: 3600, reductionFactor: 1_000_000n } });
    // Compounding is a documented gap of the validator
    expectCode(() => validateDbcConfigParameters({ ...custom, migratedPoolFee: { collectFeeMode: MigratedCollectFeeMode.Compounding, dynamicFee: 0, poolFeeBps: 100 }, compoundingFeeBps: 100 }), "UnsupportedByValidator");
  });

  it("token decimals 6..=9 (0 is not possible)", () => {
    const p = baseline();
    expectCode(() => validateDbcConfigParameters({ ...p, tokenDecimal: 0 }), "InvalidTokenDecimals");
    expectCode(() => validateDbcConfigParameters({ ...p, tokenDecimal: 5 }), "InvalidTokenDecimals");
    expectCode(() => validateDbcConfigParameters({ ...p, tokenDecimal: 10 }), "InvalidTokenDecimals");
  });

  it("liquidity percentages must sum to 100 and keep 10% locked on day one", () => {
    const p = baseline();
    expectCode(() => validateDbcConfigParameters({ ...p, partnerPermanentLockedLiquidityPercentage: 99 }), "InvalidFeePercentage");
    expectCode(() => validateDbcConfigParameters({ ...p, partnerPermanentLockedLiquidityPercentage: 0, partnerLiquidityPercentage: 100 }), "InvalidMigrationLockedLiquidity");
    expectCode(() => validateDbcConfigParameters({ ...p, partnerPermanentLockedLiquidityPercentage: 9, partnerLiquidityPercentage: 91 }), "InvalidMigrationLockedLiquidity");
    validateDbcConfigParameters({ ...p, partnerPermanentLockedLiquidityPercentage: 10, creatorLiquidityPercentage: 90 });
    // vesting liquidity counts as locked on day one when its cliff is a day or more. Note the program's
    // u128 floor arithmetic makes a 10% vesting bucket worth 999 bps, not 1000, so 10% vesting alone fails.
    expectCode(
      () =>
        validateDbcConfigParameters({
          ...p,
          partnerPermanentLockedLiquidityPercentage: 0,
          creatorLiquidityPercentage: 90,
          creatorLiquidityVestingInfo: { vestingPercentage: 10, bpsPerPeriod: 1000, numberOfPeriods: 10, cliffDurationFromMigrationTime: 86_400, frequency: 86_400 },
        }),
      "InvalidMigrationLockedLiquidity",
    );
    expect(
      sdk.calculateLockedLiquidityBpsAtTime(0, 0, undefined, { vestingPercentage: 10, bpsPerPeriod: 1000, numberOfPeriods: 10, cliffDurationFromMigrationTime: 86_400, frequency: 86_400 }, 86_400),
    ).toBe(999);
    validateDbcConfigParameters({
      ...p,
      partnerPermanentLockedLiquidityPercentage: 1,
      creatorLiquidityPercentage: 89,
      creatorLiquidityVestingInfo: { vestingPercentage: 10, bpsPerPeriod: 1000, numberOfPeriods: 10, cliffDurationFromMigrationTime: 86_400, frequency: 86_400 },
    });
    expectCode(
      () =>
        validateDbcConfigParameters({
          ...p,
          partnerPermanentLockedLiquidityPercentage: 0,
          creatorLiquidityPercentage: 90,
          creatorLiquidityVestingInfo: { vestingPercentage: 10, bpsPerPeriod: 10_000, numberOfPeriods: 1, cliffDurationFromMigrationTime: 0, frequency: 3600 },
        }),
      "InvalidMigrationLockedLiquidity",
    );
    expectCode(
      () =>
        validateDbcConfigParameters({
          ...p,
          partnerPermanentLockedLiquidityPercentage: 0,
          creatorLiquidityPercentage: 90,
          creatorLiquidityVestingInfo: { vestingPercentage: 10, bpsPerPeriod: 100, numberOfPeriods: 100, cliffDurationFromMigrationTime: 0, frequency: 700_000 },
        }),
      "InvalidVestingParameters", // 100 · 700_000 s > 2 years
    );
  });

  it("quote threshold, locked vesting, pool creation fee", () => {
    const p = baseline();
    expectCode(() => validateDbcConfigParameters({ ...p, migrationQuoteThreshold: 0n }), "InvalidQuoteThreshold");
    expectCode(() => validateDbcConfigParameters({ ...p, lockedVesting: { ...p.lockedVesting, frequency: 0n } }), "InvalidVestingParameters");
    expectCode(() => validateDbcConfigParameters({ ...p, lockedVesting: { amountPerPeriod: 0n, cliffDurationFromMigrationTime: 10n, frequency: 1n, numberOfPeriod: 0n, cliffUnlockAmount: 0n } }), "InvalidVestingParameters");
    expectCode(() => validateDbcConfigParameters({ ...p, poolCreationFee: 999_999n }), "InvalidPoolCreationFee");
    expectCode(() => validateDbcConfigParameters({ ...p, poolCreationFee: 100_000_000_001n }), "InvalidPoolCreationFee");
    validateDbcConfigParameters({ ...p, poolCreationFee: 1_000_000n });
  });

  it("curve shape", () => {
    const p = baseline();
    expectCode(() => validateDbcConfigParameters({ ...p, sqrtStartPrice: MIN_SQRT_PRICE - 1n }), "InvalidCurve");
    expectCode(() => validateDbcConfigParameters({ ...p, sqrtStartPrice: MAX_SQRT_PRICE }), "InvalidCurve");
    expectCode(() => validateDbcConfigParameters({ ...p, curve: [] }), "InvalidCurve");
    expectCode(() => validateDbcConfigParameters({ ...p, curve: Array.from({ length: 17 }, (_, i) => ({ sqrtPrice: p.sqrtStartPrice + BigInt(i + 1), liquidity: 1n })) }), "InvalidCurve");
    expectCode(() => validateDbcConfigParameters({ ...p, curve: [{ sqrtPrice: p.sqrtStartPrice, liquidity: 1n }] }), "InvalidCurve");
    expectCode(() => validateDbcConfigParameters({ ...p, curve: [{ ...p.curve[0]!, liquidity: 0n }] }), "InvalidCurve");
    expectCode(() => validateDbcConfigParameters({ ...p, curve: [p.curve[0]!, { sqrtPrice: p.curve[0]!.sqrtPrice, liquidity: 1n }] }), "InvalidCurve");
    expectCode(() => validateDbcConfigParameters({ ...p, curve: [p.curve[0]!, { sqrtPrice: MAX_SQRT_PRICE + 1n, liquidity: 1n }] }), "InvalidCurve");
    // too little liquidity to absorb the threshold
    expectCode(() => validateDbcConfigParameters({ ...p, curve: [{ ...p.curve[0]!, liquidity: p.curve[0]!.liquidity / 2n }] }), "NotEnoughLiquidity");
    // migration exactly at MAX_SQRT_PRICE is rejected
    expectCode(() => validateDbcConfigParameters({ ...p, curve: [{ sqrtPrice: MAX_SQRT_PRICE, liquidity: 1n }], migrationQuoteThreshold: 1n }), "InvalidCurve");
  });

  it("fixed supply bounds and leftover receiver", () => {
    const p = baseline();
    const pre = p.tokenSupply!.preMigrationTokenSupply;
    expectCode(() => validateDbcConfigParameters({ ...p, tokenSupply: { preMigrationTokenSupply: pre - 1n, postMigrationTokenSupply: pre - 1n } }), "InvalidTokenSupply");
    expectCode(() => validateDbcConfigParameters({ ...p, tokenSupply: { preMigrationTokenSupply: pre, postMigrationTokenSupply: pre + 1n } }), "InvalidTokenSupply");
    expectCode(() => validateDbcConfigParameters(p, { leftoverReceiverIsDefault: true }), "InvalidLeftoverAddress");
    validateDbcConfigParameters({ ...p, tokenSupply: { preMigrationTokenSupply: pre * 2n, postMigrationTokenSupply: pre } });
    // dynamic supply never checks the leftover receiver
    validateDbcConfigParameters({ ...p, tokenSupply: null }, { leftoverReceiverIsDefault: true });
  });
});

describe("agreement with the SDK's buildCurve outputs and validator", () => {
  function sdkCurve(f: number, lockedVesting = 0): sdk.ConfigParameters {
    return sdk.buildCurve({
      token: { tokenType: sdk.TokenType.Token2022, tokenBaseDecimal: sdk.TokenDecimal.SIX, tokenQuoteDecimal: 6, tokenAuthorityOption: sdk.TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000, leftover: 0 },
      fee: {
        baseFeeParams: { baseFeeMode: sdk.BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } },
        dynamicFeeEnabled: false,
        collectFeeMode: sdk.CollectFeeMode.QuoteToken,
        creatorTradingFeePercentage: 0,
        poolCreationFee: 0,
        enableFirstSwapWithMinFee: false,
      },
      migration: { migrationOption: sdk.MigrationOption.MET_DAMM_V2, migrationFeeOption: sdk.MigrationFeeOption.FixedBps100, migrationFee: { feePercentage: f, creatorFeePercentage: f === 0 ? 0 : 100 } },
      liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 100, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
      lockedVesting: { totalLockedVestingAmount: lockedVesting, numberOfVestingPeriod: lockedVesting ? 12 : 0, cliffUnlockAmount: 0, totalVestingDuration: lockedVesting ? 31_557_600 : 0, cliffDurationFromMigrationTime: 0 },
      activationType: sdk.ActivationType.Timestamp,
      percentageSupplyOnMigration: 20,
      migrationQuoteThreshold: 100_000,
    });
  }
  it("the program-mirror validator accepts SDK-built configs and derives the same values the SDK does", () => {
    // (the SDK's own builder cannot express f = 99 with a 20% migration allocation: its derived start price
    // would exceed the migration price and `getFirstCurve` throws — one reason Merces anchors the curve itself)
    expect(() => sdkCurve(99)).toThrow();
    for (const [f, v] of [
      [0, 0],
      [20, 0],
      [50, 50_000],
    ] as const) {
      const s = sdkCurve(f, v);
      const mine = fromSdkConfigParameters(s);
      const d = validateDbcConfigParameters(mine);
      expect(d.migrationSqrtPrice.toString()).toBe(sdk.getMigrationThresholdPrice(s.migrationQuoteThreshold, s.sqrtStartPrice, s.curve).toString());
      // round trip through the SDK type keeps every field
      expect(fromSdkConfigParameters(toSdkConfigParameters(mine))).toEqual(mine);
      // and the SDK's own validator agrees on acceptance
      sdk.validateConfigParameters({ ...s, leftoverReceiver: Keypair.generate().publicKey });
    }
  });
  it("the SDK's validator also accepts the Merces generator's output", () => {
    const p = toSdkConfigParameters(baseline());
    expect(() => sdk.validateConfigParameters({ ...p, leftoverReceiver: Keypair.generate().publicKey })).not.toThrow();
  });
  it("both validators reject a decimal-0 token and an unlocked pool", () => {
    const p = toSdkConfigParameters(baseline());
    expect(() => sdk.validateConfigParameters({ ...p, tokenDecimal: 0 as never, leftoverReceiver: Keypair.generate().publicKey })).toThrow();
    expect(() => sdk.validateConfigParameters({ ...p, partnerPermanentLockedLiquidityPercentage: 0, partnerLiquidityPercentage: 100, leftoverReceiver: Keypair.generate().publicKey })).toThrow();
  });
});

describe("Merces defaults are expressed in program terms", () => {
  it("baseline parameters", () => {
    const p = baseline();
    expect(p.tokenType).toBe(TokenType.Token2022);
    expect(p.tokenDecimal).toBe(6);
    expect(p.collectFeeMode).toBe(CollectFeeMode.QuoteToken);
    expect(p.migrationOption).toBe(MigrationOption.DammV2);
    expect(p.migrationFeeOption).toBe(MigrationFeeOption.FixedBps100);
    expect(p.tokenUpdateAuthority).toBe(TokenAuthorityOption.Immutable);
    expect(p.migrationFee).toEqual({ feePercentage: 99, creatorFeePercentage: 100 });
    expect(p.creatorTradingFeePercentage).toBe(0);
    expect(p.poolFees.baseFee.cliffFeeNumerator).toBe(10_000_000n); // 100 bps
    expect(p.partnerPermanentLockedLiquidityPercentage).toBe(100);
    // start FDV over 11_000 issued units = 40_000 USDC → P_start = 40_000 / 11_000 USDC per unit
    expect(p.sqrtStartPrice).toBe(isqrt((40_000n * USDC * (1n << 128n)) / (11_000n * USDC)));
    expect(p.sqrtStartPrice < 2n * ONE_Q64).toBe(true);
  });
});
