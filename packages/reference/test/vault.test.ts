import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { WAD } from "@merces/sdk";
import { accumulate, capPerUnit, newVaultState, settleHolderDelta, vaultReceiveGross, type VaultState } from "../src/index.js";

const USDC = 1_000_000n;

describe("payout vault (SPEC §6.3, brief C6)", () => {
  it("cap_per_unit = floor(m × P0 / WAD)", () => {
    expect(capPerUnit(2_500_000_000_000_000_000n, 1n * USDC)).toBe(2_500_000n);
    expect(capPerUnit(2_500_000_000_000_000_000n, 3n)).toBe(7n);
  });
  it("simple distribution: 5% fee, accumulator in WAD", () => {
    const s0 = newVaultState(2_500_000n);
    const { state, result } = vaultReceiveGross(s0, 1n * USDC, 100n, 500, 0);
    expect(result).toEqual({ accepted: 1n * USDC, refund: 0n, incWad: 10_000n * WAD, fee: 50_000n, netAdded: 950_000n, deltaAccWad: 9_500n * WAD, carryWad: 0n, retired: false });
    expect(state.paidPerUnitWad).toBe(10_000n * WAD);
    expect(state.netAccWad).toBe(9_500n * WAD);
    expect(state.yearGrossWad).toEqual([10_000n * WAD]);
    expect(settleHolderDelta(state.netAccWad, 0n, 10n)).toBe(95_000n);
  });
  it("carry keeps the exact remainder and rolls it forward", () => {
    const s0 = newVaultState(1_000_000n);
    const a = vaultReceiveGross(s0, 100n, 7n, 500, 0);
    expect(a.result.fee).toBe(5n);
    expect(a.result.deltaAccWad).toBe((95n * WAD) / 7n); // 13571428571428571428
    expect(a.result.carryWad).toBe(95n * WAD - 13_571_428_571_428_571_428n * 7n); // 4
    const b = vaultReceiveGross(a.state, 100n, 7n, 500, 0);
    expect(b.result.netAdded).toBe(95n);
    expect(b.result.deltaAccWad).toBe((95n * WAD + 4n) / 7n); // 13571428571428571429
    expect(b.result.carryWad).toBe(1n);
    expect(b.state.grossReceived).toBe(200n);
    expect(b.state.feeCollected).toBe(10n);
    // a single holder of all 7 units can claim 189 of the 190 net units; 1 unit of rounding dust stays
    expect(settleHolderDelta(b.state.netAccWad, 0n, 7n)).toBe(189n);
  });
  it("the spec's base-unit carry would let holders over-claim (SPEC defect S1)", () => {
    // N = 3, three net payments of 1: spec formula gives acc = 1666666666666666665 → claim 4 of a 3-unit vault
    let acc = 0n;
    let carry = 0n;
    for (let i = 0; i < 3; i++) {
      const net = 1n + carry;
      const delta = (net * WAD) / 3n;
      const distributed = (delta * 3n) / WAD;
      carry = net - distributed;
      acc += delta;
    }
    expect((acc * 3n) / WAD).toBe(4n);
    // exact remainder: never more than the vault
    let s = newVaultState(1_000_000n);
    for (let i = 0; i < 3; i++) s = vaultReceiveGross(s, 1n, 3n, 0, 0).state;
    expect(settleHolderDelta(s.netAccWad, 0n, 3n)).toBe(3n);
    expect(s.carryWad).toBe(3n * WAD - s.netAccWad * 3n);
    expect(s.carryWad).toBe(0n);
  });
  it("cap hit: truncates, refunds the issuer, retires", () => {
    const s0 = newVaultState(250n); // P0 = 100, m = 2.5
    const a = vaultReceiveGross(s0, 2000n, 10n, 500, 0);
    expect(a.result.retired).toBe(false);
    expect(a.state.paidPerUnitWad).toBe(200n * WAD);
    const b = vaultReceiveGross(a.state, 600n, 10n, 500, 1);
    expect(b.result).toMatchObject({ accepted: 500n, refund: 100n, incWad: 50n * WAD, fee: 25n, retired: true });
    expect(b.state.paidPerUnitWad).toBe(250n * WAD);
    expect(b.state.retired).toBe(true);
    expect(b.state.refundedToIssuer).toBe(100n);
    expect(b.state.yearGrossWad).toEqual([200n * WAD, 50n * WAD]);
  });
  it("reaching the cap exactly retires without a refund", () => {
    const s0 = newVaultState(250n);
    const a = vaultReceiveGross(s0, 2000n, 10n, 500, 0);
    const b = vaultReceiveGross(a.state, 500n, 10n, 500, 0);
    expect(b.result).toMatchObject({ accepted: 500n, refund: 0n, retired: true });
    expect(b.state.paidPerUnitWad).toBe(250n * WAD);
  });
  it("zero units outstanding reverts; zero gross is a no-op distribution", () => {
    expect(() => vaultReceiveGross(newVaultState(1n), 1n, 0n, 500, 0)).toThrow("NoUnitsOutstanding");
    const z = vaultReceiveGross(newVaultState(100n), 0n, 10n, 500, 0);
    expect(z.result).toMatchObject({ accepted: 0n, fee: 0n, deltaAccWad: 0n, retired: false });
  });
  it("accumulate (tail/final) shares the carry logic", () => {
    const a = accumulate(0n, 0n, 95n, 7n);
    expect(a.deltaAccWad).toBe((95n * WAD) / 7n);
    expect(a.carryWad).toBe(4n);
    expect(a.accWad * 7n + a.carryWad).toBe(95n * WAD);
    expect(() => accumulate(0n, 0n, 1n, 0n)).toThrow("NoUnitsOutstanding");
  });

  it("property (F2): no unit over cap; Σ accepted + Σ refund == Σ G; fees exact; claims ≤ distributed ≤ vault; accumulators monotone", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000n }),
        fc.bigInt({ min: 1n, max: 10n * USDC }),
        fc.array(fc.bigInt({ min: 0n, max: 100n * USDC }), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 2000 }),
        (N, cap, payments, feeBps) => {
          let s: VaultState = newVaultState(cap);
          let sumG = 0n;
          let sumAccepted = 0n;
          let sumRefund = 0n;
          let sumFee = 0n;
          let sumNet = 0n;
          let prevPaid = 0n;
          let prevAcc = 0n;
          // three holders splitting N
          const a = N / 3n;
          const b = N / 3n;
          const c = N - a - b;
          for (const [i, G] of payments.entries()) {
            if (s.retired) break;
            const { state, result } = vaultReceiveGross(s, G, N, feeBps, i % 3);
            s = state;
            sumG += G;
            sumAccepted += result.accepted;
            sumRefund += result.refund;
            sumFee += result.fee;
            sumNet += result.netAdded;
            expect(result.fee).toBe((result.accepted * BigInt(feeBps)) / 10_000n);
            expect(s.paidPerUnitWad <= cap * WAD).toBe(true);
            expect(s.paidPerUnitWad >= prevPaid).toBe(true);
            expect(s.netAccWad >= prevAcc).toBe(true);
            expect(result.carryWad < N).toBe(true);
            expect(s.netAccWad * N + s.carryWad).toBe((s.grossReceived - s.feeCollected) * WAD);
            prevPaid = s.paidPerUnitWad;
            prevAcc = s.netAccWad;
            if (result.retired) expect(s.retired).toBe(true);
          }
          expect(sumAccepted + sumRefund).toBe(sumG);
          expect(s.grossReceived).toBe(sumAccepted);
          expect(s.feeCollected).toBe(sumFee);
          expect(sumFee <= sumAccepted).toBe(true);
          const claims = settleHolderDelta(s.netAccWad, 0n, a) + settleHolderDelta(s.netAccWad, 0n, b) + settleHolderDelta(s.netAccWad, 0n, c);
          const vaultBalance = sumAccepted - sumFee;
          expect(claims <= vaultBalance).toBe(true);
          // the tightest case: one holder owning every unit
          expect(settleHolderDelta(s.netAccWad, 0n, N) <= vaultBalance).toBe(true);
          expect(vaultBalance - settleHolderDelta(s.netAccWad, 0n, N) <= 1n).toBe(true);
          // the issuer never pays a fee: fees are carved out of accepted payments only
          expect(sumFee + (sumAccepted - sumFee)).toBe(sumAccepted);
          // per-unit lifetime gross ≤ cap
          expect(s.paidPerUnitWad / WAD <= cap).toBe(true);
          expect(s.yearGrossWad.reduce((x, y) => x + y, 0n)).toBe(s.paidPerUnitWad);
        },
      ),
      { numRuns: 400 },
    );
  });
});
