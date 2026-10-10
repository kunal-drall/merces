/**
 * Decimal-string codecs for WAD ratios and the UTC day index. Stage 1 has no equivalent of these (its terms carry
 * ratios as WAD integers already), so they stay ours. Errors carry no values: a share rate is part of the private
 * terms, and an unhandled error's message reaches the operator logs.
 */
import { WAD } from '@merces/sdk';

/** Parse a ratio given as a decimal string ("0.025", "2.5") into WAD. Exact; no floating point. */
export function wadFromDecimal(s: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new RangeError('not a decimal');
  const neg = m[1] === '-';
  const whole = BigInt(m[2]!);
  const frac = (m[3] ?? '').padEnd(18, '0');
  if (frac.length > 18) throw new RangeError('too many decimals for WAD');
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

/** UTC day index (days since epoch) for a timestamp: the same day as Stage 1's FX `snapshot` (one per UTC day). */
export function utcDayIndex(ts: number): number {
  return Math.floor(ts / 86_400);
}
