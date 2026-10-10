import { describe, expect, it } from 'vitest';
import { WAD, parsePeriod, wadFromDecimal } from '@merces/math';
import { SimHarness } from '../src/index.ts';
import { seedHolder, seriesOf } from './kit.ts';
import { GENESIS, USDC, expectStage1Error, types } from './helpers.ts';

/*
 * S3 cause codes:
 *  - S3-BR: `burnRetired{holder}`, one holder per call, replaces the S1 list burn crank (`holders[]`);
 *  - S3-Z: the zero-amount rule: a claim of nothing emits `PayoutClaimed` with zeros, a burn of nothing `UnitsBurned(0)`;
 *  - S3-BU: `PayoutClaimed.burnedUnits`.
 */
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
    expect(q1.events.find((e) => e.type === 'PaymentReceived')!.payload).toMatchObject({ gross: USDC(11_250).toString(), fee: USDC(562.5).toString(), net: USDC(10_687.5).toString() });
    const s = (await h.sim.getSeries(seriesId))!;
    expect(s.status).toBe('Retired');
    expect(s.paidPerUnitWad).toBe((USDC(22.5) * WAD).toString());
    expect(s.refundedToIssuer).toBe(USDC(2750).toString());
    // Stage 1's vault: the cap refund is recorded, the open due is closed by the retirement
    const v = h.sim.stage1View(seriesId).ledger;
    expect([v.grossReceived, v.feeCollected, v.refundedToIssuer, v.paidPerUnitWad, v.openDueAmount, v.lastPaidPeriod]).toEqual([USDC(11_250).toString(), USDC(562.5).toString(), USDC(2750).toString(), (USDC(22.5) * WAD).toString(), '0', '8104']);
    // claim burns; burnRetired burns the rest, one holder at a time
    const c = await h.exec(h.backers[0]!, { kind: 'claimPayout', seriesId });
    expect(types(c.events)).toEqual(['PayoutClaimed', 'UnitsBurned']);
    expect(c.events[0]!.payload).toMatchObject({ burnedUnits: '100' }); // cause S3-BU
    // cause S3-BR: one burnRetired per holder (was one list burn crank); b0, burned by its claim, gets a burn of 0
    const burns = [];
    for (const b of h.backers) burns.push(...(await h.sim.submit({ kind: 'burnRetired', seriesId, holder: b.address }, 'keeper')).events);
    expect(burns.map((e) => (e.payload as { units: string }).units)).toEqual(['0', '100', '100', '100', '100']);
    expect((await h.sim.getSeries(seriesId))!.unitsOutstanding).toBe('0');
    // cause S3-Z: a holder with no units left gets a burn of 0 (Stage 1's zero-amount rule; was: no event)
    expect((await h.sim.submit({ kind: 'burnRetired', seriesId, holder: h.backers[1]!.address }, 'keeper')).events.map((e) => [e.type, e.payload])).toEqual([['UnitsBurned', { seriesId, holder: h.backers[1]!.address, units: '0', reason: 'cap' }]]);
    // burned holders can still claim what they were owed: the burn settled them before burning
    const c2 = await h.exec(h.backers[1]!, { kind: 'claimPayout', seriesId });
    expect(types(c2.events)).toEqual(['PayoutClaimed']);
    expect(c2.events[0]!.payload).toMatchObject({ burnedUnits: '0' }); // cause S3-BU
    expect((c2.events[0]!.payload as { amount: string }).amount).toBe((USDC(11_250 * 0.95) / 5n).toString());
    // no further reports
    await h.sim.setTime(parsePeriod('2026Q2').end + 86_400);
    await expect(h.reportAndPay(seriesId, '2026Q2', privateTerms, terms.termsCommitment, USDC(200_000), USDC(250_000))).rejects.toThrow();
    // vault invariant: total claims ≤ vault, dust ≥ 0
    const vault = (await h.sim.getVault(seriesId))!;
    expect(BigInt(vault.balance)).toBeGreaterThanOrEqual(0n);
    expect(BigInt(vault.dust)).toBeGreaterThanOrEqual(0n);
  });

  it('the refund goes to the issuer even when someone else pays; the cap is read live after an amendment', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    // amend the cap multiple 2.5 → 2.0 (the floor): 18 per unit × 500 = 9,000 gross lifetime
    await h.exec(h.issuer, { kind: 'amendTerms', seriesId, termsCommitment: terms.termsCommitment, capMultipleWad: wadFromDecimal('2.0').toString(), attestor: h.attestors[0]!.address }, [h.attestors[0]!]);
    expect((await h.sim.getSeries(seriesId))!.capPerUnit).toBe(USDC(18).toString());
    expect(h.sim.stage1View(seriesId).ledger.capPerUnit).toBe(USDC(18).toString());
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    const { command } = await h.buildReport({ seriesId, periodId: '2026Q1', privateTerms, termsCommitment: terms.termsCommitment, incomeYtdNow: USDC(200_000) });
    await h.exec(h.issuer, command);
    // a backer pays the 14,000 due: it is debited all of it, the 5,000 above the cap goes back to the issuer
    const payer = h.backers[3]!;
    const [payerBefore, issuerBefore] = [BigInt(await h.sim.getBalance(payer.address, 'USDC')), BigInt(await h.sim.getBalance(h.issuer.address, 'USDC'))];
    const paid = await h.exec(payer, { kind: 'payIn', seriesId, periodId: '2026Q1', amount: USDC(14_000).toString() });
    expect(types(paid.events)).toEqual(['PaymentRefunded', 'FeeTaken', 'PaymentReceived', 'StatusChanged', 'SeriesRetired']);
    expect(paid.events.find((e) => e.type === 'PaymentReceived')!.payload).toMatchObject({ gross: USDC(9000).toString(), paidPerUnitWad: (USDC(18) * WAD).toString() });
    expect(BigInt(await h.sim.getBalance(payer.address, 'USDC'))).toBe(payerBefore - USDC(14_000));
    expect(BigInt(await h.sim.getBalance(h.issuer.address, 'USDC'))).toBe(issuerBefore + USDC(5000));
    const s = (await h.sim.getSeries(seriesId))!;
    expect([s.status, s.refundedToIssuer, s.paidPerUnitWad]).toEqual(['Retired', USDC(5000).toString(), (USDC(18) * WAD).toString()]);
  });

  it('a claim on a Retired series burns the units even when nothing is paid; burnRetired refuses an unregistered holder', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, terms, privateTerms } = await h.runRaise();
    await h.sim.setTime(parsePeriod('2026Q1').end + 86_400);
    await h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, USDC(200_000));
    // white box: backer 2 has already been paid everything up to the live accumulator
    const w = h.backers[2]!.address;
    seedHolder(h.sim, seriesId, w, { pending: 0n, lastNetAccWad: seriesOf(h.sim, seriesId).vault.netAccWad });
    expect((await h.sim.getPosition(seriesId, w))!.claimable).toBe('0');
    const c = await h.exec(h.backers[2]!, { kind: 'claimPayout', seriesId });
    // cause S3-Z: the claim of nothing emits its event with 0, then the burn (was: the burn alone)
    expect(c.events.map((e) => [e.type, e.payload])).toEqual([['PayoutClaimed', { seriesId, holder: w, amount: '0', burnedUnits: '100' }], ['UnitsBurned', { seriesId, holder: w, units: '100', reason: 'cap' }]]);
    expect((await h.sim.getPosition(seriesId, w))!.units).toBe('0');
    // Stage 1 burn_retired settles the holder first, so an unregistered holder with units is refused
    const stray = h.backers[3]!.address;
    seedHolder(h.sim, seriesId, stray, { registered: false });
    await expectStage1Error(h.sim.submit({ kind: 'burnRetired', seriesId, holder: stray }, 'keeper'), 'HolderNotRegistered'); // cause S3-BR
    await expectStage1Error(h.exec(h.backers[3]!, { kind: 'claimPayout', seriesId }), 'HolderNotRegistered');
  });
});
