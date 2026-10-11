import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import type { UnsignedTx } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import { generateE2eKeyPair, sealTier3Opening } from '@merces/poi-device';
import type { PrivateTerms, SimHarness } from '@merces/simulator';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/*
 * The curve census around reports (S3 WP9, amendment H1). On a curve series the report proof's units are the census
 * (Stage 1 binds it when the report is submitted, income.rs:376-381; anyone may take one at any time, curve.rs:936-963):
 * assembling and the tier-3 path refuse a census older than the period's end with the sync step (CurveUnitsNotSynced),
 * a proof over another count is `census-changed`, building the submission refuses a census that moved since assembly,
 * and Merces' own census builder waits while an assembled report is not submitted.
 *
 * S3 cause codes:
 *  - S3-CN: the curve census (syncCurveUnits, the CurveUnitsNotSynced gate, redeem's own census).
 *
 * S4 cause codes:
 *  - S4-ID: attestors are keys linked to an account (S4 WP7): access is the account's linked key (`rig.attestorToken`);
 *  - S4-T3: the attestor signs Stage 1's REPORT message with tier 3 (S4 WP9; was the key's EIP-191 text), and the
 *    report carries the stored signature (no `attestor` co-signer in the body).
 */

/** Stand-in for the client's end-to-end encryption of documents (opaque bytes; the server never decrypts). */
const opaque = () => randomBytes(96).toString('base64');
const ATTESTOR_E2E = generateE2eKeyPair();

describe.skipIf(!dbTestsEnabled())('curve census around reports (S3 WP9, amendment H1)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let h: SimHarness;
  let seriesId: string;
  let privateTerms: PrivateTerms;
  let termsCommitment: string;
  let issuerTok: string;
  let anyoneTok: string;
  let attTok: string;

  beforeAll(async () => {
    rig = await makeRig();
    h = rig.sol;
    const c = await h.createCurve();
    seriesId = c.seriesId;
    privateTerms = c.privateTerms;
    termsCommitment = c.terms.termsCommitment;
    await h.fillCurve(seriesId);
    issuerTok = rig.token({ accountId: 'iss-curve', wallets: [{ chain: h.sim.chain, address: h.issuer.address }], roles: ['issuer'] });
    anyoneTok = rig.token({ accountId: 'acct-any', wallets: [{ chain: h.sim.chain, address: h.backers[3]!.address }] });
    attTok = await rig.attestorToken('att-curve', [h.attestors[0]!]); // cause S4-ID: attestor access is the account's linked key
    await rig.sync();
  });
  afterAll(async () => {
    await rig.close();
  });

  /** The device's assembled report (the harness proves with mock proofs; the rig accepts them). */
  async function device(periodId: string, incomeYtdNow: bigint, tier: 2 | 3 = 2) {
    const { command } = await h.buildReport({ seriesId, periodId, privateTerms, termsCommitment, incomeYtdNow, tier, attestor: tier === 3 ? h.attestors[0]! : null });
    // cause S4-T3: a tier-3 body names no co-signer; the service carries the attestor's signature stored with the case
    return {
      command,
      body: { periodId, tier, source: 'stripe', paymentStable: command.paymentStable, priorIncomeCommitment: command.priorIncomeCommitment, incomeCommitment: command.incomeCommitment, proof: command.proof, attestation: tier === 2 ? command.attestation : null },
    };
  }

  const send = async (tx: UnsignedTx, who = h.issuer, tok = issuerTok) => rig.post('/tx/send', await who.sign(tx), tok);

  // cause S3-CN: assemble and build-submit follow the census (H1); build-sync waits for an assembled report
  it('assemble: 409 CurveUnitsNotSynced with the sync step; build-sync; census-changed; build-submit refuses a moved census; build-sync waits for the report', async () => {
    await h.sim.setTime(parsePeriod('2026Q1').end + 3_600);
    await rig.sync();
    // the schedule names the census as the next step
    const schedule = (await rig.get(`/series/${seriesId}/reporting/schedule`, issuerTok)).json();
    expect(schedule.periods.map((p: { periodId: string; nextStep: string }) => [p.periodId, p.nextStep])).toEqual([['2026Q1', 'sync-curve-units']]);
    // no census yet: the device proved over 0 units; the API refuses before checking the proof, naming the sync step
    const stale = await device('2026Q1', USDC(70_000));
    const refused = await rig.post(`/series/${seriesId}/reports`, stale.body, issuerTok);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().detail).toMatchObject({ stage1: 'CurveUnitsNotSynced', periodId: '2026Q1', periodEnd: parsePeriod('2026Q1').end, unitsSyncedAt: null, next: { step: 'sync-curve-units', command: { kind: 'syncCurveUnits', seriesId } } });

    // any account builds the census for one of its wallets (permissionless), and only for its own wallets
    expect((await rig.post(`/series/${seriesId}/curve/build-sync`, { signer: h.backers[0]!.address }, anyoneTok)).statusCode).toBe(403);
    const built = await rig.post(`/series/${seriesId}/curve/build-sync`, { signer: h.backers[3]!.address }, anyoneTok);
    expect(built.statusCode, built.body).toBe(200);
    expect(built.json()).toMatchObject({ seriesId, changes: true, census: { unitsOutstanding: '100000000', redemptionUnits: '100000000', synced: null, changedSinceSync: true } });
    expect((built.json().tx as UnsignedTx).command).toEqual({ kind: 'syncCurveUnits', seriesId });
    const synced = await send(built.json().tx as UnsignedTx, h.backers[3]!, anyoneTok);
    expect(synced.statusCode, synced.body).toBe(200);
    expect(synced.json().events.map((e: { type: string }) => e.type)).toEqual(['CurveUnitsSynced']);

    // the census is fresh now, but the device's proof is over 0 units: prove again over the census
    const over0 = await rig.post(`/series/${seriesId}/reports`, stale.body, issuerTok);
    expect(over0.statusCode).toBe(409);
    expect(over0.json().detail).toEqual({ stage1: 'InvalidProof', reason: 'census-changed', unitsOutstanding: '100000000', next: 're-prove' });
    const fresh = await device('2026Q1', USDC(70_000));
    expect(fresh.command.proof.publicInputs[1]).toBe('100000000');
    const assembled = await rig.post(`/series/${seriesId}/reports`, fresh.body, issuerTok);
    expect(assembled.statusCode, assembled.body).toBe(201);
    const reportId = assembled.json().reportId as string;
    expect(assembled.json().state).toBe('assembled');

    // our builders take no census while the issuer's assembled report waits: its proof is over the current count
    const pending = await rig.post(`/series/${seriesId}/curve/build-sync`, { signer: h.backers[3]!.address }, anyoneTok);
    expect(pending.statusCode).toBe(409);
    expect(pending.json().detail).toEqual({ reason: 'report-pending', periodId: '2026Q1', reportId });

    // anyone may still take a census onchain (Stage 1 sync_curve_units is permissionless): units bought out of the DAMM
    // pool become outstanding, and the assembled report's proof is now over the old count
    await h.sim.curveHook(seriesId, { kind: 'migrate' });
    await h.sim.curveHook(seriesId, { kind: 'dammTrade', wallet: h.backers[3]!.address, units: 100_000n });
    await h.syncCurve(seriesId, h.backers[4]);
    const moved = await rig.post(`/reports/${reportId}/build-submit`, {}, issuerTok);
    expect(moved.statusCode).toBe(409);
    expect(moved.json().detail).toEqual({ stage1: 'InvalidProof', reason: 'census-changed', unitsOutstanding: '100100000', next: 're-assemble' });
    // what the assembly returned would fail onchain for the same reason
    const failed = await send(assembled.json().tx as UnsignedTx);
    expect(failed.statusCode).toBe(422);
    expect(failed.json()).toMatchObject({ error: 'ChainInvalidProof', detail: { stage1: 'InvalidProof' } });

    // re-assembled over the new census: submitted and accepted; the census builder is open again (Q2 is next)
    const again = await device('2026Q1', USDC(70_000));
    const reassembled = await rig.post(`/series/${seriesId}/reports`, again.body, issuerTok);
    expect(reassembled.statusCode, reassembled.body).toBe(201);
    const submit = await rig.post(`/reports/${reassembled.json().reportId}/build-submit`, {}, issuerTok);
    expect(submit.statusCode, submit.body).toBe(200);
    const accepted = await send(submit.json().tx as UnsignedTx);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().events[0].type).toBe('ReportAccepted');
    await rig.post(`/reports/${reassembled.json().reportId}/submitted`, { txId: accepted.json().txId }, issuerTok);
    const pay = await rig.post(`/reports/${reassembled.json().reportId}/build-payin`, {}, issuerTok);
    expect((await send(pay.json().tx as UnsignedTx)).statusCode).toBe(200);
    await rig.sync();
    expect((await rig.post(`/series/${seriesId}/curve/build-sync`, { signer: h.backers[3]!.address }, anyoneTok)).json()).toMatchObject({ changes: false });
  });

  // cause S3-CN: the tier-3 path follows the census too (H1; attestor/service.ts): the case opens once a census
  // postdates the period's end, and the attestor signs a proof over the census only
  it('tier 3: the case opens after a census; the attestor signs a proof over the census only (409 otherwise)', async () => {
    const att = h.attestors[0]!;
    await h.sim.setTime(parsePeriod('2026Q2').end + 3_600);
    await rig.sync();
    const open = (body: Record<string, unknown> = {}) => rig.post(`/series/${seriesId}/tier3/2026Q2`, { attestor: att.address, documentsCiphertext: opaque(), openingCiphertext: sealTier3Opening({ version: 'merces/tier3-opening/v1', seriesId, periodId: '2026Q2', incomeYtd: '0', incomeSalt: '0', priorIncomeYtd: '0', priorSalt: '0', priorIncomeCommitment: '0x' + '0'.repeat(64), incomeCommitment: '0x' + '0'.repeat(64) }, ATTESTOR_E2E.publicKey), estimatePaymentStable: USDC(500).toString(), ...body }, issuerTok);
    // the last census predates the end of 2026Q2
    const early = await open();
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json().detail).toMatchObject({ stage1: 'CurveUnitsNotSynced', periodId: '2026Q2', next: { step: 'sync-curve-units' } });
    await h.syncCurve(seriesId);
    const opened = await open();
    expect(opened.statusCode, opened.body).toBe(201);
    const caseId = opened.json().caseId as string;
    const view = (await rig.get(`/attestor/tier3/${caseId}`, attTok)).json();
    const series = (await h.sim.getSeries(seriesId))!;
    expect(view).toMatchObject({ unitsOutstanding: series.unitsOutstanding, unitsSyncedAt: series.unitsSyncedAt });

    // the issuer proved Q2 over the census; then a census moves the count before the attestor signs
    const proved = await device('2026Q2', USDC(75_000), 3);
    const sign = async (proof = proved.command.proof) => {
      const c = { seriesId, periodId: '2026Q2', priorIncomeCommitment: proved.command.priorIncomeCommitment, incomeCommitment: proved.command.incomeCommitment };
      // cause S4-T3: the key's Stage 1 REPORT signature with tier 3 over the chain's domain and the series key
      const attestation = await att.attest('REPORT', (await h.sim.info()).signing!, (await h.sim.getSeries(seriesId))!.seriesKey, { ...c, tier: 3, liquidityEvent: false });
      return rig.post(`/attestor/tier3/${caseId}/sign`, { priorIncomeCommitment: c.priorIncomeCommitment, incomeCommitment: c.incomeCommitment, liquidityEvent: false, proof, attestation }, attTok);
    };
    await h.sim.curveHook(seriesId, { kind: 'dammTrade', wallet: h.backers[3]!.address, units: 50_000n });
    await h.syncCurve(seriesId);
    const changed = await sign();
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().detail).toEqual({ stage1: 'InvalidProof', reason: 'census-changed', unitsOutstanding: '100150000', next: 're-prove' });
    // proved again over the current census (the same commitments: the attestor's signature over them stands): signed,
    // then assembled carrying the attestor's stored signature
    const reproved = await device('2026Q2', USDC(75_000), 3);
    expect(reproved.command.incomeCommitment).toBe(proved.command.incomeCommitment);
    expect(reproved.command.proof.publicInputs[1]).toBe('100150000');
    const signed = await sign(reproved.command.proof);
    expect(signed.statusCode, signed.body).toBe(200);
    const assembled = await rig.post(`/series/${seriesId}/reports`, reproved.body, issuerTok);
    expect(assembled.statusCode, assembled.body).toBe(201);
  });

  // cause S3-CN, amendment M4: the redemption quote's N on a curve is the count redeem's own census takes now (the DAMM
  // pool not subtracted, B-C13), not the last regular census
  it("the redemption quote counts redeem's own census on a curve", async () => {
    const curve = (await h.sim.getCurve(seriesId))!;
    const q = (await rig.get(`/series/${seriesId}/redemption/quote`, issuerTok)).json();
    expect(q).toMatchObject({ unitsCounted: 'redemption-census', unitsOutstanding: curve.census.redemptionUnits });
    expect(BigInt(curve.census.redemptionUnits)).toBeGreaterThan(BigInt(curve.census.unitsOutstanding)); // the DAMM pool holds units
  });
});
