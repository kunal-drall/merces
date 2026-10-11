import { describe, expect, it } from 'vitest';
import { ChainError, orderCommitment, type UserCommand } from '@merces/domain';
import { parsePeriod, toPid } from '@merces/math';
import { SimHarness, serialiseState, type SimWallet } from '../src/index.ts';
import { GENESIS, USDC, types } from './helpers.ts';
import { seedHolder, seedPause, seriesOf } from './kit.ts';

/*
 * S4 cause codes on the pins that moved:
 *  - S4-BID: bid and order commitments are Stage 1's keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32) (S4 D11):
 *    the builders take no series, window or side, and the salt is 32 bytes.
 */

/**
 * Transfer windows with Stage 1's escrow semantics on our one-step clearing (S1 plan WP8; SPEC v1.1 §7; SIM:1485-1658).
 *
 * Cause codes on the pins that changed from the version-1 engine:
 *  - W: a redemption, a final claim or a Retired burn never burns the units held for a window ask (Stage 1 burns the
 *    balance, which excludes the ask escrow); a terminal series forces the window to NoMatch, which returns them;
 *  - S: an ask settles the holder first (SIM:1528) and clearing settles every asker (SIM:1606, 1634), so the stored
 *    `pending` carries what the held units earned (the claimable total does not change);
 *  - S2-PR: push delivery (`deliverBid`): the harness raise delivers every bid, so a winner's refund is already paid;
 *  - S3-TL: the tail is `claimTail`'s (was paid by `claimPayout` once the holder had redeemed units);
 *  - S3-BR: `burnRetired{holder}` replaces the S1 list burn crank (`holders[]`); a holder with nothing to burn gets `UnitsBurned(0)`;
 *  - S3-Z, S3-BU: a claim of nothing emits `PayoutClaimed` with zeros, its `burnedUnits` naming what it burns.
 * The payout figures follow from the harness terms: θ 60,000, 10% above it, a 5% payout fee, 500 units of which each
 * backer holds 100, cap 2.5 × 9 = 22.5 per unit.
 */

const DAY = 86_400;
const SALT = '0x' + 'cd'.repeat(32);
type Order = { side: 'buy' | 'sell'; price: bigint; quantity: bigint; deposit?: bigint };

async function settled(lockupSeconds: number) {
  const h = await SimHarness.create('solana', { genesis: GENESIS });
  await h.exec(h.admin, { kind: 'setFlags', windowsEnabled: true });
  const raise = await h.runRaise({ terms: { lockupSeconds, windowCommitDuration: 3600, windowRevealDuration: 3600 } });
  const settledAt = (await h.sim.getSeries(raise.seriesId))!.settledAt!;
  return { h, settledAt, ...raise };
}

/** A fresh allowlisted, funded wallet that is not a holder (so it has room under the wallet cap). */
async function newBuyer(h: SimHarness, label: string): Promise<string> {
  const buyer = h.sim.address(`wallet:${label}`);
  await h.sim.submit({ kind: 'setAllowlist', wallet: buyer, allowed: true }, 'allowlistManager');
  await h.sim.fund(buyer, 'USDC', USDC(10_000));
  return buyer;
}

/** Send `cmd` as `wallet`, a harness wallet or a bare address. */
async function sendAs(h: SimHarness, wallet: SimWallet | string, cmd: UserCommand) {
  if (typeof wallet !== 'string') return h.exec(wallet, cmd);
  const tx = await h.sim.build(cmd, wallet);
  return h.sim.send({ tx, signatures: { [wallet]: `sim:${wallet}` } });
}

const addressOf = (w: SimWallet | string) => (typeof w === 'string' ? w : w.address);

async function commit(h: SimHarness, seriesId: string, who: SimWallet | string, o: Order) {
  const wallet = addressOf(who);
  // cause S4-BID: Stage 1's keccak commitment, over no series or window
  const commitment = orderCommitment({ wallet, pricePerUnit: o.price, quantity: o.quantity, salt: SALT });
  const deposit = o.side === 'buy' ? (o.deposit ?? o.price * o.quantity * 101n / 100n) : 0n;
  return sendAs(h, who, { kind: 'commitWindowOrder', seriesId, windowId: 0, side: o.side, commitment, deposit: deposit.toString(), units: o.side === 'sell' ? o.quantity.toString() : '0' });
}

async function reveal(h: SimHarness, seriesId: string, who: SimWallet | string, o: Order) {
  return sendAs(h, who, { kind: 'revealWindowOrder', seriesId, windowId: 0, side: o.side, pricePerUnit: o.price.toString(), quantity: o.quantity.toString(), salt: SALT });
}

const balance = async (h: SimHarness, wallet: string) => BigInt(await h.sim.getBalance(wallet, 'USDC'));
const stored = (h: SimHarness, seriesId: string, wallet: string) => seriesOf(h.sim, seriesId).positions.get(wallet)!;

describe('transfer windows and allowlist', () => {
  it('moves units only through a window after lockup, respecting the wallet cap, and never strands a removed wallet', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    await h.exec(h.admin, { kind: 'setFlags', windowsEnabled: true });
    const { seriesId, terms, privateTerms } = await h.runRaise({ terms: { lockupSeconds: 10 } });
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 0n);
    const now = await h.sim.now();
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
    // cause S4-BID: Stage 1's keccak commitment, over no series or window
    const sc = orderCommitment({ wallet: seller.address, pricePerUnit: USDC(10), quantity: 50n, salt });
    await h.exec(seller, { kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'sell', commitment: sc, deposit: '0', units: '50' });
    // cause S4-BID: Stage 1's keccak commitment, over no series or window
    const bc = orderCommitment({ wallet: buyer.address, pricePerUnit: USDC(11), quantity: 50n, salt });
    await h.exec(buyer, { kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'buy', commitment: bc, deposit: USDC(550).toString(), units: '0' });
    // cause S4-BID: Stage 1's keccak commitment, over no series or window
    const bc2 = orderCommitment({ wallet: buyer2, pricePerUnit: USDC(10.5), quantity: 50n, salt });
    const tx = await h.sim.build({ kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'buy', commitment: bc2, deposit: USDC(530.25).toString(), units: '0' }, buyer2);
    await h.sim.send({ tx, signatures: { [buyer2]: `sim:${buyer2}` } });
    await h.sim.setTime((await h.sim.getTransferWindow(seriesId))!.commitEndsAt);
    await h.exec(seller, { kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'sell', pricePerUnit: USDC(10).toString(), quantity: '50', salt });
    await h.exec(buyer, { kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'buy', pricePerUnit: USDC(11).toString(), quantity: '50', salt });
    const rtx = await h.sim.build({ kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'buy', pricePerUnit: USDC(10.5).toString(), quantity: '50', salt }, buyer2);
    await h.sim.send({ tx: rtx, signatures: { [buyer2]: `sim:${buyer2}` } });
    await h.sim.setTime((await h.sim.getTransferWindow(seriesId))!.revealEndsAt);
    const cleared = await h.sim.submit({ kind: 'clearTransferWindow', seriesId, windowId: 0 }, 'keeper');
    const transfers = cleared.events.filter((e) => e.type === 'WindowOrderProcessed').map((e) => e.payload);
    expect(transfers).toContainEqual(expect.objectContaining({ owner: buyer2, side: 'buy', fill: '50', fee: USDC(5.25).toString() }));
    expect((await h.sim.getPosition(seriesId, buyer2))!.units).toBe('50');
    expect((await h.sim.getPosition(seriesId, seller.address))!.units).toBe('50');
    // cause S2-PR: the deposit 1111 less cost 900 and fee 9 came back at delivery (+ 202; was still claimable)
    expect(await h.sim.getBalance(seller.address, 'USDC')).toBe((1_000_000_000_000n - USDC(1111) + USDC(202) + USDC(525)).toString());
  });
});

describe('window escrow on Stage 1', () => {
  it('an ask settles the holder first; an unregistered wallet cannot ask', async () => {
    const { h, seriesId, terms, privateTerms } = await settled(30 * DAY);
    const [b1, b2] = [h.backers[1]!, h.backers[2]!];
    // 2026Q1: 100,000 YTD → 4,000 due; net 3,800 → 7.6 per unit, 760 per backer
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(100_000));
    const now = await h.sim.now();
    await h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: now + 100, revealEndsAt: now + 200 }, 'keeper');
    expect(stored(h, seriesId, b1.address).pending).toBe(0n); // settled lazily: nothing stored yet
    expect((await h.sim.getPosition(seriesId, b1.address))!.claimable).toBe(USDC(760).toString());

    await commit(h, seriesId, b1, { side: 'sell', price: USDC(10), quantity: 40n });
    // the ask stored the 760 (S; was 0) and moved the cursor; the claim itself is unchanged
    expect(stored(h, seriesId, b1.address)).toMatchObject({ pending: USDC(760), escrowed: 40n, units: 100n });
    expect(h.sim.stage1View(seriesId).holders[b1.address]!.pending).toBe(USDC(760).toString());
    expect((await h.sim.getPosition(seriesId, b1.address))!.claimable).toBe(USDC(760).toString());
    expect(stored(h, seriesId, b2.address).pending).toBe(0n);
    // the held units count in the window's escrow (the window view and the vector money view agree)
    expect(await h.sim.getTransferWindow(seriesId)).toMatchObject({ escrowUnits: '40', escrowStable: '0', orderCount: 1 });
    expect(h.sim.stage1View(seriesId).money).toMatchObject({ windowEscrowUnits: '40', windowEscrowStable: '0' });

    // a wallet with units but no holder registration is refused (Stage 1 settle_holder: HolderNotRegistered); nothing moves
    const stray = h.sim.address('wallet:unregistered');
    seedHolder(h.sim, seriesId, stray, { units: 10n });
    const before = serialiseState(h.sim.state);
    const e = await commit(h, seriesId, stray, { side: 'sell', price: USDC(10), quantity: 10n }).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ChainError);
    expect((e as ChainError).detail?.stage1).toBe('HolderNotRegistered');
    expect(serialiseState(h.sim.state)).toBe(before);
  });

  it('a payout during the window accrues on the ask escrow; clearing settles every asker and empties the escrow', async () => {
    const { h, seriesId, terms, privateTerms } = await settled(30 * DAY);
    const [b1, b2] = [h.backers[1]!, h.backers[2]!];
    const buyer = await newBuyer(h, 'window-buyer');
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(10_000)); // below θ: nothing due
    const open = await h.sim.now();
    const revealEndsAt = parsePeriod('2026Q2').end + 2 * DAY;
    await h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: open + 100, revealEndsAt }, 'keeper');
    // the book does not cross: the ask is above the bid
    const ask: Order = { side: 'sell', price: USDC(20), quantity: 50n };
    const bid: Order = { side: 'buy', price: USDC(10), quantity: 50n };
    await commit(h, seriesId, b1, ask);
    await commit(h, seriesId, buyer, bid);
    expect(await h.sim.getTransferWindow(seriesId)).toMatchObject({ escrowUnits: '50', escrowStable: USDC(505).toString(), cleared: false });
    await h.sim.setTime((await h.sim.getTransferWindow(seriesId))!.commitEndsAt);
    await reveal(h, seriesId, b1, ask);
    await reveal(h, seriesId, buyer, bid);
    // 2026Q2 pays while the 50 units are held (100,000 YTD → 4,000 due, net 7.6 per unit): they earn like the rest
    await h.sim.setTime(parsePeriod('2026Q2').end + DAY);
    await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(10_000), USDC(100_000));
    expect((await h.sim.getPosition(seriesId, b1.address))!.claimable).toBe(USDC(760).toString());

    await h.sim.setTime(revealEndsAt);
    const cleared = await h.sim.submit({ kind: 'clearTransferWindow', seriesId, windowId: 0 }, 'keeper');
    expect(types(cleared.events)).toContain('TransferWindowCleared');
    expect(cleared.events.find((e) => e.type === 'TransferWindowCleared')!.payload).toMatchObject({ clearingPrice: '0', unitsTransferred: '0' });
    // the asker was settled at clearing (S): its stored pending holds the 760 earned on all 100 units; a holder with no
    // ask is still settled lazily
    expect(stored(h, seriesId, b1.address)).toMatchObject({ pending: USDC(760), escrowed: 0n, units: 100n });
    expect(stored(h, seriesId, b2.address).pending).toBe(0n);
    expect(await balance(h, buyer)).toBe(USDC(10_000));
    expect(await h.sim.getTransferWindow(seriesId)).toMatchObject({ escrowUnits: '0', escrowStable: '0', cleared: true, clearingPrice: null });
    expect(h.sim.stage1View(seriesId).money).toMatchObject({ windowEscrowUnits: '0', windowEscrowStable: '0' });
    const b1Before = await balance(h, b1.address);
    await h.exec(b1, { kind: 'claimPayout', seriesId });
    expect((await balance(h, b1.address)) - b1Before).toBe(USDC(760));
  });

  it('opening a window during the lockup fails with Stage 1 LockupActive and changes nothing', async () => {
    const { h, seriesId, settledAt } = await settled(30 * DAY);
    const lockupEnd = settledAt + 30 * DAY;
    await h.sim.setTime(lockupEnd - 1);
    const before = serialiseState(h.sim.state);
    const e = await h.sim
      .submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: lockupEnd + 100, revealEndsAt: lockupEnd + 200 }, 'keeper')
      .then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ChainError);
    // the Stage 1 name (SIM:1494) on the same code as before, so the HTTP status is unchanged
    expect((e as ChainError).code).toBe('TooEarly');
    expect((e as ChainError).detail?.stage1).toBe('LockupActive');
    expect(serialiseState(h.sim.state)).toBe(before);
    expect(seriesOf(h.sim, seriesId).transferWindows).toHaveLength(0);
    // the lockup ends at settlement + lockupSeconds exactly (Stage 1 fails only while now < that)
    await h.sim.setTime(lockupEnd);
    seriesOf(h.sim, seriesId).ledger.lastPaidPeriod = toPid('2025Q4');
    const r = await h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: lockupEnd + 100, revealEndsAt: lockupEnd + 200 }, 'keeper');
    expect(types(r.events)).toContain('TransferWindowOpened');
  });

  it('opening a window is a status sync point', async () => {
    const { h, seriesId, terms, privateTerms } = await settled(30 * DAY);
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(100_000));
    // a hardship pause, stored by a crank, that has since ended: derived OnTime, stored still Paused
    const t = await h.sim.now();
    seedPause(h.sim, seriesId, t, t + 9 * DAY);
    await h.sim.setTime(t + DAY);
    await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(seriesOf(h.sim, seriesId).status).toBe('Paused');
    const now = t + 10 * DAY;
    await h.sim.setTime(now);
    const r = await h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: now + 100, revealEndsAt: now + 200 }, 'keeper');
    expect(types(r.events)).toEqual(['StatusChanged', 'TransferWindowOpened']);
    expect(r.events[0]!.payload).toMatchObject({ from: 'Paused', to: 'OnTime' });
    expect(seriesOf(h.sim, seriesId).status).toBe('OnTime');
  });
});

describe('transfer windows on a series that ended during the window', () => {
  it('a redemption during an open window leaves the escrowed units; NoMatch returns them and they are redeemed with the tail catch-up', async () => {
    const { h, seriesId, terms, privateTerms } = await settled(30 * DAY);
    const [b0, seller] = [h.backers[0]!, h.backers[1]!];
    const buyer = await newBuyer(h, 'window-buyer');
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(10_000)); // below θ: nothing due
    const open = await h.sim.now();
    const revealEndsAt = parsePeriod('2026Q2').end + 2 * DAY;
    await h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: open + 100, revealEndsAt }, 'keeper');
    // the book crosses: a live series would trade 50 units at 10.5
    const ask: Order = { side: 'sell', price: USDC(10), quantity: 50n };
    const bid: Order = { side: 'buy', price: USDC(10.5), quantity: 50n };
    await commit(h, seriesId, seller, ask);
    await commit(h, seriesId, buyer, bid);
    await h.sim.setTime((await h.sim.getTransferWindow(seriesId))!.commitEndsAt);
    await reveal(h, seriesId, seller, ask);
    await reveal(h, seriesId, buyer, bid);

    // the issuer redeems (hurdle-bound: 9.173589 per unit, tail cap 13.326411); the seller's claim redeems only its 50
    // units not held for the ask (W: Stage 1 redeems the balance, SIM:1375-1393)
    await h.sim.setTime(parsePeriod('2026Q1').end + 2 * DAY);
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(10).toString() });
    const price = BigInt((await h.sim.getRedemption(seriesId))!.pricePerUnit);
    expect(price).toBe(9_173_589n);
    const s0 = await balance(h, seller.address);
    await h.exec(seller, { kind: 'claimRedemption', seriesId });
    expect((await balance(h, seller.address)) - s0).toBe(price * 50n);
    expect(stored(h, seriesId, seller.address)).toMatchObject({ units: 50n, escrowed: 50n, redeemedUnits: 50n });
    expect((await h.sim.getSeries(seriesId))!.unitsOutstanding).toBe('450');

    // 2026Q2 liquidity event: the tail takes 6,663.2055, net 12.66009045 per unit; the seller claims it on its 50
    // redeemed units, which moves its tail cursor
    await h.sim.setTime(parsePeriod('2026Q2').end + DAY);
    await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(10_000), USDC(2_000_000), { liquidityEvent: true });
    expect((await h.sim.getPosition(seriesId, seller.address))!.tailClaimable).toBe('633004522');
    const s1 = await balance(h, seller.address);
    const tail = await h.exec(seller, { kind: 'claimTail', seriesId }); // cause S3-TL (was claimPayout)
    expect(tail.events.map((e) => [e.type, e.payload])).toEqual([['TailClaimed', { seriesId, holder: seller.address, amount: '633004522' }]]);
    expect((await balance(h, seller.address)) - s1).toBe(633_004_522n);

    // the stored status is terminal: clearing is forced to NoMatch whatever the book (W; SIM:1575-1581)
    await h.sim.setTime(revealEndsAt);
    const sellerBalance = await balance(h, seller.address);
    const cleared = await h.sim.submit({ kind: 'clearTransferWindow', seriesId, windowId: 0 }, 'keeper');
    expect(types(cleared.events)).toContain('TransferWindowCleared');
    expect(cleared.events.find((e) => e.type === 'TransferWindowCleared')!.payload).toMatchObject({ unitsTransferred: '0', clearingPrice: '0' });
    // the escrow comes back to the seller (the units never left its position); the buyer gets its whole deposit back
    expect(stored(h, seriesId, seller.address)).toMatchObject({ units: 50n, escrowed: 0n, redeemedUnits: 50n });
    expect((await h.sim.getPosition(seriesId, buyer))?.units ?? '0').toBe('0');
    expect(await balance(h, seller.address)).toBe(sellerBalance);
    expect(await balance(h, buyer)).toBe(USDC(10_000));
    expect(await h.sim.getTransferWindow(seriesId)).toMatchObject({ escrowUnits: '0', escrowStable: '0', cleared: true });

    // the returned 50 are redeemed at the same price, with the tail catch-up floor(cursor × 50 / WAD) = 633,004,522
    // (Stage 1 S6, SIM:1382-1385); the cursor is not reset, so nothing more is claimable after it
    const c = await h.exec(seller, { kind: 'claimRedemption', seriesId });
    expect(types(c.events)).toEqual(['PayoutClaimed', 'UnitsBurned', 'RedemptionClaimed']);
    expect(c.events[0]!.payload).toMatchObject({ amount: '633004522' });
    expect((await balance(h, seller.address)) - sellerBalance).toBe(price * 50n + 633_004_522n);
    expect((await h.sim.getPosition(seriesId, seller.address))!).toMatchObject({ units: '0', redeemedUnits: '100', tailClaimable: '0' });
    // a holder that redeems its 100 at once is owed 1,266,009,045 of tail: the two batches lost one base unit to the floors
    await h.exec(b0, { kind: 'claimRedemption', seriesId });
    expect((await h.sim.getPosition(seriesId, b0.address))!.tailClaimable).toBe('1266009045');
  });

  it('a Retired series keeps the ask escrow out of its burns; NoMatch settles the askers, returns the units, and they burn after', async () => {
    const { h, seriesId, terms, privateTerms } = await settled(30 * DAY);
    const [b1, b2, b3] = [h.backers[1]!, h.backers[2]!, h.backers[3]!];
    const buyer = await newBuyer(h, 'window-buyer');
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(10_000)); // below θ: nothing due
    const open = await h.sim.now();
    const revealEndsAt = parsePeriod('2026Q2').end + 2 * DAY;
    await h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: open + 100, revealEndsAt }, 'keeper');
    const askB1: Order = { side: 'sell', price: USDC(10), quantity: 40n };
    const askB2: Order = { side: 'sell', price: USDC(10), quantity: 30n };
    const bid: Order = { side: 'buy', price: USDC(11), quantity: 70n };
    await commit(h, seriesId, b1, askB1);
    await commit(h, seriesId, b2, askB2);
    await commit(h, seriesId, buyer, bid);
    await h.sim.setTime((await h.sim.getTransferWindow(seriesId))!.commitEndsAt);
    await reveal(h, seriesId, b1, askB1);
    await reveal(h, seriesId, b2, askB2);
    await reveal(h, seriesId, buyer, bid);

    // 2026Q2: 200,000 YTD → 14,000 due; the cap (22.5 × 500 = 11,250) takes 11,250 and retires the series; net
    // 10,687.5 → 21.375 per unit, 2,137.5 per backer
    await h.sim.setTime(parsePeriod('2026Q2').end + DAY);
    await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(10_000), USDC(200_000));
    expect(seriesOf(h.sim, seriesId).status).toBe('Retired');

    // b1 claims: paid on all 100 units, but only its 60 free units burn (W; was 100)
    const b1Before = await balance(h, b1.address);
    const claim = await h.exec(b1, { kind: 'claimPayout', seriesId });
    expect(types(claim.events)).toEqual(['PayoutClaimed', 'UnitsBurned']);
    expect(claim.events[0]!.payload).toMatchObject({ amount: USDC(2_137.5).toString(), burnedUnits: '60' }); // cause S3-BU
    expect(claim.events[1]!.payload).toMatchObject({ units: '60', reason: 'cap' });
    expect((await balance(h, b1.address)) - b1Before).toBe(USDC(2_137.5));
    expect(stored(h, seriesId, b1.address)).toMatchObject({ units: 40n, escrowed: 40n });
    // cause S3-BR: burnRetired per holder: b1 has no free units (a burn of 0), b3 burns its 100
    const crank = [...(await h.sim.submit({ kind: 'burnRetired', seriesId, holder: b1.address }, 'keeper')).events, ...(await h.sim.submit({ kind: 'burnRetired', seriesId, holder: b3.address }, 'keeper')).events];
    expect(crank.map((e) => e.payload)).toEqual([{ seriesId, holder: b1.address, units: '0', reason: 'cap' }, { seriesId, holder: b3.address, units: '100', reason: 'cap' }]);
    expect((await h.sim.getSeries(seriesId))!.unitsOutstanding).toBe('340');
    expect(stored(h, seriesId, b2.address).pending).toBe(0n); // not settled yet

    // forced NoMatch on the Retired series, although the book crosses
    await h.sim.setTime(revealEndsAt);
    const cleared = await h.sim.submit({ kind: 'clearTransferWindow', seriesId, windowId: 0 }, 'keeper');
    expect(types(cleared.events)).toContain('TransferWindowCleared');
    expect(cleared.events.find((e) => e.type === 'TransferWindowCleared')!.payload).toMatchObject({ unitsTransferred: '0', clearingPrice: '0' });
    // askers settled first (S): b2's stored pending is its 2,137.5; b1 had claimed already
    expect(stored(h, seriesId, b2.address)).toMatchObject({ pending: USDC(2_137.5), units: 100n, escrowed: 0n });
    expect(stored(h, seriesId, b1.address)).toMatchObject({ pending: 0n, units: 40n, escrowed: 0n });
    expect(await balance(h, buyer)).toBe(USDC(10_000));

    // the returned units burn now: b1's 40 with nothing to pay, b2's 100 with its payout
    const again = await h.exec(b1, { kind: 'claimPayout', seriesId });
    // cause S3-Z: the claim of nothing emits its event with 0 and the units it burns (was: the burn alone)
    expect(types(again.events)).toEqual(['PayoutClaimed', 'UnitsBurned']);
    expect(again.events[0]!.payload).toMatchObject({ amount: '0', burnedUnits: '40' });
    expect(again.events[1]!.payload).toMatchObject({ units: '40' });
    await h.sim.submit({ kind: 'burnRetired', seriesId, holder: b2.address }, 'keeper'); // cause S3-BR
    const b2Before = await balance(h, b2.address);
    await h.exec(b2, { kind: 'claimPayout', seriesId });
    expect((await balance(h, b2.address)) - b2Before).toBe(USDC(2_137.5));
    expect((await h.sim.getSeries(seriesId))!.unitsOutstanding).toBe('200');
  });
});

// Both programs implement C-S4: economic ownership changes at clearing, although processing and delivery are later.
describe.each(['solana', 'monad'] as const)('paged window ownership on %s', (personality) => {
  it('rejects and retallies a bad proposal, attributes intervening payouts once, and delivers an older window with flags off', async () => {
    const h = await SimHarness.create(personality, { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise({ terms: { lockupSeconds: 10, windowCommitDuration: 3600, windowRevealDuration: 3600 } });
    const seller = h.backers[1]!, buyer = await newBuyer(h, 'delayed-window');
    const base = { seriesId, windowId: 0 };
    await expect(h.sim.submit({ kind: 'openWindow', seriesId, periodId: '2026Q1' }, 'keeper')).rejects.toMatchObject({ detail: { stage1: 'WindowsDisabled' } });
    await h.exec(h.admin, { kind: 'setFlags', windowsEnabled: true });
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await expect(h.sim.submit({ kind: 'openWindow', seriesId, periodId: '2026Q1' }, 'keeper')).rejects.toMatchObject({ detail: { stage1: 'WindowNotEligible' } });
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(100_000));
    await h.sim.submit({ kind: 'openWindow', seriesId, periodId: '2026Q1' }, 'keeper');
    const ask: Order = { side: 'sell', price: USDC(10), quantity: 40n };
    const bid: Order = { side: 'buy', price: USDC(10), quantity: 25n };
    await commit(h, seriesId, seller, ask);
    await commit(h, seriesId, buyer, bid);
    await h.sim.setTime((await h.sim.getTransferWindow(seriesId))!.commitEndsAt);
    await reveal(h, seriesId, seller, ask);
    await reveal(h, seriesId, buyer, bid);
    await h.sim.setTime((await h.sim.getTransferWindow(seriesId))!.revealEndsAt);
    // A crossed book cannot clear as NoMatch; reject the proposal, then start a fresh tally round.
    await h.sim.submit({ kind: 'beginWindowSettlement', ...base, clearingPrice: null }, 'keeper');
    await expect(h.sim.submit({ kind: 'finalizeWindow', ...base }, 'keeper')).rejects.toMatchObject({ detail: { stage1: 'TallyIncomplete' } });
    await h.sim.submit({ kind: 'tallyWindow', ...base, maxOrders: 1 }, 'keeper');
    expect((await h.sim.getTransferWindow(seriesId))!.talliedCount).toBe(1);
    await h.sim.submit({ kind: 'tallyWindow', ...base, maxOrders: 1 }, 'keeper');
    expect(types((await h.sim.submit({ kind: 'finalizeWindow', ...base }, 'keeper')).events)).toEqual(['WindowSettlementRejected']);
    await h.sim.submit({ kind: 'beginWindowSettlement', ...base, clearingPrice: USDC(10).toString() }, 'keeper');
    await h.sim.submit({ kind: 'tallyWindow', ...base, maxOrders: 2 }, 'keeper');
    await h.sim.submit({ kind: 'finalizeWindow', ...base }, 'keeper');
    await expect(h.sim.submit({ kind: 'processOrder', ...base, owner: seller.address }, 'keeper')).rejects.toMatchObject({ detail: { stage1: 'BidsNotProcessed' } });
    // 950 net arrives after clearing. The 40 escrowed units stop earning for the seller until its unsold 15 return.
    await h.sim.setTime(parsePeriod('2026Q2').end + DAY);
    await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(100_000), USDC(110_000));
    expect((await h.sim.getPosition(seriesId, seller.address))!.claimable).toBe(USDC(874).toString());
    await h.exec(seller, { kind: 'claimPayout', seriesId });
    await h.exec(h.admin, { kind: 'setFlags', windowsEnabled: false });
    await h.sim.submit({ kind: 'processOrder', ...base, owner: buyer }, 'keeper');
    await h.sim.submit({ kind: 'processOrder', ...base, owner: seller.address }, 'keeper');
    expect((await h.sim.getPosition(seriesId, buyer))!.claimable).toBe(USDC(47.5).toString());
    expect((await h.sim.getPosition(seriesId, seller.address))!.claimable).toBe(USDC(28.5).toString());
    expect(await h.sim.getTransferWindow(seriesId)).toMatchObject({ state: 'Done', escrowUnits: '40', escrowStable: USDC(250).toString() });
    await h.exec(h.admin, { kind: 'setFlags', windowsEnabled: true });
    await h.sim.submit({ kind: 'openWindow', seriesId, periodId: '2026Q2' }, 'keeper');
    await h.exec(h.admin, { kind: 'setFlags', windowsEnabled: false });
    await h.sim.submit({ kind: 'setAllowlist', wallet: buyer, allowed: false }, 'allowlistManager');
    // A second 950 net arrives while the units still await delivery in the previous window.
    await h.sim.setTime(parsePeriod('2026Q3').end + DAY);
    await h.reportAndPay(seriesId, '2026Q3', privateTerms, terms.termsCommitment, USDC(110_000), USDC(120_000));
    expect((await h.sim.getPosition(seriesId, buyer))!.claimable).toBe(USDC(95).toString());
    expect((await h.sim.getPosition(seriesId, seller.address))!.claimable).toBe(USDC(171).toString());
    const before = await balance(h, seller.address);
    await h.sim.submit({ kind: 'deliverOrder', ...base, owner: buyer }, 'keeper');
    await h.sim.submit({ kind: 'deliverOrder', ...base, owner: seller.address }, 'keeper');
    expect((await balance(h, seller.address)) - before).toBe(USDC(250));
    expect(await h.sim.getTransferWindow(seriesId, 0)).toMatchObject({ escrowUnits: '0', escrowStable: '0' });
    expect((await h.sim.getPosition(seriesId, buyer))!.claimable).toBe(USDC(95).toString());
    expect((await h.sim.getPosition(seriesId, seller.address))!.claimable).toBe(USDC(171).toString());
    await expect(h.sim.submit({ kind: 'deliverOrder', ...base, owner: buyer }, 'keeper')).rejects.toMatchObject({ detail: { stage1: 'AlreadyDelivered' } });
  });
});
