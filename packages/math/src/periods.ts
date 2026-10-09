/**
 * Calendar quarters as `"YYYYQn"` strings, rebuilt on Stage 1's period math (`@merces/sdk` periods.ts, SPEC §1.2).
 *
 * Stage 1 names a quarter by its integer id `pid = year × 4 + (quarter − 1)` and keeps timestamps as bigint; the
 * canonical model and the API name it `"2026Q1"` and keep unix seconds as numbers. This module is the codec between
 * the two: every boundary comes from Stage 1's `periodStart`/`periodEnd`, so the two can never disagree.
 */
import { periodEnd, periodId, periodLabel, periodOf as pidOfTs, periodStart, quarterOf, yearOf } from '@merces/sdk';

const DAY_SECONDS = 86_400;

export interface Period {
  /** e.g. "2026Q3" */
  id: string;
  /** Stage 1's period id: year × 4 + (quarter − 1); 2026Q1 = 8104 */
  pid: number;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  /** inclusive start, unix seconds */
  start: number;
  /** exclusive end, unix seconds */
  end: number;
  /** number of UTC days in the quarter */
  days: number;
}

/** The quarter with Stage 1 id `pid`. */
export function periodOfPid(pid: number): Period {
  const start = Number(periodStart(pid));
  const end = Number(periodEnd(pid));
  return { id: periodLabel(pid), pid, year: yearOf(pid), quarter: quarterOf(pid) as 1 | 2 | 3 | 4, start, end, days: Math.round((end - start) / DAY_SECONDS) };
}

/** The UTC calendar quarter containing `ts` (unix seconds, ≥ 0). */
export function periodOf(ts: number): Period {
  return periodOfPid(pidOfTs(BigInt(Math.floor(ts))));
}

export function periodFrom(year: number, quarter: 1 | 2 | 3 | 4): Period {
  return periodOfPid(periodId(year, quarter));
}

export function parsePeriod(id: string): Period {
  return periodOfPid(toPid(id));
}

/** `"2026Q1"` → 8104. */
export function toPid(id: string): number {
  const m = /^(\d{4})Q([1-4])$/.exec(id);
  if (!m) throw new RangeError(`bad period id: ${id}`);
  return periodId(Number(m[1]), Number(m[2]));
}

/** 8104 → `"2026Q1"`. */
export function fromPid(pid: number): string {
  return periodLabel(pid);
}

/** Quarters covering [from, to), oldest first. */
export function periodsBetween(from: number, to: number): Period[] {
  const out: Period[] = [];
  let p = periodOf(from);
  while (p.start < to) {
    out.push(p);
    p = periodOfPid(p.pid + 1);
  }
  return out;
}
