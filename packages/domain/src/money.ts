import { z } from 'zod';

/** Money is always a decimal string in stablecoin base units. Never floating point. */
export const moneySchema = z.string().regex(/^\d+$/, 'money must be a non-negative integer string in base units');
export type Money = string;
/** Ratios are decimal strings of 1e18 fixed point. */
export const wadSchema = z.string().regex(/^\d+$/);
export type Wad = string;
/** Unit counts are decimal integer strings (0-decimal tokens). */
export const unitsSchema = z.string().regex(/^\d+$/);
export type Units = string;

export function toBig(x: string): bigint {
  if (!/^-?\d+$/.test(x)) throw new TypeError(`not an integer string: ${x}`);
  return BigInt(x);
}
export function fromBig(x: bigint): string {
  return x.toString(10);
}
export function addMoney(a: Money, b: Money): Money {
  return fromBig(toBig(a) + toBig(b));
}
