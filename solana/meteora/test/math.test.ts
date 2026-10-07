import { describe, expect, it } from "vitest";
import BN from "bn.js";
import * as sdk from "@meteora-ag/dynamic-bonding-curve-sdk";
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE, ONE_Q64, Q128 } from "../src/constants.js";
import * as m from "../src/math.js";

const bn = (x: bigint): BN => new BN(x.toString());
const big = (x: BN): bigint => BigInt(x.toString());

// A deterministic pseudo-random generator so the property checks are reproducible.
function lcg(seed: bigint): () => bigint {
  let s = seed;
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return s;
  };
}

describe("isqrt", () => {
  it("is the floor square root for small and large values", () => {
    for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 30n, (1n << 128n) - 1n, 1n << 200n]) {
      const r = m.isqrt(n);
      expect(r * r <= n).toBe(true);
      expect((r + 1n) * (r + 1n) > n).toBe(true);
    }
  });
  it("matches the SDK's decimal sqrt price for USDC/HEU prices", () => {
    // price = quote lamports per base lamport; both mints have 6 decimals so the lamport price equals the unit price.
    for (const price of [0.000001, 0.5, 1, 4, 10, 25, 123.456789, 1_000_000]) {
      const num = BigInt(Math.round(price * 1e9));
      const mine = m.sqrtPriceFromRatio(num, 1_000_000_000n);
      const theirs = big(sdk.getSqrtPriceFromPrice(price.toString(), 6, 6));
      const diff = mine > theirs ? mine - theirs : theirs - mine;
      // the SDK rounds through 20 significant decimal digits; allow 1e-15 relative error
      expect(diff * 10n ** 15n <= theirs).toBe(true);
    }
    // exact powers: price 4 → √4 · 2^64
    expect(m.sqrtPriceFromRatio(4n, 1n)).toBe(2n * ONE_Q64);
    expect(m.sqrtPriceFromRatio(25n, 1n)).toBe(5n * ONE_Q64);
  });
});

describe("curve deltas agree with the SDK (bn.js port of the program)", () => {
  const rnd = lcg(42n);
  const cases: { lower: bigint; upper: bigint; liquidity: bigint }[] = [];
  for (let i = 0; i < 200; i++) {
    const lower = MIN_SQRT_PRICE + (rnd() % (1n << 70n));
    const upper = lower + 1n + (rnd() % (1n << 70n));
    const liquidity = 1n + (rnd() % (1n << 100n));
    cases.push({ lower, upper, liquidity });
  }
  it("getDeltaAmountQuote", () => {
    for (const { lower, upper, liquidity } of cases) {
      for (const r of [m.Rounding.Up, m.Rounding.Down]) {
        const theirs = sdk.getDeltaAmountQuoteUnsigned(bn(lower), bn(upper), bn(liquidity), r === m.Rounding.Up ? sdk.Rounding.Up : sdk.Rounding.Down);
        expect(m.getDeltaAmountQuote(lower, upper, liquidity, r)).toBe(big(theirs));
      }
    }
  });
  it("getDeltaAmountBase", () => {
    for (const { lower, upper, liquidity } of cases) {
      for (const r of [m.Rounding.Up, m.Rounding.Down]) {
        const theirs = sdk.getDeltaAmountBaseUnsigned(bn(lower), bn(upper), bn(liquidity), r === m.Rounding.Up ? sdk.Rounding.Up : sdk.Rounding.Down);
        expect(m.getDeltaAmountBase(lower, upper, liquidity, r)).toBe(big(theirs));
      }
    }
  });
  it("getNextSqrtPriceFromQuoteIn / BaseIn", () => {
    for (const { lower, liquidity } of cases.slice(0, 50)) {
      const amount = 1n + (rnd() % (1n << 40n));
      expect(m.getNextSqrtPriceFromQuoteIn(lower, liquidity, amount)).toBe(big(sdk.getNextSqrtPriceFromInput(bn(lower), bn(liquidity), bn(amount), false)));
      // base-in needs L > amount·√P to stay in range; use a large liquidity
      const L = liquidity + amount * lower * 2n;
      expect(m.getNextSqrtPriceFromBaseIn(lower, L, amount)).toBe(big(sdk.getNextSqrtPriceFromInput(bn(lower), bn(L), bn(amount), true)));
    }
  });
  it("liquidity from quote / base", () => {
    for (const { upper, liquidity } of cases.slice(0, 50)) {
      const quote = liquidity % (1n << 50n);
      expect(m.getInitialLiquidityFromDeltaQuote(quote, MIN_SQRT_PRICE, upper)).toBe(big(sdk.getInitialLiquidityFromDeltaQuote(bn(quote), sdk.MIN_SQRT_PRICE, bn(upper))));
      expect(m.getInitialLiquidityFromDeltaBase(quote, MAX_SQRT_PRICE, upper)).toBe(big(sdk.getInitialLiquidityFromDeltaBase(bn(quote), sdk.MAX_SQRT_PRICE, bn(upper))));
    }
  });
});

describe("curve walking agrees with the SDK", () => {
  const sqrtStart = 2n * ONE_Q64; // price 4
  const curve: m.CurvePoint[] = [
    { sqrtPrice: 5n * ONE_Q64, liquidity: 614891469123651720533333333334n },
    { sqrtPrice: MAX_SQRT_PRICE, liquidity: 10n ** 27n },
  ];
  const sdkCurve = curve.map((c) => ({ sqrtPrice: bn(c.sqrtPrice), liquidity: bn(c.liquidity) }));
  it("getMigrationThresholdPrice", () => {
    for (const X of [1n, 1_000n, 10n ** 9n, 10n ** 11n, 10n ** 11n + 1n, 3n * 10n ** 11n]) {
      expect(m.getMigrationThresholdPrice(X, sqrtStart, curve)).toBe(big(sdk.getMigrationThresholdPrice(bn(X), bn(sqrtStart), sdkCurve)));
    }
  });
  it("getBaseTokenForSwap and getSwapAmountWithBuffer", () => {
    for (const target of [sqrtStart + 1n, 3n * ONE_Q64, 5n * ONE_Q64, 7n * ONE_Q64, MAX_SQRT_PRICE]) {
      const swapBase = m.getBaseTokenForSwap(sqrtStart, target, curve);
      expect(swapBase).toBe(big(sdk.getBaseTokenForSwap(bn(sqrtStart), bn(target), sdkCurve)));
      expect(m.getSwapAmountWithBuffer(swapBase, sqrtStart, curve)).toBe(big(sdk.getSwapAmountWithBuffer(bn(swapBase), bn(sqrtStart), sdkCurve)));
    }
  });
  it("reports NotEnoughLiquidity exactly where the SDK throws", () => {
    const short: m.CurvePoint[] = [curve[0]!];
    const capacity = m.getDeltaAmountQuote(sqrtStart, short[0]!.sqrtPrice, short[0]!.liquidity, m.Rounding.Up);
    expect(() => m.getMigrationThresholdPrice(capacity + 1n, sqrtStart, short)).toThrow(/NotEnoughLiquidity/);
    expect(() => sdk.getMigrationThresholdPrice(bn(capacity + 1n), bn(sqrtStart), [{ sqrtPrice: bn(short[0]!.sqrtPrice), liquidity: bn(short[0]!.liquidity) }])).toThrow(/Not enough liquidity/);
    expect(m.getMigrationThresholdPrice(capacity, sqrtStart, short)).toBe(short[0]!.sqrtPrice);
  });
});

describe("migration amounts agree with the SDK", () => {
  const sqrtMig = 5n * ONE_Q64;
  it("migration quote amount and base threshold", () => {
    for (const f of [0, 10, 20, 50, 99]) {
      const X = 100_000_000_000n;
      const { quoteAmount, fee } = m.getMigrationQuoteAmount(X, f);
      expect(quoteAmount + fee).toBe(X);
      expect(quoteAmount).toBe((X * BigInt(100 - f)) / 100n); // exact for these inputs (no rounding)
      const base = m.getMigrationBaseThreshold(quoteAmount, sqrtMig);
      expect(base).toBe(big(sdk.getMigrationBaseToken(bn(quoteAmount), bn(sqrtMig), sdk.MigrationOption.MET_DAMM_V2)));
    }
  });
  it("ceil rounding of the migration quote amount", () => {
    // X = 101, f = 50 → ceil(50.5) = 51, fee 50
    expect(m.getMigrationQuoteAmount(101n, 50)).toEqual({ quoteAmount: 51n, fee: 50n });
    expect(m.getMigrationFeeDistribution(50n, 33)).toEqual({ creatorMigrationFee: 16n, partnerMigrationFee: 34n });
  });
  it("protocol liquidity migration fee", () => {
    for (const q of [1_000_000n, 99_800_000_000n, 750_000_000n]) {
      const mine = m.getProtocolMigrationFees(q, sqrtMig);
      const [baseFee, quoteFee] = sdk.getProtocolMigrationFee(bn(0n), bn(q), bn(sqrtMig), 20, sdk.MigrationOption.MET_DAMM_V2);
      expect(mine.quoteFee).toBe(big(quoteFee));
      expect(mine.baseFee).toBe(big(baseFee));
    }
  });
});

describe("fees", () => {
  it("fee on amount rounds the fee up and splits 20% to the protocol", () => {
    const num = m.bpsToFeeNumerator(100); // 1%
    expect(num).toBe(10_000_000n);
    const r = m.getFeeOnAmount(num, 1_000_001n, false);
    expect(r.tradingFee + r.protocolFee + r.referralFee + r.amount).toBe(1_000_001n);
    expect(r.protocolFee).toBe(2_000n); // floor(10001 · 20%)
    expect(r.tradingFee).toBe(8_001n);
    const theirs = sdk.getFeeOnAmount(bn(num), bn(1_000_001n), { baseFee: {} } as any, false);
    expect(big(theirs.tradingFee)).toBe(r.tradingFee);
    expect(big(theirs.protocolFee)).toBe(r.protocolFee);
  });
  it("included fee amount inverts the fee", () => {
    const num = m.bpsToFeeNumerator(100);
    const { included, fee } = m.getIncludedFeeAmount(num, 100_000_000_000n);
    expect(included - fee).toBe(100_000_000_000n);
    expect(m.getFeeOnAmount(num, included, false).amount >= 100_000_000_000n).toBe(true);
    const [inc, f] = sdk.getIncludedFeeAmount(bn(num), bn(100_000_000_000n));
    expect(big(inc)).toBe(included);
    expect(big(f)).toBe(fee);
  });
  it("fee scheduler numerator by period matches the SDK (linear and exponential)", () => {
    const lin = sdk.getFeeSchedulerParams(500, 100, sdk.BaseFeeMode.FeeSchedulerLinear, 10, 600);
    const exp = sdk.getFeeSchedulerParams(500, 100, sdk.BaseFeeMode.FeeSchedulerExponential, 10, 600);
    for (const [s, linear] of [
      [lin, true],
      [exp, false],
    ] as const) {
      const scheduler: m.FeeScheduler = {
        cliffFeeNumerator: big(s.cliffFeeNumerator),
        numberOfPeriod: s.firstFactor,
        periodFrequency: big(s.secondFactor),
        reductionFactor: big(s.thirdFactor),
        linear,
      };
      for (let p = 0; p <= 12; p++) {
        const theirs = sdk.getBaseFeeNumeratorByPeriod(
          s.cliffFeeNumerator,
          s.firstFactor,
          new BN(p),
          s.thirdFactor,
          linear ? sdk.BaseFeeMode.FeeSchedulerLinear : sdk.BaseFeeMode.FeeSchedulerExponential,
        );
        expect(m.getFeeSchedulerNumeratorByPeriod(scheduler, p)).toBe(big(theirs));
      }
    }
  });
  it("powQ64 reproduces (1 − r/10000)^n in Q64.64", () => {
    // reduction 50%: bps = 2^63 exactly, base = 0.5 in Q64, so 1e9 · 0.5 = 5e8 with no truncation
    expect(m.getFeeInPeriod(1_000_000_000n, 5000n, 1)).toBe(500_000_000n);
    expect(m.getFeeInPeriod(1_000_000_000n, 5000n, 3)).toBe(125_000_000n);
    expect(m.getFeeInPeriod(1_000_000_000n, 0n, 7)).toBe(1_000_000_000n);
    // cross-check against the SDK's exponential scheduler for a non-trivial reduction factor
    for (let p = 0; p <= 20; p++) {
      expect(m.getFeeInPeriod(100_000_000n, 1234n, p)).toBe(big(sdk.getFeeNumeratorOnExponentialFeeScheduler(new BN(100_000_000), new BN(1234), p)));
    }
  });
});

describe("Q128 sanity", () => {
  it("constants", () => {
    expect(Q128).toBe(1n << 128n);
    expect(ONE_Q64 * ONE_Q64).toBe(Q128);
  });
});
