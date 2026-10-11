import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import type { UnsignedTx } from '@merces/domain';
import { SimSigner } from '@merces/simulator';
import { makeRig } from './helpers.ts';

/**
 * The owner's decision (S4, A-SIG-7): "Extinguishment: two separately verified accounts, enforced at registration."
 * An attestor identity check belongs to the account (`POST /me/attestor/identity-check`, `GET …`; migration 031 stores
 * the provider's check id and status only). The admin's `registerAttestor` and `rotateAttestor` refuse, 409 and
 * value-free, a key whose account has not passed it (`identity-not-verified`) and a second key of an account that
 * already holds one active or proposed on the chain (`account-already-attestor`); two verified accounts register side
 * by side. The extinguish-time same-account check stays as defence in depth (attestor.test.ts: a tampered link table).
 */
describe.skipIf(!dbTestsEnabled())('attestor registration needs a separately verified account, one key per account and chain (A-SIG-7)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let adminTok: string;
  beforeAll(async () => {
    rig = await makeRig();
    adminTok = rig.token({ accountId: 'adm-identity', roles: ['admin'], wallets: [] });
  });
  afterAll(async () => {
    await rig.close();
  });

  const register = (chain: string, attestor: string) => rig.post('/admin/attestors', { chain, attestor }, adminTok);

  it('an unverified account is refused (409 identity-not-verified, nothing built); the account passes the check through its own flow and the registration follows', async () => {
    const k = SimSigner.attestor('identity-k1');
    await rig.linkKeys('id-acct-1', [k]);
    const tok = rig.token({ accountId: 'id-acct-1', roles: [], wallets: [] });
    expect((await rig.get('/me/attestor/identity-check', tok)).json()).toEqual({ provider: null, checkId: null, status: 'not_started', startedAt: null, updatedAt: null });

    const refused = await register('solana', k.address);
    expect([refused.statusCode, refused.json().detail]).toEqual([409, { reason: 'identity-not-verified' }]);
    expect(refused.json().message).not.toContain(k.address); // value-free: no key, no account
    expect(refused.json().message).not.toContain('id-acct-1');
    expect((await rig.t.pool.query("select 1 from admin_tx_requests where kind = 'registerAttestor' and command->>'attestor' = $1", [k.address])).rowCount).toBe(0);
    expect((await rig.t.pool.query('select 1 from attestor_proposals where address = $1', [k.address])).rowCount).toBe(0);

    // the account starts its check (the mock provider passes at once) and reads it back; a second start returns the
    // passed check instead of starting another
    const started = await rig.post('/me/attestor/identity-check', {}, tok);
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({ provider: 'mock', checkId: 'mockid_attestor_id-acct-1', status: 'passed', redirectUrl: expect.stringContaining('identity.mock.invalid') });
    expect((await rig.get('/me/attestor/identity-check', tok)).json()).toMatchObject({ provider: 'mock', checkId: 'mockid_attestor_id-acct-1', status: 'passed', startedAt: expect.any(String) });
    expect((await rig.post('/me/attestor/identity-check', {}, tok)).json()).toMatchObject({ status: 'passed', redirectUrl: null });
    // the table holds the provider's check id and status only (PRIVACY.md): no document, no extracted data
    const stored = (await rig.t.pool.query('select * from attestor_identity_checks where account_id = $1', ['id-acct-1'])).rows[0] as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['account_id', 'check_id', 'provider', 'started_at', 'status', 'updated_at']);
    // another account cannot read it (the route is the caller's own)
    expect((await rig.get('/me/attestor/identity-check', rig.token({ accountId: 'id-acct-nobody', roles: [], wallets: [] }))).json().status).toBe('not_started');

    const ok = await register('solana', k.address);
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await rig.get('/admin/attestors', adminTok)).json().attestors.find((a: { attestor: string }) => a.attestor === k.address)).toMatchObject({ accountId: 'id-acct-1', identityStatus: 'passed', status: 'pending-onchain' });
  });

  it("a pending or failed check is not a passed one: the provider's status is refreshed on read; a failed check starts again", async () => {
    const k = SimSigner.attestor('identity-pending');
    await rig.linkKeys('id-acct-p', [k]);
    const tok = rig.token({ accountId: 'id-acct-p', roles: [], wallets: [] });
    await rig.post('/me/attestor/identity-check', {}, tok);
    // the provider's answer goes back to pending (the mock's test hook; the stored status with it)
    rig.identity.set('mockid_attestor_id-acct-p', 'pending');
    await rig.t.pool.query("update attestor_identity_checks set status = 'pending' where account_id = 'id-acct-p'");
    expect((await rig.get('/me/attestor/identity-check', tok)).json().status).toBe('pending');
    expect((await register('solana', k.address)).json().detail).toEqual({ reason: 'identity-not-verified' });
    expect((await rig.get('/admin/attestors', adminTok)).json().attestors.find((a: { attestor: string }) => a.attestor === k.address)).toBeUndefined();
    // the provider fails it: the read refreshes the stored status (the application checks' refresh path)
    rig.identity.set('mockid_attestor_id-acct-p', 'failed');
    expect((await rig.get('/me/attestor/identity-check', tok)).json().status).toBe('failed');
    expect((await rig.t.pool.query("select status from attestor_identity_checks where account_id = 'id-acct-p'")).rows[0]!.status).toBe('failed');
    expect((await register('solana', k.address)).json().detail).toEqual({ reason: 'identity-not-verified' });
    // a failed check is started again in place; the mock passes it
    expect((await rig.post('/me/attestor/identity-check', {}, tok)).json()).toMatchObject({ status: 'passed', redirectUrl: expect.any(String) });
    expect((await register('solana', k.address)).statusCode).toBe(201);
  });

  it('one attestor key per verified account and chain: a second key is refused while the first is proposed and while it is active; another chain is open; two verified accounts register side by side', async () => {
    const [a, b, c] = ['identity-two-a', 'identity-two-b', 'identity-other'].map((l) => SimSigner.attestor(l)) as [SimSigner, SimSigner, SimSigner];
    await rig.linkKeys('id-acct-2', [a, b]);
    await rig.verifyAttestor('id-acct-2');
    const first = await register('monad', a.address);
    expect(first.statusCode, first.body).toBe(201);
    // proposed, not yet onchain: the second key of the account is refused, value-free
    const second = await register('monad', b.address);
    expect([second.statusCode, second.json().detail]).toEqual([409, { reason: 'account-already-attestor' }]);
    expect(second.json().message).not.toContain(a.address);
    expect(second.json().message).not.toContain('id-acct-2');
    expect((await rig.t.pool.query('select 1 from attestor_proposals where address = $1', [b.address])).rowCount).toBe(0);
    // the multisig signs and sends the first; the key is active on the chain: still refused (read live, before indexing too)
    await rig.mon.sim.send(await rig.mon.admin.sign(first.json().tx as UnsignedTx));
    expect((await register('monad', b.address)).json().detail).toEqual({ reason: 'account-already-attestor' });
    await rig.sync();
    expect((await register('monad', b.address)).json().detail).toEqual({ reason: 'account-already-attestor' });
    // another chain, where the account holds no attestor key: accepted
    expect((await register('solana', b.address)).statusCode).toBe(201);
    // a second verified account registers its own key on the same chain
    await rig.linkKeys('id-acct-3', [c]);
    await rig.verifyAttestor('id-acct-3');
    expect((await register('monad', c.address)).statusCode).toBe(201);
    const rows = (await rig.get('/admin/attestors', adminTok)).json().attestors.filter((x: { chain: string; attestor: string }) => x.chain === 'monad' && [a.address, c.address].includes(x.attestor));
    expect(rows.map((x: { accountId: string; identityStatus: string }) => [x.accountId, x.identityStatus]).sort()).toEqual([['id-acct-2', 'passed'], ['id-acct-3', 'passed']]);
  });

  it('a rotation keeps requiring the same account, verified: 409 identity-not-verified for a key registered outside the API whose account never passed the check', async () => {
    const [r1, r2] = ['identity-rot-1', 'identity-rot-2'].map((l) => SimSigner.attestor(l)) as [SimSigner, SimSigner];
    await rig.sol.exec(rig.sol.admin, { kind: 'registerAttestor', attestor: r1.address }); // the multisig registered it directly
    await rig.linkKeys('id-acct-rot', [r1, r2]);
    const rotate = () => rig.post('/admin/attestors/rotate', { chain: 'solana', from: r1.address, to: r2.address }, adminTok);
    const refused = await rotate();
    expect([refused.statusCode, refused.json().detail]).toEqual([409, { reason: 'identity-not-verified' }]);
    expect((await rig.t.pool.query("select 1 from admin_tx_requests where kind = 'rotateAttestor' and command->>'to' = $1", [r2.address])).rowCount).toBe(0);
    await rig.verifyAttestor('id-acct-rot');
    expect((await rotate()).statusCode).toBe(201);
    // a third key of the account on the chain, active, is refused at a later rotation (one key per account and chain)
    const r3 = SimSigner.attestor('identity-rot-3');
    await rig.sol.exec(rig.sol.admin, { kind: 'registerAttestor', attestor: r3.address });
    await rig.linkKeys('id-acct-rot', [r3]);
    expect((await rotate()).json().detail).toEqual({ reason: 'account-already-attestor' });
  });
});
