import { describe, expect, it } from 'vitest';
import { ChainError, KEY_GRACE_SECONDS, orderCommitment, permissionlessCommandSchema, termsCommitment, userCommandSchema, type PermissionlessCommand, type UserCommand } from '@merces/domain';
import { WAD, parsePeriod, wadFromDecimal } from '@merces/math';
import { SimHarness, SimSigner, defaultTerms, personalitySigning, serialiseState } from '../src/index.ts';
import { GENESIS, USDC, expectStage1Error, types } from './helpers.ts';
import { seriesOf } from './kit.ts';

/*
 * S4 cause codes on the pins that moved:
 *  - S4-BID: bid and order commitments are Stage 1's keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32) (S4 D11):
 *    the builders take no series, window or side, and the salt is 32 bytes;
 *  - S4-CTX: the series read carries Stage 1's signing nonces as `nonces {pause, amendment, extinguish, trueup}`, u64
 *    decimal strings (S4 D7; were `amendmentNonce` / `extinguishNonce` numbers);
 *  - S4-REG: Stage 1's key registry: `registerAttestor{attestor}` and `revokeAttestor{attestor}` (forward-only, with the
 *    45-day grace and the last-key rule; S4 WP5; was `registerAttestor{attestor, active}`);
 *  - S4-AMD: `amendTerms` is Stage 1's `amend_terms`: the issuer sends it carrying an attestor key's AMEND signature over
 *    the domain, the series key, the live amendment nonce, the new commitment and the new cap (`h.amendment`; S4 WP11,
 *    D8), in the EVM's order (NotIssuer, AmendmentAfterTerminal, the cap a u64, the signature, UnfavourableAmendment);
 *    `TermsAmended` carries the nonce that was signed. Was the attestor co-signing the issuer's transaction.
 *  - S4-EXT: `extinguish` is Stage 1's permissionless `extinguish(attestorA, signatureA, attestorB, signatureB)`: two
 *    attestor keys' EXTINGUISH signatures over the domain, the series key and the live extinguish nonce
 *    (`h.extinguishment`; S4 WP12, D8), sent by anyone (the keeper here); SameAttestor on the named keys, then each
 *    signature (InvalidAttestorSignature), then the raise, mint and terminal checks. Was `{attestors}` with the second
 *    attestor co-signing the first one's transaction.
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
    // cause S4-AMD: the issuer's amendTerms carries a1's AMEND signature over the live nonce (was a1 co-signing)
    const amend = async (cap: string, signer = h.issuer) => h.exec(signer, await h.amendment(seriesId, { termsCommitment: newCommitment, capMultipleWad: wadFromDecimal(cap) }, a1));
    // Stage 1 order: the issuer, then the terminal check, then the attestor, then the cap (E; the attestor came first)
    await expectStage1Error(amend('2.4', h.backers[0]!), 'NotIssuer');
    // E: was Unauthorized; cause S4-AMD: a signature that recovers to nobody (was: no co-signer)
    await expectStage1Error(h.exec(h.issuer, { ...(await h.amendment(seriesId, { termsCommitment: newCommitment, capMultipleWad: wadFromDecimal('2.4') }, a1)), signature: '0x' + '00'.repeat(65) }), 'InvalidAttestorSignature');
    await expectStage1Error(amend('2.6'), 'UnfavourableAmendment'); // E: was InvalidTerms
    await expectStage1Error(amend('1.9'), 'UnfavourableAmendment'); // below Stage 1's bound 2·WAD
    const ok = await amend('2.4');
    expect(types(ok.events)).toEqual(['TermsAmended']);
    // cause S4-AMD: the event names the key that signed and the nonce it signed (0, before the increment, as both chains)
    expect(ok.events[0]!.payload).toEqual({ seriesId, termsCommitment: newCommitment, previousCommitment: terms.termsCommitment, capMultipleWad: wadFromDecimal('2.4').toString(), attestor: a1.address, nonce: '0' });
    const s = (await h.sim.getSeries(seriesId))!;
    expect(s.terms.termsCommitment).toBe(newCommitment);
    expect(s.capPerUnit).toBe((USDC(9) * 24n / 10n).toString());
    expect(s.nonces).toEqual({ pause: '0', amendment: '1', extinguish: '0', trueup: '0' }); // E; cause S4-CTX
    // a proof over the old terms no longer matches the live commitment (vector 14)
    await h.sim.setTime(parsePeriod('2026Q1').end + DAY);
    await expectStage1Error(h.reportAndPay(seriesId, '2026Q1', privateTerms, terms.termsCommitment, 0n, 0n), 'InvalidProof');

    // extinguishment: two distinct, active attestor keys' signatures; cause S4-EXT: the keeper relays them (was a2 co-signing a1's transaction)
    const extinguish = async (a: typeof a1 = a1, b: typeof a1 = a2) => h.sim.submit(await h.extinguishment(seriesId, a, b), 'keeper');
    await expectStage1Error(extinguish(a1, a1), 'SameAttestor'); // E: was InvalidTerms
    // cause S4-EXT: a signature that recovers to nobody (E: was Unauthorized, no co-signer)
    await expectStage1Error(h.sim.submit({ ...(await h.extinguishment(seriesId)), signatureB: '0x' + '00'.repeat(65) }, 'keeper'), 'InvalidAttestorSignature');
    await h.exec(h.admin, { kind: 'revokeAttestor', attestor: a2.address }); // cause S4-REG (was registerAttestor{active: false})
    await expectStage1Error(extinguish(), 'InvalidAttestorSignature'); // a revoked attestor (vector 11 #37)
    await h.exec(h.admin, { kind: 'registerAttestor', attestor: a2.address }); // cause S4-REG (was {active: true})
    const ex = await extinguish();
    expect(types(ex.events)).toEqual(['PaymentReceived', 'SeriesExtinguished', 'StatusChanged']);
    expect(ex.events[0]!.payload).toMatchObject({ source: 'extinguishment', gross: USDC(2250).toString(), fee: '0', net: USDC(2250).toString() });
    // only tranches 1 and 2 (90 and 180 days) are unvested on 2026-04-02: 2,250 returns (G7; was all 4,500 unreleased)
    expect((ex.events[1]!.payload as { returnedToHolders: string }).returnedToHolders).toBe(USDC(2250).toString());
    expect((ex.events[1]!.payload as { attestors: string[] }).attestors).toEqual([a1.address, a2.address]); // cause S4-EXT: the two keys
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
    // cause S4-EXT: a signature over the new nonce reaches the terminal check; the used one is dead (nonce 0)
    await expectStage1Error(extinguish(), 'TerminalStatus');
    await expectStage1Error(h.sim.submit(await h.extinguishment(seriesId, a1, a2, { extinguishNonce: 0n }), 'keeper'), 'InvalidAttestorSignature');
    await expectStage1Error(amend('2.3'), 'AmendmentAfterTerminal');
  });

  it('refuses a raise that has not settled (amendment M5)', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const { terms } = defaultTerms(h.sim);
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    // a Draft raise (Stage 1 exit.rs: RaiseNotSettled; was cancelled by the extinguishment); cause S4-EXT: the keeper
    // relays the two signatures (was a1 sending with a2 co-signing)
    await expectStage1Error(h.sim.submit(await h.extinguishment(seriesId), 'keeper'), 'RaiseNotSettled');
    await h.exec(h.issuer, { kind: 'openRaise', seriesId }); // cause S2-AD: the terms' 3-day commit and 1-day reveal
    // an Open raise (was failed with every deposit refundable)
    await expectStage1Error(h.sim.submit(await h.extinguishment(seriesId), 'keeper'), 'RaiseNotSettled');
    expect((await h.sim.getSeries(seriesId))!.phase).toBe('Open');
  });

  it('on a redeemed series weighs the final share on redeemed units, redeeming the rest first (amendment M4)', async () => {
    const { h, seriesId, settledAt } = await settled(10);
    const [b0, b1] = [h.backers[0]!, h.backers[1]!];
    await h.sim.setTime(settledAt + 11);
    await h.exec(h.issuer, { kind: 'redeem', seriesId, maxPricePerUnit: USDC(100).toString() });
    expect((await h.sim.getSeries(seriesId))!.redemption).toMatchObject({ pricePerUnit: USDC(9).toString(), unitsAtRedemption: '500' });
    const r0 = await h.exec(b0, { kind: 'claimRedemption', seriesId });
    expect(types(r0.events)).toEqual(['UnitsBurned', 'RedemptionClaimed']);
    expect((await h.sim.getPosition(seriesId, b0.address))!).toMatchObject({ units: '0', redeemedUnits: '100' });
    await h.sim.setTime(settledAt + 12);
    const ex = await h.sim.submit(await h.extinguishment(seriesId), 'keeper'); // cause S4-EXT (was a co-signed transaction)
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
    await h.sim.submit(await h.extinguishment(seriesId), 'keeper'); // cause S4-EXT (was a co-signed transaction)
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

/** The transaction is refused with Stage 1 error `name`, leaving the chain's state and event log as they were. */
async function refused(h: SimHarness, tx: Promise<unknown>, name: string, message?: RegExp): Promise<void> {
  const before = serialiseState(h.sim.state);
  const events = h.sim.engine.events.length;
  const e = await tx.then(() => null, (x: unknown) => x);
  expect(e, `expected ${name}`).toBeInstanceOf(ChainError);
  expect((e as ChainError).detail?.stage1, (e as ChainError).message).toBe(name);
  if (message) expect((e as ChainError).message).toMatch(message);
  expect(serialiseState(h.sim.state)).toBe(before);
  expect(h.sim.engine.events.length).toBe(events);
}

type Amend = Extract<UserCommand, { kind: 'amendTerms' }>;
const ZERO_SIG = '0x' + '00'.repeat(65);

// cause S4-AMD (S4 WP11, D8): the AMEND signature binds the domain, the series key, the live amendment nonce, the new
// commitment and the new cap; the issuer sends it. Each refusal leaves the state and the event log as they were.
describe('signed amendments (Stage 1 amend_terms)', () => {
  it('the issuer sends the attestor key\'s AMEND signature: the cap a u64 first, then the signature over the live nonce, then the cap\'s bounds', async () => {
    for (const personality of ['solana', 'monad'] as const) {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      const { seriesId, terms, privateTerms } = await h.runRaise();
      const other = (await h.runRaise()).seriesId;
      const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
      const commitment = termsCommitment({ ...privateTerms, theta: privateTerms.theta * 103n / 100n });
      const cap = wadFromDecimal('2.4');
      const f = { termsCommitment: commitment, capMultipleWad: cap };
      const good = await h.amendment(seriesId, f);
      const series = (await h.sim.getSeries(seriesId))!;
      expect(series.nonces.amendment).toBe('0');
      // the issuer check and the terminal check come before the signature is read
      await refused(h, h.exec(h.backers[0]!, { ...good, signature: ZERO_SIG }), 'NotIssuer');
      // a cap above u64 is AmountOutOfRange before any recovery (the EVM's toU64 first; no AMEND message encodes it): with a
      // placeholder signature, and with a valid signature for another cap
      await refused(h, h.exec(h.issuer, { ...good, capMultipleWad: (1n << 64n).toString(), signature: ZERO_SIG }), 'AmountOutOfRange');
      await refused(h, h.exec(h.issuer, { ...good, capMultipleWad: (1n << 64n).toString() }), 'AmountOutOfRange');
      // the signature binds the cap and the commitment
      await refused(h, h.exec(h.issuer, { ...good, capMultipleWad: wadFromDecimal('2.3').toString() }), 'InvalidAttestorSignature', /does not recover/);
      await refused(h, h.exec(h.issuer, { ...good, termsCommitment: terms.termsCommitment }), 'InvalidAttestorSignature', /does not recover/);
      // another series' signature (the same issuer's other series, also at nonce 0): no replay across series
      await refused(h, h.exec(h.issuer, { ...(await h.amendment(other, f)), seriesId }), 'InvalidAttestorSignature', /does not recover/);
      // another chain's domain (the other personality's simulator)
      const foreign = personalitySigning(personality === 'solana' ? 'monad' : 'solana', personality === 'solana' ? 'monad' : 'solana');
      const elsewhere = await a1.attest('AMEND', foreign, series.seriesKey, { amendmentNonce: series.nonces.amendment, termsCommitment: commitment, capMultipleWad: cap.toString() });
      await refused(h, h.exec(h.issuer, { ...good, signature: elsewhere.signature }), 'InvalidAttestorSignature', /does not recover/);
      // another nonce (a signature made for an amendment nonce that is not the live one)
      await refused(h, h.exec(h.issuer, await h.amendment(seriesId, f, a1, { amendmentNonce: '1' })), 'InvalidAttestorSignature', /does not recover/);
      // the named attestor must be the signer; the report verifier's key is no attestor (14#52); an unregistered key; a
      // non-canonical (high-s) signature
      await refused(h, h.exec(h.issuer, { ...good, attestor: a2.address }), 'InvalidAttestorSignature', /does not recover/);
      await refused(h, h.exec(h.issuer, await h.amendment(seriesId, f, h.verifier)), 'InvalidAttestorSignature', /not a usable attestor key/);
      await refused(h, h.exec(h.issuer, await h.amendment(seriesId, f, SimSigner.attestor('never-registered'))), 'InvalidAttestorSignature', /not a usable attestor key/);
      const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
      const sHigh = (n - BigInt('0x' + good.signature.slice(66, 130))).toString(16).padStart(64, '0');
      const flipV = good.signature.slice(130) === '1b' ? '1c' : '1b';
      await refused(h, h.exec(h.issuer, { ...good, signature: good.signature.slice(0, 66) + sHigh + flipV }), 'InvalidAttestorSignature', /does not recover/);
      // the signature is read before the cap's bounds: an unfavourable cap with a bad signature is InvalidAttestorSignature,
      // with the key's signature over it UnfavourableAmendment
      const up = { termsCommitment: commitment, capMultipleWad: wadFromDecimal('2.6') };
      await refused(h, h.exec(h.issuer, { ...(await h.amendment(seriesId, up)), signature: ZERO_SIG }), 'InvalidAttestorSignature');
      await refused(h, h.exec(h.issuer, await h.amendment(seriesId, up)), 'UnfavourableAmendment');
      // the schema takes a 65-byte hex signature and a lowercase 20-byte attestor key (a wallet of another form is no key)
      for (const bad of [{ ...good, signature: 'sim:' + a1.address }, { ...good, signature: undefined }, { ...good, attestor: h.backers[0]!.address }, { ...good, attestor: a1.address.toUpperCase().replace('0X', '0x') }]) {
        await expect(h.exec(h.issuer, bad as unknown as Amend)).rejects.toThrow();
      }
      // the issuer sends it alone (nobody co-signs); the event carries the key and the nonce it signed (0)
      const ok = await h.exec(h.issuer, good);
      expect(ok.events.map((e) => [e.type, e.payload])).toEqual([['TermsAmended', { seriesId, termsCommitment: commitment, previousCommitment: terms.termsCommitment, capMultipleWad: cap.toString(), attestor: a1.address, nonce: '0' }]]);
      expect((await h.sim.getSeries(seriesId))!.nonces).toEqual({ pause: '0', amendment: '1', extinguish: '0', trueup: '0' });
      expect(seriesOf(h.sim, seriesId).amendments).toEqual([{ at: await h.sim.now(), termsCommitment: commitment, capMultipleWad: cap, attestor: a1.address }]);
      expect(h.sim.stage1View(seriesId).ledger.amendmentNonce).toBe('1');
      // a replay of the same signature is dead: the nonce moved
      await refused(h, h.exec(h.issuer, good), 'InvalidAttestorSignature', /does not recover/);
      // the other series' nonce is its own
      expect((await h.sim.getSeries(other))!.nonces.amendment).toBe('0');
    }
  });

  it('a second amendment advances the nonce: a signature collected before it is dead (stale nonce)', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    const { seriesId, privateTerms } = await h.runRaise();
    const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
    const c1 = termsCommitment({ ...privateTerms, theta: privateTerms.theta * 103n / 100n });
    const c2 = termsCommitment({ ...privateTerms, theta: privateTerms.theta * 106n / 100n });
    // two signatures collected at nonce 0, by two keys, for two amendments
    const first = await h.amendment(seriesId, { termsCommitment: c1, capMultipleWad: wadFromDecimal('2.4') }, a1);
    const second = await h.amendment(seriesId, { termsCommitment: c2, capMultipleWad: wadFromDecimal('2.3') }, a2);
    expect((await h.exec(h.issuer, first)).events[0]!.payload).toMatchObject({ attestor: a1.address, nonce: '0' });
    // the second was signed over nonce 0; the live nonce is 1
    await refused(h, h.exec(h.issuer, second), 'InvalidAttestorSignature', /does not recover/);
    // signed again over the live nonce it lands, and its event carries nonce 1
    const again = await h.amendment(seriesId, { termsCommitment: c2, capMultipleWad: wadFromDecimal('2.3') }, a2);
    expect((await h.exec(h.issuer, again)).events[0]!.payload).toMatchObject({ termsCommitment: c2, previousCommitment: c1, attestor: a2.address, nonce: '1' });
    expect((await h.sim.getSeries(seriesId))!.nonces.amendment).toBe('2');
  });

  it('a revoked attestor key cannot sign an amendment, inside the report grace or not: an AMEND needs an active key', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId, privateTerms } = await h.runRaise();
    const f = { termsCommitment: termsCommitment({ ...privateTerms, theta: privateTerms.theta * 103n / 100n }), capMultipleWad: wadFromDecimal('2.4') };
    const signed = await h.amendment(seriesId, f);
    const now = await h.sim.now();
    await h.exec(h.admin, { kind: 'revokeAttestor', attestor: h.attestors[0]!.address });
    await h.sim.setTime(now + 1);
    expect(now + 1).toBeLessThan(now + KEY_GRACE_SECONDS);
    await refused(h, h.exec(h.issuer, signed), 'InvalidAttestorSignature', /not a usable attestor key/);
    expect(types((await h.exec(h.issuer, await h.amendment(seriesId, f, h.attestors[1]!))).events)).toEqual(['TermsAmended']);
  });
});

type Extinguish = Extract<PermissionlessCommand, { kind: 'extinguish' }>;

// cause S4-EXT (S4 WP12, D8): the EXTINGUISH signatures bind the domain, the series key and the live extinguish nonce;
// anyone sends them. Each refusal leaves the state and the event log as they were.
describe('signed extinguishment (Stage 1 extinguish)', () => {
  it('anyone relays two attestor keys\' EXTINGUISH signatures: distinct named keys first, then each signature over the live nonce, then the raise checks', async () => {
    for (const personality of ['solana', 'monad'] as const) {
      const h = await SimHarness.create(personality, { genesis: GENESIS });
      const { seriesId } = await h.runRaise();
      const other = (await h.runRaise()).seriesId;
      const [a1, a2] = [h.attestors[0]!, h.attestors[1]!];
      const good = await h.extinguishment(seriesId);
      const series = (await h.sim.getSeries(seriesId))!;
      expect(series.nonces.extinguish).toBe('0');
      expect(good).toMatchObject({ attestorA: a1.address, attestorB: a2.address });
      // the two named keys must differ, before any signature is read (Solana's AttestorsNotDistinct on the supplied
      // addresses): with placeholders, and with a1's own signature twice
      await refused(h, h.sim.submit({ ...good, attestorB: a1.address, signatureA: ZERO_SIG, signatureB: ZERO_SIG }, 'keeper'), 'SameAttestor');
      await refused(h, h.sim.submit(await h.extinguishment(seriesId, a1, a1), 'keeper'), 'SameAttestor');
      // each signature must recover to its named key: A, then B
      await refused(h, h.sim.submit({ ...good, signatureA: ZERO_SIG }, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      await refused(h, h.sim.submit({ ...good, signatureB: ZERO_SIG }, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      // the signatures swapped between the named keys; one key's two signatures named as two keys (the EVM compares the
      // recovered addresses and says SameAttestor there: an adapter note)
      await refused(h, h.sim.submit({ ...good, signatureA: good.signatureB, signatureB: good.signatureA }, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      await refused(h, h.sim.submit({ ...good, signatureB: good.signatureA }, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      // another series' signatures (also at nonce 0): no replay across series
      await refused(h, h.sim.submit({ ...(await h.extinguishment(other)), seriesId }, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      // another chain's domain (the other personality's simulator): no replay across domains
      const foreign = personalitySigning(personality === 'solana' ? 'monad' : 'solana', personality === 'solana' ? 'monad' : 'solana');
      const elsewhere = await a2.attest('EXTINGUISH', foreign, series.seriesKey, { extinguishNonce: series.nonces.extinguish });
      await refused(h, h.sim.submit({ ...good, signatureB: elsewhere.signature }, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      // another nonce (a signature made for an extinguish nonce that is not the live one)
      await refused(h, h.sim.submit(await h.extinguishment(seriesId, a1, a2, { extinguishNonce: '1' }), 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      // the report verifier's key is no attestor; an unregistered key; a non-canonical (high-s) signature
      await refused(h, h.sim.submit(await h.extinguishment(seriesId, a1, h.verifier), 'keeper'), 'InvalidAttestorSignature', /not a usable attestor key/);
      await refused(h, h.sim.submit(await h.extinguishment(seriesId, SimSigner.attestor('never-registered'), a2), 'keeper'), 'InvalidAttestorSignature', /not a usable attestor key/);
      const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
      const sHigh = (n - BigInt('0x' + good.signatureA.slice(66, 130))).toString(16).padStart(64, '0');
      const flipV = good.signatureA.slice(130) === '1b' ? '1c' : '1b';
      await refused(h, h.sim.submit({ ...good, signatureA: good.signatureA.slice(0, 66) + sHigh + flipV }, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      // the schema takes 65-byte hex signatures and lowercase 20-byte keys, and it is no user command
      for (const bad of [{ ...good, signatureA: 'sim:' + a1.address }, { ...good, signatureB: undefined }, { ...good, attestorA: h.backers[0]!.address }, { ...good, attestorB: a2.address.toUpperCase().replace('0X', '0x') }, { kind: 'extinguish', seriesId, attestors: [a1.address, a2.address] }]) {
        await expect(h.sim.submit(bad as unknown as Extinguish, 'keeper')).rejects.toThrow();
      }
      expect(() => userCommandSchema.parse(good)).toThrow();
      expect(permissionlessCommandSchema.parse(good)).toEqual(good);
      // the signer and the sender are independent: a backer relays it from its own wallet; the event names the two keys
      const ex = await h.exec(h.backers[3]!, good);
      expect(types(ex.events)).toEqual(['PaymentReceived', 'SeriesExtinguished', 'StatusChanged']);
      expect(ex.events[1]!.payload).toMatchObject({ seriesId, attestors: [a1.address, a2.address] });
      expect((await h.sim.getSeries(seriesId))!.nonces).toEqual({ pause: '0', amendment: '0', extinguish: '1', trueup: '0' });
      expect(h.sim.stage1View(seriesId).ledger.extinguishNonce).toBe('1');
      // a replay of the same signatures is dead (the nonce moved), and fresh ones reach the terminal check
      await refused(h, h.sim.submit(good, 'keeper'), 'InvalidAttestorSignature', /does not recover/);
      await refused(h, h.sim.submit(await h.extinguishment(seriesId), 'keeper'), 'TerminalStatus');
      // the other series' nonce is its own, and its own signatures still extinguish it
      expect((await h.sim.getSeries(other))!.nonces.extinguish).toBe('0');
      expect(types((await h.sim.submit(await h.extinguishment(other, a2, a1), 'keeper')).events)).toContain('SeriesExtinguished');
    }
  });

  it('the signatures are read before the raise: an unsettled raise with a bad signature is InvalidAttestorSignature, with good ones RaiseNotSettled', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms });
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    const good = await h.extinguishment(seriesId);
    await refused(h, h.sim.submit({ ...good, signatureB: ZERO_SIG }, 'keeper'), 'InvalidAttestorSignature');
    await refused(h, h.sim.submit(good, 'keeper'), 'RaiseNotSettled');
  });

  it('a revoked attestor key cannot sign an extinguishment, inside the report grace or not: an EXTINGUISH needs active keys', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await h.runRaise();
    const third = SimSigner.attestor('attestor-3');
    await h.exec(h.admin, { kind: 'registerAttestor', attestor: third.address });
    const signed = await h.extinguishment(seriesId);
    const now = await h.sim.now();
    await h.exec(h.admin, { kind: 'revokeAttestor', attestor: h.attestors[1]!.address });
    await h.sim.setTime(now + 1);
    expect(now + 1).toBeLessThan(now + KEY_GRACE_SECONDS);
    await refused(h, h.sim.submit(signed, 'keeper'), 'InvalidAttestorSignature', /not a usable attestor key/);
    // a rotation's new key signs in its place
    expect(types((await h.sim.submit(await h.extinguishment(seriesId, h.attestors[0]!, third), 'keeper')).events)).toContain('SeriesExtinguished');
  });
});
