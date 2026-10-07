import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { WAD } from "@merces/sdk";
import { routeIncome, type RouterState } from "../src/index.js";

const USDC = 1_000_000n;
const r0: RouterState = { theta: 80_000n * USDC, rWad: WAD / 1000n, ytdYear: 2026, ytdReceived: 0n };

describe("tier-1 split router (SPEC §6.5)", () => {
  it("passes 100% through below θ, then r × units of each receipt", () => {
    const a = routeIncome(r0, 50_000n * USDC, 100n, 2026);
    expect(a).toMatchObject({ passThrough: 50_000n * USDC, share: 0n });
    expect(a.state.ytdReceived).toBe(50_000n * USDC);
    const b = routeIncome(a.state, 50_000n * USDC, 100n, 2026);
    // 30k below θ passes; 20k above → 10% = 2k
    expect(b.share).toBe(2_000n * USDC);
    expect(b.passThrough).toBe(48_000n * USDC);
    const c = routeIncome(b.state, 10_000n * USDC, 100n, 2026);
    expect(c.share).toBe(1_000n * USDC);
  });
  it("resets at a new year", () => {
    const a = routeIncome({ ...r0, ytdReceived: 200_000n * USDC }, 10_000n * USDC, 100n, 2026);
    expect(a.share).toBe(1_000n * USDC);
    const b = routeIncome({ ...r0, ytdReceived: 200_000n * USDC }, 10_000n * USDC, 100n, 2027);
    expect(b.share).toBe(0n);
    expect(b.state).toEqual({ ...r0, ytdYear: 2027, ytdReceived: 10_000n * USDC });
  });
  it("share never exceeds the above-threshold part", () => {
    const big = { ...r0, rWad: WAD, ytdReceived: r0.theta };
    const a = routeIncome(big, 1_000n, 5n, 2026); // r × units = 5 → 500%
    expect(a.share).toBe(1_000n);
    expect(a.passThrough).toBe(0n);
  });
  it("property: pass-through + share == amount; share ≤ above; ytd accumulates", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1n << 50n }), fc.bigInt({ min: 0n, max: 1n << 50n }), fc.bigInt({ min: 0n, max: 1n << 50n }), fc.bigInt({ min: 1n, max: 10_000n }), fc.bigInt({ min: 0n, max: WAD }), (theta, ytd, amount, units, r) => {
        const s = { theta, rWad: r, ytdYear: 2026, ytdReceived: ytd };
        const out = routeIncome(s, amount, units, 2026);
        expect(out.passThrough + out.share).toBe(amount);
        const above = amount - (amount < (theta > ytd ? theta - ytd : 0n) ? amount : theta > ytd ? theta - ytd : 0n);
        expect(out.share <= above).toBe(true);
        expect(out.state.ytdReceived).toBe(ytd + amount);
      }),
      { numRuns: 300 },
    );
  });
});
