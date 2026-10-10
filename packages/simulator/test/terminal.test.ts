import { describe, expect, it } from 'vitest';
import { termsCommitment } from '@merces/domain';
import { WAD, parsePeriod, wadFromDecimal } from '@merces/math';
import { SimHarness, defaultTerms } from '../src/index.ts';
import { GENESIS, USDC, expectStage1Error, types } from './helpers.ts';
import { seriesOf } from './kit.ts';

/**
 * Amendments, extinguishment and the final pool on Stage 1 (S1 plan WP7; SIM:853-865, 1419-1475).
 *
 * The figures were computed with Stage 1 itself: Stage 1's `ScenarioBuilder` drove Stage 1's own `Simulator` through the
 * same flows and dates (the harness's 500 units at 9 USDC, proceeds 4,500 released 50% at settlement, 25% at 90 and
 * 180 days). Cause codes on what changed from the version-1 engine:
 *  - G7: only the unvested proceeds (`proceeds − vested(now)`) go to holders, through a separate final pool weighed on
 *    the final units; vested but undrawn tranches stay drawable by the issuer; the net accumulator is not touched;
 *  - E: Stage 1's check order and names (SameAttestor, InvalidAttestorSignature, RaiseNotSettled, TerminalStatus,
 *    NotIssuer, AmendmentAfterTerminal, UnfavourableAmendment) and `amendmentNonce` / `extinguishNonce`;
 *  - M4: on a series that redeemed, a holder's final share is weighed on its redeemed units, its remaining units being
 *    redeemed first.
 */

const DAY = 86_400;
const balance = async (h: SimHarness, wallet: string) => BigInt(await h.sim.getBalance(wallet, 'USDC'));

async function settled(lockupSeconds?: number) {
  const h = await SimHarness.create('monad', { genesis: GENESIS });
  const raise = await h.runRaise(lockupSeconds === undefined ? {} : { terms: { lockupSeconds } });
  const settledAt = (await h.sim.getSeries(raise.seriesId))!.settledAt!;
  return { h, settledAt, ...raise };
}

describe('amendments and extinguishment', () => {
  it('allows only issuer-favourable amendments with an attestor, and extinguishes with two attestors', async () => {
    const { h, seriesId, terms, privateTerms } = await settled();
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    const newCommitment = termsCommitment({ ...privateTerms, theta: privateTerms.theta * 103n / 100n });
    const amend = (cap: string, signer = h.issuer, coSigners = [a1]) => h.exec(signer, { kind: 'amendTerms', seriesId, termsCommitment: newCommitment, capMultipleWad: wadFromDecimal(cap).toString(), attestor: a1.address }, coSigners);
    // Stage 1 order: the issuer, then the terminal check, then the attestor, then the cap (E; the attestor came first)
    await expectStage1Error(amend('2.4', h.backers[0]!), 'NotIssuer');
    await expectStage1Error(amend('2.4', h.issuer, []), 'InvalidAttestorSignature'); // E: was Unauthorized
    await expectStage1Error(amend('2.6'), 'UnfavourableAmendment'); // E: was InvalidTerms
    await expectStage1Error(amend('1.9'), 'UnfavourableAmendment'); // below Stage 1's bound 2·WAD
    const ok = await amend('2.4');
    expect(types(ok.events)).toEqual(['TermsAmended']);
    const s = (await h.sim.getSeries(seriesId))!;
    expect(s.terms.termsCommitment).toBe(newCommitment);
    expect(s.capPerUnit).toBe((USDC(9) * 24n / 10n).toString());
    expect(s.amendmentNonce).toBe(1); // E
    // a proof over the old terms no longer matches the live commitment (vector 14)
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await expectStage1Error(h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 0n), 'InvalidProof');

    // extinguishment: two distinct, active, co-signing attestors
    const extinguish = (attestors: [string, string], coSigners = [a2]) => h.exec(a1, { kind: 'extinguish', seriesId, attestors }, coSigners);
    await expectStage1Error(extinguish([a1.address, a1.address], []), 'SameAttestor'); // E: was InvalidTerms
    await expectStage1Error(extinguish([a1.address, a2.address], []), 'InvalidAttestorSignature'); // E: was Unauthorized
    await h.exec(h.admin, { kind: 'registerAttestor', attestor: a2.address, active: false });
    await expectStage1Error(extinguish([a1.address, a2.address]), 'InvalidAttestorSignature'); // a revoked attestor (vector 11 #37)
    await h.exec(h.admin, { kind: 'registerAttestor', attestor: a2.address, active: true });
    const ex = await extinguish([a1.address, a2.address]);
    expect(types(ex.events)).toEqual(['PaymentReceived', 'SeriesExtinguished', 'StatusChanged']);
    expect(ex.events[0]!.payload).toMatchObject({ source: 'extinguishment', gross: USDC(2250).toString(), fee: '0', net: USDC(2250).toString() });
    // only tranches 1 and 2 (90 and 180 days) are unvested on 2026-04-02: 2,250 returns (G7; was all 4,500 unreleased)
    expect((ex.events[1]!.payload as { returnedToHolders: string }).returnedToHolders).toBe(USDC(2250).toString());
    const x = (await h.sim.getSeries(seriesId))!;
    expect(x).toMatchObject({ status: 'Extinguished', extinguishNonce: 1, accNetWad: '0' }); // the net accumulator is untouched (G7)
    expect(x.final).toEqual({ accWad: (USDC(2250) * WAD / 500n).toString(), units: '500', distributed: USDC(2250).toString() });
    const treasury = (await h.sim.getTreasury(seriesId))!;
    expect(treasury).toMatchObject({ total: USDC(4500).toString(), released: '0', balance: USDC(2250).toString() });
    // the returned tranches are never drawable (the issuer's build-draw lists tranche 0 only)
    expect(treasury.tranches.map((t) => t.drawableAt === null)).toEqual([false, true, true]);
    // a holder's share comes from the final pool, not the net payout (G7; was claimable 900)
    const pos = (await h.sim.getPosition(seriesId, h.backers[2]!.address))!;
    expect(pos).toMatchObject({ claimable: '0', finalClaimable: USDC(450).toString() });
    // the burn crank refuses an Extinguished series (Stage 1 burn_retired: TerminalStatus); its units burn on claim
    await expectStage1Error(h.sim.submit({ kind: 'crankBurn', seriesId, holders: [h.backers[2]!.address] }, 'keeper'), 'TerminalStatus');
    const before = await balance(h, h.backers[2]!.address);
    const claim = await h.exec(h.backers[2]!, { kind: 'claimPayout', seriesId });
    expect(types(claim.events)).toEqual(['PayoutClaimed', 'UnitsBurned']);
    expect(claim.events[0]!.payload).toMatchObject({ amount: USDC(450).toString() });
    expect(claim.events[1]!.payload).toMatchObject({ units: '100', reason: 'extinguishment' });
    expect(await balance(h, h.backers[2]!.address)).toBe(before + USDC(450));
    expect((await h.sim.getPosition(seriesId, h.backers[2]!.address))!.finalClaimable).toBe('0');
    // a second claim pays nothing and burns nothing
    expect((await h.exec(h.backers[2]!, { kind: 'claimPayout', seriesId })).events).toEqual([]);
    // the vested tranche stays drawable after the extinguishment, up to vested(extinguishedAt) (G7; was WrongStatus)
    const issuerBefore = await balance(h, h.issuer.address);
    const draw = await h.exec(h.issuer, { kind: 'drawRelease', seriesId });
    expect(types(draw.events)).toEqual(['FundsReleased']);
    expect(await balance(h, h.issuer.address)).toBe(issuerBefore + USDC(2250));
    await h.sim.setTime(parsePeriod('2026Q3').end); // tranche 2 is past its date but was returned to holders
    await expectStage1Error(h.exec(h.issuer, { kind: 'drawRelease', seriesId }), 'NothingVested');
    expect(await h.sim.getTreasury(seriesId)).toMatchObject({ released: USDC(2250).toString(), balance: '0' });
    // terminal: no second extinguishment, no amendment (E; were Duplicate and WrongStatus)
    await expectStage1Error(extinguish([a1.address, a2.address]), 'TerminalStatus');
    await expectStage1Error(amend('2.3'), 'AmendmentAfterTerminal');
  });

  it('refuses a raise that has not settled (amendment M5)', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const { terms } = defaultTerms(h.sim);
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    // a Draft raise (Stage 1 exit.rs: RaiseNotSettled; was cancelled by the extinguishment)
    await expectStage1Error(h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]), 'RaiseNotSettled');
    const now = await h.sim.now();
    await h.exec(h.issuer, { kind: 'openRaise', seriesId, commitEndsAt: now + 3 * DAY, revealEndsAt: now + 4 * DAY });
    // an Open raise (was failed with every deposit refundable)
    await expectStage1Error(h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]), 'RaiseNotSettled');
    expect((await h.sim.getSeries(seriesId))!.phase).toBe('Open');
  });

  it('on a redeemed series weighs the final share on redeemed units, redeeming the rest first (amendment M4)', async () => {
    const { h, seriesId, settledAt } = await settled(10);
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    const [b0, b1] = [h.backers[0]!, h.backers[1]!];
    await h.sim.setTime(settledAt + 11);
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() });
    expect((await h.sim.getSeries(seriesId))!.redemption).toMatchObject({ pricePerUnit: USDC(9).toString(), unitsAtRedemption: '500' });
    const r0 = await h.exec(b0, { kind: 'claimRedemption', seriesId });
    expect(types(r0.events)).toEqual(['UnitsBurned', 'RedemptionClaimed']);
    expect((await h.sim.getPosition(seriesId, b0.address))!).toMatchObject({ units: '0', redeemedUnits: '100' });
    await h.sim.setTime(settledAt + 12);
    const ex = await h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]);
    // a Redeemed series may be extinguished; the final units are the units at redemption, 500 (not the 400 left)
    expect((ex.events.find((e) => e.type === 'SeriesExtinguished')!.payload as { returnedToHolders: string }).returnedToHolders).toBe(USDC(2250).toString());
    expect((await h.sim.getSeries(seriesId))!.final).toMatchObject({ units: '500', accWad: (USDC(2250) * WAD / 500n).toString() });
    // b0 redeemed everything before: weight 100 redeemed units (the plan's wording would have given it 0)
    expect((await h.sim.getPosition(seriesId, b0.address))!.finalClaimable).toBe(USDC(450).toString());
    expect((await h.sim.getPosition(seriesId, b1.address))!.finalClaimable).toBe(USDC(450).toString());
    let before = await balance(h, b0.address);
    const c0 = await h.exec(b0, { kind: 'claimPayout', seriesId });
    expect(types(c0.events)).toEqual(['PayoutClaimed']);
    expect(await balance(h, b0.address)).toBe(before + USDC(450));
    // b1 still holds 100 units: the redemption body runs first (900), then the final share (450), as Stage 1 pays 1,350
    before = await balance(h, b1.address);
    const c1 = await h.exec(b1, { kind: 'claimPayout', seriesId });
    expect(types(c1.events)).toEqual(['UnitsBurned', 'RedemptionClaimed', 'PayoutClaimed']);
    expect(c1.events[1]!.payload).toMatchObject({ units: '100', amount: USDC(900).toString() });
    expect(c1.events[2]!.payload).toMatchObject({ amount: USDC(450).toString() });
    expect(await balance(h, b1.address)).toBe(before + USDC(1350));
    expect((await h.sim.getPosition(seriesId, b1.address))!).toMatchObject({ units: '0', redeemedUnits: '100', finalClaimable: '0' });
    expect((await h.exec(b1, { kind: 'claimPayout', seriesId })).events).toEqual([]);
    // Stage 1's vault after the same two claims: 4,500 deposit + 2,250 final − 900 − 450 − 1,350 = 4,050
    expect(seriesOf(h.sim, seriesId).vaultBalance).toBe(USDC(4050));
  });
});
