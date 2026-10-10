import { AppError } from '@merces/core';
import type { SeriesState } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import type { ServiceContext } from './context.ts';

/**
 * The curve census around reports (S3 WP9, amendment H1). On a curve series the report proof's units are the curve's
 * census (`SeriesState.unitsOutstanding`, Stage 1 `units_outstanding`), and Stage 1 binds it when the report is
 * submitted (income.rs:376-381): a regular report needs a census taken at or after its period's end
 * (CurveUnitsNotSynced, curve.rs:1532-1541), and anyone may take a census at any time (`sync_curve_units`), which can
 * change the count and so invalidate a proof already made over the old one. So:
 *  - assembling a curve report (and the tier-3 path) is refused while the census predates the period's end, with the
 *    "sync first" step (`requireCensusFor`);
 *  - building the submission of an assembled report is refused when the census changed since its proof
 *    (`requireCensusUnchanged`: re-assemble);
 *  - Merces' own builders never take a census while the series has an assembled report waiting to be submitted for its
 *    next expected period (`censusLockedBy`): the issuer's proof stays valid until it is sent.
 * A tail report (the series redeemed) proves over the units at redemption, which no census changes.
 */

/** The step a refused curve report names: take a census (permissionless), then assemble again. */
export function syncStep(seriesId: string): Record<string, unknown> {
  return { step: 'sync-curve-units', command: { kind: 'syncCurveUnits', seriesId }, build: `POST /series/${seriesId}/curve/build-sync`, then: 'assemble the report again over the new census (GET /series/{seriesId}/curve: census.synced)' };
}

/** A curve series' regular (not tail) report: its proof's units are the curve's census. */
export function curveRegularReport(series: SeriesState): boolean {
  return series.terms.raiseStyle === 'curve' && series.redemption === null;
}

/** The units a report on `series` proves over now: the units at redemption for a tail report, else the units outstanding. */
export function reportUnits(series: SeriesState): string {
  return series.redemption ? series.redemption.unitsAtRedemption : series.unitsOutstanding;
}

/** Stage 1's gate holds for a report on `periodId` now (always on a sealed-bid series and for a tail report). */
export function censusFreshFor(series: SeriesState, periodId: string): boolean {
  if (!curveRegularReport(series)) return true;
  return series.unitsSyncedAt !== null && series.unitsSyncedAt >= parsePeriod(periodId).end && BigInt(series.unitsOutstanding) > 0n;
}

/**
 * Stage 1's gate (`require_units_synced_for`): on a curve series' regular report the census was taken at or after the
 * period's end and counts more than 0 units. Otherwise 409 CurveUnitsNotSynced with the sync step. Public facts only.
 */
export function requireCensusFor(series: SeriesState, periodId: string): void {
  if (censusFreshFor(series, periodId)) return;
  const end = parsePeriod(periodId).end;
  throw new AppError(409, 'Conflict', `the curve's units must be counted after ${periodId} ended before its report: take a census (syncCurveUnits), then assemble the report over it`, {
    stage1: 'CurveUnitsNotSynced', periodId, periodEnd: end, unitsSyncedAt: series.unitsSyncedAt, next: syncStep(series.seriesId),
  });
}

/**
 * The census a proof was made over (its public input 1) is still the chain's: otherwise 409 `census-changed` naming
 * the current count and what to do (`re-assemble` a stored report, `re-prove` a proof not stored yet). Stage 1 would
 * refuse the submission as InvalidProof.
 */
export function requireCensusUnchanged(series: SeriesState, provedUnits: string | undefined, next: 're-assemble' | 're-prove'): void {
  const live = reportUnits(series);
  if (provedUnits !== undefined && /^\d+$/.test(provedUnits) && BigInt(provedUnits) === BigInt(live)) return;
  throw new AppError(409, 'Conflict', next === 're-assemble'
    ? 'the curve census changed since this report was assembled: its proof is over the old count; prove again over the current census and assemble the report again'
    : 'the curve census changed since this proof was made: prove again over the current census', { stage1: 'InvalidProof', reason: 'census-changed', unitsOutstanding: live, next });
}

/**
 * The report a census would invalidate now: the issuer's assembled, not yet submitted report for the series' next
 * expected period (the one Stage 1 accepts next, the latest ended period when the issuer is up to date), whose proof
 * binds the census. Null when there is none, on a sealed-bid series and once the series redeemed (a tail report binds
 * the units at redemption). Merces' builders (`build-sync`; the stake builder from WP12) and keepers send no census
 * while one exists.
 */
export async function censusLockedBy(ctx: Pick<ServiceContext, 'pool'>, series: SeriesState): Promise<{ reportId: string; periodId: string } | null> {
  if (!curveRegularReport(series) || series.reporting.nextExpectedPeriod === null) return null;
  const r = await ctx.pool.query<{ report_id: string; period_id: string }>("select report_id, period_id from reports where series_id = $1 and period_id = $2 and state = 'assembled' order by created_at desc limit 1", [series.seriesId, series.reporting.nextExpectedPeriod]);
  const x = r.rows[0];
  return x ? { reportId: x.report_id, periodId: x.period_id } : null;
}
