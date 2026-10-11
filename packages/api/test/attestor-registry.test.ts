import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { dispatchOutbox, enqueueOutbox } from '@merces/core';
import { IdentityService, notificationsOutboxHandler } from '@merces/services';
import { SimSigner } from '@merces/simulator';
import { makeRig } from './helpers.ts';

/** Stand-in for client-side encryption to the attestor's key: the server never sees the key. */
function e2e(plain: string): string {
  const iv = randomBytes(12);
  // never a merces-e2e v1 version byte (0x01) first: one blob in 256 would otherwise parse as an envelope (a flake)
  if (iv[0] === 0x01) iv[0] = 0x00;
  const c = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  return Buffer.concat([iv, c.update(plain, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}

/*
 * S4 cause codes:
 *  - S4-REG: Stage 1's key registry (S4 WP5): a deactivation is `revokeAttestor`, a registration `registerAttestor{attestor}`;
 *  - S4-ID: attestors are keys (S4 WP7): a secp256k1 key's 20-byte address, the same on every chain, linked to an account
 *    by its own proof (`rig.attestorToken` links the published test keys); access is per key and per chain, read live
 *    (was: the session's chain wallets, which differ per chain).
 */

/** A-M5-2: attestor access follows the indexed onchain registry of the addressed key itself, chain by chain. */
describe.skipIf(!dbTestsEnabled())('attestor access follows the indexed registry, key by key and chain by chain', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it("a key revoked on one chain loses that chain's cases, even when its registration on another chain passes the tier", async () => {
    const h = rig.mon;
    const { seriesId } = await h.runRaise();
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'mon-issuer', wallets: [{ chain: 'monad', address: h.issuer.address }], roles: ['issuer'] });
    const until = (await h.sim.now()) + 30 * 86_400;
    const req = await rig.post(`/series/${seriesId}/hardship`, { until, attestor: h.attestors[0]!.address, ciphertext: e2e('medical') }, issuerTok);
    expect(req.statusCode, req.body).toBe(201);
    const hardshipId = req.json().hardshipId as string;
    // cause S4-ID: one key, the attestor on both chains (the harnesses register the same 20-byte address)
    expect(rig.sol.attestors[0]!.address).toBe(h.attestors[0]!.address);
    const both = await rig.attestorToken('att-multi', [h.attestors[0]!]);
    expect((await rig.get(`/attestor/hardship/${hardshipId}`, both)).statusCode).toBe(200);

    // the multisig revokes the key on monad; once indexed, its monad cases close to this account
    await h.exec(h.admin, { kind: 'revokeAttestor', attestor: h.attestors[0]!.address }); // cause S4-REG (was registerAttestor{active: false})
    await rig.sync();
    expect((await rig.get(`/attestor/queue`, both)).statusCode).toBe(200); // the solana registration still passes the tier
    expect((await rig.get(`/attestor/queue`, both)).json().hardship.map((x: { hardshipId: string }) => x.hardshipId)).not.toContain(hardshipId);
    expect((await rig.get(`/attestor/hardship/${hardshipId}`, both)).statusCode).toBe(403);
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, { approve: false, decisionCode: 'declined' }, both)).statusCode).toBe(403);
    // work cannot be addressed to it either
    expect((await rig.post(`/series/${seriesId}/hardship`, { until, attestor: h.attestors[0]!.address, ciphertext: e2e('x') }, issuerTok)).statusCode).toBe(422);
  });

  it('an admin can only propose a key linked to the named account (cause S4-ID: a key, not a wallet)', async () => {
    const adminTok = rig.token({ accountId: 'adm', roles: ['admin'], wallets: [] });
    const k = SimSigner.attestor('unlinked-attestor');
    await new IdentityService(rig.ctx).seedAccount({ accountId: 'acct-a', wallets: [], roles: ['backer'], eligible: false });
    const r = await rig.post('/admin/attestors', { chain: 'solana', attestor: k.address, accountId: 'acct-a' }, adminTok);
    expect([r.statusCode, r.json().detail]).toEqual([422, { reason: 'key-not-linked' }]);
    expect(r.json().message).toMatch(/not linked/);
    // linked to another account: refused for the named one; accepted for its own (the account defaults to the holder's)
    await rig.linkKeys('acct-other', [k]);
    expect((await rig.post('/admin/attestors', { chain: 'solana', attestor: k.address, accountId: 'acct-a' }, adminTok)).json().detail).toEqual({ reason: 'key-not-linked' });
    const ok = await rig.post('/admin/attestors', { chain: 'solana', attestor: k.address }, adminTok);
    expect([ok.statusCode, ok.json().request.meta.accountId]).toEqual([201, 'acct-other']);
    // a wallet address of a chain's family is no key (400), and the old body shape is refused
    expect((await rig.post('/admin/attestors', { chain: 'solana', attestor: rig.sol.issuer.address }, adminTok)).statusCode).toBe(400);
    expect((await rig.post('/admin/attestors', { chain: 'solana', wallet: k.address, accountId: 'acct-other', active: true }, adminTok)).statusCode).toBe(400);
  });

  /** An inflation amendment awaiting an attestor, seeded directly (the people-paper test covers the full flow). */
  async function seedAmendment(chain: 'monad' | 'solana', seriesId: string, issuer: string, id: string): Promise<void> {
    const draftId = `draft-${id}`;
    await rig.t.pool.query("insert into series_drafts (draft_id, account_id, chain, issuer, public_terms, series_id, state) values ($1,'iss-acct',$2,$3,'{}',$4,'created')", [draftId, chain, issuer, seriesId]);
    const oldT = { threshold: '65000000000', ratePerUnitWad: '100000000000000', reportingCurrency: 'USD', indexingRule: 'cpi-annual', salt: '0x' + '11'.repeat(32) };
    const newT = { ...oldT, threshold: '66950000000' };
    await rig.t.pool.query("insert into terms_vault (draft_id, series_id, ciphertext, key_id, commitment) values ($1,$2,$3,'k','0xold')", [draftId, seriesId, rig.ctx.vault.encrypt(JSON.stringify(oldT), `terms:${draftId}`)]);
    await rig.t.pool.query("insert into terms_amendments (amendment_id, series_id, draft_id, kind, new_commitment, new_cap_multiple_wad, ciphertext, version, rationale_code) values ($1,$2,$3,'inflation-index','0xnew',2500000000000000000,$4,2,'cpi-2026-300bps')", [id, seriesId, draftId, rig.ctx.vault.encrypt(JSON.stringify(newT), `terms:${draftId}`)]);
  }

  it('amendments: a key registered onchain but not yet indexed on the series\' chain cannot attest or reject, not even with the admin role', async () => {
    const m = rig.mon;
    const { seriesId } = await m.runRaise();
    await rig.sync();
    await seedAmendment('monad', seriesId, m.issuer.address, 'amend-late');
    // cause S4-ID: a key active and indexed on solana passes the tier; on monad it is registered but not indexed yet
    const late = SimSigner.attestor('late-attestor');
    await rig.sol.exec(rig.sol.admin, { kind: 'registerAttestor', attestor: late.address });
    await rig.sync();
    await m.exec(m.admin, { kind: 'registerAttestor', attestor: late.address }); // onchain, not indexed yet; cause S4-REG (was {active: true})
    const viaSolana = await rig.attestorToken('att-late', [late], { roles: [] });
    expect((await rig.post('/attestor/amendments/amend-late/attest', { attestor: late.address, approve: true }, viaSolana)).statusCode).toBe(422);
    // the admin role does not stand in: the key is not the admin's (cause S4-ID: 403, the key must be linked to the account)
    const admin = rig.token({ accountId: 'adm-att', roles: ['admin'], wallets: [{ chain: 'monad', address: late.address }] });
    expect((await rig.post('/attestor/amendments/amend-late/attest', { attestor: late.address, approve: false }, admin)).statusCode).toBe(403);
    expect((await rig.t.pool.query("select state from terms_amendments where amendment_id = 'amend-late'")).rows[0].state).toBe('proposed');
    // the old body (a wallet) is refused
    expect((await rig.post('/attestor/amendments/amend-late/attest', { attestorWallet: late.address, approve: true }, viaSolana)).statusCode).toBe(400);
    // once indexed it may attest
    await rig.sync();
    expect((await rig.post('/attestor/amendments/amend-late/attest', { attestor: late.address.toUpperCase().replace('0X', '0x'), approve: true }, viaSolana)).json()).toMatchObject({ state: 'attested' });
    expect((await rig.t.pool.query("select attestor from terms_amendments where amendment_id = 'amend-late'")).rows[0].attestor).toBe(late.address);
  });

  it("amendment lists and attestor notices follow the registry of the series' chain", async () => {
    const m = rig.mon;
    const { seriesId } = await m.runRaise();
    await rig.sync();
    await seedAmendment('monad', seriesId, m.issuer.address, 'amend-list');
    // cause S4-ID: the key is the attestor on both chains, linked to the account (its wallets play no part)
    const monAtt = m.attestors[1]!.address;
    const tok = await rig.attestorToken('att-y', [monAtt], { roles: [] });
    expect((await rig.get(`/series/${seriesId}/amendments`, tok)).statusCode).toBe(200);
    await m.exec(m.admin, { kind: 'revokeAttestor', attestor: monAtt }); // cause S4-REG (was registerAttestor{active: false})
    await rig.sync();
    // its solana registration no longer opens the monad series' amendments
    expect((await rig.get(`/series/${seriesId}/amendments`, tok)).statusCode).toBe(403);
    // and a notice addressed to the key revoked on monad does not reach the account
    await rig.t.pool.query('update outbox set dispatched_at = now() where dispatched_at is null');
    await enqueueOutbox(rig.t.pool, 'notification', { kind: 'hardship.requested', seriesId, hardshipId: 'hs-deact', attestor: monAtt });
    const client = await rig.t.pool.connect();
    try {
      await dispatchOutbox(client, notificationsOutboxHandler(rig.ctx));
    } finally {
      client.release();
    }
    expect((await rig.t.pool.query("select 1 from notifications where account_id = 'att-y' and kind = 'hardship.requested'")).rowCount).toBe(0);
  });
});
