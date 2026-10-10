/**
 * The unit scale of a curve series, ported from Stage 1's Rust (merces-common @1bfc66b; A-MATH-3).
 *
 * A curve series' unit mint has 6 decimals, so one whole unit is 10^6 base lamports. Weights, units outstanding and the
 * vault's per-unit WAD accumulators are per base lamport (the accounting unit), while prices (P0, the cap, P_redeem)
 * stay per whole unit. A sealed-bid series has scale 1. Stage 1's TypeScript reference has no `unit_scale`, so these
 * are ports of the Rust functions, kept apart from the Stage 1 re-exports (`stage1:sync` lists them as ported).
 *
 * Errors mirror Rust's `MathError` (Overflow, DivisionByZero, InvalidInput) as a `RangeError` whose message starts with
 * the variant's name, as Stage 1's TypeScript throws a `RangeError` for bad inputs. A value outside u64 where Rust has a
 * `u64` is refused the same way (InvalidInput for an argument, Overflow for a result).
 */
import { U64_MAX, WAD, mulDiv } from '@merces/sdk';

/** Rust `MathError` variants. */
export type MathErrorKind = 'Overflow' | 'DivisionByZero' | 'InvalidInput';

/** A `RangeError` named after Rust's `MathError` variant. Not exported from `@merces/math`. */
export function mathError(kind: MathErrorKind, detail: string): RangeError {
  return new RangeError(`${kind}: ${detail}`);
}

/** An argument Rust types as `u64`. */
export function argU64(v: bigint, name: string): bigint {
  if (v < 0n || v > U64_MAX) throw mathError('InvalidInput', `${name} is not a u64`);
  return v;
}

/** Rust `to_u64`: a result that must fit u64. */
export function toU64(v: bigint, name: string): bigint {
  if (v < 0n || v > U64_MAX) throw mathError('Overflow', `${name} exceeds u64`);
  return v;
}

/** An argument Rust types as `u8`. */
export function argU8(v: number, name: string): number {
  if (!Number.isInteger(v) || v < 0 || v > 255) throw mathError('InvalidInput', `${name} is not a u8`);
  return v;
}

/** Base-mint decimals of a curve-mode series (`curve.rs:13-14` `CURVE_BASE_DECIMALS`). */
export const CURVE_BASE_DECIMALS = 6;

/** Accounting units (base lamports) per whole unit of a curve-mode series (`curve.rs:15-16` `CURVE_UNIT_SCALE`). */
export const CURVE_UNIT_SCALE = 1_000_000n;

/** Base lamports per whole unit for `decimals`: `10^decimals`, Overflow past u64 (`curve.rs:17-22` `unit_scale_for`). */
export function unitScaleFor(decimals: number): bigint {
  argU8(decimals, 'decimals');
  return toU64(10n ** BigInt(decimals), 'unit scale');
}

/**
 * `WAD / unit_scale`, the WAD value of one base unit per whole unit, per accounting unit. The scale must divide WAD
 * (1 or a power of ten up to 10^18), else InvalidInput (`vault.rs:125-135` `wad_per_scaled_unit`).
 */
export function wadPerScaledUnit(unitScale: bigint): bigint {
  argU64(unitScale, 'unit scale');
  if (unitScale === 0n) throw mathError('InvalidInput', 'unit scale is 0');
  if (WAD % unitScale !== 0n) throw mathError('InvalidInput', 'unit scale does not divide WAD');
  return WAD / unitScale;
}

/**
 * The cap per accounting unit as a WAD accumulator value: `cap_per_unit × WAD / unit_scale`, exact (scale 1 gives
 * SPEC §6.3's `cap_per_unit × WAD`) (`vault.rs:137-143` `scaled_cap_wad`).
 */
export function scaledCapWad(capPerUnit: bigint, unitScale: bigint): bigint {
  argU64(capPerUnit, 'cap per unit');
  return capPerUnit * wadPerScaledUnit(unitScale);
}

/**
 * `floor(price × units / unit_scale)`: the amount for `units` accounting units at a price per whole unit (the
 * redemption deposit and a curve tender; `P × units` at scale 1) (`vault.rs:145-156` `scaled_amount`).
 */
export function scaledAmount(price: bigint, units: bigint, unitScale: bigint): bigint {
  argU64(price, 'price');
  argU64(units, 'units');
  argU64(unitScale, 'unit scale');
  if (unitScale === 0n) throw mathError('DivisionByZero', 'unit scale is 0');
  return toU64(mulDiv(price, units, unitScale), 'scaled amount');
}
