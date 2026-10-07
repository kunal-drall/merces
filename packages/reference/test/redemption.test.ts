import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { WAD, YEAR } from "@merces/sdk";
import { averageAnnualGross, finalDistribute, hurdlePrice, newTailState, redemptionQuote, tailReceive } from "../src/index.js";

const USDC = 1_000_000n;
const h = (8n * WAD) / 100n;

describe("hurdle price (brief C7)", () => {
  it("P0 × (1+h)^floor(t) × (1 + h × frac(t)) with floor rounding at each step", () => {
    expect(hurdlePrice(1n * USDC, h, 0n).pHurdle).toBe(1n * USDC);
    expect(hurdlePrice(1n * USDC, h, YEAR).pHurdle).toBe(1_080_000n);
    expect(hurdlePrice(1n * USDC, h, 2n * YEAR).pHurdle).toBe(1_166_400n);
    const half = hurdlePrice(1n * USDC, h, YEAR + YEAR / 2n);
    expect(half.years).toBe(1n);
    expect(half.fracWad).toBe(WAD / 2n);
    expect(half.pHurdle).toBe(1_123_200n); // 1.08 × 1.04
    // 18 months = 547.875 days → frac = 182.875 / 365
    const lockup = hurdlePrice(1n * USDC, h, 47_336_400n);
    expect(lockup.fracWad).toBe(((47_336_400n - YEAR) * WAD) / YEAR);
    expect(lockup.pHurdle).toBe((1_080_000n * (WAD + (h * lockup.fracWad) / WAD)) / WAD);
    expect(() => hurdlePrice(1n, h, -1n)).toThrow(RangeError);
  });
});

describe("D_avg", () => {
  it("omitted under one full year; trailing min(Y, 3) full years", () => {
    const yg = [100n * WAD, 200n * WAD, 300n * WAD, 400n * WAD];
    expect(averageAnnualGross(yg, 0n)).toBeNull();
    expect(averageAnnualGross(yg, 1n)).toBe(100n);
    expect(averageAnnualGross(yg, 2n)).toBe(150n);
    expect(averageAnnualGross(yg, 3n)).toBe(200n);
    expect(averageAnnualGross(yg, 4n)).toBe(300n); // years 1..3
    expect(averageAnnualGross([], 2n)).toBe(0n);
    expect(averageAnnualGross([1n], 1n)).toBe(0n); // floor(1 / WAD)
  });
});

describe("redemption price: each term can decide", () => {
  const base = { p0: 1n * USDC, hurdleRateWad: h, payoutMultipleK: 5, capPerUnit: 2_500_000n, unitsOutstanding: 1000n };
  it("hurdle decides (little paid, low D_avg)", () => {
    const q = redemptionQuote({ ...base, t: YEAR + YEAR / 2n, paidPerUnitWad: 50_000n * WAD, yearGrossWad: [50_000n * WAD] });
    expect(q.pHurdle).toBe(1_123_200n);
    expect(q.dAvg).toBe(50_000n);
    expect(q.floorTerm).toBe(1_123_200n);
    expect(q.cRemaining).toBe(2_450_000n);
    expect(q.pRedeem).toBe(1_123_200n);
    expect(q.decidedBy).toBe("hurdle");
    expect(q.deposit).toBe(1_123_200n * 1000n);
    expect(q.tailCapPerUnit).toBe(2_450_000n - 1_123_200n);
  });
  it("payout multiple decides (high average payments)", () => {
    const q = redemptionQuote({ ...base, t: 2n * YEAR, paidPerUnitWad: 800_000n * WAD, yearGrossWad: [300_000n * WAD, 500_000n * WAD] });
    expect(q.dAvg).toBe(400_000n);
    expect(q.floorTerm).toBe(2_000_000n);
    expect(q.cRemaining).toBe(1_700_000n);
    expect(q.pRedeem).toBe(1_700_000n); // capped by remaining cap
    expect(q.decidedBy).toBe("cap_remaining");
    const q2 = redemptionQuote({ ...base, capPerUnit: 3_000_000n, t: 2n * YEAR, paidPerUnitWad: 800_000n * WAD, yearGrossWad: [300_000n * WAD, 500_000n * WAD] });
    expect(q2.pRedeem).toBe(2_000_000n);
    expect(q2.decidedBy).toBe("payout_multiple");
  });
  it("remaining cap decides and the tail is then zero", () => {
    const q = redemptionQuote({ ...base, t: 3n * YEAR, paidPerUnitWad: 2_400_000n * WAD + 1n, yearGrossWad: [800_000n * WAD, 800_000n * WAD, 800_000n * WAD] });
    expect(q.paidUnits).toBe(2_400_001n); // ceil favours the issuer
    expect(q.cRemaining).toBe(99_999n);
    expect(q.pRedeem).toBe(99_999n);
    expect(q.decidedBy).toBe("cap_remaining");
    expect(q.tailCapPerUnit).toBe(0n);
  });
  it("under one year only the hurdle counts", () => {
    const q = redemptionQuote({ ...base, t: YEAR - 1n, paidPerUnitWad: 0n, yearGrossWad: [10n ** 30n] });
    expect(q.dAvg).toBeNull();
    expect(q.decidedBy).toBe("hurdle");
  });
  it("property: P_redeem ≤ C_rem, P_redeem ≥ min(C_rem, P_hurdle), tail cap = C_rem − P_redeem", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n * USDC }), fc.bigInt({ min: 0n, max: 10n * YEAR }), fc.bigInt({ min: 0n, max: 25n * USDC }), fc.array(fc.bigInt({ min: 0n, max: 3n * USDC }), { maxLength: 12 }), (p0, t, paidUnits, yg) => {
        const cap = (p0 * 25n) / 10n;
        const paid = paidUnits * WAD > cap * WAD ? cap * WAD : paidUnits * WAD;
        const q = redemptionQuote({ p0, hurdleRateWad: h, payoutMultipleK: 5, t, capPerUnit: cap, paidPerUnitWad: paid, yearGrossWad: yg.map((v) => v * WAD), unitsOutstanding: 7n });
        expect(q.pRedeem <= q.cRemaining).toBe(true);
        expect(q.pRedeem >= (q.cRemaining < q.pHurdle ? q.cRemaining : q.pHurdle)).toBe(true);
        expect(q.tailCapPerUnit).toBe(q.cRemaining - q.pRedeem);
        expect(q.deposit).toBe(q.pRedeem * 7n);
        expect(q.pRedeem + q.paidUnits <= cap).toBe(true); // invariant C6: payments + redemption ≤ C
      }),
      { numRuns: 300 },
    );
  });
});

describe("tail clause (SPEC §6.8)", () => {
  it("accepts up to the tail cap, refunds the rest, 5% fee, own accumulator", () => {
    const s0 = newTailState(1_000_000n);
    const a = tailReceive(s0, 100n * USDC, 1000n, 500);
    expect(a.result).toEqual({ accepted: 100n * USDC, refund: 0n, fee: 5n * USDC, deltaAccWad: 95_000n * WAD });
    expect(a.state.tailPaidPerUnitWad).toBe(100_000n * WAD);
    // 1,000 units × 1 USDC cap = 1,000 USDC total tail; 950 more would exceed by 50
    const b = tailReceive(a.state, 950n * USDC, 1000n, 500);
    expect(b.result).toMatchObject({ accepted: 900n * USDC, refund: 50n * USDC, fee: 45n * USDC });
    expect(b.state.tailPaidPerUnitWad).toBe(1_000_000n * WAD);
    // exactly reaching the cap is accepted in full (strict > in the spec)
    const c = tailReceive(a.state, 900n * USDC, 1000n, 500);
    expect(c.result.refund).toBe(0n);
    expect(() => tailReceive(s0, 1n, 0n, 500)).toThrow("NoUnitsOutstanding");
  });
});

describe("extinguishment distribution (SPEC §6.9)", () => {
  it("no fee, carry as usual", () => {
    const a = finalDistribute({ finalAccWad: 0n, finalCarryWad: 0n, unreleasedDistributed: 0n }, 100n, 7n);
    expect(a.deltaAccWad).toBe((100n * WAD) / 7n);
    expect(a.state.finalCarryWad).toBe(100n * WAD - ((100n * WAD) / 7n) * 7n);
    expect(a.state.unreleasedDistributed).toBe(100n);
    const z = finalDistribute(a.state, 0n, 7n);
    expect(z.state).toBe(a.state);
  });
});
