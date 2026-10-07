import { describe, it, expect } from "vitest";
import {
  DAY,
  EIGHTEEN_MONTHS_SECONDS,
  MONTH_SECONDS,
  YEAR,
  civilFromDays,
  civilFromTimestamp,
  daysFromCivil,
  daysInPeriod,
  isLeapYear,
  periodEnd,
  periodId,
  periodLabel,
  periodOf,
  periodStart,
  quarterIndex,
  quarterOf,
  timestampFromCivil,
  yearOf,
} from "../src/index.js";

function utc(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): bigint {
  return BigInt(Date.UTC(y, m - 1, d, hh, mm, ss) / 1000);
}

describe("time constants (SPEC §1.2)", () => {
  it("values", () => {
    expect(DAY).toBe(86_400n);
    expect(YEAR).toBe(31_536_000n);
    expect(MONTH_SECONDS).toBe(2_629_800n);
    expect(EIGHTEEN_MONTHS_SECONDS).toBe(47_336_400n);
  });
});

describe("Hinnant civil <-> days", () => {
  it("matches Date.UTC for every day from 1970 to 2200", () => {
    const start = Date.UTC(1970, 0, 1);
    const end = Date.UTC(2200, 11, 31);
    let checked = 0;
    for (let t = start; t <= end; t += 86_400_000) {
      const d = new Date(t);
      const days = BigInt(t / 86_400_000);
      const c = civilFromDays(days);
      expect([c.year, c.month, c.day]).toEqual([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]);
      expect(daysFromCivil(c.year, c.month, c.day)).toBe(days);
      checked++;
    }
    expect(checked).toBeGreaterThan(84_000);
  });
  it("handles far dates and the proleptic rules", () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0n);
    expect(daysFromCivil(2000, 3, 1)).toBe(BigInt(Date.UTC(2000, 2, 1) / 86_400_000));
    expect(civilFromDays(daysFromCivil(2400, 2, 29))).toEqual({ year: 2400, month: 2, day: 29 });
    expect(civilFromDays(daysFromCivil(9999, 12, 31))).toEqual({ year: 9999, month: 12, day: 31 });
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(() => daysFromCivil(2026, 13, 1)).toThrow(RangeError);
    expect(() => daysFromCivil(2026, 1, 0)).toThrow(RangeError);
  });
  it("timestampFromCivil / civilFromTimestamp", () => {
    expect(timestampFromCivil(2026, 1, 1)).toBe(1_767_225_600n);
    expect(timestampFromCivil(2038, 1, 19, 3, 14, 7)).toBe(2_147_483_647n);
    expect(civilFromTimestamp(2_147_483_647n)).toEqual({ year: 2038, month: 1, day: 19, hour: 3, minute: 14, second: 7 });
    expect(() => timestampFromCivil(2026, 1, 1, 24)).toThrow(RangeError);
  });
});

describe("periods", () => {
  it("period_id = year × 4 + (quarter − 1); 2026 Q1 → 8104", () => {
    expect(periodId(2026, 1)).toBe(8104);
    expect(periodId(2026, 4)).toBe(8107);
    expect(periodId(2029, 3)).toBe(8118);
    expect(yearOf(8104)).toBe(2026);
    expect(quarterIndex(8104)).toBe(0);
    expect(quarterOf(8107)).toBe(4);
    expect(periodLabel(8118)).toBe("2029Q3");
    expect(() => periodId(2026, 5)).toThrow(RangeError);
    expect(() => periodId(2026, 0)).toThrow(RangeError);
  });

  const cases: { date: [number, number, number, number, number, number]; pid: number; days: number }[] = [
    { date: [1970, 1, 1, 0, 0, 0], pid: 1970 * 4, days: 90 },
    { date: [2000, 2, 29, 12, 0, 0], pid: 2000 * 4, days: 91 },
    { date: [2024, 2, 29, 0, 0, 0], pid: 2024 * 4, days: 91 },
    { date: [2024, 3, 31, 23, 59, 59], pid: 2024 * 4, days: 91 },
    { date: [2024, 4, 1, 0, 0, 0], pid: 2024 * 4 + 1, days: 91 },
    { date: [2024, 12, 31, 23, 59, 59], pid: 2024 * 4 + 3, days: 92 },
    { date: [2025, 1, 1, 0, 0, 0], pid: 2025 * 4, days: 90 },
    { date: [2026, 1, 1, 0, 0, 0], pid: 8104, days: 90 },
    { date: [2026, 3, 31, 23, 59, 59], pid: 8104, days: 90 },
    { date: [2026, 4, 1, 0, 0, 0], pid: 8105, days: 91 },
    { date: [2026, 6, 30, 23, 59, 59], pid: 8105, days: 91 },
    { date: [2026, 7, 1, 0, 0, 0], pid: 8106, days: 92 },
    { date: [2026, 9, 30, 23, 59, 59], pid: 8106, days: 92 },
    { date: [2026, 10, 1, 0, 0, 0], pid: 8107, days: 92 },
    { date: [2026, 12, 31, 23, 59, 59], pid: 8107, days: 92 },
    { date: [2027, 2, 28, 23, 59, 59], pid: 2027 * 4, days: 90 },
    { date: [2027, 3, 1, 0, 0, 0], pid: 2027 * 4, days: 90 },
    { date: [2028, 2, 29, 23, 59, 59], pid: 2028 * 4, days: 91 },
    { date: [2028, 3, 1, 0, 0, 0], pid: 2028 * 4, days: 91 },
    { date: [2028, 12, 31, 23, 59, 59], pid: 2028 * 4 + 3, days: 92 },
    { date: [2029, 1, 1, 0, 0, 0], pid: 2029 * 4, days: 90 },
    { date: [2029, 9, 30, 23, 59, 59], pid: 2029 * 4 + 2, days: 92 },
    { date: [2029, 10, 1, 0, 0, 0], pid: 2029 * 4 + 3, days: 92 },
    { date: [2032, 2, 29, 6, 30, 0], pid: 2032 * 4, days: 91 },
    { date: [2038, 1, 19, 3, 14, 7], pid: 2038 * 4, days: 90 },
    { date: [2099, 12, 31, 23, 59, 59], pid: 2099 * 4 + 3, days: 92 },
    { date: [2100, 2, 28, 23, 59, 59], pid: 2100 * 4, days: 90 },
    { date: [2100, 3, 1, 0, 0, 0], pid: 2100 * 4, days: 90 },
    { date: [2400, 2, 29, 0, 0, 0], pid: 2400 * 4, days: 91 },
  ];

  it(`classifies ${cases.length} timestamps across leap and non-leap years`, () => {
    for (const c of cases) {
      const ts = timestampFromCivil(...c.date);
      expect(ts).toBe(utc(...c.date));
      expect(periodOf(ts)).toBe(c.pid);
      expect(daysInPeriod(c.pid)).toBe(BigInt(c.days));
      const y = yearOf(c.pid);
      const q = quarterIndex(c.pid);
      expect(periodStart(c.pid)).toBe(utc(y, q * 3 + 1, 1));
      expect(periodEnd(c.pid)).toBe(q === 3 ? utc(y + 1, 1, 1) : utc(y, q * 3 + 4, 1));
      expect(periodStart(c.pid) <= ts && ts < periodEnd(c.pid)).toBe(true);
    }
  });

  it("boundaries are exact: the last second belongs to the old quarter, the next second to the new one", () => {
    for (let pid = periodId(2024, 1); pid <= periodId(2031, 4); pid++) {
      const end = periodEnd(pid);
      expect(periodOf(end - 1n)).toBe(pid);
      expect(periodOf(end)).toBe(pid + 1);
      expect(periodStart(pid + 1)).toBe(end);
      expect([90n, 91n, 92n]).toContain(daysInPeriod(pid));
    }
  });

  it("Q1 has 90 days except in leap years (91); Q2 91; Q3 and Q4 92", () => {
    expect(daysInPeriod(periodId(2026, 1))).toBe(90n);
    expect(daysInPeriod(periodId(2028, 1))).toBe(91n);
    expect(daysInPeriod(periodId(2026, 2))).toBe(91n);
    expect(daysInPeriod(periodId(2026, 3))).toBe(92n);
    expect(daysInPeriod(periodId(2026, 4))).toBe(92n);
  });

  it("rejects negative timestamps and bad period ids", () => {
    expect(() => periodOf(-1n)).toThrow(RangeError);
    expect(() => periodStart(-1)).toThrow(RangeError);
    expect(() => yearOf(1.5)).toThrow(RangeError);
  });
});
