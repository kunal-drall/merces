import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { makeRig } from './helpers.ts';

/*
 * S2 cause codes:
 *  - S2-MF: Stage 1's mint gate: a settled raise is not mint-finalized until its last bid is processed (MintNotFinalized);
 *    the services that front a gated path refuse before it, and reconciliation leaves a raise in flight alone.
 *
 * S4 cause codes:
 *  - S4-ID: attestors are keys linked to an account (S4 WP7): attestor access is the account's linked key, read live
 *    (`rig.attestorToken`), never a token's wallets.
 *  - S4-EXT: an extinguishment request names the caller's key and a co-attestor key of another account
 *    (`{attestor, coAttestor}`) and opens collecting their EXTINGUISH signatures (S4 WP12; was `{attestors}` returning a
 *    transaction for the first attestor to send with the second co-signing).
 */

/** Stand-in for the client's end-to-end encryption (as attestor.test.ts): AES-256-GCM under a throwaway key. */
function e2e(plain: string): string {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  // never a merces-e2e v1 version byte (0x01) first: one blob in 256 would otherwise parse as an envelope (a flake)
  if (iv[0] === 0x01) iv[0] = 0x00;
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

describe.skipIf(!dbTestsEnabled())('S2 mint gates in the services (extinguishment, redemption quote, reconciliation)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it('extinguishment and the redemption quote are 409 until the last bid is processed; reconciliation skips the raise until then', async () => {
    const h = rig.sol;
    // settled (finalize), with every bid still to process: Settled, the mint not final
    const { seriesId } = await h.runRaise({ settle: 'finalize' });
    await rig.sync();
    expect(await h.sim.getSeries(seriesId)).toMatchObject({ phase: 'Settled', mintFinalized: false });
    const issuerTok = rig.token({ accountId: 'gate-issuer', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    const attTok = await rig.attestorToken('gate-att', [h.attestors[0]!]); // cause S4-ID: attestor access is the account's linked key
    const adminTok = rig.token({ accountId: 'gate-admin', wallets: [], roles: ['admin'] });
    await rig.linkKeys('gate-att-2', [h.attestors[1]!]); // the co-attestor's key, held by another account (S4 D15)
    const extinguish = () => rig.post('/attestor/extinguish', { seriesId, attestor: h.attestors[0]!.address, coAttestor: h.attestors[1]!.address, evidenceCiphertext: e2e('evidence') }, attTok); // cause S4-EXT
    const quote = () => rig.get(`/series/${seriesId}/redemption/quote`, issuerTok);
    const reconciled = async () => {
      const r = await rig.get('/admin/accounting/reconcile', adminTok);
      expect(r.statusCode).toBe(200);
      expect(r.json().ok).toBe(true);
      return (r.json().checks as { check: string; seriesId: string | null }[]).filter((c) => c.seriesId === seriesId).map((c) => c.check);
    };

    const ext = await extinguish();
    expect(ext.statusCode).toBe(409);
    expect(ext.json().message).toContain('MintNotFinalized');
    expect(ext.json().detail).toEqual({ stage1: 'MintNotFinalized' });
    expect((await rig.t.pool.query('select 1 from extinguishment_requests where series_id = $1', [seriesId])).rowCount).toBe(0);
    const q = await quote();
    expect(q.statusCode).toBe(409);
    expect(q.json().message).toContain('MintNotFinalized');
    expect(await reconciled()).toEqual([]);

    // half the bids processed: still in flight
    const bids = await h.sim.listBids(seriesId);
    for (const b of bids.slice(0, 2)) await h.sim.submit({ kind: 'processBid', seriesId, bidder: b.bidder }, 'keeper');
    await rig.sync();
    expect((await extinguish()).statusCode).toBe(409);
    expect((await quote()).statusCode).toBe(409);
    expect(await reconciled()).toEqual([]);

    // the last bid processed: the mint is final and every path opens
    await h.settle(seriesId, 'process');
    await rig.sync();
    expect((await h.sim.getSeries(seriesId))!.mintFinalized).toBe(true);
    expect((await quote()).statusCode).toBe(200);
    expect(await reconciled()).toEqual(['vault-gross', 'vault-fees', 'treasury-total', 'treasury-released']);
    const opened = await extinguish();
    expect(opened.statusCode, JSON.stringify(opened.json())).toBe(201);
    // cause S4-EXT: the request opens collecting the two keys' signatures; there is no transaction for an attestor to send
    expect(opened.json()).toMatchObject({ state: 'collecting', attestors: [h.attestors[0]!.address, h.attestors[1]!.address], signers: [], extinguishNonce: null });
    expect(opened.json()).not.toHaveProperty('tx');
  });
});
