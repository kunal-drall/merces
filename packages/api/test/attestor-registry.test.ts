import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { dispatchOutbox, enqueueOutbox } from '@merces/core';
import { IdentityService, notificationsOutboxHandler } from '@merces/services';
import { SimWallet } from '@merces/simulator';
import { makeRig } from './helpers.ts';

/** Stand-in for client-side encryption to the attestor's key: the server never sees the key. */
function e2e(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', randomBytes(32), iv);
  return Buffer.concat([iv, c.update(plain, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}

/** A-M5-2: attestor access follows the indexed onchain registry of the addressed wallet itself, chain by chain. */
describe.skipIf(!dbTestsEnabled())('attestor access follows the indexed registry, wallet by wallet', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it("a wallet deactivated on one chain loses that chain's cases, even when another chain's registration passes the tier", async () => {
    const h = rig.mon;
    const { seriesId } = await h.runRaise();
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'mon-issuer', wallets: [{ chain: 'monad', address: h.issuer.address }], roles: ['issuer'] });
    const until = (await h.sim.now()) + 30 * 86_400;
    const req = await rig.post(`/series/${seriesId}/hardship`, { until, attestor: h.attestors[0]!.address, ciphertext: e2e('medical') }, issuerTok);
    expect(req.statusCode, req.body).toBe(201);
    const hardshipId = req.json().hardshipId as string;
    const both = rig.token({ accountId: 'att-multi', roles: ['attestor'], wallets: [{ chain: 'solana', address: rig.sol.attestors[0]!.address }, { chain: 'monad', address: h.attestors[0]!.address }] });
    expect((await rig.get(`/attestor/hardship/${hardshipId}`, both)).statusCode).toBe(200);

    // the multisig deactivates the monad wallet; once indexed, its cases close to this account
    await h.exec(h.admin, { kind: 'registerAttestor', attestor: h.attestors[0]!.address, active: false });
    await rig.sync();
    expect((await rig.get(`/attestor/queue`, both)).statusCode).toBe(200); // the solana registration still passes the tier
    expect((await rig.get(`/attestor/queue`, both)).json().hardship.map((x: { hardshipId: string }) => x.hardshipId)).not.toContain(hardshipId);
    expect((await rig.get(`/attestor/hardship/${hardshipId}`, both)).statusCode).toBe(403);
    expect((await rig.post(`/attestor/hardship/${hardshipId}/decide`, { approve: false, decisionCode: 'declined' }, both)).statusCode).toBe(403);
    // work cannot be addressed to it either
    expect((await rig.post(`/series/${seriesId}/hardship`, { until, attestor: h.attestors[0]!.address, ciphertext: e2e('x') }, issuerTok)).statusCode).toBe(422);
  });

  it('an admin can only propose a wallet the named account has linked', async () => {
    const adminTok = rig.token({ accountId: 'adm', roles: ['admin'], wallets: [] });
    const w = new SimWallet('solana', 'unlinked-attestor');
    await new IdentityService(rig.ctx).seedAccount({ accountId: 'acct-a', wallets: [], roles: ['backer'], eligible: false });
    const r = await rig.post('/admin/attestors', { chain: 'solana', wallet: w.address, accountId: 'acct-a', active: true }, adminTok);
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toMatch(/not linked/);
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

  it('amendments: a wallet registered onchain but not yet indexed cannot attest or reject, not even with the admin role', async () => {
    const m = rig.mon;
    const { seriesId } = await m.runRaise();
    await rig.sync();
    await seedAmendment('monad', seriesId, m.issuer.address, 'amend-late');
    const late = new SimWallet('evm', 'late-attestor');
    await m.exec(m.admin, { kind: 'registerAttestor', attestor: late.address, active: true }); // onchain, not indexed yet
    const viaSolana = rig.token({ accountId: 'att-late', roles: [], wallets: [{ chain: 'solana', address: rig.sol.attestors[0]!.address }, { chain: 'monad', address: late.address }] });
    expect((await rig.post('/attestor/amendments/amend-late/attest', { attestorWallet: late.address, approve: true }, viaSolana)).statusCode).toBe(422);
    const admin = rig.token({ accountId: 'adm-att', roles: ['admin'], wallets: [{ chain: 'monad', address: late.address }] });
    expect((await rig.post('/attestor/amendments/amend-late/attest', { attestorWallet: late.address, approve: false }, admin)).statusCode).toBe(422);
    expect((await rig.t.pool.query("select state from terms_amendments where amendment_id = 'amend-late'")).rows[0].state).toBe('proposed');
    // once indexed it may attest
    await rig.sync();
    expect((await rig.post('/attestor/amendments/amend-late/attest', { attestorWallet: late.address, approve: true }, viaSolana)).json()).toMatchObject({ state: 'attested' });
  });

  it("amendment lists and attestor notices follow the registry of the series' chain", async () => {
    const m = rig.mon;
    const { seriesId } = await m.runRaise();
    await rig.sync();
    await seedAmendment('monad', seriesId, m.issuer.address, 'amend-list');
    const monAtt = m.attestors[1]!.address;
    await new IdentityService(rig.ctx).seedAccount({ accountId: 'att-y', wallets: [{ chain: 'solana', address: rig.sol.attestors[1]!.address, family: 'solana' }, { chain: 'monad', address: monAtt, family: 'evm' }], roles: [], eligible: false });
    const tok = rig.token({ accountId: 'att-y', roles: [], wallets: [{ chain: 'solana', address: rig.sol.attestors[1]!.address }, { chain: 'monad', address: monAtt }] });
    expect((await rig.get(`/series/${seriesId}/amendments`, tok)).statusCode).toBe(200);
    await m.exec(m.admin, { kind: 'registerAttestor', attestor: monAtt, active: false });
    await rig.sync();
    // the solana registration no longer opens the monad series' amendments
    expect((await rig.get(`/series/${seriesId}/amendments`, tok)).statusCode).toBe(403);
    // and a notice addressed to the deactivated monad wallet does not reach the account
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
