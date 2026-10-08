import { incomeCommitment, mockProve, randomSalt, reportPublicInputs, type ReportProof, type VerifierAttestation } from '@merces/domain';
import { WAD, quarterPayment, ratePerUnit } from '@merces/math';
import type { IncomeSourceKind, ZkTlsProof } from '@merces/ports';
import type { ReportVerifierPort } from '@merces/report-verifier';

/** The private terms as disclosed to the issuer (E4) — needed on the device to compute the payment. */
export interface DevicePrivateTerms {
  threshold: string;
  ratePerUnitWad?: string;
  shareRate?: string;
  reportingCurrency: string;
}

export interface DeviceReportInput {
  seriesId: string;
  periodId: string;
  termsCommitment: string;
  unitsOutstanding: string;
  /** units offered at creation: r = s / N uses N offered when only shareRate is known */
  unitsOffered?: string;
  privateTerms: DevicePrivateTerms;
  /** YTD income at the end of the previous quarter of the reporting year (0 in Q1) */
  incomeYtdPrev: bigint;
  /** YTD income attested by the zkTLS proof for this quarter */
  incomeYtdNow: bigint;
  fxAvgWad: bigint;
  tier: 1 | 2;
  source: IncomeSourceKind | 'split';
  zktlsProof: ZkTlsProof | null;
  liquidityEvent?: boolean;
  salt?: string;
}

export interface AssembledReport {
  seriesId: string;
  periodId: string;
  tier: 1 | 2;
  /** which provider the device used — stays offchain (the service stores it for the issuer only) */
  source: string;
  paymentStable: string;
  incomeCommitment: string;
  termsCommitment: string;
  fxAvgWad: string;
  proof: ReportProof;
  attestation: VerifierAttestation | null;
  liquidityEvent: boolean;
}

/**
 * Compute the payment, the income commitment and the proof, then obtain the verifier attestation.
 * Only `assembled` leaves the device: it carries commitments, the payment and the proof — never the income.
 */
export async function assembleOnDevice(input: DeviceReportInput, verifier: ReportVerifierPort | null): Promise<{ assembled: AssembledReport; salt: string }> {
  const rate = input.privateTerms.ratePerUnitWad ? BigInt(input.privateTerms.ratePerUnitWad) : ratePerUnit(decimalToWad(input.privateTerms.shareRate ?? '0'), BigInt(input.unitsOffered ?? input.unitsOutstanding));
  const units = BigInt(input.unitsOutstanding);
  const q = quarterPayment({ ratePerUnitWad: rate, unitsOutstanding: units, incomeYtdPrev: input.incomeYtdPrev, incomeYtdNow: input.incomeYtdNow, threshold: BigInt(input.privateTerms.threshold), fxAvgWad: input.fxAvgWad });
  const salt = input.salt ?? randomSalt();
  const ic = incomeCommitment({ seriesId: input.seriesId, periodId: input.periodId, incomeYtd: input.incomeYtdNow, salt });
  const publicInputs = reportPublicInputs({ termsCommitment: input.termsCommitment, incomeCommitment: ic, unitsOutstanding: units, paymentStable: q.paymentStable, fxAvgWad: input.fxAvgWad, periodId: input.periodId });
  const proof: ReportProof = { system: 'mock', proof: mockProve(publicInputs, { incomeYtd: input.incomeYtdNow.toString(), threshold: input.privateTerms.threshold, ratePerUnitWad: rate.toString(), salt }), publicInputs };
  let attestation: VerifierAttestation | null = null;
  if (input.tier === 2) {
    if (!verifier || !input.zktlsProof) throw new Error('tier 2 needs a zkTLS proof and a report verifier');
    const r = await verifier.attest({ seriesId: input.seriesId, periodId: input.periodId, tier: 2, source: input.source as IncomeSourceKind, reportingCurrency: input.privateTerms.reportingCurrency, zktlsProof: input.zktlsProof, incomeSalt: salt, incomeCommitment: ic });
    if (!r.ok) throw new Error(`verifier refused: ${r.code}`);
    attestation = r.attestation;
  } else if (verifier && input.zktlsProof) {
    const r = await verifier.attest({ seriesId: input.seriesId, periodId: input.periodId, tier: 1, source: (input.source === 'split' ? 'stripe' : input.source) as IncomeSourceKind, reportingCurrency: input.privateTerms.reportingCurrency, zktlsProof: input.zktlsProof, incomeSalt: salt, incomeCommitment: ic });
    if (r.ok) attestation = r.attestation;
  }
  return { salt, assembled: { seriesId: input.seriesId, periodId: input.periodId, tier: input.tier, source: input.source, paymentStable: q.paymentStable.toString(), incomeCommitment: ic, termsCommitment: input.termsCommitment, fxAvgWad: input.fxAvgWad.toString(), proof, attestation, liquidityEvent: !!input.liquidityEvent } };
}

function decimalToWad(s: string): bigint {
  const [w, f = ''] = s.split('.');
  return BigInt(w || '0') * WAD + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
