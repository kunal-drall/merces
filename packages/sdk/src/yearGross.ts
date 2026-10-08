/**
 * Tagged 4-slot `year_gross` ring (SPEC §6.3): slot `y % 4` holds `{ year, gross_wad }`; it is
 * zeroed and re-tagged when its `year != y` before adding; readers treat a missing tag as 0.
 */
import { YEAR } from "./periods.js";

export interface YearGrossSlot {
  /** settlement-year tag, or null when the slot has never been written */
  year: number | null;
  grossWad: bigint;
}

export type YearGrossRing = readonly [YearGrossSlot, YearGrossSlot, YearGrossSlot, YearGrossSlot];

export function newYearGross(): YearGrossRing {
  return [
    { year: null, grossWad: 0n },
    { year: null, grossWad: 0n },
    { year: null, grossWad: 0n },
    { year: null, grossWad: 0n },
  ];
}

/** `settlement_year(ts) = floor((ts − settlement_ts) / YEAR)`; negative for ts before settlement. */
export function settlementYear(ts: bigint, settlementTs: bigint): number {
  const d = ts - settlementTs;
  const q = d / YEAR;
  return Number(d < 0n && d % YEAR !== 0n ? q - 1n : q);
}

export function yearGrossGet(ring: YearGrossRing, year: number): bigint {
  if (year < 0) return 0n;
  const slot = ring[year % 4]!;
  return slot.year === year ? slot.grossWad : 0n;
}

/** Returns a new ring with `incWad` added to `year`'s slot (re-tagging an older slot). */
export function yearGrossAdd(ring: YearGrossRing, year: number, incWad: bigint): YearGrossRing {
  if (year < 0) throw new RangeError("settlement year must be ≥ 0");
  if (incWad < 0n) throw new RangeError("negative increment");
  const copy = ring.map((s) => ({ ...s })) as [YearGrossSlot, YearGrossSlot, YearGrossSlot, YearGrossSlot];
  const slot = copy[year % 4]!;
  if (slot.year !== year) {
    slot.year = year;
    slot.grossWad = 0n;
  }
  slot.grossWad += incWad;
  return copy;
}
