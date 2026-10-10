import { describe, expect, it } from 'vitest';
import { bidCommitment } from '@merces/domain';
import { capPerUnit, pidAt } from '@merces/math';
import { SimHarness, SimWallet, defaultTerms } from '../src/index.ts';
import { balKey } from '../src/engine/core.ts';
import { STAND_IN_POOL } from '../src/engine/curve.ts';
import { GENESIS, USDC, expectChainError, expectStage1Error, types } from './helpers.ts';
import { seriesOf } from './kit.ts';

/*
 * S4 cause codes on the pins that moved:
 *  - S4-BID: bid and order commitments are Stage 1's keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32) (S4 D11):
 *    the builders take no series, window or side, and the salt is 32 bytes.
 */

/*
 * Curve mode on Stage 1's lifecycle (S3 WP8). Figures are Stage 1's where Stage 1 has them: P0 and the fee split from
 * merces-common `curve.rs` tests and `solana/tests/fixtures/meteora/curve_config.json` (`expected`), the lifecycle from
 * `solana/tests/tests/curve_mode.rs` (CMT); the stand-in pool's own trade figures (the constant price, the PartialFill
 * charge) are ours and say so.
 *
 * S3 cause codes:
 *  - S3-CV: curve lifecycle on Stage 1: activation at creation (P0, Open), the stand-in pool, completion at the finish
 *    time, collection funds the treasury, no cancel, no registration at completion, the sealed-bid paths refused.
 *  - S3-UL: base lamports (unit scale 10^6).
 *  - S3-NC: no cap at any stage.
 */

const X = USDC(1000); // Stage 1's worked series: X = 1,000 USDC over 100 units (curve_config.json expected)
const SWAP_BASE = 100_000_000n;
const P0 = 10_000_000n; // merces-common curve.rs:120-131 `p0_of_the_worked_series`
const PARTNER_MIGRATION_FEE = 990_000_000n; // curve_config.json expected.partnerMigrationFee
const INITIAL_BASE_SUPPLY = 110_363_638n; // curve_config.json expected.initialBaseSupply

async function curveSeries() {
  const h = await SimHarness.create('solana', { genesis: GENESIS });
  const { seriesId } = await h.createCurve();
  const s = () => seriesOf(h.sim, seriesId);
  const units = (w: string) => h.sim.curveUnitsOf(seriesId, w);
  const usdc = (w: string) => h.sim.state.balances.get(balKey(w, h.sim.mintOf('USDC'))) ?? 0n;
  return { h, seriesId, s, units, usdc };
}

/** A wallet that is not on the allowlist, funded with USDC (Stage 1's buyer `d`, curve_mode.rs:102-110). */
async function stranger(h: SimHarness, label = 'curve-stranger'): Promise<SimWallet> {
  const w = new SimWallet(h.sim.family, label);
  await h.sim.fund(w.address, 'USDC', USDC(10_000));
  return w;
}

describe('curve mode (solana): activation', () => {
  // cause S3-CV, S3-UL: creation is the activation (Stage 1 activate_curve + mark_curve_activated): CurveActivated, then
  // RaiseOpened{0, 0} (curve.rs:824-830); was SeriesCreated, the toy curve's creation event and a Draft raise
  it('fixes P0 and the units sold at creation and opens the raise; the unit mint holds its whole supply', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const { terms } = defaultTerms(h.sim, { raiseStyle: 'curve', unitsOffered: '100', minimumRaise: X.toString() });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    expect(types(created.events)).toEqual(['SeriesCreated', 'CurveActivated', 'RaiseOpened']);
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    const c = seriesOf(h.sim, seriesId).curve!;
    expect(created.events[1]!.payload).toEqual({ seriesId, dbcConfig: c.dbcConfig, dbcPool: c.dbcPool, baseMint: c.baseMint, dbcCreator: h.issuer.address, unitsSold: SWAP_BASE.toString(), issuePrice: P0.toString() });
    expect(created.events[2]!.payload).toEqual({ seriesId, commitEndsAt: 0, revealEndsAt: 0 });
    const series = (await h.sim.getSeries(seriesId))!;
    expect(series).toMatchObject({ phase: 'Open', unitScale: '1000000', issuePrice: P0.toString(), unitsSold: SWAP_BASE.toString(), unitsOutstanding: '0', settledAt: null, mintFinalized: false });
    // the fixture's base supply: swap base 100,000,000 + migration base 363,637 + locked vesting 10,000,000 + leftover 1
    expect([c.swapBaseAmount, c.migrationBaseAmount, c.lockedVestingAmount, c.leftoverAmount, c.supply]).toEqual([SWAP_BASE, 363_637n, 10_000_000n, 1n, INITIAL_BASE_SUPPLY]);
    expect(h.sim.curveUnitsOf(seriesId, c.accounts.dbcBaseVault)).toBe(INITIAL_BASE_SUPPLY);
    const curve = (await h.sim.getCurve(seriesId))!;
    expect(curve).toMatchObject({ venue: 'simulator-stand-in', migrationQuoteThreshold: X.toString(), quoteReserve: '0', progressBps: 0, poolComplete: false, settled: false, issuePrice: P0.toString(), tradingFeeBps: 100, migrationFeePercentage: 99, baseSupply: INITIAL_BASE_SUPPLY.toString() });
    // the auction display passes a curve's Open raise through (no commit or reveal phase)
    expect((await h.sim.getAuction(seriesId))!.phase).toBe('Open');
  });

  // cause S3-CV: P0 = floor(X × 10^6 / swap base) below 1 is CurveThresholdMismatch (curve.rs:799-805)
  it('refuses a curve whose P0 rounds to 0 (CurveThresholdMismatch)', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    await expectStage1Error(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { raiseStyle: 'curve', unitsOffered: '100', minimumRaise: '99' }).terms }), 'CurveThresholdMismatch');
    // one base unit per 10^6 base lamports is still a P0 of 1
    const ok = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { raiseStyle: 'curve', unitsOffered: '100', minimumRaise: '100' }).terms });
    expect((ok.events[1]!.payload as { issuePrice: string }).issuePrice).toBe('1');
  });

  // cause S3-CV: the curve's r is per base lamport (Stage 1 registry lib.rs:594-600; B-C2): the harness's 10% share over
  // 100 units is 10^9 per base lamport, the r of Stage 1's report fixtures (gen-curve-zk-fixture.mjs)
  it('takes r per base lamport for a curve series', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    expect(defaultTerms(h.sim, { raiseStyle: 'curve', unitsOffered: '100' }).privateTerms.rWad).toBe(1_000_000_000n);
    expect(defaultTerms(h.sim, { unitsOffered: '100' }).privateTerms.rWad).toBe(1_000_000_000_000_000n);
  });
});

describe('curve mode (solana): the stand-in pool', () => {
  // cause S3-CV, S3-NC: anyone buys (Stage 1 has no allowlist on the curve, CMT:102-110) and nothing reaches the treasury
  // while the curve bonds; was allowlisted buys minting units and funding the treasury (TreasuryFunded)
  it('lets any wallet buy; the money stays in the pool, net of the 1% fee, and no Merces event is emitted', async () => {
    const { h, seriesId, s, units, usdc } = await curveSeries();
    const d = await stranger(h);
    const buy = await h.curveBuy(seriesId, d, USDC(400));
    expect(buy.events).toEqual([]);
    // the fee is ceil(1%) of the input (4 USDC): 20% Meteora's, 80% the partner's; the rest buys at P0 = X per swap base
    expect(units(d.address)).toBe(39_600_000n);
    expect(usdc(d.address)).toBe(USDC(10_000 - 400));
    const c = s().curve!;
    expect([c.quoteReserve, c.protocolQuoteFee, c.partnerQuoteFee]).toEqual([USDC(396), USDC(0.8), USDC(3.2)]);
    expect([s().treasuryTotal, s().tranches.length]).toEqual([0n, 0]);
    expect((await h.sim.getCurve(seriesId))!.progressBps).toBe(3960);
    // a wallet that is not approved can buy but never register (so never stake or earn)
    await expectStage1Error(h.exec(h.backers[0]!, { kind: 'registerHolder', seriesId, wallet: d.address }), 'NotAllowlisted');
  });

  // cause S3-NC: no cap at any stage (owner; Stage 1 stores 0): one wallet buys most of the curve
  it('has no wallet cap: one wallet buys 90% of the curve', async () => {
    const { h, seriesId, units } = await curveSeries();
    expect((await h.sim.getSeries(seriesId))!.terms.walletCapBps).toBe(0);
    await h.curveBuy(seriesId, h.backers[0]!, USDC(500));
    await h.curveBuy(seriesId, h.backers[0]!, USDC(409));
    expect(units(h.backers[0]!.address)).toBe(49_500_000n + 40_491_000n);
  });

  // cause S3-CV: the buy that reaches X fills partially (the stand-in's PartialFill, ours): it takes the rest of the swap
  // base and is charged the smallest input whose fee-free part is the quote still missing; the pool records its finish
  it("fills at exactly X on Stage 1's buys of 400, 350 and 300 USDC, and charges the last only what it uses", async () => {
    const { h, seriesId, s, units, usdc } = await curveSeries();
    const [a, b] = [h.backers[0]!, h.backers[1]!];
    const d = await stranger(h);
    await h.curveBuy(seriesId, a, USDC(400));
    await h.curveBuy(seriesId, b, USDC(350));
    expect(await h.sim.quoteCurveSwap(seriesId, 'buy', USDC(300).toString())).toEqual({ seriesId, side: 'buy', amountIn: USDC(300).toString(), amountUsed: '260101011', amountOut: '25750000', fee: '2601011', fillsCurve: true });
    await h.sim.advanceTime(3_600);
    const fillAt = await h.sim.now();
    await h.curveBuy(seriesId, d, USDC(300));
    // 257.5 USDC were missing: ceil(257.5 × 100 / 99) = 260.101011 USDC charged, 2.601011 of it the fee; 39.898989 untouched
    expect(usdc(d.address)).toBe(USDC(10_000) - 260_101_011n);
    expect([units(a.address), units(b.address), units(d.address)]).toEqual([39_600_000n, 34_650_000n, 25_750_000n]);
    const c = s().curve!;
    expect([c.quoteReserve, c.baseSold, c.finishTs]).toEqual([X, SWAP_BASE, fillAt]);
    // the buyers paid 1,010.101011 USDC and 10.101011 of it in fees, as Stage 1's proceeds memo derives for any curve that
    // nets X: V = ceil(X / (1 − 1%)), at most a lamport of rounding per swap (PROCEEDS_OPTIONS.md R4)
    expect(c.protocolQuoteFee + c.partnerQuoteFee).toBe(10_101_011n);
    expect(c.partnerQuoteFee).toBe(8_080_809n);
    expect(await h.sim.getCurve(seriesId)).toMatchObject({ poolComplete: true, progressBps: 10_000, finishCurveTimestamp: fillAt, settled: false });
    // a filled pool takes no more trades, either way (Meteora PoolIsCompleted)
    await expectChainError(h.curveBuy(seriesId, a, USDC(10)), 'WrongPhase');
    await expectChainError(h.curveSell(seriesId, a, 1_000_000n), 'WrongPhase');
    expect(s().treasuryTotal).toBe(0n);
  });

  // cause S3-CV: selling back into the curve is the only exit before it fills, at P0 less the 1% fee
  it('buys back units before the curve fills, less the fee', async () => {
    const { h, seriesId, s, units, usdc } = await curveSeries();
    const a = h.backers[0]!;
    await h.curveBuy(seriesId, a, USDC(400));
    const before = usdc(a.address);
    const sell = await h.curveSell(seriesId, a, 10_000_000n);
    expect(sell.events).toEqual([]);
    // 10 units at P0 = 100 USDC out of the reserve; the 1 USDC fee stays in the pool's fee buckets
    expect(usdc(a.address) - before).toBe(USDC(99));
    expect(units(a.address)).toBe(29_600_000n);
    const c = s().curve!;
    expect([c.quoteReserve, c.baseSold, c.protocolQuoteFee, c.partnerQuoteFee]).toEqual([USDC(296), 29_600_000n, USDC(0.8 + 0.2), USDC(3.2 + 0.8)]);
    // slippage, nothing to sell, more than the curve sold, a sealed-bid series
    await expectChainError(h.exec(a, { kind: 'curveSwap', seriesId, side: 'sell', amountIn: '1000000', minimumAmountOut: USDC(10).toString() }), 'InvalidTerms');
    await expectChainError(h.curveSell(seriesId, a, 0n), 'InvalidTerms');
    await expectChainError(h.curveSell(seriesId, a, 30_000_000n), 'InvalidTerms');
    await expectChainError(h.curveSell(seriesId, h.backers[1]!, 1_000_000n), 'InsufficientFunds');
    const { seriesId: sealed } = await h.runRaise({ settle: 'none' });
    await expectStage1Error(h.curveBuy(sealed, a, USDC(10)), 'NotCurveMode');
  });
});

describe('curve mode (solana): completion and proceeds', () => {
  async function filled() {
    const x = await curveSeries();
    const { h, seriesId } = x;
    for (const [i, amount] of [400, 350, 300].entries()) await x.h.curveBuy(seriesId, h.backers[i]!, USDC(amount));
    const finishTs = x.s().curve!.finishTs!;
    return { ...x, finishTs };
  }

  // cause S3-CV: Stage 1 complete_curve (curve.rs:861-906): CurveNotComplete before the pool filled; it settles at the
  // pool's finish time, not when it is called, takes no census and registers nobody (was: settled now, units
  // outstanding from the buys, every buyer registered, issue price raised / units)
  it('settles at the finish time with P0, takes no census and registers nobody', async () => {
    const { h, seriesId, s } = await curveSeries();
    await h.curveBuy(seriesId, h.backers[0]!, USDC(400));
    await expectStage1Error(h.sim.submit({ kind: 'completeCurve', seriesId }, 'keeper'), 'CurveNotComplete');
    for (const [i, amount] of [350, 300].entries()) await h.curveBuy(seriesId, h.backers[i + 1]!, USDC(amount));
    const finishTs = s().curve!.finishTs!;
    await h.sim.advanceTime(200 * 86_400); // completion comes late: the settlement time is still the finish time
    const done = await h.sim.submit({ kind: 'completeCurve', seriesId }, 'keeper');
    expect(types(done.events)).toEqual(['CurveGraduated', 'RaiseMintFinalized']);
    expect(done.events[0]!.payload).toEqual({ seriesId, issuePrice: P0.toString(), unitsSold: SWAP_BASE.toString(), settledAt: finishTs });
    expect(done.events[1]!.payload).toEqual({ seriesId, unitsSold: SWAP_BASE.toString(), proceeds: '0' });
    const series = (await h.sim.getSeries(seriesId))!;
    expect(series).toMatchObject({ phase: 'Settled', settledAt: finishTs, mintFinalized: true, unitsOutstanding: '0', issuePrice: P0.toString(), capPerUnit: capPerUnit(BigInt(series.terms.capMultipleWad), P0).toString(), lockupEndsAt: finishTs });
    expect(s().ledger.firstPeriod).toBe(pidAt(BigInt(finishTs)));
    expect([...s().positions.values()].filter((p) => p.registered)).toEqual([]);
    expect(h.sim.stage1View(seriesId).holders).toEqual({});
    await expectStage1Error(h.sim.submit({ kind: 'completeCurve', seriesId }, 'keeper'), 'RaiseNotOpen');
  });

  // cause S3-CV: Stage 1 collect_curve_proceeds (curve.rs:1112-1214; CMT:218-237): the treasury is 0 until the partner
  // migration fee arrives (990 USDC of X = 1,000, curve_config.json partnerMigrationFee), the partner trading fee goes to
  // the fee collector, the call is idempotent and the D4 schedule's first half is drawable at settlement
  it("funds the treasury with the partner migration fee, pays the trading fee to the fee collector and is idempotent", async () => {
    const { h, seriesId, s, usdc } = await filled();
    const feeCollector = h.sim.state.feeCollector;
    await h.sim.submit({ kind: 'completeCurve', seriesId }, 'keeper');
    expect(s().treasuryTotal).toBe(0n);
    const collect = await h.sim.submit({ kind: 'collectCurveProceeds', seriesId }, 'keeper');
    expect(types(collect.events)).toEqual(['CurveProceedsCollected', 'TreasuryFunded', 'FeeTaken']);
    expect(collect.events.map((e) => e.payload)).toEqual([
      { seriesId, migrationFee: PARTNER_MIGRATION_FEE.toString(), surplus: '0', tradingFee: '8080809', proceeds: PARTNER_MIGRATION_FEE.toString() },
      { seriesId, amount: PARTNER_MIGRATION_FEE.toString() },
      { seriesId, kind: 'curveTrading', amount: '8080809', payer: s().curve!.dbcPool },
    ]);
    expect(usdc(feeCollector)).toBe(8_080_809n);
    expect(s().treasuryTotal).toBe(PARTNER_MIGRATION_FEE);
    // idempotent: nothing more to collect, the proceeds unchanged
    const again = await h.sim.submit({ kind: 'collectCurveProceeds', seriesId }, 'keeper');
    expect(again.events.map((e) => [e.type, e.payload])).toEqual([['CurveProceedsCollected', { seriesId, migrationFee: '0', surplus: '0', tradingFee: '0', proceeds: PARTNER_MIGRATION_FEE.toString() }]]);
    // the release schedule's first tranche (50% at settlement) is drawable at once: 495 USDC (CMT:234-237)
    expect(s().tranches.map((t) => t.amount)).toEqual([495_000_000n, 247_500_000n, 247_500_000n]);
    const before = usdc(h.issuer.address);
    const draw = await h.exec(h.issuer, { kind: 'drawRelease', seriesId });
    expect(draw.events.find((e) => e.type === 'FundsReleased')!.payload).toMatchObject({ amount: '495000000', trancheIndex: 0 });
    expect(usdc(h.issuer.address) - before).toBe(495_000_000n);
    expect((await h.sim.getCurve(seriesId))!.collected).toEqual({ migrationFee: PARTNER_MIGRATION_FEE.toString(), surplus: '0', tradingFee: '8080809', proceeds: PARTNER_MIGRATION_FEE.toString() });
  });

  // cause S3-CV: the partner trading fee is collectable at any time, also on a curve that never fills (curve.rs:1179-1181);
  // the treasury of a curve that has not filled stays 0, and the proceeds may arrive before completeCurve
  it('collects the trading fee from a curve that has not filled, with nothing for the treasury', async () => {
    const { h, seriesId, s } = await curveSeries();
    await h.curveBuy(seriesId, h.backers[0]!, USDC(400));
    const early = await h.sim.submit({ kind: 'collectCurveProceeds', seriesId }, 'keeper');
    expect(early.events.map((e) => [e.type, e.payload])).toEqual([
      ['CurveProceedsCollected', { seriesId, migrationFee: '0', surplus: '0', tradingFee: '3200000', proceeds: '0' }],
      ['FeeTaken', { seriesId, kind: 'curveTrading', amount: '3200000', payer: s().curve!.dbcPool }],
    ]);
    expect([s().treasuryTotal, s().tranches.length]).toEqual([0n, 0]);
    for (const [i, amount] of [350, 300].entries()) await h.curveBuy(seriesId, h.backers[i + 1]!, USDC(amount));
    // filled, not yet completed: Stage 1 collects while the raise is still Open
    const collected = await h.sim.submit({ kind: 'collectCurveProceeds', seriesId }, 'keeper');
    expect(types(collected.events)).toEqual(['CurveProceedsCollected', 'TreasuryFunded', 'FeeTaken']);
    expect(s().phase).toBe('Open');
    expect(s().treasuryTotal).toBe(PARTNER_MIGRATION_FEE);
    await h.sim.submit({ kind: 'completeCurve', seriesId }, 'keeper');
    expect(s().phase).toBe('Settled');
  });

  // cause S3-CV: a surplus above X (DBC rounding; the stand-in fills at exactly X) pays the partner 80% of it, once
  // (PROCEEDS_OPTIONS.md R3). White-box: the reserve is seeded above X
  it('takes 80% of a surplus above X into the treasury, once', async () => {
    const { h, seriesId, s } = await filled();
    s().curve!.quoteReserve = X + 10n;
    const c = await h.sim.submit({ kind: 'collectCurveProceeds', seriesId }, 'keeper');
    expect(c.events[0]!.payload).toMatchObject({ migrationFee: PARTNER_MIGRATION_FEE.toString(), surplus: '8', proceeds: (PARTNER_MIGRATION_FEE + 8n).toString() });
    expect(STAND_IN_POOL.surplusSharePercent).toBe(80n);
    expect((await h.sim.submit({ kind: 'collectCurveProceeds', seriesId }, 'keeper')).events[0]!.payload).toMatchObject({ migrationFee: '0', surplus: '0' });
  });

  // cause S3-CV: an extinguishment needs a settled raise (Stage 1 exit.rs:229-236): an unfilled curve has nothing in its
  // treasury and cannot be extinguished (amendment M5)
  it('refuses to extinguish a curve before its completion', async () => {
    const { h, seriesId } = await curveSeries();
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    await h.curveBuy(seriesId, h.backers[0]!, USDC(400));
    await expectStage1Error(h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]), 'RaiseNotSettled');
  });

  it('refuses the curve commands on a sealed-bid series (NotCurveMode)', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    await expectStage1Error(h.sim.submit({ kind: 'completeCurve', seriesId }, 'keeper'), 'NotCurveMode');
    await expectStage1Error(h.sim.submit({ kind: 'collectCurveProceeds', seriesId }, 'keeper'), 'NotCurveMode');
    await expectStage1Error(h.sim.quoteCurveSwap(seriesId, 'buy', '1000000'), 'NotCurveMode');
  });
});

describe('curve mode (solana): the sealed-bid paths and the sealed-bid exits are closed', () => {
  // cause S3-CV (amendment M7): every sealed-bid step refuses a curve series first with NotSealedBid (Stage 1: raise.rs:194
  // and window.rs:119 by name, the auction steps on the missing auction account); was a cancellable curve, WrongPhase for
  // open and window, CommitPhaseClosed and SettlementNotReady for the auction steps
  it('refuses the raise, the auction steps, cancel and the window with NotSealedBid', async () => {
    const { h, seriesId } = await curveSeries();
    const b = h.backers[0]!;
    const salt = '0x' + '01'.repeat(32);
    // cause S4-BID: Stage 1's keccak commitment, over no series or window
    const commitment = bidCommitment({ bidder: b.address, pricePerUnit: P0, quantity: 1n, salt });
    const refusals: Promise<unknown>[] = [
      h.exec(h.issuer, { kind: 'openRaise', seriesId }),
      h.exec(h.issuer, { kind: 'cancelRaise', seriesId }),
      h.exec(b, { kind: 'commitBid', seriesId, commitment, deposit: USDC(20).toString() }),
      h.exec(b, { kind: 'revealBid', seriesId, pricePerUnit: P0.toString(), quantity: '1', salt }),
      h.sim.submit({ kind: 'beginSettlement', seriesId, clearingPrice: P0.toString(), qAboveClaim: '0', qAtClaim: '0' }, 'keeper'),
      h.sim.submit({ kind: 'tallyBids', seriesId }, 'keeper'),
      h.sim.submit({ kind: 'finalizeSettlement', seriesId }, 'keeper'),
      h.sim.submit({ kind: 'processBid', seriesId, bidder: b.address }, 'keeper'),
      h.sim.submit({ kind: 'deliverBid', seriesId, bidder: b.address }, 'keeper'),
      h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: GENESIS + 10_000_000, revealEndsAt: GENESIS + 20_000_000 }, 'keeper'),
    ];
    for (const r of refusals) await expectStage1Error(r, 'NotSealedBid');
    await h.fillCurve(seriesId);
    // still refused once settled (a curve has no auction, ever)
    await expectStage1Error(h.sim.submit({ kind: 'processBid', seriesId, bidder: b.address }, 'keeper'), 'NotSealedBid');
    await expectStage1Error(h.exec(h.issuer, { kind: 'cancelRaise', seriesId }), 'NotSealedBid');
  });

  // cause S3-CV: claim_redemption refuses a curve first (CurveUsesTender, claims.rs:342) and burn_retired too
  // (CurveModeNoBurn, claims.rs:252), a zero balance included
  it('refuses claimRedemption (CurveUsesTender) and burnRetired (CurveModeNoBurn)', async () => {
    const { h, seriesId } = await curveSeries();
    await h.fillCurve(seriesId);
    await h.exec(h.backers[0]!, { kind: 'registerHolder', seriesId, wallet: h.backers[0]!.address });
    await expectStage1Error(h.exec(h.backers[0]!, { kind: 'claimRedemption', seriesId }), 'CurveUsesTender');
    await expectStage1Error(h.sim.submit({ kind: 'burnRetired', seriesId, holder: h.backers[0]!.address }, 'keeper'), 'CurveModeNoBurn');
    await expectStage1Error(h.sim.submit({ kind: 'burnRetired', seriesId, holder: h.sim.address('wallet:nobody') }, 'keeper'), 'CurveModeNoBurn');
    // a registered holder with nothing staked claims nothing and burns nothing (only staked units earn, S3 WP10)
    const claim = await h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId });
    expect(claim.events.map((e) => [e.type, e.payload])).toEqual([['PayoutClaimed', { seriesId, holder: h.backers[0]!.address, amount: '0', burnedUnits: '0' }]]);
  });
});

describe('curve mode (solana): base lamports', () => {
  // cause S3-UL, M2: the unit mint's supply is conserved through trades and the stand-in's hooks (the migration, a locker
  // release, a DAMM trade), which move base lamports between the protocol's accounts and wallets as Stage 1's census
  // test mocks them (curve_mode.rs:708-766); supply − protocol-held is what wallets hold
  it('conserves the supply: wallets hold supply − protocol-held through trades, the migration, a locker release and a DAMM trade', async () => {
    const { h, seriesId, s, units } = await curveSeries();
    const d = await stranger(h);
    const wallets = [h.backers[0]!.address, h.backers[1]!.address, d.address, h.issuer.address];
    const c = () => s().curve!;
    const held = () => wallets.reduce((n, w) => n + units(w), 0n);
    const protocolHeld = () => [c().accounts.dbcBaseVault, c().accounts.dammBaseVault, c().accounts.lockerEscrow, c().accounts.leftoverReceiver].reduce((n, a) => n + units(a), 0n);
    const conserved = () => {
      expect(protocolHeld() + held() + units(c().accounts.stakeVault)).toBe(INITIAL_BASE_SUPPLY);
      expect(c().supply - protocolHeld()).toBe(held());
    };
    await h.curveBuy(seriesId, h.backers[0]!, USDC(400));
    await h.curveSell(seriesId, h.backers[0]!, 1_000_000n);
    conserved();
    await expect(h.sim.curveHook(seriesId, { kind: 'migrate' })).rejects.toThrow(/not filled/);
    await h.curveBuy(seriesId, h.backers[1]!, USDC(350));
    await h.curveBuy(seriesId, d, USDC(300));
    await h.completeAndCollect(seriesId);
    conserved();
    const n0 = held();
    expect(n0).toBe(SWAP_BASE);
    // the migration (Meteora keeps a protocol base fee of 7 in the DBC vault, as Stage 1's test mocks it): outstanding unchanged
    await h.sim.curveHook(seriesId, { kind: 'migrate', protocolBaseFee: 7n });
    expect([units(c().accounts.dbcBaseVault), units(c().accounts.lockerEscrow), units(c().accounts.leftoverReceiver), units(c().accounts.dammBaseVault)]).toEqual([7n, 10_000_000n, 1n, 363_637n - 7n]);
    conserved();
    expect(held()).toBe(n0);
    // the issuer claims 4 vested units from the locker: they become outstanding
    await h.sim.curveHook(seriesId, { kind: 'lockerRelease', to: h.issuer.address, units: 4_000_000n });
    conserved();
    expect(held()).toBe(n0 + 4_000_000n);
    // a trader buys units out of the DAMM pool: outstanding grows by exactly that
    await h.sim.curveHook(seriesId, { kind: 'dammTrade', wallet: d.address, units: 100_000n });
    conserved();
    expect(held()).toBe(n0 + 4_000_000n + 100_000n);
    await expect(h.sim.curveHook(seriesId, { kind: 'dammTrade', wallet: d.address, units: 1_000_000n })).rejects.toThrow(/fewer units/);
    conserved();
  });

  // cause S3-CV: the money moved is conserved: what buyers paid is the pool's reserve plus the fee buckets, and the
  // collection moves the partner's part into the treasury and to the fee collector
  it('conserves the stablecoin: buyers paid = reserve + fee buckets; collection moves the partner parts out', async () => {
    const { h, seriesId, s, usdc } = await curveSeries();
    const d = await stranger(h);
    const ws = [h.backers[0]!, h.backers[1]!, d];
    const start = ws.map((w) => usdc(w.address));
    for (const [i, amount] of [400, 350, 300].entries()) await h.curveBuy(seriesId, ws[i]!, USDC(amount));
    const paid = ws.reduce((n, w, i) => n + start[i]! - usdc(w.address), 0n);
    const c = s().curve!;
    expect(paid).toBe(c.quoteReserve + c.protocolQuoteFee + c.partnerQuoteFee);
    await h.completeAndCollect(seriesId);
    expect(s().treasuryTotal + usdc(h.sim.state.feeCollector)).toBe(PARTNER_MIGRATION_FEE + 8_080_809n);
  });
});
