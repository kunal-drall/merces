import type { CurveState, CurveSwapQuote } from '@merces/domain';
import type { SimSeries } from '../state.ts';
import { str as s } from '../engine/core.ts';
import { curveSwapOutcome, poolComplete } from '../engine/curve.ts';

/** A curve series' curve as the chain reads it (`CurveState`): the stand-in pool and what was collected from it. */
export function toCurveState(seriesId: string, x: SimSeries): CurveState {
  const c = x.curve!;
  const X = c.migrationQuoteThreshold;
  const progress = X === 0n ? 0 : Number((c.quoteReserve >= X ? 10_000n : (c.quoteReserve * 10_000n) / X));
  const proceeds = c.collected.migrationFee + c.collected.surplus;
  return {
    seriesId, venue: c.venue, dbcConfig: c.dbcConfig, dbcPool: c.dbcPool, baseMint: c.baseMint, quoteStablecoin: c.quoteStablecoin,
    migrationQuoteThreshold: s(X), quoteReserve: s(c.quoteReserve), progressBps: progress, finishCurveTimestamp: c.finishTs, poolComplete: poolComplete(c),
    settled: x.phase === 'Settled', issuePrice: s(c.p0), unitsSold: s(c.swapBaseAmount), baseSold: s(c.baseSold), baseSupply: s(c.supply),
    // the stand-in sells at the constant price P0 throughout (S3); Meteora's curve price arrives with its venue (S5)
    spotPrice: s(c.p0), tradingFeeBps: Number(c.tradingFeeBps), migrationFeePercentage: c.migrationFeePercentage, tradingFeeUncollected: s(c.partnerQuoteFee),
    collected: { migrationFee: s(c.collected.migrationFee), surplus: s(c.collected.surplus), tradingFee: s(c.collected.tradingFee), proceeds: s(proceeds) },
  };
}

/** A stand-in trade's quote at the current state (`curveSwapOutcome`; moves nothing). */
export function toCurveSwapQuote(seriesId: string, x: SimSeries, side: 'buy' | 'sell', amountIn: string): CurveSwapQuote {
  const o = curveSwapOutcome(x.curve!, side, amountIn);
  return { seriesId, side, amountIn, amountUsed: s(o.used), amountOut: s(o.out), fee: s(o.fee), fillsCurve: o.fillsCurve };
}
