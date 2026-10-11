import { afterAll, describe, expect, it } from 'vitest';
import { WAD, ratePerUnit } from '@merces/math';
import { E2E_HEADER_BYTES, E2E_TAG_BYTES, E2E_TIER3_OPENING, ZERO_INCOME_COMMITMENT, incomeCommitment, parseE2eEnvelope, reportDigest, reportPublicInputs, seriesKeyOf, termsCommitment } from '@merces/domain';
import { Groth16ReportVerifier, LocalKms, MockZkTls, shutdownProofSystem } from '@merces/ports';
import { ReportVerifier, verifierChainsFromPorts, type ReportVerifierPort } from '@merces/report-verifier';
import { SimulatorChain, deriveAddress } from '@merces/simulator';
import * as deviceModule from '../src/index.ts';
import { DeviceError, E2eError, MemoryIncomeChain, assembleOnDevice, checkTier3Opening, choosePrior, deriveIncomeSalt, generateE2eKeyPair, openE2e, openTier3Opening, sealE2e, sealTier3Opening, submitReportCommand, type DeviceReportInput, type DevicePrivateTerms } from '../src/index.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
/*
 * S3 cause codes:
 *  - S3-UL: a curve series' r is per base lamport (unit scale 10^6; S3 WP8).
 * S4 cause codes:
 *  - S4-KMS: a local KMS key id names its algorithm explicitly (S4 WP3).
 *  - S4-T2: the verifier's key is secp256k1 and it signs Stage 1's REPORT message under the series' chain's domain, from
 *    a chain table that tests derive from the simulator's `ChainInfo.signing` (S4 amendment D10), for a series id with a
 *    series key there; the device keeps the verifier's record and sends `{signer, signature}` with the report.
 *  - S4-T3: a tier-3 report carries the attestor key's Stage 1 REPORT signature (made on the attestor's device for the
 *    case), the FX fallback the attestor's per-series FX signature (S4 WP9): `submitReportCommand` takes both, names no
 *    co-signer, and the EIP-191 tier-3 text is gone (cause S4-CS: the retired names spelled in parts, for the S4 WP13
 *    grep gate).
 */
const CANARY_YTD = 7_317_317_317n;
const rWad = ratePerUnit(10n ** 17n, 500n);
const privateTerms: DevicePrivateTerms = { threshold: USDC(5_000).toString(), ratePerUnitWad: rWad.toString(), reportingCurrency: 'USD', indexingRule: 'cpi-annual', termsSalt: '123456789123456789123456789' };
const terms = termsCommitment({ theta: privateTerms.threshold, rWad, currency: 'USD', indexingRule: 'cpi-annual', termsSalt: privateTerms.termsSalt });
// cause S4-T2: a series address of the chain's family (it has a series key), on a simulator chain whose domain the verifier holds
const sim = SimulatorChain.createSync({ personality: 'solana' });
const seriesId = `${sim.chain}:${deriveAddress('solana', 'series:device-series')}`;
const secret = 'device-secret-not-for-production';

const zktls = new MockZkTls();
const verifierKms = new LocalKms('device-test', { 'rv-device': 'secp256k1' }); // cause S4-KMS, S4-T2: explicit algorithm, secp256k1
const verifier = new ReportVerifier(zktls, verifierKms, { keyId: 'rv-device', chains: () => verifierChainsFromPorts([sim]), allowLocal: true }); // cause S4-T2
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
    // cause S4-T2: the report carries the verifier key's signature only; the device keeps the verifier's record for the next prior
    expect(a.attestation).toEqual({ signer: await verifierKms.signerAddress('rv-device'), signature: r.entry.attestation!.signature });
    expect(r.entry.attestation).toMatchObject({ chain: sim.chain, seriesId, periodId: '2026Q1', tier: 2, incomeCommitment: a.incomeCommitment, priorIncomeCommitment: ZERO_INCOME_COMMITMENT });
    expect(r.entry.attestation!.digest).toBe(reportDigest({ domain: (await sim.info()).signing!.domain, seriesKey: seriesKeyOf(seriesId, 'solana') }, { periodId: '2026Q1', priorIncomeCommitment: ZERO_INCOME_COMMITMENT, incomeCommitment: a.incomeCommitment, tier: 2, liquidityEvent: false }).digest);
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
    // cause S4-T2: a verifier record for anything but this report (here another liquidity flag) is refused, never kept
    const liar: ReportVerifierPort = {
      publicKey: () => verifier.publicKey(),
      attest: async (q) => {
        const r = await verifier.attest(q);
        return r.ok ? { ok: true, attestation: { ...r.attestation, liquidityEvent: !r.attestation.liquidityEvent } } : r;
      },
    };
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD }), liar, { proofs: 'mock' }))).toEqual(['verifier-refused', 'mismatch']);
    // nor a record whose signature does not recover to its named signer over its digest (S4 WP6 fix 1, defence in depth)
    const forger: ReportVerifierPort = {
      publicKey: () => verifier.publicKey(),
      attest: async (q) => {
        const r = await verifier.attest(q);
        return r.ok ? { ok: true, attestation: { ...r.attestation, signer: '0x' + '33'.repeat(20) } } : r;
      },
    };
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD }), forger, { proofs: 'mock' }))).toEqual(['verifier-refused', 'mismatch']);
    const garbled: ReportVerifierPort = {
      publicKey: () => verifier.publicKey(),
      attest: async (q) => {
        const r = await verifier.attest(q);
        return r.ok ? { ok: true, attestation: { ...r.attestation, digest: 'not-a-digest' } } : r;
      },
    };
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD }), garbled, { proofs: 'mock' }))).toEqual(['verifier-refused', 'mismatch']);
    const q1 = await assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD }), verifier, { proofs: 'mock' });
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q3', incomeYtdNow: CANARY_YTD, prior: q1.entry }), verifier, { proofs: 'mock' }))).toEqual(['prior-mismatch', null]);
    expect(await codeOf(assembleOnDevice(input({ periodId: '2026Q2', incomeYtdNow: CANARY_YTD, prior: { ...q1.entry, incomeYtd: 1n } }), verifier, { proofs: 'mock' }))).toEqual(['prior-mismatch', null]);
  });

  // cause S3-UL: on a curve series r is per base lamport (Stage 1 registry lib.rs:594-600, B-C2): a device that knows only
  // the share rate derives r over the units offered × the series' unit scale (10^6), as the terms service does
  it('derives r per base lamport from the share rate on a curve series (units offered × the unit scale)', async () => {
    const shareTerms: DevicePrivateTerms = { threshold: privateTerms.threshold, shareRate: '0.10', reportingCurrency: 'USD', indexingRule: 'cpi-annual', termsSalt: privateTerms.termsSalt };
    const curveTerms = termsCommitment({ theta: privateTerms.threshold, rWad: 1_000_000_000n, currency: 'USD', indexingRule: 'cpi-annual', termsSalt: privateTerms.termsSalt }); // 0.10 WAD / 10^8
    const curveInput = (unitScale?: string) => input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD, termsCommitment: curveTerms, unitsOutstanding: '99999998', unitsOffered: '100', unitScale, privateTerms: shareTerms });
    const r = await assembleOnDevice(curveInput('1000000'), verifier, { proofs: 'mock' });
    expect(r.assembled.proof.publicInputs[0]).toBe(BigInt(curveTerms).toString());
    // without the scale the device would derive r per whole unit, which opens another commitment
    const e = await assembleOnDevice(curveInput(), verifier, { proofs: 'mock' }).then(() => null, (x: unknown) => x);
    expect((e as DeviceError).code).toBe('terms-mismatch');
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

  it('cause S4-T3: submitReportCommand carries the tier-3 attestation and the FX fallback it is given, and no co-signer', async () => {
    // the retired EIP-191 tier-3 text builder is gone (its name spelled in parts for the S4 WP13 grep gate)
    expect(['tier3Attestation', 'Text'].join('') in deviceModule).toBe(false);
    const t3 = await assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: USDC(80_000), tier: 3, source: 'attestor', zktlsProof: null }), null, { proofs: 'mock' });
    const sig = { signer: '0x' + 'ab'.repeat(20), signature: '0x' + '11'.repeat(65) };
    const fx = { signer: '0x' + 'cd'.repeat(20), signature: '0x' + '22'.repeat(65) };
    const cmd = submitReportCommand(t3.assembled, { fxBasis: 'attestor', fxAvgWad: WAD.toString(), pair: 'EUR/USD', fxFallback: fx, attestation: sig });
    expect(cmd).toMatchObject({ kind: 'submitReport', tier: 3, attestation: sig, fxFallback: fx, fxBasis: 'attestor', pair: 'EUR/USD' });
    expect(cmd).not.toHaveProperty('attestor');
    expect(cmd).not.toHaveProperty(['attestor', 'Rate'].join(''));
    // tier 2 keeps the verifier's signature the device received; an attestation given beside it is not used
    const t2 = await assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: USDC(80_000) }), verifier, { proofs: 'mock' });
    const c2 = submitReportCommand(t2.assembled, { fxBasis: 'unity', fxAvgWad: WAD.toString(), attestation: sig });
    expect(c2.attestation).toEqual(t2.assembled.attestation);
    expect(c2.fxFallback).toBeNull();
  });

  // S1 review: the API took any base64/hex-looking string as the opening "ciphertext", so a hex encoding of the opening
  // was stored at rest. The opening now travels in a merces-e2e v1 envelope, which the API parses and refuses otherwise.
  it('tier 3: the opening is sealed for the attestor in a merces-e2e v1 envelope; only the attestor\'s key opens it', async () => {
    const r = await assembleOnDevice(input({ periodId: '2026Q1', incomeYtdNow: CANARY_YTD, tier: 3, source: 'attestor', zktlsProof: null }), null, { proofs: 'mock' });
    const o = r.tier3Opening!;
    const attestor = generateE2eKeyPair();
    const other = generateE2eKeyPair();
    const env = sealTier3Opening(o, attestor.publicKey);
    // the shape the server checks: version 0x01, a 32-byte ephemeral key, a 12-byte nonce, the sealed opening and its tag
    const parsed = parseE2eEnvelope(env, E2E_TIER3_OPENING);
    expect(parsed.ok).toBe(true);
    const bytes = Buffer.from(env, 'base64');
    expect(bytes[0]).toBe(0x01);
    expect(bytes.length).toBe(E2E_HEADER_BYTES + Buffer.byteLength(JSON.stringify(o)) + E2E_TAG_BYTES);
    // nothing of the opening is readable in the envelope, in any encoding
    for (const v of [CANARY_YTD.toString(), o.incomeSalt, o.incomeCommitment.slice(2)]) {
      expect(env).not.toContain(v);
      expect(bytes.toString('latin1')).not.toContain(v);
      expect(bytes.toString('hex')).not.toContain(Buffer.from(v).toString('hex'));
    }
    // fresh ephemeral key and nonce every time
    const again = sealTier3Opening(o, attestor.publicKey);
    expect(again).not.toBe(env);
    expect(Buffer.from(again, 'base64').subarray(1, E2E_HEADER_BYTES).equals(bytes.subarray(1, E2E_HEADER_BYTES))).toBe(false);
    // the attestor's device opens it and checks it
    const opened = openTier3Opening(env, attestor.privateKey);
    expect(opened).toEqual(o);
    expect(checkTier3Opening(opened, { seriesId, periodId: '2026Q1', priorIncomeCommitment: r.assembled.priorIncomeCommitment, incomeCommitment: r.assembled.incomeCommitment, documentedYtd: CANARY_YTD })).toEqual({ ok: true });
    // another key, another purpose, or a changed byte (header or body) does not open; errors carry a code only
    const codeOfOpen = (f: () => unknown): string | null => {
      try {
        f();
        return null;
      } catch (e) {
        expect(e).toBeInstanceOf(E2eError);
        expect(`${(e as Error).message}${(e as Error).stack}`).not.toContain(CANARY_YTD.toString());
        return (e as E2eError).code;
      }
    };
    expect(codeOfOpen(() => openTier3Opening(env, other.privateKey))).toBe('cannot-open');
    expect(codeOfOpen(() => openE2e(sealE2e(JSON.stringify(o), attestor.publicKey, 'merces/other/v1'), attestor.privateKey, E2E_TIER3_OPENING))).toBe('cannot-open');
    for (const at of [1, 40, E2E_HEADER_BYTES + 3, bytes.length - 1]) {
      const t = Buffer.from(bytes);
      t[at] = t[at]! ^ 0x01;
      expect(codeOfOpen(() => openTier3Opening(t.toString('base64'), attestor.privateKey)), `byte ${at}`).toBe('cannot-open');
    }
    // a well-formed envelope of something that is not an opening is refused after opening
    expect(codeOfOpen(() => openTier3Opening(sealE2e(JSON.stringify({ version: 'merces/tier3-opening/v0', note: 'x'.repeat(80) }), attestor.publicKey, E2E_TIER3_OPENING.purpose), attestor.privateKey))).toBe('not-an-opening');
    // encodings of the opening are not envelopes
    for (const enc of [Buffer.from(JSON.stringify(o)).toString('hex'), Buffer.from(JSON.stringify(o)).toString('base64')]) expect(codeOfOpen(() => openTier3Opening(enc, attestor.privateKey))).toBe('malformed');
    expect(codeOfOpen(() => sealTier3Opening(o, 'not-a-key'))).toBe('bad-key');
    expect(codeOfOpen(() => sealTier3Opening(o, Buffer.alloc(32).toString('base64')))).toBe('bad-key');
  });
});
