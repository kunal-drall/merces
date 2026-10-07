import { describe, expect, it } from "vitest";
import { ONE_Q64, USDC_MINT_MAINNET } from "../src/constants.js";
import { buildMercesCurveConfig, formatUnits } from "../src/config.js";
import { computeProceeds, estimateTradingFees, type ProceedsBreakdown } from "../src/proceeds.js";
import { bpsToFeeNumerator } from "../src/math.js";

const USDC = 1_000_000n;
const X = 100_000n * USDC;
/** Migration sqrt price of the canonical example (25 USDC per unit, program-derived). */
const SQRT_MIG = 5n * ONE_Q64 - 1n;

function scenario(f: number, cm: number, ct = 0): ProceedsBreakdown {
  return computeProceeds({
    migrationQuoteThreshold: X,
    migrationFeePercentage: f,
    creatorMigrationFeePercentage: cm,
    creatorTradingFeePercentage: ct,
    tradingFeeNumerator: bpsToFeeNumerator(100),
    sqrtMigrationPrice: SQRT_MIG,
  });
}

const usd = (x: bigint): string => formatUnits(x, 6);

describe("proceeds routing for X = 100,000 USDC (the memo table)", () => {
  it("conservation: X = pool net + protocol liquidity fee + migration fee; migration fee = creator + partner", () => {
    for (const [f, cm] of [
      [0, 0],
      [20, 100],
      [50, 100],
      [99, 100],
      [99, 0],
      [99, 50],
    ]) {
      const p = scenario(f!, cm!);
      expect(p.quoteForPoolNet + p.protocolLiquidityMigrationFeeQuote + p.migrationFeeTotal).toBe(X);
      expect(p.creatorMigrationFee + p.partnerMigrationFee).toBe(p.migrationFeeTotal);
      expect(p.tradingFees.grossPaidByBuyers - p.tradingFees.totalFee).toBe(X);
      expect(p.tradingFees.protocol + p.tradingFees.partner + p.tradingFees.creator).toBe(p.tradingFees.totalFee);
    }
  });

  it("fee_percentage 0 (everything to the pool)", () => {
    const p = scenario(0, 0);
    expect(usd(p.quoteForPoolGross)).toBe("100000.000000");
    expect(usd(p.migrationFeeTotal)).toBe("0.000000");
    expect(usd(p.protocolLiquidityMigrationFeeQuote)).toBe("200.000000");
    expect(usd(p.quoteForPoolNet)).toBe("99800.000000");
    expect(usd(p.pool.quoteInPool)).toBe("99799.999999");
    expect(usd(p.pool.baseInPool)).toBe("3991.999995");
    expect(usd(p.pool.quoteToMovePriceUp.bps1000)).toBe("4871.123048");
    expect(p.pool.priceImpactBps.quote1k).toBe(201n);
    expect(p.pool.priceImpactBps.quote10k).toBe(2104n);
  });

  it("fee_percentage 20, creator 100", () => {
    const p = scenario(20, 100);
    expect(usd(p.creatorMigrationFee)).toBe("20000.000000");
    expect(usd(p.partnerMigrationFee)).toBe("0.000000");
    expect(usd(p.protocolLiquidityMigrationFeeQuote)).toBe("160.000000");
    expect(usd(p.quoteForPoolNet)).toBe("79840.000000");
    expect(usd(p.pool.quoteInPool)).toBe("79839.999999");
    expect(usd(p.pool.baseInPool)).toBe("3193.599996");
    expect(usd(p.pool.quoteToMovePriceUp.bps1000)).toBe("3896.898439");
    expect(p.pool.priceImpactBps.quote1k).toBe(252n);
  });

  it("fee_percentage 50, creator 100", () => {
    const p = scenario(50, 100);
    expect(usd(p.creatorMigrationFee)).toBe("50000.000000");
    expect(usd(p.protocolLiquidityMigrationFeeQuote)).toBe("100.000000");
    expect(usd(p.quoteForPoolNet)).toBe("49900.000000");
    expect(usd(p.pool.quoteInPool)).toBe("49899.999999");
    expect(usd(p.pool.baseInPool)).toBe("1995.999997");
    expect(p.pool.priceImpactBps.quote1k).toBe(404n);
    expect(p.pool.priceImpactBps.quote10k).toBe(4409n);
  });

  it("fee_percentage 99, creator 100 (the recommended default)", () => {
    const p = scenario(99, 100);
    expect(usd(p.creatorMigrationFee)).toBe("99000.000000");
    expect(usd(p.partnerMigrationFee)).toBe("0.000000");
    expect(usd(p.quoteForPoolGross)).toBe("1000.000000");
    expect(usd(p.protocolLiquidityMigrationFeeQuote)).toBe("2.000000");
    expect(usd(p.quoteForPoolNet)).toBe("998.000000");
    expect(usd(p.pool.quoteInPool)).toBe("997.999999");
    expect(usd(p.pool.baseInPool)).toBe("39.919999");
    expect(usd(p.pool.quoteToMovePriceUp.bps1000)).toBe("48.711231");
    expect(usd(p.pool.quoteToMovePriceUp.bps10000)).toBe("413.385136");
    expect(p.pool.priceImpactBps.quote1k).toBe(30_080n);
    expect(p.pool.priceImpactBps.quote10k).toBe(1_204_412n);
  });

  it("partner-takes-fee variant: fee_percentage 99, creator 0, and a 50/50 split", () => {
    const partner = scenario(99, 0);
    expect(usd(partner.creatorMigrationFee)).toBe("0.000000");
    expect(usd(partner.partnerMigrationFee)).toBe("99000.000000");
    const split = scenario(99, 50);
    expect(usd(split.creatorMigrationFee)).toBe("49500.000000");
    expect(usd(split.partnerMigrationFee)).toBe("49500.000000");
    // odd amounts: creator rounds down, partner gets the remainder
    const odd = computeProceeds({ migrationQuoteThreshold: 101n, migrationFeePercentage: 99, creatorMigrationFeePercentage: 50, creatorTradingFeePercentage: 0, tradingFeeNumerator: bpsToFeeNumerator(100), sqrtMigrationPrice: SQRT_MIG });
    expect(odd.quoteForPoolGross).toBe(2n); // ceil(1.01)
    expect(odd.migrationFeeTotal).toBe(99n);
    expect(odd.creatorMigrationFee).toBe(49n);
    expect(odd.partnerMigrationFee).toBe(50n);
  });

  it("trading fees during the curve (1% QuoteToken fee, creator share 0)", () => {
    const t = estimateTradingFees(X, bpsToFeeNumerator(100), 0);
    expect(usd(t.grossPaidByBuyers)).toBe("101010.101011");
    expect(usd(t.totalFee)).toBe("1010.101011");
    expect(usd(t.protocol)).toBe("202.020202");
    expect(usd(t.partner)).toBe("808.080809");
    expect(t.creator).toBe(0n);
    const shared = estimateTradingFees(X, bpsToFeeNumerator(100), 25);
    expect(shared.creator).toBe((t.partner * 25n) / 100n);
    expect(shared.partner + shared.creator).toBe(t.partner);
  });

  it("surplus is split 80/20 and the 80% follows the creator trading fee percentage", () => {
    const p = computeProceeds({ migrationQuoteThreshold: X, migrationFeePercentage: 99, creatorMigrationFeePercentage: 100, creatorTradingFeePercentage: 25, tradingFeeNumerator: bpsToFeeNumerator(100), surplus: 5_000_000n, sqrtMigrationPrice: SQRT_MIG });
    expect(p.surplus).toEqual({ total: 5_000_000n, partnerAndCreator: 4_000_000n, creator: 1_000_000n, partner: 3_000_000n, protocol: 1_000_000n });
  });

  it("the generator reports the same breakdown for its own config", () => {
    const cfg = buildMercesCurveConfig({ trailingAnnualIncome: 40_000n * USDC, targetRaise: X, unitsOnCurve: 10_000n, quoteMint: USDC_MINT_MAINNET });
    expect(cfg.proceeds).toEqual(scenario(99, 100));
    expect(cfg.proceeds.totals.creator).toBe(99_000n * USDC);
    expect(cfg.proceeds.totals.partner).toBe(808_080_809n);
  });
});
