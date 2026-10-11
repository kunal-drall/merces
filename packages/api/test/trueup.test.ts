import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import type { SigningRequest } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import { makeRig } from './helpers.ts';

describe.skipIf(!dbTestsEnabled())('annual true-up submission and payment', () => {
  it('serializes competing years, gives only the issuer the submission, consumes the nonce, then pays with accrual', async () => {
    const rig = await makeRig();
    try {
      const h = rig.mon;
      await h.sim.setTime(parsePeriod('2028Q1').start);
      const { seriesId } = await h.runRaise();
      await rig.sync();
      const issuer = rig.token({ accountId: 'issuer', roles: ['issuer'], wallets: [{ chain: 'monad', address: h.issuer.address }] });
      const att = await rig.attestorToken('attestor', [h.attestors[0]!]);
      const ids: string[] = [];
      const bodies: Record<string, unknown>[] = [];
      for (const year of [2026, 2027]) {
        const open = await rig.post(`/series/${seriesId}/tier3/annual`, { year, attestor: h.attestors[0]!.address, documentsCiphertext: randomBytes(128).toString('base64') }, issuer);
        expect(open.statusCode, open.body).toBe(201);
        const id = open.json().annualId as string;
        ids.push(id);
        const message = await rig.get(`/attestor/tier3/annual/${id}/message?totalPaymentStable=1000000`, att);
        expect(message.statusCode, message.body).toBe(200);
        const request = message.json() as SigningRequest<'TRUEUP'>;
        const signature = await h.attestors[0]!.attest('TRUEUP', request.domain, request.seriesKey, request.fields);
        bodies.push({ totalPaymentStable: '1000000', trueupNonce: request.fields.trueupNonce, attestationTs: request.fields.attestationTs, attestation: signature });
      }
      const signed = await Promise.all(ids.map((id, i) => rig.post(`/attestor/tier3/annual/${id}/sign`, bodies[i], att)));
      expect(signed.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(signed.find((r) => r.statusCode === 409)!.json().detail.reason).toBe('earlier-trueup-pending');
      const id = ids[signed.findIndex((r) => r.statusCode === 200)]!;
      const path = `/series/${seriesId}/tier3/annual/${id}/build-submit`;
      expect((await rig.post(path, {}, att)).statusCode).toBe(403);
      const built = await rig.post(path, {}, issuer);
      expect(built.statusCode, built.body).toBe(200);
      expect(JSON.stringify(signed)).not.toContain('trueup_signature');
      await h.exec(h.issuer, built.json().tx.command);
      // A lagging indexer cannot trick the builder into issuing a replay.
      expect((await rig.post(path, {}, issuer)).statusCode).toBe(409);
      await rig.sync();
      expect((await rig.t.pool.query('select state from tier3_annual where annual_id=$1', [id])).rows[0].state).toBe('recorded');
      await h.sim.advanceTime(100 * 86400);
      await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
      expect((await h.sim.getSeries(seriesId))!.trueUp.noticeEmitted).toBe(false);
      // Stage 1 notice: 60 + (90 - 45) = 105 unpaused days after attestation.
      await h.sim.advanceTime(5 * 86400);
      await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
      await rig.sync();
      const live = await rig.get(`/series/${seriesId}/true-up`, issuer);
      expect(live.statusCode, live.body).toBe(200);
      expect(live.json()).toMatchObject({ nonce: '1', due: '1000000', noticeEmitted: true });
      expect(BigInt(live.json().accrual)).toBeGreaterThan(0n);
      const pay = await rig.post(`/series/${seriesId}/true-up/build-pay`, { wallet: h.issuer.address }, issuer);
      expect(pay.statusCode, pay.body).toBe(200);
      await h.exec(h.issuer, pay.json().tx.command);
      await rig.sync();
      expect((await rig.t.pool.query('select state from tier3_annual where annual_id=$1', [id])).rows[0].state).toBe('paid');
      expect((await rig.get(`/series/${seriesId}/true-up`, issuer)).json()).toMatchObject({ due: '0', total: '0' });
      expect((await rig.post(`/series/${seriesId}/true-up/build-pay`, { wallet: h.issuer.address }, issuer)).statusCode).toBe(409);
    } finally { await rig.close(); }
  });
});
