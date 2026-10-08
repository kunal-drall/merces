import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { WAD, yearGrossGet } from "@merces/sdk";
import { accumulate, capEffWad, capPerUnit, isCapped, newVaultState, settleHolderDelta, vaultReceiveGross, type VaultState } from "../src/index.js";

const USDC = 1_000_000n;

describe("payout vault (SPEC v1.1 §6.3, brief C6)", () => {
  it("cap_per_unit is read live; the effective cap never underflows", () => {
    expect(capPerUnit(2_500_000_000_000_000_000n, 1n * USDC)).toBe(2_500_000n);
    expect(capPerUnit(2_500_000_000_000_000_000n, 3n)).toBe(7n);
    expect(capEffWad(100n, 50n * WAD)).toBe(100n * WAD);
    expect(capEffWad(100n, 150n * WAD)).toBe(150n * WAD);
    expect(isCapped({ paidPerUnitWad: 150n * WAD }, 100n)).toBe(true);
    expect(isCapped({ paidPerUnitWad: 100n * WAD }, 100n)).toBe(true);
    expect(isCapped({ paidPerUnitWad: 99n * WAD }, 100n)).toBe(false);
  });
  it("simple distribution: 5% fee, accumulator in WAD, year_gross ring tagged by settlement year", () => {
    const { state, result } = vaultReceiveGross(newVaultState(), 1n * USDC, 100n, 2_500_000n, 500, 0);
    expect(result).toEqual({ accepted: 1n * USDC, refund: 0n, incWad: 10_000n * WAD, fee: 50_000n, netAdded: 950_000n, deltaAccWad: 9_500n * WAD, carryWad: 0n, retired: false });
    expect(state.paidPerUnitWad).toBe(10_000n * WAD);
    expect(state.netAccWad).toBe(9_500n * WAD);
    expect(yearGrossGet(state.yearGross, 0)).toBe(10_000n * WAD);
    expect(settleHolderDelta(state.netAccWad, 0n, 10n)).toBe(95_000n);
    const later = vaultReceiveGross(state, 2n * USDC, 100n, 2_500_000n, 500, 4);
    expect(yearGrossGet(later.state.yearGross, 4)).toBe(20_000n * WAD);
    expect(yearGrossGet(later.state.yearGross, 0)).toBe(0n); // slot 0 re-tagged to year 4
  });
  it("carry keeps the exact remainder and rolls it forward", () => {
    const a = vaultReceiveGross(newVaultState(), 100n, 7n, 1_000_000n, 500, 0);
    expect(a.result.fee).toBe(5n);
    expect(a.result.deltaAccWad).toBe((95n * WAD) / 7n);
    expect(a.result.carryWad).toBe(95n * WAD - 13_571_428_571_428_571_428n * 7n);
    const b = vaultReceiveGross(a.state, 100n, 7n, 1_000_000n, 500, 0);
    expect(b.result.deltaAccWad).toBe((95n * WAD + 4n) / 7n);
    expect(b.result.carryWad).toBe(1n);
    expect(settleHolderDelta(b.state.netAccWad, 0n, 7n)).toBe(189n);
  });
  it("the spec's base-unit carry would let holders over-claim (SPEC defect S1, still in v1.1)", () => {
    let acc = 0n;
    let carry = 0n;
    for (let i = 0; i < 3; i++) {
      const net = 1n + carry;
      const delta = (net * WAD) / 3n;
      const distributed = (delta * 3n) / WAD;
      carry = net - distributed;
      acc += delta;
    }
    expect((acc * 3n) / WAD).toBe(4n); // 4 claimable from a 3-unit vault
    let s = newVaultState();
    for (let i = 0; i < 3; i++) s = vaultReceiveGross(s, 1n, 3n, 1_000_000n, 0, 0).state;
    expect(settleHolderDelta(s.netAccWad, 0n, 3n)).toBe(3n);
  });
  it("cap hit: truncates, refunds the issuer, retires; exactly reaching the cap retires too", () => {
    const a = vaultReceiveGross(newVaultState(), 2000n, 10n, 250n, 500, 0);
    expect(a.result.retired).toBe(false);
    const b = vaultReceiveGross(a.state, 600n, 10n, 250n, 500, 1);
    expect(b.result).toMatchObject({ accepted: 500n, refund: 100n, incWad: 50n * WAD, fee: 25n, retired: true });
    expect(b.state.paidPerUnitWad).toBe(250n * WAD);
    expect(yearGrossGet(b.state.yearGross, 1)).toBe(50n * WAD);
    const c = vaultReceiveGross(a.state, 500n, 10n, 250n, 500, 0);
    expect(c.result).toMatchObject({ accepted: 500n, refund: 0n, retired: true });
  });
  it("a cap lowered below what was paid accepts nothing more and retires (effective cap)", () => {
    const a = vaultReceiveGross(newVaultState(), 2000n, 10n, 250n, 500, 0); // paid 200/unit
    expect(isCapped(a.state, 150n)).toBe(true);
    const b = vaultReceiveGross(a.state, 100n, 10n, 150n, 500, 0);
    expect(b.result).toMatchObject({ accepted: 0n, refund: 100n, fee: 0n, incWad: 0n, retired: true });
    expect(b.state.paidPerUnitWad).toBe(200n * WAD);
  });
  it("zero units outstanding reverts; zero gross is a no-op distribution", () => {
    expect(() => vaultReceiveGross(newVaultState(), 1n, 0n, 1n, 500, 0)).toThrow("NoUnitsOutstanding");
    expect(vaultReceiveGross(newVaultState(), 0n, 10n, 100n, 500, 0).result).toMatchObject({ accepted: 0n, fee: 0n, deltaAccWad: 0n, retired: false });
    expect(accumulate(0n, 0n, 95n, 7n).carryWad).toBe(4n);
    expect(() => accumulate(0n, 0n, 1n, 0n)).toThrow("NoUnitsOutstanding");
  });

  it("property (F2): no unit over the effective cap; Σ accepted + Σ refund == Σ G; fees exact; claims ≤ vault; monotone", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000n }),
        fc.bigInt({ min: 1n, max: 10n * USDC }),
        fc.array(fc.tuple(fc.bigInt({ min: 0n, max: 100n * USDC }), fc.bigInt({ min: 0n, max: 2n })), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 2000 }),
        (N, cap0, payments, feeBps) => {
          let s: VaultState = newVaultState();
          let cap = cap0;
          let sumG = 0n;
          let sumAccepted = 0n;
          let sumRefund = 0n;
          let sumFee = 0n;
          let prevPaid = 0n;
          let prevAcc = 0n;
          for (const [i, [G, lower]] of payments.entries()) {
            if (s.retired) break;
            if (lower === 2n && cap > 1n) cap -= cap / 10n + 1n; // an amendment lowers the live cap
            const { state, result } = vaultReceiveGross(s, G, N, cap, feeBps, i % 3);
            s = state;
            sumG += G;
            sumAccepted += result.accepted;
            sumRefund += result.refund;
            sumFee += result.fee;
            expect(result.fee).toBe((result.accepted * BigInt(feeBps)) / 10_000n);
            expect(s.paidPerUnitWad <= capEffWad(cap, prevPaid)).toBe(true);
            expect(s.paidPerUnitWad >= prevPaid).toBe(true);
            expect(s.netAccWad >= prevAcc).toBe(true);
            expect(result.carryWad < N).toBe(true);
            expect(s.netAccWad * N + s.carryWad).toBe((s.grossReceived - s.feeCollected) * WAD);
            prevPaid = s.paidPerUnitWad;
            prevAcc = s.netAccWad;
          }
          expect(sumAccepted + sumRefund).toBe(sumG);
          expect(s.grossReceived).toBe(sumAccepted);
          expect(s.feeCollected).toBe(sumFee);
          const vaultBalance = sumAccepted - sumFee;
          const a = N / 3n;
          const b = N / 3n;
          const c = N - a - b;
          expect(settleHolderDelta(s.netAccWad, 0n, a) + settleHolderDelta(s.netAccWad, 0n, b) + settleHolderDelta(s.netAccWad, 0n, c) <= vaultBalance).toBe(true);
          expect(settleHolderDelta(s.netAccWad, 0n, N) <= vaultBalance).toBe(true);
          expect(vaultBalance - settleHolderDelta(s.netAccWad, 0n, N) <= 1n).toBe(true);
          expect([0, 1, 2].reduce((x, y) => x + yearGrossGet(s.yearGross, y), 0n)).toBe(s.paidPerUnitWad);
        },
      ),
      { numRuns: 400 },
    );
  });
});
