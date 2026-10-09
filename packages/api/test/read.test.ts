import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { parsePeriod } from '@merces/math';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

describe.skipIf(!dbTestsEnabled())('API read side (M1)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let seriesId: string;
  let monSeriesId: string;
  let issuerTok: string;
  let holderTok: string;
  let strangerTok: string;
  beforeAll(async () => {
    rig = await makeRig();
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
    // refundable excludes the allocated spend and its fee, and agrees with the refund builder:
    // deposit 1212 USDC (100 × 12 + 1%), spent 100 × 9 = 900, fee 9 → 303 USDC
    expect(mine.json().bids[0].refundable).toBe(USDC(303).toString());
    const built = await rig.post(`/series/${seriesId}/bids/build-refund`, { bidder: rig.sol.backers[0]!.address }, holderTok);
    expect(built.json().refundable).toBe(mine.json().bids[0].refundable);
    // a bidder at the clearing price who won everything has nothing to refund
    const lastTok = rig.token({ accountId: 'b4', wallets: [{ chain: 'solana', address: rig.sol.backers[4]!.address }], roles: ['backer'] });
    expect((await rig.get('/me/bids', lastTok)).json().bids[0].refundable).toBe('0');
    expect((await rig.post(`/series/${seriesId}/bids/build-refund`, { bidder: rig.sol.backers[4]!.address }, lastTok)).statusCode).toBe(409);
  });

  it('a series id with an unknown or missing chain prefix is 404 on every series route, never 500', async () => {
    for (const url of ['/series/nochain:0xabc/auction', '/series/abc/auction/preview', '/series/nochain:1/retirement', '/series/nochain:1/window', '/series/nochain:1/curve', '/series/:1/auction', '/series/nochain:1/status']) {
      const r = await rig.get(url);
      expect([url, r.statusCode]).toEqual([url, 404]);
      expect(r.json().error).toBe('NotFound');
    }
    // relaying to an unconfigured chain is a client error
    const tx = await rig.sol.sim.build({ kind: 'claimPayout', seriesId }, rig.sol.backers[0]!.address);
    const signed = await rig.sol.backers[0]!.sign({ ...tx, chain: 'nochain' });
    expect((await rig.post('/tx/send', signed, holderTok)).statusCode).toBe(400);
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
