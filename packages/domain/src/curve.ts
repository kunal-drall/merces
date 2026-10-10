import { CURVE_UNIT_SCALE } from '@merces/math';
import type { SeriesTerms } from './events.ts';

/**
 * Curve mode in the chain-neutral model (Stage 1 SPEC §9, CURVE_MODE.md).
 *
 * A curve series' unit mint has 6 decimals: one whole unit is 10^6 base lamports, the series' accounting unit (Stage 1
 * `Ledger.unit_scale`, merces-common `curve.rs:15-16` `CURVE_UNIT_SCALE`). Units outstanding, weights, stakes, tenders
 * and the vault's per-unit WAD figures are per accounting unit; prices (the issue price, the cap, `P_redeem`) stay per
 * whole unit. A sealed-bid series has scale 1.
 */

/** Accounting units per whole unit, as the reads carry it: "1" (sealed bid) or "1000000" (curve, base lamports). */
export type UnitScale = '1' | '1000000';

/** The unit scale a raise style implies (Stage 1 sets `unit_scale` when the series is created and never changes it). */
export function unitScaleOf(raiseStyle: SeriesTerms['raiseStyle']): bigint {
  return raiseStyle === 'curve' ? CURVE_UNIT_SCALE : 1n;
}
