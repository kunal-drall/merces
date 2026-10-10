import { describe, expect, it } from 'vitest';
import { orderCommitment } from '@merces/domain';
import { SimHarness } from '../src/index.ts';
import { GENESIS, USDC, types } from './helpers.ts';

describe('transfer windows and allowlist', () => {
  it('moves units only through a window after lockup, respecting the wallet cap, and never strands a removed wallet', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await h.runRaise({ terms: { lockupSeconds: 10 } });
    const now = (await h.sim.now()) + 11;
    await h.sim.setTime(now);
    // remove backer 1 from the allowlist: it may still sell and claim
    await h.sim.submit({ kind: 'setAllowlist', wallet: h.backers[1]!.address, allowed: false }, 'allowlistManager');
    await h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: now + 100, revealEndsAt: now + 200 }, 'keeper');
    const seller = h.backers[1]!;
    const buyer = h.backers[0]!; // already holds 100 = cap; can buy nothing
    const buyer2 = h.sim.address('wallet:newbacker');
    await h.sim.submit({ kind: 'setAllowlist', wallet: buyer2, allowed: true }, 'allowlistManager');
    await h.sim.fund(buyer2, 'USDC', USDC(10_000));
    const salt = '0x' + 'cc'.repeat(32);
    const sc = orderCommitment({ seriesId, windowId: 0, wallet: seller.address, side: 'sell', pricePerUnit: USDC(10), quantity: 50n, salt });
    await h.exec(seller, { kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'sell', commitment: sc, deposit: '0', units: '50' });
    const bc = orderCommitment({ seriesId, windowId: 0, wallet: buyer.address, side: 'buy', pricePerUnit: USDC(11), quantity: 50n, salt });
    await h.exec(buyer, { kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'buy', commitment: bc, deposit: USDC(550).toString(), units: '0' });
    const bc2 = orderCommitment({ seriesId, windowId: 0, wallet: buyer2, side: 'buy', pricePerUnit: USDC(10.5), quantity: 50n, salt });
    const tx = await h.sim.build({ kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'buy', commitment: bc2, deposit: USDC(525).toString(), units: '0' }, buyer2);
    await h.sim.send({ tx, signatures: { [buyer2]: `sim:${buyer2}` } });
    await h.sim.setTime(now + 100);
    await h.exec(seller, { kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'sell', pricePerUnit: USDC(10).toString(), quantity: '50', salt });
    await h.exec(buyer, { kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'buy', pricePerUnit: USDC(11).toString(), quantity: '50', salt });
    const rtx = await h.sim.build({ kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'buy', pricePerUnit: USDC(10.5).toString(), quantity: '50', salt }, buyer2);
    await h.sim.send({ tx: rtx, signatures: { [buyer2]: `sim:${buyer2}` } });
    await h.sim.setTime(now + 200);
    const cleared = await h.sim.submit({ kind: 'clearTransferWindow', seriesId, windowId: 0 }, 'keeper');
    const transfers = cleared.events.filter((e) => e.type === 'UnitsTransferred').map((e) => e.payload as { to: string; units: string });
    expect(transfers).toEqual([{ seriesId, from: seller.address, to: buyer2, units: '50', windowId: 0 }]);
    expect((await h.sim.getPosition(seriesId, buyer2))!.units).toBe('50');
    expect((await h.sim.getPosition(seriesId, seller.address))!.units).toBe('50');
    expect(await h.sim.getBalance(seller.address, 'USDC')).toBe((1_000_000_000_000n - USDC(1111) + USDC(525)).toString()); // deposit 1111 still partly refundable
  });
});

describe('transfer windows on a series that ended during the window', () => {
  it('a redemption during an open window leaves the escrowed units; clearing matches nothing, returns them, and they are redeemed after', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await h.runRaise({ terms: { lockupSeconds: 10 } });
    const now = (await h.sim.now()) + 11;
    await h.sim.setTime(now);
    await h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: now + 100, revealEndsAt: now + 200 }, 'keeper');
    const seller = h.backers[1]!;
    const buyer = h.sim.address('wallet:window-buyer');
    await h.sim.submit({ kind: 'setAllowlist', wallet: buyer, allowed: true }, 'allowlistManager');
    await h.sim.fund(buyer, 'USDC', USDC(10_000));
    const salt = '0x' + 'cd'.repeat(32);
    const sc = orderCommitment({ seriesId, windowId: 0, wallet: seller.address, side: 'sell', pricePerUnit: USDC(10), quantity: 50n, salt });
    await h.exec(seller, { kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'sell', commitment: sc, deposit: '0', units: '50' });
    const bc = orderCommitment({ seriesId, windowId: 0, wallet: buyer, side: 'buy', pricePerUnit: USDC(10.5), quantity: 50n, salt });
    await h.sim.send({ tx: await h.sim.build({ kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'buy', commitment: bc, deposit: USDC(525).toString(), units: '0' }, buyer), signatures: { [buyer]: `sim:${buyer}` } });
    await h.sim.setTime(now + 100);
    await h.exec(seller, { kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'sell', pricePerUnit: USDC(10).toString(), quantity: '50', salt });
    await h.sim.send({ tx: await h.sim.build({ kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'buy', pricePerUnit: USDC(10.5).toString(), quantity: '50', salt }, buyer), signatures: { [buyer]: `sim:${buyer}` } });
    // the issuer redeems; the seller's claim redeems only its 50 units not held for the ask (Stage 1 redeems the
    // balance, SIM:1375-1393; cause RD: the escrowed units were burned before WP6)
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1000).toString() });
    await h.exec(seller, { kind: 'claimRedemption', seriesId });
    expect((await h.sim.getPosition(seriesId, seller.address))!).toMatchObject({ units: '50', redeemedUnits: '50' });
    const sellerBalance = await h.sim.getBalance(seller.address, 'USDC');
    await h.sim.setTime(now + 200);
    const cleared = await h.sim.submit({ kind: 'clearTransferWindow', seriesId, windowId: 0 }, 'keeper');
    expect(types(cleared.events)).toEqual(['TransferWindowCleared']);
    expect(cleared.events[0]!.payload).toMatchObject({ unitsTransferred: '0', clearingPrice: '0' });
    // the escrow comes back to the seller (the units never left its position)
    expect((await h.sim.getPosition(seriesId, seller.address))!.units).toBe('50');
    expect((await h.sim.getPosition(seriesId, buyer))?.units ?? '0').toBe('0');
    expect(await h.sim.getBalance(seller.address, 'USDC')).toBe(sellerBalance);
    expect(await h.sim.getBalance(buyer, 'USDC')).toBe(USDC(10_000).toString());
    expect(h.sim.state.series.get(seriesId)!.positions.get(seller.address)!.escrowed).toBe(0n);
    // and are redeemed at the same price once claimed
    const price = BigInt((await h.sim.getRedemption(seriesId))!.pricePerUnit);
    await h.exec(seller, { kind: 'claimRedemption', seriesId });
    expect((await h.sim.getPosition(seriesId, seller.address))!).toMatchObject({ units: '0', redeemedUnits: '100' });
    expect(BigInt(await h.sim.getBalance(seller.address, 'USDC'))).toBe(BigInt(sellerBalance) + price * 50n);
  });
});
