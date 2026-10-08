import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { WAD, periodId, timestampFromCivil } from "@merces/sdk";
import { closeRouterPeriod, newRouterState, routeIncome, ytdAtEnd } from "../src/index.js";

const USDC = 1_000_000n;
const ts = timestampFromCivil;
const q = (y: number, n: number) => periodId(y, n);
const r0 = newRouterState(usdc(80_000), WAD / 10_000n, q(2026, 1));
function usdc(n: number): bigint {
  return BigInt(n) * USDC;
}

describe("tier-1 split router (SPEC v1.1 §6.5)", () => {
  it("passes 100% through below θ, then mulDiv(above, r × units, WAD)", () => {
    const a = routeIncome(r0, usdc(50_000), 100n, ts(2026, 2, 10));
    expect(a).toMatchObject({ passThrough: usdc(50_000), share: 0n });
    const b = routeIncome(a.state, usdc(50_000), 100n, ts(2026, 3, 10));
    expect(b.share).toBe(usdc(200)); // 20,000 above θ × 1%
    expect(b.passThrough).toBe(usdc(49_800));
    expect(b.state.ytdReceived).toBe(usdc(100_000));
  });
  it("closes period checkpoints when a receipt arrives in a later period and on close_router_period", () => {
    const a = routeIncome(r0, usdc(90_000), 100n, ts(2026, 3, 10));
    expect(a.state.checkpoints).toEqual([]);
    const b = routeIncome(a.state, usdc(10_000), 100n, ts(2026, 5, 12)); // Q2 receipt closes Q1
    expect(ytdAtEnd(b.state, q(2026, 1))).toBe(usdc(90_000));
    expect(ytdAtEnd(b.state, q(2026, 2))).toBeNull();
    const c = closeRouterPeriod(b.state, q(2026, 2));
    expect(ytdAtEnd(c, q(2026, 2))).toBe(usdc(100_000));
    const d = closeRouterPeriod(c, q(2026, 4)); // Q3 (no receipts) and Q4 hold the year total
    expect(ytdAtEnd(d, q(2026, 3))).toBe(usdc(100_000));
    expect(ytdAtEnd(d, q(2026, 4))).toBe(usdc(100_000));
    const e = routeIncome(d, usdc(5_000), 100n, ts(2027, 5, 2)); // 2027 Q2 receipt closes 2027 Q1 with 0 (new year)
    expect(ytdAtEnd(e.state, q(2027, 1))).toBe(0n);
    expect(e.state.ytdReceived).toBe(usdc(5_000));
    expect(e.passThrough).toBe(usdc(5_000));
    // ring keeps the last 8 checkpoints
    const f = closeRouterPeriod(e.state, q(2028, 4));
    expect(f.checkpoints.length).toBe(8);
    expect(ytdAtEnd(f, q(2026, 1))).toBeNull();
    expect(ytdAtEnd(f, q(2028, 4))).toBe(0n);
  });
  it("share never exceeds the above-threshold part", () => {
    const big = { ...r0, rWad: WAD, ytdReceived: r0.theta };
    const a = routeIncome(big, 1_000n, 5n, ts(2026, 2, 1));
    expect(a.share).toBe(1_000n);
    expect(a.passThrough).toBe(0n);
  });
  it("property: pass-through + share == amount; share ≤ above; ytd accumulates", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1n << 50n }), fc.bigInt({ min: 0n, max: 1n << 50n }), fc.bigInt({ min: 0n, max: 1n << 50n }), fc.bigInt({ min: 1n, max: 10_000n }), fc.bigInt({ min: 0n, max: WAD / 10_000n }), (theta, ytd, amount, units, r) => {
        const s = { ...newRouterState(theta, r, q(2026, 1)), ytdReceived: ytd };
        const out = routeIncome(s, amount, units, ts(2026, 2, 1));
        expect(out.passThrough + out.share).toBe(amount);
        const below = theta > ytd ? theta - ytd : 0n;
        const above = amount - (amount < below ? amount : below);
        expect(out.share <= above).toBe(true);
        expect(out.state.ytdReceived).toBe(ytd + amount);
      }),
      { numRuns: 300 },
    );
  });
});
