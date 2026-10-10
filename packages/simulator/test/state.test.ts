import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { orderCommitment } from '@merces/domain';
import { WAD, ZERO_INCOME_COMMITMENT, toPid, type LedgerExpect } from '@merces/math';
import { SimHarness, SimStateVersionError, defaultTerms, deserialiseState, pendingRefundOf, serialiseState } from '../src/index.ts';
import { ZERO_INCOME_COMMITMENT_HEX, derivedStatus, ledgerClock } from '../src/engine/ledger.ts';
import { GENESIS, USDC } from './helpers.ts';
import { seedFinal, seedHolder, seedLedger, seedPause, seedTail, seedVault, seriesOf } from './kit.ts';

const VECTOR_01 = new URL('../../../stage1/packages/vectors/01_happy_path.json', import.meta.url);

/*
 * S2 cause codes:
 *  - S2-V3: simulator state version 3 (S2: the raise's own terms, Stage 1's multi-step settlement); versions 1 and 2
 *    are refused, never upgraded.
 */
describe('simulator state version 3', () => {
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
    seedHolder(h.sim, seriesId, h.backers[0]!.address, { pending: 42n, lastTailAccWad: 5n, finalClaimed: true });

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
    expect(back.version).toBe(3); // cause S2-V3 (was 2)
    expect(structuredClone(h.sim.state)).toEqual(h.sim.state);
  });

  it('refuses a version-1 or version-2 state instead of upgrading it', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const v3 = JSON.parse(serialiseState(h.sim.state)) as Record<string, unknown>;
    const { version: _v, ...v1 } = v3;
    expect(() => deserialiseState(JSON.stringify(v1))).toThrow(SimStateVersionError);
    expect(() => deserialiseState(JSON.stringify({ ...v3, version: 1 }))).toThrow(/version 1 is not supported.*sim:reset/);
    // cause S2-V3: a version-2 state (S1) is refused too
    expect(() => deserialiseState(JSON.stringify({ ...v3, version: 2 }))).toThrow(/version 2 is not supported \(this build needs version 3\).*sim:reset/);
    expect(() => deserialiseState(JSON.stringify(v3))).not.toThrow();
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
      for (const [k, v] of Object.entries(view.auction)) expect([k, v]).toEqual([k, step.auction![k]]);
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
  it('settlement sets the first period and registers every allocated bidder; the auction escrow is the unclaimed refunds', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await h.runRaise({ bids: [{ backer: 0, price: 12_000_000n, qty: 100n }, { backer: 1, price: 11_000_000n, qty: 100n }, { backer: 2, price: 10_000_000n, qty: 100n }, { backer: 3, price: 10_000_000n, qty: 100n }, { backer: 4, price: 9_000_000n, qty: 100n }] });
    const s = seriesOf(h.sim, seriesId);
    expect(s.ledger.firstPeriod).toBe(toPid('2026Q1'));
    for (const b of h.backers) expect(s.positions.get(b.address)).toMatchObject({ registered: true, lastNetAccWad: 0n, lastTailAccWad: 0n, lastFinalAccWad: 0n, finalClaimed: false });
    const view = h.sim.stage1View(seriesId);
    expect(view.ledger.raiseState).toBe('Settled');
    expect(view.ledger.mintFinalized).toBe(true);
    expect(view.auction.mintFinalized).toBe(true);
    expect(view.ledger.capPerUnit).toBe(USDC(22.5).toString());
    expect(Object.keys(view.holders)).toEqual(h.backers.map((b) => b.address).sort());
    const refundable = [...s.bids.values()].reduce((a, b) => a + b.refundable, 0n);
    expect(refundable).toBeGreaterThan(0n);
    expect(view.money).toEqual({ treasury: USDC(4500).toString(), vault: '0', auctionEscrow: refundable.toString() });
    expect(view.auction.escrowTotal).toBe(view.money.auctionEscrow);
    expect(pendingRefundOf(s, h.backers[0]!.address)).toBe(s.bids.get(h.backers[0]!.address)!.refundable);
    // a refund leaves the escrow: the sum never goes negative (amendment M1)
    const first = s.bids.get(h.backers[0]!.address)!.refundable;
    await h.exec(h.backers[0]!, { kind: 'claimRefund', seriesId });
    expect(h.sim.stage1View(seriesId).money.auctionEscrow).toBe((refundable - first).toString());
    for (const b of h.backers.slice(1)) await h.exec(b, { kind: 'claimRefund', seriesId }).catch(() => undefined);
    expect(h.sim.stage1View(seriesId).money.auctionEscrow).toBe('0');
    const pos = (await h.sim.getPosition(seriesId, h.backers[0]!.address))!;
    expect(pos).toMatchObject({ registered: true, pending: '0', lastAccWad: '0', finalClaimable: '0', tailClaimable: '0' });
    expect('rewardDebt' in pos).toBe(false);
    const series = (await h.sim.getSeries(seriesId))!;
    expect(series.reporting.firstPeriod).toBe('2026Q1');
    expect(series.reporting.nextExpectedPeriod).toBe('2026Q1');
    expect(derivedStatus(s, await h.sim.now())).toBe('OnTime');
    expect(ledgerClock(s).firstPeriod).toBe(toPid('2026Q1'));
  });

  it('a curve graduation registers every buyer and sets the first period', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const { terms } = defaultTerms(h.sim, { raiseStyle: 'curve', minimumRaise: USDC(2000).toString(), reservePrice: USDC(5).toString(), unitsOffered: '1000' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    await h.exec(h.backers[0]!, { kind: 'buyCurve', seriesId, amountIn: USDC(500).toString(), minUnitsOut: '0' });
    expect(seriesOf(h.sim, seriesId).positions.get(h.backers[0]!.address)!.registered).toBe(false);
    await h.exec(h.backers[1]!, { kind: 'buyCurve', seriesId, amountIn: USDC(500).toString(), minUnitsOut: '0' });
    await h.exec(h.backers[2]!, { kind: 'buyCurve', seriesId, amountIn: USDC(500).toString(), minUnitsOut: '0' });
    await h.exec(h.backers[3]!, { kind: 'buyCurve', seriesId, amountIn: USDC(600).toString(), minUnitsOut: '0' });
    const s = seriesOf(h.sim, seriesId);
    expect(s.curve!.graduated).toBe(true);
    expect(s.ledger.firstPeriod).toBe(toPid('2026Q1'));
    for (const b of h.backers.slice(0, 4)) expect(s.positions.get(b.address)!.registered).toBe(true);
    expect(h.sim.stage1View(seriesId).ledger.mintFinalized).toBe(true);
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
