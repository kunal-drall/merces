import { describe, it, expect } from "vitest";
import { DAY, SeriesStatus, WAD, periodEnd, periodId, timestampFromCivil } from "@merces/sdk";
import {
  countdown,
  deriveStatus,
  earliestUnpaid,
  formalNoticeDue,
  isLateUnderlying,
  lateAccrual,
  lateAccrualTrueup,
  lateDays,
  nextExpectedPeriod,
  pauseApprovalError,
  trueupNoticeDue,
  trueupOverdue,
  type LedgerClock,
  type StatusParams,
} from "../src/index.js";

const ts = timestampFromCivil;
const params: StatusParams = { reportDueDays: 30, graceDays: 15, formalNoticeDays: 90, trueupDays: 60, hurdleRateWad: (8n * WAD) / 100n };
const q1 = periodId(2026, 1);
const base: LedgerClock = { status: SeriesStatus.OnTime, firstPeriod: q1, lastAcceptedPeriod: null, openDuePeriod: null, openDueAmount: 0n, pauses: [], trueupDue: 0n, trueupAttestedAt: 0n };
const deadline = periodEnd(q1) + 30n * DAY; // 1 May 2026
const graceEnd = deadline + 15n * DAY; // 16 May 2026

describe("countdowns (SPEC v1.1 §6.4)", () => {
  it("run in unpaused time from period_end", () => {
    expect(countdown(q1, base, periodEnd(q1) - 1n)).toBe(0n);
    expect(countdown(q1, base, periodEnd(q1) + 5n * DAY)).toBe(5n * DAY);
    const paused = { ...base, pauses: [{ start: ts(2026, 4, 10), end: ts(2026, 6, 10) }] };
    expect(countdown(q1, paused, ts(2026, 7, 1))).toBe(91n * DAY - 61n * DAY);
    expect(nextExpectedPeriod(base)).toBe(q1);
    expect(earliestUnpaid({ ...base, lastAcceptedPeriod: q1, openDuePeriod: q1, openDueAmount: 5n })).toBe(q1);
    expect(earliestUnpaid({ ...base, lastAcceptedPeriod: q1, openDuePeriod: q1, openDueAmount: 0n })).toBe(q1 + 1);
  });
  it("OnTime → InGrace → Late across the deadline and grace end; formal notice at 90 days", () => {
    expect(deriveStatus(base, ts(2026, 2, 1), params)).toBe(SeriesStatus.OnTime);
    expect(deriveStatus(base, deadline, params)).toBe(SeriesStatus.OnTime);
    expect(deriveStatus(base, deadline + 1n, params)).toBe(SeriesStatus.InGrace);
    expect(deriveStatus(base, graceEnd, params)).toBe(SeriesStatus.InGrace);
    expect(deriveStatus(base, graceEnd + 1n, params)).toBe(SeriesStatus.Late);
    expect(formalNoticeDue(q1, base, periodEnd(q1) + 90n * DAY - 1n, params)).toBe(false);
    expect(formalNoticeDue(q1, base, periodEnd(q1) + 90n * DAY, params)).toBe(true);
    expect(isLateUnderlying(base, graceEnd + 1n, params)).toBe(true);
    expect(isLateUnderlying(base, graceEnd, params)).toBe(false);
  });
  it("terminal statuses are returned as stored", () => {
    for (const s of [SeriesStatus.Retired, SeriesStatus.Redeemed, SeriesStatus.Extinguished]) {
      expect(deriveStatus({ ...base, status: s }, graceEnd + 100n * DAY, params)).toBe(s);
      expect(isLateUnderlying({ ...base, status: s }, graceEnd + 100n * DAY, params)).toBe(false);
    }
  });
  it("a pause stops every running clock but does not shift obligations that start later", () => {
    const c = { ...base, pauses: [{ start: ts(2026, 4, 10), end: ts(2026, 6, 10) }] };
    expect(deriveStatus(c, ts(2026, 5, 20), params)).toBe(SeriesStatus.Paused);
    expect(deriveStatus(c, ts(2026, 6, 10), params)).toBe(SeriesStatus.OnTime); // 61 days paused: deadline effectively 1 July
    expect(deriveStatus(c, ts(2026, 7, 1), params)).toBe(SeriesStatus.OnTime);
    expect(deriveStatus(c, ts(2026, 7, 1, 0, 0, 1), params)).toBe(SeriesStatus.InGrace);
    expect(deriveStatus(c, ts(2026, 7, 16, 0, 0, 1), params)).toBe(SeriesStatus.Late);
    // Q2's clock starts 1 July, after the pause: it is not shifted
    const q2Clock = { ...c, lastAcceptedPeriod: q1 };
    expect(countdown(q1 + 1, q2Clock, ts(2026, 8, 1))).toBe(31n * DAY);
    expect(deriveStatus(q2Clock, ts(2026, 7, 31), params)).toBe(SeriesStatus.OnTime);
    expect(deriveStatus(q2Clock, ts(2026, 7, 31, 0, 0, 1), params)).toBe(SeriesStatus.InGrace);
  });
  it("a pause approved while Late keeps the underlying lateness (releases stay blocked)", () => {
    const c = { ...base, pauses: [{ start: ts(2026, 5, 20), end: ts(2026, 7, 20) }] };
    expect(deriveStatus(c, ts(2026, 6, 1), params)).toBe(SeriesStatus.Paused);
    expect(isLateUnderlying(c, ts(2026, 6, 1), params)).toBe(true);
    expect(lateDays(q1, c, ts(2026, 6, 1), params)).toBe(4n); // 16 → 20 May, then frozen
    expect(lateDays(q1, c, ts(2026, 7, 25), params)).toBe(9n);
  });
});

describe("late accrual (nested mulDiv)", () => {
  const c = { ...base, lastAcceptedPeriod: q1, openDuePeriod: q1, openDueAmount: 10_000_000_000n };
  it("simple interest per whole late day from grace end", () => {
    expect(lateDays(q1, c, graceEnd, params)).toBe(0n);
    expect(lateDays(q1, c, graceEnd + DAY - 1n, params)).toBe(0n);
    expect(lateDays(q1, c, graceEnd + DAY, params)).toBe(1n);
    expect(lateAccrual(q1, 10_000_000_000n, c, graceEnd + 10n * DAY, params)).toBe((((10_000_000_000n * params.hurdleRateWad) / WAD) * 10n) / 365n);
    expect(lateAccrual(q1, 10_000_000_000n, c, graceEnd + 10n * DAY, params)).toBe(21_917_808n);
    expect(lateAccrual(q1, 2_000_000_000n, c, graceEnd + 77n * DAY, params)).toBe(33_753_424n);
    expect(lateAccrual(q1, 0n, c, graceEnd + 100n * DAY, params)).toBe(0n);
    // nested rounding differs from the single-expression floor for small amounts
    expect(lateAccrual(q1, 7n, c, graceEnd + 365n * DAY, params)).toBe(0n); // mulDiv(7, 0.08) = 0
  });
  it("true-up: overdue after trueup_days of unpaused time, accrual and notice", () => {
    const t = { ...base, trueupDue: 1_000_000_000n, trueupAttestedAt: ts(2027, 2, 1) };
    expect(trueupOverdue(t, ts(2027, 4, 2), params)).toBe(false); // 60 days exactly
    expect(trueupOverdue(t, ts(2027, 4, 2, 0, 0, 1), params)).toBe(true);
    expect(deriveStatus(t, ts(2027, 4, 3), params)).toBe(SeriesStatus.Late);
    expect(isLateUnderlying(t, ts(2027, 4, 3), params)).toBe(true);
    expect(lateAccrualTrueup(t, ts(2027, 4, 12), params)).toBe((((1_000_000_000n * params.hurdleRateWad) / WAD) * 10n) / 365n);
    expect(lateAccrualTrueup(t, ts(2027, 4, 1), params)).toBe(0n);
    expect(trueupNoticeDue(t, ts(2027, 2, 1) + 60n * DAY + 45n * DAY - 1n, params)).toBe(false);
    expect(trueupNoticeDue(t, ts(2027, 2, 1) + 60n * DAY + 45n * DAY, params)).toBe(true);
    const paused = { ...t, pauses: [{ start: ts(2027, 3, 1), end: ts(2027, 3, 11) }] };
    expect(trueupOverdue(paused, ts(2027, 4, 12), params)).toBe(false);
  });
});

describe("pause approval bounds", () => {
  const bounds = { maxPauseSeconds: 365n * DAY, maxCumulativePauseSeconds: 730n * DAY, maxPauses: 16 };
  it("checks end, overlap, length, cumulative length and count", () => {
    const now = ts(2026, 4, 10);
    expect(pauseApprovalError([], 0n, now, now, bounds)).toBe("InvalidPauseEnd");
    expect(pauseApprovalError([{ start: now - DAY, end: now + DAY }], 2n * DAY, now, now + 10n * DAY, bounds)).toBe("AlreadyPaused");
    expect(pauseApprovalError([], 0n, now, now + 366n * DAY, bounds)).toBe("PauseTooLong");
    expect(pauseApprovalError([], 400n * DAY, now, now + 331n * DAY, bounds)).toBe("PauseTooLong");
    expect(pauseApprovalError([], 400n * DAY, now, now + 330n * DAY, bounds)).toBeNull();
    const sixteen = Array.from({ length: 16 }, (_, i) => ({ start: BigInt(i) * 10n, end: BigInt(i) * 10n + 5n }));
    expect(pauseApprovalError(sixteen, 80n, now, now + DAY, bounds)).toBe("TooManyPauses");
    expect(pauseApprovalError([], 0n, now, now + 60n * DAY, bounds)).toBeNull();
  });
});
