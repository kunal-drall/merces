import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { parsePeriod, settleHolderDelta } from '@merces/math';
import type { PrivateTerms, SimAttestor, SimHarness, SimWallet } from '@merces/simulator';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/*
 * The claim builders on a curve series (S3 WP10; Stage 1 claims.rs:182-196, :365-391, :424-452): a curve holder's
 * position row comes from its first stake (holder access, A-REV-10), the payout claim pays what the stake earned and
 * never burns, the tail claim pays the tail on tendered units (and the pending payout) and redeems nothing, the final
 * claim weighs the stake or the tendered units and burns nothing. Every figure is the chain's own read.
 *
 * S3 cause codes:
 *  - S3-ST: staking, tender and stake-weighted claims.
 *
 * S4 cause codes:
 *  - S4-ID: the harness attestors are keys (S4 WP7): `SimAttestor`, a secp256k1 key's 20-byte address (transitionally
 *    a co-signing wallet at the key's address).
 *  - S4-EXT: an extinguishment is Stage 1's permissionless `extinguish` carrying two attestor keys' EXTINGUISH signatures
 *    over the live extinguish nonce, relayed by the keeper (`h.extinguishment`; S4 WP12; was `{attestors}` with the
 *    second attestor co-signing the first one's transaction).
 */
describe.skipIf(!dbTestsEnabled())('claim builders on a curve series (S3 WP10)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let h: SimHarness;
  let seriesId: string;
  let privateTerms: PrivateTerms;
  let termsCommitment: string;
  let a: SimWallet;
  let b: SimWallet;
  let aTok: string;
  let bTok: string;

  beforeAll(async () => {
    rig = await makeRig();
    h = rig.sol;
    // half the proceeds vest a year after the fill, so an extinguishment after the tail still has a final pool
    const c = await h.createCurve({ terms: { releaseSchedule: [{ afterSeconds: 0, bps: 5000 }, { afterSeconds: 365 * 86_400, bps: 5000 }] } });
    seriesId = c.seriesId;
    privateTerms = c.privateTerms;
    termsCommitment = c.terms.termsCommitment;
    await h.fillCurve(seriesId);
    [a, b] = h.backers as [SimWallet, SimWallet];
    aTok = rig.token({ accountId: 'curve-a', wallets: [{ chain: h.sim.chain, address: a.address }] });
    bTok = rig.token({ accountId: 'curve-b', wallets: [{ chain: h.sim.chain, address: b.address }] });
  });
  afterAll(async () => {
    await rig.close();
  });

  it('a registration grants no holder access; the first stake does', async () => {
    await h.registerHolder(seriesId, a);
    await rig.sync();
    expect((await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: a.address }, aTok)).statusCode).toBe(403);
    await h.syncCurve(seriesId);
    await h.stake(seriesId, a, h.sim.curveUnitsOf(seriesId, a.address));
    await rig.sync();
    const pos = await rig.get(`/series/${seriesId}/position`, aTok);
    expect(pos.statusCode).toBe(200);
    expect(pos.json().positions[0]).toMatchObject({ registered: true, walletUnits: '0' });
  });

  it('the payout claim pays what the stake earned and burns nothing; the tail claim waits for a tender', async () => {
    const staked = BigInt((await h.sim.getPosition(seriesId, a.address))!.stakedUnits);
    await h.sim.setTime(parsePeriod('2026Q1').end + 3_600);
    await h.syncCurve(seriesId);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, termsCommitment, 0n, USDC(61_000));
    const owed = settleHolderDelta(BigInt((await h.sim.getSeries(seriesId))!.accNetWad), 0n, staked);
    const claim = await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: a.address }, aTok);
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ claimable: owed.toString(), burnsUnits: '0' });
    // no redemption yet, then a redemption with nothing tendered: Stage 1 refuses before the wallet signs
    expect((await rig.post(`/series/${seriesId}/tail/build-claim`, { holder: a.address }, aTok)).json()).toMatchObject({ detail: { stage1: 'NotRedeemed' } });
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    const none = await rig.post(`/series/${seriesId}/tail/build-claim`, { holder: a.address }, aTok);
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ detail: { stage1: 'NoRedeemedUnits' } });
  });

  it('after a tender the tail claim pays the tail on tendered units and the pending payout, redeeming nothing', async () => {
    const staked = BigInt((await h.sim.getPosition(seriesId, a.address))!.stakedUnits);
    const half = staked / 2n;
    await h.tender(seriesId, a, half, 0n);
    // a tail report (a liquidity event) pays the tail on the units at redemption
    await h.sim.setTime(parsePeriod('2026Q2').end + 3_600);
    await h.reportAndPay(seriesId, '2026Q2', privateTerms, termsCommitment, 0n, USDC(90_000), { liquidityEvent: true });
    await rig.sync();
    const p = (await h.sim.getPosition(seriesId, a.address))!;
    expect(BigInt(p.tailClaimable) > 0n).toBe(true);
    const tail = await rig.post(`/series/${seriesId}/tail/build-claim`, { holder: a.address }, aTok);
    expect(tail.statusCode).toBe(200);
    expect(tail.json()).toMatchObject({ amount: p.tailClaimable, redeemsFirst: null, total: (BigInt(p.tailClaimable) + BigInt(p.claimable)).toString(), burnsUnits: '0' });
    const res = await h.exec(a, tail.json().tx.command);
    expect(res.events.map((e) => e.type)).toEqual(['TailClaimed']);
    expect(res.events[0]!.payload).toMatchObject({ amount: p.tailClaimable });
  });

  it('the final claim pays the pending payout and the share of the tendered units, burning nothing; a wallet-only tender holds the units', async () => {
    // b registers and tenders wallet units only: the tender creates its position (amendment M3)
    await h.registerHolder(seriesId, b);
    await h.tender(seriesId, b, 0n, 1_000_000n);
    await h.sim.submit(await h.extinguishment(seriesId), 'keeper'); // cause S4-EXT
    await rig.sync();
    const p = (await h.sim.getPosition(seriesId, a.address))!;
    expect(BigInt(p.finalClaimable) > 0n).toBe(true);
    const fin = await rig.post(`/series/${seriesId}/final/build-claim`, { holder: a.address }, aTok);
    expect(fin.statusCode).toBe(200);
    const amount = (BigInt(p.claimable) + BigInt(p.finalClaimable)).toString();
    expect(fin.json()).toMatchObject({ amount, redeemsFirst: null, total: amount, burnsUnits: '0' });
    const res = await h.exec(a, fin.json().tx.command);
    expect(res.events.map((e) => [e.type, (e.payload as { amount?: string }).amount])).toEqual([['FinalClaimed', amount]]);
    // b holds a position from its tender (holder access) and claims its share of its tendered unit
    const bFin = await rig.post(`/series/${seriesId}/final/build-claim`, { holder: b.address }, bTok);
    expect(bFin.statusCode).toBe(200);
    expect(bFin.json()).toMatchObject({ redeemsFirst: null, burnsUnits: '0' });
  });
});
