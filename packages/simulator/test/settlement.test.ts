import { describe, expect, it } from 'vitest';
import {
  ChainError, bidCommitment, nextSettlementStep, permissionlessCommandKinds, readSettlementView, runSettlement,
  type PermissionlessCommand, type SeriesTerms, type TxResult,
} from '@merces/domain';
import { U64_MAX, requiredEscrow, toPid } from '@merces/math';
import { SimHarness, SimWallet, SimulatorChain, defaultTerms, type Personality } from '../src/index.ts';
import { applyBidOutcome } from '../src/engine/settlement.ts';
import { GENESIS, USDC, expectChainError, expectStage1Error, types } from './helpers.ts';
import { seedAuction, seedBid, seriesOf } from './kit.ts';

/*
 * Stage 1's multi-step settlement in the engine (S2 WP4a; SPEC §5.2, SIM:928-1028). The figures of the harness raise,
 * the pro-rata margin, the 30-bid paging round and the non-reveal case were recomputed with Stage 1's own Simulator.
 *
 * S2 cause codes:
 *  - S2-MS: multi-step settlement (begin, tally pages, finalize, process, deliver; the planner and the driver);
 *  - S2-E: Stage 1's auction error names (`detail.stage1`) and check order;
 *  - S2-VR: validity is fixed at reveal (an invalid bid is refunded in full; a reveal never reverts on validity);
 *  - S2-MF: MintNotFinalized until the last `processBid`; units outstanding and the tranches at mint finalisation;
 *  - S2-PU: per-bid money movement (`UnitsAllocated`, `FeeTaken`, `TreasuryFunded` per processed winner);
 *  - S2-PR: push delivery (`deliverBid`);
 *  - S2-DA: a bidder removed from the allowlist stays valid and is delivered;
 *  - S2-NRC: the non-reveal charge hold (0 bps applies; a charge is never credited);
 *  - S2-RH: `registerHolder` and `HolderRegistered`.
 *
 * S3 cause codes:
 *  - S3-BR: `burnRetired` joins the permissionless group (its own cases are in claims.test.ts);
 *  - S3-FN: the final claim is `claimFinal` (was `claimPayout`, which no longer pays the final pool).
 *  - S3-CN: a curve's census `syncCurveUnits` joins the permissionless group (its own cases are in census.test.ts).
 */

interface Bid { w: SimWallet; price: bigint; qty: bigint; reveal?: boolean; deposit?: bigint }

/**
 * A sealed raise with these bids committed and (unless `reveal: false`) revealed; the clock at the reveal end (plus
 * `offset` seconds).
 */
async function raise(h: SimHarness, bids: Bid[], over: Partial<SeriesTerms> = {}, offset = 0): Promise<{ seriesId: string; commitEndsAt: number; revealEndsAt: number }> {
  const { terms } = defaultTerms(h.sim, over);
  if (!(await h.sim.getIssuer(h.issuer.address))) await h.exec(h.issuer, { kind: 'registerIssuer' });
  const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
  const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
  await h.exec(h.issuer, { kind: 'openRaise', seriesId });
  const { commitEndsAt, revealEndsAt } = (await h.sim.getAuction(seriesId))!;
  const salt = (i: number) => '0x' + (i + 1).toString(16).padStart(2, '0').repeat(32);
  for (const [i, b] of bids.entries()) {
    const commitment = bidCommitment({ seriesId, bidder: b.w.address, pricePerUnit: b.price, quantity: b.qty, salt: salt(i) });
    await h.exec(b.w, { kind: 'commitBid', seriesId, commitment, deposit: (b.deposit ?? requiredEscrow(b.price, b.qty, terms.auctionFeeBps)).toString() });
  }
  await h.sim.setTime(commitEndsAt!);
  for (const [i, b] of bids.entries()) {
    if (b.reveal === false) continue;
    await h.exec(b.w, { kind: 'revealBid', seriesId, pricePerUnit: b.price.toString(), quantity: b.qty.toString(), salt: salt(i) });
  }
  await h.sim.setTime(revealEndsAt! + offset);
  return { seriesId, commitEndsAt: commitEndsAt!, revealEndsAt: revealEndsAt! };
}

/** The harness's default bids: 12/11/10/10/9 USDC × 100 units (clears at 9 for 500 units; refunds 303/202/101/101/0). */
const harnessBids = (h: SimHarness): Bid[] => [12, 11, 10, 10, 9].map((p, i) => ({ w: h.backers[i]!, price: USDC(p), qty: 100n }));

/** `n` extra allowlisted, funded wallets. */
async function wallets(h: SimHarness, n: number): Promise<SimWallet[]> {
  const out: SimWallet[] = [];
  for (let i = 0; i < n; i++) {
    const w = new SimWallet(h.sim.family, `settlement-bidder-${i}`);
    await h.sim.submit({ kind: 'setAllowlist', wallet: w.address, allowed: true }, 'allowlistManager');
    await h.sim.fund(w.address, 'USDC', USDC(100_000));
    out.push(w);
  }
  return out;
}

const keeper = (h: SimHarness, cmd: PermissionlessCommand): Promise<TxResult> => h.sim.submit(cmd, 'keeper');
const balance = async (h: SimHarness, wallet: string): Promise<bigint> => BigInt(await h.sim.getBalance(wallet, 'USDC'));

describe('the chain\'s settlement limits and the permissionless group', () => {
  it('reports the personality\'s settlement limits, derived on every read and never persisted', async () => {
    const sol = SimulatorChain.createSync({ personality: 'solana', genesis: GENESIS });
    const mon = SimulatorChain.createSync({ personality: 'monad', genesis: GENESIS });
    expect((await sol.info()).limits).toEqual({ tallyPageMax: 24, maxBidsPerAuction: null });
    expect((await mon.info()).limits).toEqual({ tallyPageMax: 200, maxBidsPerAuction: 4096 });
    expect('limits' in sol.state.config).toBe(false);
  });

  // cause S2-MS: the engine runs every step (was refused NotImplemented until WP4)
  it('any wallet builds and sends every permissionless step; the keeper submits them too', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await raise(h, harnessBids(h));
    const anyone = h.backers[4]!;
    const cmds: PermissionlessCommand[] = [
      { kind: 'beginSettlement', seriesId, clearingPrice: USDC(9).toString(), qAboveClaim: '400', qAtClaim: '100' },
      { kind: 'tallyBids', seriesId, maxBids: 24 },
      { kind: 'finalizeSettlement', seriesId },
      { kind: 'processBid', seriesId, bidder: h.backers[0]!.address },
      { kind: 'deliverBid', seriesId, bidder: h.backers[0]!.address },
      { kind: 'registerHolder', seriesId, wallet: h.backers[1]!.address },
    ];
    // cause S3-BR: every settlement step and registration; `burnRetired` needs a Retired series (claims.test.ts), and
    // `completeCurve`, `collectCurveProceeds` and `syncCurveUnits` a curve series (curve.test.ts, census.test.ts; cause
    // S3-CV, S3-CN)
    expect(cmds.map((c) => c.kind)).toEqual(permissionlessCommandKinds.filter((k) => !['burnRetired', 'completeCurve', 'collectCurveProceeds', 'syncCurveUnits'].includes(k)));
    for (const cmd of cmds) {
      const tx = await h.sim.build(cmd, anyone.address);
      expect(tx.command).toEqual(cmd);
      await h.sim.send(await anyone.sign(tx));
    }
    expect(await h.sim.getBid(seriesId, h.backers[0]!.address)).toMatchObject({ processed: true, delivered: true });
    await keeper(h, { kind: 'processBid', seriesId, bidder: h.backers[1]!.address });
    // a service role other than the keeper may submit them too (any sender)
    await h.sim.submit({ kind: 'processBid', seriesId, bidder: h.backers[2]!.address }, 'allowlistManager');
    await expect(h.sim.build({ kind: 'settleEverything', seriesId } as never, anyone.address)).rejects.toThrow();
  });
});

describe('Stage 1 settlement, step by step', () => {
  // cause S2-MS, S2-MF, S2-PU, S2-PR
  it('begin → tally → finalize → process → deliver: events, Settling, the escrow per step, the first period at finalize, units outstanding at the last process', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, revealEndsAt } = await raise(h, harnessBids(h));
    const s = seriesOf(h.sim, seriesId);
    const escrow = async () => (await h.sim.getAuction(seriesId))!.escrowTotal;
    expect(await escrow()).toBe(USDC(5252).toString()); // 1212 + 1111 + 1010 + 1010 + 909
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ raiseState: 'Open', phase: 'Reveal', revealedCount: 5, validCount: 5, round: 0, proposal: null });

    const begun = await keeper(h, { kind: 'beginSettlement', seriesId, clearingPrice: USDC(9).toString(), qAboveClaim: '400', qAtClaim: '100' });
    expect(types(begun.events)).toEqual(['SettlementProposed']);
    expect(begun.events[0]!.payload).toEqual({ seriesId, clearingPrice: USDC(9).toString(), round: 1 });
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ raiseState: 'Settling', phase: 'Settling', round: 1, roundRejected: false, proposal: { clearingPrice: USDC(9).toString(), qAboveClaim: '400', qAtClaim: '100', rClaim: '100' }, tally: { talliedCount: 0 } });
    expect((await h.sim.getSeries(seriesId))!.phase).toBe('Settling');

    expect((await keeper(h, { kind: 'tallyBids', seriesId })).events).toEqual([]);
    expect((await h.sim.getAuction(seriesId))!.tally).toEqual({ talliedCount: 5, qAbove: '400', qAt: '100', allocSum: '100', minValidPrice: USDC(9).toString() });

    const fin = await keeper(h, { kind: 'finalizeSettlement', seriesId });
    expect(types(fin.events)).toEqual(['AuctionSettled']);
    // Stage 1's RaiseSettled fields: the fees are taken bid by bid at processing (no totalFees)
    expect(fin.events[0]!.payload).toEqual({ seriesId, clearingPrice: USDC(9).toString(), unitsSold: '500', proceeds: USDC(4500).toString(), settledAt: revealEndsAt });
    expect(s.ledger.firstPeriod).toBe(toPid('2026Q1'));
    expect(await h.sim.getSeries(seriesId)).toMatchObject({ phase: 'Settled', settledAt: revealEndsAt, issuePrice: USDC(9).toString(), unitsSold: '500', unitsOutstanding: '0', mintFinalized: false });
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ clearingPrice: USDC(9).toString(), qAbove: '400', qAt: '100', R: '100', unitsSold: '500', proceeds: USDC(4500).toString(), finalizedAt: revealEndsAt, failureReason: null, mintFinalized: false });
    expect(await escrow()).toBe(USDC(5252).toString());

    const refunds = [303, 202, 101, 101, 0];
    let held = USDC(5252);
    for (const [i, b] of h.backers.entries()) {
      const r = await keeper(h, { kind: 'processBid', seriesId, bidder: b.address });
      const last = i === h.backers.length - 1;
      expect(types(r.events)).toEqual(['HolderRegistered', 'UnitsAllocated', 'FeeTaken', 'TreasuryFunded', ...(last ? ['RaiseMintFinalized'] : [])]);
      expect(r.events[1]!.payload).toEqual({ seriesId, bidder: b.address, units: '100', cost: USDC(900).toString(), fee: USDC(9).toString(), refund: USDC(refunds[i]!).toString() });
      expect(r.events[2]!.payload).toEqual({ seriesId, kind: 'auction', amount: USDC(9).toString(), payer: b.address });
      expect(r.events[3]!.payload).toEqual({ seriesId, amount: USDC(900).toString() });
      held -= USDC(909);
      expect(await escrow()).toBe(held.toString());
      expect((await h.sim.getSeries(seriesId))!.unitsOutstanding).toBe(last ? '500' : '0');
      expect(await h.sim.getPosition(seriesId, b.address)).toMatchObject({ units: '100', undeliveredUnits: '100', registered: true });
      if (last) expect(r.events[4]!.payload).toEqual({ seriesId, unitsSold: '500', proceeds: USDC(4500).toString() });
    }
    expect(held).toBe(USDC(707));
    expect(await balance(h, h.sim.state.feeCollector)).toBe(USDC(45));
    expect(await h.sim.getTreasury(seriesId)).toMatchObject({ total: USDC(4500).toString(), balance: USDC(4500).toString() });
    expect((await h.sim.getTreasury(seriesId))!.tranches.map((t) => t.amount)).toEqual([USDC(2250), USDC(1125), USDC(1125)].map(String));
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ bidsProcessed: 5, unitsMinted: '500', escrowUnits: '500', mintFinalized: true });

    const before = await balance(h, h.backers[0]!.address);
    const d = await h.exec(h.backers[3]!, { kind: 'deliverBid', seriesId, bidder: h.backers[0]!.address });
    expect(types(d.events)).toEqual(['BidDelivered']);
    expect(d.events[0]!.payload).toEqual({ seriesId, bidder: h.backers[0]!.address, units: '100', refund: USDC(303).toString() });
    expect(await balance(h, h.backers[0]!.address)).toBe(before + USDC(303));
    expect(await escrow()).toBe(USDC(404).toString());
    // position units do not move at delivery: they joined the position at processing
    expect(await h.sim.getPosition(seriesId, h.backers[0]!.address)).toMatchObject({ units: '100', undeliveredUnits: '0' });
    // cause S2-PR: the bid read drops the deprecated `refunded` (S2 WP7); the refund delivered is the BidDelivered event's
    expect(await h.sim.getBid(seriesId, h.backers[0]!.address)).toMatchObject({ processed: true, delivered: true, allocatedUnits: '100', pendingUnits: '0', pendingRefund: '0' });
    expect(await h.sim.getBid(seriesId, h.backers[1]!.address)).toMatchObject({ processed: true, delivered: false, pendingUnits: '100', pendingRefund: USDC(202).toString() });
    await h.settle(seriesId, 'deliver');
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ escrowTotal: '0', escrowUnits: '0' });
  });

  // cause S2-MS, S2-E
  it('records ClaimMismatch and InvalidClearingPrice rejections; TallyInProgress, NotSettling, TallyIncomplete and the u64 claims', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await raise(h, harnessBids(h));
    await expectStage1Error(keeper(h, { kind: 'tallyBids', seriesId }), 'NotSettling');
    await expectStage1Error(keeper(h, { kind: 'finalizeSettlement', seriesId }), 'NotSettling');
    const tooBig = keeper(h, { kind: 'beginSettlement', seriesId, clearingPrice: (U64_MAX + 1n).toString(), qAboveClaim: '0', qAtClaim: '0' });
    await expectChainError(tooBig, 'InvalidTerms');
    await expectStage1Error(tooBig, 'AmountOutOfRange');
    // round 1: a wrong claim at the right price
    await keeper(h, { kind: 'beginSettlement', seriesId, clearingPrice: USDC(9).toString(), qAboveClaim: '400', qAtClaim: '99' });
    const again = keeper(h, { kind: 'beginSettlement', seriesId, clearingPrice: USDC(9).toString(), qAboveClaim: '400', qAtClaim: '100' });
    await expectChainError(again, 'WrongPhase');
    await expectStage1Error(again, 'TallyInProgress');
    await keeper(h, { kind: 'tallyBids', seriesId, maxBids: 2 });
    const early = keeper(h, { kind: 'finalizeSettlement', seriesId });
    await expectChainError(early, 'WrongPhase');
    await expectStage1Error(early, 'TallyIncomplete');
    await keeper(h, { kind: 'tallyBids', seriesId });
    const rejected = await keeper(h, { kind: 'finalizeSettlement', seriesId });
    expect(types(rejected.events)).toEqual(['SettlementRejected']);
    expect(rejected.events[0]!.payload).toEqual({ seriesId, round: 1, clearingPrice: USDC(9).toString(), reason: 'ClaimMismatch' });
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ raiseState: 'Settling', round: 1, roundRejected: true, rejectionReason: 'ClaimMismatch', tally: { talliedCount: 5, qAbove: '400', qAt: '100' }, finalizedAt: null });
    await expectStage1Error(keeper(h, { kind: 'tallyBids', seriesId }), 'NotSettling');
    await expectStage1Error(keeper(h, { kind: 'finalizeSettlement', seriesId }), 'NotSettling');
    // round 2: honest claims at a price that does not clear (200 above, 200 at 10: neither over- nor undersubscribed there)
    expect((await keeper(h, { kind: 'beginSettlement', seriesId, clearingPrice: USDC(10).toString(), qAboveClaim: '200', qAtClaim: '200' })).events[0]!.payload).toMatchObject({ round: 2 });
    expect((await h.sim.getAuction(seriesId))!).toMatchObject({ roundRejected: false, rejectionReason: null, tally: { talliedCount: 0 } });
    await keeper(h, { kind: 'tallyBids', seriesId });
    const invalid = await keeper(h, { kind: 'finalizeSettlement', seriesId });
    expect(invalid.events[0]!.payload).toEqual({ seriesId, round: 2, clearingPrice: USDC(10).toString(), reason: 'InvalidClearingPrice' });
    // processing waits for a settled or failed raise
    await expectStage1Error(keeper(h, { kind: 'processBid', seriesId, bidder: h.backers[0]!.address }), 'RaiseNotSettled');
    // the planner proposes the honest round 3, and the rest follows
    const run = await h.settle(seriesId, 'deliver');
    expect(run.steps.slice(0, 3)).toEqual(['beginSettlement', 'tallyBids', 'finalizeSettlement']);
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ raiseState: 'Settled', round: 3, clearingPrice: USDC(9).toString(), unitsSold: '500' });
  });

  // S2 D3: the running tally is the sum of the pages; finalize checks it equals one pass over every revealed bid
  it('finalize refuses a running tally that is not one pass over the revealed bids (an invariant, never reached)', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await raise(h, harnessBids(h));
    await keeper(h, { kind: 'beginSettlement', seriesId, clearingPrice: USDC(9).toString(), qAboveClaim: '400', qAtClaim: '100' });
    await keeper(h, { kind: 'tallyBids', seriesId });
    seedAuction(h.sim, seriesId, { tally: { ...seriesOf(h.sim, seriesId).auction.tally, qAbove: 399n } });
    await expectChainError(keeper(h, { kind: 'finalizeSettlement', seriesId }), 'ChainSpecific');
    // a bid seeded as already tallied this round is skipped by the next page (the per-bid round mark)
    const h2 = await SimHarness.create('monad', { genesis: GENESIS });
    const r2 = await raise(h2, harnessBids(h2));
    await keeper(h2, { kind: 'beginSettlement', seriesId: r2.seriesId, clearingPrice: USDC(9).toString(), qAboveClaim: '400', qAtClaim: '100' });
    seedBid(h2.sim, r2.seriesId, h2.backers[0]!.address, { talliedRound: 1 });
    await keeper(h2, { kind: 'tallyBids', seriesId: r2.seriesId });
    expect((await h2.sim.getAuction(r2.seriesId))!.tally).toMatchObject({ talliedCount: 4, qAbove: '300' });
    await expectStage1Error(keeper(h2, { kind: 'finalizeSettlement', seriesId: r2.seriesId }), 'TallyIncomplete');
  });

  // cause S2-MS (D11): Solana tallies 24 bids a page, EVM 200
  for (const [personality, pages] of [['solana', 2], ['monad', 1]] as [Personality, number][]) {
    it(`tallies 30 revealed bids in ${pages} page(s) on ${personality}; an overlapping page is harmless`, async () => {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      const ws = await wallets(h, 30);
      // 30 × 10 units at 8–12 USDC for 300 units: clears at 8 (6 bids at 8, 240 units above)
      const { seriesId } = await raise(h, ws.map((w, i) => ({ w, price: USDC(8 + (i % 5)), qty: 10n })), { unitsOffered: '300', minimumRaise: USDC(2000).toString() });
      const run = await runSettlement(h.sim, seriesId, { until: 'finalize' });
      expect(run.steps).toEqual(['beginSettlement', ...Array<string>(pages).fill('tallyBids'), 'finalizeSettlement']);
      expect(await h.sim.getAuction(seriesId)).toMatchObject({ raiseState: 'Settled', clearingPrice: USDC(8).toString(), unitsSold: '300', R: '60', tally: { talliedCount: 30 } });
      // a fresh round on another chain of the same bids: small pages, then a page past the end changes nothing
      const h2 = await SimHarness.create(personality, { genesis: GENESIS });
      const ws2 = await wallets(h2, 30);
      const r2 = await raise(h2, ws2.map((w, i) => ({ w, price: USDC(8 + (i % 5)), qty: 10n })), { unitsOffered: '300', minimumRaise: USDC(2000).toString() });
      await keeper(h2, { kind: 'beginSettlement', seriesId: r2.seriesId, clearingPrice: USDC(8).toString(), qAboveClaim: '240', qAtClaim: '60' });
      const tallied = async (): Promise<number> => (await h2.sim.getAuction(r2.seriesId))!.tally.talliedCount;
      await keeper(h2, { kind: 'tallyBids', seriesId: r2.seriesId, maxBids: 1_000 }); // capped at the chain's page
      expect(await tallied()).toBe(personality === 'solana' ? 24 : 30);
      await keeper(h2, { kind: 'tallyBids', seriesId: r2.seriesId, maxBids: 3 });
      expect(await tallied()).toBe(personality === 'solana' ? 27 : 30);
      await keeper(h2, { kind: 'tallyBids', seriesId: r2.seriesId });
      const t = (await h2.sim.getAuction(r2.seriesId))!.tally;
      await keeper(h2, { kind: 'tallyBids', seriesId: r2.seriesId }); // nothing left: harmless
      expect((await h2.sim.getAuction(r2.seriesId))!.tally).toEqual(t);
      expect(t).toEqual({ talliedCount: 30, qAbove: '240', qAt: '60', allocSum: '60', minValidPrice: USDC(8).toString() });
      expect(types((await keeper(h2, { kind: 'finalizeSettlement', seriesId: r2.seriesId })).events)).toEqual(['AuctionSettled']);
    });
  }

  // cause S2-MS: Stage 1's marginal allocation floor(R × q / q_at); the remainder is not sold
  it('allocates the bids at the clearing price pro rata, floored, and leaves the remainder unsold', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const [b0, b1, b2, b3] = h.backers;
    // 250 units, cap 50% = 125: 100 above at 12, then 100 + 100 + 70 at 10 → R = min(250 − 100, 270) = 150
    const { seriesId } = await raise(h, [{ w: b0!, price: USDC(12), qty: 100n }, { w: b1!, price: USDC(10), qty: 100n }, { w: b2!, price: USDC(10), qty: 100n }, { w: b3!, price: USDC(10), qty: 70n }], { unitsOffered: '250', walletCapBps: 5000, minimumRaise: USDC(2000).toString() });
    await h.settle(seriesId, 'deliver');
    // 150 × 100 / 270 = 55.5 → 55 (twice); 150 × 70 / 270 = 38.8 → 38; 148 of 150 sold at the margin
    const alloc = await Promise.all([b0, b1, b2, b3].map(async (b) => (await h.sim.getBid(seriesId, b!.address))!.allocatedUnits));
    expect(alloc).toEqual(['100', '55', '55', '38']);
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ clearingPrice: USDC(10).toString(), R: '150', qAt: '270', qAbove: '100', unitsSold: '248', proceeds: USDC(2480).toString() });
    expect((await h.sim.getSeries(seriesId))!.unitsOutstanding).toBe('248');
    // b3 paid 38 × 10 + 1% and got the rest of its 707 back
    expect(await balance(h, b3!.address)).toBe(1_000_000_000_000n - USDC(380) - USDC(3.8));
  });

  // S2 D7 (amendment L2): SPEC §5.2 step 5 and both chains; Stage 1's TS reference would settle it
  it('fails a round that would sell 0 units (MinRaise), and finalises the mint with 0 and 0', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    // 1 unit offered, cap 100% = 1: two valid bids of 1 unit at 10 → R = 1, each floor(1 × 1 / 2) = 0
    const { seriesId } = await raise(h, [{ w: h.backers[0]!, price: USDC(10), qty: 1n }, { w: h.backers[1]!, price: USDC(10), qty: 1n }], { unitsOffered: '1', walletCapBps: 10_000, minimumRaise: '0' });
    const run = await h.settle(seriesId, 'deliver');
    expect(run.steps).toEqual(['beginSettlement', 'tallyBids', 'finalizeSettlement', 'processBid', 'processBid', 'deliverBid', 'deliverBid']);
    const events = run.results.flatMap((r) => r.events);
    expect(events.find((e) => e.type === 'SettlementProposed')!.payload).toMatchObject({ clearingPrice: USDC(10).toString() });
    expect(events.find((e) => e.type === 'AuctionFailed')!.payload).toEqual({ seriesId, reason: 'MinRaise', clearingPrice: USDC(10).toString(), unitsSold: '0', proceeds: '0', minimumRaise: '0' });
    expect(events.find((e) => e.type === 'RaiseMintFinalized')!.payload).toEqual({ seriesId, unitsSold: '0', proceeds: '0' });
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ raiseState: 'Failed', failureReason: 'MinRaise', clearingPrice: USDC(10).toString(), R: '0', unitsSold: '0', mintFinalized: true });
    for (const b of h.backers.slice(0, 2)) expect(await balance(h, b.address)).toBe(1_000_000_000_000n);
  });

  // cause S2-FP: Stage 1 emits (0, 0) on a failed raise's mint finalisation on both chains (its TS simulator emits the would-be values)
  it('a failed raise processes every bid without an event, refunds in full and finalises the mint with 0 and 0', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await raise(h, [{ w: h.backers[0]!, price: USDC(10), qty: 10n }, { w: h.backers[1]!, price: USDC(11), qty: 10n, reveal: false }]);
    await keeper(h, { kind: 'beginSettlement', seriesId, clearingPrice: USDC(10).toString(), qAboveClaim: '0', qAtClaim: '10' });
    await keeper(h, { kind: 'tallyBids', seriesId });
    const fin = await keeper(h, { kind: 'finalizeSettlement', seriesId });
    expect(fin.events[0]!.payload).toEqual({ seriesId, reason: 'MinRaise', clearingPrice: USDC(10).toString(), unitsSold: '10', proceeds: USDC(100).toString(), minimumRaise: USDC(4000).toString() });
    expect(await h.sim.getSeries(seriesId)).toMatchObject({ phase: 'Failed', settledAt: null, issuePrice: null, mintFinalized: false });
    expect((await keeper(h, { kind: 'processBid', seriesId, bidder: h.backers[0]!.address })).events).toEqual([]);
    const last = await keeper(h, { kind: 'processBid', seriesId, bidder: h.backers[1]!.address });
    expect(last.events.map((e) => [e.type, e.payload])).toEqual([['RaiseMintFinalized', { seriesId, unitsSold: '0', proceeds: '0' }]]);
    expect(await h.sim.getBid(seriesId, h.backers[1]!.address)).toMatchObject({ processed: true, pendingRefund: USDC(111.1).toString() });
    expect(seriesOf(h.sim, seriesId).ledger.firstPeriod).toBeNull();
  });

  // cause S2-MS, S2-E
  it('refuses BidNotFound, AlreadyProcessed, NotProcessed and AlreadyDelivered', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await raise(h, harnessBids(h));
    await h.settle(seriesId, 'finalize');
    const b0 = h.backers[0]!.address;
    const stranger = h.sim.address('wallet:no-bid');
    await expectStage1Error(keeper(h, { kind: 'processBid', seriesId, bidder: stranger }), 'BidNotFound');
    await expectStage1Error(keeper(h, { kind: 'deliverBid', seriesId, bidder: stranger }), 'BidNotFound');
    const notYet = keeper(h, { kind: 'deliverBid', seriesId, bidder: b0 });
    await expectChainError(notYet, 'WrongPhase');
    await expectStage1Error(notYet, 'NotProcessed');
    await keeper(h, { kind: 'processBid', seriesId, bidder: b0 });
    const twice = keeper(h, { kind: 'processBid', seriesId, bidder: b0 });
    await expectChainError(twice, 'Duplicate');
    await expectStage1Error(twice, 'AlreadyProcessed');
    await keeper(h, { kind: 'deliverBid', seriesId, bidder: b0 });
    const delivered = keeper(h, { kind: 'deliverBid', seriesId, bidder: b0 });
    await expectChainError(delivered, 'Duplicate');
    await expectStage1Error(delivered, 'AlreadyDelivered');
  });

  // cause S2-E, S2-VR: Stage 1's commit and reveal checks, in order
  it('commit and reveal refuse in Stage 1\'s order; an invalid reveal is recorded, not refused', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { terms } = defaultTerms(h.sim);
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    const [w, v] = [h.backers[0]!, h.backers[1]!];
    const salt = '0x' + 'ab'.repeat(32);
    const c = bidCommitment({ seriesId, bidder: w.address, pricePerUnit: USDC(7), quantity: 50n, salt });
    await expectStage1Error(h.exec(w, { kind: 'commitBid', seriesId, commitment: c, deposit: '1' }), 'RaiseNotOpen');
    await h.exec(h.issuer, { kind: 'openRaise', seriesId });
    const { commitEndsAt, revealEndsAt } = (await h.sim.getAuction(seriesId))!;
    await expectStage1Error(h.exec(w, { kind: 'commitBid', seriesId, commitment: c, deposit: '0' }), 'ZeroEscrow');
    await expectStage1Error(h.exec(w, { kind: 'commitBid', seriesId, commitment: c, deposit: (U64_MAX + 1n).toString() }), 'AmountOutOfRange');
    await expectStage1Error(h.exec(w, { kind: 'commitBid', seriesId, commitment: c, deposit: USDC(2_000_000).toString() }), 'InsufficientEscrow');
    // below the reserve (7 < 8), so invalid at reveal whatever the deposit
    await h.exec(w, { kind: 'commitBid', seriesId, commitment: c, deposit: USDC(500).toString() });
    expect((await h.sim.getAuction(seriesId))!.escrowTotal).toBe(USDC(500).toString());
    await expectStage1Error(h.exec(w, { kind: 'revealBid', seriesId, pricePerUnit: USDC(7).toString(), quantity: '50', salt }), 'RevealNotStarted');
    await h.sim.setTime(commitEndsAt!);
    await expectStage1Error(h.exec(v, { kind: 'commitBid', seriesId, commitment: c, deposit: '1' }), 'CommitPhaseClosed');
    await expectStage1Error(h.exec(v, { kind: 'revealBid', seriesId, pricePerUnit: USDC(7).toString(), quantity: '50', salt }), 'BidNotFound');
    const r = await h.exec(w, { kind: 'revealBid', seriesId, pricePerUnit: USDC(7).toString(), quantity: '50', salt });
    expect(r.events[0]!.payload).toEqual({ seriesId, bidder: w.address, pricePerUnit: USDC(7).toString(), quantity: '50', valid: false });
    expect(await h.sim.getBid(seriesId, w.address)).toMatchObject({ revealIndex: 0, valid: false });
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ revealedCount: 1, validCount: 0 });
    await expectStage1Error(h.exec(w, { kind: 'revealBid', seriesId, pricePerUnit: USDC(7).toString(), quantity: '50', salt }), 'AlreadyRevealed');
    await h.sim.setTime(revealEndsAt!);
    await expectStage1Error(h.exec(w, { kind: 'revealBid', seriesId, pricePerUnit: USDC(7).toString(), quantity: '50', salt }), 'RevealPhaseClosed');
    // no valid bid: the raise fails NoValidBids whatever the proposal, and the deposit comes back in full
    await h.settle(seriesId, 'deliver');
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ raiseState: 'Failed', failureReason: 'NoValidBids', clearingPrice: null });
    expect(await balance(h, w.address)).toBe(1_000_000_000_000n);
  });
});

describe('the mint gate, delivery and holders', () => {
  // cause S2-MF: Stage 1's MintNotFinalized until the last processBid (SIM:458, 1034, 1062, 1154, 1332, 1426, 1489)
  it('refuses the money paths with MintNotFinalized between finalize and the last process', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, privateTerms } = await h.runRaise({ terms: { lockupSeconds: 10 }, settle: 'finalize' });
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    const now = await h.sim.now();
    await h.sim.setTime(now + 11);
    const report = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, incomeYtdNow: 0n });
    const gated: Promise<unknown>[] = [
      h.exec(h.issuer, { kind: 'drawRelease', seriesId }),
      h.exec(h.issuer, report.command),
      h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: '1' }),
      h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() }),
      h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]),
      h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: now + 100, revealEndsAt: now + 200 }, 'keeper'),
    ];
    for (const p of gated) {
      await expectChainError(p, 'WrongPhase');
      await expectStage1Error(p, 'MintNotFinalized');
    }
    expect((await h.sim.getSeries(seriesId))!.mintFinalized).toBe(false);
    await h.settle(seriesId, 'process');
    expect((await h.sim.getSeries(seriesId))!.mintFinalized).toBe(true);
    expect(types((await h.exec(h.issuer, { kind: 'drawRelease', seriesId })).events)).toEqual(['FundsReleased']);
    await expectStage1Error(h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: '1' }), 'NothingDue');
  });

  // cause S2-DA
  it('a winner removed from the allowlist is processed, registered and delivered', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await raise(h, harnessBids(h));
    const b0 = h.backers[0]!;
    await h.sim.submit({ kind: 'setAllowlist', wallet: b0.address, allowed: false }, 'allowlistManager');
    const before = await balance(h, b0.address);
    await h.settle(seriesId, 'deliver');
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ clearingPrice: USDC(9).toString(), unitsSold: '500' });
    expect(await h.sim.getPosition(seriesId, b0.address)).toMatchObject({ units: '100', undeliveredUnits: '0', registered: true });
    expect(await balance(h, b0.address)).toBe(before + USDC(303));
  });

  // cause S2-RH: Stage 1 register_holder (SIM:618-623); both chains emit HolderRegistered
  it('registerHolder: any sender, an allowlisted wallet only, idempotent, one HolderRegistered', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    const outsider = h.sim.address('wallet:outsider');
    const refused = h.exec(h.backers[0]!, { kind: 'registerHolder', seriesId, wallet: outsider });
    await expectChainError(refused, 'NotAllowlisted');
    await expectStage1Error(refused, 'NotAllowlisted');
    expect(seriesOf(h.sim, seriesId).positions.has(outsider)).toBe(false);
    await h.sim.submit({ kind: 'setAllowlist', wallet: outsider, allowed: true }, 'allowlistManager');
    const first = await h.exec(h.backers[0]!, { kind: 'registerHolder', seriesId, wallet: outsider });
    expect(first.events.map((e) => [e.type, e.payload])).toEqual([['HolderRegistered', { seriesId, holder: outsider }]]);
    expect((await keeper(h, { kind: 'registerHolder', seriesId, wallet: outsider })).events).toEqual([]);
    // a winner registered at processing registers nothing new
    expect((await keeper(h, { kind: 'registerHolder', seriesId, wallet: h.backers[1]!.address })).events).toEqual([]);
    // a registration holds no units: the position lists only holders with something
    expect((await h.sim.listPositions(seriesId)).map((p) => p.wallet)).not.toContain(outsider);
    expect(seriesOf(h.sim, seriesId).positions.get(outsider)).toMatchObject({ registered: true, units: 0n });
  });

  // SIM:1369-1377, 1453: Stage 1 delivers a pending allocation before a redemption claim and a final claim
  it('the redemption claim and the final claim deliver a pending bid first', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise({ terms: { lockupSeconds: 10 }, settle: 'process' });
    const [b0, b1] = [h.backers[0]!, h.backers[1]!];
    await h.sim.setTime((await h.sim.now()) + 11);
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() });
    const before = await balance(h, b0.address);
    const r = await h.exec(b0, { kind: 'claimRedemption', seriesId });
    expect(types(r.events)).toEqual(['BidDelivered', 'UnitsBurned', 'RedemptionClaimed']);
    expect(r.events[0]!.payload).toEqual({ seriesId, bidder: b0.address, units: '100', refund: USDC(303).toString() });
    expect(await balance(h, b0.address)).toBe(before + USDC(303) + USDC(900)); // the refund and 100 × the redemption price 9
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    await h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]);
    const fin = await h.exec(b1, { kind: 'claimFinal', seriesId }); // cause S3-FN
    expect(types(fin.events)[0]).toBe('BidDelivered');
    expect(fin.events[0]!.payload).toEqual({ seriesId, bidder: b1.address, units: '100', refund: USDC(202).toString() });
    expect(await h.sim.getBid(seriesId, b1.address)).toMatchObject({ delivered: true });
  });

  // cause S2-NRC (amendment M1): the charge is held; Stage 1's processBid gets 0 bps, and a charge is never credited
  it('an unrevealed bid on a settled raise is refunded in full, whatever the series recorded; an injected charge is refused', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const bids = [...harnessBids(h).slice(0, 4), { w: h.backers[4]!, price: USDC(9), qty: 100n, reveal: false }];
    // 400 units, cap 25% = 100: the four revealed bids clear at 10 and take all 400
    const { seriesId } = await raise(h, bids, { nonRevealChargeBps: 100, unitsOffered: '400', walletCapBps: 2500, minimumRaise: USDC(3200).toString() });
    expect((await h.sim.getSeries(seriesId))!.terms.nonRevealChargeBps).toBe(100);
    await h.settle(seriesId, 'deliver');
    expect((await h.sim.getSeries(seriesId))!.phase).toBe('Settled');
    // cause S2-PR: the bid read drops the deprecated `refunded` (S2 WP7); the full refund shows in the balance
    expect(await h.sim.getBid(seriesId, h.backers[4]!.address)).toMatchObject({ revealed: null, processed: true, delivered: true, pendingRefund: '0' });
    expect(await balance(h, h.backers[4]!.address)).toBe(1_000_000_000_000n);
    // the fee collector holds the auction fees only (4 × 1% of 10 × 100)
    expect(await balance(h, h.sim.state.feeCollector)).toBe(USDC(40));
    // Stage 1's simulator at the 100 bps the series recorded charges b4 1% of 909 (refund 899.91; fee collector 49.09):
    // that charge, should Stage 1's processBid ever return it, is refused, value-free, and moves nothing
    const s = seriesOf(h.sim, seriesId);
    const b = { ...s.bids.get(h.backers[4]!.address)!, processed: false, delivered: false };
    let caught: unknown;
    try {
      applyBidOutcome(h.sim.engine, s, b, { alloc: 0n, cost: 0n, fee: 0n, pendingRefund: USDC(899.91), charge: USDC(9.09) }, () => undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ChainError);
    expect((caught as ChainError).code).toBe('ChainSpecific');
    expect(/\d/.test((caught as ChainError).message)).toBe(false);
    expect(b.processed).toBe(false);
    expect(await balance(h, h.sim.state.feeCollector)).toBe(USDC(40));
  });
});

describe('the planner and the driver on the chain', () => {
  // S2 amendment M3: the planner reads the stored raise state, not the display phase (which reads Reveal after the end)
  it('plans from a real auction read: wait during the reveal, then Stage 1\'s proposal once it has ended', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, revealEndsAt } = await raise(h, harnessBids(h), {}, -1);
    const limits = (await h.sim.info()).limits;
    const plan = async () => {
      const view = (await readSettlementView(h.sim, seriesId))!;
      return { a: (await h.sim.getAuction(seriesId))!, step: nextSettlementStep(view, { now: await h.sim.now(), limits, deliver: true }) };
    };
    const during = await plan();
    expect([during.a.phase, during.a.raiseState]).toEqual(['Reveal', 'Open']);
    expect(during.step).toEqual({ kind: 'wait', until: revealEndsAt, stage: 'reveal' });
    await h.sim.setTime(revealEndsAt);
    const after = await plan();
    // the display phase still reads Reveal past the reveal end; the stored state says Open, and the plan proposes
    expect([after.a.phase, after.a.raiseState]).toEqual(['Reveal', 'Open']);
    expect(after.step).toEqual({ kind: 'submit', command: { kind: 'beginSettlement', seriesId, clearingPrice: USDC(9).toString(), qAboveClaim: '400', qAtClaim: '100' }, stage: 'awaiting-proposal' });
  });

  it('runSettlement stops at its goal, waits for the reveal end, and re-plans after losing a race', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, revealEndsAt } = await raise(h, harnessBids(h), {}, -1);
    expect(await runSettlement(h.sim, seriesId, { until: 'deliver' })).toMatchObject({ steps: [], stage: 'reveal', waitUntil: revealEndsAt });
    await h.sim.setTime(revealEndsAt);
    // another sender proposes and tallies between our read and our submit: our begin is refused TallyInProgress, and
    // the driver re-reads and finalizes the other sender's round
    let raced = false;
    const submit = async (cmd: PermissionlessCommand): Promise<TxResult> => {
      if (!raced) {
        raced = true;
        await h.exec(h.backers[4]!, { kind: 'beginSettlement', seriesId, clearingPrice: USDC(9).toString(), qAboveClaim: '400', qAtClaim: '100' });
        await h.exec(h.backers[4]!, { kind: 'tallyBids', seriesId });
      }
      return h.sim.submit(cmd, 'keeper');
    };
    const fin = await runSettlement(h.sim, seriesId, { until: 'finalize', submit });
    expect(fin.steps).toEqual(['finalizeSettlement']);
    expect(fin.stage).toBe('processing');
    const proc = await runSettlement(h.sim, seriesId, { until: 'process' });
    expect(proc.steps).toEqual(Array<string>(5).fill('processBid'));
    expect(proc.stage).toBe('delivering');
    const del = await runSettlement(h.sim, seriesId, { until: 'deliver' });
    expect(del).toMatchObject({ steps: Array<string>(5).fill('deliverBid'), stage: 'complete' });
    expect(await runSettlement(h.sim, seriesId, { until: 'deliver' })).toMatchObject({ steps: [], stage: 'complete' });
  });
});

describe('the driver\'s step bound', () => {
  // the keepers bound their work per pass (`advanceSettlements`): at the bound the driver stops and says so, or throws
  it('runSettlement at maxSteps throws by default, or stops with `limited` and resumes on the next run', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await h.runRaise({ settle: 'none' });
    await expectChainError(runSettlement(h.sim, seriesId, { until: 'deliver', maxSteps: 2 }), 'ChainSpecific');
    // the two steps sent before the throw stay sent (begin and the one tally page); the next run goes on from there
    const first = await runSettlement(h.sim, seriesId, { until: 'deliver', maxSteps: 3, atLimit: 'stop' });
    expect(first).toMatchObject({ steps: ['finalizeSettlement', 'processBid', 'processBid'], stage: 'processing', limited: true });
    const rest = await runSettlement(h.sim, seriesId, { until: 'deliver', maxSteps: 64, atLimit: 'stop' });
    expect(rest.steps).toEqual([...Array<string>(3).fill('processBid'), ...Array<string>(5).fill('deliverBid')]);
    expect([rest.stage, rest.limited]).toEqual(['complete', undefined]);
  });

  // S2 review fix: a keeper reports the steps a pass landed before a refusal (`onError: 'stop'`), where a throw loses them
  it('runSettlement refused part-way throws by default, or stops with the steps that landed, the stage and the error', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const refusal = new ChainError('ChainSpecific', 'compute budget exceeded');
    const refusing = (bidder: string) => async (cmd: PermissionlessCommand): Promise<TxResult> => {
      if (cmd.kind === 'processBid' && cmd.bidder === bidder) throw refusal;
      return h.sim.submit(cmd, 'keeper');
    };
    const a = (await h.runRaise({ settle: 'none' })).seriesId;
    await expect(runSettlement(h.sim, a, { until: 'process', submit: refusing(h.backers[1]!.address) })).rejects.toBe(refusal);
    expect(await h.sim.getAuction(a)).toMatchObject({ raiseState: 'Settled', bidsProcessed: 1 }); // four steps landed all the same
    const b = (await h.runRaise({ settle: 'none' })).seriesId;
    const run = await runSettlement(h.sim, b, { until: 'process', submit: refusing(h.backers[1]!.address), onError: 'stop' });
    expect(run).toMatchObject({ steps: ['beginSettlement', 'tallyBids', 'finalizeSettlement', 'processBid'], stage: 'processing', error: refusal });
    expect(run.results).toHaveLength(4);
    // a lost race is still re-planned, not an error; an error before the first plan is thrown either way
    const rest = await runSettlement(h.sim, b, { until: 'process', onError: 'stop' });
    expect([rest.steps, rest.stage, rest.error]).toEqual([Array<string>(4).fill('processBid'), 'delivering', undefined]);
    await expectChainError(runSettlement(h.sim, 'no-such-series', { until: 'process', onError: 'stop' }), 'NotFound');
    for (const s of [a, b]) await h.settle(s, 'deliver');
  });
});
