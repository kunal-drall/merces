import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { CURVE_NO_CAP, perWholeUnit, type UnsignedTx } from '@merces/domain';
import { WAD, capRemainingScaled, parsePeriod, scaledAmount } from '@merces/math';
import { SimWallet, type PrivateTerms, type SimHarness } from '@merces/simulator';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const SCALE = 1_000_000n;

/*
 * Curve staking as a first-class flow through the API (S3 WP12; amendments M4 and M8; owner direction of 2026-10-10):
 * buy through build-swap, the keepers' completion, the wallet's curve position read, staking in steps (registration,
 * census), the stake builder held by an assembled report (amendment H1), a report paid to stakes only, unstake and claim
 * in ONE transaction, tender at a redemption, and every per-unit read at the series' unit scale. On Stage 1's worked
 * series (curve_mode.rs: 100 units, X = 1,000 USDC, P0 = 10 USDC; buys of 400, 350 and 300 USDC by `a` and `b`,
 * allowlisted, and `c`, not); every amount is the chain's own read or Stage 1's arithmetic on it.
 *
 * S3 cause codes:
 *  - S3-ST: staking, unstake, tender and stake-weighted claims;
 *  - S3-SW: build-swap and the statements before a buy (owner direction of 2026-10-10);
 *  - S3-UL: base lamports: per-unit reads are per whole unit at the series' unit scale (was: per base lamport on a curve,
 *    `paidPerUnitWad / WAD`, and cost bases and cap totals 10^6 times too large);
 *  - S3R-Y (S3 review fix 2): a curve holding's realised yield is on what the wallet has held, its stake, its wallet
 *    units and its tendered units (was: on its stake, the indexed `units`, so an unstake moved it and a wallet that
 *    unstaked everything read 0);
 *  - S3R-N (S3 review fix 3): every curve read and builder carries no cap and the buyer notice with the curve's figures,
 *    the position read and the stake, unstake, tender and census builders included (was: only the curve read, the
 *    configure step, the quote and build-swap); the tests walk every curve route of the OpenAPI document.
 */
describe.skipIf(!dbTestsEnabled())('curve staking through the API (S3 WP12)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  let h: SimHarness;
  let seriesId: string;
  let privateTerms: PrivateTerms;
  let termsCommitment: string;
  let a: SimWallet;
  let b: SimWallet;
  let c: SimWallet;
  let aTok: string;
  let bTok: string;
  let cTok: string;
  let issuerTok: string;
  let adminTok: string;

  beforeAll(async () => {
    rig = await makeRig();
    h = rig.sol;
    const created = await h.createCurve();
    seriesId = created.seriesId;
    privateTerms = created.privateTerms;
    termsCommitment = created.terms.termsCommitment;
    [a, b, c] = h.backers as [SimWallet, SimWallet, SimWallet];
    await h.sim.submit({ kind: 'setAllowlist', wallet: c.address, allowed: false }, 'allowlistManager');
    aTok = await rig.grant({ accountId: 'stk-a', wallets: [{ chain: h.sim.chain, address: a.address }], roles: ['backer'] });
    bTok = await rig.grant({ accountId: 'stk-b', wallets: [{ chain: h.sim.chain, address: b.address }], roles: ['backer'] });
    cTok = await rig.grant({ accountId: 'stk-c', wallets: [{ chain: h.sim.chain, address: c.address }], roles: ['backer'] });
    issuerTok = rig.token({ accountId: 'stk-iss', wallets: [{ chain: h.sim.chain, address: h.issuer.address }], roles: ['issuer'] });
    adminTok = rig.token({ accountId: 'stk-adm', roles: ['admin'], wallets: [] });
    await rig.sync();
  });
  afterAll(async () => {
    await rig.close();
  });

  const send = async (tx: UnsignedTx, who: SimWallet, tok: string) => {
    const r = await rig.post('/tx/send', await who.sign(tx), tok);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { txId: string; events: { type: string; payload: Record<string, unknown> }[] };
  };
  const buy = async (w: SimWallet, tok: string, amountIn: bigint) => {
    const q = await rig.get(`/series/${seriesId}/curve/quote?wallet=${w.address}&side=buy&amountIn=${amountIn}`, tok);
    expect(q.statusCode, q.body).toBe(200);
    const r = await rig.post(`/series/${seriesId}/curve/build-swap`, { wallet: w.address, side: 'buy', amountIn: amountIn.toString(), acknowledged: true, beforeYouBuyVersion: q.json().beforeYouBuy.version }, tok);
    expect(r.statusCode, r.body).toBe(200);
    await send(r.json().tx, w, tok);
    return r.json();
  };
  const positionOf = async (w: SimWallet, tok: string) => {
    const r = await rig.get(`/series/${seriesId}/curve/position?wallet=${w.address}`, tok);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().positions[0];
  };
  const usdc = async (w: SimWallet) => BigInt(await h.sim.getBalance(w.address, 'USDC'));
  /**
   * cause S3R-N: a curve route's 200 carries no cap and the buyer notice, the one `GET /series/{id}/curve` renders from
   * the curve's figures (its trading fee and that fee's split from the pool's config); `route` names it in `walked`
   */
  const walked = new Set<string>();
  const noCapOn = async (route: string, body: Record<string, unknown>) => {
    const notice = (await rig.get(`/series/${seriesId}/curve`)).json().notice as string;
    expect(notice, route).toContain('Every trade pays a trading fee (1%): 80% of it goes to Merces, 20% to Meteora and 0% to the issuer.');
    expect(body, route).toMatchObject({ walletCap: null, noCap: true, noCapStatement: CURVE_NO_CAP, notice });
    walked.add(route);
  };
  const units = (w: SimWallet) => h.sim.curveUnitsOf(seriesId, w.address);
  /** The device's assembled report (the harness proves with mock proofs; the rig accepts them). */
  async function device(periodId: string, incomeYtdNow: bigint) {
    const { command } = await h.buildReport({ seriesId, periodId, privateTerms, termsCommitment, incomeYtdNow });
    return { periodId, tier: 2, source: 'stripe', paymentStable: command.paymentStable, priorIncomeCommitment: command.priorIncomeCommitment, incomeCommitment: command.incomeCommitment, proof: command.proof, attestation: command.attestation };
  }

  // cause S3-ST / S3-SW (amendment M8): the curve position read says where each linked wallet stands while the curve
  // still sells: an approved wallet can stake through the builder's registration and census steps; one not approved
  // earns nothing and can only sell
  it('buys through build-swap; the position read shows units, what can be staked and what stops it', async () => {
    // cause S3R-N: the curve read, the configure step and the quote carry no cap and the notice (as build-swap, below)
    await noCapOn('/series/{seriesId}/curve', (await rig.get(`/series/${seriesId}/curve`)).json());
    const configured = await rig.post(`/series/${seriesId}/curve/configure`, {}, issuerTok);
    expect(configured.statusCode, configured.body).toBe(200);
    await noCapOn('/series/{seriesId}/curve/configure', configured.json());
    await noCapOn('/series/{seriesId}/curve/quote', (await rig.get(`/series/${seriesId}/curve/quote?wallet=${a.address}&side=buy&amountIn=${USDC(400)}`, aTok)).json());
    const boughtA = await buy(a, aTok, USDC(400));
    expect(boughtA).toMatchObject({ earns: true, warning: null, quote: { amountOut: '39600000' } });
    await noCapOn('/series/{seriesId}/curve/build-swap', boughtA);
    await buy(b, bTok, USDC(350));
    // a wallet not approved buys too, warned it earns nothing; its buy fills the curve (the stand-in's partial fill)
    const boughtC = await buy(c, cTok, USDC(300));
    expect(boughtC).toMatchObject({ earns: false, quote: { fillsCurve: true } });
    expect(boughtC.warning).toMatch(/cannot register or stake/);
    expect([units(a), units(b), units(c)]).toEqual([39_600_000n, 34_650_000n, 25_750_000n]);

    // before any census, an approved buyer can stake its whole wallet: the builder registers it and takes a census first
    const pa = await positionOf(a, aTok);
    expect(pa).toEqual({
      wallet: a.address, approved: true, registered: false, walletUnits: '39600000', stakedUnits: '0', earning: false, pending: '0', claimable: '0',
      stakable: '39600000', stakeBlockedBy: null, censusHeldBy: null, stakeSteps: ['registerHolder', 'syncCurveUnits'], unstakable: '0', tender: null, next: 'register-and-stake',
    });
    // not approved: it holds units that never earn, and approval is its next step
    expect(await positionOf(c, cTok)).toMatchObject({ approved: false, registered: false, walletUnits: '25750000', earning: false, stakable: '0', stakeBlockedBy: 'NotAllowlisted', stakeSteps: [], next: 'approve-wallet' });
    // every linked wallet on the series' chain without `wallet`; a wallet not linked is refused; an account with none reads none
    const all = await rig.get(`/series/${seriesId}/curve/position`, aTok);
    expect(all.json()).toMatchObject({ seriesId, unitScale: '1000000', phase: 'Open', redeemed: false });
    // cause S3R-N: the position read carries no cap and the notice, as every curve read (was neither)
    await noCapOn('/series/{seriesId}/curve/position', all.json());
    expect(all.json().positions.map((p: { wallet: string }) => p.wallet)).toEqual([a.address]);
    expect((await rig.get(`/series/${seriesId}/curve/position?wallet=${b.address}`, aTok)).statusCode).toBe(403);
    expect((await rig.get(`/series/${seriesId}/curve/position`, rig.token({ accountId: 'nobody', wallets: [] }))).json().positions).toEqual([]);
    expect((await rig.get(`/series/${seriesId}/curve/position`)).statusCode).toBe(401);
    // a sealed-bid series has no curve position
    const sealed = await h.runRaise({ bids: [{ backer: 0, price: 12_000_000n, qty: 100n }], settle: 'none' });
    expect((await rig.get(`/series/${sealed.seriesId}/curve/position`, aTok)).json()).toMatchObject({ detail: { stage1: 'NotCurveMode' } });
  });

  // cause S3-ST: the keepers complete the curve; staking in Stage 1's order, the steps it needs, and the holder access
  // its first stake grants (A-REV-10)
  it('stakes in steps (registration, census, stake); refuses in Stage 1 order; the first stake grants holder access', async () => {
    expect((await rig.post('/admin/curves/monitor', {}, adminTok)).json()).toMatchObject({ completed: [seriesId], collected: [seriesId] });
    await h.sim.curveHook(seriesId, { kind: 'migrate' });
    // refusals before any step is built
    expect((await rig.post(`/series/${seriesId}/curve/build-stake`, { wallet: a.address, units: '0' }, aTok)).json()).toMatchObject({ detail: { stage1: 'ZeroUnits' } });
    const notApproved = await rig.post(`/series/${seriesId}/curve/build-stake`, { wallet: c.address, units: '1' }, cTok);
    expect(notApproved.statusCode).toBe(403);
    expect(notApproved.json()).toMatchObject({ detail: { stage1: 'NotAllowlisted' } });
    expect((await rig.post(`/series/${seriesId}/curve/build-stake`, { wallet: a.address, units: '1' }, bTok)).statusCode).toBe(403);
    const short = await rig.post(`/series/${seriesId}/curve/build-stake`, { wallet: a.address, units: '39600001' }, aTok);
    expect(short.statusCode).toBe(409);
    expect(short.json()).toMatchObject({ detail: { code: 'InsufficientFunds', walletUnits: '39600000' } });
    // a: registration, the census (none taken yet), then the stake, each signed in turn
    const built = await rig.post(`/series/${seriesId}/curve/build-stake`, { wallet: a.address, units: '39600000' }, aTok);
    expect(built.statusCode, built.body).toBe(200);
    expect(built.json()).toMatchObject({ units: '39600000', stakedAfter: '39600000' });
    await noCapOn('/series/{seriesId}/curve/build-stake', built.json()); // cause S3R-N (was neither)
    expect(built.json().steps.map((s: { step: string; tx: UnsignedTx }) => [s.step, s.tx.command.kind])).toEqual([['registerHolder', 'registerHolder'], ['syncCurveUnits', 'syncCurveUnits'], ['stakeUnits', 'stakeUnits']]);
    for (const s of built.json().steps) await send(s.tx, a, aTok);
    // no holder access before the stake is indexed; then the series' holder reads open
    await rig.sync();
    expect((await rig.get(`/series/${seriesId}/position`, aTok)).json().positions[0]).toMatchObject({ registered: true, stakedUnits: '39600000', walletUnits: '0' });
    expect(await positionOf(a, aTok)).toMatchObject({ registered: true, walletUnits: '0', stakedUnits: '39600000', earning: true, stakable: '0', stakeBlockedBy: 'ZeroUnits', unstakable: '39600000', next: null });
    // b: registered by its first step; the census covers it, so no census step
    const bStake = await rig.post(`/series/${seriesId}/curve/build-stake`, { wallet: b.address, units: '20000000' }, bTok);
    expect(bStake.json().steps.map((s: { step: string }) => s.step)).toEqual(['registerHolder', 'stakeUnits']);
    for (const s of bStake.json().steps) await send(s.tx, b, bTok);
    // the series read carries the stakes and the census time (S3 WP12)
    await rig.sync();
    const series = (await rig.get(`/series/${seriesId}`)).json();
    expect(series).toMatchObject({ unitScale: '1000000', stakedTotal: '59600000', tenderedTotal: '0', unitsOutstanding: '100000000' });
    expect(typeof series.unitsSyncedAt).toBe('number');
  });

  // cause S3-ST (amendment H1): the stake builder never takes a census while the issuer has an assembled, unsubmitted
  // report for the next expected period; it stakes within the stored census, and adds the census once the report is sent
  it('holds the census step while an assembled report waits; stakes what the stored census covers', async () => {
    // c parks its units in the DAMM pool (protocol-held), then the keepers' census after the quarter counts the rest
    await h.sim.curveHook(seriesId, { kind: 'dammTrade', wallet: c.address, units: -25_750_000n });
    await h.sim.setTime(parsePeriod('2026Q1').end + 3_600);
    await h.syncCurve(seriesId);
    const stored = BigInt((await h.sim.getSeries(seriesId))!.unitsOutstanding);
    expect(stored).toBe(74_250_000n);
    const assembled = await rig.post(`/series/${seriesId}/reports`, await device('2026Q1', USDC(70_000)), issuerTok);
    expect(assembled.statusCode, assembled.body).toBe(201);
    // the issuer's vested units reach b: a census now would count them, the stored one does not
    await h.sim.curveHook(seriesId, { kind: 'lockerRelease', to: b.address, units: SCALE });
    expect(units(b)).toBe(15_650_000n);
    const room = stored - 59_600_000n;
    expect(await positionOf(b, bTok)).toMatchObject({ walletUnits: '15650000', stakable: room.toString(), stakeBlockedBy: null, censusHeldBy: { periodId: '2026Q1' }, stakeSteps: [] });
    const held = await rig.post(`/series/${seriesId}/curve/build-stake`, { wallet: b.address, units: '15650000' }, bTok);
    expect(held.statusCode).toBe(409);
    expect(held.json().detail).toEqual({ stage1: 'StakeExceedsOutstanding', reason: 'report-pending', periodId: '2026Q1', stakable: room.toString() });
    // the report is submitted and paid; the census step is open again
    const submit = await rig.post(`/reports/${assembled.json().reportId}/build-submit`, {}, issuerTok);
    expect(submit.statusCode, submit.body).toBe(200);
    const accepted = await send(submit.json().tx, h.issuer, issuerTok);
    await rig.post(`/reports/${assembled.json().reportId}/submitted`, { txId: accepted.txId }, issuerTok);
    const pay = await rig.post(`/reports/${assembled.json().reportId}/build-payin`, {}, issuerTok);
    await send(pay.json().tx, h.issuer, issuerTok);
    // cause S3R-N: the census builder carries no cap and the notice, as every curve builder (was neither)
    const census = await rig.post(`/series/${seriesId}/curve/build-sync`, { signer: b.address }, bTok);
    expect(census.statusCode, census.body).toBe(200);
    await noCapOn('/series/{seriesId}/curve/build-sync', census.json());
    const open = await rig.post(`/series/${seriesId}/curve/build-stake`, { wallet: b.address, units: '15650000' }, bTok);
    expect(open.statusCode, open.body).toBe(200);
    expect(open.json().steps.map((s: { step: string }) => s.step)).toEqual(['syncCurveUnits', 'stakeUnits']);
    for (const s of open.json().steps) await send(s.tx, b, bTok);
    expect((await h.sim.getPosition(seriesId, b.address))!.stakedUnits).toBe('35650000');
  });

  // cause S3-ST (owner direction of 2026-10-10): unstaking pays in the product: ONE transaction, all or nothing, whose
  // claim pays exactly the pending payout the unstake credited
  it('unstakes and claims in one transaction; the claim pays exactly what the stake earned', async () => {
    const before = (await h.sim.getPosition(seriesId, a.address))!;
    expect(BigInt(before.claimable) > 0n).toBe(true);
    // refusals: zero, more than the stake, a wallet not linked; the tender waits for a redemption
    expect((await rig.post(`/series/${seriesId}/curve/build-unstake`, { wallet: a.address, units: '0' }, aTok)).json()).toMatchObject({ detail: { stage1: 'ZeroUnits' } });
    expect((await rig.post(`/series/${seriesId}/curve/build-unstake`, { wallet: a.address, units: '39600001' }, aTok)).json()).toMatchObject({ detail: { stage1: 'InsufficientStake', stakedUnits: '39600000' } });
    expect((await rig.post(`/series/${seriesId}/curve/build-unstake`, { wallet: a.address, units: '1' }, bTok)).statusCode).toBe(403);
    expect((await rig.post(`/series/${seriesId}/curve/build-tender`, { wallet: a.address, fromStake: '1' }, aTok)).json()).toMatchObject({ detail: { stage1: 'NotRedeemed' } });
    const built = await rig.post(`/series/${seriesId}/curve/build-unstake`, { wallet: a.address, units: '19800000' }, aTok);
    expect(built.statusCode, built.body).toBe(200);
    expect(built.json()).toMatchObject({ units: '19800000', commands: ['unstakeUnits', 'claimPayout'], payout: before.claimable, stakedAfter: '19800000' });
    await noCapOn('/series/{seriesId}/curve/build-unstake', built.json()); // cause S3R-N (was neither)
    const tx = built.json().tx as UnsignedTx;
    expect(tx.commands).toEqual([{ kind: 'unstakeUnits', seriesId, units: '19800000' }, { kind: 'claimPayout', seriesId }]);
    const u0 = await usdc(a);
    const sent = await send(tx, a, aTok);
    expect(sent.events.map((e) => e.type)).toEqual(['UnitsUnstaked', 'PayoutClaimed']);
    expect(sent.events[1]!.payload).toMatchObject({ holder: a.address, amount: before.claimable, burnedUnits: '0' });
    expect((await usdc(a)) - u0).toBe(BigInt(before.claimable));
    expect(await positionOf(a, aTok)).toMatchObject({ walletUnits: '19800000', stakedUnits: '19800000', pending: '0', claimable: '0', earning: true, stakable: '19800000', stakeSteps: [], next: 'stake' });
  });

  // cause S3-UL (amendment M4): every per-unit read is per whole unit at the series' unit scale
  it('reads per-unit figures per whole unit: holdings, retirement and the accounting statement', async () => {
    await rig.sync();
    const s = (await h.sim.getSeries(seriesId))!;
    const paidWad = BigInt(s.paidPerUnitWad);
    const perWhole = (paidWad * SCALE) / WAD;
    expect(perWhole > 0n).toBe(true);
    expect(perWholeUnit(paidWad, SCALE)).toBe(perWhole);
    // holdings: the unit scale, the stake and the wallet units, gross paid per whole unit, a cost basis per whole unit
    const holding = (await rig.get('/me/holdings', aTok)).json().holdings.find((x: { seriesId: string }) => x.seriesId === seriesId);
    expect(holding).toMatchObject({ raiseStyle: 'curve', unitScale: '1000000', stakedUnits: '19800000', walletUnits: '19800000', grossPaidPerUnit: perWhole.toString(), issuePrice: '10000000' });
    // cause S3R-Y: the yield is on the 39.6 units a holds, 19.8 staked and 19.8 in its wallet, at P0 = 10 USDC: 396 USDC,
    // of which it has claimed 376.2 USDC, 9,500 bps (was: on its 19.8-unit stake, the indexed units, 19,000 bps)
    expect(holding).toMatchObject({ units: '19800000', burnedUnits: '0', claimedTotal: '376200000', realisedYieldBps: 9_500 });
    const costBasis = (10_000_000n * (BigInt(holding.stakedUnits) + BigInt(holding.walletUnits) + BigInt(holding.burnedUnits))) / SCALE;
    expect(costBasis).toBe(USDC(396));
    expect(holding.realisedYieldBps).toBe(Number((BigInt(holding.claimedTotal) * 10_000n) / costBasis));
    // retirement: paid per whole unit and Stage 1's C_remaining at the unit scale
    const cap = BigInt(s.capPerUnit!);
    const retirement = (await rig.get(`/series/${seriesId}/retirement`)).json();
    expect(retirement).toMatchObject({ unitScale: '1000000', paidPerUnit: perWhole.toString(), capRemaining: capRemainingScaled(cap, paidWad, SCALE).toString(), capProgressBps: Number((perWhole * 10_000n) / cap), burnable: false });
    // the accounting statement: the cap total over whole units, the remaining total too
    const st = (await rig.get(`/admin/accounting/series/${seriesId}`, adminTok)).json().cap;
    const remaining = capRemainingScaled(cap, paidWad, SCALE);
    expect(st).toMatchObject({
      unitScale: '1000000', perUnit: cap.toString(), unitsSold: '100000000', total: (cap * 100n).toString(), paidPerUnit: perWhole.toString(), remainingPerUnit: remaining.toString(),
      remainingTotal: ((remaining * BigInt(st.unitsOutstanding)) / SCALE).toString(), progressBps: Number((paidWad * SCALE * 10_000n) / (cap * WAD)),
    });
  });

  // cause S3R-Y (S3 review fix 2): unstaking moves no unit out of the holding, so it leaves the cost basis where it is.
  // b holds 35.65 units, all staked, and has claimed nothing; it unstakes them all through the builder, whose bundled
  // claim pays its pending payout (was: the cost basis fell to 0 with the stake, so its yield read 0 once it was paid)
  it('a curve holding\'s yield is on what the wallet holds: an unstake leaves the cost basis where it is', async () => {
    const holdingOf = async () => {
      await rig.sync();
      return (await rig.get('/me/holdings', bTok)).json().holdings.find((x: { seriesId: string }) => x.seriesId === seriesId) as Record<string, string | number>;
    };
    const basis = USDC(356.5); // 35.65 units at P0 = 10 USDC
    const before = await holdingOf();
    expect(before).toMatchObject({ units: '35650000', stakedUnits: '35650000', walletUnits: '0', burnedUnits: '0', claimedTotal: '0', realisedYieldBps: 0 });
    const pending = BigInt((await h.sim.getPosition(seriesId, b.address))!.claimable);
    expect(pending > 0n).toBe(true);
    const built = await rig.post(`/series/${seriesId}/curve/build-unstake`, { wallet: b.address, units: '35650000' }, bTok);
    expect(built.statusCode, built.body).toBe(200);
    expect(built.json()).toMatchObject({ commands: ['unstakeUnits', 'claimPayout'], payout: pending.toString(), stakedAfter: '0' });
    await send(built.json().tx, b, bTok);
    const after = await holdingOf();
    // the stake (the indexed units) is 0 and every unit is in the wallet; the yield is the payout over the 35.65 units
    expect(after).toMatchObject({ units: '0', stakedUnits: '0', walletUnits: '35650000', burnedUnits: '0', claimedTotal: pending.toString() });
    expect(after.realisedYieldBps).toBe(Number((pending * 10_000n) / basis));
    expect(after.realisedYieldBps).toBeGreaterThan(0);
  });

  // cause S3-ST: a curve redeems by tender; the builder previews the principal, the pending payout and the quota, and
  // refuses in Stage 1's order; stakes close at the redemption; the tail read is per whole unit (S3-UL)
  it('tenders at the redemption: previews principal, payout and quota; refuses in Stage 1 order; the tail per whole unit', async () => {
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    const s = (await h.sim.getSeries(seriesId))!;
    const r = s.redemption!;
    // stakes are closed; the position read shows each wallet's tender
    expect((await rig.post(`/series/${seriesId}/curve/build-stake`, { wallet: a.address, units: '1' }, aTok)).json()).toMatchObject({ detail: { stage1: 'TerminalStatus' } });
    const quotaLeft = BigInt(r.unitsAtRedemption) - BigInt(s.tenderedTotal) - BigInt(s.stakedTotal);
    const pa = await positionOf(a, aTok);
    expect(pa).toMatchObject({ stakeBlockedBy: 'TerminalStatus', stakable: '0', next: 'tender' });
    expect(pa.tender).toEqual({ fromStake: '19800000', fromWallet: '19800000', quotaLeft: quotaLeft.toString(), pricePerUnit: r.pricePerUnit, principal: scaledAmount(BigInt(r.pricePerUnit), 39_600_000n, SCALE).toString(), blockedBy: null });
    // c buys units back from the DAMM pool: never registered, it cannot tender (registering needs approval)
    await h.sim.curveHook(seriesId, { kind: 'dammTrade', wallet: c.address, units: SCALE });
    expect(await positionOf(c, cTok)).toMatchObject({ registered: false, tender: { fromWallet: '1000000', blockedBy: 'HolderNotRegistered' }, next: 'approve-wallet' });
    expect((await rig.post(`/series/${seriesId}/curve/build-tender`, { wallet: c.address, fromWallet: '1000000' }, cTok)).json()).toMatchObject({ detail: { stage1: 'HolderNotRegistered' } });
    // a's refusals in Stage 1's order
    expect((await rig.post(`/series/${seriesId}/curve/build-tender`, { wallet: a.address }, aTok)).json()).toMatchObject({ detail: { stage1: 'ZeroUnits' } });
    expect((await rig.post(`/series/${seriesId}/curve/build-tender`, { wallet: a.address, fromStake: '19800001' }, aTok)).json()).toMatchObject({ detail: { stage1: 'InsufficientStake' } });
    expect((await rig.post(`/series/${seriesId}/curve/build-tender`, { wallet: a.address, fromWallet: (quotaLeft + 1n).toString() }, aTok)).json()).toMatchObject({ detail: { stage1: 'TenderQuotaExhausted', quotaLeft: quotaLeft.toString() } });
    // the tender of the stake and the wallet: principal at the redemption price per whole unit, plus the pending payout
    const claimable = BigInt((await h.sim.getPosition(seriesId, a.address))!.claimable);
    const built = await rig.post(`/series/${seriesId}/curve/build-tender`, { wallet: a.address, fromStake: '19800000', fromWallet: '19800000' }, aTok);
    expect(built.statusCode, built.body).toBe(200);
    const principal = scaledAmount(BigInt(r.pricePerUnit), 39_600_000n, SCALE);
    expect(built.json()).toMatchObject({ units: '39600000', pricePerUnit: r.pricePerUnit, principal: principal.toString(), payout: claimable.toString(), total: (principal + claimable).toString(), quotaLeft: quotaLeft.toString(), quotaLeftAfter: (quotaLeft - 19_800_000n).toString() });
    await noCapOn('/series/{seriesId}/curve/build-tender', built.json()); // cause S3R-N (was neither)
    const u0 = await usdc(a);
    const sent = await send(built.json().tx, a, aTok);
    expect(sent.events.map((e) => e.type)).toEqual([...(claimable > 0n ? ['PayoutClaimed'] : []), 'UnitsBurned', 'RedemptionClaimed']);
    expect((await usdc(a)) - u0).toBe(principal + claimable);
    expect(await positionOf(a, aTok)).toMatchObject({ walletUnits: '0', stakedUnits: '0', tender: { fromStake: '0', fromWallet: '0' }, next: null });

    // a tail report (a liquidity event) pays the tail; the redemption read gives it per whole unit
    await h.sim.setTime(parsePeriod('2026Q2').end + 3_600);
    await h.reportAndPay(seriesId, '2026Q2', privateTerms, termsCommitment, 0n, USDC(90_000), { liquidityEvent: true });
    await rig.sync();
    const red = (await rig.get(`/series/${seriesId}/redemption`, aTok)).json();
    const tailWad = BigInt(red.redemption.tailPaidPerUnitWad);
    expect(tailWad > 0n).toBe(true);
    expect(red.tail).toMatchObject({ paidPerUnitWad: tailWad.toString(), paidPerUnit: ((tailWad * SCALE) / WAD).toString() });
    expect(BigInt(red.tail.paidPerUnit) > tailWad / WAD).toBe(true);
    expect(red.tail.payouts).toHaveLength(1);
  });

  // cause S3R-N: every curve route of the OpenAPI document was walked above, each carrying no cap and the notice
  it('every curve read and builder carries no cap and the buyer notice: the walk covers every curve route of the OpenAPI document', () => {
    const doc = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');
    const routes = [...doc.matchAll(/^ {2}(\/series\/\{seriesId\}\/curve[^:]*):$/gm)].map((m) => m[1]!);
    expect(routes).toHaveLength(9);
    expect([...walked].sort()).toEqual(routes.sort());
  });
});
