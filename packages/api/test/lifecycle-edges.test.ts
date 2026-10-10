import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { setFlag } from '@merces/core';
import { CURVE_NO_CAP, orderCommitment } from '@merces/domain';
import { KeeperScheduler, transferWindowsJob } from '@merces/keepers';
import { periodOf } from '@merces/math';
import { defaultTerms } from '@merces/simulator';
import { makeRig } from './helpers.ts';

/*
 * S4 cause codes on the pins that moved:
 *  - S4-BID: bid and order commitments are Stage 1's keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32) (S4 D11):
 *    the builders take no series, window or side, and the salt is 32 bytes.
 */

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/**
 * Edges of the lifecycle: windows on finished series, extinguishment accounting, curve raises that cannot be cancelled.
 *
 * Cause codes on the pins that moved with Stage 1 (S1 WP12; Stage 1's own `Simulator` gives the same figures for an
 * extinguishment in the instant of settlement: the issuer's claim_release pays tranche 0, 2,250 of the 4,500 proceeds):
 *  - G7: an extinguishment returns only the unvested proceeds (`proceeds − vested(now)`) through the final pool; the
 *    vested tranches stay in the treasury, drawable by the issuer;
 *  - M5: Stage 1 extinguishes a settled raise only (RaiseNotSettled), so an ungraduated curve cannot be extinguished.
 *  - S3-NC: a curve raise has no wallet cap at any stage (owner; Stage 1 stores 0).
 */
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
    // cause S4-BID: Stage 1's keccak commitment, over no series or window
    const bc = orderCommitment({ wallet: buyer, pricePerUnit: USDC(11), quantity: 40n, salt: '0x' + 'bb'.repeat(32) });
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

  it('extinguishing a settled series returns the unvested treasury to holders without counting it as an issuer payment', async () => {
    const h = rig.sol;
    const { seriesId } = await h.runRaise();
    await h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!]);
    await rig.sync();
    const rec = await rig.get('/admin/accounting/reconcile', adminTok);
    expect(rec.json().checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    const st = (await rig.get(`/admin/accounting/series/${seriesId}`, adminTok)).json();
    // only the unvested half (tranches 1 and 2) leaves the treasury; tranche 0 vested at settlement and stays there,
    // undrawn and drawable by the issuer (G7; was released = total, balance 0, all of it returned)
    const half = (BigInt(st.treasury.total) / 2n).toString();
    expect(st.treasury).toMatchObject({ released: '0', balance: half });
    expect(st.extinguishment.returnedToHolders).toBe(half);
    // the unvested proceeds are shown once, under the extinguishment: no issuer payment, nothing in `payments`
    // (G7, WP11: was payments.netDistributed = half), still unclaimed by the holders
    expect(st.payments).toEqual({ grossPaidTotal: '0', netDistributed: '0', feesTaken: '0', count: 0 });
    expect(st.payouts.unclaimed).toBe(half);
  });

  // cause S3-CV: a curve's buys sit in Meteora's pool, not in the treasury (Stage 1: the treasury of an unfilled curve is
  // 0), and a curve raise has no cancel (NotSealedBid; was: buys funding the treasury, cancel refused only once units existed)
  it('an unfilled curve: buys never fund the treasury; the raise can be neither cancelled nor extinguished', async () => {
    const h = rig.sol;
    const { seriesId } = await h.createCurve();
    await h.curveBuy(seriesId, h.backers[0]!, USDC(400));
    await h.curveBuy(seriesId, h.backers[1]!, USDC(350));
    await rig.sync();
    expect((await rig.t.pool.query('select treasury_total::text as t from series where series_id = $1', [seriesId])).rows[0].t).toBe('0');
    // a curve raise cannot be cancelled, before or after buys (no cancel, no failure, no deadline)
    await expect(h.exec(h.issuer, { kind: 'cancelRaise', seriesId })).rejects.toMatchObject({ code: 'WrongPhase', detail: { stage1: 'NotSealedBid' } });
    // nor can it be extinguished before it completes: Stage 1 extinguishes a settled raise only (M5: was the whole
    // treasury returned to the curve buyers)
    await expect(h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!])).rejects.toMatchObject({ code: 'WrongPhase', detail: { stage1: 'RaiseNotSettled' } });
    // and the attestor service does not build the doomed transaction
    const attTok = rig.token({ accountId: 'edge-att', wallets: [{ chain: 'solana', address: h.attestors[0]!.address }], roles: ['attestor'] });
    const evidence = Buffer.from(randomBytes(48)).toString('base64');
    const req = await rig.post('/attestor/extinguish', { seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address], evidenceCiphertext: evidence }, attTok);
    expect(req.statusCode, req.body).toBe(409);
    await rig.sync();
    const row = (await rig.t.pool.query('select status, extinguished_at, treasury_total::text as t, treasury_released::text as r from series where series_id = $1', [seriesId])).rows[0];
    expect(row).toMatchObject({ extinguished_at: null, t: '0', r: '0' });
    expect(row.status).not.toBe('Extinguished');
    expect((await rig.get('/admin/accounting/reconcile', adminTok)).json().checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    // cause S3-CV: the retirement read never offers a burn on a curve (its units never burn, CurveModeNoBurn), the admin
    // burn crank refuses it, and the redemption claim builder sends a curve holder to tendering (CurveUsesTender). The
    // positions row stands in for a staker's (stakes create them from S3 WP10), which holder access needs
    const ret = (await rig.get(`/series/${seriesId}/retirement`)).json();
    expect(ret).toMatchObject({ burnable: false });
    expect(ret.note).toMatch(/never burned/);
    const crank = await rig.post(`/series/${seriesId}/retirement/crank-burn`, {}, adminTok);
    expect([crank.statusCode, crank.json().detail]).toEqual([409, { stage1: 'CurveModeNoBurn' }]);
    await rig.t.pool.query('insert into positions (series_id, wallet, units, first_seq, last_seq) values ($1, $2, 1, 0, 0) on conflict do nothing', [seriesId, h.backers[0]!.address]);
    const holderTok = rig.token({ accountId: 'curve-holder', wallets: [{ chain: 'solana', address: h.backers[0]!.address }], roles: ['backer'] });
    const tender = await rig.post(`/series/${seriesId}/redemption/build-claim`, { holder: h.backers[0]!.address }, holderTok);
    expect([tender.statusCode, tender.json().detail]).toEqual([409, { stage1: 'CurveUsesTender' }]);
    // the curve keeps bonding, with no cap at any stage (cause S3-NC: was "under its wallet cap"); its buyers' money is
    // in the pool, net of the fee
    expect((await rig.get(`/series/${seriesId}/curve`)).json()).toMatchObject({ walletCap: null, noCap: true, noCapStatement: CURVE_NO_CAP, onchain: { quoteReserve: USDC(396 + 346.5).toString(), poolComplete: false } });
  });
});
