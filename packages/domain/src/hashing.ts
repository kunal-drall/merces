import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  BN254_FR, CURRENCY_CODES, INDEXING_RULES, U64_MAX, ZERO_INCOME_COMMITMENT as ZERO_FIELD, quarterIndex, yearOf,
  incomeCommitmentField, routerIncomeCommitmentField, termsCommitmentField,
} from '@merces/math';

/**
 * Canonical hashing for commitments and attestations. All parties (device, verifier, services, simulator, live
 * adapters) agree on these layouts.
 *
 * The report commitments and the report's public inputs are Stage 1's (SPEC v1.1.2 §1.5, §6.2; the circuit
 * `stage1/circuits`): Poseidon over BN254 through `@merces/math`, which re-exports Stage 1's own functions. Field
 * elements travel as 0x-prefixed 32-byte big-endian lowercase hex, the encoding the chains store. Bid and order
 * commitments stay SHA-256 over canonical JSON until the auction work (S2). The attestation message keeps Stage 1's
 * field set in a JSON encoding until the signature work (S4) switches it to Stage 1's `MERCES_REPORT_V1` bytes.
 *
 * Errors raised here never carry the offending value: the inputs include income figures, salts and private terms.
 */

export function sha256Hex(data: Uint8Array): string {
  return '0x' + bytesToHex(sha256(data));
}

/** Deterministic JSON: sorted keys, no whitespace, bigint as string. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function hashCanonical(domainTag: string, value: unknown): string {
  return sha256Hex(utf8ToBytes(`merces/${domainTag}/v0\n` + canonicalJson(value)));
}

// ---------------------------------------------------------------- field elements

/** A BN254 scalar field element as 0x + 64 lowercase hex digits (big-endian). */
export function fieldToHex32(f: bigint): string {
  if (f < 0n || f >= BN254_FR) throw new RangeError('not a BN254 field element');
  return '0x' + f.toString(16).padStart(64, '0');
}

/** The field element a 0x-prefixed 32-byte hex string encodes; refuses anything that is not one (≥ r included). */
export function hex32ToField(h: string): bigint {
  if (typeof h !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(h)) throw new RangeError('not a 32-byte hex value');
  const f = BigInt(h);
  if (f >= BN254_FR) throw new RangeError('not a BN254 field element');
  return f;
}

/** A field element given as a bigint, a decimal string or a 0x-hex string (salts travel as decimals, commitments as hex). */
function toField(v: bigint | string, what: string): bigint {
  let x: bigint;
  try {
    x = typeof v === 'bigint' ? v : BigInt(v);
  } catch {
    throw new RangeError(`${what} is not an integer`);
  }
  if (x < 0n || x >= BN254_FR) throw new RangeError(`${what} is not a BN254 field element`);
  return x;
}
function toU64(v: bigint | string, what: string): bigint {
  let x: bigint;
  try {
    x = typeof v === 'bigint' ? v : BigInt(v);
  } catch {
    throw new RangeError(`${what} is not an integer`);
  }
  if (x < 0n || x > U64_MAX) throw new RangeError(`${what} is out of the u64 range`);
  return x;
}

/** 512 random bits reduced mod r (bias below 2^-250, as Stage 1's prover does): a salt for a Poseidon commitment. */
export function randomFieldSalt(): bigint {
  const b = new Uint8Array(64);
  globalThis.crypto.getRandomValues(b);
  return BigInt('0x' + bytesToHex(b)) % BN254_FR;
}

// ---------------------------------------------------------------- terms and income commitments (SPEC §1.5)

/** `Poseidon(2)(0, 0)`: the prior income commitment at the start of a reporting year. */
export const ZERO_INCOME_COMMITMENT: string = fieldToHex32(ZERO_FIELD);

/** Stage 1's `indexing_rule` codes (SDK `INDEXING_RULES`) by the names the terms carry. */
export const INDEXING_RULE_CODE = { none: INDEXING_RULES.none, 'cpi-annual': INDEXING_RULES.cpiYearly } as const;
export type IndexingRule = keyof typeof INDEXING_RULE_CODE;

/** The ISO-4217 numeric code of a reporting currency (Stage 1 `CURRENCY_CODES`). A currency Stage 1 does not list is refused. */
export function currencyCodeOf(alpha: string): number {
  const c = (CURRENCY_CODES as Record<string, number>)[alpha];
  if (c === undefined) throw new RangeError('unsupported reporting currency');
  return c;
}

/**
 * The opening of a terms commitment. θ is the annual threshold in the reporting currency at the stablecoin's 6
 * decimals; `rWad` the per-unit rate (WAD); both below 2^64. `termsSalt` is a field element.
 */
export interface TermsOpening {
  theta: bigint | string;
  rWad: bigint | string;
  currency: string;
  indexingRule: IndexingRule;
  termsSalt: bigint | string;
}

/** `terms_commitment = Poseidon(5)(θ, r_wad, currency_code, indexing_rule, terms_salt)` (SPEC §1.5). */
export function termsCommitment(t: TermsOpening): string {
  const code = INDEXING_RULE_CODE[t.indexingRule];
  if (code === undefined) throw new RangeError('unknown indexing rule');
  return fieldToHex32(termsCommitmentField({ theta: toU64(t.theta, 'theta'), rWad: toU64(t.rWad, 'rWad'), currencyCode: currencyCodeOf(t.currency), indexingRule: code, termsSalt: toField(t.termsSalt, 'termsSalt') }));
}

/** `income_commitment = Poseidon(2)(income_ytd, income_salt)`; the year-to-date figure is a u64 at the stablecoin's decimals. */
export function incomeCommitment(incomeYtd: bigint | string, incomeSalt: bigint | string): string {
  return fieldToHex32(incomeCommitmentField(toU64(incomeYtd, 'incomeYtd'), toField(incomeSalt, 'incomeSalt')));
}

/** Tier 1 (router) binding: `Poseidon(2)(router.ytd_at_end[period], 0)`. */
export function routerIncomeCommitment(ytdAtEnd: bigint | string): string {
  return fieldToHex32(routerIncomeCommitmentField(toU64(ytdAtEnd, 'ytdAtEnd')));
}

/**
 * The prior income commitment the chain requires for a report of period `pid` (Stage 1 period id), SPEC §6.2 step 5
 * (Stage 1 simulator `submitReport`):
 * - the previous quarter of the same year was the last report: its income commitment (the chain);
 * - the series' first report, outside Q1: the supplied prior, accepted as given (A25; the attestation binds it);
 * - otherwise (a year start): ZERO.
 */
export function expectedPrior(ledger: { lastAcceptedPeriod: number | null; lastIncomePeriod: number | null; lastIncomeCommitment: string }, pid: number, supplied: string): string {
  const last = ledger.lastIncomePeriod;
  if (last !== null && last === pid - 1 && yearOf(last) === yearOf(pid)) return ledger.lastIncomeCommitment;
  if (ledger.lastAcceptedPeriod === null && quarterIndex(pid) !== 0) return supplied;
  return ZERO_INCOME_COMMITMENT;
}

// ---------------------------------------------------------------- the report's public inputs

/** The circuit's public inputs, in order (Stage 1 `PUBLIC_INPUT_NAMES`, circuits/src/prover.ts). */
export const REPORT_PUBLIC_INPUT_NAMES = ['terms_commitment', 'units_outstanding', 'fx_avg_wad', 'prior_income_commitment', 'income_commitment', 'payment_usd'] as const;

/**
 * The report's six public inputs as decimal strings, in Stage 1's order:
 * `[terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd]`.
 * `termsCommitment` is the series' live commitment; units are the units outstanding, or the units at redemption for a
 * tail report.
 */
export function reportPublicInputs(p: { termsCommitment: string; unitsOutstanding: bigint | string; fxAvgWad: bigint | string; priorIncomeCommitment: string; incomeCommitment: string; paymentStable: bigint | string }): string[] {
  return [
    hex32ToField(p.termsCommitment),
    toU64(p.unitsOutstanding, 'unitsOutstanding'),
    toU64(p.fxAvgWad, 'fxAvgWad'),
    hex32ToField(p.priorIncomeCommitment),
    hex32ToField(p.incomeCommitment),
    toU64(p.paymentStable, 'paymentStable'),
  ].map(String);
}

// ---------------------------------------------------------------- attestations

/**
 * The message a report verifier signs (ed25519): Stage 1's `MERCES_REPORT_V1` field set (series, period, prior and
 * income commitments, tier, liquidity event) without the domain, as canonical JSON. It names no income source:
 * sources never go onchain (B7). S4 replaces the encoding with Stage 1's bytes and the key with secp256k1.
 */
export function attestationMessage(input: { seriesId: string; periodId: string; priorIncomeCommitment: string; incomeCommitment: string; tier: number; liquidityEvent: boolean }): Uint8Array {
  return utf8ToBytes(`merces/attestation/v1\n` + canonicalJson({
    seriesId: input.seriesId, periodId: input.periodId, priorIncomeCommitment: input.priorIncomeCommitment, incomeCommitment: input.incomeCommitment, tier: input.tier, liquidityEvent: input.liquidityEvent,
  }));
}

/** The message an attestor signs when attesting a fallback FX rate. */
export function fxAttestationMessage(input: { pair: string; periodId: string; rateWad: string }): Uint8Array {
  return utf8ToBytes(`merces/fx-attestation/v0\n` + canonicalJson(input));
}

// ---------------------------------------------------------------- the mock proof system

/**
 * Mock proof system for the simulator and tests: a SHA-256 digest over the six public inputs, with no witness.
 * It proves nothing (anyone can compute it), so a chain accepts it only when explicitly configured to (the
 * simulator's `acceptMockProofs`, off by default; never on a live chain). What keeps it useful is the device side:
 * the harness checks the circuit's equations in TypeScript before it emits one.
 */
export function mockProve(publicInputs: readonly string[]): string {
  return sha256Hex(utf8ToBytes('merces/mock-groth16/v1\n' + publicInputs.join(',')));
}

export function mockVerify(proof: unknown, publicInputs: readonly string[]): boolean {
  return typeof proof === 'string' && publicInputs.length === REPORT_PUBLIC_INPUT_NAMES.length && proof === mockProve(publicInputs);
}

// ---------------------------------------------------------------- other commitments (unchanged until S2)

/** Sealed-bid commitment = hash(seriesId, bidder, price, quantity, salt). */
export function bidCommitment(input: { seriesId: string; bidder: string; pricePerUnit: bigint | string; quantity: bigint | string; salt: string }): string {
  return hashCanonical('bid', { seriesId: input.seriesId, bidder: input.bidder, pricePerUnit: input.pricePerUnit.toString(), quantity: input.quantity.toString(), salt: input.salt });
}

/** Transfer-window order commitment. */
export function orderCommitment(input: { seriesId: string; windowId: number; wallet: string; side: 'buy' | 'sell'; pricePerUnit: bigint | string; quantity: bigint | string; salt: string }): string {
  return hashCanonical('order', { ...input, pricePerUnit: input.pricePerUnit.toString(), quantity: input.quantity.toString() });
}

/** A random 0x-hex salt for bid and order commitments (not a field element: use `randomFieldSalt` for Poseidon). */
export function randomSalt(bytes = 32): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return '0x' + bytesToHex(b);
}

export { bytesToHex, hexToBytes, utf8ToBytes };
