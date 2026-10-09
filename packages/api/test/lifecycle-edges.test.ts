import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { setFlag } from '@merces/core';
import { orderCommitment } from '@merces/domain';
import { KeeperScheduler, transferWindowsJob } from '@merces/keepers';
import { periodOf } from '@merces/math';
import { defaultTerms } from '@merces/simulator';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/** Edges of the lifecycle: windows on finished series, extinguishment accounting, curve raises that cannot be cancelled. */
describe.skipIf(!dbTestsEnabled())('lifecycle edges', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let adminTok: string;
  beforeAll(async () => {
    rig = await makeRig();
    adminTok = rig.token({ accountId: 'adm', roles: ['admin'], wallets: [] });
  });
  afterAll(async () => {
    await rig.close();
  });

  it('an open transfer window is cleared after its reveal even when the series became terminal and the flag is off', async () => {
    const h = rig.mon;
    const { seriesId } = await h.runRaise({ terms: { lockupSeconds: 10 } });
    await setFlag(rig.t.pool, 'transfer_windows', true, 'test');
    const sched = new KeeperScheduler(rig.ctx, [transferWindowsJob]);
    const now0 = await h.sim.now();
    await h.sim.setTime(Math.max(now0 + 11, periodOf(now0).start + 15 * 86_400));
    await sched.runAll();
    const w = (await h.sim.getTransferWindow(seriesId))!;
    expect(w.cleared).toBe(false);
    const buyer = h.sim.address('wallet:edge-buyer');
    await h.sim.submit({ kind: 'setAllowlist', wallet: buyer, allowed: true }, 'allowlistManager');
    await h.sim.fund(buyer, 'USDC', USDC(10_000));
    const bc = orderCommitment({ seriesId, windowId: w.windowId, wallet: buyer, side: 'buy', pricePerUnit: USDC(11), quantity: 40n, salt: '0x' + 'bb'.repeat(32) });
    await h.sim.send({ tx: await h.sim.build({ kind: 'commitWindowOrder', seriesId, windowId: w.windowId, side: 'buy', commitment: bc, deposit: USDC(440).toString(), units: '0' }, buyer), signatures: { [buyer]: `sim:${buyer}` } });
    expect(BigInt(await h.sim.getBalance(buyer, 'USDC'))).toBe(USDC(9_560));
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1000).toString() });
    await setFlag(rig.t.pool, 'transfer_windows', false, 'test');
    await h.sim.setTime(w.revealEndsAt + 1);
    const r = await sched.runAll();
    expect(r['transfer.windows']).toMatchObject({ ok: true, actions: 1 });
    expect((await h.sim.getTransferWindow(seriesId))!.cleared).toBe(true);
    // nothing is matched on a Redeemed series: clearing paid the whole deposit back
    expect(BigInt(await h.sim.getBalance(buyer, 'USDC'))).toBe(USDC(10_000));
  });

  it('extinguishing a settled series returns the treasury to holders without counting it as an issuer payment', async () => {
    const h = rig.sol;
    const { seriesId } = await h.runRaise();
    await h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!]);
    await rig.sync();
    const rec = await rig.get('/admin/accounting/reconcile', adminTok);
    expect(rec.json().checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    const st = (await rig.get(`/admin/accounting/series/${seriesId}`, adminTok)).json();
    expect(st.treasury).toMatchObject({ released: st.treasury.total, balance: '0' });
    expect(st.payments.grossPaidTotal).toBe('0');
    expect(BigInt(st.payments.netDistributed)).toBe(BigInt(st.treasury.total));
  });

  it('an ungraduated curve: buys fund the treasury in the read model; after extinguishment holders claim it and the raise cannot be cancelled', async () => {
    const h = rig.sol;
    const { terms } = defaultTerms(h.sim, { raiseStyle: 'curve', minimumRaise: USDC(2000).toString(), reservePrice: USDC(5).toString(), unitsOffered: '1000' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    await h.exec(h.backers[0]!, { kind: 'buyCurve', seriesId, amountIn: USDC(1000).toString(), minUnitsOut: '0' });
    await h.exec(h.backers[1]!, { kind: 'buyCurve', seriesId, amountIn: USDC(500).toString(), minUnitsOut: '0' });
    await rig.sync();
    expect((await rig.t.pool.query('select treasury_total::text as t from series where series_id = $1', [seriesId])).rows[0].t).toBe(USDC(1500).toString());
    // with units out there is no raise to cancel
    await expect(h.exec(h.issuer, { kind: 'cancelRaise', seriesId })).rejects.toMatchObject({ code: 'TooLate' });
    await h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!]);
    await expect(h.exec(h.issuer, { kind: 'cancelRaise', seriesId })).rejects.toMatchObject({ code: 'WrongStatus' });
    let claimed = 0n;
    for (const b of [h.backers[0]!, h.backers[1]!]) claimed += BigInt(((await h.exec(b, { kind: 'claimPayout', seriesId })).events[0]!.payload as { amount: string }).amount);
    expect(USDC(1500) - claimed).toBeLessThan(10n); // rounding dust only
    await rig.sync();
    const row = (await rig.t.pool.query('select status, treasury_total::text as t, treasury_released::text as r, gross_paid_total::text as g from series where series_id = $1', [seriesId])).rows[0];
    expect(row).toMatchObject({ status: 'Extinguished', t: USDC(1500).toString(), r: USDC(1500).toString(), g: '0' });
    expect((await rig.get('/admin/accounting/reconcile', adminTok)).json().checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    // the cap view says plainly that this curve is closed rather than 'until graduation'
    expect((await rig.get(`/series/${seriesId}/curve`)).json().walletCap).toMatchObject({ enforced: false, note: 'Curve buys are closed and this curve will not graduate.' });
    // and the curve no longer builds buys (a USDG buyer would otherwise swap for real and then revert)
    const tok = await rig.grant({ accountId: 'curve-b0', wallets: [{ chain: 'solana', address: h.backers[0]!.address }], roles: ['backer'] });
    const buy = await rig.post(`/series/${seriesId}/curve/build-buy`, { buyer: h.backers[0]!.address, amountIn: USDC(10).toString(), payIn: 'USDG' }, tok);
    expect(buy.statusCode).toBe(409);
  });
});
