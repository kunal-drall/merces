import { createCipheriv, createHash, randomBytes } from 'node:crypto';
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
 *  - S4-AMD: an amendment is approved with the key's Stage 1 AMEND signature over the series' live amendment nonce
 *    (`rig.signAmendment`, S4 WP11; was `{attestor, approve: true}`); a rejection names the key it acts with.
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
    const both = await rig.attestorToken('att-multi', [h.attestors[0]!]);
    const until = (await h.sim.now()) + 30 * 86_400;
    const req = await rig.post(`/series/${seriesId}/hardship`, { until, attestor: h.attestors[0]!.address, ciphertext: e2e('medical') }, issuerTok);
    expect(req.statusCode, req.body).toBe(201);
    const hardshipId = req.json().hardshipId as string;
    // cause S4-ID: one key, the attestor on both chains (the harnesses register the same 20-byte address)
    expect(rig.sol.attestors[0]!.address).toBe(h.attestors[0]!.address);

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
    // linked to another account: refused for the named one; accepted for its own (the account defaults to the holder's;
    // A-SIG-7: the holder has passed the attestor identity check)
    await rig.linkKeys('acct-other', [k]);
    await rig.verifyAttestor('acct-other');
    expect((await rig.post('/admin/attestors', { chain: 'solana', attestor: k.address, accountId: 'acct-a' }, adminTok)).json().detail).toEqual({ reason: 'key-not-linked' });
    const ok = await rig.post('/admin/attestors', { chain: 'solana', attestor: k.address }, adminTok);
    expect([ok.statusCode, ok.json().request.meta.accountId]).toEqual([201, 'acct-other']);
    // a wallet address of a chain's family is no key (400), and the old body shape is refused
    expect((await rig.post('/admin/attestors', { chain: 'solana', attestor: rig.sol.issuer.address }, adminTok)).statusCode).toBe(400);
    expect((await rig.post('/admin/attestors', { chain: 'solana', wallet: k.address, accountId: 'acct-other', active: true }, adminTok)).statusCode).toBe(400);
  });

  /**
   * Inflation amendments awaiting an attestor, seeded directly (the people-paper test covers the full flow): one draft and
   * vault for the series, one amendment per id, each with its own new commitment (cause S4-AMD: a 32-byte commitment the
   * AMEND message can carry; was '0xnew') and the series' cap.
   */
  async function seedAmendment(chain: 'monad' | 'solana', seriesId: string, issuer: string, ...ids: string[]): Promise<string[]> {
    const draftId = `draft-${ids[0]}`;
    await rig.t.pool.query("insert into series_drafts (draft_id, account_id, chain, issuer, public_terms, series_id, state) values ($1,'iss-acct',$2,$3,'{}',$4,'created')", [draftId, chain, issuer, seriesId]);
    const oldT = { threshold: '65000000000', ratePerUnitWad: '100000000000000', reportingCurrency: 'USD', indexingRule: 'cpi-annual', salt: '0x' + '11'.repeat(32) };
    const newT = { ...oldT, threshold: '66950000000' };
    await rig.t.pool.query("insert into terms_vault (draft_id, series_id, ciphertext, key_id, commitment) values ($1,$2,$3,'k','0xold')", [draftId, seriesId, rig.ctx.vault.encrypt(JSON.stringify(oldT), `terms:${draftId}`)]);
    const commitments: string[] = [];
    for (const [i, id] of ids.entries()) {
      const commitment = '0x' + createHash('sha256').update(`${seriesId}:${id}`).digest('hex').replace(/^./, '0');
      commitments.push(commitment);
      await rig.t.pool.query("insert into terms_amendments (amendment_id, series_id, draft_id, kind, new_commitment, new_cap_multiple_wad, ciphertext, version, rationale_code) values ($1,$2,$3,'inflation-index',$4,2500000000000000000,$5,$6,'cpi-2026-300bps')", [id, seriesId, draftId, commitment, rig.ctx.vault.encrypt(JSON.stringify(newT), `terms:${draftId}`), 2 + i]);
    }
    return commitments;
  }

  it('amendments: a key registered onchain but not yet indexed on the series\' chain cannot attest or reject, not even with the admin role', async () => {
    const m = rig.mon;
    const { seriesId } = await m.runRaise();
    await rig.sync();
    const [commitment] = await seedAmendment('monad', seriesId, m.issuer.address, 'amend-late');
    // cause S4-ID: a key active and indexed on solana passes the tier; on monad it is registered but not indexed yet
    const late = SimSigner.attestor('late-attestor');
    await rig.sol.exec(rig.sol.admin, { kind: 'registerAttestor', attestor: late.address });
    await rig.sync();
    await m.exec(m.admin, { kind: 'registerAttestor', attestor: late.address }); // onchain, not indexed yet; cause S4-REG (was {active: true})
    const viaSolana = await rig.attestorToken('att-late', [late], { roles: [] });
    // cause S4-AMD: neither the signing request nor an approval with the key's signature (was {attestor, approve: true})
    expect((await rig.signAmendment('amend-late', late, viaSolana)).statusCode).toBe(422);
    const signed = await m.attestAmend(seriesId, { termsCommitment: commitment!, capMultipleWad: '2500000000000000000' }, late);
    expect((await rig.post('/attestor/amendments/amend-late/attest', { approve: true, amendmentNonce: '0', attestation: signed }, viaSolana)).statusCode).toBe(422);
    expect((await rig.post('/attestor/amendments/amend-late/attest', { approve: false, attestor: late.address }, viaSolana)).statusCode).toBe(422);
    // the admin role does not stand in: the key is not the admin's (cause S4-ID: 403, the key must be linked to the account)
    const admin = rig.token({ accountId: 'adm-att', roles: ['admin'], wallets: [{ chain: 'monad', address: late.address }] });
    expect((await rig.post('/attestor/amendments/amend-late/attest', { approve: false, attestor: late.address }, admin)).statusCode).toBe(403);
    expect((await rig.post('/attestor/amendments/amend-late/attest', { approve: true, amendmentNonce: '0', attestation: signed }, admin)).statusCode).toBe(403);
    expect((await rig.t.pool.query("select state from terms_amendments where amendment_id = 'amend-late'")).rows[0].state).toBe('proposed');
    // the old bodies (a wallet; a key with no signature) are refused
    expect((await rig.post('/attestor/amendments/amend-late/attest', { attestorWallet: late.address, approve: true }, viaSolana)).statusCode).toBe(400);
    expect((await rig.post('/attestor/amendments/amend-late/attest', { attestor: late.address, approve: true }, viaSolana)).statusCode).toBe(400);
    // once indexed it may attest (the key in any case)
    await rig.sync();
    const ok = await rig.post('/attestor/amendments/amend-late/attest', { approve: true, amendmentNonce: '0', attestation: { ...signed, signer: late.address.toUpperCase().replace('0X', '0x') } }, viaSolana);
    expect(ok.json()).toMatchObject({ state: 'attested', attestor: late.address, amendmentNonce: '0' });
    expect((await rig.t.pool.query("select attestor, amendment_nonce::text, attestor_signature from terms_amendments where amendment_id = 'amend-late'")).rows[0]).toEqual({ attestor: late.address, amendment_nonce: '0', attestor_signature: signed.signature });
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

  // cause S4-AMD (S4 WP11): an amendment that lands consumes the series' amendment nonce, so every other one signed over it
  // is dead onchain. The attest and the build read the live nonce (409 stale-nonce), the build sends a dead one back to an
  // attestor, and so does the indexer when it sees the TermsAmended; one that landed keeps its record.
  it('amendments: a signature over a consumed amendment nonce is dead: 409 stale-nonce at the attest and the build, and the indexer sends it back to an attestor', async () => {
    const m = rig.mon;
    const { seriesId } = await m.runRaise();
    const key = SimSigner.attestor('amend-stale');
    await m.exec(m.admin, { kind: 'registerAttestor', attestor: key.address });
    await rig.sync();
    const [cA, cB, cC] = await seedAmendment('monad', seriesId, m.issuer.address, 'amend-a', 'amend-b', 'amend-c');
    const tok = await rig.attestorToken('att-stale', [key]);
    const issuerTok = rig.token({ accountId: 'iss-acct', roles: ['issuer'], wallets: [{ chain: 'monad', address: m.issuer.address }] });
    const row = async (id: string) => (await rig.t.pool.query('select state, attestor, amendment_nonce::text as amendment_nonce, digest, attestor_signature, decision_code from terms_amendments where amendment_id = $1', [id])).rows[0];
    const send = async (id: string) => {
      const b = await rig.post(`/amendments/${id}/build`, {}, issuerTok);
      expect(b.statusCode, b.body).toBe(200);
      return m.sim.send(await m.issuer.sign(b.json().tx));
    };
    // A and B are signed over nonce 0; C's signing request is taken at nonce 0 too
    expect((await rig.signAmendment('amend-a', key, tok)).json()).toMatchObject({ state: 'attested', amendmentNonce: '0' });
    expect((await rig.signAmendment('amend-b', key, tok)).json()).toMatchObject({ state: 'attested', amendmentNonce: '0' });
    const reqC = (await rig.get(`/attestor/amendments/amend-c/message?attestor=${key.address}`, tok)).json();
    const sigC = await key.attest('AMEND', reqC.domain, reqC.seriesKey, reqC.fields);
    // A lands (nonce 0 → 1); its event carries the nonce it signed
    const landed = await send('amend-a');
    expect(landed.events[0]).toMatchObject({ type: 'TermsAmended', payload: { termsCommitment: cA, attestor: key.address, nonce: '0' } });
    // before the indexer catches up: B's build reads the chain, finds the nonce moved and sends B back to an attestor
    const bB = await rig.post('/amendments/amend-b/build', {}, issuerTok);
    expect([bB.statusCode, bB.json().detail]).toEqual([409, { reason: 'stale-nonce', liveAmendmentNonce: '1' }]);
    expect(await row('amend-b')).toEqual({ state: 'proposed', attestor: null, amendment_nonce: null, digest: null, attestor_signature: null, decision_code: 'stale-nonce' });
    // C's signature over nonce 0 is refused at the attest, with a fresh signing request at nonce 1
    const aC = await rig.post('/attestor/amendments/amend-c/attest', { approve: true, amendmentNonce: '0', attestation: sigC }, tok);
    expect(aC.statusCode, aC.body).toBe(409);
    expect(aC.json().detail).toMatchObject({ reason: 'stale-nonce', liveAmendmentNonce: '1', request: { kind: 'AMEND', signer: key.address, fields: { amendmentNonce: '1', termsCommitment: cC } } });
    expect((await row('amend-c')).state).toBe('proposed');
    // B and C signed again over the live nonce; B lands (nonce 1 → 2) and the indexed TermsAmended sends C back
    expect((await rig.signAmendment('amend-b', key, tok)).json()).toMatchObject({ state: 'attested', amendmentNonce: '1' });
    expect((await rig.signAmendment('amend-c', key, tok)).json()).toMatchObject({ state: 'attested', amendmentNonce: '1' });
    expect((await send('amend-b')).events[0]).toMatchObject({ payload: { termsCommitment: cB, nonce: '1' } });
    await rig.sync();
    expect(await row('amend-c')).toMatchObject({ state: 'proposed', attestor: null, attestor_signature: null, decision_code: 'stale-nonce' });
    // the ones that landed keep their record (A was signed over a nonce B consumed too), and are not built again
    expect(await row('amend-a')).toMatchObject({ state: 'submitted', attestor: key.address, amendment_nonce: '0' });
    expect(await row('amend-b')).toMatchObject({ state: 'submitted', attestor: key.address, amendment_nonce: '1' });
    for (const id of ['amend-a', 'amend-b']) expect((await rig.post(`/amendments/${id}/build`, {}, issuerTok)).json().detail).toEqual({ reason: 'already-amended' });
    // a key revoked after it signed: the build sends the amendment back (the chain would refuse InvalidAttestorSignature)
    expect((await rig.signAmendment('amend-c', key, tok)).json()).toMatchObject({ state: 'attested', amendmentNonce: '2' });
    await m.exec(m.admin, { kind: 'revokeAttestor', attestor: key.address });
    const bC = await rig.post('/amendments/amend-c/build', {}, issuerTok);
    expect([bC.statusCode, bC.json().detail]).toEqual([409, { reason: 'attestor-key-inactive', stage1: 'InvalidAttestorSignature' }]);
    expect(await row('amend-c')).toMatchObject({ state: 'proposed', attestor_signature: null, decision_code: 'attestor-key-inactive' });
    // the series is the issuer's: another account cannot build its amendments
    expect((await rig.post('/amendments/amend-c/build', {}, rig.token({ accountId: 'other-iss', roles: ['issuer'], wallets: [] }))).statusCode).toBe(403);
  });
});
