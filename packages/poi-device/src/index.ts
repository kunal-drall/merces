import { ZERO_INCOME_COMMITMENT, incomeCommitment, mockProve, randomFieldSalt, reportPublicInputs, type ReportProof, type VerifierAttestation } from '@merces/domain';
import { WAD, paymentStable, ratePerUnit } from '@merces/math';
import type { IncomeSourceKind, ZkTlsProof } from '@merces/ports';
import type { ReportVerifierPort } from '@merces/report-verifier';

/** The private terms as disclosed to the issuer (E4) — needed on the device to compute the payment. */
export interface DevicePrivateTerms {
  threshold: string;
  ratePerUnitWad?: string;
  shareRate?: string;
  reportingCurrency: string;
}

/**
 * The opening of an income commitment `Poseidon(2)(ytd, salt)` (SPEC §1.5). The device keeps the opening of its last
 * report to prove the next quarter against it; it never leaves the device (not to the API, not to the DB).
 */
export interface IncomeOpening {
  incomeYtd: bigint;
  incomeSalt: bigint;
}

export interface DeviceReportInput {
  seriesId: string;
  periodId: string;
  termsCommitment: string;
  unitsOutstanding: string;
  /** units offered at creation: r = s / N uses N offered when only shareRate is known */
  unitsOffered?: string;
  privateTerms: DevicePrivateTerms;
  /**
   * The opening of the prior income commitment the chain expects (SPEC §6.2 step 5): the previous report's opening
   * in the same year, the attested year-to-date figure on a first report outside Q1 (A25), or null at a year start
   * (ZERO = Poseidon(0, 0)).
   */
  prior: IncomeOpening | null;
  /** YTD income attested by the zkTLS proof for this quarter */
  incomeYtdNow: bigint;
  fxAvgWad: bigint;
  tier: 1 | 2;
  source: IncomeSourceKind | 'split';
  zktlsProof: ZkTlsProof | null;
  liquidityEvent?: boolean;
  /** a field element; random by default */
  incomeSalt?: bigint;
}

export interface AssembledReport {
  seriesId: string;
  periodId: string;
  tier: 1 | 2;
  /** which provider the device used — stays offchain (the service stores it for the issuer only) */
  source: string;
  paymentStable: string;
  priorIncomeCommitment: string;
  incomeCommitment: string;
  termsCommitment: string;
  fxAvgWad: string;
  proof: ReportProof;
  attestation: VerifierAttestation | null;
  liquidityEvent: boolean;
}

/**
 * Compute the payment, the income commitment and the proof, then obtain the verifier attestation.
 * Only `assembled` leaves the device: it carries commitments, the payment and the proof — never the income. The
 * returned `opening` stays on the device for the next quarter's prior.
 *
 * The proof is the mock system in Stage 1's signal layout (S1 WP10 moves the device to Stage 1's Groth16 prover).
 * The year-to-date figure is the high-water mark `max(attested, prior)` (SPEC §1.5).
 */
export async function assembleOnDevice(input: DeviceReportInput, verifier: ReportVerifierPort | null): Promise<{ assembled: AssembledReport; opening: IncomeOpening }> {
  const rate = input.privateTerms.ratePerUnitWad ? BigInt(input.privateTerms.ratePerUnitWad) : ratePerUnit(decimalToWad(input.privateTerms.shareRate ?? '0'), BigInt(input.unitsOffered ?? input.unitsOutstanding));
  const units = BigInt(input.unitsOutstanding);
  const prior = input.prior ?? { incomeYtd: 0n, incomeSalt: 0n };
  const incomeYtd = input.incomeYtdNow > prior.incomeYtd ? input.incomeYtdNow : prior.incomeYtd;
  const payment = paymentStable({ rWad: rate, unitsOutstanding: units, theta: BigInt(input.privateTerms.threshold), incomeYtd, priorIncomeYtd: prior.incomeYtd, fxAvgWad: input.fxAvgWad });
  const incomeSalt = input.incomeSalt ?? randomFieldSalt();
  const ic = incomeCommitment(incomeYtd, incomeSalt);
  const priorCommitment = input.prior ? incomeCommitment(prior.incomeYtd, prior.incomeSalt) : ZERO_INCOME_COMMITMENT;
  const publicInputs = reportPublicInputs({ termsCommitment: input.termsCommitment, unitsOutstanding: units, fxAvgWad: input.fxAvgWad, priorIncomeCommitment: priorCommitment, incomeCommitment: ic, paymentStable: payment });
  const proof: ReportProof = { system: 'mock', proof: mockProve(publicInputs), publicInputs };
  const liquidityEvent = !!input.liquidityEvent;
  let attestation: VerifierAttestation | null = null;
  if (input.tier === 2) {
    if (!verifier || !input.zktlsProof) throw new Error('tier 2 needs a zkTLS proof and a report verifier');
    const r = await verifier.attest({ seriesId: input.seriesId, periodId: input.periodId, tier: 2, source: input.source as IncomeSourceKind, reportingCurrency: input.privateTerms.reportingCurrency, zktlsProof: input.zktlsProof, incomeSalt: incomeSalt.toString(), incomeCommitment: ic, priorIncomeCommitment: priorCommitment, liquidityEvent });
    if (!r.ok) throw new Error(`verifier refused: ${r.code}`);
    attestation = r.attestation;
  }
  // tier 1 carries no attestation (Stage 1 binds tier 1 to the router's checkpoints instead)
  return {
    opening: { incomeYtd, incomeSalt },
    assembled: { seriesId: input.seriesId, periodId: input.periodId, tier: input.tier, source: input.source, paymentStable: payment.toString(), priorIncomeCommitment: priorCommitment, incomeCommitment: ic, termsCommitment: input.termsCommitment, fxAvgWad: input.fxAvgWad.toString(), proof, attestation, liquidityEvent },
  };
}

function decimalToWad(s: string): bigint {
  const [w, f = ''] = s.split('.');
  return BigInt(w || '0') * WAD + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
