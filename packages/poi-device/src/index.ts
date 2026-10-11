import { createHmac } from 'node:crypto';
import {
  INDEXING_RULE_CODE, ZERO_INCOME_COMMITMENT, attestationOf, currencyCodeOf, hex32ToField, incomeCommitment, mockProve, recoverSigner, reportPublicInputs, termsCommitment,
  type Attestation, type IndexingRule, type ReportAttestationRecord, type ReportProof, type UserCommand,
} from '@merces/domain';
import { BN254_FR, U64_MAX, WAD, fromPid, paymentStable, quarterIndex, ratePerUnit, toPid } from '@merces/math';
import type { IncomeSourceKind, ZkTlsProof } from '@merces/ports';
import type { ReportVerifierPort } from '@merces/report-verifier';

import type { Tier3Opening } from './attestor.ts';

export * from './attestor.ts';
export * from './e2e.ts';
// the attestor tool (S4 WP8): the keystore (without its internal signing helper) and the request signer
export {
  AttestorKey, KEYSTORE_DKLEN, KEYSTORE_SCRYPT_N, KEYSTORE_SCRYPT_P, KEYSTORE_SCRYPT_R, KeystoreError, MIN_KEYSTORE_SCRYPT_N, MIN_PASSWORD_LENGTH,
  createKeystore, decryptKeystore, isTestHarness, keystoreKdf, type KeystoreErrorCode, type KeystoreKdf, type KeystoreV3, type Pbkdf2Params, type ScryptParams,
} from './attestor-keys.ts';
export * from './attestor-signer.ts';

/**
 * What runs on the issuer's device for a quarterly ProofOfIncome report (SPEC v1.1.2 §1.5, §6.2, §8):
 *  - the private terms opening (disclosed to the issuer by E4) and the device's income chain: per quarter, the
 *    year-to-date figure and the salt of the income commitment it reported. These never leave the device: not to the
 *    API, the database, a queue or a log. Tier 2 sends the figure to the report verifier only inside the zkTLS proof,
 *    and the prior opening to the verifier only; tier 3 hands the openings to the attestor end-to-end encrypted (M7);
 *  - salts derived from a device secret (owner question 2's default), so a reinstalled device rebuilds its openings
 *    from its own records: `HMAC-SHA512(deviceSecret, "merces/income-salt/v1\n" ‖ series ‖ "\n" ‖ period) mod r`;
 *  - Stage 1's prover (`@merces/circuits` `proveReport`, fresh randomness) over Stage 1's six public signals.
 * Every error from Stage 1's sdk, reference math or circuits is mapped to a `DeviceError` code: Stage 1's range
 * errors put the offending value in their message, so a message is never forwarded.
 */

/** The private terms as the terms vault discloses them to the issuer (scheme `poseidon5-v1`, decimal strings). */
export interface DevicePrivateTerms {
  /** θ: the annual threshold in the reporting currency at the stablecoin's 6 decimals */
  threshold: string;
  /** r: the per-unit rate (WAD); derived from `shareRate` and the units offered when absent */
  ratePerUnitWad?: string;
  shareRate?: string;
  reportingCurrency: string;
  indexingRule: IndexingRule;
  /** the terms salt, a field element (decimal) */
  termsSalt: string;
}

/** The opening of an income commitment `Poseidon(2)(incomeYtd, incomeSalt)`. */
export interface IncomeOpening {
  incomeYtd: bigint;
  incomeSalt: bigint;
}

/** One quarter of the device's income chain. Device-local only. */
export interface IncomeChainEntry extends IncomeOpening {
  seriesId: string;
  periodId: string;
  incomeCommitment: string;
  /**
   * The report verifier's record of this quarter (tier 2; S4 WP6): its Stage 1 REPORT signature with the fields and the
   * chain it signed for. It authenticates the entry as the next quarter's prior (`priorAttestation`). Public data.
   */
  attestation: ReportAttestationRecord | null;
}

/** Device-local storage of the income chain (a real device persists it locally, never to the API). */
export interface IncomeChainStore {
  get(seriesId: string, periodId: string): IncomeChainEntry | undefined;
  put(entry: IncomeChainEntry): void;
}

export class MemoryIncomeChain implements IncomeChainStore {
  private readonly entries = new Map<string, IncomeChainEntry>();
  get(seriesId: string, periodId: string): IncomeChainEntry | undefined {
    return this.entries.get(`${seriesId}|${periodId}`);
  }
  put(entry: IncomeChainEntry): void {
    this.entries.set(`${entry.seriesId}|${entry.periodId}`, entry);
  }
}

export type DeviceErrorCode =
  | 'out-of-range'
  | 'not-field'
  | 'unsupported-currency'
  | 'terms-mismatch'
  | 'prior-mismatch'
  | 'needs-zktls'
  | 'verifier-refused'
  | 'verifier-unavailable'
  | 'proof-failed';

/** A device failure as a code. The message names the code (and the verifier's code), never a value. */
export class DeviceError extends Error {
  constructor(
    readonly code: DeviceErrorCode,
    readonly verifierCode: string | null = null,
  ) {
    super(`device: ${code}${verifierCode ? ` (${verifierCode})` : ''}`);
    this.name = 'DeviceError';
  }
}

/** Run `f`; anything it throws becomes `DeviceError(code)` (a `DeviceError` passes through). */
function guard<T>(code: DeviceErrorCode, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof DeviceError) throw e;
    throw new DeviceError(code);
  }
}

/** The income salt of a quarter, derived from the device secret (512 bits reduced mod r). */
export function deriveIncomeSalt(deviceSecret: Uint8Array | string, seriesId: string, periodId: string): bigint {
  const mac = createHmac('sha512', typeof deviceSecret === 'string' ? Buffer.from(deviceSecret, 'utf8') : Buffer.from(deviceSecret)).update(`merces/income-salt/v1\n${seriesId}\n${periodId}`).digest('hex');
  return BigInt('0x' + mac) % BN254_FR;
}

/**
 * The prior a report chains from, given what the chain expects (`GET /series/:id/reporting/prior`):
 * - `expected` is ZERO: no prior (a year start);
 * - `expected` is a commitment: the device's entry for the previous quarter, which must carry that commitment;
 * - `expected` is null (the series' first report outside Q1, A25, where the chain accepts the prior as given): the
 *   device's entry for the previous quarter when it has one (attested by the verifier for this purpose), else ZERO.
 * Throws `prior-mismatch` when the device holds no opening for the commitment the chain expects.
 */
export function choosePrior(store: IncomeChainStore, seriesId: string, periodId: string, expected: string | null): IncomeChainEntry | null {
  if (expected === ZERO_INCOME_COMMITMENT) return null;
  const pid = toPid(periodId);
  const prev = quarterIndex(pid) === 0 ? undefined : store.get(seriesId, fromPid(pid - 1));
  if (expected === null) return prev ?? null;
  if (!prev || prev.incomeCommitment !== expected) throw new DeviceError('prior-mismatch');
  return prev;
}

export interface DeviceReportInput {
  seriesId: string;
  periodId: string;
  /** the series' live terms commitment (public) */
  termsCommitment: string;
  /** units outstanding, or the units at redemption for a tail report */
  unitsOutstanding: string;
  /** units offered at creation: r = s / N uses N offered when only `shareRate` is known */
  unitsOffered?: string;
  /**
   * The series' accounting units per whole unit (`SeriesState.unitScale`: "1", or "1000000" base lamports on a curve
   * series). r is per accounting unit (Stage 1 registry lib.rs:594-600), so the N it is derived over is the units offered
   * × this. Default "1".
   */
  unitScale?: string;
  privateTerms: DevicePrivateTerms;
  /** the previous quarter's entry this report chains from (see `choosePrior`); null = ZERO */
  prior: IncomeChainEntry | null;
  /** the real year-to-date income at the period end (6 decimals); the device applies the high-water rule */
  incomeYtdNow: bigint;
  fxAvgWad: bigint;
  tier: 1 | 2 | 3;
  source: IncomeSourceKind | 'split' | 'attestor';
  /** tier 2: the zkTLS proof of the year-to-date figure */
  zktlsProof?: ZkTlsProof | null;
  liquidityEvent?: boolean;
  /** derives the income salt (`deriveIncomeSalt`) */
  deviceSecret: Uint8Array | string;
  /** overrides the derived salt (a field element) */
  incomeSalt?: bigint;
}

/** What leaves the device: commitments, the payment and the proof. Never a figure or a salt. */
export interface AssembledReport {
  seriesId: string;
  periodId: string;
  tier: 1 | 2 | 3;
  /** which provider the device used: stays offchain (the service stores it for the issuer only) */
  source: string;
  paymentStable: string;
  priorIncomeCommitment: string;
  incomeCommitment: string;
  proof: ReportProof;
  /** tier 2: the verifier key's signature as `submitReport.attestation` carries it (`{signer, signature}`); else null */
  attestation: Attestation | null;
  liquidityEvent: boolean;
}

export interface DeviceReport {
  assembled: AssembledReport;
  /** keep in the device's income chain: the next quarter proves against it */
  entry: IncomeChainEntry;
  /** tier 3 only: seal it for the attestor with `sealTier3Opening` (merces-e2e v1); the API refuses anything else */
  tier3Opening: Tier3Opening | null;
}

const u64 = (v: bigint | string): bigint => {
  const x = BigInt(v);
  if (x < 0n || x > U64_MAX) throw new DeviceError('out-of-range');
  return x;
};

/**
 * Assemble a quarterly report on the device: the payment (Stage 1's `payment_usd`), the income commitment under the
 * high-water rule, Stage 1's Groth16 proof (or, for a simulator that opted in, the mock), and for tier 2 the report
 * verifier's attestation. Only `assembled` leaves the device.
 */
export async function assembleOnDevice(input: DeviceReportInput, verifier: ReportVerifierPort | null, opts: { proofs?: 'groth16' | 'mock' } = {}): Promise<DeviceReport> {
  const t = input.privateTerms;
  const units = guard('out-of-range', () => u64(input.unitsOutstanding));
  const theta = guard('out-of-range', () => u64(t.threshold));
  const rate = guard('out-of-range', () => (t.ratePerUnitWad !== undefined ? u64(t.ratePerUnitWad) : ratePerUnit(decimalToWad(t.shareRate ?? '0'), input.unitsOffered !== undefined ? BigInt(input.unitsOffered) * BigInt(input.unitScale ?? '1') : BigInt(input.unitsOutstanding))));
  const currencyCode = guard('unsupported-currency', () => currencyCodeOf(t.reportingCurrency));
  const indexingCode = INDEXING_RULE_CODE[t.indexingRule];
  if (indexingCode === undefined) throw new DeviceError('terms-mismatch');
  const termsSalt = guard('not-field', () => field(t.termsSalt));
  const terms = guard('terms-mismatch', () => termsCommitment({ theta, rWad: rate, currency: t.reportingCurrency, indexingRule: t.indexingRule, termsSalt }));
  if (terms !== input.termsCommitment) throw new DeviceError('terms-mismatch');
  const fx = guard('out-of-range', () => u64(input.fxAvgWad));

  // the prior: the previous quarter of the same year from the device's own chain, or ZERO
  const prior = input.prior;
  const pid = guard('prior-mismatch', () => toPid(input.periodId));
  if (prior && (prior.seriesId !== input.seriesId || quarterIndex(pid) === 0 || prior.periodId !== fromPid(pid - 1))) throw new DeviceError('prior-mismatch');
  const priorYtd = prior ? guard('out-of-range', () => u64(prior.incomeYtd)) : 0n;
  const priorSalt = prior ? guard('not-field', () => field(prior.incomeSalt)) : 0n;
  const priorCommitment = prior ? guard('not-field', () => incomeCommitment(priorYtd, priorSalt)) : ZERO_INCOME_COMMITMENT;
  if (prior && prior.incomeCommitment !== priorCommitment) throw new DeviceError('prior-mismatch');

  const real = guard('out-of-range', () => u64(input.incomeYtdNow));
  const incomeYtd = real > priorYtd ? real : priorYtd; // high-water (SPEC §1.5)
  const incomeSalt = input.incomeSalt !== undefined ? guard('not-field', () => field(input.incomeSalt!)) : input.tier === 1 ? 0n : deriveIncomeSalt(input.deviceSecret, input.seriesId, input.periodId);
  const ic = guard('not-field', () => incomeCommitment(incomeYtd, incomeSalt));
  const payment = guard('out-of-range', () => paymentStable({ rWad: rate, unitsOutstanding: units, theta, incomeYtd, priorIncomeYtd: priorYtd, fxAvgWad: fx }));
  const publicInputs = guard('out-of-range', () => reportPublicInputs({ termsCommitment: terms, unitsOutstanding: units, fxAvgWad: fx, priorIncomeCommitment: priorCommitment, incomeCommitment: ic, paymentStable: payment }));

  let proof: ReportProof;
  if ((opts.proofs ?? 'groth16') === 'mock') {
    proof = { system: 'mock', proof: mockProve(publicInputs), publicInputs };
  } else {
    proof = await groth16(publicInputs, {
      terms_commitment: hex32ToField(terms), units_outstanding: units, fx_avg_wad: fx, prior_income_commitment: hex32ToField(priorCommitment), income_commitment: hex32ToField(ic), payment_usd: payment,
      theta, r_wad: rate, currency_code: BigInt(currencyCode), indexing_rule: BigInt(indexingCode), terms_salt: termsSalt, income_ytd: incomeYtd, income_salt: incomeSalt, prior_income_ytd: priorYtd, prior_salt: priorSalt,
    });
  }

  const liquidityEvent = !!input.liquidityEvent;
  let attestation: ReportAttestationRecord | null = null;
  if (input.tier === 2) {
    if (!verifier || !input.zktlsProof) throw new DeviceError('needs-zktls');
    let r: Awaited<ReturnType<ReportVerifierPort['attest']>>;
    try {
      r = await verifier.attest({
        seriesId: input.seriesId, periodId: input.periodId, tier: 2, source: input.source as IncomeSourceKind, reportingCurrency: t.reportingCurrency, zktlsProof: input.zktlsProof,
        incomeSalt: incomeSalt.toString(), incomeCommitment: ic, priorIncomeCommitment: priorCommitment,
        priorOpening: prior ? { incomeYtd: priorYtd.toString(), incomeSalt: priorSalt.toString() } : null, priorAttestation: prior?.attestation ?? null, liquidityEvent,
      });
    } catch {
      throw new DeviceError('verifier-unavailable');
    }
    if (!r.ok) throw new DeviceError('verifier-refused', r.code);
    // the record must be for this report: the verifier signed these commitments, this period and series, tier 2; and its
    // signature must recover to its named signer over its digest (defence in depth: the chain rebuilds the digest itself)
    const a = r.attestation;
    if (a.seriesId !== input.seriesId || a.periodId !== input.periodId || a.priorIncomeCommitment !== priorCommitment || a.incomeCommitment !== ic || a.tier !== 2 || a.liquidityEvent !== liquidityEvent) throw new DeviceError('verifier-refused', 'mismatch');
    let recovered: string | null = null;
    try {
      recovered = recoverSigner(a.digest, a.signature);
    } catch {
      // a malformed digest: refused below
    }
    if (recovered === null || recovered !== a.signer) throw new DeviceError('verifier-refused', 'mismatch');
    attestation = a;
  }
  // tier 1 carries no attestation (Stage 1 binds tier 1 to the router's checkpoints); tier 3 carries the attestor's REPORT
  // signature, made on the attestor's own device for the case (S4 WP9), not this one
  const entry: IncomeChainEntry = { seriesId: input.seriesId, periodId: input.periodId, incomeYtd, incomeSalt, incomeCommitment: ic, attestation };
  return {
    entry,
    assembled: { seriesId: input.seriesId, periodId: input.periodId, tier: input.tier, source: input.source, paymentStable: payment.toString(), priorIncomeCommitment: priorCommitment, incomeCommitment: ic, proof, attestation: attestation ? attestationOf(attestation) : null, liquidityEvent },
    tier3Opening: input.tier === 3
      ? { version: 'merces/tier3-opening/v1', seriesId: input.seriesId, periodId: input.periodId, incomeYtd: incomeYtd.toString(), incomeSalt: incomeSalt.toString(), priorIncomeYtd: priorYtd.toString(), priorSalt: priorSalt.toString(), priorIncomeCommitment: priorCommitment, incomeCommitment: ic }
      : null,
  };
}

type ProveInputs = Parameters<typeof import('@merces/circuits').proveReport>[0];

/** Stage 1's prover with fresh randomness (`deterministic: false`); the witness never leaves this function. */
async function groth16(publicInputs: string[], inputs: ProveInputs): Promise<ReportProof> {
  let out: Awaited<ReturnType<typeof import('@merces/circuits').proveReport>>;
  try {
    const { proveReport } = await import('@merces/circuits');
    out = await proveReport(inputs, { deterministic: false });
  } catch {
    // an unsatisfied constraint or a malformed input; the witness calculator's message is not forwarded
    throw new DeviceError('proof-failed');
  }
  const signals = out.publicSignals.map(String);
  if (signals.join(',') !== publicInputs.join(',')) throw new DeviceError('proof-failed');
  const p = out.proof as unknown as { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
  return { system: 'groth16-bn254', proof: { pi_a: p.pi_a.map(String), pi_b: p.pi_b.map((r) => r.map(String)), pi_c: p.pi_c.map(String), protocol: 'groth16', curve: 'bn128' }, publicInputs };
}

/**
 * The `submitReport` command for an assembled report, for a caller that submits directly (the simulator scenarios);
 * the API builds the same command from the stored report (`POST /reports/:id/build-submit`).
 */
export function submitReportCommand(a: AssembledReport, extra: { fxBasis: 'unity' | 'accumulator' | 'attestor'; fxAvgWad: string; pair?: string | null; fxFallback?: Attestation | null; attestation?: Attestation | null }): Extract<UserCommand, { kind: 'submitReport' }> {
  return {
    kind: 'submitReport', seriesId: a.seriesId, periodId: a.periodId, tier: a.tier, paymentStable: a.paymentStable, priorIncomeCommitment: a.priorIncomeCommitment, incomeCommitment: a.incomeCommitment,
    fxBasis: extra.fxBasis, fxAvgWad: extra.fxAvgWad, pair: extra.pair ?? null, fxFallback: extra.fxFallback ?? null, proof: a.proof,
    // tier 2: the verifier's signature the device received; tier 3: the attestor's REPORT signature (S4 WP9), from the case
    attestation: a.tier === 3 ? (extra.attestation ?? null) : a.attestation, liquidityEvent: a.liquidityEvent,
  };
}

function field(v: bigint | string): bigint {
  const x = BigInt(v);
  if (x < 0n || x >= BN254_FR) throw new DeviceError('not-field');
  return x;
}

function decimalToWad(s: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(s)) throw new DeviceError('out-of-range');
  const [w, f = ''] = s.split('.');
  return BigInt(w || '0') * WAD + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
