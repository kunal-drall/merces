/**
 * Time, days and periods (SPEC §1.2). Timestamps are unix seconds (bigint). Period ids are small
 * integers: `period_id = year × 4 + (quarter − 1)`.
 */

export const DAY = 86_400n;
/** 365 days: hurdle years, late-accrual denominators and the tail. */
export const YEAR = 365n * DAY;
/** 30.4375 days. */
export const MONTH_SECONDS = 2_629_800n;
/** 18 × MONTH_SECONDS. */
export const EIGHTEEN_MONTHS_SECONDS = 18n * MONTH_SECONDS;

export interface CivilDate {
  year: number;
  /** 1..12 */
  month: number;
  /** 1..31 */
  day: number;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

/**
 * Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
 * Exact for every representable date.
 */
export function daysFromCivil(year: number, month: number, day: number): bigint {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) throw new TypeError("date fields must be integers");
  if (month < 1 || month > 12) throw new RangeError(`month out of range: ${month}`);
  if (day < 1 || day > 31) throw new RangeError(`day out of range: ${day}`);
  const y = BigInt(month <= 2 ? year - 1 : year);
  const era = floorDiv(y, 400n);
  const yoe = y - era * 400n; // [0, 399]
  const m = BigInt(month);
  const doy = floorDiv(153n * (m + (m > 2n ? -3n : 9n)) + 2n, 5n) + BigInt(day) - 1n; // [0, 365]
  const doe = yoe * 365n + floorDiv(yoe, 4n) - floorDiv(yoe, 100n) + doy; // [0, 146096]
  return era * 146_097n + doe - 719_468n;
}

/** Civil date from days since 1970-01-01 (Howard Hinnant's `civil_from_days`). */
export function civilFromDays(z0: bigint): CivilDate {
  const z = z0 + 719_468n;
  const era = floorDiv(z, 146_097n);
  const doe = z - era * 146_097n; // [0, 146096]
  const yoe = floorDiv(doe - floorDiv(doe, 1460n) + floorDiv(doe, 36_524n) - floorDiv(doe, 146_096n), 365n); // [0, 399]
  const y = yoe + era * 400n;
  const doy = doe - (365n * yoe + floorDiv(yoe, 4n) - floorDiv(yoe, 100n)); // [0, 365]
  const mp = floorDiv(5n * doy + 2n, 153n); // [0, 11]
  const d = doy - floorDiv(153n * mp + 2n, 5n) + 1n; // [1, 31]
  const m = mp < 10n ? mp + 3n : mp - 9n; // [1, 12]
  return { year: Number(m <= 2n ? y + 1n : y), month: Number(m), day: Number(d) };
}

/** Unix timestamp of a UTC civil date-time. */
export function timestampFromCivil(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): bigint {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) throw new RangeError("time out of range");
  return daysFromCivil(year, month, day) * DAY + BigInt(hour) * 3600n + BigInt(minute) * 60n + BigInt(second);
}

export function civilFromTimestamp(ts: bigint): CivilDate & { hour: number; minute: number; second: number } {
  const days = floorDiv(ts, DAY);
  const rem = Number(ts - days * DAY);
  return { ...civilFromDays(days), hour: Math.floor(rem / 3600), minute: Math.floor((rem % 3600) / 60), second: rem % 60 };
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** `period_id = year × 4 + (quarter − 1)`, quarter ∈ {1,2,3,4}. */
export function periodId(year: number, quarter: number): number {
  if (!Number.isInteger(year) || year < 1970) throw new RangeError(`year out of range: ${year}`);
  if (quarter < 1 || quarter > 4 || !Number.isInteger(quarter)) throw new RangeError(`quarter out of range: ${quarter}`);
  return year * 4 + (quarter - 1);
}

function assertPeriod(pid: number): void {
  if (!Number.isInteger(pid) || pid < 0 || pid > 0xffff_ffff) throw new RangeError(`period id out of range: ${pid}`);
}

/** The UTC calendar quarter containing `ts` (ts ≥ 0). */
export function periodOf(ts: bigint): number {
  if (ts < 0n) throw new RangeError("timestamp must be ≥ 0");
  const { year, month } = civilFromDays(ts / DAY);
  return periodId(year, Math.floor((month - 1) / 3) + 1);
}

export function yearOf(pid: number): number {
  assertPeriod(pid);
  return Math.floor(pid / 4);
}

/** 0 = Q1 … 3 = Q4. */
export function quarterIndex(pid: number): number {
  assertPeriod(pid);
  return pid % 4;
}

/** 1 = Q1 … 4 = Q4. */
export function quarterOf(pid: number): number {
  return quarterIndex(pid) + 1;
}

/** First second of the quarter. */
export function periodStart(pid: number): bigint {
  assertPeriod(pid);
  return daysFromCivil(yearOf(pid), quarterIndex(pid) * 3 + 1, 1) * DAY;
}

/** First second of the next quarter (exclusive end). */
export function periodEnd(pid: number): bigint {
  assertPeriod(pid);
  return periodStart(pid + 1);
}

/** 90, 91 or 92. */
export function daysInPeriod(pid: number): bigint {
  return (periodEnd(pid) - periodStart(pid)) / DAY;
}

/** Day of week of a days-since-epoch value: 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday). */
export function weekdayOfDays(days: bigint): number {
  return Number((((days + 4n) % 7n) + 7n) % 7n);
}

/** Monday–Friday civil day (UTC). */
export function isTradingDay(ts: bigint): boolean {
  const w = weekdayOfDays(floorDiv(ts, DAY));
  return w >= 1 && w <= 5;
}

/** Number of Monday–Friday civil days in the quarter (SPEC §6.6 coverage base). */
export function tradingDaysInPeriod(pid: number): bigint {
  const start = periodStart(pid) / DAY;
  const end = periodEnd(pid) / DAY;
  let n = 0n;
  for (let d = start; d < end; d++) {
    const w = weekdayOfDays(d);
    if (w >= 1 && w <= 5) n++;
  }
  return n;
}

/** `"2026Q1"` style label. */
export function periodLabel(pid: number): string {
  return `${yearOf(pid)}Q${quarterOf(pid)}`;
}
