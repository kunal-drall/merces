import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { WAD, YEAR, newYearGross, yearGrossAdd } from "@merces/sdk";
import { averageAnnualGross, finalDistribute, hurdlePrice, newFinalState, newTailState, redemptionQuote, tailReceive } from "../src/index.js";

const USDC = 1_000_000n;
const h = (8n * WAD) / 100n;
const ring = (values: bigint[]) => values.reduce((r, v, i) => yearGrossAdd(r, i, v), newYearGross());

describe("hurdle price (brief C7)", () => {
  it("P0 × (1+h)^floor(t) × (1 + h × frac(t)) with floor rounding at each step", () => {
    expect(hurdlePrice(1n * USDC, h, 0n).pHurdle).toBe(1n * USDC);
    expect(hurdlePrice(1n * USDC, h, YEAR).pHurdle).toBe(1_080_000n);
    expect(hurdlePrice(1n * USDC, h, 2n * YEAR).pHurdle).toBe(1_166_400n);
    const half = hurdlePrice(1n * USDC, h, YEAR + YEAR / 2n);
    expect(half.pHurdle).toBe(1_123_200n);
    expect(() => hurdlePrice(1n, h, -1n)).toThrow(RangeError);
  });
});

describe("D_avg from the tagged ring", () => {
  it("omitted under one full year; trailing min(Y, 3) full years; evicted years read as 0", () => {
    const yg = ring([100n * WAD, 200n * WAD, 300n * WAD, 400n * WAD]);
    expect(averageAnnualGross(yg, 0n)).toBeNull();
    expect(averageAnnualGross(yg, 1n)).toBe(100n);
    expect(averageAnnualGross(yg, 2n)).toBe(150n);
    expect(averageAnnualGross(yg, 3n)).toBe(200n);
    expect(averageAnnualGross(yg, 4n)).toBe(300n);
    expect(averageAnnualGross(newYearGross(), 2n)).toBe(0n);
    const five = yearGrossAdd(yg, 4, 500n * WAD); // year 0 evicted
    expect(averageAnnualGross(five, 5n)).toBe(400n); // years 2,3,4
    expect(averageAnnualGross(five, 1n)).toBe(0n); // year 0 gone
  });
});

describe("redemption price: each term can decide; C_rem saturates", () => {
  const base = { p0: 1n * USDC, hurdleRateWad: h, payoutMultipleK: 5, capPerUnit: 2_500_000n, unitsOutstanding: 1000n };
  it("hurdle decides", () => {
    const q = redemptionQuote({ ...base, t: YEAR + YEAR / 2n, paidPerUnitWad: 50_000n * WAD, yearGross: ring([50_000n * WAD]) });
    expect(q).toMatchObject({ pHurdle: 1_123_200n, dAvg: 50_000n, pRedeem: 1_123_200n, cRemaining: 2_450_000n, decidedBy: "hurdle", deposit: 1_123_200n * 1000n, tailCapPerUnit: 2_450_000n - 1_123_200n });
  });
  it("payout multiple decides, capped by the remaining cap", () => {
    const yg = ring([300_000n * WAD, 500_000n * WAD]);
    const q = redemptionQuote({ ...base, t: 2n * YEAR, paidPerUnitWad: 800_000n * WAD, yearGross: yg });
    expect(q).toMatchObject({ dAvg: 400_000n, floorTerm: 2_000_000n, cRemaining: 1_700_000n, pRedeem: 1_700_000n, decidedBy: "cap_remaining" });
    const q2 = redemptionQuote({ ...base, capPerUnit: 3_000_000n, t: 2n * YEAR, paidPerUnitWad: 800_000n * WAD, yearGross: yg });
    expect(q2).toMatchObject({ pRedeem: 2_000_000n, decidedBy: "payout_multiple" });
  });
  it("remaining cap decides; a lowered cap below what was paid saturates C_rem at 0", () => {
    const q = redemptionQuote({ ...base, t: 3n * YEAR, paidPerUnitWad: 2_400_000n * WAD + 1n, yearGross: ring([800_000n * WAD, 800_000n * WAD, 800_000n * WAD]) });
    expect(q).toMatchObject({ paidUnits: 2_400_001n, cRemaining: 99_999n, pRedeem: 99_999n, decidedBy: "cap_remaining", tailCapPerUnit: 0n });
    const z = redemptionQuote({ ...base, capPerUnit: 2_000_000n, t: 2n * YEAR, paidPerUnitWad: 2_400_000n * WAD, yearGross: newYearGross() });
    expect(z.cRemaining).toBe(0n);
    expect(z.pRedeem).toBe(0n);
    expect(z.deposit).toBe(0n);
  });
  it("property: P_redeem ≤ C_rem, ≥ min(C_rem, P_hurdle), tail cap = C_rem − P_redeem, payments + redemption ≤ cap", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n * USDC }), fc.bigInt({ min: 0n, max: 10n * YEAR }), fc.bigInt({ min: 0n, max: 30n * USDC }), fc.array(fc.bigInt({ min: 0n, max: 3n * USDC }), { maxLength: 6 }), (p0, t, paidUnits, yg) => {
        const cap = (p0 * 25n) / 10n;
        const q = redemptionQuote({ p0, hurdleRateWad: h, payoutMultipleK: 5, t, capPerUnit: cap, paidPerUnitWad: paidUnits * WAD, yearGross: ring(yg.map((v) => v * WAD)), unitsOutstanding: 7n });
        expect(q.pRedeem <= q.cRemaining).toBe(true);
        expect(q.pRedeem >= (q.cRemaining < q.pHurdle ? q.cRemaining : q.pHurdle)).toBe(true);
        expect(q.tailCapPerUnit).toBe(q.cRemaining - q.pRedeem);
        expect(q.deposit).toBe(q.pRedeem * 7n);
        if (paidUnits <= cap) expect(q.pRedeem + q.paidUnits <= cap).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe("tail clause (SPEC v1.1 §6.8): `<` boundary, tail_exhausted, own carry", () => {
  it("accepts below the cap, truncates at or above it and marks the tail exhausted", () => {
    const s0 = newTailState(1_000_000n);
    const a = tailReceive(s0, 100n * USDC, 1000n, 500);
    expect(a.result).toEqual({ accepted: 100n * USDC, refund: 0n, fee: 5n * USDC, deltaAccWad: 95_000n * WAD, exhausted: false });
    const b = tailReceive(a.state, 950n * USDC, 1000n, 500);
    expect(b.result).toMatchObject({ accepted: 900n * USDC, refund: 50n * USDC, fee: 45n * USDC, exhausted: true });
    expect(b.state.tailPaidPerUnitWad).toBe(1_000_000n * WAD);
    expect(b.state.tailExhausted).toBe(true);
    // exactly reaching the cap also exhausts (same `<` rule as §6.3)
    const c = tailReceive(a.state, 900n * USDC, 1000n, 500);
    expect(c.result).toMatchObject({ refund: 0n, exhausted: true });
    const d = tailReceive(b.state, 10n * USDC, 1000n, 500);
    expect(d.result).toMatchObject({ accepted: 0n, refund: 10n * USDC, fee: 0n, exhausted: true });
    expect(() => tailReceive(s0, 1n, 0n, 500)).toThrow("NoUnitsOutstanding");
  });
});

describe("extinguishment distribution (SPEC v1.1 §6.9)", () => {
  it("no fee, own carry, records final_units; nothing to distribute when unreleased or units are 0", () => {
    const a = finalDistribute(newFinalState(), 100n, 7n);
    expect(a.deltaAccWad).toBe((100n * WAD) / 7n);
    expect(a.state.finalCarryWad).toBe(100n * WAD - ((100n * WAD) / 7n) * 7n);
    expect(a.state.finalUnits).toBe(7n);
    expect(a.state.unreleasedDistributed).toBe(100n);
    expect(finalDistribute(newFinalState(), 0n, 7n)).toMatchObject({ deltaAccWad: 0n, state: { finalUnits: 7n, finalAccWad: 0n } });
    expect(finalDistribute(newFinalState(), 100n, 0n)).toMatchObject({ deltaAccWad: 0n, state: { finalUnits: 0n } });
  });
});
