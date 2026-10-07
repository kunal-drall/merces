/**
 * Treasury tranches and vesting (SPEC §5.3).
 */
import { BPS_DENOMINATOR, mulDiv } from "@merces/sdk";

export interface ReleaseTranche {
  atOffsetSeconds: bigint;
  bps: number;
}

export const MAX_RELEASE_TRANCHES = 24;

/** Returns the names of violated rules (empty when valid). */
export function validateReleaseSchedule(schedule: ReleaseTranche[]): string[] {
  const errors: string[] = [];
  if (schedule.length < 1) errors.push("empty");
  if (schedule.length > MAX_RELEASE_TRANCHES) errors.push("too_many_tranches");
  let sum = 0n;
  let last = -1n;
  for (const t of schedule) {
    if (t.bps < 0 || t.bps > 10_000) errors.push("bps_out_of_range");
    if (t.atOffsetSeconds < 0n) errors.push("negative_offset");
    if (t.atOffsetSeconds < last) errors.push("offsets_decrease");
    last = t.atOffsetSeconds;
    sum += BigInt(t.bps);
  }
  if (sum !== BPS_DENOMINATOR) errors.push("bps_sum_not_10000");
  return errors;
}

/**
 * `tranche_amount(i) = floor(proceeds × bps_i / 10000)` for `i < last`; the last tranche takes the
 * remainder so the tranches sum exactly to `proceeds`.
 */
export function trancheAmounts(proceeds: bigint, schedule: ReleaseTranche[]): bigint[] {
  if (schedule.length === 0) return [];
  const out: bigint[] = [];
  let sum = 0n;
  for (let i = 0; i < schedule.length - 1; i++) {
    const a = mulDiv(proceeds, BigInt(schedule[i]!.bps), BPS_DENOMINATOR);
    out.push(a);
    sum += a;
  }
  out.push(proceeds - sum);
  return out;
}

/** `vested(now) = Σ_{i : settlement_ts + at_offset_i ≤ now} tranche_amount(i)` */
export function vested(now: bigint, settlementTs: bigint, schedule: ReleaseTranche[], proceeds: bigint): bigint {
  const amounts = trancheAmounts(proceeds, schedule);
  let v = 0n;
  for (let i = 0; i < schedule.length; i++) {
    if (settlementTs + schedule[i]!.atOffsetSeconds <= now) v += amounts[i]!;
  }
  return v;
}

/** `amount = min(vested(now), proceeds) − released_total` (early draws count against vesting). */
export function releasable(now: bigint, settlementTs: bigint, schedule: ReleaseTranche[], proceeds: bigint, releasedTotal: bigint): bigint {
  const v = vested(now, settlementTs, schedule, proceeds);
  const cap = v < proceeds ? v : proceeds;
  return cap > releasedTotal ? cap - releasedTotal : 0n;
}
