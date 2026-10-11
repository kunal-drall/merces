import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { E2E_TIER3_OPENING, type SigningRequest } from '@merces/domain';
import { parsePeriod, WAD } from '@merces/math';
import { generateE2eKeyPair, sealE2e } from '@merces/poi-device';
import { AdminService, IdentityService } from '@merces/services';
import { defaultTerms, SimSigner } from '@merces/simulator';
import { makeRig } from './helpers.ts';

const DAY = 86_400;
const cipher = () => randomBytes(128).toString('base64');
const opening = () => sealE2e('private opening'.repeat(30), generateE2eKeyPair().publicKey, E2E_TIER3_OPENING.purpose);

describe.skipIf(!dbTestsEnabled())('S4 review recovery', () => {
  it('projects a third-party pause relay and closes pending hardship when the series becomes terminal', async () => {
    const rig = await makeRig();
    try {
      const h = rig.sol;
      const r = await h.runRaise();
      await rig.sync();
      const token = rig.token({ accountId: 'issuer', roles: ['issuer'], wallets: [{ chain: 'solana', address: h.issuer.address }] });
      await rig.attestorToken('attestor', [h.attestors[0]!]);
      const until = await h.sim.now() + 5 * DAY;
      const opened = await rig.post(`/series/${r.seriesId}/hardship`, { until, attestor: h.attestors[0]!.address, ciphertext: cipher() }, token);
      expect(opened.statusCode, opened.body).toBe(201);
      await h.exec(h.issuer, opened.json().tx.command);
      await rig.sync();
      const approval = await h.attestPause(r.seriesId, until);
      await h.sim.submit({ kind: 'approvePause', seriesId: r.seriesId, pauseEnd: String(until), attestor: approval.signer, signature: approval.signature }, 'keeper');
      await rig.sync();
      const row = (await rig.t.pool.query('select state, approved_until::text, approval, relay_tx from hardship_requests where hardship_id = $1', [opened.json().hardshipId])).rows[0];
      expect(row).toEqual({ state: 'approved', approved_until: String(until), approval: null, relay_tx: null });
      await h.sim.setTime(until + DAY);
      const next = await rig.post(`/series/${r.seriesId}/hardship`, { until: until + 5 * DAY, attestor: h.attestors[0]!.address, ciphertext: cipher() }, token);
      expect(next.statusCode, next.body).toBe(201);
      await h.exec(h.issuer, next.json().tx.command);
      await h.sim.submit(await h.extinguishment(r.seriesId), 'keeper');
      const att = await rig.attestorToken('attestor', [h.attestors[0]!]);
      const refused = await rig.get(`/attestor/hardship/${next.json().hardshipId}/message?pauseEnd=${until + 4 * DAY}`, att);
      expect([refused.statusCode, refused.json().detail]).toEqual([409, { stage1: 'TerminalStatus' }]);
      await rig.sync();
      expect((await rig.t.pool.query('select state, decision_code from hardship_requests where hardship_id = $1', [next.json().hardshipId])).rows[0]).toEqual({ state: 'withdrawn', decision_code: 'series-terminal' });
    } finally { await rig.close(); }
  });

  it('keeps withdrawal available after revocation, rejects strangers, and permits a new request', async () => {
    const rig = await makeRig();
    try {
      const h = rig.sol;
      const r = await h.runRaise();
      await rig.sync();
      const first = await rig.attestorToken('first', [h.attestors[0]!]);
      await rig.attestorToken('second', [h.attestors[1]!]);
      const body = { seriesId: r.seriesId, attestor: h.attestors[0]!.address, coAttestor: h.attestors[1]!.address, evidenceCiphertext: cipher() };
      const request = await rig.post('/attestor/extinguish', body, first);
      expect(request.statusCode, request.body).toBe(201);
      const path = `/attestor/extinguish/${request.json().requestId}/withdraw`;
      expect((await rig.post(path, {}, rig.token({ accountId: 'stranger' }))).statusCode).toBe(403);
      await h.exec(h.admin, { kind: 'revokeAttestor', attestor: h.attestors[1]!.address });
      await rig.sync();
      const withdrawn = await rig.post(path, {}, first);
      expect(withdrawn.statusCode, withdrawn.body).toBe(200);
      expect(withdrawn.json().state).toBe('withdrawn');
      expect((await rig.post(path, {}, first)).statusCode).toBe(200);
      expect((await rig.t.pool.query('select signatures, extinguish_nonce from extinguishment_requests where request_id = $1', [request.json().requestId])).rows[0]).toEqual({ signatures: [], extinguish_nonce: null });
      await h.exec(h.admin, { kind: 'registerAttestor', attestor: h.attestors[1]!.address });
      await rig.sync();
      expect((await rig.post('/attestor/extinguish', body, first)).statusCode).toBe(201);
    } finally { await rig.close(); }
  });

  it('readdresses tier-3 and annual work only after a same-account rotation; requesters can withdraw it', async () => {
    const rig = await makeRig();
    try {
      const h = rig.sol;
      const r = await h.runRaise();
      const old = h.attestors[0]!;
      const next = SimSigner.attestor('recovery-next');
      const att = await rig.attestorToken('attestor', [old, next]);
      const issuer = rig.token({ accountId: 'issuer', roles: ['issuer'], wallets: [{ chain: 'solana', address: h.issuer.address }] });
      await h.sim.setTime(parsePeriod('2026Q4').end + DAY);
      await rig.sync();
      const quarterly = await rig.post(`/series/${r.seriesId}/tier3/2026Q1`, { attestor: old.address, documentsCiphertext: cipher(), openingCiphertext: opening(), estimatePaymentStable: '0' }, issuer);
      const annual = await rig.post(`/series/${r.seriesId}/tier3/annual`, { attestor: old.address, year: 2026, documentsCiphertext: cipher() }, issuer);
      expect(quarterly.statusCode, quarterly.body).toBe(201);
      expect(annual.statusCode, annual.body).toBe(201);
      const body = { chain: 'solana', from: old.address, to: next.address };
      expect((await rig.post('/me/signer-keys/readdress-work', body, att)).statusCode).toBe(409);
      await h.exec(h.admin, { kind: 'rotateAttestor', from: old.address, to: next.address });
      await rig.sync();
      expect((await rig.post('/me/signer-keys/readdress-work', body, issuer)).statusCode).toBe(403);
      const moved = await rig.post('/me/signer-keys/readdress-work', body, att);
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json()).toMatchObject({ tier3: 1, annual: 1 });
      expect((await rig.get(`/attestor/tier3/${quarterly.json().caseId}`, att)).json().attestor).toBe(next.address);
      for (const path of [`/attestor/tier3/${quarterly.json().caseId}/withdraw`, `/attestor/tier3/annual/${annual.json().annualId}/withdraw`]) {
        expect((await rig.post(path, {}, att)).statusCode).toBe(403);
        const out = await rig.post(path, {}, issuer);
        expect(out.statusCode, out.body).toBe(200);
      }
    } finally { await rig.close(); }
  });

  it('preserves an FX signature within grace and replaces it at the same rate after grace', async () => {
    const rig = await makeRig();
    try {
      const h = rig.sol;
      const r = await h.runRaise({ terms: { reportingCurrency: 'EUR' }, privateTerms: { ...defaultTerms(h.sim).privateTerms, currency: 'EUR' } });
      await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
      await rig.sync();
      const first = h.attestors[0]!;
      const second = h.attestors[1]!;
      const signed = await rig.signFxFallback(h, 'EUR/USD', '2026Q1', first, WAD.toString());
      const secondTok = await rig.attestorToken('second', [second]);
      const issuer = rig.token({ accountId: 'issuer', roles: ['issuer'], wallets: [{ chain: 'solana', address: h.issuer.address }] });
      const url = `/attestor/fx-requests/${signed.requestId}/messages?rateWad=${WAD}`;
      await h.exec(h.admin, { kind: 'revokeAttestor', attestor: first.address });
      await rig.sync();
      expect((await rig.get(url, secondTok)).json().requests).toEqual([]);
      expect((await rig.get('/attestor/queue', secondTok)).json().fxRequests).toEqual([]);
      await h.sim.advanceTime(46 * DAY);
      expect((await rig.get('/attestor/queue', secondTok)).json().fxRequests).toEqual([expect.objectContaining({ requestId: signed.requestId })]);
      const fallback = await rig.get(`/series/${r.seriesId}/reporting/fx-fallback/2026Q1`, issuer);
      expect(fallback.json()).toMatchObject({ seriesSigned: false, fxFallback: null });
      const requests = (await rig.get(url, secondTok)).json().requests as SigningRequest<'FX'>[];
      expect(requests).toHaveLength(1);
      const req = requests[0]!;
      const sig = await second.attest('FX', req.domain, req.seriesKey, req.fields);
      const body = { signer: second.address, rateWad: WAD.toString(), sourceNote: 'replacement', signatures: [{ seriesId: r.seriesId, signature: sig.signature }] };
      const replaced = await rig.post(`/attestor/fx-requests/${signed.requestId}/sign`, body, secondTok);
      expect(replaced.statusCode, replaced.body).toBe(200);
      expect((await rig.get(`/series/${r.seriesId}/reporting/fx-fallback/2026Q1`, issuer)).json()).toMatchObject({ seriesSigned: true, fxFallback: { signer: second.address } });
      expect((await rig.post(`/attestor/fx-requests/${signed.requestId}/sign`, body, secondTok)).statusCode).toBe(409);
      expect((await rig.get('/attestor/queue', secondTok)).json().fxRequests).toEqual([]);
    } finally { await rig.close(); }
  });

  it('rejects published attestor and verifier keys if any configured chain is live', async () => {
    const rig = await makeRig();
    try {
      // A live chain alongside an otherwise mocked registry must close every enrollment path.
      rig.ctx.chains.chains.set('live-testnet', { mode: 'live' } as never);
      const address = rig.sol.attestors[0]!.address;
      const admin = { accountId: 'admin', roles: ['admin'], wallets: [] } as never;
      const service = new AdminService(rig.ctx);
      for (const action of [
        () => service.registerAttestor({ chain: 'solana', attestor: address }, admin),
        () => service.rotateAttestor({ chain: 'solana', from: rig.sol.attestors[1]!.address, to: address }, admin),
        () => service.registerVerifierKey({ chain: 'solana', address }, admin),
        () => service.rotateVerifierKey({ chain: 'solana', from: rig.sol.attestors[1]!.address, to: address }, admin),
        () => new IdentityService(rig.ctx).linkSignerKey(admin, { address, nonce: 'not-consumed', signature: '0x' + '00'.repeat(65) }),
      ]) await expect(action()).rejects.toMatchObject({ detail: { reason: 'published-test-key' } });
      rig.ctx.chains.chains.delete('live-testnet');
    } finally { await rig.close(); }
  });
});
