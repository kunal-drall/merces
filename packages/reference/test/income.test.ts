import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { WAD } from "@merces/sdk";
import { expectedPaymentUsd } from "@merces/circuits";
import { owedYtd, paymentUsd, quarterPayment } from "../src/index.js";

const USDC = 1_000_000n;
const theta = 80_000n * USDC;
const rWad = WAD / 1000n; // 0.1% per unit
const units = 100n; // 10% total share

describe("year-to-date payment (brief C3)", () => {
  it("brief example: nothing until YTD income clears θ, then the increments", () => {
    const ytd = [30_000n, 70_000n, 110_000n, 160_000n].map((v) => v * USDC);
    const payments = ytd.map((inc, i) => quarterPayment(rWad, units, theta, inc, i === 0 ? 0n : ytd[i - 1]!));
    expect(payments).toEqual([0n, 0n, 3_000n * USDC, 5_000n * USDC]);
    expect(payments.reduce((a, b) => a + b, 0n)).toBe(((160_000n - 80_000n) * USDC) / 10n);
  });
  it("θ boundary", () => {
    expect(owedYtd(rWad, units, theta, theta)).toBe(0n);
    expect(owedYtd(rWad, units, theta + 1n, theta)).toBe((rWad * units) / WAD); // floor(1e17 / 1e18) = 0
    expect(owedYtd(WAD / 50n, 100n, theta + 1n, theta)).toBe(2n);
    expect(owedYtd(rWad, units, theta + 10n * USDC, theta)).toBe(1n * USDC);
  });
  it("fx applies with floor rounding and matches the circuit helper", () => {
    const fx = 1_083_456_789_012_345_678n;
    const args = { rWad, unitsOutstanding: units, theta, incomeYtd: 110_000n * USDC, priorIncomeYtd: 70_000n * USDC, fxAvgWad: fx };
    expect(paymentUsd(args)).toBe((3_000n * USDC * fx) / WAD);
    expect(paymentUsd(args)).toBe(expectedPaymentUsd(args));
    expect(paymentUsd({ ...args, fxAvgWad: WAD })).toBe(3_000n * USDC);
  });
  it("rejects non-monotone income and out-of-range inputs", () => {
    expect(() => quarterPayment(rWad, units, theta, 1n, 2n)).toThrow(RangeError);
    expect(() => owedYtd(1n << 64n, units, 1n, 0n)).toThrow(RangeError);
  });
  it("property: payments are non-negative, YTD-additive and agree with the circuit helper", () => {
    const u64 = fc.bigInt({ min: 0n, max: (1n << 40n) - 1n });
    fc.assert(
      fc.property(u64, u64, u64, fc.bigInt({ min: 1n, max: 10_000n }), fc.bigInt({ min: 0n, max: WAD / 100n }), fc.bigInt({ min: 1n, max: 3n * WAD }), (a, b, th, n, r, fx) => {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const p = quarterPayment(r, n, th, hi, lo);
        expect(p >= 0n).toBe(true);
        expect(owedYtd(r, n, lo, th) + p).toBe(owedYtd(r, n, hi, th));
        const args = { rWad: r, unitsOutstanding: n, theta: th, incomeYtd: hi, priorIncomeYtd: lo, fxAvgWad: fx };
        expect(paymentUsd(args)).toBe(expectedPaymentUsd(args));
      }),
      { numRuns: 300 },
    );
  });
});
