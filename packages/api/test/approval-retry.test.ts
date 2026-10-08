import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { IdentityService } from '@merces/services';
import { SimWallet } from '@merces/simulator';
import { makeRig } from './helpers.ts';

/** Review round 2: an approval whose allowlist sync fails records nothing, so the admin can simply retry. */
describe.skipIf(!dbTestsEnabled())('application approval is retry-safe', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it('a failed setAllowlist leaves the application undecided; the retry approves, allowlists and notifies once', async () => {
    const w = new SimWallet('solana', 'retry-backer');
    await new IdentityService(rig.ctx).seedAccount({ accountId: 'acct-retry', wallets: [{ chain: 'solana', address: w.address, family: 'solana' }], roles: ['backer'], eligible: false });
    const tok = rig.token({ accountId: 'acct-retry', wallets: [{ chain: 'solana', address: w.address }], roles: ['backer'], eligible: false });
    const adminTok = rig.token({ accountId: 'admin-r', roles: ['admin'], wallets: [] });
    const app = (await rig.post('/applications', { kind: 'backer', chain: 'solana', wallet: w.address, country: 'GB' }, tok)).json();
    await rig.post(`/applications/${app.applicationId}/identity/start`, {}, tok);
    expect((await rig.post(`/applications/${app.applicationId}/submit`, {}, tok)).statusCode).toBe(200);

    const sim = rig.sol.sim;
    const original = sim.submit.bind(sim);
    sim.submit = async () => {
      throw new Error('allowlist manager RPC unavailable');
    };
    const failed = await rig.post(`/admin/applications/${app.applicationId}/decide`, { decision: 'approved', reasonCode: 'ok' }, adminTok, { 'idempotency-key': 'decide-1' });
    sim.submit = original;
    expect(failed.statusCode).toBe(500);
    expect((await rig.get(`/applications/${app.applicationId}`, tok)).json().state).toBe('submitted');
    expect((await rig.t.pool.query('select 1 from eligibility where wallet = $1', [w.address])).rowCount).toBe(0);
    expect((await rig.t.pool.query("select 1 from outbox where payload->>'applicationId' = $1 and payload->>'kind' = 'application.approved'", [app.applicationId])).rowCount).toBe(0);

    // same key: the failed attempt released it, so this is a fresh, successful decision
    const ok = await rig.post(`/admin/applications/${app.applicationId}/decide`, { decision: 'approved', reasonCode: 'ok' }, adminTok, { 'idempotency-key': 'decide-1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().state).toBe('approved');
    const elig = await rig.t.pool.query('select revoked_at, allowlist_synced_at, allowlist_tx from eligibility where wallet = $1', [w.address]);
    expect(elig.rows[0]).toMatchObject({ revoked_at: null });
    expect(elig.rows[0].allowlist_synced_at).not.toBeNull();
    expect(await sim.isAllowlisted(w.address)).toBe(true);
    expect((await rig.t.pool.query("select 1 from outbox where payload->>'applicationId' = $1 and payload->>'kind' = 'application.approved'", [app.applicationId])).rowCount).toBe(1);
    // and the decision cannot be made twice
    expect((await rig.post(`/admin/applications/${app.applicationId}/decide`, { decision: 'approved', reasonCode: 'ok' }, adminTok)).statusCode).toBe(409);
  });
});
