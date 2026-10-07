import { describe, expect, it } from "vitest";
import BN from "bn.js";
import * as sdk from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  MAX_SQRT_PRICE,
  MERCES_BASE_PER_UNIT,
  MIN_SQRT_PRICE,
  ONE_Q64,
  Q128,
  TokenAuthorityOption,
  USDC_MINT_MAINNET,
  WAD,
} from "../src/constants.js";
import {
  buildIssuerLockedVesting,
  buildMercesCurveConfig,
  formatUnits,
  MercesConfigError,
  mercesCurveConfigFromJson,
  mercesCurveConfigToJson,
  type MercesCurveConfig,
  type MercesCurveInput,
} from "../src/config.js";
import { getBaseTokenForSwap, getDeltaAmountQuote, getMigrationThresholdPrice, isqrt, Rounding } from "../src/math.js";
import { lockedVestingTotal, toSdkConfigParameters } from "../src/types.js";

const USDC = 1_000_000n;
const bn = (x: bigint): BN => new BN(x.toString());
const big = (x: BN): bigint => BigInt(x.toString());

const EXAMPLE: MercesCurveInput = {
  seriesLabel: "example-issuer-1",
  trailingAnnualIncome: 40_000n * USDC,
  targetRaise: 100_000n * USDC,
  unitsOnCurve: 10_000n,
  quoteMint: USDC_MINT_MAINNET,
};

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MercesConfigError);
    expect((e as MercesConfigError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

/**
 * Drive the SDK's own swap simulator (a port of the program's swap math) over a Merces config until the
 * curve completes, the way the graduation script's buy loop does on devnet.
 */
function simulateBuyLoop(cfg: MercesCurveConfig, chunks: bigint[]) {
  const p = toSdkConfigParameters(cfg.configParameters);
  const poolConfig = {
    ...p,
    migrationSqrtPrice: bn(cfg.derived.migrationSqrtPrice),
    poolFees: { ...p.poolFees, dynamicFee: { initialized: 0, binStep: 0, variableFeeControl: 0 } },
  } as unknown as sdk.PoolConfig;
  const pool = {
    poolState: {
      sqrtPrice: bn(cfg.configParameters.sqrtStartPrice),
      baseReserve: bn(cfg.derived.initialBaseSupply),
      quoteReserve: new BN(0),
      activationPoint: new BN(0),
      volatilityTracker: {
        lastUpdateTimestamp: new BN(0),
        sqrtPriceReference: new BN(0),
        volatilityAccumulator: new BN(0),
        volatilityReference: new BN(0),
        padding: [],
      },
    },
  } as unknown as sdk.VirtualPool;
  let baseSold = 0n;
  let quotePaid = 0n;
  let fees = 0n;
  let swaps = 0;
  for (const amountIn of chunks) {
    if (big(pool.poolState.quoteReserve) >= cfg.configParameters.migrationQuoteThreshold) break;
    const q = sdk.swapQuotePartialFill(pool, poolConfig, false, bn(amountIn), 0, false, new BN(1), false);
    pool.poolState.quoteReserve = pool.poolState.quoteReserve.add(q.excludedFeeInputAmount);
    pool.poolState.sqrtPrice = q.nextSqrtPrice;
    baseSold += big(q.outputAmount);
    quotePaid += big(q.includedFeeInputAmount);
    fees += big(q.tradingFee) + big(q.protocolFee) + big(q.referralFee);
    swaps++;
  }
  return { quoteReserve: big(pool.poolState.quoteReserve), sqrtPrice: big(pool.poolState.sqrtPrice), baseSold, quotePaid, fees, swaps };
}

describe("buildMercesCurveConfig — known answers for the canonical example", () => {
  const cfg = buildMercesCurveConfig(EXAMPLE);
  it("anchors the raise and the prices to income", () => {
    expect(cfg.anchoring.maxRaise).toBe(120_000n * USDC); // 3 × 40_000
    expect(cfg.anchoring.migrationQuoteThreshold).toBe(100_000n * USDC); // min(T, μI) = T
    expect(cfg.anchoring.raiseCappedByIncome).toBe(false);
    // start FDV = 1 × I over 10_000 units → 4 USDC per unit → √4 · 2^64
    expect(cfg.anchoring.sqrtStartPrice).toBe(2n * ONE_Q64);
    expect(cfg.anchoring.startPricePerUnit).toBe(4n * USDC);
    // average price = X / N_pub = 10 USDC; migration price = avg² / start = 25 USDC → √25 · 2^64
    expect(cfg.anchoring.averagePricePerUnit).toBe(10n * USDC);
    expect(cfg.anchoring.sqrtCurveEnd).toBe(5n * ONE_Q64);
    // the program derives migration_sqrt_price = start + floor(X·2^128 / L), one unit below the curve end
    expect(cfg.anchoring.sqrtMigrationPrice).toBe(5n * ONE_Q64 - 1n);
    expect(cfg.anchoring.migrationPricePerUnit).toBe(24_999_999n);
    expect(cfg.anchoring.priceRampWad).toBe((625n * WAD) / 100n); // 6.25×
    expect(cfg.anchoring.curveLiquidity).toBe(614891469123651720533333333334n);
  });
  it("derives the program-stored values", () => {
    expect(cfg.derived.swapBaseAmount).toBe(10_000n * MERCES_BASE_PER_UNIT); // exactly the public allocation
    expect(cfg.derived.unitsSoldOnCurve).toBe("10000.000000");
    expect(cfg.derived.migrationBaseThreshold).toBe(40_000_000n); // 40 units pair 1,000 USDC at 25 USDC/unit
    expect(cfg.derived.initialBaseSupply).toBe(10_040_000_001n);
    expect(cfg.configParameters.tokenSupply).toEqual({ preMigrationTokenSupply: 10_040_000_001n, postMigrationTokenSupply: 10_040_000_001n });
    expect(cfg.derived.p0PerUnit).toBe(10n * USDC);
    expect(cfg.derived.capPerUnit).toBe(25n * USDC); // 2.5 × P0
    expect(cfg.derived.lockedLiquidityBpsAtOneDay).toBe(10_000);
  });
  it("routes proceeds per the default (migration fee 99%, creator 100%)", () => {
    const p = cfg.proceeds;
    expect(p.quoteForPoolGross).toBe(1_000n * USDC);
    expect(p.migrationFeeTotal).toBe(99_000n * USDC);
    expect(p.creatorMigrationFee).toBe(99_000n * USDC);
    expect(p.partnerMigrationFee).toBe(0n);
    expect(p.protocolLiquidityMigrationFeeQuote).toBe(2n * USDC);
    expect(p.quoteForPoolNet).toBe(998n * USDC);
    expect(p.tradingFees.grossPaidByBuyers).toBe(101_010_101_011n);
    expect(p.tradingFees.partner).toBe(808_080_809n);
    expect(p.tradingFees.protocol).toBe(202_020_202n);
    expect(p.pool.quoteInPool).toBe(997_999_999n);
    expect(p.pool.priceImpactBps.quote1k).toBe(30_080n); // a 1,000 USDC buy triples the price of a 998 USDC pool
  });
  it("is deterministic and survives a JSON round trip", () => {
    const again = buildMercesCurveConfig(EXAMPLE);
    expect(mercesCurveConfigToJson(again)).toBe(mercesCurveConfigToJson(cfg));
    expect(cfg.configHash).toBe("7b1664a9118e62e7629fbd4d58cafcf19b00ab8831925ff998c6941cf5545b26");
    const parsed = mercesCurveConfigFromJson(mercesCurveConfigToJson(cfg));
    expect(parsed).toEqual(cfg);
    // tampering with a stored parameter is detected
    const tampered = JSON.parse(mercesCurveConfigToJson(cfg));
    tampered.configParameters.migrationQuoteThreshold = "99999999999";
    expect(() => mercesCurveConfigFromJson(JSON.stringify(tampered))).toThrow(/does not reproduce/);
    const tamperedInput = JSON.parse(mercesCurveConfigToJson(cfg));
    tamperedInput.input.targetRaise = "99999000000";
    expect(() => mercesCurveConfigFromJson(JSON.stringify(tamperedInput))).toThrow(/does not reproduce/);
  });
});

describe("buildMercesCurveConfig — curve properties", () => {
  const variants: MercesCurveInput[] = [
    EXAMPLE,
    { ...EXAMPLE, issuerUnits: 1_000n },
    { ...EXAMPLE, trailingAnnualIncome: 20_000n * USDC }, // raise capped at 60_000 by μ = 3
    { ...EXAMPLE, unitsOnCurve: 1n, targetRaise: 7n * USDC, trailingAnnualIncome: 3n * USDC },
    { ...EXAMPLE, unitsOnCurve: 123_456_789n, targetRaise: 987_654_321_123n, trailingAnnualIncome: 500_000_000_000n },
    { ...EXAMPLE, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    { ...EXAMPLE, migrationFee: { feePercentage: 20, creatorFeePercentage: 100 } },
    { ...EXAMPLE, migrationFee: { feePercentage: 50, creatorFeePercentage: 50 } },
    { ...EXAMPLE, startValuationMultipleWad: WAD / 10n, maxPriceRampWad: 1_000n * WAD },
  ];
  it("sqrt prices are within program bounds and strictly increasing; LP percentages sum to 100", () => {
    for (const v of variants) {
      const cfg = buildMercesCurveConfig(v);
      const p = cfg.configParameters;
      expect(p.sqrtStartPrice >= MIN_SQRT_PRICE && p.sqrtStartPrice < MAX_SQRT_PRICE).toBe(true);
      let prev = p.sqrtStartPrice;
      for (const c of p.curve) {
        expect(c.sqrtPrice > prev).toBe(true);
        expect(c.sqrtPrice <= MAX_SQRT_PRICE).toBe(true);
        expect(c.liquidity > 0n).toBe(true);
        prev = c.sqrtPrice;
      }
      expect(cfg.derived.migrationSqrtPrice < MAX_SQRT_PRICE).toBe(true);
      expect(cfg.derived.migrationSqrtPrice > p.sqrtStartPrice).toBe(true);
      expect(
        p.partnerLiquidityPercentage +
          p.partnerPermanentLockedLiquidityPercentage +
          p.creatorLiquidityPercentage +
          p.creatorPermanentLockedLiquidityPercentage +
          p.partnerLiquidityVestingInfo.vestingPercentage +
          p.creatorLiquidityVestingInfo.vestingPercentage,
      ).toBe(100);
    }
  });
  it("sqrt prices match the SDK's helper for the same decimal prices", () => {
    for (const v of variants) {
      const cfg = buildMercesCurveConfig(v);
      const dec = cfg.input.tokenDecimals;
      // exact lamport price ν·I / issued units as a 30-digit decimal string (the SDK takes a decimal price)
      const startValuation = (cfg.input.startValuationMultipleWad * cfg.input.trailingAnnualIncome) / WAD;
      const scaled = (startValuation * 10n ** 30n) / cfg.anchoring.issuedUnitsBase;
      const priceStr = `${scaled / 10n ** 30n}.${(scaled % 10n ** 30n).toString().padStart(30, "0")}`;
      const theirs = big(sdk.getSqrtPriceFromPrice(priceStr, dec, dec));
      const diff = theirs > cfg.anchoring.sqrtStartPrice ? theirs - cfg.anchoring.sqrtStartPrice : cfg.anchoring.sqrtStartPrice - theirs;
      // the SDK rounds through 20 significant decimal digits; allow 1e-15 relative error
      expect(diff * 10n ** 15n <= cfg.anchoring.sqrtStartPrice).toBe(true);
      // and the program-side derivation agrees with the SDK's port
      expect(cfg.derived.migrationSqrtPrice.toString()).toBe(
        sdk.getMigrationThresholdPrice(bn(cfg.configParameters.migrationQuoteThreshold), bn(cfg.configParameters.sqrtStartPrice), cfg.configParameters.curve.map((c) => ({ sqrtPrice: bn(c.sqrtPrice), liquidity: bn(c.liquidity) }))).toString(),
      );
      expect(cfg.derived.swapBaseAmount.toString()).toBe(
        sdk.getBaseTokenForSwap(bn(cfg.configParameters.sqrtStartPrice), bn(cfg.derived.migrationSqrtPrice), cfg.configParameters.curve.map((c) => ({ sqrtPrice: bn(c.sqrtPrice), liquidity: bn(c.liquidity) }))).toString(),
      );
    }
  });
  it("the curve sells the public allocation within rounding and absorbs exactly the threshold", () => {
    for (const v of variants) {
      const cfg = buildMercesCurveConfig(v);
      const X = cfg.configParameters.migrationQuoteThreshold;
      const unitsBase = cfg.input.unitsOnCurve * MERCES_BASE_PER_UNIT;
      const sold = cfg.derived.swapBaseAmount;
      const diff = sold > unitsBase ? sold - unitsBase : unitsBase - sold;
      // |sold − N_pub| ≤ 2 base lamports (1e-6 of a unit) from the sqrt-price floors; N_pub itself for tiny raises
      expect(diff <= 2n || diff * 1_000_000n <= unitsBase).toBe(true);
      // quote needed to reach the program-derived migration price equals X
      const quote = getDeltaAmountQuote(cfg.configParameters.sqrtStartPrice, cfg.derived.migrationSqrtPrice, cfg.anchoring.curveLiquidity, Rounding.Up);
      expect(quote).toBe(X);
      expect(getMigrationThresholdPrice(X, cfg.configParameters.sqrtStartPrice, cfg.configParameters.curve)).toBe(cfg.derived.migrationSqrtPrice);
      expect(getBaseTokenForSwap(cfg.configParameters.sqrtStartPrice, cfg.derived.migrationSqrtPrice, cfg.configParameters.curve)).toBe(sold);
    }
  });
  it("raise math: the SDK swap simulator completes the curve with quote_reserve == threshold (±1 lamport)", () => {
    const cfg = buildMercesCurveConfig(EXAMPLE);
    const X = cfg.configParameters.migrationQuoteThreshold;
    for (const chunks of [
      [200_000n * USDC], // one buyer overshoots: partial fill stops exactly at the threshold
      [10_000n * USDC, 25_000n * USDC, 40_000n * USDC, 30_000n * USDC, 50_000n * USDC],
      Array.from({ length: 40 }, (_, i) => BigInt(1_000 + 317 * i) * USDC),
      Array.from({ length: 2_000 }, () => 60n * USDC),
    ]) {
      const r = simulateBuyLoop(cfg, chunks);
      expect(r.quoteReserve >= X && r.quoteReserve <= X + 1n).toBe(true);
      expect(r.sqrtPrice).toBe(cfg.derived.migrationSqrtPrice);
      // base sold is at most the design value; per-swap floors can only leave dust unsold
      expect(r.baseSold <= cfg.derived.swapBaseAmount).toBe(true);
      expect(cfg.derived.swapBaseAmount - r.baseSold <= BigInt(r.swaps)).toBe(true);
      // what buyers paid in total = reserve + fees, and the fee is 1% of the gross (rounded up per swap)
      expect(r.quotePaid).toBe(r.quoteReserve + r.fees);
      expect(r.fees >= r.quotePaid / 100n && r.fees <= r.quotePaid / 100n + BigInt(r.swaps)).toBe(true);
    }
  });
  it("a raise above μ × income is capped", () => {
    const cfg = buildMercesCurveConfig({ ...EXAMPLE, trailingAnnualIncome: 20_000n * USDC });
    expect(cfg.anchoring.raiseCappedByIncome).toBe(true);
    expect(cfg.configParameters.migrationQuoteThreshold).toBe(60_000n * USDC);
    expect(cfg.anchoring.averagePricePerUnit).toBe(6n * USDC);
    // 20_000 / 10_000 = 2 USDC, but √2·2^64 is floored so the price read back is one lamport short
    expect(cfg.anchoring.startPricePerUnit).toBe(2n * USDC - 1n);
    expect(cfg.anchoring.sqrtStartPrice).toBe(isqrt(2n * Q128));
    // (6/2)² = 9, up to the sqrt floors (relative 1e-9)
    const ramp = cfg.anchoring.priceRampWad;
    expect(ramp >= 9n * WAD - 10n ** 9n && ramp <= 9n * WAD + 10n ** 9n).toBe(true);
  });
  it("issuer allocation is minted into the fixed supply and vests through the locker", () => {
    const cfg = buildMercesCurveConfig({ ...EXAMPLE, issuerUnits: 1_000n });
    const lv = cfg.configParameters.lockedVesting;
    expect(lockedVestingTotal(lv)).toBe(1_000n * MERCES_BASE_PER_UNIT);
    expect(lv.numberOfPeriod).toBe(12n);
    expect(lv.frequency).toBe(2_629_800n);
    expect(lv.amountPerPeriod).toBe((1_000n * MERCES_BASE_PER_UNIT) / 12n);
    expect(lv.cliffUnlockAmount).toBe(1_000n * MERCES_BASE_PER_UNIT - 12n * lv.amountPerPeriod); // the remainder
    expect(cfg.derived.initialBaseSupply).toBe(cfg.derived.swapBaseAmount + cfg.derived.migrationBaseThreshold + 1_000n * MERCES_BASE_PER_UNIT + 1n);
    // start FDV counts the issuer units
    expect(cfg.anchoring.startPricePerUnit).toBe((40_000n * USDC) / 11_000n);
    expect(cfg.anchoring.sqrtStartPrice).toBe(isqrt((40_000n * USDC * Q128) / (11_000n * USDC)));
  });
  it("cliff-only vesting uses the one-lamport trailing period encoding", () => {
    const lv = buildIssuerLockedVesting(5n * MERCES_BASE_PER_UNIT, { cliffSeconds: 86_400, periods: 0, periodSeconds: 0 });
    expect(lv).toEqual({ amountPerPeriod: 1n, cliffDurationFromMigrationTime: 86_400n, frequency: 1n, numberOfPeriod: 1n, cliffUnlockAmount: 5n * MERCES_BASE_PER_UNIT - 1n });
    expect(lockedVestingTotal(lv)).toBe(5n * MERCES_BASE_PER_UNIT);
    const sdkEquivalent = sdk.getLockedVestingParams(5, 0, 5, 0, 86_400, sdk.TokenDecimal.SIX);
    expect(big(sdkEquivalent.cliffUnlockAmount) + big(sdkEquivalent.amountPerPeriod) * big(sdkEquivalent.numberOfPeriod)).toBe(5n * MERCES_BASE_PER_UNIT);
    expect(buildIssuerLockedVesting(0n, { cliffSeconds: 1, periods: 1, periodSeconds: 1 })).toEqual({ amountPerPeriod: 0n, cliffDurationFromMigrationTime: 0n, frequency: 0n, numberOfPeriod: 0n, cliffUnlockAmount: 0n });
  });
  it("token authority leaves no mint authority after creation", () => {
    const cfg = buildMercesCurveConfig(EXAMPLE);
    expect(cfg.configParameters.tokenUpdateAuthority).toBe(TokenAuthorityOption.Immutable);
    // options 3/4 (mint authority kept) are rejected by the program for non-transfer-hook configs
    expect(() => buildMercesCurveConfig({ ...EXAMPLE, tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAndMintAuthority })).toThrow(/InvalidTokenAuthorityOption/);
  });
});

describe("buildMercesCurveConfig — rejections", () => {
  it("start price must be below the average price", () => {
    // ν = 3 with X = 3 × I makes start = average
    expectCode(() => buildMercesCurveConfig({ ...EXAMPLE, trailingAnnualIncome: 20_000n * USDC, startValuationMultipleWad: 3n * WAD }), "StartPriceNotBelowAveragePrice");
    expectCode(() => buildMercesCurveConfig({ ...EXAMPLE, startValuationMultipleWad: 10n * WAD }), "StartPriceNotBelowAveragePrice");
  });
  it("price ramp bound", () => {
    expectCode(() => buildMercesCurveConfig({ ...EXAMPLE, maxPriceRampWad: 6n * WAD }), "PriceRampTooSteep"); // 6.25 > 6
    buildMercesCurveConfig({ ...EXAMPLE, maxPriceRampWad: (625n * WAD) / 100n });
  });
  it("input bounds", () => {
    expectCode(() => buildMercesCurveConfig({ ...EXAMPLE, trailingAnnualIncome: 0n }), "InvalidInput");
    expectCode(() => buildMercesCurveConfig({ ...EXAMPLE, targetRaise: 0n }), "InvalidInput");
    expectCode(() => buildMercesCurveConfig({ ...EXAMPLE, unitsOnCurve: 0n }), "InvalidInput");
    expectCode(() => buildMercesCurveConfig({ ...EXAMPLE, issuerUnits: -1n }), "InvalidInput");
    expectCode(() => buildMercesCurveConfig({ ...EXAMPLE, quoteDecimals: 9 }), "UnsupportedQuoteDecimals");
    expectCode(() => buildMercesCurveConfig({ ...EXAMPLE, tradingFeeBps: 10 }), "InvalidInput");
    expectCode(() => buildMercesCurveConfig({ ...EXAMPLE, tradingFeeBps: 9_901 }), "InvalidInput");
    expectCode(() => buildMercesCurveConfig({ ...EXAMPLE, quoteMint: "not-a-pubkey" }), "InvalidInput");
    expectCode(() => buildMercesCurveConfig({ ...EXAMPLE, issuerUnits: 10n, issuerVesting: { cliffSeconds: 0, periods: 3, periodSeconds: 0 } }), "InvalidInput");
  });
  it("program-level rejections surface as DbcValidationError", () => {
    expect(() => buildMercesCurveConfig({ ...EXAMPLE, tokenDecimals: 0 })).toThrow(/InvalidTokenDecimals/);
    expect(() => buildMercesCurveConfig({ ...EXAMPLE, migrationFee: { feePercentage: 100, creatorFeePercentage: 100 } })).toThrow(/InvalidMigratorFeePercentage/);
    expect(() =>
      buildMercesCurveConfig({
        ...EXAMPLE,
        liquidityDistribution: { partnerLiquidityPercentage: 100, partnerPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
      }),
    ).toThrow(/InvalidMigrationLockedLiquidity/);
    expect(() =>
      buildMercesCurveConfig({
        ...EXAMPLE,
        liquidityDistribution: { partnerLiquidityPercentage: 50, partnerPermanentLockedLiquidityPercentage: 40, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0 },
      }),
    ).toThrow(/InvalidFeePercentage/);
  });
});

describe("formatUnits", () => {
  it("formats base amounts", () => {
    expect(formatUnits(10_040_000_001n, 6)).toBe("10040.000001");
    expect(formatUnits(5n, 6)).toBe("0.000005");
    expect(formatUnits(7n, 0)).toBe("7");
  });
});
