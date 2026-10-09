/**
 * Fixed-point helpers. Ratios use 1e18 fixed point (WAD). Money is in stablecoin base units.
 * Every division rounds down (toward zero for non-negative inputs), per C2.
 */
export const WAD = 10n ** 18n;
export const BPS = 10_000n;

export function assertNonNegative(x: bigint, name: string): void {
  if (x < 0n) throw new RangeError(`${name} must be non-negative, got ${x}`);
}

/** floor(a * b / d) with a bigint intermediate (the Solana side uses u128). */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  return (a * b) / d;
}

/** floor(a * b / 1e18) */
export function wadMul(a: bigint, b: bigint): bigint {
  return (a * b) / WAD;
}

/** floor(a * 1e18 / b) */
export function wadDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError('division by zero');
  return (a * WAD) / b;
}

/** Parse a ratio given as a decimal string ("0.025", "2.5") into WAD. Exact; no floating point. */
export function wadFromDecimal(s: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new RangeError(`not a decimal: ${s}`);
  const neg = m[1] === '-';
  const whole = BigInt(m[2]!);
  const frac = (m[3] ?? '').padEnd(18, '0');
  if (frac.length > 18) throw new RangeError(`too many decimals for WAD: ${s}`);
  const v = whole * WAD + BigInt(frac);
  return neg ? -v : v;
}

/** Render a WAD ratio as a decimal string with up to 18 places (trailing zeros trimmed). */
export function wadToDecimal(x: bigint): string {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const whole = a / WAD;
  const frac = (a % WAD).toString().padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export function bpsOf(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / BPS;
}

export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
export function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Integer power for bigint exponents. */
export function pow(base: bigint, exp: number): bigint {
  if (!Number.isInteger(exp) || exp < 0) throw new RangeError('exp must be a non-negative integer');
  let r = 1n;
  let b = base;
  let e = exp;
  while (e > 0) {
    if (e & 1) r *= b;
    b *= b;
    e >>= 1;
  }
  return r;
}

/** (1 + h)^n in WAD, computed by repeated WAD multiplication (floor each step). */
export function wadPow1p(hWad: bigint, n: number): bigint {
  let r = WAD;
  const base = WAD + hWad;
  for (let i = 0; i < n; i++) r = wadMul(r, base);
  return r;
}
