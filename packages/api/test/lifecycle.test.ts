import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbTestsEnabled } from '@merces/db';
import { setFlag } from '@merces/core';
import { orderCommitment, type UnsignedTx } from '@merces/domain';
import { parsePeriod } from '@merces/math';
import { SimWallet } from '@merces/simulator';
import { makeRig } from './helpers.ts';

const USDC = (n: number) => BigInt(Math.round(n * 1e6));

/**
 * Pins that moved with Stage 1 (S1 WP12) carry a cause code. The figures were recomputed with Stage 1's own `Simulator`
 * (its `ScenarioBuilder`, the harness's terms: θ 60,000, 10% above it, 500 units at 9 USDC, cap 2.5×, hurdle 8%, k 2,
 * a 5% payout fee) over the same flow: tranche 0 drawn, 20/40/60/80k year to date reported a day after each 2026 quarter,
 * quote and redeem at settlement + 365 days + 10 s, b0 claims its redemption:
 *  - G6: Stage 1's `redemptionQuote` over the tagged year ring: the 2026Q4 payment is tagged with the settlement year of
 *    its deadline (2027-01-31, settlement year 1), so year 0 holds no gross, D_avg = 0 and the hurdle 9 × 1.08 = 9.72
 *    decides below C_rem = 22.5 − 4 = 18.5; deposit 4,860, tail cap 8.78, b0's claim 972;
 *  - C: Stage 1's zero-amount claim is a successful no-op (SIM:1268-1282): HTTP 200 with no events.
 * S3 cause codes:
 *  - S3-Z: the zero-amount rule: a claim of nothing succeeds and emits its event with zeros (`PayoutClaimed{0, 0}`);
 *  - S3-CL: the payout claim builder is Stage 1's `claim`: it returns what that claim pays (`claimable`) and the units it
 *    burns (`burnsUnits`), and its 409 (`nothing-to-claim`) names the claims that would pay the holder something;
 *  - S3-BR: the admin burn sends one `burnRetired` per holder still holding units, and refuses a series not Retired;
 *  - S3-RC: the redemption claim builder's preview is everything the claim pays, the redemption (`redemptionClaimable`)
 *    and the pending payout it pays too (`claimable`), over the units it redeems (was: units × price).
 *
 * The S3 WP4 builders (tail, final, registration) are checked against the chain itself: every figure a builder shows is
 * what the relayed transaction's events then pay and burn, so no figure here is a new pin.
 */
describe.skipIf(!dbTestsEnabled())('lifecycle builders (R6, R13, R14, R15, R19)', () => {
  let rig: Awaited<ReturnType<typeof makeRig>>;
  beforeAll(async () => {
    rig = await makeRig();
  });
  afterAll(async () => {
    await rig.close();
  });

  it('treasury draw, payout claim, redemption quote → redeem → claim, tail view, retirement view, windows gated by the flag', async () => {
    const h = rig.mon;
    const raise = await h.runRaise({ terms: { lockupSeconds: 365 * 86_400 } });
    const seriesId = raise.seriesId;
    await rig.sync();
    const issuerTok = rig.token({ accountId: 'iss', wallets: [{ chain: 'monad', address: h.issuer.address }], roles: ['issuer'] });
    const holderTok = rig.token({ accountId: 'b0', wallets: [{ chain: 'monad', address: h.backers[0]!.address }], roles: ['backer'] });
    const adminTok = rig.token({ accountId: 'adm', roles: ['admin'], wallets: [] });
    // R6: draw the first tranche through the builder; a second draw is refused until the next tranche
    const draw = await rig.post(`/series/${seriesId}/treasury/build-draw`, {}, issuerTok);
    expect(draw.json().drawable).toEqual([{ index: 0, amount: USDC(2250).toString() }]);
    expect((await rig.post('/tx/send', await h.issuer.sign(draw.json().tx as UnsignedTx), issuerTok)).statusCode).toBe(200);
    expect((await rig.post(`/series/${seriesId}/treasury/build-draw`, {}, issuerTok)).statusCode).toBe(409);
    const pause = await rig.post(`/series/${seriesId}/treasury/build-pause`, { paused: true }, issuerTok);
    await rig.post('/tx/send', await h.issuer.sign(pause.json().tx as UnsignedTx), issuerTok);
    expect((await rig.post(`/series/${seriesId}/treasury/build-draw`, {}, issuerTok)).json().message).toContain('paused by the issuer');
    await rig.post('/tx/send', await h.issuer.sign((await rig.post(`/series/${seriesId}/treasury/build-pause`, { paused: false }, issuerTok)).json().tx as UnsignedTx), issuerTok);
    // a year of modest payments (80k/yr → 2,000 gross/yr = 4 per unit)
    const ytd = [20_000, 40_000, 60_000, 80_000].map(USDC);
    let prev = 0n;
    for (const [i, q] of ['2026Q1', '2026Q2', '2026Q3', '2026Q4'].entries()) {
      await h.sim.setTime(parsePeriod(q).end + 86_400);
      await h.reportAndPay(seriesId, q, raise.privateTerms, raise.terms.termsCommitment, prev, ytd[i]!);
      prev = ytd[i]!;
    }
    await rig.sync();
    // R13: claim through the builder
    expect((await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: h.backers[0]!.address }, issuerTok)).statusCode).toBe(403);
    const claim = await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: h.backers[0]!.address }, holderTok);
    // cause S3-CL: what the claim pays and burns, nothing of the other pools (was: tailClaimable and finalClaimable too)
    expect(claim.json()).toMatchObject({ builder: 'public', claimable: (USDC(2000) * 95n / 100n / 5n).toString(), burnsUnits: '0' });
    expect(claim.json()).not.toHaveProperty('tailClaimable');
    expect(claim.json()).not.toHaveProperty('finalClaimable');
    expect((await rig.post('/tx/send', await h.backers[0]!.sign(claim.json().tx as UnsignedTx), holderTok)).json().events[0].type).toBe('PayoutClaimed');
    const nothing = await rig.post(`/series/${seriesId}/payouts/build-claim`, { holder: h.backers[0]!.address }, holderTok);
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json()).toMatchObject({ message: 'nothing to claim', detail: { reason: 'nothing-to-claim', claimWith: [] } });
    // the builder refuses a claim with nothing in it, but the chain takes one: relayed anyway, a zero claim succeeds
    // (cause C: was 404, ChainNotFound) and emits its event with zeros (cause S3-Z: was no event)
    const zero = await rig.post('/tx/send', await h.backers[0]!.sign(await h.sim.build({ kind: 'claimPayout', seriesId }, h.backers[0]!.address)), holderTok);
    expect(zero.statusCode, zero.body).toBe(200);
    expect(zero.json().events.map((e: { type: string; payload: unknown }) => [e.type, e.payload])).toEqual([['PayoutClaimed', { seriesId, holder: h.backers[0]!.address, amount: '0', burnedUnits: '0' }]]);
    // a wallet that is not a registered holder is still refused: 404 with Stage 1's HolderNotRegistered
    const notHolder = await rig.post('/tx/send', await h.issuer.sign(await h.sim.build({ kind: 'claimPayout', seriesId }, h.issuer.address)), issuerTok);
    expect(notHolder.statusCode).toBe(404);
    expect(notHolder.json()).toMatchObject({ error: 'ChainNotFound', detail: { stage1: 'HolderNotRegistered' } });
    // R14 retirement view (not retired)
    const ret = await rig.get(`/series/${seriesId}/retirement`);
    expect(ret.json()).toMatchObject({ retired: false, paidPerUnit: USDC(4).toString(), capProgressBps: Math.floor((4 / 22.5) * 10_000) });
    // R15: quote before lockup end lists the blocker; after a full year the hurdle decides (matches the simulator test)
    const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
    let quote = await rig.get(`/series/${seriesId}/redemption/quote`, holderTok);
    expect(quote.json().blockers.some((b: string) => b.includes('lockup'))).toBe(true);
    expect(quote.json().blockedBy).toEqual(['LockupActive']); // Stage 1's error name beside the text
    expect((await rig.post(`/series/${seriesId}/redemption/build-redeem`, { maxPricePerUnit: USDC(100).toString() }, issuerTok)).statusCode).toBe(409);
    await h.sim.setTime(settledAt + 365 * 86_400 + 10);
    quote = await rig.get(`/series/${seriesId}/redemption/quote`, issuerTok);
    // Stage 1's quote over the year ring: the 2026Q4 payment is tagged with settlement year 1 (its deadline), so
    // k × D_avg = 0 and the hurdle 9.72 decides below C_rem 18.5 (G6; was 18.5 bound by the cap, payoutTerm 20, deposit 9,250)
    expect(quote.json()).toMatchObject({ redeemable: true, pricePerUnit: USDC(9.72).toString(), boundBy: 'hurdle', deposit: USDC(4_860).toString(), tailCapPerUnit: USDC(8.78).toString() });
    expect(quote.json()).toMatchObject({ decidedBy: 'hurdle', blockedBy: [], outcome: 'redeem', terms: { dAvg: '0', capRemaining: USDC(18.5).toString() } });
    expect(quote.json().terms.hurdlePrice).toBe(USDC(9.72).toString());
    expect(quote.json().terms.payoutTerm).toBe('0');
    const redeem = await rig.post(`/series/${seriesId}/redemption/build-redeem`, { maxPricePerUnit: USDC(9.72).toString() }, issuerTok);
    expect(redeem.statusCode).toBe(200);
    expect((await rig.post('/tx/send', await h.issuer.sign(redeem.json().tx as UnsignedTx), issuerTok)).json().events.map((e: { type: string }) => e.type)).toEqual(['RedemptionOpened', 'StatusChanged']);
    const rc = await rig.post(`/series/${seriesId}/redemption/build-claim`, { holder: h.backers[0]!.address }, holderTok);
    // 9.72 × 100 (G6; was 18.5 × 100 = 1,850); b0 claimed its payout above, so the redemption pays no pending payout (S3-RC)
    expect(rc.json()).toMatchObject({ units: '100', amount: USDC(972).toString(), redemption: USDC(972).toString(), payout: '0' });
    expect((await rig.post('/tx/send', await h.backers[0]!.sign(rc.json().tx as UnsignedTx), holderTok)).statusCode).toBe(200);
    await rig.sync();
    const red = await rig.get(`/series/${seriesId}/redemption`, holderTok);
    expect(red.json().status).toBe('Redeemed');
    expect(red.json().tail.open).toBe(true); // the hurdle decided: 18.5 − 9.72 = 8.78 per unit of tail room (G6; was closed)
    // Stage 1's tail state: nothing paid yet, not exhausted
    expect(red.json().tail).toMatchObject({ capPerUnit: USDC(8.78).toString(), paidPerUnitWad: '0', paidPerUnit: '0', exhausted: false, refunded: '0' });
    expect(red.json().claims.count).toBe(1);
    // R19: windows switched off → 403; on → builders work after lockup
    const win = await rig.get(`/series/${seriesId}/window`);
    expect(win.json().enabled).toBe(false);
    expect((await rig.post(`/series/${seriesId}/window/build-commit`, { wallet: h.backers[1]!.address, side: 'sell', commitment: '0x' + '00'.repeat(32), deposit: '0', units: '10' }, rig.token({ accountId: 'b1', wallets: [{ chain: 'monad', address: h.backers[1]!.address }], roles: ['backer'] }))).statusCode).toBe(403);
    await setFlag(rig.t.pool, 'transfer_windows', true, 'test');
    const other = await rig.mon.runRaise({ terms: { lockupSeconds: 10 } });
    await h.sim.advanceTime(11);
    const now = await h.sim.now();
    await h.sim.submit({ kind: 'openTransferWindow', seriesId: other.seriesId, commitEndsAt: now + 100, revealEndsAt: now + 200 }, 'keeper');
    const b1 = h.backers[1]!;
    const b1Tok = rig.token({ accountId: 'b1', wallets: [{ chain: 'monad', address: b1.address }], roles: ['backer'] });
    const salt = '0x' + 'dd'.repeat(32);
    const c = orderCommitment({ seriesId: other.seriesId, windowId: 0, wallet: b1.address, side: 'sell', pricePerUnit: USDC(10), quantity: 10n, salt });
    const wc = await rig.post(`/series/${other.seriesId}/window/build-commit`, { wallet: b1.address, side: 'sell', commitment: c, deposit: '0', units: '10' }, b1Tok);
    expect(wc.statusCode).toBe(200);
    const wsent = await rig.post('/tx/send', await b1.sign(wc.json().tx as UnsignedTx), b1Tok);
    expect(wsent.statusCode, wsent.body).toBe(200);
    expect((await rig.put(`/series/${other.seriesId}/window/backup`, { wallet: b1.address, ciphertext: 'age:...' }, b1Tok)).statusCode).toBe(200);
    expect((await rig.get(`/series/${other.seriesId}/window`)).json().phase).toBe('commit');
    // cause S3-BR: burnRetired takes a Retired series only; redeemed units burn at their redemption
    const burn = await rig.post(`/series/${seriesId}/retirement/crank-burn`, {}, adminTok);
    expect(burn.statusCode).toBe(409);
    expect(burn.json()).toMatchObject({ detail: { stage1: 'TerminalStatus' } });
    await setFlag(rig.t.pool, 'transfer_windows', false, 'test');
  });

  /** The canonical events of a relayed transaction as [type, payload]; the stablecoin they pay and the units they burn. */
  const relay = async (wallet: SimWallet, tx: UnsignedTx, tok: string) => {
    const r = await rig.post('/tx/send', await wallet.sign(tx), tok);
    expect(r.statusCode, r.body).toBe(200);
    const events = (r.json().events as { type: string; payload: Record<string, string> }[]).map((e) => [e.type, e.payload] as const);
    const paid = events.filter(([t]) => ['PayoutClaimed', 'RedemptionClaimed', 'TailClaimed', 'FinalClaimed'].includes(t)).reduce((a, [, p]) => a + BigInt(p.amount!), 0n);
    const burned = events.filter(([t]) => t === 'UnitsBurned').reduce((a, [, p]) => a + BigInt(p.units!), 0n);
    return { events, paid: paid.toString(), burned: burned.toString() };
  };

  it('S3 WP4: the tail and final claim builders and the holder registration builder, in Stage 1\'s order, show what the chain pays', async () => {
    const h = rig.sol;
    const raise = await h.runRaise({ terms: { lockupSeconds: 30 * 86_400 } });
    const seriesId = raise.seriesId;
    await rig.sync();
    const [b0, b1, b2, b3] = h.backers as [SimWallet, SimWallet, SimWallet, SimWallet];
    const tok = (w: SimWallet) => rig.token({ accountId: `wp4-${w.label}`, wallets: [{ chain: 'solana', address: w.address }], roles: ['backer'] });
    const issuerTok = rig.token({ accountId: 'wp4-iss', wallets: [{ chain: 'solana', address: h.issuer.address }], roles: ['issuer'] });
    const adminTok = rig.token({ accountId: 'wp4-adm', roles: ['admin'], wallets: [] });
    const tail = (w: SimWallet, t = tok(w)) => rig.post(`/series/${seriesId}/tail/build-claim`, { holder: w.address }, t);
    const final = (w: SimWallet, t = tok(w)) => rig.post(`/series/${seriesId}/final/build-claim`, { holder: w.address }, t);
    const register = (wallet: string, t: string) => rig.post(`/series/${seriesId}/holders/build-register`, { wallet }, t);
    const position = async (w: SimWallet) => (await rig.get(`/series/${seriesId}/position`, tok(w))).json().positions[0] as Record<string, string>;

    // before a redemption there is no tail (NotRedeemed) and before an extinguishment no final claim (TerminalStatus);
    // a holder builds claims for its own wallets only
    expect((await tail(b0)).json()).toMatchObject({ error: 'Conflict', detail: { stage1: 'NotRedeemed' } });
    expect((await final(b0)).json()).toMatchObject({ error: 'Conflict', detail: { stage1: 'TerminalStatus' } });
    expect((await tail(b1, tok(b0))).statusCode).toBe(403);
    expect((await final(b1, tok(b0))).statusCode).toBe(403);

    // registration: a winner is registered when its bid is processed, so nothing to build
    expect((await register(b0.address, tok(b0))).json()).toEqual({ tx: null, alreadyRegistered: true });
    const late = new SimWallet('solana', 'wp4-late');
    const lateTok = rig.token({ accountId: 'wp4-late', wallets: [{ chain: 'solana', address: late.address }], roles: [] });
    expect((await register(b0.address, lateTok)).statusCode).toBe(403); // not the caller's wallet
    const refused = await register(late.address, lateTok);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'Forbidden', detail: { stage1: 'NotAllowlisted' } });
    await h.sim.submit({ kind: 'setAllowlist', wallet: late.address, allowed: true }, 'allowlistManager');
    const reg = await register(late.address, lateTok);
    expect(reg.json()).toMatchObject({ alreadyRegistered: false, tx: { signer: late.address, command: { kind: 'registerHolder', seriesId, wallet: late.address } } });
    expect((await relay(late, reg.json().tx, lateTok)).events).toEqual([['HolderRegistered', { seriesId, holder: late.address }]]);
    expect((await register(late.address, lateTok)).json()).toEqual({ tx: null, alreadyRegistered: true });
    await rig.sync();
    // a registration grants no holder access (A-REV-10): the claim builders are holder-tier
    expect((await tail(late, lateTok)).statusCode).toBe(403);

    // a quarter's payment (100k income against the 60k threshold), then the issuer redeems after the lockup (the flow of
    // the tail scenario); nobody claims the payout, so the redemptions below pay it too
    const settledAt = (await h.sim.getSeries(seriesId))!.settledAt!;
    const q = parsePeriod(`${new Date(settledAt * 1000).getUTCFullYear()}Q${Math.floor(new Date(settledAt * 1000).getUTCMonth() / 3) + 1}`);
    await h.sim.setTime(Math.max(await h.sim.now(), q.end + 86_400, settledAt + 31 * 86_400));
    await h.reportAndPay(seriesId, q.id, raise.privateTerms, raise.terms.termsCommitment, 0n, USDC(100_000));
    for (const p of await h.sim.listPeriods(seriesId)) if (!p.settled) await h.reportAndPay(seriesId, p.periodId, raise.privateTerms, raise.terms.termsCommitment, USDC(100_000), USDC(100_000));
    const quote = (await rig.get(`/series/${seriesId}/redemption/quote`, issuerTok)).json();
    const redeem = await rig.post(`/series/${seriesId}/redemption/build-redeem`, { maxPricePerUnit: quote.pricePerUnit }, issuerTok);
    expect((await relay(h.issuer, redeem.json().tx, issuerTok)).events.map(([t]) => t)).toEqual(['RedemptionOpened', 'StatusChanged']);
    await rig.sync();

    // the late registration has redeemed nothing and has nothing to redeem: NoRedeemedUnits (built by an admin, since the
    // registration alone opens no holder tier)
    expect((await tail(late, adminTok)).json()).toMatchObject({ error: 'Conflict', detail: { stage1: 'NoRedeemedUnits' } });

    // b1 has not redeemed: its tail claim redeems it first in the same transaction, and pays exactly what the builder said
    const p1 = await position(b1);
    expect(BigInt(p1.claimable!)).toBeGreaterThan(0n);
    const t1 = await tail(b1);
    expect(t1.statusCode, t1.body).toBe(200);
    expect(t1.json()).toMatchObject({ amount: '0', redeemsFirst: { units: '100', amount: p1.redemptionClaimable, payout: p1.claimable }, burnsUnits: '100', total: (BigInt(p1.redemptionClaimable!) + BigInt(p1.claimable!)).toString() });
    expect(t1.json().tx).toMatchObject({ signer: b1.address, command: { kind: 'claimTail', seriesId } });
    const r1 = await relay(b1, t1.json().tx, tok(b1));
    expect(r1.events.map(([t]) => t)).toEqual(['PayoutClaimed', 'UnitsBurned', 'RedemptionClaimed', 'TailClaimed']);
    expect(r1.events.at(-1)![1]).toEqual({ seriesId, holder: b1.address, amount: '0' });
    expect([r1.paid, r1.burned]).toEqual([t1.json().total, '100']);
    // nothing is left for its tail until a tail is paid: the builder refuses a claim of nothing
    expect((await tail(b1)).json()).toMatchObject({ message: 'nothing to claim', detail: { reason: 'nothing-to-claim', claimWith: [] } });

    // b3's redemption claim: the preview is everything the claim pays (S3-RC)
    const p3 = await position(b3);
    const rc = await rig.post(`/series/${seriesId}/redemption/build-claim`, { holder: b3.address }, tok(b3));
    expect(rc.json()).toMatchObject({ units: '100', redemption: p3.redemptionClaimable, payout: p3.claimable, amount: (BigInt(p3.redemptionClaimable!) + BigInt(p3.claimable!)).toString() });
    const r3 = await relay(b3, rc.json().tx, tok(b3));
    expect([r3.paid, r3.burned]).toEqual([rc.json().amount, '100']);

    // two attestors extinguish the redeemed series: the unvested proceeds go to the final pool
    await h.exec(h.attestors[0]!, { kind: 'extinguish', seriesId, attestors: [h.attestors[0]!.address, h.attestors[1]!.address] }, [h.attestors[1]!]);
    await rig.sync();
    expect((await tail(b0)).statusCode).toBe(200); // the tail claim stays open on an extinguished series that redeemed

    // b2 never redeemed: its final claim redeems it first and weighs its share on the redeemed units
    const p2 = await position(b2);
    expect(BigInt(p2.finalClaimable!)).toBeGreaterThan(0n);
    const f2 = await final(b2);
    expect(f2.statusCode, f2.body).toBe(200);
    expect(f2.json()).toMatchObject({ amount: p2.finalClaimable, redeemsFirst: { units: '100', amount: p2.redemptionClaimable, payout: p2.claimable }, burnsUnits: '100' });
    const r2 = await relay(b2, f2.json().tx, tok(b2));
    expect(r2.events.map(([t]) => t)).toEqual(['PayoutClaimed', 'UnitsBurned', 'RedemptionClaimed', 'FinalClaimed']);
    expect(r2.events.at(-1)![1]).toEqual({ seriesId, holder: b2.address, units: '100', amount: p2.finalClaimable });
    expect([r2.paid, r2.burned]).toEqual([f2.json().total, '100']);

    // b1 redeemed already: its final claim pays its share (and any payout still pending) and burns nothing
    const p1x = await position(b1);
    const f1 = await final(b1);
    expect(f1.json()).toMatchObject({ amount: (BigInt(p1x.claimable!) + BigInt(p1x.finalClaimable!)).toString(), redeemsFirst: null, burnsUnits: '0' });
    const r1x = await relay(b1, f1.json().tx, tok(b1));
    expect(r1x.events).toEqual([['FinalClaimed', { seriesId, holder: b1.address, units: '100', amount: f1.json().amount }]]);
    // the share is paid once: a second final claim is a claim of nothing
    expect((await final(b1)).json()).toMatchObject({ detail: { reason: 'nothing-to-claim', claimWith: [] } });
    // the reads keep each claim's figure apart
    const holding = (await rig.get('/me/holdings', tok(b1))).json().holdings.find((x: { seriesId: string }) => x.seriesId === seriesId);
    expect(holding).toMatchObject({ claimable: '0', pending: '0', redemptionClaimable: '0', tailClaimable: '0', finalClaimable: '0', redeemedUnits: '100' });
  });
});
