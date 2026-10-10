import { describe, expect, it } from 'vitest';
import { orderCommitment, termsCommitment } from '@merces/domain';
import { WAD, parsePeriod, wadFromDecimal } from '@merces/math';
import { SimHarness, defaultTerms } from '../src/index.ts';
import { GENESIS, USDC, expectStage1Error, types } from './helpers.ts';
import { seriesOf } from './kit.ts';

/*
 * S4 cause codes on the pins that moved:
 *  - S4-BID: bid and order commitments are Stage 1's keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32) (S4 D11):
 *    the builders take no series, window or side, and the salt is 32 bytes;
 *  - S4-CTX: the series read carries Stage 1's signing nonces as `nonces {pause, amendment, extinguish, trueup}`, u64
 *    decimal strings (S4 D7; were `amendmentNonce` / `extinguishNonce` numbers);
 *  - S4-REG: Stage 1's key registry: `registerAttestor{attestor}` and `revokeAttestor{attestor}` (forward-only, with the
 *    45-day grace and the last-key rule; S4 WP5; was `registerAttestor{attestor, active}`).
 */

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
 *    redeemed first;
 *  - S2-AD (S2): commit and reveal durations are series terms; `openRaise` derives the phase ends from them;
 *  - S3-FN (S3): the final-pool share is `claimFinal`'s (Stage 1 `claim_final`, `FinalClaimed{units: weight, amount}`,
 *    the claim event before the burn; was paid by `claimPayout`);
 *  - S3-CL (S3): `claimPayout` is Stage 1's `claim`: the net payout only, no final share and no burn on an Extinguished
 *    series;
 *  - S3-Z (S3): a claim of nothing emits its event with zeros (was: no event);
 *  - S3-BR (S3): `burnRetired{holder}` replaces the S1 list burn crank (`holders[]`);
 *  - S3R-F (S3 review fix 1): on a series that redeemed, the final share is weighed on the redeemed units plus the units
 *    held for an uncleared window ask, as both Stage 1 chains weigh it (MercesVault.sol:658, claims.rs:486-490; Stage 1's
 *    TS reference leaves the escrow out, SIM:1460, and strands its share: DIV-S1I-1).
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
    expect(s.nonces).toEqual({ pause: '0', amendment: '1', extinguish: '0', trueup: '0' }); // E; cause S4-CTX
    // a proof over the old terms no longer matches the live commitment (vector 14)
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await expectStage1Error(h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 0n), 'InvalidProof');

    // extinguishment: two distinct, active, co-signing attestors
    const extinguish = (attestors: [string, string], coSigners = [a2]) => h.exec(a1, { kind: 'extinguish', seriesId, attestors }, coSigners);
    await expectStage1Error(extinguish([a1.address, a1.address], []), 'SameAttestor'); // E: was InvalidTerms
    await expectStage1Error(extinguish([a1.address, a2.address], []), 'InvalidAttestorSignature'); // E: was Unauthorized
    await h.exec(h.admin, { kind: 'revokeAttestor', attestor: a2.address }); // cause S4-REG (was registerAttestor{active: false})
    await expectStage1Error(extinguish([a1.address, a2.address]), 'InvalidAttestorSignature'); // a revoked attestor (vector 11 #37)
    await h.exec(h.admin, { kind: 'registerAttestor', attestor: a2.address }); // cause S4-REG (was {active: true})
    const ex = await extinguish([a1.address, a2.address]);
    expect(types(ex.events)).toEqual(['PaymentReceived', 'SeriesExtinguished', 'StatusChanged']);
    expect(ex.events[0]!.payload).toMatchObject({ source: 'extinguishment', gross: USDC(2250).toString(), fee: '0', net: USDC(2250).toString() });
    // only tranches 1 and 2 (90 and 180 days) are unvested on 2026-04-02: 2,250 returns (G7; was all 4,500 unreleased)
    expect((ex.events[1]!.payload as { returnedToHolders: string }).returnedToHolders).toBe(USDC(2250).toString());
    const x = (await h.sim.getSeries(seriesId))!;
    expect(x).toMatchObject({ status: 'Extinguished', nonces: { amendment: '1', extinguish: '1' }, accNetWad: '0' }); // the net accumulator is untouched (G7); cause S4-CTX
    expect(x.final).toEqual({ accWad: (USDC(2250) * WAD / 500n).toString(), units: '500', distributed: USDC(2250).toString() });
    const treasury = (await h.sim.getTreasury(seriesId))!;
    expect(treasury).toMatchObject({ total: USDC(4500).toString(), released: '0', balance: USDC(2250).toString() });
    // the returned tranches are never drawable (the issuer's build-draw lists tranche 0 only)
    expect(treasury.tranches.map((t) => t.drawableAt === null)).toEqual([false, true, true]);
    // a holder's share comes from the final pool, not the net payout (G7; was claimable 900)
    const pos = (await h.sim.getPosition(seriesId, h.backers[2]!.address))!;
    expect(pos).toMatchObject({ claimable: '0', finalClaimable: USDC(450).toString() });
    // cause S3-BR: burnRetired refuses an Extinguished series (Stage 1 burn_retired: TerminalStatus); its units burn at
    // the final claim
    await expectStage1Error(h.sim.submit({ kind: 'burnRetired', seriesId, holder: h.backers[2]!.address }, 'keeper'), 'TerminalStatus');
    const holder = h.backers[2]!.address;
    const before = await balance(h, holder);
    // cause S3-CL, S3-Z: claimPayout pays the net payout only (0 here) and burns nothing on an Extinguished series
    const net = await h.exec(h.backers[2]!, { kind: 'claimPayout', seriesId });
    expect(net.events.map((e) => [e.type, e.payload])).toEqual([['PayoutClaimed', { seriesId, holder, amount: '0', burnedUnits: '0' }]]);
    expect((await h.sim.getPosition(seriesId, holder))!).toMatchObject({ units: '100', finalClaimable: USDC(450).toString() });
    // cause S3-FN: claimFinal pays the share on its 100 units, then burns them (was: claimPayout's PayoutClaimed)
    const claim = await h.exec(h.backers[2]!, { kind: 'claimFinal', seriesId });
    expect(types(claim.events)).toEqual(['FinalClaimed', 'UnitsBurned']);
    expect(claim.events[0]!.payload).toEqual({ seriesId, holder, units: '100', amount: USDC(450).toString() });
    expect(claim.events[1]!.payload).toMatchObject({ units: '100', reason: 'extinguishment' });
    expect(await balance(h, holder)).toBe(before + USDC(450));
    expect((await h.sim.getPosition(seriesId, holder))!.finalClaimable).toBe('0');
    // cause S3-Z: a second claim pays nothing and burns nothing, and still emits its event (was: no event)
    expect((await h.exec(h.backers[2]!, { kind: 'claimFinal', seriesId })).events.map((e) => e.payload)).toEqual([{ seriesId, holder, units: '0', amount: '0' }]);
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
    await h.exec(h.issuer, { kind: 'openRaise', seriesId }); // cause S2-AD: the terms' 3-day commit and 1-day reveal
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
    // cause S3-FN: the final claim is claimFinal's (was: claimPayout's), its event names the weight
    let before = await balance(h, b0.address);
    const c0 = await h.exec(b0, { kind: 'claimFinal', seriesId });
    expect(c0.events.map((e) => [e.type, e.payload])).toEqual([['FinalClaimed', { seriesId, holder: b0.address, units: '100', amount: USDC(450).toString() }]]);
    expect(await balance(h, b0.address)).toBe(before + USDC(450));
    // cause S3-CL: claimPayout on the extinguished series pays b1 its net payout only (0): no redemption, no share, no burn
    before = await balance(h, b1.address);
    expect((await h.exec(b1, { kind: 'claimPayout', seriesId })).events.map((e) => [e.type, e.payload])).toEqual([['PayoutClaimed', { seriesId, holder: b1.address, amount: '0', burnedUnits: '0' }]]);
    expect((await h.sim.getPosition(seriesId, b1.address))!).toMatchObject({ units: '100', redeemedUnits: '0', finalClaimable: USDC(450).toString() });
    // b1 still holds 100 units: claimFinal runs the redemption body first (900), then the final share (450), as Stage 1
    // pays 1,350
    const c1 = await h.exec(b1, { kind: 'claimFinal', seriesId });
    expect(types(c1.events)).toEqual(['UnitsBurned', 'RedemptionClaimed', 'FinalClaimed']);
    expect(c1.events[1]!.payload).toMatchObject({ units: '100', amount: USDC(900).toString() });
    expect(c1.events[2]!.payload).toEqual({ seriesId, holder: b1.address, units: '100', amount: USDC(450).toString() });
    expect(await balance(h, b1.address)).toBe(before + USDC(1350));
    expect((await h.sim.getPosition(seriesId, b1.address))!).toMatchObject({ units: '0', redeemedUnits: '100', finalClaimable: '0' });
    // cause S3-Z: again, nothing is paid and the event names the weight, its redeemed units (was: no event)
    expect((await h.exec(b1, { kind: 'claimFinal', seriesId })).events.map((e) => e.payload)).toEqual([{ seriesId, holder: b1.address, units: '100', amount: '0' }]);
    // Stage 1's vault after the same two claims: 4,500 deposit + 2,250 final − 900 − 450 − 1,350 = 4,050
    expect(seriesOf(h.sim, seriesId).vaultBalance).toBe(USDC(4050));
  });

  // cause S3R-F: the S3 review's case (scenario S3l on vector 22) at the harness's scale. Five holders of 100 units at
  // 52.5 USDC; 50% of the 26,250 proceeds is unvested at the extinguishment, 13,125 over the 500 units at redemption:
  // 26.25 a unit, 2,625 for a 100-unit holder. b1 has 40 of its 100 units in an open ask (was: weighed on its 60 redeemed
  // units, 1,575, and the escrowed 40 units' 1,050 stranded in the vault for good)
  it('on a redeemed series weighs the final share on the redeemed units plus an open ask\'s escrow, as both chains do: 2,625 USDC for the 100-unit holder (S3 review)', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const bids = [0, 1, 2, 3, 4].map((backer) => ({ backer, price: USDC(52.5), qty: 100n }));
    const { seriesId } = await h.runRaise({ terms: { lockupSeconds: 10 }, bids });
    const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    const [b0, b1, b2, b3, b4] = h.backers as [typeof h.backers[0], typeof h.backers[0], typeof h.backers[0], typeof h.backers[0], typeof h.backers[0]];
    // b1 asks 40 of its 100 units in a window, and reveals; the window is still open when the series ends
    const open = settledAt + 11;
    await h.sim.setTime(open);
    await h.sim.submit({ kind: 'openTransferWindow', seriesId, commitEndsAt: open + 100, revealEndsAt: open + 200 }, 'keeper');
    const salt = '0x' + 'cd'.repeat(32);
    // cause S4-BID: Stage 1's keccak commitment, over no series or window
    const commitment = orderCommitment({ wallet: b1.address, pricePerUnit: USDC(60), quantity: 40n, salt });
    await h.exec(b1, { kind: 'commitWindowOrder', seriesId, windowId: 0, side: 'sell', commitment, deposit: '0', units: '40' });
    await h.sim.setTime(open + 100);
    await h.exec(b1, { kind: 'revealWindowOrder', seriesId, windowId: 0, side: 'sell', pricePerUnit: USDC(60).toString(), quantity: '40', salt });
    expect(seriesOf(h.sim, seriesId).positions.get(b1.address)).toMatchObject({ units: 100n, escrowed: 40n });

    await h.sim.setTime(open + 150);
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(1_000).toString() });
    const price = BigInt((await h.sim.getRedemption(seriesId))!.pricePerUnit);
    expect((await h.sim.getRedemption(seriesId))!.unitsAtRedemption).toBe('500');
    await h.exec(a1, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }, [a2]);
    expect((await h.sim.getSeries(seriesId))!.final).toMatchObject({ units: '500', accWad: (USDC(26.25) * WAD).toString(), distributed: USDC(13_125).toString() });

    // the read and the claim agree: b1's share is weighed on 60 + 40 = 100 units, like b0's
    expect((await h.sim.getPosition(seriesId, b1.address))!).toMatchObject({ units: '100', escrowedUnits: '40', finalClaimable: USDC(2_625).toString() });
    expect((await h.sim.getPosition(seriesId, b0.address))!.finalClaimable).toBe(USDC(2_625).toString());
    const before = await balance(h, b1.address);
    const first = await h.exec(b1, { kind: 'claimFinal', seriesId });
    // its 60 free units are redeemed first (the units in the ask stay for the window to return); the share is 2,625
    expect(types(first.events)).toEqual(['UnitsBurned', 'RedemptionClaimed', 'FinalClaimed']);
    expect(first.events[1]!.payload).toMatchObject({ units: '60', amount: (price * 60n).toString() });
    expect(first.events[2]!.payload).toEqual({ seriesId, holder: b1.address, units: '100', amount: USDC(2_625).toString() });
    expect((await balance(h, b1.address)) - before).toBe(price * 60n + USDC(2_625));
    expect((await h.sim.getPosition(seriesId, b1.address))!).toMatchObject({ units: '40', escrowedUnits: '40', redeemedUnits: '60', finalClaimable: '0' });

    // the window ends in NoMatch on the terminal series and returns the 40 units; b1's next final claim redeems them at
    // the redemption price with a share of 0 (it was paid on them already)
    await h.sim.setTime(open + 200);
    await h.sim.submit({ kind: 'clearTransferWindow', seriesId, windowId: 0 }, 'keeper');
    const mid = await balance(h, b1.address);
    const second = await h.exec(b1, { kind: 'claimFinal', seriesId });
    expect(second.events.find((e) => e.type === 'RedemptionClaimed')!.payload).toMatchObject({ units: '40', amount: (price * 40n).toString() });
    expect(second.events.find((e) => e.type === 'FinalClaimed')!.payload).toEqual({ seriesId, holder: b1.address, units: '100', amount: '0' });
    expect((await balance(h, b1.address)) - mid).toBe(price * 40n);

    // every other 100-unit holder gets the same 2,625, and nothing strands: the vault ends empty
    for (const b of [b0, b2, b3, b4]) {
      const ev = (await h.exec(b, { kind: 'claimFinal', seriesId })).events.find((e) => e.type === 'FinalClaimed')!;
      expect(ev.payload, b.address).toEqual({ seriesId, holder: b.address, units: '100', amount: USDC(2_625).toString() });
    }
    expect((await h.sim.getSeries(seriesId))!.unitsOutstanding).toBe('0');
    expect(seriesOf(h.sim, seriesId).vaultBalance).toBe(0n);
  });
});
