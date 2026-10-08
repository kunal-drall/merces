import { describe, it, expect } from "vitest";
import { WAD, bytesToHex, fxPairId, hexToBytes, invertRate, keccak256, normalizePythPrice, u8 } from "../src/index.js";

describe("fx helpers (SPEC §3.1, §6.6)", () => {
  it("normalize handles negative, zero and positive exponents", () => {
    expect(normalizePythPrice(108_345_678n, -8)).toBe(1_083_456_780_000_000_000n);
    expect(normalizePythPrice(108_345n, -5)).toBe(1_083_450_000_000_000_000n);
    expect(normalizePythPrice(5n, 0)).toBe(5n * WAD);
    expect(normalizePythPrice(7n, 2)).toBe(700n * WAD);
    expect(normalizePythPrice(123_456_789_012_345_678_901n, -18)).toBe(123_456_789_012_345_678_901n);
    expect(() => normalizePythPrice(1n, -19)).toThrow(RangeError);
    expect(() => normalizePythPrice(0n, -8)).toThrow(RangeError);
    expect(() => normalizePythPrice(1n, 1.5)).toThrow(RangeError);
  });
  it("inverts with floor", () => {
    expect(invertRate(2n * WAD)).toBe(WAD / 2n);
    expect(invertRate(150n * WAD)).toBe(6_666_666_666_666_666n);
  });
  it("pair id = keccak256(feed_id ‖ inverted_u8)", () => {
    const feed = "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b";
    expect(fxPairId(feed, false)).toEqual(keccak256(hexToBytes(feed), u8(0)));
    expect(fxPairId(feed, true)).toEqual(keccak256(hexToBytes(feed), u8(1)));
    expect(bytesToHex(fxPairId(feed, false))).not.toBe(bytesToHex(fxPairId(feed, true)));
  });
});
