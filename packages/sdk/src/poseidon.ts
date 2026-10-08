/**
 * Poseidon commitments (SPEC §1.5). Poseidon over BN254 with circomlib's parameters, computed
 * with poseidon-lite (shown equal to circomlibjs in the test suite). Chains treat commitments as
 * opaque 32-byte big-endian field elements.
 */
import { poseidon2 as poseidonLite2, poseidon5 as poseidonLite5 } from "poseidon-lite";
import { bytes32, bytesToBigInt, toBigInt } from "./bytes.js";
import { keccak256 } from "./hash.js";
import { utf8 } from "./bytes.js";

/** BN254 scalar field modulus. */
export const BN254_FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function assertField(v: bigint | number | string, name = "value"): bigint {
  const x = toBigInt(v, name);
  if (x < 0n || x >= BN254_FR) throw new RangeError(`${name} is not a BN254 field element`);
  return x;
}

export function poseidon2(a: bigint | number | string, b: bigint | number | string): bigint {
  return poseidonLite2([assertField(a, "a"), assertField(b, "b")]);
}

export function poseidon5(inputs: readonly [bigint | number | string, bigint | number | string, bigint | number | string, bigint | number | string, bigint | number | string]): bigint {
  return poseidonLite5(inputs.map((v, i) => assertField(v, `inputs[${i}]`)));
}

export interface TermsPlain {
  /** annual threshold in income-currency minor units (< 2^64) */
  theta: bigint;
  /** rate per unit, WAD (< 2^64) */
  rWad: bigint;
  /** ISO-4217 numeric code (840 = USD) */
  currencyCode: bigint | number;
  /** opaque u32 code (0 = none, 1 = CPI-indexed yearly) */
  indexingRule: bigint | number;
  /** random field element */
  termsSalt: bigint;
}

/** `terms_commitment = Poseidon(5)(theta, r_wad, currency_code, indexing_rule, terms_salt)` */
export function termsCommitment(t: TermsPlain): bigint {
  return poseidon5([t.theta, t.rWad, t.currencyCode, t.indexingRule, t.termsSalt]);
}

/** `income_commitment = Poseidon(2)(income_ytd, income_salt)` */
export function incomeCommitment(incomeYtd: bigint, incomeSalt: bigint): bigint {
  return poseidon2(incomeYtd, incomeSalt);
}

/** Tier-1 (router) income binding: `Poseidon(2)(router.ytd_at_end[period], 0)` (SPEC §1.5, §6.2 step 7). */
export function routerIncomeCommitment(ytdAtEnd: bigint): bigint {
  return poseidon2(ytdAtEnd, 0n);
}

/** `ZERO_INCOME_COMMITMENT = Poseidon(2)(0, 0)`: the prior commitment at the start of a reporting year. */
export const ZERO_INCOME_COMMITMENT: bigint = poseidon2(0n, 0n);

/** A field element as the 32-byte big-endian value chains store. */
export function fieldToBytes32(f: bigint): Uint8Array {
  return bytes32(assertField(f));
}

export function bytes32ToField(b: Uint8Array | string): bigint {
  return assertField(bytesToBigInt(bytes32(b)));
}

/** Deterministic test salt: keccak256(seed ‖ label) reduced into the field. Test use only. */
export function deriveSalt(seed: Uint8Array | string, label: string): bigint {
  const s = typeof seed === "string" ? utf8(seed) : seed;
  return bytesToBigInt(keccak256(s, utf8(label))) % BN254_FR;
}
