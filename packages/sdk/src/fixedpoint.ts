/**
 * Fixed-point helpers (SPEC §1.1). Division rounds down unless the name says `ceil`.
 */

export const WAD = 1_000_000_000_000_000_000n;
export const BPS_DENOMINATOR = 10_000n;

function assertNonNegative(v: bigint, name: string): void {
  if (v < 0n) throw new RangeError(`${name} must be non-negative`);
}

/** floor(a × b / c), exact (bigint). */
export function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  assertNonNegative(a, "a");
  assertNonNegative(b, "b");
  if (c <= 0n) throw new RangeError("division by zero");
  return (a * b) / c;
}

/** ceil(a × b / c). */
export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  assertNonNegative(a, "a");
  assertNonNegative(b, "b");
  if (c <= 0n) throw new RangeError("division by zero");
  const p = a * b;
  return p / c + (p % c === 0n ? 0n : 1n);
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return mulDivCeil(a, 1n, b);
}

/** floor(a × b / WAD) */
export function wadMul(a: bigint, b: bigint): bigint {
  return mulDiv(a, b, WAD);
}

/** floor(a × WAD / b) */
export function wadDiv(a: bigint, b: bigint): bigint {
  return mulDiv(a, WAD, b);
}

/** floor(amount × bps / 10_000) */
export function bpsOf(amount: bigint, bps: bigint | number): bigint {
  const b = BigInt(bps);
  if (b < 0n || b > BPS_DENOMINATOR) throw new RangeError(`bps out of range: ${b}`);
  return mulDiv(amount, b, BPS_DENOMINATOR);
}

export function minBig(...v: bigint[]): bigint {
  if (v.length === 0) throw new RangeError("min of nothing");
  return v.reduce((a, b) => (b < a ? b : a));
}

export function maxBig(...v: bigint[]): bigint {
  if (v.length === 0) throw new RangeError("max of nothing");
  return v.reduce((a, b) => (b > a ? b : a));
}

export function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}
