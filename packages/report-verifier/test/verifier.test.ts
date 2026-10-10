import { describe, expect, it } from 'vitest';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { ZERO_INCOME_COMMITMENT, attestationMessage, incomeCommitment, type VerifierAttestation } from '@merces/domain';
import { LocalKms, MockZkTls } from '@merces/ports';
import { HttpReportVerifierClient, ReportVerifier, createVerifierServer, type AttestRequest } from '../src/index.ts';

/*
 * S4 cause codes:
 *  - S4-KMS: a local KMS key id names its algorithm explicitly (S4 WP3; the verifier key stays ed25519 until S4 WP6).
 */

describe('report verifier (attestation v1: prior, liquidity event, high-water)', () => {
  const zktls = new MockZkTls();
  const kms = new LocalKms('verifier-test', { 'rv-1': 'ed25519' }); // cause S4-KMS: explicit algorithm
  const verifier = new ReportVerifier(zktls, kms, 'rv-1');
  const seriesId = 'solana:abc';
  const figure = 7_317_317_317n; // canary value
  const salt = '5761287346129834761298347612983476129834761298347612983476129834'; // a field element (decimal)
  const salt2 = '4242424242424242424242424242424242424242424242424242424242424242';
  const proofFor = (periodId: string, f: bigint, currency = 'USD', source: 'stripe' | 'deel' | 'distrokid' = 'stripe') => zktls.prove({ source, seriesId, periodId, figure: f, currency, coversUntil: 1_000, owner: 'issuer' });
  const req = (over: Partial<AttestRequest> & Pick<AttestRequest, 'periodId' | 'zktlsProof' | 'incomeCommitment'>): AttestRequest => ({
    seriesId, tier: 2, source: 'stripe', reportingCurrency: 'USD', incomeSalt: salt, priorIncomeCommitment: ZERO_INCOME_COMMITMENT, ...over,
  });
  /** a Q1 attestation, the prior of Q2 */
  async function q1(f = figure): Promise<{ attestation: VerifierAttestation; commitment: string }> {
    const commitment = incomeCommitment(f, salt);
    const r = await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proofFor('2026Q1', f), incomeCommitment: commitment }));
    if (!r.ok) throw new Error(r.code);
    return { attestation: r.attestation, commitment };
  }

  it('attests a Q1 report with the ZERO prior; the signature verifies against its published key; the figure is never echoed', async () => {
    const ic = incomeCommitment(figure, salt);
    const r = await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proofFor('2026Q1', figure), incomeCommitment: ic, liquidityEvent: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r)).not.toContain(figure.toString());
    expect(r.attestation).toMatchObject({ keyId: 'rv-1', seriesId, periodId: '2026Q1', priorIncomeCommitment: ZERO_INCOME_COMMITMENT, incomeCommitment: ic, tier: 2, liquidityEvent: true });
    const key = await verifier.publicKey();
    const pub = createPublicKey({ key: Buffer.from(key.spkiHex, 'hex'), format: 'der', type: 'spki' });
    expect(edVerify(null, Buffer.from(attestationMessage({ seriesId, periodId: '2026Q1', priorIncomeCommitment: ZERO_INCOME_COMMITMENT, incomeCommitment: ic, tier: 2, liquidityEvent: true })), pub, Buffer.from(r.attestation.signature.slice(2), 'hex'))).toBe(true);
  });

  it('refuses mismatched commitments, replayed contexts, tampered proofs, foreign currencies and non-field salts with codes only', async () => {
    const ic = incomeCommitment(figure, salt);
    const proof = proofFor('2026Q1', figure);
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proof, incomeSalt: '42', incomeCommitment: ic }))).toEqual({ ok: false, code: 'commitment-mismatch' });
    expect(await verifier.attest(req({ periodId: '2026Q2', zktlsProof: proof, incomeCommitment: ic }))).toEqual({ ok: false, code: 'wrong-context' });
    const tampered = { ...proof, extractedParameterValues: { ...proof.extractedParameterValues, grossIncome: '1' } };
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: tampered, incomeCommitment: ic }))).toEqual({ ok: false, code: 'bad-proof' });
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proofFor('2026Q1', figure, 'EUR'), reportingCurrency: 'GBP', incomeCommitment: ic }))).toEqual({ ok: false, code: 'currency-mismatch' });
    // a USD figure for a EUR series is refused too: θ and the payment are in the reporting currency (A-REP-4)
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proof, reportingCurrency: 'EUR', incomeCommitment: ic }))).toEqual({ ok: false, code: 'currency-mismatch' });
    const hashed = zktls.prove({ source: 'distrokid', seriesId, periodId: '2026Q1', figure, currency: 'USD', coversUntil: 1_000, owner: 'issuer', hashOnly: true });
    expect(await verifier.attest(req({ periodId: '2026Q1', source: 'distrokid', zktlsProof: hashed, incomeCommitment: ic }))).toEqual({ ok: false, code: 'hash-only-unsupported' });
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proof, incomeSalt: '9'.repeat(78) /* ≥ the BN254 field modulus */, incomeCommitment: ic }))).toEqual({ ok: false, code: 'not-field' });
    // a year-to-date figure of 2^64 or more cannot be committed
    const huge = 1n << 64n;
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proofFor('2026Q1', huge), incomeCommitment: ic }))).toEqual({ ok: false, code: 'not-field' });
  });

  it('prior rule: a chained prior needs its opening and this verifier\'s attestation of the previous quarter', async () => {
    const { attestation: a1, commitment: c1 } = await q1();
    const q2Figure = figure + 1_000_000_000n;
    const c2 = incomeCommitment(q2Figure, salt2);
    const opening = { incomeYtd: figure.toString(), incomeSalt: salt };
    const base = { periodId: '2026Q2', zktlsProof: proofFor('2026Q2', q2Figure), incomeSalt: salt2, incomeCommitment: c2, priorIncomeCommitment: c1 };
    const ok = await verifier.attest(req({ ...base, priorOpening: opening, priorAttestation: a1 }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.attestation).toMatchObject({ periodId: '2026Q2', priorIncomeCommitment: c1, incomeCommitment: c2 });
    // no opening, a wrong opening, no attestation, a forged or foreign attestation
    expect(await verifier.attest(req(base))).toEqual({ ok: false, code: 'prior-mismatch' });
    expect(await verifier.attest(req({ ...base, priorOpening: { ...opening, incomeYtd: '1' }, priorAttestation: a1 }))).toEqual({ ok: false, code: 'prior-mismatch' });
    expect(await verifier.attest(req({ ...base, priorOpening: opening }))).toEqual({ ok: false, code: 'prior-unattested' });
    expect(await verifier.attest(req({ ...base, priorOpening: opening, priorAttestation: { ...a1, signature: '0x' + '00'.repeat(64) } }))).toEqual({ ok: false, code: 'prior-unattested' });
    const other = await new ReportVerifier(zktls, new LocalKms('another-verifier', { 'rv-1': 'ed25519' }), 'rv-1').attest(req({ periodId: '2026Q1', zktlsProof: proofFor('2026Q1', figure), incomeCommitment: c1 }));
    if (!other.ok) throw new Error(other.code);
    expect(await verifier.attest(req({ ...base, priorOpening: opening, priorAttestation: other.attestation }))).toEqual({ ok: false, code: 'prior-unattested' });
    expect(await verifier.attest(req({ ...base, priorOpening: opening, priorAttestation: { ...a1, periodId: '2026Q3' } }))).toEqual({ ok: false, code: 'prior-unattested' });
    // a non-ZERO prior in Q1 is refused: a reporting year starts from ZERO
    expect(await verifier.attest(req({ periodId: '2026Q1', zktlsProof: proofFor('2026Q1', figure), incomeCommitment: c1, priorIncomeCommitment: c1, priorOpening: opening, priorAttestation: a1 }))).toEqual({ ok: false, code: 'prior-mismatch' });
    // ZERO is always allowed (the issuer's least favourable prior), but only with an empty opening
    expect((await verifier.attest(req({ periodId: '2026Q2', zktlsProof: proofFor('2026Q2', q2Figure), incomeSalt: salt2, incomeCommitment: c2 }))).ok).toBe(true);
    expect(await verifier.attest(req({ periodId: '2026Q2', zktlsProof: proofFor('2026Q2', q2Figure), incomeSalt: salt2, incomeCommitment: c2, priorOpening: opening }))).toEqual({ ok: false, code: 'prior-mismatch' });
  });

  it('high-water: below the prior, the committed year-to-date figure is the prior\'s (SPEC §1.5)', async () => {
    const { attestation: a1, commitment: c1 } = await q1();
    const lower = figure - 1_000_000n; // a refund lowered the real year-to-date figure
    const priorOpening = { incomeYtd: figure.toString(), incomeSalt: salt };
    const proof = proofFor('2026Q2', lower);
    expect(await verifier.attest(req({ periodId: '2026Q2', zktlsProof: proof, incomeSalt: salt2, incomeCommitment: incomeCommitment(lower, salt2), priorIncomeCommitment: c1, priorOpening, priorAttestation: a1 }))).toEqual({ ok: false, code: 'commitment-mismatch' });
    const r = await verifier.attest(req({ periodId: '2026Q2', zktlsProof: proof, incomeSalt: salt2, incomeCommitment: incomeCommitment(figure, salt2), priorIncomeCommitment: c1, priorOpening, priorAttestation: a1 }));
    expect(r.ok).toBe(true);
  });

  it('serves over HTTP with logs that carry only ids, routes, outcome codes and timings', async () => {
    const lines: string[] = [];
    const server = createVerifierServer(verifier, (l) => lines.push(l));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const client = new HttpReportVerifierClient(`http://127.0.0.1:${port}`);
    const proof = proofFor('2026Q1', figure, 'USD', 'deel');
    const ic = incomeCommitment(figure, salt);
    const ok = await client.attest(req({ periodId: '2026Q1', source: 'deel', zktlsProof: proof, incomeCommitment: ic }));
    expect(ok.ok).toBe(true);
    const bad = await client.attest(req({ periodId: '2026Q1', source: 'deel', zktlsProof: proof, incomeCommitment: '0x' + '00'.repeat(32) }));
    expect(bad).toEqual({ ok: false, code: 'commitment-mismatch' });
    expect((await client.publicKey()).keyId).toBe('rv-1');
    const res = await fetch(`http://127.0.0.1:${port}/attest`, { method: 'POST', body: '{not json' });
    expect(res.status).toBe(400);
    // an unknown field (a stray figure) is refused, and its value is not echoed
    const stray = await fetch(`http://127.0.0.1:${port}/attest`, { method: 'POST', body: JSON.stringify({ ...req({ periodId: '2026Q1', source: 'deel', zktlsProof: proof, incomeCommitment: ic }), incomeYtd: figure.toString() }) });
    expect(stray.status).toBe(400);
    expect(await stray.text()).not.toContain(figure.toString());
    server.close();
    const text = lines.join('\n');
    expect(text).toContain('outcome=attested');
    expect(text).toContain('outcome=commitment-mismatch');
    expect(text).not.toContain(figure.toString());
    expect(text).not.toContain(salt);
    expect(text).not.toContain(ic);
  });
});
