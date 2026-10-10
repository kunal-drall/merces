import { randomBytes } from 'node:crypto';
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
    expect(st.payments.grossPaidTotal).toBe('0');
    expect(st.payments.netDistributed).toBe(half);
  });

  it('an ungraduated curve: buys fund the treasury in the read model; the raise can be neither cancelled nor extinguished', async () => {
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
    // nor can it be extinguished before it graduates: Stage 1 extinguishes a settled raise only (M5: was the whole
    // treasury returned to the curve buyers)
    await expect(h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!])).rejects.toMatchObject({ code: 'WrongPhase', detail: { stage1: 'RaiseNotSettled' } });
    // and the attestor service does not build the doomed transaction
    const attTok = rig.token({ accountId: 'edge-att', wallets: [{ chain: 'solana', address: h.attestors[0]!.address }], roles: ['attestor'] });
    const evidence = Buffer.from(randomBytes(48)).toString('base64');
    const req = await rig.post('/attestor/extinguish', { seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address], evidenceCiphertext: evidence }, attTok);
    expect(req.statusCode, req.body).toBe(409);
    await rig.sync();
    const row = (await rig.t.pool.query('select status, extinguished_at, treasury_total::text as t, treasury_released::text as r from series where series_id = $1', [seriesId])).rows[0];
    expect(row).toMatchObject({ extinguished_at: null, t: USDC(1500).toString(), r: '0' });
    expect(row.status).not.toBe('Extinguished');
    expect((await rig.get('/admin/accounting/reconcile', adminTok)).json().checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    // the curve keeps bonding under its wallet cap
    expect((await rig.get(`/series/${seriesId}/curve`)).json().walletCap).toMatchObject({ enforced: true });
  });
});
