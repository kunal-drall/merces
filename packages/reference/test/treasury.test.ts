import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { releasable, trancheAmounts, validateReleaseSchedule, vested, type ReleaseTranche } from "../src/index.js";

const DAY = 86_400n;
const schedule: ReleaseTranche[] = [
  { atOffsetSeconds: 0n, bps: 2500 },
  { atOffsetSeconds: 90n * DAY, bps: 2500 },
  { atOffsetSeconds: 180n * DAY, bps: 2500 },
  { atOffsetSeconds: 270n * DAY, bps: 2500 },
];

describe("treasury (SPEC §5.3)", () => {
  it("tranches sum exactly to proceeds; the last tranche takes the remainder", () => {
    expect(trancheAmounts(1_000_001n, schedule)).toEqual([250_000n, 250_000n, 250_000n, 250_001n]);
    expect(trancheAmounts(7n, [{ atOffsetSeconds: 0n, bps: 3333 }, { atOffsetSeconds: 1n, bps: 3333 }, { atOffsetSeconds: 2n, bps: 3334 }])).toEqual([2n, 2n, 3n]);
    expect(trancheAmounts(0n, schedule)).toEqual([0n, 0n, 0n, 0n]);
  });
  it("vesting follows offsets from settlement", () => {
    const s = 1_000n;
    expect(vested(s - 1n, s, schedule, 1_000_000n)).toBe(0n);
    expect(vested(s, s, schedule, 1_000_000n)).toBe(250_000n);
    expect(vested(s + 90n * DAY - 1n, s, schedule, 1_000_000n)).toBe(250_000n);
    expect(vested(s + 90n * DAY, s, schedule, 1_000_000n)).toBe(500_000n);
    expect(vested(s + 1000n * DAY, s, schedule, 1_000_000n)).toBe(1_000_000n);
  });
  it("releasable nets out what was already released (including early draws)", () => {
    const s = 0n;
    expect(releasable(100n * DAY, s, schedule, 1_000_000n, 0n)).toBe(500_000n);
    expect(releasable(100n * DAY, s, schedule, 1_000_000n, 300_000n)).toBe(200_000n);
    expect(releasable(100n * DAY, s, schedule, 1_000_000n, 600_000n)).toBe(0n);
    expect(releasable(1000n * DAY, s, schedule, 1_000_000n, 600_000n)).toBe(400_000n);
  });
  it("schedule validation", () => {
    expect(validateReleaseSchedule(schedule)).toEqual([]);
    expect(validateReleaseSchedule([])).toContain("empty");
    expect(validateReleaseSchedule([{ atOffsetSeconds: 0n, bps: 9999 }])).toContain("bps_sum_not_10000");
    expect(validateReleaseSchedule([{ atOffsetSeconds: 10n, bps: 5000 }, { atOffsetSeconds: 5n, bps: 5000 }])).toContain("offsets_decrease");
    expect(validateReleaseSchedule(Array.from({ length: 25 }, () => ({ atOffsetSeconds: 0n, bps: 400 })))).toContain("too_many_tranches");
  });
  it("property: Σ tranches == proceeds and vesting is monotone", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1n << 60n }), fc.array(fc.integer({ min: 1, max: 5000 }), { minLength: 1, maxLength: 24 }), (proceeds, weights) => {
        const total = weights.reduce((a, b) => a + b, 0);
        const sched: ReleaseTranche[] = weights.map((w, i) => ({ atOffsetSeconds: BigInt(i) * DAY, bps: Math.floor((w * 10_000) / total) }));
        const sumBps = sched.reduce((a, t) => a + t.bps, 0);
        sched[sched.length - 1]!.bps += 10_000 - sumBps;
        expect(validateReleaseSchedule(sched)).toEqual([]);
        const amounts = trancheAmounts(proceeds, sched);
        expect(amounts.reduce((a, b) => a + b, 0n)).toBe(proceeds);
        let prev = 0n;
        for (let i = 0; i <= sched.length; i++) {
          const v = vested(BigInt(i) * DAY, 0n, sched, proceeds);
          expect(v >= prev).toBe(true);
          prev = v;
        }
        expect(prev).toBe(proceeds);
      }),
      { numRuns: 200 },
    );
  });
});
