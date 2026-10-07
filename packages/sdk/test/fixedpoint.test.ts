import { describe, it, expect } from "vitest";
import { BPS_DENOMINATOR, WAD, absBig, bpsOf, ceilDiv, maxBig, minBig, mulDiv, mulDivCeil, wadDiv, wadMul } from "../src/index.js";

describe("fixed point (SPEC §1.1)", () => {
  it("WAD and bps", () => {
    expect(WAD).toBe(1_000_000_000_000_000_000n);
    expect(BPS_DENOMINATOR).toBe(10_000n);
  });
  it("mulDiv floors, mulDivCeil ceils, exact for huge intermediates", () => {
    expect(mulDiv(999_999n, 500n, 10_000n)).toBe(49_999n);
    expect(mulDivCeil(999_999n, 500n, 10_000n)).toBe(50_000n);
    expect(mulDiv(1_000_000n, 500n, 10_000n)).toBe(50_000n);
    expect(mulDivCeil(1_000_000n, 500n, 10_000n)).toBe(50_000n);
    expect(mulDiv((1n << 128n) - 1n, (1n << 128n) - 1n, 1n << 200n)).toBe(((1n << 128n) - 1n) ** 2n >> 200n);
    expect(ceilDiv(7n, 3n)).toBe(3n);
    expect(ceilDiv(6n, 3n)).toBe(2n);
    expect(ceilDiv(0n, 3n)).toBe(0n);
  });
  it("wad helpers", () => {
    expect(wadMul(2_500_000_000_000_000_000n, 1_000_000n)).toBe(2_500_000n);
    expect(wadMul(1n, 1n)).toBe(0n);
    expect(wadDiv(1n, 3n)).toBe(333_333_333_333_333_333n);
    expect(wadDiv(7n, 1n)).toBe(7n * WAD);
  });
  it("bpsOf", () => {
    expect(bpsOf(1_000_000n, 100)).toBe(10_000n);
    expect(bpsOf(1_000_000n, 500n)).toBe(50_000n);
    expect(bpsOf(999_999n, 100)).toBe(9_999n);
    expect(bpsOf(5n, 10_000)).toBe(5n);
    expect(() => bpsOf(1n, 10_001)).toThrow(RangeError);
    expect(() => bpsOf(1n, -1)).toThrow(RangeError);
  });
  it("guards", () => {
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(RangeError);
    expect(() => mulDiv(-1n, 1n, 1n)).toThrow(RangeError);
    expect(() => mulDivCeil(1n, -1n, 1n)).toThrow(RangeError);
    expect(minBig(3n, 1n, 2n)).toBe(1n);
    expect(maxBig(3n, 1n, 2n)).toBe(3n);
    expect(absBig(-5n)).toBe(5n);
    expect(absBig(5n)).toBe(5n);
    expect(() => minBig()).toThrow(RangeError);
  });
});
