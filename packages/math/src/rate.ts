/**
 * The per-unit rate `r = s / N` (WAD), derived by the Stage 2 term builder from the series' share rate.
 *
 * Stage 1 takes `r_wad` from the terms and never derives it. SPEC.md §1.5 makes `r_wad < 2^64` a field bound and
 * `r_wad × units_offered ≤ WAD` "a documented obligation of the Stage 2 term builder" for tiers 2 and 3 (Stage 1
 * enforces it on-chain for tier 1 only). Both are checked here. Errors carry no values: a share rate is part of the
 * private terms.
 */
import { U64_MAX, WAD } from '@merces/sdk';

export function ratePerUnit(shareRateWad: bigint, unitsOffered: bigint): bigint {
  if (unitsOffered <= 0n) throw new RangeError('units offered must be positive');
  if (shareRateWad < 0n) throw new RangeError('rate out of range');
  const r = shareRateWad / unitsOffered;
  if (r > U64_MAX || r * unitsOffered > WAD) throw new RangeError('rate out of range');
  return r;
}
