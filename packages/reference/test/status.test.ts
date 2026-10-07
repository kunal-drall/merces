import { describe, it, expect } from "vitest";
import { DAY, SeriesStatus, WAD, periodEnd, periodId, timestampFromCivil } from "@merces/sdk";
import {
  closeExpiredPause,
  deadline,
  deriveStatus,
  earliestUnpaid,
  effectiveNow,
  formalNoticeDue,
  graceEnd,
  isPaused,
  lateAccrual,
  lateDays,
  nextExpectedPeriod,
  type LedgerClock,
  type StatusParams,
} from "../src/index.js";

const params: StatusParams = { reportDueDays: 30, graceDays: 15, formalNoticeDays: 90, hurdleRateWad: (8n * WAD) / 100n };
const q1 = periodId(2026, 1);
const base: LedgerClock = { status: SeriesStatus.OnTime, firstPeriod: q1, lastAcceptedPeriod: null, openDuePeriod: null, openDueAmount: 0n, pauseStart: 0n, pauseEnd: 0n, pausedTotal: 0n };

describe("deadlines (brief C8)", () => {
  it("2026 Q1: due 1 May, grace to 16 May, formal notice 30 July", () => {
    expect(periodEnd(q1)).toBe(timestampFromCivil(2026, 4, 1));
    expect(deadline(q1, params)).toBe(timestampFromCivil(2026, 5, 1));
    expect(graceEnd(q1, params)).toBe(timestampFromCivil(2026, 5, 16));
    expect(formalNoticeDue(q1, base, timestampFromCivil(2026, 7, 30) - 1n, params)).toBe(false);
    expect(formalNoticeDue(q1, base, timestampFromCivil(2026, 7, 30), params)).toBe(true);
  });
  it("earliest unpaid period follows the ledger", () => {
    expect(nextExpectedPeriod(base)).toBe(q1);
    expect(nextExpectedPeriod({ ...base, lastAcceptedPeriod: q1 })).toBe(q1 + 1);
    expect(earliestUnpaid({ ...base, lastAcceptedPeriod: q1 + 1, openDuePeriod: q1 + 1, openDueAmount: 5n })).toBe(q1 + 1);
    expect(earliestUnpaid({ ...base, lastAcceptedPeriod: q1 + 1, openDuePeriod: q1 + 1, openDueAmount: 0n })).toBe(q1 + 2);
  });
});

describe("derive_status", () => {
  it("OnTime → InGrace → Late across the deadline and grace end", () => {
    expect(deriveStatus(base, timestampFromCivil(2026, 2, 1), params)).toBe(SeriesStatus.OnTime);
    expect(deriveStatus(base, deadline(q1, params), params)).toBe(SeriesStatus.OnTime);
    expect(deriveStatus(base, deadline(q1, params) + 1n, params)).toBe(SeriesStatus.InGrace);
    expect(deriveStatus(base, graceEnd(q1, params), params)).toBe(SeriesStatus.InGrace);
    expect(deriveStatus(base, graceEnd(q1, params) + 1n, params)).toBe(SeriesStatus.Late);
  });
  it("a report accepted but unpaid keeps the due period as the clock", () => {
    const c = { ...base, lastAcceptedPeriod: q1, openDuePeriod: q1, openDueAmount: 100n };
    expect(deriveStatus(c, graceEnd(q1, params) + 1n, params)).toBe(SeriesStatus.Late);
    const paid = { ...c, openDueAmount: 0n };
    expect(deriveStatus(paid, graceEnd(q1, params) + 1n, params)).toBe(SeriesStatus.OnTime);
  });
  it("terminal statuses are returned as stored", () => {
    for (const s of [SeriesStatus.Retired, SeriesStatus.Redeemed, SeriesStatus.Extinguished]) {
      expect(deriveStatus({ ...base, status: s }, graceEnd(q1, params) + 100n * DAY, params)).toBe(s);
    }
  });
  it("hardship pause stops the clock and reports Paused", () => {
    const start = timestampFromCivil(2026, 4, 20);
    const end = timestampFromCivil(2026, 6, 20);
    const c = { ...base, pauseStart: start, pauseEnd: end };
    expect(isPaused(c, start)).toBe(true);
    expect(isPaused(c, end)).toBe(false);
    expect(deriveStatus(c, timestampFromCivil(2026, 5, 20), params)).toBe(SeriesStatus.Paused);
    // effective time at the pause end is the pause start
    expect(effectiveNow(c, end)).toBe(start);
    // right after the pause ends, 61 days of pause have shifted the deadline from 1 May to 1 July
    expect(deriveStatus(c, end, params)).toBe(SeriesStatus.OnTime);
    expect(deriveStatus(c, end + 10n * DAY, params)).toBe(SeriesStatus.OnTime);
    expect(deriveStatus(c, end + 11n * DAY + 1n, params)).toBe(SeriesStatus.InGrace);
    // sync folds the finished pause into paused_total; the derived values do not change
    const closed = { ...c, ...closeExpiredPause(c, end) };
    expect(closed.pausedTotal).toBe(end - start);
    expect(closed.pauseStart).toBe(0n);
    expect(effectiveNow(closed, end + 5n * DAY)).toBe(effectiveNow(c, end + 5n * DAY));
    expect(closeExpiredPause(c, end - 1n)).toEqual({ pauseStart: start, pauseEnd: end, pausedTotal: 0n });
  });
});

describe("late accrual", () => {
  it("simple interest at the hurdle rate per whole late day, counted from grace end", () => {
    const c = { ...base, lastAcceptedPeriod: q1, openDuePeriod: q1, openDueAmount: 10_000_000_000n };
    const g = graceEnd(q1, params);
    expect(lateDays(q1, c, g, params)).toBe(0n);
    expect(lateDays(q1, c, g + DAY - 1n, params)).toBe(0n);
    expect(lateDays(q1, c, g + DAY, params)).toBe(1n);
    expect(lateDays(q1, c, g + 10n * DAY + 5n, params)).toBe(10n);
    expect(lateAccrual(q1, 10_000_000_000n, c, g + 10n * DAY, params)).toBe(21_917_808n); // 10,000 × 8% × 10/365
    expect(lateAccrual(q1, 10_000_000_000n, c, g - 1n, params)).toBe(0n);
    expect(lateAccrual(q1, 0n, c, g + 100n * DAY, params)).toBe(0n);
  });
  it("a pause removes days from the accrual", () => {
    const g = graceEnd(q1, params);
    const c = { ...base, lastAcceptedPeriod: q1, openDuePeriod: q1, openDueAmount: 1n, pauseStart: g + 2n * DAY, pauseEnd: g + 7n * DAY };
    expect(lateDays(q1, c, g + 10n * DAY, params)).toBe(5n);
    expect(lateDays(q1, c, g + 4n * DAY, params)).toBe(2n);
  });
});
