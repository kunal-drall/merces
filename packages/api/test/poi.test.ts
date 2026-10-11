import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { stripeFixtureFor, stripeGrossUntil } from '@merces/fixtures';
import { parsePeriod, periodOf, ratePerUnit, wadFromDecimal } from '@merces/math';
import { MemoryIncomeChain, assembleOnDevice, choosePrior } from '@merces/poi-device';
import { ZERO_INCOME_COMMITMENT, mockProve, type UnsignedTx } from '@merces/domain';
import { createServiceContext, serviceRoutes } from '@merces/services';
import { SimSigner } from '@merces/simulator';
import { buildApp, makeContext } from '../src/index.ts';
import { SECRET, makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/*
 * Pins that moved with Stage 1 (S1 WP12) carry a cause code:
 *  - PF: Stage 1's report proof format: a Groth16 (BN254) proof over six public signals (terms commitment, units, FX,
 *    prior income commitment, income commitment, payment), and Groth16 is the only system a process accepts unless it is
 *    simulator-only and started with MERCES_PROOF_SYSTEM=mock (H3); the test rig opts into mock proofs as well;
 *  - R: Stage 1's report rules: reports are sequential (WrongPeriod), and each report proves against the prior the
 *    chain expects (SIM:1096-1103): ZERO at a year start, else the last accepted report's income commitment.
 *
 * S4 cause codes:
 *  - S4-T2: tier 2 carries the report verifier key's Stage 1 REPORT signature `{signer, signature}` (S4 WP6); the service
 *    recomputes the digest from the chain's signing domain and the series key, recovers the signer and reads the
 *    chain's verifier key record (422 otherwise); `/reporting/verifier` serves the verifier's address and chains;
 *  - S4-FX: the FX fallback is an attestor key's Stage 1 FX signature for the series (S4 WP9), stored through the attestor
 *    routes; the service carries the stored one into the report (the body has no `attestorRate`) and checks it against
 *    the chain again; the issuer sends the report alone (no co-signer).
 */

describe.skipIf(!dbTestsEnabled())('M3 ProofOfIncome (E5) through the API with Stripe test data', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  for (const personality of ['solana', 'monad'] as const) {
    it(`${personality}: tier-2 quarter — zkTLS proof → verifier attestation → assemble → submit → pay in → holders claim`, async () => {
      const h = rig.harness(personality);
      const raise = await h.runRaise();
      const seriesId = raise.seriesId;
      const issuerTok = rig.token({ accountId: `iss-${personality}`, wallets: [{ chain: h.sim.chain, address: h.issuer.address }], roles: ['issuer'] });
      // the device's view of the private terms (as disclosed by E4: the opening of the Poseidon terms commitment)
      const privateTerms = { threshold: raise.privateTerms.theta.toString(), shareRate: '0.10', reportingCurrency: 'USD', indexingRule: raise.privateTerms.indexingRule, termsSalt: raise.privateTerms.termsSalt.toString() };
      const fixture = stripeFixtureFor(`iss-${personality}`, 2026, [USDC(25_000), USDC(50_000), USDC(75_000), USDC(100_000)]);
      // Q3 is over
      await h.sim.setTime(parsePeriod('2026Q3').end + 86_400);
      await rig.sync();
      const schedule = await rig.get(`/series/${seriesId}/reporting/schedule`, issuerTok);
      expect(schedule.statusCode).toBe(200);
      expect(schedule.json().periods.map((p: { periodId: string; nextStep: string }) => [p.periodId, p.nextStep])).toEqual([['2026Q1', 'assemble-report'], ['2026Q2', 'assemble-report'], ['2026Q3', 'assemble-report']]);
      expect(schedule.json().fxBasis).toBe('unity');
      const sources = await rig.get('/income-sources');
      expect(sources.json().sources.map((s: { kind: string }) => s.kind)).toEqual(['stripe', 'deel', 'distrokid']);
      const artifacts = (await rig.get('/prover/artifacts')).json();
      expect(artifacts).toMatchObject({ system: 'groth16-bn254', trustedSetup: 'development', acceptedSystems: ['groth16-bn254', 'mock'] });
      expect(artifacts.publicInputLayout).toHaveLength(6);
      const wasm = await rig.get(artifacts.wasm.url);
      expect(wasm.statusCode).toBe(200);
      expect(wasm.headers['x-content-sha256']).toBe(artifacts.wasm.sha256);
      expect(wasm.rawPayload.length).toBe(artifacts.wasm.bytes);

      // the device keeps its income chain (openings and attestations) for the next quarter's prior; it never reaches the API
      const chain = new MemoryIncomeChain();
      const deviceSecret = `device-secret-${personality}`;
      for (const q of ['2026Q1', '2026Q2', '2026Q3']) {
        const period = parsePeriod(q);
        // 1. zkTLS session (device completes it with the provider; here the mock proves from the Stripe fixture)
        const sess = await rig.post(`/series/${seriesId}/reporting/zktls-session`, { periodId: q, source: 'stripe' }, issuerTok);
        expect(sess.statusCode).toBe(200);
        expect(sess.json().verifier.url).toBe('http://verifier.test');
        const ytdCents = stripeGrossUntil(fixture, period.end);
        const ytd = ytdCents * 10_000n;
        const zktlsProof = rig.zktls.prove({ source: 'stripe', seriesId, periodId: q, figure: ytd, currency: 'USD', coversUntil: period.end, owner: h.issuer.address, sessionId: sess.json().sessionId });
        // 2. device: the prior the chain expects (public), then commitment + Stage 1 Groth16 proof + attestation from the verifier (direct, not via the API)
        const expected = (await rig.get(`/series/${seriesId}/reporting/prior`)).json();
        expect(expected).toMatchObject({ periodId: q, nextExpectedPeriod: q, rule: q === '2026Q1' ? 'year-start' : 'chained', acceptsSuppliedPrior: false });
        // the year starts from ZERO; later quarters chain from the last accepted report (cause R)
        if (q === '2026Q1') expect(expected.expectedPriorIncomeCommitment).toBe(ZERO_INCOME_COMMITMENT);
        else expect(expected.expectedPriorIncomeCommitment).toBe(chain.get(seriesId, q === '2026Q2' ? '2026Q1' : '2026Q2')!.incomeCommitment);
        const prior = choosePrior(chain, seriesId, q, expected.expectedPriorIncomeCommitment);
        const { assembled, entry } = await assembleOnDevice({ seriesId, periodId: q, termsCommitment: raise.terms.termsCommitment, unitsOutstanding: '500', unitsOffered: '500', privateTerms, prior, incomeYtdNow: ytd, fxAvgWad: 10n ** 18n, tier: 2, source: 'stripe', zktlsProof, deviceSecret }, rig.verifier);
        chain.put(entry);
        // the device proves with Stage 1's Groth16 by default (cause PF; was a mock digest over our own input layout)
        expect(assembled.proof.system).toBe('groth16-bn254');
        expect(assembled.proof.publicInputs).toHaveLength(6);
        expect(assembled.priorIncomeCommitment).toBe(expected.expectedPriorIncomeCommitment);
        expect(JSON.stringify(assembled)).not.toContain(ytd.toString());
        if (q === '2026Q2') {
          // reports are sequential (Stage 1 WrongPeriod): the API refuses a later quarter before the chain would
          const ahead = await rig.post(`/series/${seriesId}/reports`, { ...assembled, periodId: '2026Q3' }, issuerTok);
          expect(ahead.statusCode).toBe(409);
          expect(ahead.json().detail).toMatchObject({ stage1: 'WrongPeriod', nextExpectedPeriod: '2026Q2' });
          // a report that does not chain from Q1 (here: the year-start ZERO again) is refused before its proof is checked,
          // naming the prior the chain will require (cause R: Stage 1 InvalidProof "prior commitment mismatch")
          const unchained = await rig.post(`/series/${seriesId}/reports`, { ...assembled, priorIncomeCommitment: ZERO_INCOME_COMMITMENT }, issuerTok);
          expect(unchained.statusCode).toBe(422);
          expect(unchained.json().detail).toEqual({ expectedPrior: expected.expectedPriorIncomeCommitment });
          // the body is strict: a stray year-to-date figure is refused, and never echoed or stored
          const stray = await rig.post(`/series/${seriesId}/reports`, { ...assembled, incomeYtd: ytd.toString() }, issuerTok);
          expect(stray.statusCode).toBe(400);
          expect(stray.body).not.toContain(ytd.toString());
          // a payment no u64 holds reaches the circuit's range check, which the API wraps: a fixed message, no value
          const tooBig = (1n << 64n).toString();
          const unfit = await rig.post(`/series/${seriesId}/reports`, { ...assembled, paymentStable: tooBig }, issuerTok);
          expect(unfit.statusCode, unfit.body).toBe(422);
          expect(unfit.json()).toEqual({ error: 'Unprocessable', message: 'the report does not fit the circuit: the series terms commitment is not a Poseidon commitment, or an amount is out of range', detail: null });
          expect(unfit.body).not.toContain(tooBig);
        }
        // 3. assemble through the API (offchain verification) → unsigned submitReport
        const rep = await rig.post(`/series/${seriesId}/reports`, assembled, issuerTok, { 'idempotency-key': `rep-${personality}-${q}` });
        expect(rep.statusCode, JSON.stringify(rep.json())).toBe(201);
        expect(rep.json().verifiedOffchain).toBe(true);
        expect(rep.json().priorIncomeCommitment).toBe(assembled.priorIncomeCommitment);
        const reportId = rep.json().reportId as string;
        const tx = rep.json().tx as UnsignedTx;
        expect(tx.command.kind).toBe('submitReport');
        // 4. sign + send
        const sent = await rig.post('/tx/send', await h.issuer.sign(tx), issuerTok);
        expect(sent.statusCode, JSON.stringify(sent.json())).toBe(200);
        const accepted = sent.json().events.find((e: { type: string }) => e.type === 'ReportAccepted');
        expect(accepted).toBeTruthy();
        expect(accepted.payload.priorIncomeCommitment).toBe(expected.expectedPriorIncomeCommitment); // cause R
        const sub = await rig.post(`/reports/${reportId}/submitted`, { txId: sent.json().txId }, issuerTok);
        if (q === '2026Q3') {
          expect(sub.json().state).toBe('accepted');
          expect(accepted.payload.paymentDue).toBe(USDC(1500).toString());
          // 5. pay in exactly what the chain says
          const pay = await rig.post(`/reports/${reportId}/build-payin`, {}, issuerTok);
          expect(pay.json().amount).toBe(USDC(1500).toString());
          const paid = await rig.post('/tx/send', await h.issuer.sign(pay.json().tx), issuerTok);
          expect(paid.statusCode).toBe(200);
          expect((await rig.post(`/reports/${reportId}/paid`, { txId: paid.json().txId }, issuerTok)).json().state).toBe('paid');
          expect((await rig.post(`/reports/${reportId}/build-payin`, {}, issuerTok)).statusCode).toBe(409);
        } else {
          expect(sub.json().state).toBe('paid'); // zero payment = complete
          expect(accepted.payload.paymentDue).toBe('0');
        }
      }
      await rig.sync();
      // holders see the payment and can claim
      const holderTok = rig.token({ accountId: `b0-${personality}`, wallets: [{ chain: h.sim.chain, address: h.backers[0]!.address }], roles: ['backer'] });
      const periods = await rig.get(`/series/${seriesId}/periods`, holderTok);
      expect(periods.json().periods.find((p: { periodId: string }) => p.periodId === '2026Q3').paid).toBe(USDC(1500).toString());
      const claim = await h.sim.build({ kind: 'claimPayout', seriesId }, h.backers[0]!.address);
      const claimed = await rig.post('/tx/send', await h.backers[0]!.sign(claim), holderTok);
      expect(claimed.json().events[0].payload.amount).toBe(USDC(285).toString());
      // the report store holds commitments and amounts, never the figure or the salt
      const rows = await rig.t.pool.query('select row_to_json(r)::text as j from reports r where series_id = $1', [seriesId]);
      for (const r of rows.rows) {
        expect(r.j).not.toContain((USDC(75_000)).toString());
        expect(r.j).not.toContain((USDC(50_000)).toString());
      }
      const reportsView = await rig.get(`/series/${seriesId}/reports`, holderTok);
      expect(reportsView.json().reports).toHaveLength(3);
    });
  }

  it('cause S4-T2: /reporting/verifier serves the verifier\'s address and the chains it signs for, each with the chain\'s own signing domain', async () => {
    const r = await rig.get('/reporting/verifier');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      url: 'http://verifier.test',
      address: await rig.kms.signerAddress('report-verifier-test'),
      chains: [{ chain: rig.sol.sim.chain, domain: (await rig.sol.sim.info()).signing }, { chain: rig.mon.sim.chain, domain: (await rig.mon.sim.info()).signing }],
    });
  });

  it('rejects bad attestations, wrong public inputs, tier 4, and demands an attestor\'s FX signature when FX is flagged', async () => {
    const h = rig.harness('solana');
    const raise = await h.runRaise({ privateTerms: { theta: 50_000_000_000n, rWad: ratePerUnit(wadFromDecimal('0.10'), 500n), currency: 'EUR', indexingRule: 'cpi-annual', termsSalt: BigInt('0x' + '55'.repeat(31)) }, terms: { reportingCurrency: 'EUR' } });
    const seriesId = raise.seriesId;
    const issuerTok = rig.token({ accountId: 'iss-eur', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    // the shared simulator is already past 2026Q3 (previous test); this raise settles in Q4, so Q4 is its first reportable quarter
    const q = '2026Q4';
    await h.sim.setTime(parsePeriod(q).end + 86_400);
    await rig.sync();
    const fx = await rig.get(`/series/${seriesId}/reporting/fx/${q}`, issuerTok);
    expect(fx.json()).toMatchObject({ basis: 'attestor', pair: 'EUR/USD', reason: 'coverage' });
    const privateTerms = { threshold: '50000000000', shareRate: '0.10', reportingCurrency: 'EUR', indexingRule: 'cpi-annual' as const, termsSalt: BigInt('0x' + '55'.repeat(31)).toString() };
    const ytd = 70_000_000_000n;
    const zktlsProof = rig.zktls.prove({ source: 'deel', seriesId, periodId: q, figure: ytd, currency: 'EUR', coversUntil: parsePeriod(q).end, owner: h.issuer.address });
    const rate = wadFromDecimal('1.08');
    const { assembled } = await assembleOnDevice({ seriesId, periodId: q, termsCommitment: raise.terms.termsCommitment, unitsOutstanding: '500', unitsOffered: '500', privateTerms, prior: null, incomeYtdNow: ytd, fxAvgWad: rate, tier: 2, source: 'deel', zktlsProof, deviceSecret: 'device-secret-eur' }, rig.verifier);
    // no FX signature for this series yet → 422 with the fx detail (cause S4-FX: was "an attestor-signed rate")
    const noRate = await rig.post(`/series/${seriesId}/reports`, assembled, issuerTok);
    expect(noRate.statusCode).toBe(422);
    expect(noRate.json().message).toContain('an attestor\'s FX signature for this series is required');
    // cause S4-FX: the body takes no rate or co-signer (strict): the attestor signs through the attestor routes
    expect((await rig.post(`/series/${seriesId}/reports`, { ...assembled, attestorRate: { attestor: h.attestors[1]!.address, rateWad: rate.toString() } }, issuerTok)).statusCode).toBe(400);
    // the attestor key signs Stage 1's FX message for every covered series on its device; the service stores them
    const fxSigned = await rig.signFxFallback(h, 'EUR/USD', q, h.attestors[1]!, rate.toString());
    expect((fxSigned.signatures as { seriesId: string }[]).map((x) => x.seriesId)).toContain(seriesId);
    // wrong public inputs (payment tampered)
    const tampered = { ...assembled, paymentStable: '1' };
    expect((await rig.post(`/series/${seriesId}/reports`, tampered, issuerTok)).statusCode).toBe(422);
    // cause S4-T2: a forged attestation (65 bytes that recover to no one, or to another key), a malformed one (400), the
    // signature of a key that is not a verifier key, and another report's signature: each 422 InvalidVerifierSignature
    const refuse = async (attestation: unknown, status = 422) => {
      const r = await rig.post(`/series/${seriesId}/reports`, { ...assembled, attestation }, issuerTok);
      expect(r.statusCode, JSON.stringify(r.json())).toBe(status);
      return r.json();
    };
    expect((await refuse({ ...assembled.attestation!, signature: '0x' + '11'.repeat(65) })).detail).toEqual({ stage1: 'InvalidVerifierSignature' });
    await refuse({ ...assembled.attestation!, signature: '0x' + '11'.repeat(64) }, 400);
    await refuse({ keyId: 'report-verifier-test', ...assembled.attestation! }, 400);
    expect((await refuse({ ...assembled.attestation!, signer: '0x' + '5e'.repeat(20) })).message).toMatch(/not the report verifier's signature/);
    const series = (await h.sim.getSeries(seriesId))!;
    const fields = { periodId: q, priorIncomeCommitment: assembled.priorIncomeCommitment, incomeCommitment: assembled.incomeCommitment, tier: 2 as const, liquidityEvent: false };
    const stranger = await new SimSigner('sim-verifier:not-registered').attest('REPORT', (await h.sim.info()).signing!, series.seriesKey, fields);
    expect((await refuse({ signer: stranger.signer, signature: stranger.signature })).message).toMatch(/not a verifier key usable/);
    const otherReport = await h.verifier.attest('REPORT', (await h.sim.info()).signing!, series.seriesKey, { ...fields, liquidityEvent: true });
    expect((await refuse({ signer: otherReport.signer, signature: otherReport.signature })).message).toMatch(/not the report verifier's signature/);
    // cause S4-T2: a chain whose signing domain is not known yet (a live adapter before S5) cannot have a tier-2 report
    // checked: 409 signing-domain-unknown, nothing stored
    {
      const blind = new Proxy(h.sim, {
        get(target, k) {
          if (k === 'info') return async () => ({ ...(await target.info()), signing: null });
          const v = Reflect.get(target, k);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      const chains = { ...rig.ctx.chains, chains: new Map([...rig.ctx.chains.chains].map(([k, v]) => [k, k === h.sim.chain ? blind : v])), get: (c: string) => (c === h.sim.chain ? blind : rig.ctx.chains.get(c)) };
      const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as never;
      const ctx = createServiceContext(makeContext({ pool: rig.t.pool, chains: chains as never, log: silent, sessionSecret: SECRET, devMode: true }), { esign: rig.esign, identity: rig.identity, zktls: rig.zktls, kms: rig.kms, verifier: rig.verifier, reportVerifierUrl: 'http://verifier.test', proofVerifier: rig.ctx.proofVerifier });
      const app = await buildApp(ctx, serviceRoutes);
      await app.ready();
      try {
        const r = await app.inject({ method: 'POST', url: `/series/${seriesId}/reports`, payload: assembled as never, headers: { authorization: `Bearer ${issuerTok}` } });
        expect([r.statusCode, r.json().detail]).toEqual([409, { reason: 'signing-domain-unknown' }]);
      } finally {
        await app.close();
      }
    }
    // tier 4 is off
    expect((await rig.post(`/series/${seriesId}/reports`, { ...assembled, tier: 4 }, issuerTok)).statusCode).toBe(403);
    // cause S4-FX: the stored FX signature is checked against the chain again: one that no longer recovers to its signer
    // over this series' FX message (here: altered at rest) is 422 InvalidAttestorSignature, nothing stored
    const fxRow = (await rig.t.pool.query('select request_id, signature from fx_fallback_signatures where series_id = $1', [seriesId])).rows[0];
    await rig.t.pool.query('update fx_fallback_signatures set signature = $2 where series_id = $1', [seriesId, '0x' + '11'.repeat(65)]);
    const forged = await rig.post(`/series/${seriesId}/reports`, assembled, issuerTok);
    expect([forged.statusCode, forged.json().detail]).toEqual([422, { stage1: 'InvalidAttestorSignature' }]);
    await rig.t.pool.query('update fx_fallback_signatures set signature = $2 where series_id = $1', [seriesId, fxRow.signature]);
    // with the stored FX signature: assembled, and the tx carries it as `fxFallback` (cause S4-FX: no co-signer)
    const ok = await rig.post(`/series/${seriesId}/reports`, assembled, issuerTok);
    expect(ok.statusCode, JSON.stringify(ok.json())).toBe(201);
    expect(ok.json()).toMatchObject({ fxBasis: 'attestor', fxAvgWad: rate.toString(), fxFallbackSigner: h.attestors[1]!.address });
    // cause S4-T2: the stored attestation is the command's {signer, signature}; a row still holding the retired ed25519
    // attestation v1 (assembled before S4 WP6) cannot be built: 409 attestation-superseded (assemble it again)
    const stored = (await rig.t.pool.query('select attestation from reports where report_id = $1', [ok.json().reportId])).rows[0].attestation;
    expect(stored).toEqual(assembled.attestation);
    await rig.t.pool.query('update reports set attestation = $2 where report_id = $1', [ok.json().reportId, JSON.stringify({ keyId: 'report-verifier-test', seriesId, periodId: q, signature: '0x' + '11'.repeat(64) })]);
    const legacy = await rig.post(`/reports/${ok.json().reportId}/build-submit`, {}, issuerTok);
    expect([legacy.statusCode, legacy.json().detail]).toEqual([409, { reason: 'attestation-superseded' }]);
    await rig.t.pool.query('update reports set attestation = $2 where report_id = $1', [ok.json().reportId, JSON.stringify(stored)]);
    const tx = ok.json().tx as UnsignedTx;
    expect(tx.coSigners ?? []).toEqual([]);
    expect(tx.command).toMatchObject({ kind: 'submitReport', fxBasis: 'attestor', fxFallback: { signer: h.attestors[1]!.address, signature: fxRow.signature } });
    const sent = await rig.post('/tx/send', await h.issuer.sign(tx), issuerTok);
    expect(sent.statusCode, JSON.stringify(sent.json())).toBe(200);
    const due = sent.json().events[0].payload.paymentDue;
    expect(due).toBe(((ytd - 50_000_000_000n) * 10n / 100n * rate / 10n ** 18n).toString());
  });

  it('Groth16 is the default: a service left to its defaults accepts Stage 1 Groth16 proofs only and refuses a mock proof', async () => {
    // the API as a deployment starts it: no proof verifier override, MERCES_PROOF_SYSTEM unset (cause PF, H3)
    const saved = process.env.MERCES_PROOF_SYSTEM;
    delete process.env.MERCES_PROOF_SYSTEM;
    const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } } as never;
    let app: Awaited<ReturnType<typeof buildApp>>;
    try {
      const ctx = createServiceContext(makeContext({ pool: rig.t.pool, chains: rig.ctx.chains, log: silent, sessionSecret: SECRET, devMode: true }), { esign: rig.esign, identity: rig.identity, zktls: rig.zktls, kms: rig.kms, verifier: rig.verifier, reportVerifierUrl: 'http://verifier.test' });
      app = await buildApp(ctx, serviceRoutes);
      await app.ready();
    } finally {
      if (saved !== undefined) process.env.MERCES_PROOF_SYSTEM = saved;
    }
    try {
      const artifacts = (await app.inject({ method: 'GET', url: '/prover/artifacts' })).json();
      expect(artifacts).toMatchObject({ system: 'groth16-bn254', acceptedSystems: ['groth16-bn254'] });
      // a fresh series' first quarter, proven on the device; the same report with a mock proof over the same six signals
      const h = rig.harness('monad');
      const raise = await h.runRaise();
      const seriesId = raise.seriesId;
      const q = periodOf((await h.sim.getSeries(seriesId))!.settledAt!);
      await h.sim.setTime(Math.max(await h.sim.now(), q.end + 86_400));
      await rig.sync();
      const issuerTok = rig.token({ accountId: 'iss-g16', wallets: [{ chain: h.sim.chain, address: h.issuer.address }], roles: ['issuer'] });
      const privateTerms = { threshold: raise.privateTerms.theta.toString(), shareRate: '0.10', reportingCurrency: 'USD', indexingRule: raise.privateTerms.indexingRule, termsSalt: raise.privateTerms.termsSalt.toString() };
      const expected = (await rig.get(`/series/${seriesId}/reporting/prior`)).json();
      const prior = choosePrior(new MemoryIncomeChain(), seriesId, q.id, expected.expectedPriorIncomeCommitment);
      const zktlsProof = rig.zktls.prove({ source: 'stripe', seriesId, periodId: q.id, figure: USDC(70_000), currency: 'USD', coversUntil: q.end, owner: h.issuer.address });
      const { assembled } = await assembleOnDevice({ seriesId, periodId: q.id, termsCommitment: raise.terms.termsCommitment, unitsOutstanding: '500', unitsOffered: '500', privateTerms, prior, incomeYtdNow: USDC(70_000), fxAvgWad: 10n ** 18n, tier: 2, source: 'stripe', zktlsProof, deviceSecret: 'device-secret-g16' }, rig.verifier);
      const mock = { ...assembled, proof: { system: 'mock' as const, proof: mockProve(assembled.proof.publicInputs), publicInputs: assembled.proof.publicInputs } };
      const refused = await app.inject({ method: 'POST', url: `/series/${seriesId}/reports`, payload: mock, headers: { authorization: `Bearer ${issuerTok}` } });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json().message).toBe('proof system mock is not accepted (this service verifies groth16-bn254)');
      // the Groth16 report passes the same service
      const ok = await app.inject({ method: 'POST', url: `/series/${seriesId}/reports`, payload: assembled, headers: { authorization: `Bearer ${issuerTok}` } });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(ok.json()).toMatchObject({ verifiedOffchain: true, paymentStable: USDC(1000).toString() });
    } finally {
      await app.close();
    }
  });
});
