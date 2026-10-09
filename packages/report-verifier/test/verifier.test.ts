import { describe, expect, it } from 'vitest';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { ZERO_INCOME_COMMITMENT, attestationMessage, incomeCommitment } from '@merces/domain';
import { LocalKms, MockZkTls } from '@merces/ports';
import { HttpReportVerifierClient, ReportVerifier, createVerifierServer } from '../src/index.ts';

describe('report verifier', () => {
  const zktls = new MockZkTls();
  const kms = new LocalKms('verifier-test');
  const verifier = new ReportVerifier(zktls, kms, 'rv-1');
  const seriesId = 'solana:abc';
  const periodId = '2026Q1';
  const figure = 7_317_317_317n; // canary value
  const salt = '5761287346129834761298347612983476129834761298347612983476129834'; // a field element (decimal)
  const prior = ZERO_INCOME_COMMITMENT;

  it('attests a valid proof with a signature that verifies against its published key, and never echoes the figure', async () => {
    const proof = zktls.prove({ source: 'stripe', seriesId, periodId, figure, currency: 'USD', coversUntil: 1_000, owner: 'issuer' });
    const ic = incomeCommitment(figure, salt);
    const r = await verifier.attest({ seriesId, periodId, tier: 2, source: 'stripe', reportingCurrency: 'USD', zktlsProof: proof, incomeSalt: salt, incomeCommitment: ic, priorIncomeCommitment: prior });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r)).not.toContain(figure.toString());
    const key = await verifier.publicKey();
    const pub = createPublicKey({ key: Buffer.from(key.spkiHex, 'hex'), format: 'der', type: 'spki' });
    expect(r.attestation.priorIncomeCommitment).toBe(prior);
    expect(r.attestation.liquidityEvent).toBe(false);
    expect(edVerify(null, Buffer.from(attestationMessage({ seriesId, periodId, priorIncomeCommitment: prior, incomeCommitment: ic, tier: 2, liquidityEvent: false })), pub, Buffer.from(r.attestation.signature.slice(2), 'hex'))).toBe(true);
  });

  it('refuses mismatched commitments, replayed contexts, tampered proofs and foreign currencies with codes only', async () => {
    const proof = zktls.prove({ source: 'stripe', seriesId, periodId, figure, currency: 'USD', coversUntil: 1_000, owner: 'issuer' });
    const ic = incomeCommitment(figure, salt);
    expect((await verifier.attest({ seriesId, periodId, tier: 2, source: 'stripe', reportingCurrency: 'USD', zktlsProof: proof, incomeSalt: '42', incomeCommitment: ic, priorIncomeCommitment: prior }))).toEqual({ ok: false, code: 'commitment-mismatch' });
    expect((await verifier.attest({ seriesId, periodId: '2026Q2', tier: 2, source: 'stripe', reportingCurrency: 'USD', zktlsProof: proof, incomeSalt: salt, incomeCommitment: ic, priorIncomeCommitment: prior }))).toEqual({ ok: false, code: 'wrong-context' });
    const tampered = { ...proof, extractedParameterValues: { ...proof.extractedParameterValues, grossIncome: '1' } };
    expect((await verifier.attest({ seriesId, periodId, tier: 2, source: 'stripe', reportingCurrency: 'USD', zktlsProof: tampered, incomeSalt: salt, incomeCommitment: ic, priorIncomeCommitment: prior }))).toEqual({ ok: false, code: 'bad-proof' });
    const eur = zktls.prove({ source: 'stripe', seriesId, periodId, figure, currency: 'EUR', coversUntil: 1_000, owner: 'issuer' });
    expect((await verifier.attest({ seriesId, periodId, tier: 2, source: 'stripe', reportingCurrency: 'GBP', zktlsProof: eur, incomeSalt: salt, incomeCommitment: ic, priorIncomeCommitment: prior }))).toEqual({ ok: false, code: 'currency-mismatch' });
    const hashed = zktls.prove({ source: 'distrokid', seriesId, periodId, figure, currency: 'USD', coversUntil: 1_000, owner: 'issuer', hashOnly: true });
    expect((await verifier.attest({ seriesId, periodId, tier: 2, source: 'distrokid', reportingCurrency: 'USD', zktlsProof: hashed, incomeSalt: salt, incomeCommitment: ic, priorIncomeCommitment: prior }))).toEqual({ ok: false, code: 'hash-only-unsupported' });
    expect((await verifier.attest({ seriesId, periodId, tier: 2, source: 'stripe', reportingCurrency: 'USD', zktlsProof: proof, incomeSalt: '9'.repeat(78), /* ≥ the BN254 field modulus */ incomeCommitment: ic, priorIncomeCommitment: prior }))).toEqual({ ok: false, code: 'not-field' });
  });

  it('serves over HTTP with logs that carry only ids, routes, outcome codes and timings', async () => {
    const lines: string[] = [];
    const server = createVerifierServer(verifier, (l) => lines.push(l));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const client = new HttpReportVerifierClient(`http://127.0.0.1:${port}`);
    const proof = zktls.prove({ source: 'deel', seriesId, periodId, figure, currency: 'USD', coversUntil: 1_000, owner: 'issuer' });
    const ic = incomeCommitment(figure, salt);
    const ok = await client.attest({ seriesId, periodId, tier: 2, source: 'deel', reportingCurrency: 'USD', zktlsProof: proof, incomeSalt: salt, incomeCommitment: ic, priorIncomeCommitment: prior });
    expect(ok.ok).toBe(true);
    const bad = await client.attest({ seriesId, periodId, tier: 2, source: 'deel', reportingCurrency: 'USD', zktlsProof: proof, incomeSalt: salt, incomeCommitment: '0x' + '00'.repeat(32), priorIncomeCommitment: prior });
    expect(bad).toEqual({ ok: false, code: 'commitment-mismatch' });
    expect((await client.publicKey()).keyId).toBe('rv-1');
    const res = await fetch(`http://127.0.0.1:${port}/attest`, { method: 'POST', body: '{not json' });
    expect(res.status).toBe(400);
    server.close();
    const text = lines.join('\n');
    expect(text).toContain('outcome=attested');
    expect(text).toContain('outcome=commitment-mismatch');
    expect(text).not.toContain(figure.toString());
    expect(text).not.toContain(salt);
    expect(text).not.toContain(ic);
  });
});
