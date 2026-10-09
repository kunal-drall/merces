import { z } from 'zod';
import { attestationMessage, incomeCommitment, type VerifierAttestation } from '@merces/domain';
import type { KmsPort, ZkTlsPort, ZkTlsProof } from '@merces/ports';

/**
 * The attestation request a device sends. The zkTLS proof carries the attested figure (unless the provider hashed
 * it); the salt lets the verifier recompute the commitment the device computed. Both exist only in memory here.
 */
export const attestRequestSchema = z.object({
  seriesId: z.string(),
  periodId: z.string().regex(/^\d{4}Q[1-4]$/),
  tier: z.union([z.literal(1), z.literal(2)]),
  source: z.enum(['stripe', 'deel', 'distrokid']),
  reportingCurrency: z.string().regex(/^[A-Z]{3}$/),
  zktlsProof: z.unknown(),
  incomeSalt: z.string().min(8),
  incomeCommitment: z.string().regex(/^0x[0-9a-f]{64}$/),
});
export type AttestRequest = z.infer<typeof attestRequestSchema>;

export interface AttestResult {
  ok: true;
  attestation: VerifierAttestation;
}
export interface AttestFailure {
  ok: false;
  /** a code, never the figure or any payload */
  code: 'bad-proof' | 'wrong-context' | 'currency-mismatch' | 'commitment-mismatch' | 'hash-only-unsupported';
}

export interface ReportVerifierPort {
  attest(req: AttestRequest): Promise<AttestResult | AttestFailure>;
  publicKey(): Promise<{ keyId: string; spkiHex: string; rawHex: string }>;
}

/**
 * The verifier core. It unavoidably sees the attested figure in memory; it must therefore:
 *  - keep no state beyond the signing key handle,
 *  - never log a request body, a figure or a salt (callers log only the returned code),
 *  - sign only the tuple {series, period, income_commitment, tier}; the source is checked against the proof but never signed (B7).
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
    const v = await this.zktls.verify(req.zktlsProof as ZkTlsProof, { seriesId: req.seriesId, periodId: req.periodId });
    if (!v.ok) return { ok: false, code: v.error?.includes('replay') || v.error?.includes('another') ? 'wrong-context' : 'bad-proof' };
    if (v.source !== req.source) return { ok: false, code: 'bad-proof' };
    if (v.currency.toUpperCase() !== req.reportingCurrency && !(v.currency.toUpperCase() === 'USD')) return { ok: false, code: 'currency-mismatch' }; // A-REP-4: sources must be in the reporting currency or USD
    if (v.figure === null) return { ok: false, code: 'hash-only-unsupported' }; // Part J.3: hash-attesting providers need a commitment scheme agreed with Reclaim
    const expected = incomeCommitment({ seriesId: req.seriesId, periodId: req.periodId, incomeYtd: v.figure, salt: req.incomeSalt });
    if (expected !== req.incomeCommitment) return { ok: false, code: 'commitment-mismatch' };
    // the signed tuple names no source: the provider is checked here and stays offchain (B7)
    const msg = attestationMessage({ seriesId: req.seriesId, periodId: req.periodId, incomeCommitment: req.incomeCommitment, tier: req.tier });
    const signature = '0x' + (await this.kms.sign(this.keyId, msg));
    return { ok: true, attestation: { keyId: this.keyId, seriesId: req.seriesId, periodId: req.periodId, incomeCommitment: req.incomeCommitment, tier: req.tier, signature } };
  }
}
