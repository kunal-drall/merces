/** Calendar helpers. Periods are calendar quarters in UTC (C1). All timestamps are unix seconds. */

export const DAY = 86_400;
export const YEAR_DAYS = 365n;

export interface Period {
  /** e.g. "2026Q3" */
  id: string;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  /** inclusive start, unix seconds */
  start: number;
  /** exclusive end, unix seconds */
  end: number;
  /** number of UTC days in the quarter */
  days: number;
}

export function periodOf(ts: number): Period {
  const d = new Date(ts * 1000);
  const year = d.getUTCFullYear();
  const quarter = (Math.floor(d.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  return periodFrom(year, quarter);
}

export function periodFrom(year: number, quarter: 1 | 2 | 3 | 4): Period {
  const start = Date.UTC(year, (quarter - 1) * 3, 1) / 1000;
  const end = quarter === 4 ? Date.UTC(year + 1, 0, 1) / 1000 : Date.UTC(year, quarter * 3, 1) / 1000;
  return { id: `${year}Q${quarter}`, year, quarter, start, end, days: Math.round((end - start) / DAY) };
}

export function parsePeriod(id: string): Period {
  const m = /^(\d{4})Q([1-4])$/.exec(id);
  if (!m) throw new RangeError(`bad period id: ${id}`);
  return periodFrom(Number(m[1]), Number(m[2]) as 1 | 2 | 3 | 4);
}

export function previousPeriod(p: Period): Period {
  return p.quarter === 1 ? periodFrom(p.year - 1, 4) : periodFrom(p.year, (p.quarter - 1) as 1 | 2 | 3 | 4);
}

export function nextPeriod(p: Period): Period {
  return p.quarter === 4 ? periodFrom(p.year + 1, 1) : periodFrom(p.year, (p.quarter + 1) as 1 | 2 | 3 | 4);
}

/** Quarters covering [from, to), oldest first. */
export function periodsBetween(from: number, to: number): Period[] {
  const out: Period[] = [];
  let p = periodOf(from);
  while (p.start < to) {
    out.push(p);
    p = nextPeriod(p);
  }
  return out;
}

export function comparePeriods(a: string, b: string): number {
  const pa = parsePeriod(a);
  const pb = parsePeriod(b);
  return pa.year !== pb.year ? pa.year - pb.year : pa.quarter - pb.quarter;
}

/** UTC day index (days since epoch) for a timestamp. One rate snapshot per day per feed (C9). */
export function utcDayIndex(ts: number): number {
  return Math.floor(ts / DAY);
}

/** Whole days elapsed between two timestamps, floored at zero. */
export function daysBetween(from: number, to: number): number {
  return to <= from ? 0 : Math.floor((to - from) / DAY);
}

/** Years elapsed as [wholeYears, fractional part in WAD]. Uses 365-day years (C7 hurdle). */
export function yearsSince(from: number, to: number): { whole: number; fracWad: bigint } {
  if (to <= from) return { whole: 0, fracWad: 0n };
  const secs = BigInt(to - from);
  const yearSecs = YEAR_DAYS * 86_400n;
  const whole = Number(secs / yearSecs);
  const rem = secs % yearSecs;
  return { whole, fracWad: (rem * 10n ** 18n) / yearSecs };
}
