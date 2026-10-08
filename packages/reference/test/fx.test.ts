import { describe, it, expect } from "vitest";
import { DAY, WAD, isTradingDay, periodEnd, periodId, periodStart, timestampFromCivil, tradingDaysInPeriod } from "@merces/sdk";
import { deviates, invertRate, newFxPairState, normalizePythPrice, quarterAverage, snapshot, snapshotsNeeded, validatePythPrice, type FxPairState } from "../src/index.js";

const params = { fxMaxStalenessSeconds: 3600n, fxMaxConfBps: 100, fxDeviationBandBps: 200, fxMinCoverageBps: 8000 };

describe("Pyth validation (SPEC v1.1 §6.6)", () => {
  it("normalize and invert are re-exported from the SDK", () => {
    expect(normalizePythPrice(108_345_678n, -8)).toBe(1_083_456_780_000_000_000n);
    expect(normalizePythPrice(7n, 2)).toBe(700n * WAD);
    expect(invertRate(150n * WAD)).toBe(6_666_666_666_666_666n);
  });
  it("staleness and confidence", () => {
    const now = 1_000_000n;
    expect(validatePythPrice({ price: 100n, conf: 1n, expo: -2, publishTime: now - 3600n }, now, params)).toBeNull();
    expect(validatePythPrice({ price: 100n, conf: 1n, expo: -2, publishTime: now - 3601n }, now, params)).toBe("StalePrice");
    expect(validatePythPrice({ price: 10_000n, conf: 100n, expo: -2, publishTime: now }, now, params)).toBeNull();
    expect(validatePythPrice({ price: 10_000n, conf: 101n, expo: -2, publishTime: now }, now, params)).toBe("ConfidenceTooWide");
    expect(validatePythPrice({ price: 0n, conf: 0n, expo: -2, publishTime: now }, now, params)).toBe("NonPositivePrice");
  });
  it("deviation band", () => {
    expect(deviates(102n * WAD, 100n * WAD, 200)).toBe(false);
    expect(deviates(102n * WAD + 1n, 100n * WAD, 200)).toBe(true);
    expect(deviates(97n * WAD, 100n * WAD, 200)).toBe(true);
  });
});

describe("accumulator and quarter averages", () => {
  const q3 = periodId(2026, 3); // 92 days, 66 trading days
  const q4 = periodId(2026, 4);

  /** snapshots on trading days only (FX feeds are stale on weekends by design) */
  function run(opts: { from?: number; to?: number; rate?: (d: number) => bigint; cross?: (d: number) => bigint | null; skip?: (d: number) => boolean } = {}): FxPairState {
    let s = newFxPairState();
    const from = opts.from ?? 0;
    const to = opts.to ?? 92;
    for (let d = from; d < to; d++) {
      const now = periodStart(q3) + BigInt(d) * DAY + 43_200n;
      if (!isTradingDay(now)) continue;
      if (opts.skip?.(d)) continue;
      s = snapshot(s, now, opts.rate ? opts.rate(d) : WAD, opts.cross ? opts.cross(d) : null, params).state;
    }
    return s;
  }

  it("coverage is measured over trading days: Q3 2026 needs 53 of 66", () => {
    expect(tradingDaysInPeriod(q3)).toBe(66n);
    expect(snapshotsNeeded(q3, 8000)).toBe(53);
    expect(snapshotsNeeded(periodId(2026, 1), 8000)).toBe(52);
  });
  it("live end checkpoint: the average is available right after the period ends, before any snapshot in p+1", () => {
    const s = run();
    expect(s.count).toBe(66);
    const before = quarterAverage(s, q3, params, periodEnd(q3) - 1n);
    expect(before.ok).toBe(false); // period still running
    const live = quarterAverage(s, q3, params, periodEnd(q3));
    expect(live).toMatchObject({ ok: true, n: 66, avgWad: WAD, liveEnd: true });
    // once Q4 has a snapshot the stored checkpoint is used instead
    const withQ4 = snapshot(s, periodStart(q4) + 43_200n, 2n * WAD, null, params).state;
    const stored = quarterAverage(withQ4, q3, params, periodStart(q4) + DAY);
    expect(stored).toMatchObject({ ok: true, n: 66, avgWad: WAD, liveEnd: false });
    expect(withQ4.checkpoints.get(q4)!.count).toBe(66);
  });
  it("one snapshot per UTC day; the day check precedes validation", () => {
    const t = periodStart(q3) + 43_200n; // 1 July 2026 is a Wednesday
    const a = snapshot(newFxPairState(), t, WAD, null, params);
    expect(a.checkpointed).toBe(true);
    expect(() => snapshot(a.state, t + 1000n, WAD, null, params)).toThrow("SnapshotAlreadyTaken");
    expect(snapshot(a.state, t + DAY, WAD, null, params).checkpointed).toBe(false);
  });
  it("average of drifting rates with floor", () => {
    const rate = (d: number) => (108n * WAD) / 100n + BigInt(d) * 10n ** 15n;
    const s = run({ rate });
    let sum = 0n;
    let n = 0n;
    for (let d = 0; d < 92; d++) {
      if (!isTradingDay(periodStart(q3) + BigInt(d) * DAY + 43_200n)) continue;
      sum += rate(d);
      n++;
    }
    const r = quarterAverage(s, q3, params, periodEnd(q3) + 1n);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.avgWad).toBe(sum / n);
  });
  it("low coverage → NeedsFallback with the partial average still reported", () => {
    const s = run({ skip: (d) => d >= 70 }); // ~50 trading days
    const r = quarterAverage(s, q3, params, periodEnd(q3));
    expect(r.ok).toBe(false);
    expect(r.n).toBeLessThan(53);
    expect(r.avgWad).toBe(WAD);
    const ok = run({ skip: (d) => d >= 75 });
    expect(quarterAverage(ok, q3, params, periodEnd(q3)).ok).toBe(true);
  });
  it("missing start checkpoint, or a later period with snapshots but no checkpoint for p+1, → NeedsFallback", () => {
    const s = run({ from: 10 });
    expect(quarterAverage(s, q3 - 1, params, periodEnd(q3)).ok).toBe(false);
    // snapshots already exist in Q1 2027 but Q4 never got one: Q3's end checkpoint is missing and the live rule does not apply
    const skipQ4 = snapshot(s, periodStart(q4 + 1) + 43_200n, WAD, null, params).state;
    expect(quarterAverage(skipQ4, q3, params, periodStart(q4 + 1) + DAY).ok).toBe(false);
  });
  it("deviation flags the period being accumulated → NeedsFallback", () => {
    const s = run({ cross: (d) => (d === 40 ? (103n * WAD) / 100n : WAD) });
    expect(s.checkpoints.get(q3)!.flagged).toBe(true);
    const r = quarterAverage(s, q3, params, periodEnd(q3));
    expect(r.ok).toBe(false);
    expect(r.flagged).toBe(true);
    const clean = run({ cross: () => (102n * WAD) / 100n });
    expect(quarterAverage(clean, q3, params, periodEnd(q3)).ok).toBe(true);
  });
  it("snapshot result fields", () => {
    const now = timestampFromCivil(2026, 7, 1, 12);
    const r = snapshot(newFxPairState(), now, 3n * WAD, (31n * WAD) / 10n, params);
    expect(r).toMatchObject({ day: now / DAY, period: q3, rateWad: 3n * WAD, flagged: true, checkpointed: true });
  });
});
