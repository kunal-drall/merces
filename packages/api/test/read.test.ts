import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { parsePeriod } from '@merces/math';
import { seriesKeyOf, type DomainEvent } from '@merces/domain';
import { project } from '@merces/indexer';
import { SimWallet } from '@merces/simulator';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
/*
 * S2 cause codes:
 *  - S2-PR: push delivery (`deliverBid`): the raise delivers every bid's refund and units; the pull refund is retired;
 *  - S2-RH: registerHolder (`HolderRegistered`).
 *
 * S3 cause codes:
 *  - S3-IX: a claim never creates a position (Stage 1's zero-amount rule lets a registered wallet with nothing send one).
 *
 * S4 cause codes:
 *  - S4-CTX: the signing context (S4 D6, D7): `GET /chains` carries each chain's signing domain, and the public
 *    `GET /series/{seriesId}/signing` reads the domain, the series key and the nonces live from the chain.
 */

describe.skipIf(!dbTestsEnabled())('API read side (M1)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let seriesId: string;
  let monSeriesId: string;
  let issuerTok: string;
  let holderTok: string;
  let strangerTok: string;
  beforeAll(async () => {
    rig = await makeRig();
    // cause S2-PR: the raise delivers every bid (push delivery), so nothing is left refundable below
    const a = await rig.sol.runRaise();
    seriesId = a.seriesId;
    monSeriesId = (await rig.mon.runRaise()).seriesId;
    await rig.sol.sim.setTime(parsePeriod('2026Q3').end + 86_400);
    await rig.sol.reportAndPay(seriesId, '2026Q1', a.privateTerms, a.terms.termsCommitment, 0n, USDC(10_000));
    await rig.sol.reportAndPay(seriesId, '2026Q2', a.privateTerms, a.terms.termsCommitment, USDC(10_000), USDC(50_000));
    await rig.sol.reportAndPay(seriesId, '2026Q3', a.privateTerms, a.terms.termsCommitment, USDC(50_000), USDC(75_000));
    await rig.sol.exec(rig.sol.backers[0]!, { kind: 'claimPayout', seriesId });
    await rig.sync();
    issuerTok = rig.token({ accountId: 'issuer', wallets: [{ chain: 'solana', address: rig.sol.issuer.address }], roles: ['issuer'] });
    holderTok = rig.token({ accountId: 'b0', wallets: [{ chain: 'solana', address: rig.sol.backers[0]!.address }], roles: ['backer'] });
    strangerTok = rig.token({ accountId: 'x', wallets: [{ chain: 'solana', address: 'nobody' }], roles: ['backer'] });
  });
  afterAll(async () => {
    await rig.close();
  });

  it('serves health, chains and the chain-neutral series list across both chains', async () => {
    const h = await rig.get('/health');
    expect(h.statusCode).toBe(200);
    expect(h.json().chains.map((c: { chain: string; mode: string }) => [c.chain, c.mode])).toEqual([['solana', 'mock'], ['monad', 'mock']]);
    const chains = await rig.get('/chains');
    expect(chains.json().chains.find((c: { chain: string }) => c.chain === 'monad').stablecoins.map((s: { symbol: string }) => s.symbol)).toEqual(['USDC']);
    const list = await rig.get('/series');
    expect(list.json().series.map((s: { seriesId: string }) => s.seriesId).sort()).toEqual([seriesId, monSeriesId].sort());
    const one = await rig.get(`/series/${seriesId}`);
    expect(one.json().unitsOutstanding).toBe('500');
    // S3: Stage 1's unit scale, derived from the raise style (a sealed-bid series counts whole units)
    expect(one.json().unitScale).toBe('1');
    expect(one.json().holderCount).toBe(5);
    expect(one.json().terms.termsCommitment).toMatch(/^0x/);
    expect(one.json().terms).not.toHaveProperty('threshold');
    expect((await rig.get('/series/solana:nope')).statusCode).toBe(404);
    const issuers = await rig.get('/issuers');
    expect(issuers.json().issuers).toHaveLength(2);
    const issuer = await rig.get(`/issuers/solana:${rig.sol.issuer.address}`);
    expect(issuer.json().series).toHaveLength(1);
    const arena = await rig.get('/arena');
    expect(arena.json().arena).toHaveLength(2);
    expect(JSON.stringify(arena.json())).not.toContain('1500000000');
  });

  it('public status and activity carry no amounts; amounts need the right tier', async () => {
    const st = await rig.get(`/series/${seriesId}/status`);
    expect(st.json().status).toBe('OnTime');
    expect(st.json().periods.map((p: { periodId: string; standing: string }) => [p.periodId, p.standing])).toEqual([['2026Q1', 'OnTime'], ['2026Q2', 'OnTime'], ['2026Q3', 'OnTime']]);
    const act = await rig.get(`/series/${seriesId}/activity`);
    const text = JSON.stringify(act.json());
    expect(text).toContain('Payment received for 2026Q3');
    expect(text).not.toMatch(/1500000000|1425000000|285000000/);
    // per-series activity carries the series id like the global feed does
    expect(act.json().activity.length).toBeGreaterThan(0);
    expect(act.json().activity.every((a: { seriesId: string | null }) => a.seriesId === seriesId)).toBe(true);
    const global = await rig.get('/activity?limit=5');
    expect(global.json().activity).toHaveLength(5);
    // periods with amounts: anonymous 401, stranger 403, holder and issuer 200
    expect((await rig.get(`/series/${seriesId}/periods`)).statusCode).toBe(401);
    expect((await rig.get(`/series/${seriesId}/periods`, strangerTok)).statusCode).toBe(403);
    const holderView = await rig.get(`/series/${seriesId}/periods`, holderTok);
    expect(holderView.statusCode).toBe(200);
    expect(holderView.json().periods.find((p: { periodId: string }) => p.periodId === '2026Q3').paid).toBe(USDC(1500).toString());
    expect((await rig.get(`/series/${seriesId}/periods`, issuerTok)).statusCode).toBe(200);
    // treasury: issuer only
    expect((await rig.get(`/series/${seriesId}/treasury`, holderTok)).statusCode).toBe(403);
    const tr = await rig.get(`/series/${seriesId}/treasury`, issuerTok);
    expect(tr.json().total).toBe(USDC(4500).toString());
    expect(tr.json().earlyDraws.enabled).toBe(false);
  });

  it('holder views: payouts, position, holdings with yield', async () => {
    const payouts = await rig.get(`/series/${seriesId}/payouts`, holderTok);
    expect(payouts.json().payouts.some((p: { kind: string; amount: string }) => p.kind === 'payout' && p.amount === USDC(285).toString())).toBe(true);
    const pos = await rig.get(`/series/${seriesId}/position`, holderTok);
    expect(pos.json().positions[0].claimedTotal).toBe(USDC(285).toString());
    const holdings = await rig.get('/me/holdings', holderTok);
    const h = holdings.json().holdings[0];
    expect(h.units).toBe('100');
    expect(h.claimedTotal).toBe(USDC(285).toString());
    expect(h.realisedYieldBps).toBe(Math.floor((285 / 900) * 10_000));
    expect(h).not.toHaveProperty('incomeSources');
    expect((await rig.get('/me/holdings')).statusCode).toBe(401);
    const mine = await rig.get('/me/bids', holderTok);
    expect(mine.json().bids[0].allocatedUnits).toBe('100');
    // cause S2-PR: the refund was pushed at delivery: the deposit 1212 USDC (100 × 12 + 1%) less the cost 100 × 9 = 900
    // and its 9 fee → 303 USDC delivered; nothing is refundable any more and the delivery builder refuses (409)
    expect(mine.json().bids[0]).toMatchObject({ valid: true, processed: true, delivered: true, pendingUnits: '0', pendingRefund: '0', refundable: '0', refunded: USDC(303).toString() });
    // cause S2-PR: the delivery builder is build-deliver (was build-refund)
    const again = await rig.post(`/series/${seriesId}/bids/build-deliver`, { bidder: rig.sol.backers[0]!.address }, holderTok);
    expect([again.statusCode, again.json().detail]).toEqual([409, { stage1: 'AlreadyDelivered' }]);
    // a bidder at the clearing price who won everything had nothing to refund
    const lastTok = rig.token({ accountId: 'b4', wallets: [{ chain: 'solana', address: rig.sol.backers[4]!.address }], roles: ['backer'] });
    expect((await rig.get('/me/bids', lastTok)).json().bids[0]).toMatchObject({ refundable: '0', refunded: '0', delivered: true });
    expect((await rig.post(`/series/${seriesId}/bids/build-deliver`, { bidder: rig.sol.backers[4]!.address }, lastTok)).statusCode).toBe(409); // cause S2-PR
  });

  // cause S2-RH: Stage 1's register_holder is permissionless for any allowlisted wallet, so a registration alone is not
  // a holding (A-REV-10): it opens no holder-tier route and adds no holding. The simulator emits HolderRegistered from
  // S2 WP4, so the event is projected here directly.
  it('a wallet that is only registered as a holder gets no holder-tier access and no holding', async () => {
    const wallet = 'registered-only';
    const e = { chain: 'solana', cursor: '000009000001', seq: 9_000_001, blockTime: 1_780_000_000, blockRef: '9000001', txId: 'synthetic-register', finality: 'finalized', type: 'HolderRegistered', payload: { seriesId, holder: wallet } } as DomainEvent;
    const c = await rig.t.pool.connect();
    try {
      await project(c, e);
    } finally {
      c.release();
    }
    expect((await rig.t.pool.query('select 1 from holder_registrations where series_id = $1 and wallet = $2', [seriesId, wallet])).rowCount).toBe(1);
    const tok = rig.token({ accountId: 'registered-only', wallets: [{ chain: 'solana', address: wallet }], roles: ['backer'] });
    for (const route of ['periods', 'vault', 'holders', 'payouts', 'position']) {
      expect([route, (await rig.get(`/series/${seriesId}/${route}`, tok)).statusCode]).toEqual([route, 403]);
      expect([route, (await rig.get(`/series/${seriesId}/${route}`, holderTok)).statusCode]).toEqual([route, 200]);
    }
    expect((await rig.get('/me/holdings', tok)).json().holdings).toEqual([]);
    const holders = (await rig.get(`/series/${seriesId}/holders`, holderTok)).json().holders as { wallet: string }[];
    expect(holders).toHaveLength(5);
    expect(holders.map((h) => h.wallet)).not.toContain(wallet);
    expect((await rig.get(`/series/${seriesId}`)).json().holderCount).toBe(5);
  });

  // cause S3-IX: once a claim of nothing emits PayoutClaimed (Stage 1's zero-amount rule), any allowlisted wallet could
  // register and claim 0 onchain; the claim must not open the holder tier either (A-REV-10). Sent on the chain and
  // indexed as the indexer sees it
  it('a wallet that only registered and sent a claim of nothing gets no position, no holder-tier access and no holding', async () => {
    const h = rig.sol;
    const w = new SimWallet(h.sim.family, 'registered-zero-claimer');
    await h.sim.submit({ kind: 'setAllowlist', wallet: w.address, allowed: true }, 'allowlistManager');
    await h.sim.submit({ kind: 'registerHolder', seriesId, wallet: w.address }, 'keeper');
    const tok = rig.token({ accountId: 'registered-zero-claimer', wallets: [{ chain: 'solana', address: w.address }], roles: ['backer'] });
    const sent = await rig.post('/tx/send', await w.sign(await h.sim.build({ kind: 'claimPayout', seriesId }, w.address)), tok);
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().events.map((e: { type: string; payload: unknown }) => [e.type, e.payload])).toEqual([['PayoutClaimed', { seriesId, holder: w.address, amount: '0', burnedUnits: '0' }]]);
    await rig.sync();
    expect((await rig.t.pool.query('select 1 from positions where series_id = $1 and wallet = $2', [seriesId, w.address])).rowCount).toBe(0);
    expect((await rig.t.pool.query('select 1 from money_events where series_id = $1 and wallet = $2', [seriesId, w.address])).rowCount).toBe(0);
    for (const route of ['periods', 'vault', 'holders', 'payouts', 'position']) expect([route, (await rig.get(`/series/${seriesId}/${route}`, tok)).statusCode]).toEqual([route, 403]);
    expect((await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: w.address }, tok)).statusCode).toBe(403);
    // nor the tail and final claim builders (S3 WP4), holder-tier too; its registration builder says it is registered
    for (const pool of ['tail', 'final']) expect([pool, (await rig.post(`/series/${seriesId}/${pool}/build-claim`, { holder: w.address }, tok)).statusCode]).toEqual([pool, 403]);
    expect((await rig.post(`/series/${seriesId}/holders/build-register`, { wallet: w.address }, tok)).json()).toEqual({ tx: null, alreadyRegistered: true });
    expect((await rig.get('/me/holdings', tok)).json().holdings).toEqual([]);
    expect((await rig.get(`/series/${seriesId}`)).json().holderCount).toBe(5);
  });

  it('a series id with an unknown or missing chain prefix is 404 on every series route, never 500', async () => {
    // cause S4-CTX: the signing context joins the list
    for (const url of ['/series/nochain:0xabc/auction', '/series/abc/auction/preview', '/series/nochain:1/retirement', '/series/nochain:1/window', '/series/nochain:1/curve', '/series/:1/auction', '/series/nochain:1/status', '/series/nochain:1/signing']) {
      const r = await rig.get(url);
      expect([url, r.statusCode]).toEqual([url, 404]);
      expect(r.json().error).toBe('NotFound');
    }
    // relaying to an unconfigured chain is a client error
    const tx = await rig.sol.sim.build({ kind: 'claimPayout', seriesId }, rig.sol.backers[0]!.address);
    const signed = await rig.sol.backers[0]!.sign({ ...tx, chain: 'nochain' });
    expect((await rig.post('/tx/send', signed, holderTok)).statusCode).toBe(400);
  });

  it('the signing context is public: each chain\'s domain on /chains, a series\' key and live nonces on /series/{id}/signing (S4-CTX)', async () => {
    const sol = (await rig.sol.sim.info()).signing!;
    const mon = (await rig.mon.sim.info()).signing!;
    const chains = (await rig.get('/chains')).json().chains as { chain: string; signing: unknown }[];
    expect(chains.map((c) => [c.chain, c.signing])).toEqual([['solana', sol], ['monad', mon]]);
    expect([sol.chainKind, sol.chainId, mon.chainKind, mon.chainId]).toEqual([1, '104', 2, '31337']);
    // anonymous: the domain, the series key and the nonces are public onchain
    const s = await rig.get(`/series/${seriesId}/signing`);
    expect(s.statusCode).toBe(200);
    expect(s.json()).toEqual({ chain: 'solana', seriesId, seriesKey: seriesKeyOf(seriesId, 'solana'), domain: sol, nonces: { pause: '0', amendment: '0', extinguish: '0', trueup: '0' } });
    expect((await rig.get(`/series/${monSeriesId}/signing`)).json()).toMatchObject({ chain: 'monad', seriesKey: seriesKeyOf(monSeriesId, 'evm'), domain: mon });
    // read live from the chain, not from the index: a pause request moves the pause nonce at once
    await rig.mon.exec(rig.mon.issuer, { kind: 'requestPause', seriesId: monSeriesId, until: (await rig.mon.sim.now()) + 10 * 86_400 });
    expect((await rig.get(`/series/${monSeriesId}/signing`)).json().nonces).toEqual({ pause: '1', amendment: '0', extinguish: '0', trueup: '0' });
    expect((await rig.get('/series/monad:0x' + '00'.repeat(20) + '/signing')).statusCode).toBe(404);
    // a chain whose adapter cannot read its domain yet (the live adapters until S5): 409, value-free
    const info = await rig.mon.sim.info();
    const spy = vi.spyOn(rig.mon.sim, 'info').mockResolvedValue({ ...info, signing: null });
    try {
      const unknown = await rig.get(`/series/${monSeriesId}/signing`);
      expect([unknown.statusCode, unknown.json().detail]).toEqual([409, { reason: 'signing-domain-unknown' }]);
      expect((await rig.get('/chains')).json().chains.find((c: { chain: string }) => c.chain === 'monad').signing).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('dev routes: time travel and faucet exist in mock mode', async () => {
    const before = (await rig.get('/dev/time')).json().chains[0].now;
    const r = await rig.post('/dev/advance-time', { seconds: 60 });
    expect(r.statusCode).toBe(200);
    expect(r.json().chains[0].now).toBe(before + 60);
    const f = await rig.post('/dev/faucet', { chain: 'solana', wallet: 'someone', stablecoin: 'USDC', amount: '5' });
    expect(f.json().balance).toBe('5');
  });
});
