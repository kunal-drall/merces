import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { DAY, isPausedAt, pausedElapsed, pausedTotal, pausedWithin, timestampFromCivil, unpaused, type Pause } from "../src/index.js";

const ts = timestampFromCivil;
const pauses: Pause[] = [
  { start: ts(2026, 4, 10), end: ts(2026, 6, 10) },
  { start: ts(2026, 9, 1), end: ts(2026, 9, 20) },
];

describe("unpaused countdowns (SPEC §6.4)", () => {
  it("paused_within intersects every pause with [a, b]", () => {
    const now = ts(2027, 1, 1);
    expect(pausedWithin(pauses, ts(2026, 4, 1), ts(2026, 7, 10), now)).toBe(61n * DAY);
    expect(pausedWithin(pauses, ts(2026, 4, 1), ts(2026, 5, 1), now)).toBe(21n * DAY);
    expect(pausedWithin(pauses, ts(2026, 7, 1), ts(2026, 10, 1), now)).toBe(19n * DAY);
    expect(pausedWithin(pauses, ts(2026, 1, 1), ts(2027, 1, 1), now)).toBe(80n * DAY);
    expect(pausedWithin(pauses, ts(2026, 6, 10), ts(2026, 9, 1), now)).toBe(0n);
    expect(unpaused(pauses, ts(2026, 4, 1), ts(2026, 7, 10), now)).toBe(100n * DAY - 61n * DAY);
    expect(() => unpaused(pauses, 10n, 5n, now)).toThrow(RangeError);
  });
  it("the open pause is clipped at now", () => {
    const now = ts(2026, 5, 1);
    expect(pausedWithin(pauses, ts(2026, 4, 1), ts(2026, 7, 10), now)).toBe(21n * DAY);
    expect(isPausedAt(pauses, now)).toBe(true);
    expect(isPausedAt(pauses, ts(2026, 6, 10))).toBe(false);
    expect(isPausedAt(pauses, ts(2026, 4, 10))).toBe(true);
    expect(isPausedAt(pauses, ts(2026, 4, 9, 23, 59, 59))).toBe(false);
    expect(pausedElapsed(pauses, now)).toBe(21n * DAY);
    expect(pausedTotal(pauses)).toBe(80n * DAY);
  });
  it("a pause that starts after the countdown's interval does not shift it", () => {
    const now = ts(2026, 12, 1);
    expect(unpaused(pauses, ts(2026, 10, 1), ts(2026, 12, 1), now)).toBe(61n * DAY);
  });
  it("property: 0 ≤ paused_within ≤ b − a, additive over adjacent intervals", () => {
    // real pause lists never overlap (approve_pause requires !is_paused): build disjoint pauses
    const pauseArb = fc.array(fc.tuple(fc.bigInt({ min: 0n, max: 200n }), fc.bigInt({ min: 1n, max: 300n })), { maxLength: 6 }).map((segs) => {
      const out: Pause[] = [];
      let cursor = 0n;
      for (const [gap, len] of segs) {
        const start = cursor + gap;
        out.push({ start, end: start + len });
        cursor = start + len;
      }
      return out;
    });
    fc.assert(
      fc.property(pauseArb, fc.bigInt({ min: 0n, max: 1500n }), fc.bigInt({ min: 0n, max: 1500n }), fc.bigInt({ min: 0n, max: 1500n }), fc.bigInt({ min: 0n, max: 2000n }), (ps, a0, b0, c0, now) => {
        const [a, b, c] = [a0, b0, c0].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)) as [bigint, bigint, bigint];
        const ab = pausedWithin(ps, a, b, now);
        expect(ab >= 0n && ab <= b - a).toBe(true);
        expect(pausedWithin(ps, a, b, now) + pausedWithin(ps, b, c, now)).toBe(pausedWithin(ps, a, c, now));
        expect(unpaused(ps, a, c, now)).toBe(c - a - pausedWithin(ps, a, c, now));
      }),
      { numRuns: 500 },
    );
  });
});
