import type { CurveCensus, CurveState, CurveSwapQuote, TradingFeeSplitBps } from '@merces/domain';
import type { SimCurve, SimSeries } from '../state.ts';
import { str as s, type EngineCore } from '../engine/core.ts';
import { STAND_IN_POOL, censusPreview, curveSwapOutcome, poolComplete } from '../engine/curve.ts';

/**
 * The curve's census (`CurveCensus`): what a census now would count (`syncCurveUnits`'s, and `redeem`'s without the DAMM
 * pool) beside the one the chain stored last. Holdings past the supply never happen in the stand-in (the census would
 * refuse them, CurveUnitsInconsistent); the read then shows the stored count.
 */
function toCensus(e: EngineCore, x: SimSeries): CurveCensus {
  const p = censusPreview(e, x);
  const full = p.full ?? { supply: x.curve!.supply, protocolHeld: x.curve!.supply - x.unitsOutstanding, outstanding: x.unitsOutstanding };
  const synced = x.unitsSyncedAt === null ? null : { unitsOutstanding: s(x.unitsOutstanding), at: x.unitsSyncedAt };
  return {
    supply: s(full.supply), protocolHeld: s(full.protocolHeld), unitsOutstanding: s(full.outstanding), redemptionUnits: s(p.redemption ?? full.outstanding),
    stakedTotal: s(x.stakedTotal), synced, changedSinceSync: synced === null || full.outstanding !== x.unitsOutstanding,
  };
}

/**
 * The pool config's split of the trading fee, in bps of the fee (DBC: Meteora's protocol percent first, then the
 * creator's percent of what is left, the partner the rest): the stand-in's Meteora share is the series' pool setting
 * (`SimCurve.protocolFeePercent`) and it has no creator share (Stage 1's generator: 0).
 */
function tradingFeeSplit(c: SimCurve): TradingFeeSplitBps {
  const protocol = Number(c.protocolFeePercent) * 100;
  const creator = Math.floor(((10_000 - protocol) * Number(STAND_IN_POOL.creatorTradingFeePercent)) / 100);
  return { protocol, partner: 10_000 - protocol - creator, creator };
}

/** A curve series' curve as the chain reads it (`CurveState`): the stand-in pool, what was collected from it and the census. */
export function toCurveState(e: EngineCore, seriesId: string, x: SimSeries): CurveState {
  const c = x.curve!;
  const X = c.migrationQuoteThreshold;
  const progress = X === 0n ? 0 : Number((c.quoteReserve >= X ? 10_000n : (c.quoteReserve * 10_000n) / X));
  const proceeds = c.collected.migrationFee + c.collected.surplus;
  return {
    seriesId, venue: c.venue, dbcConfig: c.dbcConfig, dbcPool: c.dbcPool, baseMint: c.baseMint, quoteStablecoin: c.quoteStablecoin,
    migrationQuoteThreshold: s(X), quoteReserve: s(c.quoteReserve), progressBps: progress, finishCurveTimestamp: c.finishTs, poolComplete: poolComplete(c),
    settled: x.phase === 'Settled', issuePrice: s(c.p0), unitsSold: s(c.swapBaseAmount), baseSold: s(c.baseSold), baseSupply: s(c.supply),
    // the stand-in sells at the constant price P0 throughout (S3); Meteora's curve price arrives with its venue (S5)
    spotPrice: s(c.p0), tradingFeeBps: Number(c.tradingFeeBps), tradingFeeSplitBps: tradingFeeSplit(c), migrationFeePercentage: c.migrationFeePercentage, tradingFeeUncollected: s(c.partnerQuoteFee),
    collected: { migrationFee: s(c.collected.migrationFee), surplus: s(c.collected.surplus), tradingFee: s(c.collected.tradingFee), proceeds: s(proceeds) },
    census: toCensus(e, x),
  };
}

/** A stand-in trade's quote at the current state (`curveSwapOutcome`; moves nothing). */
export function toCurveSwapQuote(seriesId: string, x: SimSeries, side: 'buy' | 'sell', amountIn: string): CurveSwapQuote {
  const o = curveSwapOutcome(x.curve!, side, amountIn);
  return { seriesId, side, amountIn, amountUsed: s(o.used), amountOut: s(o.out), fee: s(o.fee), fillsCurve: o.fillsCurve };
}
