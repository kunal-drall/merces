import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { dispatchOutbox, enqueueOutbox } from '@merces/core';
import { IdentityService } from '@merces/services';
import { TEMPLATES, notificationsOutboxHandler, safeData } from '@merces/services/src/notifications/service.ts';
import type { SimHarness } from '@merces/simulator';
import { SimWallet } from '@merces/simulator';
import { makeRig } from './helpers.ts';

/** The canary value the privacy suite scans for (docs/SERVICES.md): it must never reach an inbox row or an email. */
const CANARY = '7317317317';
const DAY = 86_400;

describe.skipIf(!dbTestsEnabled())('E12 notifications: outbox handler, inbox, preferences, admin visibility', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let h: SimHarness;
  let seriesId: string;
  let issuerTok: string;
  let holderTok: string;
  let adminTok: string;
  let attTok: string;
  let dueAt: number;
  let graceEndsAt: number;

  /** Run the keeper's outbox job once (the same client/transaction shape as outboxJob). */
  async function dispatch(): Promise<{ dispatched: number; failed: number }> {
    const client = await rig.t.pool.connect();
    try {
      return await dispatchOutbox(client, notificationsOutboxHandler(rig.ctx));
    } finally {
      client.release();
    }
  }
  const inbox = async (accountId: string) => (await rig.t.pool.query('select kind, subject, body, data, email_sent_at from notifications where account_id = $1 order by created_at, notification_id', [accountId])).rows;
  const emails = async () => (await rig.t.pool.query('select to_address, subject, body from email_outbox order by created_at, email_id')).rows;

  beforeAll(async () => {
    rig = await makeRig();
    h = rig.sol;
    const raise = await h.runRaise();
    seriesId = raise.seriesId;
    await rig.sync();
    // the indexer enqueued the raise's own chain notice (auction.settled); these tests drive the handler with
    // payloads of their own, so that row is set aside here (the indexer test covers chain-driven notices)
    await rig.t.pool.query('update outbox set dispatched_at = now() where dispatched_at is null');
    const identity = new IdentityService(rig.ctx);
    await identity.seedAccount({ accountId: 'acct-issuer', wallets: [{ chain: 'solana', address: h.issuer.address, family: 'solana' }], roles: ['issuer'], eligible: true, kind: 'issuer' });
    await identity.seedAccount({ accountId: 'acct-holder', wallets: [{ chain: 'solana', address: h.backers[0]!.address, family: 'solana' }], roles: ['backer'], eligible: true });
    await identity.seedAccount({ accountId: 'acct-admin', wallets: [], roles: ['admin'], eligible: false });
    // no stored attestor role: attestor notices follow the indexed onchain registry of the account's wallets
    await identity.seedAccount({ accountId: 'acct-att', wallets: [{ chain: 'solana', address: h.attestors[0]!.address, family: 'solana' }], roles: [], eligible: false });
    // a stored role with a wallet the chain never registered (an old proposal-time grant) gets nothing
    await identity.seedAccount({ accountId: 'acct-ghost-att', wallets: [{ chain: 'solana', address: new SimWallet('solana', 'ghost-attestor').address, family: 'solana' }], roles: ['attestor'], eligible: false });
    issuerTok = rig.token({ accountId: 'acct-issuer', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    holderTok = rig.token({ accountId: 'acct-holder', wallets: [{ chain: 'solana', address: h.backers[0]!.address }], roles: ['backer'] });
    adminTok = rig.token({ accountId: 'acct-admin', wallets: [], roles: ['admin'] });
    attTok = rig.token({ accountId: 'acct-att', wallets: [{ chain: 'solana', address: h.attestors[0]!.address }], roles: ['attestor'] });
    const now = await h.sim.now();
    dueAt = now + 30 * DAY;
    graceEndsAt = dueAt + 15 * DAY;
  });
  afterAll(async () => {
    await rig.close();
  });

  it('preferences: defaults, an email address, a muted kind; the address is the account\'s own and never anyone else\'s', async () => {
    const def = await rig.get('/me/notification-preferences', issuerTok);
    expect(def.statusCode).toBe(200);
    expect(def.json()).toMatchObject({ email: true, mutedKinds: [], emailAddress: null, channel: 'mock-email' });
    expect(def.json().knownKinds).toContain('reporting.report-due');
    const set = await rig.put('/me/notification-preferences', { email: true, mutedKinds: ['series.PauseEnded', 'series.PauseEnded'], emailAddress: 'issuer@example.test' }, issuerTok);
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ email: true, mutedKinds: ['series.PauseEnded'], emailAddress: 'issuer@example.test' });
    expect((await rig.put('/me/notification-preferences', { email: true, mutedKinds: [], emailAddress: 'not-an-email' }, issuerTok)).statusCode).toBe(400);
    // the holder keeps email on but has no address: inbox only
    expect((await rig.get('/me/notification-preferences', holderTok)).json().emailAddress).toBeNull();
    // the attestor opts out of email entirely and sets an address anyway
    expect((await rig.put('/me/notification-preferences', { email: false, mutedKinds: [], emailAddress: 'att@example.test' }, attTok)).json()).toMatchObject({ email: false, emailAddress: 'att@example.test' });
    // the issuer's address never appears in the holder's view
    expect(JSON.stringify((await rig.get('/me/notification-preferences', holderTok)).json())).not.toContain('issuer@example.test');
  });

  it('handler: resolves recipients per kind, writes one inbox row each, emails only where enabled and addressed, carries statuses and dates only', async () => {
    const reminder = { kind: 'reporting.report-due', seriesId, periodId: '2026Q1', wallet: h.issuer.address, dueAt, graceEndsAt, outstanding: 'report', status: 'InGrace' };
    await enqueueOutbox(rig.t.pool, 'notification', reminder);
    await enqueueOutbox(rig.t.pool, 'notification', { kind: 'payout.available', seriesId, periodId: '2026Q1' });
    await enqueueOutbox(rig.t.pool, 'notification', { kind: 'series.PauseEnded', seriesId });
    await enqueueOutbox(rig.t.pool, 'notification', { kind: 'series.StatusChanged', seriesId, payload: { seriesId, from: 'OnTime', to: 'InGrace' } });
    await enqueueOutbox(rig.t.pool, 'notification', { kind: 'application.submitted', accountId: 'acct-holder', applicationId: 'app_test1' });
    await enqueueOutbox(rig.t.pool, 'notification', { kind: 'fx.fallback-needed', chain: 'solana', pair: 'EUR/USD', periodId: '2026Q1', reason: 'coverage' });
    // a kind this module has no template for, carrying things that must never be stored
    await enqueueOutbox(rig.t.pool, 'notification', { kind: 'hardship.requested', seriesId, hardshipId: 'hs_1', attestor: h.attestors[0]!.address, reason: `medical, income ${CANARY}`, amount: CANARY });
    const r = await dispatch();
    expect(r).toEqual({ dispatched: 7, failed: 0 });

    // issuer: reminder, payout, status change, hardship (muted PauseEnded is skipped entirely)
    const iss = await inbox('acct-issuer');
    expect(iss.map((n) => n.kind)).toEqual(['reporting.report-due', 'payout.available', 'series.StatusChanged', 'hardship.requested']);
    const rem = iss.find((n) => n.kind === 'reporting.report-due')!;
    expect(rem.subject).toBe('Report due');
    expect(rem.body).toContain(seriesId);
    expect(rem.body).toContain('2026Q1');
    expect(rem.body).toContain(new Date(dueAt * 1000).toISOString().slice(0, 10));
    // the keeper sends 'report-due' once dueAt has passed, the first InGrace instant under Stage 1's inclusive bound
    // (G2, S1 WP11: was sent at dueAt); the status named is the one the keeper read from the chain (S1 review: it was
    // hard-coded InGrace)
    expect(rem.body).toContain('Status: InGrace.');
    // no amounts: the only digits in the body are the period id, the series id and ISO dates
    const stripped = rem.body.replace(seriesId, '').replace(/\d{4}Q[1-4]/g, '').replace(/\d{4}-\d{2}-\d{2}/g, '');
    expect(stripped).not.toMatch(/\d/);
    expect(Object.keys(rem.data).sort()).toEqual(['dueAt', 'graceEndsAt', 'outstanding', 'periodId', 'seriesId', 'status', 'wallet']);
    expect(rem.email_sent_at).not.toBeNull();
    const sc = iss.find((n) => n.kind === 'series.StatusChanged')!;
    expect(sc.body).toContain('from OnTime to InGrace');
    expect(sc.data).toEqual({ seriesId, from: 'OnTime', to: 'InGrace' });
    // unknown kind: generic subject; reason and amount never stored; the canary is nowhere in the module's tables
    const hs = iss.find((n) => n.kind === 'hardship.requested')!;
    expect(hs.subject).toBe('Update: hardship.requested');
    expect(hs.data).toEqual({ seriesId, hardshipId: 'hs_1', attestor: h.attestors[0]!.address });
    const scan = await rig.t.pool.query("select count(*)::int as n from (select subject || body || data::text as t from notifications union all select to_address || subject || body from email_outbox) x where t like '%' || $1 || '%' or t ilike '%medical%'", [CANARY]);
    expect(scan.rows[0].n).toBe(0);

    // holder (backer 0 holds units): payout, PauseEnded (not muted for them), StatusChanged, and their own application
    const hold = await inbox('acct-holder');
    expect(hold.map((n) => n.kind).sort()).toEqual(['application.submitted', 'payout.available', 'series.PauseEnded', 'series.StatusChanged']);
    expect(hold.every((n) => n.email_sent_at === null)).toBe(true);
    // the reminder is for the issuer alone
    expect(hold.some((n) => n.kind === 'reporting.report-due')).toBe(false);

    // admins: the review item and fx; attestors: fx.fallback-needed and the hardship naming their wallet
    expect((await inbox('acct-admin')).map((n) => n.kind).sort()).toEqual(['application.submitted', 'fx.fallback-needed']);
    expect((await inbox('acct-ghost-att')).map((n) => n.kind)).not.toContain('fx.fallback-needed');
    const att = await inbox('acct-att');
    expect(att.map((n) => n.kind).sort()).toEqual(['fx.fallback-needed', 'hardship.requested']);
    const fx = att.find((n) => n.kind === 'fx.fallback-needed')!;
    expect(fx.body).toContain('EUR/USD');
    expect(fx.body).not.toContain('coverage');
    expect(fx.data).toEqual({ chain: 'solana', pair: 'EUR/USD', periodId: '2026Q1' });
    // the attestor has an address but email off: nothing sent
    expect(att.every((n) => n.email_sent_at === null)).toBe(true);

    // exactly the issuer's unmuted notifications went out as email
    const sent = await emails();
    expect(sent.map((e) => e.to_address)).toEqual(['issuer@example.test', 'issuer@example.test', 'issuer@example.test', 'issuer@example.test']);
    expect(sent.map((e) => e.subject)).toContain('Report due');
    expect(JSON.stringify(sent)).not.toContain(CANARY);
  });

  it('handler: redelivery of the same payload does not duplicate inbox rows or emails; a series not indexed yet is retried', async () => {
    const before = await rig.t.pool.query('select count(*)::int as n from notifications');
    const mails = (await emails()).length;
    await enqueueOutbox(rig.t.pool, 'notification', { kind: 'reporting.report-due', seriesId, periodId: '2026Q1', wallet: h.issuer.address, dueAt, graceEndsAt, outstanding: 'report', status: 'InGrace' });
    await enqueueOutbox(rig.t.pool, 'notification', { kind: 'payout.available', seriesId, periodId: '2026Q1' });
    expect(await dispatch()).toEqual({ dispatched: 2, failed: 0 });
    expect((await rig.t.pool.query('select count(*)::int as n from notifications')).rows[0].n).toBe(before.rows[0].n);
    expect((await emails()).length).toBe(mails);
    // the handler is also safe to call directly twice (the keeper may redeliver outside dispatchOutbox)
    const handler = notificationsOutboxHandler(rig.ctx);
    await handler('notification', { kind: 'payout.available', seriesId, periodId: '2026Q1' });
    await handler('other-topic', { kind: 'payout.available', seriesId, periodId: '2026Q1' });
    expect((await rig.t.pool.query('select count(*)::int as n from notifications')).rows[0].n).toBe(before.rows[0].n);
    // an unknown series stays in the backlog with a last_error and is attempted again next run
    await enqueueOutbox(rig.t.pool, 'notification', { kind: 'payout.available', seriesId: 'solana:not-a-series', periodId: '2026Q1' });
    expect(await dispatch()).toEqual({ dispatched: 0, failed: 1 });
    const pending = await rig.t.pool.query("select attempts, last_error from outbox where dispatched_at is null and payload->>'seriesId' = 'solana:not-a-series'");
    expect(pending.rows[0]).toMatchObject({ attempts: 1 });
    expect(pending.rows[0].last_error).toContain('not indexed');
  });

  it('safeData: nested chain-event payloads are flattened; reasons and amounts are dropped', () => {
    expect(safeData({ kind: 'series.ReleasesPaused', seriesId: 's', payload: { seriesId: 's', reason: 'Late' } })).toEqual({ seriesId: 's' });
    expect(safeData({ kind: 'fx.deviation', chain: 'monad', pair: 'EUR/USD', deviationBps: 150 })).toEqual({ chain: 'monad', pair: 'EUR/USD' });
    expect(safeData({ kind: 'x', paymentDue: '1000000', accrual: '5', incomeYtd: CANARY, periodId: '2026Q2' })).toEqual({ periodId: '2026Q2' });
  });

  it('reporting reminders name the status the keeper read from the chain, never one assumed from the milestone, and what is owed', () => {
    const base = { seriesId: 's', periodId: '2026Q2', wallet: 'w', dueAt: 1_785_456_000, graceEndsAt: 1_786_752_000 };
    const render = (p: Record<string, unknown>) => TEMPLATES[String(p.kind)]!(safeData(p));
    // S1 review: a Late series was told 'Status: InGrace' (hard-coded); the status is now the payload's
    expect(render({ kind: 'reporting.report-due', ...base, outstanding: 'report', status: 'Late' }).body).toMatch(/grace period has started\. The grace period ends on 2026-08-15\. Status: Late\.$/);
    expect(render({ kind: 'reporting.grace-end', ...base, outstanding: 'payment', status: 'Late' }).body).toMatch(/Status: Late\.$/);
    // a payload queued without a status (or with something that is not a lifecycle status) names none
    for (const status of [undefined, '', 'paid in full', CANARY]) {
      for (const kind of ['reporting.report-due', 'reporting.grace-end']) {
        const body = render({ kind, ...base, status }).body;
        expect(body).not.toContain('Status:');
        expect(body).not.toContain(CANARY);
      }
    }
    // a reported period whose payment is open: the payment is what is owed
    const pay = render({ kind: 'reporting.report-due-soon', ...base, outstanding: 'payment', status: 'OnTime' });
    expect(pay).toEqual({ subject: 'Payment due soon', body: 'The payment for series s, period 2026Q2 is due by 2026-07-31.' });
    expect(render({ kind: 'reporting.report-due', ...base, outstanding: 'payment', status: 'InGrace' }).subject).toBe('Payment due');
    // otherwise (and for a payload without the field) the report is
    expect(render({ kind: 'reporting.report-due-soon', ...base }).subject).toBe('Report due soon');
    expect(render({ kind: 'reporting.report-due', ...base, outstanding: 'report' }).body).toMatch(/^The report for series s, period 2026Q2 was due by 2026-07-31/);
  });

  it('inbox routes: list, unread filter, limit, mark read (own rows only, idempotent)', async () => {
    const all = await rig.get('/me/notifications', issuerTok);
    expect(all.statusCode).toBe(200);
    expect(all.json().notifications.length).toBe(4);
    expect(all.json().unreadCount).toBe(4);
    expect(all.json().notifications[0]).toMatchObject({ kind: expect.any(String), subject: expect.any(String), body: expect.any(String), readAt: null });
    expect(JSON.stringify(all.json())).not.toContain(CANARY);
    expect((await rig.get('/me/notifications?limit=2', issuerTok)).json().notifications.length).toBe(2);
    expect((await rig.get('/me/notifications?limit=0', issuerTok)).statusCode).toBe(400);
    const ids = all.json().notifications.map((n: { notificationId: string }) => n.notificationId) as string[];
    // a holder cannot mark the issuer's rows
    const foreign = await rig.post('/me/notifications/read', { ids: [ids[0]] }, holderTok);
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().read).toEqual([]);
    const read = await rig.post('/me/notifications/read', { ids: [ids[0], ids[1]] }, issuerTok, { 'idempotency-key': 'read-1' });
    expect(read.statusCode).toBe(200);
    expect(read.json().read.sort()).toEqual([ids[0], ids[1]].sort());
    expect(read.json().unreadCount).toBe(2);
    // replay with the same key returns the same answer; a different body under the same key is a 409
    expect((await rig.post('/me/notifications/read', { ids: [ids[0], ids[1]] }, issuerTok, { 'idempotency-key': 'read-1' })).json()).toEqual(read.json());
    expect((await rig.post('/me/notifications/read', { ids: [ids[2]] }, issuerTok, { 'idempotency-key': 'read-1' })).statusCode).toBe(409);
    // marking again without a key is a no-op
    expect((await rig.post('/me/notifications/read', { ids: [ids[0]] }, issuerTok)).json().read).toEqual([]);
    const unread = await rig.get('/me/notifications?unread=true', issuerTok);
    expect(unread.json().notifications.map((n: { notificationId: string }) => n.notificationId).sort()).toEqual([ids[2], ids[3]].sort());
    expect(unread.json().unreadCount).toBe(2);
    expect((await rig.post('/me/notifications/read', { ids: [] }, issuerTok)).statusCode).toBe(400);
  });

  it('admin routes: outbox backlog with failed rows and the mock email outbox; both audited', async () => {
    const ob = await rig.get('/admin/notifications/outbox', adminTok);
    expect(ob.statusCode).toBe(200);
    expect(ob.json().counts).toMatchObject({ pending: 1, failed: 1 });
    expect(ob.json().counts.dispatched).toBeGreaterThanOrEqual(9);
    expect(ob.json().failed).toHaveLength(1);
    expect(ob.json().failed[0]).toMatchObject({ kind: 'payout.available', attempts: 1 });
    expect(ob.json().failed[0].lastError).toContain('not indexed');
    expect(ob.json().recent.length).toBeGreaterThanOrEqual(10);
    expect(ob.json().recent[0]).toMatchObject({ id: expect.any(Number), topic: 'notification', payload: expect.any(Object) });
    const em = await rig.get('/admin/notifications/emails?limit=2', adminTok);
    expect(em.statusCode).toBe(200);
    expect(em.json().channel).toBe('mock-email');
    expect(em.json().emails).toHaveLength(2);
    expect(em.json().emails[0]).toMatchObject({ to: 'issuer@example.test', subject: expect.any(String), body: expect.any(String) });
    expect((await rig.get('/admin/notifications/emails', adminTok)).json().emails).toHaveLength(4);
    const audit = await rig.t.pool.query("select action from audit_log where actor = 'acct-admin' order by id");
    expect(audit.rows.map((r) => r.action)).toEqual(['notifications.outbox.view', 'notifications.emails.view', 'notifications.emails.view']);
  });

  it('access matrix: inbox and preferences need a session; the outbox and email views are admin-only', async () => {
    expect((await rig.get('/me/notifications')).statusCode).toBe(401);
    expect((await rig.post('/me/notifications/read', { ids: ['x'] })).statusCode).toBe(401);
    expect((await rig.get('/me/notification-preferences')).statusCode).toBe(401);
    expect((await rig.put('/me/notification-preferences', { email: true, mutedKinds: [] })).statusCode).toBe(401);
    expect((await rig.get('/admin/notifications/outbox')).statusCode).toBe(401);
    for (const tok of [issuerTok, holderTok, attTok]) {
      expect((await rig.get('/admin/notifications/outbox', tok)).statusCode).toBe(403);
      expect((await rig.get('/admin/notifications/emails', tok)).statusCode).toBe(403);
    }
    // any signed-in account reaches its own inbox, even with no rows
    const stranger = rig.token({ accountId: 'acct-nobody', wallets: [], roles: [] });
    expect((await rig.get('/me/notifications', stranger)).json()).toEqual({ notifications: [], unreadCount: 0 });
    // but preferences need an account row to attach to
    expect((await rig.put('/me/notification-preferences', { email: true, mutedKinds: [] }, stranger)).statusCode).toBe(404);
  });

  // S2 WP6: the settlement notices (Stage 1's multi-step settlement and the keepers' delivery). The outbox rows carry the
  // events' public onchain amounts (S2 L16); no inbox row, email or template does
  it('auction notices: the new kinds render without amounts; a failed raise reaches its bidders; a delivery reaches only its bidder; the stuck kinds reach the admins', async () => {
    const b0 = h.backers[0]!.address;
    const b1 = h.backers[1]!.address; // a bidder with no account: nobody else gets its delivery
    const chainNotice = (kind: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ kind, seriesId, chain: 'solana', seq: 900_000 + Object.keys(payload).length + kind.length, txId: `tx-${kind}`, ...extra, payload: { seriesId, ...payload } });
    const payloads = [
      chainNotice('auction.failed', { reason: 'MinRaise', clearingPrice: CANARY, unitsSold: '10', proceeds: CANARY, minimumRaise: CANARY }),
      chainNotice('auction.settlement-rejected', { round: 1, clearingPrice: CANARY, reason: 'ClaimMismatch' }),
      chainNotice('auction.mint-finalized', { unitsSold: '500', proceeds: CANARY }, { outcome: 'settled' }),
      chainNotice('bid.delivered', { bidder: b0, units: '100', refund: CANARY }, { wallet: b0 }),
      chainNotice('bid.delivered', { bidder: b1, units: '100', refund: CANARY }, { wallet: b1 }),
      { kind: 'auction.settlement-stuck', seriesId, outcome: 'ProposalRejected' },
      { kind: 'bid.delivery-stuck', seriesId, wallet: b0 },
    ];
    for (const p of payloads) await enqueueOutbox(rig.t.pool, 'notification', p);
    expect(await dispatch()).toMatchObject({ dispatched: payloads.length });
    const kinds = new Set(payloads.map((p) => p.kind));
    const mine = async (accountId: string) => (await inbox(accountId)).filter((n) => kinds.has(n.kind));
    // the bidder: the failed raise (its deposit comes back), its own delivery and its delayed one
    expect((await mine('acct-holder')).map((n) => n.kind).sort()).toEqual(['auction.failed', 'bid.delivered', 'bid.delivery-stuck']);
    // the issuer: its raise's outcome and a rejected proposal; never a bidder's delivery, nor the operator alert
    expect((await mine('acct-issuer')).map((n) => n.kind).sort()).toEqual(['auction.failed', 'auction.mint-finalized', 'auction.settlement-rejected']);
    // the admins: the rejected proposal and both stuck kinds
    expect((await mine('acct-admin')).map((n) => n.kind).sort()).toEqual(['auction.settlement-rejected', 'auction.settlement-stuck', 'bid.delivery-stuck']);
    expect(await mine('acct-att')).toEqual([]);
    // b1's delivery reached nobody: it has no account, and the issuer is not told of a bidder's delivery
    const delivered = await rig.t.pool.query("select account_id from notifications where kind = 'bid.delivered'");
    expect(delivered.rows).toEqual([{ account_id: 'acct-holder' }]);
    // no amount anywhere: the only digits are the series id's and the stored data keeps ids and codes only
    const rows = [...(await mine('acct-holder')), ...(await mine('acct-issuer')), ...(await mine('acct-admin'))];
    for (const n of rows) {
      expect(`${n.subject} ${n.body}`.replace(seriesId, '')).not.toMatch(/\d/);
      expect(JSON.stringify(n.data)).not.toContain(CANARY);
      expect(Object.keys(n.data).every((k) => ['seriesId', 'chain', 'wallet', 'outcome'].includes(k))).toBe(true);
    }
    expect(rows.find((n) => n.kind === 'auction.failed')!.body).toContain('Deposits are returned automatically.');
    expect(rows.find((n) => n.kind === 'auction.mint-finalized')!.body).toMatch(/units are minted.*Status: Settled\.$/);
    expect(rows.find((n) => n.kind === 'auction.settlement-stuck')!.body).toContain('(ProposalRejected)');
    // a failed raise's mint notice says so; a stuck reason that is not a bare code is not printed
    expect(TEMPLATES['auction.mint-finalized']!(safeData({ seriesId: 's', outcome: 'failed' })).body).toBe('Every bid on series s has been processed. Status: Failed. Deposits are returned automatically.');
    expect(TEMPLATES['auction.settlement-stuck']!(safeData({ seriesId: 's', outcome: `paid ${CANARY}` })).body).not.toContain(CANARY);
    const scan = await rig.t.pool.query("select count(*)::int as n from (select subject || body || data::text as t from notifications union all select to_address || subject || body from email_outbox) x where t like '%' || $1 || '%'", [CANARY]);
    expect(scan.rows[0].n).toBe(0);
  });
});
