import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { orderCommitment } from '@merces/domain';
import { WAD, ZERO_INCOME_COMMITMENT, toPid, type LedgerExpect } from '@merces/math';
import { SimHarness, SimStateVersionError, balanceUnits, defaultTerms, deserialiseState, pendingRefundOf, serialiseState } from '../src/index.ts';
import { ZERO_INCOME_COMMITMENT_HEX, derivedStatus, ledgerClock } from '../src/engine/ledger.ts';
import { GENESIS, USDC } from './helpers.ts';
import { seedFinal, seedHolder, seedLedger, seedPause, seedTail, seedVault, seriesOf } from './kit.ts';

const VECTOR_01 = new URL('../../../stage1/packages/vectors/01_happy_path.json', import.meta.url);

/*
 * S2 cause codes:
 *  - S2-V3: simulator state version 3 (S2: the raise's own terms, Stage 1's multi-step settlement); versions 1 and 2
 *    are refused, never upgraded;
 *  - S2-MS: multi-step settlement: the engine owns every auction and holder field of Stage 1's view (the runner's
 *    bookkeeping is no longer needed); the raise settles, then processes, then delivers;
 *  - S2-PR: push delivery (`deliverBid`): refunds wait in the auction escrow until delivered (the pull refund is retired).
 *
 * S3 cause codes:
 *  - S3-V4: simulator state version 4 (S3: the unit scale, the stake and tender totals, the census time and each
 *    holder's stake); versions 1 to 3 are refused, never upgraded.
 *  - S3-UL: a curve series keeps base lamports (unit scale 10^6) from its creation.
 *  - S3-CV: a curve's completion settles at the pool's finish time and registers nobody (Stage 1 complete_curve).
 */
describe('simulator state version 4', () => {
  it('round-trips the Stage 1 vault, tail and final states and bigint pauses through serialisation and structuredClone', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    const now = await h.sim.now();
    seedVault(h.sim, seriesId, {
      paidPerUnitWad: 3n * WAD, netAccWad: 2n * WAD + 7n, carryWad: 123n, grossReceived: USDC(1500), feeCollected: USDC(75), refundedToIssuer: USDC(1), retired: false,
      yearGross: [{ year: 0, grossWad: 5n * WAD }, { year: 1, grossWad: 1n }, { year: null, grossWad: 0n }, { year: null, grossWad: 0n }], balance: USDC(1425),
    });
    seedTail(h.sim, seriesId, { tailCapPerUnit: USDC(8.78), tailPaidPerUnitWad: WAD, tailAccWad: WAD / 2n, tailExhausted: true, tailRefunded: USDC(3) });
    seedFinal(h.sim, seriesId, { finalAccWad: 9n * WAD, finalUnits: 500n, unreleasedDistributed: USDC(2250) });
    seedPause(h.sim, seriesId, now, now + 86_400);
    seedLedger(h.sim, seriesId, { lastAcceptedPeriod: toPid('2026Q1'), openDuePeriod: toPid('2026Q1'), openDueAmount: USDC(10), pauseRequestedUntil: BigInt(now + 2 * 86_400), pauseNonce: 1n });
    seedHolder(h.sim, seriesId, h.backers[0]!.address, { pending: 42n, lastTailAccWad: 5n, finalClaimed: true, stakedUnits: 7n });
    // cause S3-V4: the version-4 series fields round-trip too
    Object.assign(seriesOf(h.sim, seriesId), { unitScale: 1_000_000n, stakedTotal: 7n, tenderedTotal: 3n, unitsSyncedAt: now });

    const json = serialiseState(h.sim.state);
    const back = deserialiseState(json);
    expect(back).toEqual(h.sim.state);
    expect(serialiseState(back)).toBe(json);
    const s = back.series.get(seriesId)!;
    expect(s.ledger.pauses).toEqual([{ start: BigInt(now), end: BigInt(now + 86_400) }]);
    expect(typeof s.ledger.pauses[0]!.start).toBe('bigint');
    expect(s.ledger.pausedTotal).toBe(86_400n);
    expect(s.vault.yearGross[0]).toEqual({ year: 0, grossWad: 5n * WAD });
    expect(s.tail.tailExhausted).toBe(true);
    expect(s.final.finalUnits).toBe(500n);
    expect([s.unitScale, s.stakedTotal, s.tenderedTotal, s.unitsSyncedAt, s.positions.get(h.backers[0]!.address)!.stakedUnits]).toEqual([1_000_000n, 7n, 3n, now, 7n]);
    expect(back.version).toBe(4); // cause S3-V4 (was 3)
    expect(structuredClone(h.sim.state)).toEqual(h.sim.state);
  });

  it('refuses a version-1, version-2 or version-3 state instead of upgrading it', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const v4 = JSON.parse(serialiseState(h.sim.state)) as Record<string, unknown>;
    const { version: _v, ...v1 } = v4;
    expect(() => deserialiseState(JSON.stringify(v1))).toThrow(SimStateVersionError);
    expect(() => deserialiseState(JSON.stringify({ ...v4, version: 1 }))).toThrow(/version 1 is not supported.*sim:reset/);
    // cause S2-V3: a version-2 state (S1) is refused too
    expect(() => deserialiseState(JSON.stringify({ ...v4, version: 2 }))).toThrow(/version 2 is not supported \(this build needs version 4\).*sim:reset/); // cause S3-V4 (was version 3)
    // cause S3-V4: a version-3 state (S2) is refused too
    expect(() => deserialiseState(JSON.stringify({ ...v4, version: 3 }))).toThrow(/version 3 is not supported \(this build needs version 4\).*sim:reset/);
    expect(() => deserialiseState(JSON.stringify(v4))).not.toThrow();
  });

  it('a new series has its scale (1, or 10^6 on a curve), no stake, no tender and no census; a new holder has no stake (S3-V4)', async () => {
    for (const raiseStyle of ['sealed', 'curve'] as const) {
      const h = await SimHarness.create('solana', { genesis: GENESIS });
      await h.exec(h.issuer, { kind: 'registerIssuer' });
      const overrides = raiseStyle === 'curve' ? { raiseStyle, minimumRaise: USDC(2000).toString(), reservePrice: USDC(5).toString(), unitsOffered: '1000' } : {};
      const created = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, overrides).terms });
      const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
      const s = seriesOf(h.sim, seriesId);
      // cause S3-UL: a curve series keeps base lamports (10^6; was 1 until WP8)
      const scale = raiseStyle === 'curve' ? 1_000_000n : 1n;
      expect([s.unitScale, s.stakedTotal, s.tenderedTotal, s.unitsSyncedAt], raiseStyle).toEqual([scale, 0n, 0n, null]);
      expect((await h.sim.getSeries(seriesId))!.unitScale).toBe(scale.toString());
      expect(seedHolder(h.sim, seriesId, h.backers[0]!.address).stakedUnits).toBe(0n);
    }
  });

  it("a fresh Draft series' Stage 1 ledger view equals vector 01 step 11", async () => {
    const vector = JSON.parse(readFileSync(VECTOR_01, 'utf8')) as { steps: { op: string; ledger?: LedgerExpect; auction?: Record<string, unknown>; treasury?: string; vault?: string; auctionEscrow?: string; holders?: object }[] };
    const step = vector.steps[11]!;
    expect(step.op).toBe('expect');
    const create = vector.steps[10] as unknown as { termsCommitment: string; terms: { capMultipleWad: string } };
    for (const personality of ['solana', 'monad'] as const) {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      await h.exec(h.issuer, { kind: 'registerIssuer' });
      const { terms } = defaultTerms(h.sim, { termsCommitment: create.termsCommitment, capMultipleWad: create.terms.capMultipleWad });
      const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
      const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
      const view = h.sim.stage1View(seriesId);
      // same values and the same key order (Stage 1 compares the whole object)
      expect(JSON.stringify(view.ledger)).toBe(JSON.stringify(step.ledger));
      expect(view.money).toEqual({ treasury: step.treasury, vault: step.vault, auctionEscrow: step.auctionEscrow });
      expect(JSON.stringify(view.auction)).toBe(JSON.stringify(step.auction)); // cause S2-MS: the whole auction view (was the engine's fields)
      expect(view.holders).toEqual(step.holders);
    }
  });

  it('a new ledger starts from Stage 1 initial values; the prior income chain starts at Poseidon(0, 0)', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    const s = seriesOf(h.sim, seriesId);
    expect(ZERO_INCOME_COMMITMENT_HEX).toBe('0x' + ZERO_INCOME_COMMITMENT.toString(16).padStart(64, '0'));
    expect(ZERO_INCOME_COMMITMENT_HEX).toMatch(/^0x2098f5fb.*b64864$/);
    expect(s.ledger).toMatchObject({ firstPeriod: null, lastAcceptedPeriod: null, openDueAmount: 0n, lastIncomeCommitment: ZERO_INCOME_COMMITMENT_HEX, pauses: [], pauseRequestedUntil: null, formalNoticeEmittedFor: null, amendmentNonce: 0n, extinguishNonce: 0n });
    expect(s.treasuryReturned).toBe(0n);
    const series = (await h.sim.getSeries(seriesId))!;
    expect(series.reporting).toEqual({ firstPeriod: null, nextExpectedPeriod: null, lastAcceptedPeriod: null, lastPaidPeriod: null, openDuePeriod: null, openDueAmount: '0', lastIncomePeriod: null, lastIncomeCommitment: ZERO_INCOME_COMMITMENT_HEX });
    expect(series.pauses).toEqual({ count: 0, pausedTotalSeconds: 0, nonce: 0, requested: false, requestedUntil: null, current: null });
    expect(series.final).toEqual({ accWad: '0', units: '0', distributed: '0' });
    expect(series.yearGross).toHaveLength(4);
  });
});

describe('Stage 1 registration, first period and money views', () => {
  // cause S2-MS, S2-PR: the raise settles, processes every bid, then delivers (was one settlement and pull refunds)
  it('finalize sets the first period; processing registers every winner; the auction escrow holds the refunds until delivered', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await h.runRaise({ settle: 'finalize', bids: [{ backer: 0, price: 12_000_000n, qty: 100n }, { backer: 1, price: 11_000_000n, qty: 100n }, { backer: 2, price: 10_000_000n, qty: 100n }, { backer: 3, price: 10_000_000n, qty: 100n }, { backer: 4, price: 9_000_000n, qty: 100n }] });
    const s = seriesOf(h.sim, seriesId);
    expect(s.ledger.firstPeriod).toBe(toPid('2026Q1')); // set at finalize (SIM:972)
    expect(h.sim.stage1View(seriesId).ledger).toMatchObject({ raiseState: 'Settled', mintFinalized: false, unitsOutstanding: '0', unitsSold: '500' });
    expect(Object.keys(h.sim.stage1View(seriesId).holders)).toEqual([]);
    await h.settle(seriesId, 'process');
    for (const b of h.backers) expect(s.positions.get(b.address)).toMatchObject({ registered: true, lastNetAccWad: 0n, lastTailAccWad: 0n, lastFinalAccWad: 0n, finalClaimed: false });
    const view = h.sim.stage1View(seriesId);
    expect(view.ledger.raiseState).toBe('Settled');
    expect(view.ledger.mintFinalized).toBe(true);
    expect(view.auction.mintFinalized).toBe(true);
    expect(view.ledger.capPerUnit).toBe(USDC(22.5).toString());
    expect(Object.keys(view.holders)).toEqual(h.backers.map((b) => b.address).sort());
    // refunds 303 + 202 + 101 + 101 + 0 wait in the escrow, with every winner's 100 units
    const pending = [...s.bids.values()].reduce((a, b) => a + b.pendingRefund, 0n);
    expect(pending).toBe(USDC(707));
    expect(view.money).toEqual({ treasury: USDC(4500).toString(), vault: '0', auctionEscrow: USDC(707).toString() });
    expect(view.auction).toMatchObject({ escrowTotal: view.money.auctionEscrow, auctionEscrowUnits: '500', unitsMinted: '500', bidsProcessed: '5', R: '100' });
    expect(pendingRefundOf(s, h.backers[0]!.address)).toBe(USDC(303));
    expect(view.holders[h.backers[0]!.address]).toEqual({ pending: '0', redeemedUnits: '0', pendingUnits: '100', pendingRefund: USDC(303).toString(), delivered: false });
    expect(balanceUnits(s, h.backers[0]!.address)).toBe(0n);
    // a delivery leaves the escrow: the sum never goes negative (amendment M1)
    await h.exec(h.backers[0]!, { kind: 'deliverBid', seriesId, bidder: h.backers[0]!.address });
    expect(h.sim.stage1View(seriesId).money.auctionEscrow).toBe(USDC(404).toString());
    expect(balanceUnits(s, h.backers[0]!.address)).toBe(100n);
    await h.settle(seriesId, 'deliver');
    const after = h.sim.stage1View(seriesId);
    expect([after.money.auctionEscrow, after.auction.auctionEscrowUnits]).toEqual(['0', '0']);
    expect(after.holders[h.backers[4]!.address]).toEqual({ pending: '0', redeemedUnits: '0', pendingUnits: '0', pendingRefund: '0', delivered: true });
    const pos = (await h.sim.getPosition(seriesId, h.backers[0]!.address))!;
    expect(pos).toMatchObject({ registered: true, pending: '0', lastAccWad: '0', finalClaimable: '0', tailClaimable: '0', units: '100', undeliveredUnits: '0' });
    expect('rewardDebt' in pos).toBe(false);
    const series = (await h.sim.getSeries(seriesId))!;
    expect(series.reporting.firstPeriod).toBe('2026Q1');
    expect(series.reporting.nextExpectedPeriod).toBe('2026Q1');
    expect(derivedStatus(s, await h.sim.now())).toBe('OnTime');
    expect(ledgerClock(s).firstPeriod).toBe(toPid('2026Q1'));
  });

  // cause S3-CV: Stage 1's complete_curve registers nobody (a curve holder registers itself, allowlisted) and settles at
  // the pool's finish time (was: every buyer registered at graduation, settled when the threshold was crossed)
  it("a curve's completion registers nobody and sets the first period from the pool's finish time", async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await h.createCurve();
    await h.curveBuy(seriesId, h.backers[0]!, USDC(400));
    expect(seriesOf(h.sim, seriesId).positions.size).toBe(0);
    await h.curveBuy(seriesId, h.backers[1]!, USDC(350));
    await h.sim.advanceTime(100 * 86_400); // into 2026Q2
    await h.curveBuy(seriesId, h.backers[2]!, USDC(300));
    await h.sim.advanceTime(100 * 86_400); // completed in 2026Q3: the first period is still the fill's quarter
    expect(h.sim.stage1View(seriesId).ledger.mintFinalized).toBe(false);
    await h.sim.submit({ kind: 'completeCurve', seriesId }, 'keeper');
    const s = seriesOf(h.sim, seriesId);
    expect(s.ledger.firstPeriod).toBe(toPid('2026Q2'));
    expect([...s.positions.values()].filter((p) => p.registered)).toEqual([]);
    expect(h.sim.stage1View(seriesId).ledger).toMatchObject({ mintFinalized: true, raiseState: 'Settled', unitsOutstanding: '0', unitsSold: '100000000', clearingPrice: '10000000', proceeds: '0' });
  });

  it('a window buyer with a fill becomes a registered holder', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise({ terms: { lockupSeconds: 10 } });
    const now = (await h.sim.now()) + 11;
    await h.sim.setTime(now);
    await h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: now + 100, revealEndsAt: now + 200 }, 'keeper');
    const seller = h.backers[1]!;
    const buyer = h.sim.address('wallet:window-buyer');
    await h.sim.submit({ kind: 'setAllowlist', wallet: buyer, allowed: true }, 'allowlistManager');
    await h.sim.fund(buyer, 'USDC', USDC(10_000));
    const salt = '0x' + 'cc'.repeat(32);
    await h.exec(seller, { kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'sell', commitment: orderCommitment({ seriesId, windowId: 0, wallet: seller.address, side: 'sell', pricePerUnit: USDC(10), quantity: 50n, salt }), deposit: '0', units: '50' });
    const tx = await h.sim.build({ kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'buy', commitment: orderCommitment({ seriesId, windowId: 0, wallet: buyer, side: 'buy', pricePerUnit: USDC(10.5), quantity: 50n, salt }), deposit: USDC(525).toString(), units: '0' }, buyer);
    await h.sim.send({ tx, signatures: { [buyer]: `sim:${buyer}` } });
    expect(h.sim.stage1View(seriesId).money).toMatchObject({ windowEscrowStable: USDC(525).toString(), windowEscrowUnits: '50' });
    await h.sim.setTime(now + 100);
    await h.exec(seller, { kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'sell', pricePerUnit: USDC(10).toString(), quantity: '50', salt });
    const rtx = await h.sim.build({ kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'buy', pricePerUnit: USDC(10.5).toString(), quantity: '50', salt }, buyer);
    await h.sim.send({ tx: rtx, signatures: { [buyer]: `sim:${buyer}` } });
    expect(seriesOf(h.sim, seriesId).positions.get(buyer)).toBeUndefined();
    await h.sim.setTime(now + 200);
    await h.sim.submit({ kind: 'clearTransferWindow', seriesId, windowId: 0 }, 'keeper');
    expect(seriesOf(h.sim, seriesId).positions.get(buyer)).toMatchObject({ units: 50n, registered: true });
    expect(h.sim.stage1View(seriesId).money).toMatchObject({ windowEscrowStable: '0', windowEscrowUnits: '0' });
    expect(Object.keys(h.sim.stage1View(seriesId).holders)).toContain(buyer);
  });
});
