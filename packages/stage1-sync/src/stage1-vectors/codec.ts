import { TIER_FLAG, fromPid, toPid } from '@merces/math';
import { RunnerError } from './errors.ts';

/**
 * Conversions between the Stage 1 vector encoding and the canonical model (S1 plan §5.1 `codec.ts`). Every function
 * here is pure and reports bad input with public facts only (the field name, never the value: a vector's value can be
 * a commitment or a salt).
 */

/** Stage 1 period id (decimal string or number, 2026Q1 = 8104) → `"2026Q1"`. */
export function periodIdOf(pid: string | number): string {
  const n = typeof pid === 'number' ? pid : Number(pid);
  if (!Number.isSafeInteger(n) || n < 0) throw new RunnerError('a period is not a Stage 1 period id');
  return fromPid(n);
}

/** `"2026Q1"` → 8104. */
export function pidOfPeriodId(periodId: string): number {
  return toPid(periodId);
}

/** The canonical tier flags of a Stage 1 `tierFlags` bitmask (SDK constants.ts:188-193). */
export function tierFlagsOf(mask: number): { tier1: boolean; tier2: boolean; tier3: boolean; tier4: boolean } {
  if (!Number.isInteger(mask) || mask < 0 || mask > 15) throw new RunnerError('tierFlags is not a 4-bit mask');
  return {
    tier1: (mask & TIER_FLAG.tier1) !== 0,
    tier2: (mask & TIER_FLAG.tier2) !== 0,
    tier3: (mask & TIER_FLAG.tier3) !== 0,
    tier4: (mask & TIER_FLAG.tier4) !== 0,
  };
}

/**
 * A vector's 0x-hex 32-byte value (commitment, salt, contract hash) as the canonical `hash32` (lowercase, 64 digits).
 * A shorter value is left-padded (a tamper case may carry a small number such as a prior of 12345); a value wider than
 * 32 bytes is refused.
 */
export function hex32(value: string, field: string): string {
  const m = /^0x([0-9a-fA-F]{1,64})$/.exec(value);
  if (!m) throw new RunnerError(`${field} is not 0x-hex of at most 32 bytes`);
  return '0x' + m[1]!.toLowerCase().padStart(64, '0');
}

/** The 32 zero bytes (a Stage 1 `contractHash: null`). */
export const ZERO_HASH32 = '0x' + '0'.repeat(64);

/** A vector decimal (u64 amounts, prices, quantities, times) as a bigint. */
export function dec(value: string, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new RunnerError(`${field} is not a decimal string`);
  return BigInt(value);
}

/** A vector decimal that must fit a JavaScript number (seconds, bps, small counts). */
export function num(value: string | number, field: string): number {
  const n = typeof value === 'number' ? value : Number(dec(value, field));
  if (!Number.isSafeInteger(n)) throw new RunnerError(`${field} does not fit a safe integer`);
  return n;
}
