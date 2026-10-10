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

/**
 * Accounting units the terms' `r` is per (Stage 1 registry `create_series`, lib.rs:594-600; B-C2): the units offered for a
 * sealed-bid series, the units offered × 10^6 base lamports for a curve series, so `r = ratePerUnit(share, rateUnits)`
 * and `r × rateUnits ≤ WAD`. `unitsOffered` itself stays in whole units on every series.
 */
export function rateUnits(terms: Pick<SeriesTerms, 'unitsOffered' | 'raiseStyle'>): bigint {
  return BigInt(terms.unitsOffered) * unitScaleOf(terms.raiseStyle);
}

/**
 * The terms a curve series records as 0 (Stage 1 registry `create_series`, lib.rs:465-480, CurveTermsNotZero; SPEC §9):
 * a curve raise has no auction (no commit or reveal phase), no lockup and no wallet cap. Stage 1 also zeroes the window
 * durations, which are not canonical terms yet (S5). Stage 1 checks its parameter bounds on the protocol defaults for
 * these fields instead (lib.rs:517-540), so a curve series' zeros are never bounded.
 */
export const CURVE_ZERO_TERMS = ['lockupSeconds', 'walletCapBps', 'commitDurationSeconds', 'revealDurationSeconds'] as const satisfies readonly (keyof SeriesTerms)[];

/** The curve series' values for `CURVE_ZERO_TERMS`, to spread into curve terms. */
export const CURVE_TERMS_ZEROS: { readonly [K in (typeof CURVE_ZERO_TERMS)[number]]: 0 } = { lockupSeconds: 0, walletCapBps: 0, commitDurationSeconds: 0, revealDurationSeconds: 0 };

/**
 * The one "no cap" statement (owner direction, S1 review; applied in S3): every API read, notice and document that
 * speaks of a curve raise's cap says this, and nothing else. Stage 1 stores a curve series' wallet cap as 0 and enforces
 * none, in either phase (registry CurveTermsNotZero; the DBC base mint has no transfer hook, freeze authority or
 * permanent delegate). Reads that carry it set `noCap: true` and `noCapStatement` to this text.
 */
export const CURVE_NO_CAP =
  'No cap: a curve raise has no wallet cap at any stage. Any wallet can hold any number of units, before and after the curve fills, and there is no limit on how many units a wallet buys or sells.';
