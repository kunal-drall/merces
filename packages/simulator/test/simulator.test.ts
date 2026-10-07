import { describe, expect, it } from 'vitest';
import { ChainError, bidCommitment, orderCommitment, termsCommitment, type DomainEvent } from '@merces/domain';
import { WAD, parsePeriod, ratePerUnit, wadFromDecimal } from '@merces/math';
import { SimHarness, SimulatorChain, defaultTerms, type Personality } from '../src/index.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const types = (evs: DomainEvent[]) => evs.map((e) => e.type);
const GENESIS = Date.UTC(2026, 0, 1) / 1000;

async function expectChainError(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ChainError && e.code === code, `expected ChainError ${code}`);
}

for (const personality of ['solana', 'monad'] as Personality[]) {
  describe(`simulator (${personality}) full raise-to-payout cycle`, () => {
    it('runs auction → treasury → reports → payouts → claims with correct money', async () => {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      const { seriesId, terms, privateTerms } = await h.runRaise();
      const series = (await h.sim.getSeries(seriesId))!;
      // 5 bids of 100 units at 12,11,10,10,9 for 500 units offered (harness wallet cap 20% = 100): all fill, clearing at 9
      expect(series.phase).toBe('Settled');
      expect(series.issuePrice).toBe(USDC(9).toString());
      expect(series.unitsOutstanding).toBe('500');
      expect(series.capPerUnit).toBe(USDC(22.5).toString());
      const treasury = (await h.sim.getTreasury(seriesId))!;
      expect(treasury.total).toBe(USDC(4500).toString());
      // auction fee 1% of 4500 = 45 at the fee collector
      expect(await h.sim.getBalance(h.sim.state.feeCollector, 'USDC')).toBe(USDC(45).toString());
      // winners get their excess deposit back
      const bid0 = (await h.sim.getBid(seriesId, h.backers[0]!.address))!;
      expect(bid0.allocatedUnits).toBe('100');
      await h.exec(h.backers[0]!, { kind: 'claimRefund', seriesId });
      const bal0 = BigInt(await h.sim.getBalance(h.backers[0]!.address, 'USDC'));
      expect(bal0).toBe(1_000_000_000_000n - USDC(900) - USDC(9));

      // treasury release: tranche 0 drawable immediately, no approval needed (C11.1)
      const drew = await h.exec(h.issuer, { kind: 'drawRelease', seriesId });
      expect(types(drew.events)).toEqual(['FundsReleased']);
      expect((await h.sim.getTreasury(seriesId))!.released).toBe(USDC(2250).toString());
      await expectChainError(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'TooEarly');

      // Q1 2026: income 25k YTD → zero payment is a complete report
      await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
      const q1 = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(25_000));
      expect(q1.due).toBe(0n);
      expect((await h.sim.getPeriod(seriesId, '2026Q1'))!.settled).toBe(true);
      await expectChainError(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'TooEarly'); // 90-day tranche not yet due on 2 April

      // Q2: 50k YTD, still below threshold
      await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
      const q2 = await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(25_000), USDC(50_000));
      expect(q2.due).toBe(0n);
      const drew2 = await h.exec(h.issuer, { kind: 'drawRelease', seriesId }); // 90-day tranche
      expect(drew2.events.map((e) => (e.payload as { trancheIndex: number }).trancheIndex)).toEqual([1]);

      // Q3: 75k YTD → 10% × 15k = 1,500 gross; fee 75; net 1,425 to 500 units
      await h.sim.setTime(parsePeriod('2026Q3').end + 86_400);
      const q3 = await h.reportAndPay(seriesId, '2026Q3', privateTerms, terms.termsCommitment, USDC(50_000), USDC(75_000));
      expect(q3.paymentStable).toBe(USDC(1500));
      expect(types(q3.events)).toEqual(['ReportAccepted', 'FeeTaken', 'PaymentReceived']);
      const vault = (await h.sim.getVault(seriesId))!;
      expect(vault.balance).toBe(USDC(1425).toString());
      const pos = (await h.sim.getPosition(seriesId, h.backers[0]!.address))!;
      expect(pos.claimable).toBe(USDC(285).toString()); // 1425 × 100/500
      const claimed = await h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId });
      expect(types(claimed.events)).toEqual(['PayoutClaimed']);
      await expectChainError(h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId }), 'NotFound');
      expect((await h.sim.getSeries(seriesId))!.status).toBe('OnTime');

      // events are resumable from a cursor
      const first = await h.sim.readEvents(null, 5);
      expect(first.events).toHaveLength(5);
      const rest = await h.sim.readEvents(first.nextCursor, 1000);
      expect(rest.events[0]!.seq).toBe(6);
      expect(first.events.every((e) => e.chain === personality)).toBe(true);
    });
  });
}

describe('simulator personalities', () => {
  it('monad has USDC only; solana has USDC and USDG; addresses have the right shape', async () => {
    const sol = SimulatorChain.createSync({ personality: 'solana' });
    const mon = SimulatorChain.createSync({ personality: 'monad' });
    expect(Object.keys((await sol.info()).stablecoins).sort()).toEqual(['USDC', 'USDG']);
    expect(Object.keys((await mon.info()).stablecoins)).toEqual(['USDC']);
    expect(mon.admin).toMatch(/^0x[0-9a-f]{40}$/);
    expect(sol.admin).not.toMatch(/^0x/);
    const h = await SimHarness.create('monad');
    const { terms } = defaultTerms(sol, { stablecoin: 'USDG' });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    await expectChainError(h.exec(h.issuer, { kind: 'createSeries', terms: { ...terms, stablecoinMint: terms.stablecoinMint } }), 'InvalidTerms');
    await expectChainError(h.exec(h.issuer, { kind: 'createSeries', terms: { ...defaultTerms(h.sim).terms, raiseStyle: 'curve' } }), 'InvalidTerms');
  });
  it('solana can raise in USDG', async () => {
    const h = await SimHarness.create('solana');
    const { seriesId } = await h.runRaise({ terms: { stablecoin: 'USDG', stablecoinMint: h.sim.mintOf('USDG') } });
    expect((await h.sim.getSeries(seriesId))!.terms.stablecoin).toBe('USDG');
    expect(await h.sim.getBalance(h.sim.state.feeCollector, 'USDG')).toBe(USDC(45).toString());
  });
});

describe('auction edge cases', () => {
  it('fails below the minimum raise and refunds everyone without fees', async () => {
    const h = await SimHarness.create('solana');
    const { seriesId } = await h.runRaise({ bids: [{ backer: 0, price: USDC(10), qty: 10n }] });
    const s = (await h.sim.getSeries(seriesId))!;
    expect(s.phase).toBe('Failed');
    await h.exec(h.backers[0]!, { kind: 'claimRefund', seriesId });
    expect(await h.sim.getBalance(h.backers[0]!.address, 'USDC')).toBe('1000000000000');
    expect(await h.sim.getBalance(h.sim.state.feeCollector, 'USDC')).toBe('0');
  });
  it('enforces allowlist, one bid per wallet, commitment integrity and the wallet cap', async () => {
    const h = await SimHarness.create('solana');
    const { terms } = defaultTerms(h.sim);
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const r = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (r.events[0]!.payload as { seriesId: string }).seriesId;
    const now = await h.sim.now();
    await h.exec(h.issuer, { kind: 'openRaise', seriesId, commitEndsAt: now + 100, revealEndsAt: now + 200 });
    const stranger = h.sim.address('wallet:stranger');
    await h.sim.fund(stranger, 'USDC', USDC(1000));
    const tx = await h.sim.build({ kind: 'commitBid', seriesId, commitment: '0x' + '00'.repeat(32), deposit: '1' }, stranger);
    await expectChainError(h.sim.send({ tx, signatures: { [stranger]: `sim:${stranger}` } }), 'NotAllowlisted');
    const w = h.backers[0]!;
    const salt = '0x' + 'aa'.repeat(32);
    const c = bidCommitment({ seriesId, bidder: w.address, pricePerUnit: USDC(10), quantity: 300n, salt });
    await h.exec(w, { kind: 'commitBid', seriesId, commitment: c, deposit: USDC(3030).toString() });
    await expectChainError(h.exec(w, { kind: 'commitBid', seriesId, commitment: c, deposit: '1' }), 'Duplicate');
    await expectChainError(h.exec(h.issuer, { kind: 'cancelRaise', seriesId }), 'TooLate');
    await h.sim.setTime(now + 100);
    await expectChainError(h.exec(w, { kind: 'revealBid', seriesId, pricePerUnit: USDC(10).toString(), quantity: '299', salt }), 'InvalidCommitment');
    await h.exec(w, { kind: 'revealBid', seriesId, pricePerUnit: USDC(10).toString(), quantity: '300', salt });
    await expectChainError(h.sim.submit({ kind: 'settleAuction', seriesId }, 'keeper'), 'TooEarly');
    await h.sim.setTime(now + 200);
    await h.sim.submit({ kind: 'settleAuction', seriesId }, 'keeper');
    // wallet cap: 20% of 500 = 100 units; 100 × 10 = 1000 < min raise 4000 → fails
    expect((await h.sim.getSeries(seriesId))!.phase).toBe('Failed');
  });
  it('the issuer can cancel before bids and cannot open while new raises are paused', async () => {
    const h = await SimHarness.create('monad');
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const r = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms });
    const seriesId = (r.events[0]!.payload as { seriesId: string }).seriesId;
    await h.exec(h.admin, { kind: 'pauseNewRaises', paused: true });
    const now = await h.sim.now();
    await expectChainError(h.exec(h.issuer, { kind: 'openRaise', seriesId, commitEndsAt: now + 10, revealEndsAt: now + 20 }), 'Paused');
    await h.exec(h.admin, { kind: 'pauseNewRaises', paused: false });
    await h.exec(h.issuer, { kind: 'openRaise', seriesId, commitEndsAt: now + 10, revealEndsAt: now + 20 });
    const c = await h.exec(h.issuer, { kind: 'cancelRaise', seriesId });
    expect(types(c.events)).toEqual(['RaiseCancelled']);
  });
});

describe('cap, retirement and burn', () => {
  it('accepts only up to the cap, refunds the issuer, retires and burns on claim or crank', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    // cap 22.5 per unit × 500 units = 11,250 gross lifetime. Pay a huge Q1: income 200k → 10% × 140k = 14,000
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const q1 = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(200_000));
    expect(q1.paymentStable).toBe(USDC(14_000));
    expect(types(q1.events)).toEqual(['ReportAccepted', 'PaymentRefunded', 'FeeTaken', 'PaymentReceived', 'StatusChanged', 'SeriesRetired']);
    const refund = q1.events.find((e) => e.type === 'PaymentRefunded')!.payload as { amount: string };
    expect(refund.amount).toBe(USDC(2750).toString());
    const s = (await h.sim.getSeries(seriesId))!;
    expect(s.status).toBe('Retired');
    expect(s.paidPerUnitWad).toBe((USDC(22.5) * WAD).toString());
    // claim burns; crank burns the rest
    const c = await h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId });
    expect(types(c.events)).toEqual(['PayoutClaimed', 'UnitsBurned']);
    const crank = await h.sim.submit({ kind: 'crankBurn', seriesId, holders: h.backers.map((b) => b.address) }, 'keeper');
    expect(crank.events.filter((e) => e.type === 'UnitsBurned')).toHaveLength(4);
    expect((await h.sim.getSeries(seriesId))!.unitsOutstanding).toBe('0');
    // burned holders can still claim what they were owed
    const c2 = await h.exec(h.backers[1]!, { kind: 'claimPayout', seriesId });
    expect((c2.events[0]!.payload as { amount: string }).amount).toBe((USDC(11_250 * 0.95) / 5n).toString());
    // no further reports
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    await expect(h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(200_000), USDC(250_000))).rejects.toThrow();
    // vault invariant: total claims ≤ vault, dust ≥ 0
    const v = (await h.sim.getVault(seriesId))!;
    expect(BigInt(v.balance)).toBeGreaterThanOrEqual(0n);
  });
});

describe('lateness, accrual and release pause', () => {
  it('sets InGrace then Late, pauses releases, accrues interest, resumes when paid, emits FormalNoticeDue', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    const q1 = parsePeriod('2026Q1');
    await h.sim.setTime(q1.end + 31 * 86_400);
    let r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(types(r.events)).toEqual(['StatusChanged']);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('InGrace');
    await h.sim.setTime(q1.end + 46 * 86_400);
    r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(types(r.events)).toEqual(['StatusChanged', 'ReleasesPaused']);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('Late');
    await expectChainError(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'Paused');
    await h.sim.setTime(q1.end + 121 * 86_400);
    r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(types(r.events)).toEqual(['FormalNoticeDue']);
    // pay 76 days after grace end: income 100k → 4,000 gross; accrual = 4000 × 8% × 76/365
    const { command } = h.buildReport({ seriesId, periodId: '2026Q1', unitsOutstanding: 500n, privateTerms, incomeYtdPrev: 0n, incomeYtdNow: USDC(100_000), termsCommitment: terms.termsCommitment });
    const acc = await h.exec(h.issuer, command);
    const p = acc.events[0]!.payload as { paymentDue: string; accrual: string };
    expect(BigInt(p.accrual)).toBe((USDC(4000) * wadFromDecimal('0.08') * 76n) / (WAD * 365n));
    expect(BigInt(p.paymentDue)).toBe(USDC(4000) + BigInt(p.accrual));
    // Q2 also complete and unpaid now (we are 121 days after Q1 end, ~30 days after Q2 end): still in grace for Q2
    const pay = await h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: p.paymentDue });
    expect(types(pay.events)).toEqual(['FeeTaken', 'PaymentReceived', 'StatusChanged', 'ReleasesResumed']);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('InGrace');
    const periods = await h.sim.listPeriods(seriesId);
    expect(periods.map((x) => [x.periodId, x.standing])).toEqual([['2026Q1', 'OnTime'], ['2026Q2', 'InGrace']]);
    // nothing is slashed: treasury intact
    expect((await h.sim.getTreasury(seriesId))!.balance).toBe(USDC(4500).toString());
  });
});

describe('hardship pause', () => {
  it('needs an attestor, defers deadlines without accrual, and ends by crank', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    const q1 = parsePeriod('2026Q1');
    await h.sim.setTime(q1.end + 10 * 86_400);
    const until = q1.end + 100 * 86_400;
    await h.exec(h.issuer, { kind: 'requestPause', seriesId, until });
    await expectChainError(h.exec(h.backers[0]!, { kind: 'approvePause', seriesId, until }), 'Unauthorized');
    const ap = await h.exec(h.attestors[0]!, { kind: 'approvePause', seriesId, until });
    expect(types(ap.events)).toEqual(['PauseApproved', 'StatusChanged']);
    // 60 days later: without the pause we'd be Late; paused instead and deadlines deferred
    await h.sim.setTime(q1.end + 70 * 86_400);
    const r = await h.sim.submit({ kind: 'crankStatus', seriesId }, 'keeper');
    expect(r.events).toHaveLength(0);
    expect((await h.sim.getPeriod(seriesId, '2026Q1'))!.standing).toBe('Deferred');
    await expectChainError(h.sim.submit({ kind: 'crankPause', seriesId }, 'keeper'), 'TooEarly');
    await h.sim.setTime(until);
    const ended = await h.sim.submit({ kind: 'crankPause', seriesId }, 'keeper');
    expect(types(ended.events)[0]).toBe('PauseEnded');
    const per = (await h.sim.getPeriod(seriesId, '2026Q1'))!;
    // due shifted by the 90 paused days: original due = end+30d → end+120d
    expect(per.dueAt).toBe(q1.end + 120 * 86_400);
    expect(per.standing).toBe('NotDue');
    expect((await h.sim.getSeries(seriesId))!.status).toBe('OnTime');
    // paying now carries no accrual
    const res = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(100_000));
    expect(res.due).toBe(USDC(4000));
  });
});

describe('redemption and tail', () => {
  it('quotes the formula price, blocks before lockup, pays holders and burns, then honours the tail', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise({ terms: { lockupSeconds: 365 * 86_400 } });
    const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
    // report all 2026 quarters at modest income (80k/yr → 2,000 gross/yr = 4 per unit)
    const ytd = [20_000, 40_000, 60_000, 80_000].map(USDC);
    let prev = 0n;
    for (const [i, q] of ['2026Q1', '2026Q2', '2026Q3', '2026Q4'].entries()) {
      await h.sim.setTime(parsePeriod(q).end + 86_400);
      await h.reportAndPay(seriesId, q, privateTerms, terms.termsCommitment, prev, ytd[i]!);
      prev = ytd[i]!;
    }
    await expectChainError(h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() }), 'TooEarly');
    await h.sim.setTime(settledAt + 365 * 86_400 + 10);
    // 2027Q1 not yet complete, so no unpaid periods block the redemption (A-RED-1)
    const quote = h.sim.engine.quote(h.sim.state.series.get(seriesId)!, await h.sim.now());
    // hurdle: 9 × 1.08 = 9.72; D_avg over 1 full year = 2000/500 = 4 → k×D = 20; C_remaining = 22.5 − 4 = 18.5 → bound by cap
    expect(quote.hurdlePrice).toBe(USDC(9.72));
    expect(quote.payoutTerm).toBe(USDC(20));
    expect(quote.pricePerUnit).toBe(USDC(18.5));
    expect(quote.boundBy).toBe('cap');
    await expectChainError(h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(18).toString() }), 'InvalidTerms');
    const r = await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(18.5).toString() });
    expect(types(r.events)).toEqual(['RedemptionOpened', 'StatusChanged']);
    const red = (await h.sim.getRedemption(seriesId))!;
    expect(red.deposit).toBe(USDC(18.5 * 500).toString());
    expect(red.tailCapPerUnit).toBe('0');
    const before = BigInt(await h.sim.getBalance(h.backers[0]!.address, 'USDC'));
    const c = await h.exec(h.backers[0]!, { kind: 'claimRedemption', seriesId });
    expect(types(c.events)).toEqual(['PayoutClaimed', 'UnitsBurned', 'RedemptionClaimed']);
    const after = BigInt(await h.sim.getBalance(h.backers[0]!.address, 'USDC'));
    expect(after - before).toBe(USDC(1850) + (USDC(2000 * 0.95) / 5n));
    // tail: price equalled C_remaining → no tail due even on a liquidity event
    await h.sim.setTime(parsePeriod('2027Q1').end + 86_400);
    const tail = await h.reportAndPay(seriesId, '2027Q1', privateTerms, terms.termsCommitment, 0n, USDC(1_000_000), { liquidityEvent: true });
    expect(tail.due).toBe(0n);
  });
  it('pays a capped tail when redemption was bound by the hurdle', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise({ terms: { lockupSeconds: 30 * 86_400 } });
    const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(10_000));
    await h.sim.setTime(Math.max(settledAt + 31 * 86_400, parsePeriod('2026Q1').end + 2 * 86_400));
    const r = await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(10).toString() });
    const opened = r.events[0]!.payload as { pricePerUnit: string; tailCapPerUnit: string };
    expect(BigInt(opened.pricePerUnit)).toBeGreaterThan(USDC(9)); // hurdle-bound, < 1 year → linear accrual
    const tailCap = BigInt(opened.tailCapPerUnit);
    expect(tailCap).toBe(USDC(22.5) - BigInt(opened.pricePerUnit));
    // Q2 liquidity event: 10% × (2M − 60k) ≈ 194,000 → 388/unit, capped at tailCap per unit
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    const tail = await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(10_000), USDC(2_000_000), { liquidityEvent: true });
    expect(tail.due).toBe(tailCap * 500n);
    expect(types(tail.events)).toContain('TailPayout');
    const pos = (await h.sim.getPosition(seriesId, h.backers[0]!.address))!;
    expect(BigInt(pos.tailClaimable)).toBe((tailCap * 500n * 95n / 100n) / 5n);
    await h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId });
    // a second tail report cannot exceed the cap
    await h.sim.setTime(parsePeriod('2026Q3').end + 86_400);
    const tail2 = await h.reportAndPay(seriesId, '2026Q3', privateTerms, terms.termsCommitment, USDC(2_000_000), USDC(3_000_000), { liquidityEvent: true });
    expect(tail2.due).toBe(0n);
  });
});

describe('amendments and extinguishment', () => {
  it('allows only issuer-favourable amendments with an attestor, and extinguishes with two attestors', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    const r = ratePerUnit(privateTerms.shareRateWad, 500n);
    const newCommitment = termsCommitment({ threshold: privateTerms.threshold * 103n / 100n, ratePerUnitWad: r, reportingCurrency: 'USD', indexingRule: 'cpi-annual', salt: privateTerms.salt });
    await expectChainError(h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: newCommitment, capMultipleWad: wadFromDecimal('2.5').toString(), attestor: h.attestors[0]!.address }), 'Unauthorized');
    await expectChainError(h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: newCommitment, capMultipleWad: wadFromDecimal('2.6').toString(), attestor: h.attestors[0]!.address }, [h.attestors[0]!]), 'InvalidTerms');
    const ok = await h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: newCommitment, capMultipleWad: wadFromDecimal('2.4').toString(), attestor: h.attestors[0]!.address }, [h.attestors[0]!]);
    expect(types(ok.events)).toEqual(['TermsAmended']);
    const s = (await h.sim.getSeries(seriesId))!;
    expect(s.terms.termsCommitment).toBe(newCommitment);
    expect(s.capPerUnit).toBe((USDC(9) * 24n / 10n).toString());
    // old commitment no longer accepted
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    await expect(h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 0n)).rejects.toThrow(/commitment/);
    // extinguishment: two attestors, unreleased treasury to holders
    await expectChainError(h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }), 'Unauthorized');
    const ex = await h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!]);
    expect(types(ex.events)).toEqual(['PaymentReceived', 'SeriesExtinguished', 'StatusChanged']);
    const returned = (ex.events[1]!.payload as { returnedToHolders: string }).returnedToHolders;
    expect(returned).toBe(USDC(4500).toString());
    const pos = (await h.sim.getPosition(seriesId, h.backers[2]!.address))!;
    expect(pos.claimable).toBe(USDC(900).toString());
    await expectChainError(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'WrongStatus');
  });
});

describe('rate accumulator and FX fallback', () => {
  it('snapshots once per day, averages the quarter, flags low coverage and requires an attestor rate', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise({ privateTerms: { threshold: 50_000_000_000n, shareRateWad: wadFromDecimal('0.10'), reportingCurrency: 'EUR', indexingRule: 'hicp-annual', salt: '0x' + '33'.repeat(32) }, terms: { reportingCurrency: 'EUR' } });
    const q1 = parsePeriod('2026Q1');
    // snapshot every day of Q1 at 1.08 then 1.10 (sim time is already past the auction; go to Q1 start)
    let t = Math.max(await h.sim.now(), q1.start);
    let n = 0;
    while (t < q1.end) {
      const rate = n % 2 === 0 ? wadFromDecimal('1.08') : wadFromDecimal('1.10');
      await h.sim.submit({ kind: 'snapshotRate', pair: 'EUR/USD', rateWad: rate.toString(), confWad: wadFromDecimal('0.0005').toString(), publishTime: t, update: null }, 'keeper');
      await expectChainError(h.sim.submit({ kind: 'snapshotRate', pair: 'EUR/USD', rateWad: rate.toString(), confWad: '0', publishTime: t, update: null }, 'keeper'), 'Duplicate');
      t += 86_400;
      n++;
      await h.sim.setTime(t);
    }
    const q = (await h.sim.getQuarterRate('EUR/USD', '2026Q1'))!;
    expect(q.coverageOk).toBe(true);
    expect(q.needsFallback).toBe(false);
    expect(BigInt(q.avgWad!)).toBeGreaterThan(wadFromDecimal('1.08'));
    await expectChainError(h.sim.submit({ kind: 'flagFxFallback', pair: 'EUR/USD', periodId: '2026Q1', reason: 'coverage' }, 'keeper'), 'InvalidTerms');
    // EUR report must use the accumulator rate
    await h.sim.setTime(q1.end + 86_400);
    const fx = BigInt(q.avgWad!);
    await expect(h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 70_000_000_000n, { fxBasis: 'accumulator', pair: 'EUR/USD', fxAvgWad: fx + 1n })).rejects.toThrow(/accumulator/);
    const ok = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 70_000_000_000n, { fxBasis: 'accumulator', pair: 'EUR/USD', fxAvgWad: fx });
    expect(ok.paymentStable).toBe((2_000_000_000n * fx) / WAD);
    // Q2 has no snapshots → fallback flagged, attestor rate required
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    const flag = await h.sim.submit({ kind: 'flagFxFallback', pair: 'EUR/USD', periodId: '2026Q2', reason: 'coverage' }, 'keeper');
    expect(types(flag.events)).toEqual(['FxFallbackFlagged']);
    await expect(h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, 70_000_000_000n, 90_000_000_000n, { fxBasis: 'accumulator', pair: 'EUR/USD', fxAvgWad: fx })).rejects.toThrow();
    const att = await h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, 70_000_000_000n, 90_000_000_000n, { fxBasis: 'attestor', pair: 'EUR/USD', fxAvgWad: wadFromDecimal('1.09'), attestorRate: { attestor: h.attestors[1]!.address, rateWad: wadFromDecimal('1.09'), pair: 'EUR/USD' } });
    expect(att.paymentStable).toBe(2_180_000_000n);
  });
});

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

describe('tier 1 split receipts and multi-series issuers', () => {
  it('reconciles router receipts against the quarterly report', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    await h.exec(h.admin, { kind: 'registerSplitRouter', seriesId, router: h.router });
    await h.sim.setTime(parsePeriod('2026Q1').start + 40 * 86_400);
    const r = await h.sim.postSplitReceipt(h.router, seriesId, USDC(1000));
    expect(types(r.events)).toEqual(['FeeTaken', 'PaymentReceived', 'SplitReceipt']);
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    // report says 10% × (100k − 60k) = 4,000; 1,000 already arrived via the split → 3,000 due
    const res = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(100_000), { tier: 1, source: 'split' });
    expect(res.due).toBe(USDC(3000));
    // second series for the same issuer
    const second = await h.runRaise({ terms: { unitsOffered: '500' } });
    expect(second.seriesId).not.toBe(seriesId);
    expect((await h.sim.getIssuer(h.issuer.address))!.seriesIds).toHaveLength(2);
  });
});

describe('autonomy charter invariants (C11)', () => {
  it('C11.1 releases follow the schedule with no approval; only Late or the issuer pause them', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    await h.exec(h.issuer, { kind: 'pauseReleases', seriesId, paused: true });
    await expectChainError(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'Paused');
    await h.exec(h.issuer, { kind: 'pauseReleases', seriesId, paused: false });
    await h.exec(h.issuer, { kind: 'drawRelease', seriesId });
    // nobody else can pause: attestor/admin/backer have no such command path (the only pause inputs are the issuer flag and Late)
    const tx = await h.sim.build({ kind: 'pauseReleases', seriesId, paused: true }, h.admin.address);
    await expectChainError(h.sim.send({ tx, signatures: { [h.admin.address]: `sim:${h.admin.address}` } }), 'Unauthorized');
  });
  it('C11.3 reporting zero carries no penalty and C11.5 the issuer can stop new issuance', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const zero = await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 0n);
    expect(zero.due).toBe(0n);
    expect((await h.sim.getSeries(seriesId))!.status).toBe('OnTime');
    await h.exec(h.issuer, { kind: 'stopIssuance' });
    await expectChainError(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms }), 'NotPermitted');
  });
  it('C11.7 the admin cannot touch a live series, move funds or block claims', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    const forbidden = [
      { kind: 'drawRelease', seriesId },
      { kind: 'redeem', seriesId, maxPricePerUnit: '1' },
      { kind: 'claimPayout', seriesId },
      { kind: 'requestPause', seriesId, until: 9_999_999_999 },
    ] as const;
    for (const cmd of forbidden) {
      const tx = await h.sim.build(cmd, h.admin.address);
      await expect(h.sim.send({ tx, signatures: { [h.admin.address]: `sim:${h.admin.address}` } })).rejects.toBeInstanceOf(ChainError);
    }
    // and a failed tx leaves no trace
    const before = (await h.sim.readEvents(null, 10_000)).events.length;
    await expect(h.exec(h.issuer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: '1' })).rejects.toBeInstanceOf(ChainError);
    expect((await h.sim.readEvents(null, 10_000)).events.length).toBe(before);
  });
});
