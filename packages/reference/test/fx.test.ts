import { describe, it, expect } from "vitest";
import { DAY, WAD, periodId, periodStart, timestampFromCivil } from "@merces/sdk";
import { deviates, invertRate, newFxPairState, normalizePythPrice, quarterAverage, snapshot, snapshotsNeeded, validatePythPrice, type FxPairState } from "../src/index.js";

const params = { fxMaxStalenessSeconds: 3600n, fxMaxConfBps: 100, fxDeviationBandBps: 200, fxMinCoverageBps: 8000 };

describe("Pyth normalization and validation (SPEC §6.6)", () => {
  it("rate_wad = price × 10^(18 + expo)", () => {
    expect(normalizePythPrice(108_345_678n, -8)).toBe(1_083_456_780_000_000_000n);
    expect(normalizePythPrice(108_345n, -5)).toBe(1_083_450_000_000_000_000n);
    expect(normalizePythPrice(5n, 0)).toBe(5n * WAD);
    expect(normalizePythPrice(123_456_789_012_345_678_901n, -20)).toBe(1_234_567_890_123_456_789n); // floor
    expect(() => normalizePythPrice(0n, -8)).toThrow(RangeError);
  });
  it("inverted pairs", () => {
    expect(invertRate(2n * WAD)).toBe(WAD / 2n);
    expect(invertRate(150_000_000_000_000_000_000n)).toBe(6_666_666_666_666_666n); // USD/JPY 150 → JPY/USD
  });
  it("staleness and confidence", () => {
    const now = 1_000_000n;
    expect(validatePythPrice({ price: 100n, conf: 1n, expo: -2, publishTime: now - 3600n }, now, params)).toBeNull();
    expect(validatePythPrice({ price: 100n, conf: 1n, expo: -2, publishTime: now - 3601n }, now, params)).toBe("StalePrice");
    expect(validatePythPrice({ price: 10_000n, conf: 100n, expo: -2, publishTime: now }, now, params)).toBeNull(); // 1% exactly
    expect(validatePythPrice({ price: 10_000n, conf: 101n, expo: -2, publishTime: now }, now, params)).toBe("ConfidenceTooWide");
    expect(validatePythPrice({ price: 0n, conf: 0n, expo: -2, publishTime: now }, now, params)).toBe("NonPositivePrice");
  });
  it("deviation band", () => {
    expect(deviates(102n * WAD, 100n * WAD, 200)).toBe(false);
    expect(deviates(102n * WAD + 1n, 100n * WAD, 200)).toBe(true);
    expect(deviates(98n * WAD, 100n * WAD, 200)).toBe(false);
    expect(deviates(97n * WAD, 100n * WAD, 200)).toBe(true);
  });
});

describe("accumulator and quarter averages", () => {
  const q3 = periodId(2026, 3); // 92 days
  const q4 = periodId(2026, 4);

  function run(days: number, rate: (d: number) => bigint, opts: { crosscheck?: (d: number) => bigint | null; startOffset?: number } = {}): FxPairState {
    let s = newFxPairState();
    const start = periodStart(q3) + BigInt(opts.startOffset ?? 0) * DAY;
    for (let d = 0; d < days; d++) {
      const now = start + BigInt(d) * DAY + 43_200n;
      s = snapshot(s, now, rate(d), opts.crosscheck ? opts.crosscheck(d) : null, params).state;
    }
    return s;
  }

  it("one snapshot per UTC day", () => {
    const s = newFxPairState();
    const t = periodStart(q3) + 100n;
    const a = snapshot(s, t, WAD, null, params);
    expect(a.checkpointed).toBe(true);
    expect(() => snapshot(a.state, t + 1000n, WAD, null, params)).toThrow("SnapshotAlreadyTaken");
    expect(snapshot(a.state, t + DAY, WAD, null, params).checkpointed).toBe(false);
  });
  it("coverage: 92-day quarter needs 74 snapshots; checkpoints close the period", () => {
    expect(snapshotsNeeded(q3, 8000)).toBe(74);
    expect(snapshotsNeeded(periodId(2026, 1), 8000)).toBe(72);
    const full = run(93, (d) => (108n * WAD) / 100n + BigInt(d) * 10n ** 15n); // 92 in Q3 + 1 in Q4 closes Q3
    const avg = quarterAverage(full, q3, params);
    expect(avg.ok).toBe(true);
    if (avg.ok) {
      expect(avg.n).toBe(92);
      let sum = 0n;
      for (let d = 0; d < 92; d++) sum += (108n * WAD) / 100n + BigInt(d) * 10n ** 15n;
      expect(avg.avgWad).toBe(sum / 92n);
    }
    // the first snapshot in Q4 created the Q4 checkpoint holding Q3's closing sums
    expect(full.checkpoints.get(q4)!.count).toBe(92);
    expect(full.checkpoints.get(q3)!.count).toBe(0);
  });
  it("missing next-period checkpoint → NeedsFallback", () => {
    const s = run(92, () => WAD);
    const r = quarterAverage(s, q3, params);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "NeedsFallback", n: 0, avgWad: null });
  });
  it("low coverage → NeedsFallback with the partial average still reported", () => {
    const s = run(74, () => WAD, { startOffset: 19 }); // 73 days inside Q3 (d=0..72), 1 in Q4
    const r = quarterAverage(s, q3, params);
    expect(r.ok).toBe(false);
    expect(r.n).toBe(73);
    expect(r.avgWad).toBe(WAD);
    const ok = run(75, () => WAD, { startOffset: 18 }); // 74 inside Q3
    expect(quarterAverage(ok, q3, params).ok).toBe(true);
  });
  it("deviation flags the period being accumulated → NeedsFallback", () => {
    const s = run(93, () => WAD, { crosscheck: (d) => (d === 40 ? (103n * WAD) / 100n : WAD) });
    expect(s.checkpoints.get(q3)!.flagged).toBe(true);
    expect(s.checkpoints.get(q4)!.flagged).toBe(false);
    const r = quarterAverage(s, q3, params);
    expect(r.ok).toBe(false);
    expect(r.flagged).toBe(true);
    const clean = run(93, () => WAD, { crosscheck: () => (102n * WAD) / 100n });
    expect(quarterAverage(clean, q3, params).ok).toBe(true);
  });
  it("snapshot result fields", () => {
    const now = timestampFromCivil(2026, 7, 1, 12);
    const r = snapshot(newFxPairState(), now, 3n * WAD, (31n * WAD) / 10n, params); // 3.2% off → flagged
    expect(r).toMatchObject({ day: now / DAY, period: q3, rateWad: 3n * WAD, flagged: true, checkpointed: true });
  });
});
