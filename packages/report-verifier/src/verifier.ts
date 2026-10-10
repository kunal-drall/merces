import { createPublicKey, verify as edVerify } from 'node:crypto';
import { z } from 'zod';
import { ZERO_INCOME_COMMITMENT, attestationMessage, incomeCommitment, verifierAttestationSchema, type VerifierAttestation } from '@merces/domain';
import { fromPid, quarterIndex, toPid } from '@merces/math';
import type { KmsPort, ZkTlsPort, ZkTlsProof } from '@merces/ports';

const decimal = z.string().regex(/^\d{1,78}$/);
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

/**
 * The attestation request a device sends (tier 2). The zkTLS proof carries the attested year-to-date figure (unless
 * the provider hashed it); the salt (a field element, decimal) lets the verifier recompute the Poseidon commitment the
 * device computed. A non-ZERO prior comes with its opening and with this verifier's attestation of the previous
 * quarter. All of it exists only in memory here.
 */
export const attestRequestSchema = z.object({
  seriesId: z.string(),
  periodId: z.string().regex(/^\d{4}Q[1-4]$/),
  /** tier 2 only: tier 1 is bound to the split router's checkpoints and tier 3 to an attestor, not to this verifier */
  tier: z.literal(2),
  source: z.enum(['stripe', 'deel', 'distrokid']),
  reportingCurrency: z.string().regex(/^[A-Z]{3}$/),
  zktlsProof: z.unknown(),
  incomeSalt: decimal,
  incomeCommitment: hex32,
  /** the commitment the report chains from: ZERO (`Poseidon(0, 0)`) at a year start */
  priorIncomeCommitment: hex32,
  /** the opening of a non-ZERO prior (decimal strings); null (or 0/0) with ZERO */
  priorOpening: z.object({ incomeYtd: decimal, incomeSalt: decimal }).strict().nullable().default(null),
  /** this verifier's attestation of the previous quarter of the same year, whose income commitment is the prior */
  priorAttestation: verifierAttestationSchema.nullable().default(null),
  /** the device's declaration (owner question 1: zkTLS data cannot show it; the verifier signs the declared flag) */
  liquidityEvent: z.boolean().default(false),
}).strict();
export type AttestRequest = z.input<typeof attestRequestSchema>;

export interface AttestResult {
  ok: true;
  attestation: VerifierAttestation;
}

/** Refusal codes. A code never carries the figure, a salt or any payload. */
export type AttestFailureCode =
  | 'bad-proof'
  | 'wrong-context'
  | 'currency-mismatch'
  | 'commitment-mismatch'
  | 'hash-only-unsupported'
  | 'not-field'
  /** the prior is not ZERO in Q1, or its opening does not open it */
  | 'prior-mismatch'
  /** a non-ZERO prior without this verifier's valid attestation of the previous quarter */
  | 'prior-unattested';

export interface AttestFailure {
  ok: false;
  code: AttestFailureCode;
}

export interface ReportVerifierPort {
  attest(req: AttestRequest): Promise<AttestResult | AttestFailure>;
  publicKey(): Promise<{ keyId: string; spkiHex: string; rawHex: string }>;
}

/**
 * The verifier core. It unavoidably sees the attested figure and the openings in memory; it must therefore:
 *  - keep no state beyond the signing key handle,
 *  - never log a request body, a figure or a salt (callers log only the returned code),
 *  - sign only attestation v1 {series, period, prior and income commitments, tier, liquidity event}; the source is
 *    checked against the proof but never signed (B7).
 *
 * What it checks, in order:
 *  1. the zkTLS proof verifies for this series and period, from the declared source;
 *  2. the figure is in the series' reporting currency (θ and the payment are in that currency; nothing onchain
 *     would catch a figure in another one, A-REP-4) and is a figure, not a hash;
 *  3. the prior (SPEC §6.2 step 5): ZERO is always allowed (it is the issuer's least favourable prior). A non-ZERO
 *     prior is refused in Q1, and otherwise needs its opening and this verifier's own attestation of the previous
 *     quarter of the same year with that income commitment. The chain checks a chained prior itself; for a series'
 *     first report outside Q1 (A25) it accepts the prior as given, and this binding is what authenticates it;
 *  4. the high-water rule (SPEC §1.5): the committed year-to-date figure is `max(attested, prior)`, so
 *     `incomeCommitment = Poseidon(2)(max(figure, priorYtd), incomeSalt)`.
 */
export class ReportVerifier implements ReportVerifierPort {
  constructor(
    private readonly zktls: ZkTlsPort,
    private readonly kms: KmsPort,
    private readonly keyId: string,
  ) {}

  async publicKey(): Promise<{ keyId: string; spkiHex: string; rawHex: string }> {
    const { publicKeyHex } = await this.kms.publicKey(this.keyId);
    return { keyId: this.keyId, spkiHex: await this.kms.spkiHex(this.keyId), rawHex: publicKeyHex };
  }

  async attest(req: AttestRequest): Promise<AttestResult | AttestFailure> {
    const fail = (code: AttestFailureCode): AttestFailure => ({ ok: false, code });
    if (req.tier !== 2) return fail('wrong-context');
    const v = await this.zktls.verify(req.zktlsProof as ZkTlsProof, { seriesId: req.seriesId, periodId: req.periodId });
    if (!v.ok) return fail(v.error?.includes('replay') || v.error?.includes('another') ? 'wrong-context' : 'bad-proof');
    if (v.source !== req.source) return fail('bad-proof');
    if (v.currency.toUpperCase() !== req.reportingCurrency.toUpperCase()) return fail('currency-mismatch');
    if (v.figure === null) return fail('hash-only-unsupported'); // Part J.3: hash-attesting providers need a commitment scheme agreed with Reclaim

    const prior = await this.priorYtd(req);
    if (typeof prior !== 'bigint') return prior;
    const ytd = v.figure > prior ? v.figure : prior; // high-water (SPEC §1.5)
    let expected: string;
    try {
      expected = incomeCommitment(ytd, req.incomeSalt); // Poseidon(2)(ytd, salt)
    } catch {
      return fail('not-field'); // the salt is not a field element, or the figure is out of the u64 range
    }
    if (expected !== req.incomeCommitment) return fail('commitment-mismatch');
    // the signed tuple names no source: the provider is checked here and stays offchain (B7)
    const tuple = { seriesId: req.seriesId, periodId: req.periodId, priorIncomeCommitment: req.priorIncomeCommitment, incomeCommitment: req.incomeCommitment, tier: 2 as const, liquidityEvent: req.liquidityEvent ?? false };
    const signature = '0x' + (await this.kms.sign(this.keyId, attestationMessage(tuple)));
    return { ok: true, attestation: { keyId: this.keyId, ...tuple, signature } };
  }

  /** The prior's year-to-date figure under the prior rule (step 3), or the refusal. */
  private async priorYtd(req: AttestRequest): Promise<bigint | AttestFailure> {
    const o = req.priorOpening ?? null;
    // decimal strings (the HTTP schema checks them; an in-process caller may not): never parse one into an error message
    const dec = (v: string): bigint | null => (typeof v === 'string' && /^\d{1,78}$/.test(v) ? BigInt(v) : null);
    if (o && (dec(o.incomeYtd) === null || dec(o.incomeSalt) === null)) return { ok: false, code: 'not-field' };
    if (req.priorIncomeCommitment === ZERO_INCOME_COMMITMENT) {
      if (o && (dec(o.incomeYtd) !== 0n || dec(o.incomeSalt) !== 0n)) return { ok: false, code: 'prior-mismatch' };
      return 0n;
    }
    const pid = toPid(req.periodId);
    if (quarterIndex(pid) === 0) return { ok: false, code: 'prior-mismatch' }; // a reporting year starts from ZERO
    if (!o) return { ok: false, code: 'prior-mismatch' };
    let opened: string;
    try {
      opened = incomeCommitment(o.incomeYtd, o.incomeSalt);
    } catch {
      return { ok: false, code: 'not-field' };
    }
    if (opened !== req.priorIncomeCommitment) return { ok: false, code: 'prior-mismatch' };
    const a = req.priorAttestation ?? null;
    if (!a || a.keyId !== this.keyId || a.seriesId !== req.seriesId || a.periodId !== fromPid(pid - 1) || a.incomeCommitment !== req.priorIncomeCommitment || a.tier !== 2) return { ok: false, code: 'prior-unattested' };
    if (!(await this.verifyOwn(a))) return { ok: false, code: 'prior-unattested' };
    return dec(o.incomeYtd)!;
  }

  /** An attestation this verifier signed (its own key; the verifier keeps no chain registry). */
  private async verifyOwn(a: VerifierAttestation): Promise<boolean> {
    try {
      const pub = createPublicKey({ key: Buffer.from(await this.kms.spkiHex(this.keyId), 'hex'), format: 'der', type: 'spki' });
      const msg = attestationMessage({ seriesId: a.seriesId, periodId: a.periodId, priorIncomeCommitment: a.priorIncomeCommitment, incomeCommitment: a.incomeCommitment, tier: a.tier, liquidityEvent: a.liquidityEvent });
      return edVerify(null, Buffer.from(msg), pub, Buffer.from(a.signature.replace(/^0x/, ''), 'hex'));
    } catch {
      return false;
    }
  }
}
