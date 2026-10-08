import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import type { UnsignedTx } from '@merces/domain';
import { SimWallet } from '@merces/simulator';
import { IdentityService } from '@merces/services';
import { makeRig } from './helpers.ts';

/**
 * E13 admin API. The admin never signs: every chain action comes back as an UnsignedTx for the multisig, which the
 * test signs with the simulator's admin stand-in (rig.sol.admin) and relays through POST /tx/send. Confirmation is
 * established by reading the chain, not by trusting the caller.
 */
describe.skipIf(!dbTestsEnabled())('E13 admin API', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let adminTok: string;
  let userTok: string;
  let attestorTok: string;

  beforeAll(async () => {
    rig = await makeRig();
    adminTok = rig.token({ accountId: 'admin-1', roles: ['admin'], wallets: [{ chain: 'solana', address: rig.sol.admin.address }] });
    userTok = rig.token({ accountId: 'user-1', roles: ['backer', 'issuer'], wallets: [{ chain: 'solana', address: rig.sol.issuer.address }] });
    attestorTok = rig.token({ accountId: 'att-existing', roles: ['attestor'], wallets: [{ chain: 'solana', address: rig.sol.attestors[0]!.address }] });
  });
  afterAll(async () => {
    await rig.close();
  });

  /** Sign an admin UnsignedTx with the multisig stand-in and relay it through the gateway. */
  async function relay(tx: UnsignedTx): Promise<string> {
    expect(tx.signer).toBe(rig.sol.admin.address);
    const sent = await rig.post('/tx/send', await rig.sol.admin.sign(tx), adminTok);
    expect(sent.statusCode).toBe(200);
    return sent.json().txId as string;
  }

  it('registers an attestor: build for the multisig → sign → send → mark sent → confirmed on the chain; the account gets the attestor role', async () => {
    const w = new SimWallet('solana', 'attestor-new');
    await new IdentityService(rig.ctx).seedAccount({ accountId: 'att-new', wallets: [{ chain: 'solana', address: w.address, family: 'solana' }], roles: ['backer'], eligible: false });
    expect(await rig.sol.sim.listAttestors()).not.toContain(w.address);

    // unknown account → 404; wrong-family wallet → 400
    expect((await rig.post('/admin/attestors', { chain: 'solana', wallet: w.address, accountId: 'nobody', active: true }, adminTok)).statusCode).toBe(404);
    expect((await rig.post('/admin/attestors', { chain: 'solana', wallet: new SimWallet('evm', 'x').address, accountId: 'att-new', active: true }, adminTok)).statusCode).toBe(400);

    const body = { chain: 'solana', wallet: w.address, accountId: 'att-new', active: true, jurisdiction: 'GB', kind: 'CA' };
    const created = await rig.post('/admin/attestors', body, adminTok, { 'idempotency-key': 'att-1' });
    expect(created.statusCode).toBe(201);
    const { request, tx } = created.json() as { request: Record<string, unknown>; tx: UnsignedTx };
    expect(request.state).toBe('proposed');
    expect(request.kind).toBe('registerAttestor');
    expect(request.createdBy).toBe('admin-1');
    expect(request.meta).toEqual({ accountId: 'att-new', jurisdiction: 'GB', kind: 'CA' });
    expect(tx.command).toEqual({ kind: 'registerAttestor', attestor: w.address, active: true });
    expect(tx.signer).toBe((await rig.sol.sim.info()).admin);
    // idempotent replay returns the same request
    const replay = await rig.post('/admin/attestors', body, adminTok, { 'idempotency-key': 'att-1' });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().request.requestId).toBe(request.requestId);
    expect((await rig.post('/admin/attestors', { ...body, active: false }, adminTok, { 'idempotency-key': 'att-1' })).statusCode).toBe(409);

    // the role is granted offchain right away; signing authority comes only from the chain registry
    const roles = await rig.t.pool.query<{ roles: string[] }>('select roles from accounts where account_id = $1', ['att-new']);
    expect(roles.rows[0]!.roles).toContain('attestor');

    // nothing happened on the chain yet: marking sent with a tx the chain does not reflect leaves the request `sent`
    const bogus = await rig.post(`/admin/tx-requests/${request.requestId}/sent`, { txId: 'not-yet' }, adminTok);
    expect(bogus.statusCode).toBe(200);
    expect(bogus.json().state).toBe('sent');
    expect(await rig.sol.sim.listAttestors()).not.toContain(w.address);

    // the multisig signs and the admin relays; the backend never signed
    const txId = await relay(tx);
    const marked = await rig.post(`/admin/tx-requests/${request.requestId}/sent`, { txId }, adminTok, { 'idempotency-key': 'sent-1' });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().state).toBe('confirmed');
    expect(marked.json().txId).toBe(txId);
    expect(marked.json().confirmedAt).toBeTruthy();
    expect(await rig.sol.sim.listAttestors()).toContain(w.address);
    // a different tx id after confirmation is refused
    expect((await rig.post(`/admin/tx-requests/${request.requestId}/sent`, { txId: 'other' }, adminTok)).statusCode).toBe(409);
    expect((await rig.post('/admin/tx-requests/nope/sent', { txId }, adminTok)).statusCode).toBe(404);

    const list = await rig.get('/admin/tx-requests?chain=solana&kind=registerAttestor', adminTok);
    expect(list.json().requests.map((r: { requestId: string; state: string }) => [r.requestId, r.state])).toContainEqual([request.requestId, 'confirmed']);
    expect((await rig.get('/admin/tx-requests?state=proposed', adminTok)).json().requests.map((r: { requestId: string }) => r.requestId)).not.toContain(request.requestId);

    // audited with the admin's account id, append-only
    const audit = await rig.get(`/admin/audit-log?actor=admin-1&target=solana:${w.address}`, adminTok);
    expect(audit.json().entries.map((e: { action: string }) => e.action)).toEqual(['attestor.register']);
    const grant = await rig.get('/admin/audit-log?action=role.grant&target=att-new', adminTok);
    expect(grant.json().entries[0].detail).toEqual({ role: 'attestor' });
    const sent = await rig.get(`/admin/audit-log?action=tx-request&target=${request.requestId}`, adminTok);
    expect(sent.json().entries.map((e: { detail: { confirmed: boolean } }) => e.detail.confirmed)).toEqual([true, false]);
    await expect(rig.t.pool.query('delete from audit_log where actor = $1', ['admin-1'])).rejects.toThrow(/append-only/);
  });

  it('registers a verifier key and pauses/resumes new raises through tracked multisig requests', async () => {
    const spki = await rig.kms.spkiHex('second-verifier');
    expect((await rig.post('/admin/verifier-keys', { chain: 'solana', keyId: 'rv-2', publicKeySpkiHex: 'zz', active: true }, adminTok)).statusCode).toBe(400);
    const key = await rig.post('/admin/verifier-keys', { chain: 'solana', keyId: 'rv-2', publicKeySpkiHex: `0x${spki}`, active: true }, adminTok, { 'idempotency-key': 'vk-1' });
    expect(key.statusCode).toBe(201);
    expect(key.json().tx.command).toEqual({ kind: 'registerVerifierKey', keyId: 'rv-2', publicKey: spki.toLowerCase(), active: true });
    const txId = await relay(key.json().tx);
    const confirmed = await rig.post(`/admin/tx-requests/${key.json().request.requestId}/sent`, { txId }, adminTok);
    expect(confirmed.json().state).toBe('confirmed');
    const keys = await rig.get('/admin/verifier-keys?chain=solana', adminTok);
    expect(keys.json().chains).toHaveLength(1);
    expect(keys.json().chains[0].keys.map((k: { keyId: string }) => k.keyId)).toContain('rv-2');
    expect((await rig.get('/admin/verifier-keys', adminTok)).json().chains.map((c: { chain: string }) => c.chain).sort()).toEqual(['monad', 'solana']);
    expect((await rig.get('/admin/verifier-keys?chain=nowhere', adminTok)).statusCode).toBe(400);

    // pause new raises on monad with the monad multisig stand-in; the simulator then refuses createSeries
    const pause = await rig.post('/admin/raises/pause', { chain: 'monad', paused: true }, adminTok, { 'idempotency-key': 'pause-1' });
    expect(pause.statusCode).toBe(201);
    const ptx = pause.json().tx as UnsignedTx;
    expect(ptx.signer).toBe(rig.mon.admin.address);
    const monAdminTok = rig.token({ accountId: 'admin-1', roles: ['admin'], wallets: [{ chain: 'monad', address: rig.mon.admin.address }] });
    const psent = await rig.post('/tx/send', await rig.mon.admin.sign(ptx), monAdminTok);
    expect(psent.statusCode).toBe(200);
    expect((await rig.post(`/admin/tx-requests/${pause.json().request.requestId}/sent`, { txId: psent.json().txId }, adminTok)).json().state).toBe('confirmed');
    expect((await rig.mon.sim.info()).newRaisesPaused).toBe(true);
    const ov = await rig.get('/admin/overview', adminTok);
    expect(ov.json().chains.find((c: { chain: string }) => c.chain === 'monad').newRaisesPaused).toBe(true);
    // resume
    const resume = await rig.post('/admin/raises/pause', { chain: 'monad', paused: false }, adminTok);
    const rsent = await rig.post('/tx/send', await rig.mon.admin.sign(resume.json().tx), monAdminTok);
    expect((await rig.post(`/admin/tx-requests/${resume.json().request.requestId}/sent`, { txId: rsent.json().txId }, adminTok)).json().state).toBe('confirmed');
    expect((await rig.mon.sim.info()).newRaisesPaused).toBe(false);
    const actions = (await rig.get('/admin/audit-log?action=raises&target=monad', adminTok)).json().entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(['raises.resume', 'raises.pause']);
  });

  it('flags: toggle and read back, refuse private_payouts, unknown names are 404', async () => {
    const before = await rig.get('/admin/flags', adminTok);
    expect(before.json().flags.map((f: { name: string }) => f.name).sort()).toEqual(['early_draws', 'private_payouts', 'secondary_trading', 'tier4', 'transfer_windows']);
    expect(before.json().flags.find((f: { name: string }) => f.name === 'transfer_windows').enabled).toBe(false);
    expect(before.json().flags.find((f: { name: string }) => f.name === 'private_payouts').locked).toBe(true);

    const on = await rig.put('/admin/flags/transfer_windows', { enabled: true }, adminTok);
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ name: 'transfer_windows', enabled: true, locked: false, changed: true });
    expect((await rig.get('/admin/flags', adminTok)).json().flags.find((f: { name: string }) => f.name === 'transfer_windows').enabled).toBe(true);
    expect((await rig.put('/admin/flags/transfer_windows', { enabled: true }, adminTok)).json().changed).toBe(false);
    expect((await rig.put('/admin/flags/transfer_windows', { enabled: false }, adminTok)).json().enabled).toBe(false);

    const locked = await rig.put('/admin/flags/private_payouts', { enabled: true }, adminTok);
    expect(locked.statusCode).toBe(409);
    expect((await rig.get('/admin/flags', adminTok)).json().flags.find((f: { name: string }) => f.name === 'private_payouts').enabled).toBe(false);
    expect((await rig.put('/admin/flags/private_payouts', { enabled: false }, adminTok)).statusCode).toBe(200);
    expect((await rig.put('/admin/flags/not_a_flag', { enabled: true }, adminTok)).statusCode).toBe(404);
    expect((await rig.put('/admin/flags/tier4', { enabled: 'yes' }, adminTok)).statusCode).toBe(400);

    const log = await rig.get('/admin/audit-log?action=flag.set&limit=10', adminTok);
    expect(log.json().entries[0]).toMatchObject({ actor: 'admin-1', actorRole: 'admin', action: 'flag.set', target: 'private_payouts', detail: { enabled: false, previous: false } });
    expect(log.json().entries.some((e: { target: string; detail: { enabled: boolean } }) => e.target === 'private_payouts' && e.detail.enabled === true)).toBe(false);
  });

  it('overview reports chains, indexer cursors, series counts, keeper runs, outbox backlog, open applications and flags', async () => {
    await rig.sol.runRaise();
    await rig.sync();
    await rig.t.pool.query(
      "insert into keeper_runs (job, started_at, finished_at, ok, actions, detail) values ('auction.settle', now(), now(), true, 1, null), ('status.crank', now() - interval '1 hour', now() - interval '1 hour', true, 2, null), ('status.crank', now(), now(), false, 0, 'boom')",
    );
    await rig.t.pool.query("insert into outbox (topic, payload) values ('notification', '{}'), ('notification', '{}')");
    await rig.t.pool.query("update outbox set attempts = 1, last_error = 'smtp down' where id = (select min(id) from outbox)");
    await rig.t.pool.query("insert into accounts (account_id) values ('applicant-x') on conflict do nothing");
    await rig.t.pool.query("insert into applications (application_id, account_id, kind, state, chain, country) values ('app-x', 'applicant-x', 'backer', 'submitted', 'solana', 'US')");

    const ov = await rig.get('/admin/overview', adminTok);
    expect(ov.statusCode).toBe(200);
    const o = ov.json();
    expect(o.chains.map((c: { chain: string }) => c.chain).sort()).toEqual(['monad', 'solana']);
    const sol = o.chains.find((c: { chain: string }) => c.chain === 'solana');
    expect(sol).toMatchObject({ family: 'solana', mode: 'mock', admin: rig.sol.admin.address, newRaisesPaused: false, health: { ok: true } });
    expect(sol.indexer.lastSeq).toBeGreaterThan(0);
    expect(sol.indexer.cursor).toBeTruthy();
    expect(sol.series.total).toBe(1);
    expect(sol.series.byStatus).toEqual({ OnTime: 1 });
    expect(sol.series.byPhase).toEqual({ Settled: 1 });
    expect(o.keepers.lastRuns.map((r: { job: string; ok: boolean }) => [r.job, r.ok]).sort()).toEqual([['auction.settle', true], ['status.crank', false]]);
    expect(o.keepers.recentFailures).toHaveLength(1);
    expect(o.keepers.recentFailures[0].detail).toBe('boom');
    expect(o.outbox.pending).toBeGreaterThanOrEqual(2);
    expect(o.outbox.failed).toBe(1);
    expect(o.applications).toEqual({ open: 1, submitted: 1, inReview: 0 });
    expect(o.txRequests.confirmed).toBeGreaterThanOrEqual(3);
    expect(o.flags.map((f: { name: string }) => f.name)).toContain('tier4');

    const runs = await rig.get('/admin/keepers/runs?job=status.crank&limit=10', adminTok);
    expect(runs.json().runs).toHaveLength(2);
    expect(runs.json().runs.every((r: { job: string }) => r.job === 'status.crank')).toBe(true);
    expect((await rig.get('/admin/keepers/runs', adminTok)).json().runs.length).toBeGreaterThanOrEqual(3);

    // audit log paging and filters
    const all = await rig.get('/admin/audit-log?limit=2', adminTok);
    expect(all.json().entries).toHaveLength(2);
    const older = await rig.get(`/admin/audit-log?limit=200&before=${all.json().entries[1].id}`, adminTok);
    expect(older.json().entries.every((e: { id: number }) => e.id < all.json().entries[1].id)).toBe(true);
    expect((await rig.get('/admin/audit-log?actor=nobody', adminTok)).json().entries).toEqual([]);
  });

  it('eligibility rows carry the allowlist sync state against the indexed chain allowlist', async () => {
    const w = new SimWallet('solana', 'eligible-1');
    await new IdentityService(rig.ctx).seedAccount({ accountId: 'elig-1', wallets: [{ chain: 'solana', address: w.address, family: 'solana' }], roles: ['backer'], eligible: true });
    // seeded as synced but the chain was never told: no allowlist row until the indexer sees one
    let rows = (await rig.get('/admin/eligibility?chain=solana', adminTok)).json().rows;
    expect(rows.find((r: { wallet: string }) => r.wallet === w.address)).toMatchObject({ accountId: 'elig-1', kind: 'backer', expectedAllowed: true, indexedAllowed: null, syncState: 'unindexed' });
    await rig.sol.sim.submit({ kind: 'setAllowlist', wallet: w.address, allowed: true }, 'allowlistManager');
    await rig.sync();
    rows = (await rig.get('/admin/eligibility?chain=solana', adminTok)).json().rows;
    expect(rows.find((r: { wallet: string }) => r.wallet === w.address).syncState).toBe('synced');
    // a revocation recorded offchain but not yet on the chain shows as diverged
    await rig.t.pool.query('update eligibility set revoked_at = now() where wallet = $1', [w.address]);
    rows = (await rig.get('/admin/eligibility', adminTok)).json().rows;
    expect(rows.find((r: { wallet: string }) => r.wallet === w.address)).toMatchObject({ expectedAllowed: false, indexedAllowed: true, syncState: 'diverged' });
    expect((await rig.get('/admin/eligibility?chain=nowhere', adminTok)).statusCode).toBe(400);
  });

  it('audit samples: 0 with a note while tier4 is off; draws nothing-yet-sampled tier-4 reports once on', async () => {
    const off = await rig.post('/admin/audit-samples', { count: 5 }, adminTok, { 'idempotency-key': 'as-1' });
    expect(off.statusCode).toBe(200);
    expect(off.json().sampled).toBe(0);
    expect(off.json().samples).toEqual([]);
    expect(off.json().note).toMatch(/tier4/);
    expect((await rig.post('/admin/audit-samples', { count: 0 }, adminTok)).statusCode).toBe(400);

    await rig.put('/admin/flags/tier4', { enabled: true }, adminTok);
    // two accepted tier-4 reports and one tier-2 report; only the tier-4 ones are eligible
    const seriesId = (await rig.sol.sim.listSeries())[0]!.seriesId;
    const zero = '0x' + '0'.repeat(64);
    for (const [id, tier, state] of [['rep-t4-a', 4, 'accepted'], ['rep-t4-b', 4, 'paid'], ['rep-t4-c', 4, 'assembled'], ['rep-t2', 2, 'accepted']] as const) {
      await rig.t.pool.query(
        "insert into reports (report_id, series_id, period_id, account_id, tier, source, state, payment_stable, income_commitment, terms_commitment, fx_basis, fx_avg_wad, proof) values ($1,$2,'2026Q1','user-1',$3,'self',$4,'1000000',$5,$5,'unity','1000000000000000000','{}')",
        [id, seriesId, tier, state, zero],
      );
    }
    const on = await rig.post('/admin/audit-samples', { count: 5 }, adminTok, { 'idempotency-key': 'as-2' });
    expect(on.json().sampled).toBe(2);
    expect(on.json().note).toBeUndefined();
    expect(on.json().samples.map((s: { reportId: string }) => s.reportId).sort()).toEqual(['rep-t4-a', 'rep-t4-b']);
    expect(on.json().samples[0]).toMatchObject({ seriesId, periodId: '2026Q1', tier: 4, sampledBy: 'admin-1', outcome: 'pending' });
    // already-sampled reports are not drawn again
    expect((await rig.post('/admin/audit-samples', { count: 5 }, adminTok)).json().sampled).toBe(0);
    const list = await rig.get('/admin/audit-samples?outcome=pending', adminTok);
    expect(list.json().samples).toHaveLength(2);
    expect((await rig.get('/admin/audit-samples?outcome=passed', adminTok)).json().samples).toEqual([]);
    const audit = await rig.get('/admin/audit-log?action=audit-samples.draw', adminTok);
    expect(audit.json().entries.map((e: { detail: { sampled: number; flagOn: boolean } }) => [e.detail.sampled, e.detail.flagOn])).toEqual([[0, true], [2, true], [0, false]]);
    await rig.put('/admin/flags/tier4', { enabled: false }, adminTok);
  });

  it('403 for a non-admin (and an attestor) on every admin route; 401 without a session', async () => {
    const routes: [string, string, unknown][] = [
      ['GET', '/admin/overview', undefined],
      ['GET', '/admin/flags', undefined],
      ['PUT', '/admin/flags/tier4', { enabled: true }],
      ['GET', '/admin/audit-log', undefined],
      ['POST', '/admin/attestors', { chain: 'solana', wallet: rig.sol.attestors[1]!.address, accountId: 'user-1', active: true }],
      ['GET', '/admin/tx-requests', undefined],
      ['POST', '/admin/tx-requests/x/sent', { txId: 'x' }],
      ['POST', '/admin/verifier-keys', { chain: 'solana', keyId: 'k', publicKeySpkiHex: '00'.repeat(44), active: true }],
      ['GET', '/admin/verifier-keys', undefined],
      ['POST', '/admin/raises/pause', { chain: 'solana', paused: true }],
      ['GET', '/admin/eligibility', undefined],
      ['POST', '/admin/audit-samples', { count: 1 }],
      ['GET', '/admin/audit-samples', undefined],
      ['GET', '/admin/keepers/runs', undefined],
    ];
    for (const [method, url, body] of routes) {
      for (const tok of [userTok, attestorTok]) {
        const res = await rig.app.inject({ method: method as 'GET', url, payload: body as Record<string, unknown> | undefined, headers: { authorization: `Bearer ${tok}` } });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().error).toBe('Forbidden');
      }
      const anon = await rig.app.inject({ method: method as 'GET', url, payload: body as Record<string, unknown> | undefined });
      expect(anon.statusCode, `${method} ${url} anonymous`).toBe(401);
    }
    // nothing leaked through: no flag changed, no request opened, no sample drawn by the non-admins
    expect((await rig.get('/admin/flags', adminTok)).json().flags.find((f: { name: string }) => f.name === 'tier4').enabled).toBe(false);
    expect((await rig.get('/admin/tx-requests?limit=200', adminTok)).json().requests.every((r: { createdBy: string }) => r.createdBy === 'admin-1')).toBe(true);
    expect((await rig.get('/admin/audit-log?actor=user-1', adminTok)).json().entries).toEqual([]);
  });
});
