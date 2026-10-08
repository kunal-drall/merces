import { describe, it, expect } from "vitest";
import { WAD, YEAR, newYearGross, settlementYear, yearGrossAdd, yearGrossGet } from "../src/index.js";

describe("year_gross tagged ring (SPEC §6.3)", () => {
  it("adds, re-tags evicted slots and reads missing tags as 0", () => {
    let r = newYearGross();
    expect(yearGrossGet(r, 0)).toBe(0n);
    r = yearGrossAdd(r, 0, 10n * WAD);
    r = yearGrossAdd(r, 0, 5n * WAD);
    r = yearGrossAdd(r, 1, 20n * WAD);
    r = yearGrossAdd(r, 2, 30n * WAD);
    r = yearGrossAdd(r, 3, 40n * WAD);
    expect([0, 1, 2, 3].map((y) => yearGrossGet(r, y))).toEqual([15n * WAD, 20n * WAD, 30n * WAD, 40n * WAD]);
    r = yearGrossAdd(r, 4, 50n * WAD); // slot 0 re-tagged
    expect(yearGrossGet(r, 0)).toBe(0n);
    expect(yearGrossGet(r, 4)).toBe(50n * WAD);
    expect(yearGrossGet(r, 8)).toBe(0n);
    expect(r[0]).toEqual({ year: 4, grossWad: 50n * WAD });
    expect(() => yearGrossAdd(r, -1, 1n)).toThrow(RangeError);
  });
  it("settlement_year floors from the settlement timestamp", () => {
    expect(settlementYear(1000n, 1000n)).toBe(0);
    expect(settlementYear(1000n + YEAR - 1n, 1000n)).toBe(0);
    expect(settlementYear(1000n + YEAR, 1000n)).toBe(1);
    expect(settlementYear(999n, 1000n)).toBe(-1);
    expect(yearGrossGet(newYearGross(), -1)).toBe(0n);
  });
});
