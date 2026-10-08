/**
 * Hardship-pause arithmetic (SPEC §6.4): countdowns run in unpaused time from their own start.
 * A pause record holds `{ start, end }` where `end` is the approved end or the early end; the
 * open pause (start ≤ now < end) is clipped at `now`.
 */

export interface Pause {
  start: bigint;
  end: bigint;
}

function clip(p: Pause, now: bigint): [bigint, bigint] {
  return [p.start, p.end < now ? p.end : now];
}

/** Σ over pauses of `|[start, min(end, now)] ∩ [a, b]|`. */
export function pausedWithin(pauses: readonly Pause[], a: bigint, b: bigint, now: bigint): bigint {
  if (b < a) throw new RangeError("interval end before start");
  let total = 0n;
  for (const p of pauses) {
    const [s, e] = clip(p, now);
    const lo = s > a ? s : a;
    const hi = e < b ? e : b;
    if (hi > lo) total += hi - lo;
  }
  return total;
}

/** `unpaused(a, b) = (b − a) − paused_within(a, b)` for `b ≥ a`. */
export function unpaused(pauses: readonly Pause[], a: bigint, b: bigint, now: bigint): bigint {
  if (b < a) throw new RangeError("interval end before start");
  return b - a - pausedWithin(pauses, a, b, now);
}

/** An open pause exists with `start ≤ now < end`. */
export function isPausedAt(pauses: readonly Pause[], now: bigint): boolean {
  return pauses.some((p) => p.start <= now && now < p.end);
}

/** Σ (end − start) over all recorded pauses (approved or early-ended lengths). */
export function pausedTotal(pauses: readonly Pause[]): bigint {
  return pauses.reduce((acc, p) => acc + (p.end - p.start), 0n);
}

/** Paused time elapsed so far (open pause clipped at `now`). */
export function pausedElapsed(pauses: readonly Pause[], now: bigint): bigint {
  let total = 0n;
  for (const p of pauses) {
    const [s, e] = clip(p, now);
    if (e > s) total += e - s;
  }
  return total;
}
