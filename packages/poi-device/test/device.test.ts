import { afterAll, describe, expect, it } from 'vitest';
import { WAD, ratePerUnit } from '@merces/math';
import { ZERO_INCOME_COMMITMENT, incomeCommitment, reportPublicInputs, termsCommitment } from '@merces/domain';
import { Groth16ReportVerifier, LocalKms, MockZkTls, shutdownProofSystem } from '@merces/ports';
import { ReportVerifier } from '@merces/report-verifier';
import { DeviceError, MemoryIncomeChain, assembleOnDevice, checkTier3Opening, choosePrior, deriveIncomeSalt, type DeviceReportInput, type DevicePrivateTerms } from '../src/index.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const CANARY_YTD = 7_317_317_317n;
const rWad = ratePerUnit(10n ** 17n, 500n);
const privateTerms: DevicePrivateTerms = { threshold: USDC(5_000).toString(), ratePerUnitWad: rWad.toString(), reportingCurrency: 'USD', indexingRule: 'cpi-annual', termsSalt: '123456789123456789123456789' };
const terms = termsCommitment({ theta: privateTerms.threshold, rWad, currency: 'USD', indexingRule: 'cpi-annual', termsSalt: privateTerms.termsSalt });
const seriesId = 'solana:device-series';
const secret = 'device-secret-not-for-production';

const zktls = new MockZkTls();
const verifier = new ReportVerifier(zktls, new LocalKms('device-test'), 'rv-device');
const proofFor = (periodId: string, figure: bigint) => zktls.prove({ source: 'stripe', seriesId, periodId, figure, currency: 'USD', coversUntil: 1_000, owner: 'issuer' });
const input = (over: Partial<DeviceReportInput> & Pick<DeviceReportInput, 'periodId' | 'incomeYtdNow'>): DeviceReportInput => ({
  seriesId, termsCommitment: terms, unitsOutstanding: '500', privateTerms, prior: null, fxAvgWad: WAD, tier: 2, source: 'stripe', deviceSecret: secret, zktlsProof: proofFor(over.periodId, over.incomeYtdNow), ...over,
});

afterAll(shutdownProofSystem);

describe('poi-device: Stage 1 Groth16 reports from the device income chain', () => {
  it('proves a Q1 report with Stage 1\'s prover; only commitments, the payment and the proof leave the device', async () => {
    const r = await assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD }), verifier);
    const a = r.assembled;
    expect(a.proof.system).toBe('groth16-bn254');
    expect(a.priorIncomeCommitment).toBe(ZERO_INCOME_COMMITMENT);
    expect(a.proof.publicInputs).toEqual(reportPublicInputs({ termsCommitment: terms, unitsOutstanding: 500n, fxAvgWad: WAD, priorIncomeCommitment: ZERO_INCOME_COMMITMENT, incomeCommitment: a.incomeCommitment, paymentStable: a.paymentStable }));
    expect(await new Groth16ReportVerifier().verify(a.proof.proof, a.proof.publicInputs)).toBe(true);
    expect(a.attestation).toMatchObject({ seriesId, periodId: '2026Q1', tier: 2, incomeCommitment: a.incomeCommitment, priorIncomeCommitment: ZERO_INCOME_COMMITMENT });
    // the salt comes from the device secret, so a reinstalled device rebuilds the opening from its own records
    expect(r.entry.incomeSalt).toBe(deriveIncomeSalt(secret, seriesId, '2026Q1'));
    expect(r.entry.incomeSalt).not.toBe(deriveIncomeSalt('another-device', seriesId, '2026Q1'));
    expect(r.entry.incomeSalt).not.toBe(deriveIncomeSalt(secret, seriesId, '2026Q2'));
    expect(incomeCommitment(r.entry.incomeYtd, r.entry.incomeSalt)).toBe(a.incomeCommitment);
    const leaving = JSON.stringify(a);
    expect(leaving).not.toContain(CANARY_YTD.toString());
    expect(leaving).not.toContain(r.entry.incomeSalt.toString());
    expect(r.tier3Opening).toBeNull();
  });

  it('chains Q2 from its own Q1 entry: the verifier gets the prior opening and attestation; the high-water rule holds', async () => {
    const chain = new MemoryIncomeChain();
    const q1 = await assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: USDC(80_000) }), verifier, { proofs: 'mock' });
    chain.put(q1.entry);
    expect(choosePrior(chain, seriesId, '2026Q2', q1.entry.incomeCommitment)).toBe(q1.entry);
    expect(() => choosePrior(chain, seriesId, '2026Q2', '0x' + '01'.repeat(32))).toThrow(DeviceError);
    expect(choosePrior(chain, seriesId, '2026Q2', ZERO_INCOME_COMMITMENT)).toBeNull();
    expect(choosePrior(chain, seriesId, '2026Q2', null)).toBe(q1.entry); // A25: the chain accepts the prior as given
    // a refund lowered the real year-to-date figure: the committed figure stays at the prior's, the payment is 0
    const q2 = await assembleOnDevice(input({ periodId: '2026Q2', incomeYtdNow: USDC(70_000), prior: chain.get(seriesId, '2026Q1')! }), verifier);
    expect(q2.assembled.priorIncomeCommitment).toBe(q1.entry.incomeCommitment);
    expect(q2.entry.incomeYtd).toBe(USDC(80_000));
    expect(q2.assembled.paymentStable).toBe('0');
    expect(await new Groth16ReportVerifier().verify(q2.assembled.proof.proof, q2.assembled.proof.publicInputs)).toBe(true);
  });

  it('maps every failure to a code and never puts a value in a message', async () => {
    const codeOf = async (p: Promise<unknown>) => {
      const e = await p.then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(DeviceError);
      for (const v of [CANARY_YTD.toString(), (1n << 64n).toString(), privateTerms.threshold, privateTerms.termsSalt]) expect((e as Error).message).not.toContain(v);
      return [(e as DeviceError).code, (e as DeviceError).verifierCode];
    };
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: 1n << 64n }), verifier))).toEqual(['out-of-range', null]);
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD, privateTerms: { ...privateTerms, termsSalt: '1' } }), verifier))).toEqual(['terms-mismatch', null]);
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD, privateTerms: { ...privateTerms, reportingCurrency: 'XXX' } }), verifier))).toEqual(['unsupported-currency', null]);
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD, privateTerms: { ...privateTerms, threshold: (1n << 64n).toString() } }), verifier))).toEqual(['out-of-range', null]);
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD, zktlsProof: null }), verifier))).toEqual(['needs-zktls', null]);
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD, zktlsProof: proofFor('2026Q1', CANARY_YTD + 1n) }), verifier, { proofs: 'mock' }))).toEqual(['verifier-refused', 'commitment-mismatch']);
    const q1 = await assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD }), verifier, { proofs: 'mock' });
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q3', incomeYtdNow: CANARY_YTD, prior: q1.entry }), verifier, { proofs: 'mock' }))).toEqual(['prior-mismatch', null]);
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q2', incomeYtdNow: CANARY_YTD, prior: { ...q1.entry, incomeYtd: 1n } }), verifier, { proofs: 'mock' }))).toEqual(['prior-mismatch', null]);
  });

  it('tier 3: the device proves; the opening for the attestor checks against the commitments and the documents', async () => {
    const r = await assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: USDC(80_000), tier: 3, source: 'attestor', zktlsProof: null }), null, { proofs: 'mock' });
    expect(r.assembled.attestation).toBeNull();
    const o = r.tier3Opening!;
    const c = { seriesId, periodId: '2026Q1', priorIncomeCommitment: r.assembled.priorIncomeCommitment, incomeCommitment: r.assembled.incomeCommitment };
    expect(checkTier3Opening(o, { ...c, documentedYtd: USDC(80_000) })).toEqual({ ok: true });
    expect(checkTier3Opening(o, { ...c, documentedYtd: USDC(90_000) })).toEqual({ ok: false, code: 'not-high-water' });
    expect(checkTier3Opening({ ...o, incomeSalt: '7' }, { ...c, documentedYtd: USDC(80_000) })).toEqual({ ok: false, code: 'commitment-mismatch' });
    expect(checkTier3Opening(o, { ...c, periodId: '2026Q2', documentedYtd: USDC(80_000) })).toEqual({ ok: false, code: 'wrong-context' });
  });
});
