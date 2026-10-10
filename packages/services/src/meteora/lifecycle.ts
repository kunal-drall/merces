import { ChainError, type ChainPort, type CurveState, type SeriesState } from '@merces/domain';
import { errorCode } from '../auction/service.ts';
import type { ServiceContext } from '../context.ts';

/**
 * The curve's lifecycle crank (S3 WP11), what the keepers' `curve.lifecycle` job runs every minute and the admin monitor
 * (`POST /admin/curves/monitor`) runs on demand. Stage 1's lifecycle steps are permissionless (curve.rs:861-906,
 * :1112-1214), so the keeper sends them with its own fee payer:
 *  - `completeCurve` once the pool filled while the raise is Open (the raise settles at the pool's finish time);
 *  - `collectCurveProceeds` right after, once: the partner's migration fee and surplus into the treasury (the release
 *    tranches start from them) and the partner's trading fee to the fee collector;
 *  - `collectCurveProceeds` at most once a week (chain time) while the partner's trading fees wait in the pool: every
 *    trade on the curve pays the fee, so they accrue while the curve sells, and a curve that never fills has its fees
 *    collected too. A pass that finds nothing waiting sends nothing.
 * A step the chain refuses as done or not ready (another sender completed first: RaiseNotOpen; the pool has not filled:
 * CurveNotComplete) is skipped; any other failure is reported per series, as a code (a Stage 1 error name or a
 * ChainError code), never a message (adapter messages can embed values).
 *
 * Each check that sent a step, or whose read changed since the last recorded one, is recorded in `curve_monitor` with
 * the chain's time (`chain_time`), which also times the weekly collection.
 */

/** How often the keepers collect a curve's accrued trading fees: weekly, on the chain's clock. */
export const CURVE_FEE_COLLECT_SECONDS = 7 * 86_400;

/** What one lifecycle pass did: the curve series checked, those completed and collected, and the failures (codes only). */
export interface CurveLifecyclePass {
  checked: number;
  completed: string[];
  collected: string[];
  errors: { target: string; error: string }[];
}

type LifecycleStep = 'completeCurve' | 'collectCurveProceeds';

/** Refusals that mean "already done" or "not ready", by Stage 1 name: never a failure of the pass. */
const ROUTINE: Record<LifecycleStep, string[]> = {
  completeCurve: ['RaiseNotOpen', 'CurveNotComplete'],
  collectCurveProceeds: ['RaiseNotOpen'],
};

interface MonitorRow {
  quote_reserve: string | null;
  pool_complete: boolean;
  settled: boolean;
  pool_progress_bps: number | null;
}

/** The keepers' collections on `seriesId` so far: the chain time of the last one, and whether one ran after the pool filled. */
export interface CurveCollections {
  last: number | null;
  afterFill: boolean;
}

async function collections(ctx: ServiceContext, seriesId: string): Promise<CurveCollections> {
  const r = await ctx.pool.query<{ t: string | null; after_fill: boolean }>(
    "select max(chain_time)::text as t, coalesce(bool_or(pool_complete), false) as after_fill from curve_monitor where series_id = $1 and 'collectCurveProceeds' = any(actions)",
    [seriesId],
  );
  const t = r.rows[0]?.t ?? null;
  return { last: t === null ? null : Number(t), afterFill: r.rows[0]?.after_fill ?? false };
}

/**
 * Whether the pass collects now: once after the pool filled (its proceeds: unless they were collected already, by the
 * keepers or anyone else), and weekly (chain time) while the partner's trading fees accrue.
 */
export function collectionDue(c: CurveState, now: number, done: CurveCollections): boolean {
  const proceedsWaiting = c.poolComplete && !done.afterFill && c.collected.migrationFee === '0' && c.collected.surplus === '0';
  const feesDue = BigInt(c.tradingFeeUncollected) > 0n && (done.last === null || now - done.last >= CURVE_FEE_COLLECT_SECONDS);
  return proceedsWaiting || feesDue;
}

async function checkCurve(ctx: ServiceContext, chain: ChainPort, s: SeriesState, now: number, out: CurveLifecyclePass): Promise<void> {
  const c = await chain.getCurve(s.seriesId);
  if (!c) return;
  const actions: LifecycleStep[] = [];
  const step = async (kind: LifecycleStep): Promise<boolean> => {
    try {
      await chain.submit({ kind, seriesId: s.seriesId }, 'keeper');
      actions.push(kind);
      return true;
    } catch (e) {
      if (e instanceof ChainError && ROUTINE[kind].includes(String(e.detail?.stage1 ?? ''))) return false;
      throw e;
    }
  };
  try {
    if (c.poolComplete && s.phase === 'Open' && (await step('completeCurve'))) out.completed.push(s.seriesId);
    if (collectionDue(c, now, await collections(ctx, s.seriesId)) && (await step('collectCurveProceeds'))) out.collected.push(s.seriesId);
  } finally {
    // the steps that landed are recorded even when a later one failed
    const settled = c.settled || actions.includes('completeCurve');
    const last = (await ctx.pool.query<MonitorRow>('select quote_reserve::text, pool_complete, settled, pool_progress_bps from curve_monitor where series_id = $1 order by id desc limit 1', [s.seriesId])).rows[0];
    const changed = !last || last.quote_reserve !== c.quoteReserve || last.pool_complete !== c.poolComplete || last.settled !== settled || last.pool_progress_bps !== c.progressBps;
    if (actions.length > 0 || changed) {
      await ctx.pool.query(
        'insert into curve_monitor (series_id, checked_at, chain_time, quote_reserve, pool_complete, settled, pool_progress_bps, actions) values ($1, now(), $2, $3, $4, $5, $6, $7)',
        [s.seriesId, now, c.quoteReserve, c.poolComplete, settled, c.progressBps, actions],
      );
    }
  }
}

/**
 * One lifecycle pass over every curve series on every Solana-family chain (curve mode is Solana only). Chains and series
 * are independent: one's failure is reported and the others still run.
 */
export async function advanceCurves(ctx: ServiceContext): Promise<CurveLifecyclePass> {
  const out: CurveLifecyclePass = { checked: 0, completed: [], collected: [], errors: [] };
  for (const chain of ctx.chains.chains.values()) {
    if (chain.family !== 'solana') continue;
    let now: number;
    let series: SeriesState[];
    try {
      now = await chain.now();
      series = (await chain.listSeries()).filter((s) => s.terms.raiseStyle === 'curve');
    } catch (e) {
      out.errors.push({ target: chain.chain, error: errorCode(e) });
      continue;
    }
    for (const s of series) {
      out.checked++;
      try {
        await checkCurve(ctx, chain, s, now, out);
      } catch (e) {
        out.errors.push({ target: s.seriesId, error: errorCode(e) });
      }
    }
  }
  return out;
}
