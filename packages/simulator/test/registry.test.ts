import { describe, expect, it } from 'vitest';
import { ChainError, DEFAULTS, type SeriesTerms } from '@merces/domain';
import { SimHarness, defaultTerms } from '../src/index.ts';
import { GENESIS, USDC, types } from './helpers.ts';
import { seriesOf } from './kit.ts';

/**
 * Series creation and the opening of a sealed-bid raise on Stage 1's rules (S2 WP2; Stage 1 create_series SIM:756-781,
 * open_raise SIM:871-883).
 *
 * Cause codes:
 *  - S2-CR: Stage 1's creation rules (reserve ≥ 1, minimum raise ≤ reserve × units, a wallet cap of at least one unit,
 *    the parameter bounds), now over the raise's own terms too (commit 1 hour–30 days, reveal 1 hour–7 days, non-reveal
 *    charge 0–1,000 bps), on a sealed raise only;
 *  - S2-AD: commit and reveal durations are series terms; `openRaise` derives the phase ends from them;
 *  - S2-E: Stage 1's open_raise error names (`detail.stage1`) and check order.
 *
 * S3 cause codes:
 *  - S3-CT: a curve series takes Stage 1's curve terms (registry create_series, lib.rs:462-572): lockup, wallet cap and
 *    raise durations 0 (CurveTermsNotZero), a positive threshold (CurveThresholdZero), USDC (CurveQuoteMintMismatch);
 *    the EVM refuses curve mode first (CurveModeUnsupported, MercesRegistry.sol:481).
 */

const HOUR = 3_600;
const DAY = 86_400;

async function rejection(p: Promise<unknown>): Promise<ChainError> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ChainError);
  return e as ChainError;
}

async function issuerHarness(personality: 'solana' | 'monad' = 'solana') {
  const h = await SimHarness.create(personality, { genesis: GENESIS });
  await h.exec(h.issuer, { kind: 'registerIssuer' });
  return h;
}

async function create(h: SimHarness, over: Partial<SeriesTerms> = {}): Promise<string> {
  const created = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, over).terms });
  return (created.events[0]!.payload as { seriesId: string }).seriesId;
}

describe('createSeries on Stage 1 create_series rules (S2-CR)', () => {
  it('refuses vector 03 #16 (5 units, a 10% cap, a 20,000 USDC minimum raise) with InvalidTerms', async () => {
    const h = await issuerHarness();
    // V/03#16: reserve 100 USDC × 5 units = 500 < 20,000, and floor(5 × 1000 / 10000) = 0 units per wallet
    const e = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { unitsOffered: '5', reservePrice: USDC(100).toString(), minimumRaise: USDC(20_000).toString(), walletCapBps: 1000 }).terms }));
    expect(e.code).toBe('InvalidTerms');
    expect(e.detail).toEqual({ stage1: 'InvalidTerms' });
    // the cap rule on its own (minimum raise reachable)
    const cap = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { unitsOffered: '5', reservePrice: USDC(100).toString(), minimumRaise: USDC(500).toString(), walletCapBps: 1000 }).terms }));
    expect([cap.code, cap.detail]).toEqual(['InvalidTerms', { stage1: 'InvalidTerms' }]);
    expect(await h.sim.listSeries()).toHaveLength(0);
  });

  it('refuses a minimum raise above reserve × units', async () => {
    const h = await issuerHarness();
    // the harness's 500 units at an 8 USDC reserve reach 4,000 USDC at most
    const e = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { minimumRaise: String(500n * USDC(8) + 1n) }).terms }));
    expect([e.code, e.detail]).toEqual(['InvalidTerms', { stage1: 'InvalidTerms' }]);
    expect(e.message).toBe('minimum raise exceeds units × reserve price');
    await create(h, { minimumRaise: String(500n * USDC(8)) });
  });

  it('bounds the commit and reveal phases and the non-reveal charge of a sealed raise (ParameterOutOfBounds)', async () => {
    const h = await issuerHarness();
    const cases: [Partial<SeriesTerms>, string][] = [
      [{ commitDurationSeconds: HOUR - 1 }, 'commit duration must be between 3600 and 2592000 seconds'],
      [{ commitDurationSeconds: 30 * DAY + 1 }, 'commit duration must be between 3600 and 2592000 seconds'],
      [{ revealDurationSeconds: HOUR - 1 }, 'reveal duration must be between 3600 and 604800 seconds'],
      [{ revealDurationSeconds: 7 * DAY + 1 }, 'reveal duration must be between 3600 and 604800 seconds'],
      [{ nonRevealChargeBps: 1001 }, 'non-reveal charge must be between 0 and 1000 bps'],
    ];
    for (const [over, message] of cases) {
      const e = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, over).terms }));
      expect([e.code, e.detail, e.message], JSON.stringify(over)).toEqual(['InvalidTerms', { stage1: 'ParameterOutOfBounds' }, message]);
    }
    // Stage 1's order: the bounded parameters before the terms (a 3,599-second commit and an unreachable minimum raise)
    const both = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { commitDurationSeconds: HOUR - 1, minimumRaise: String(500n * USDC(8) + 1n) }).terms }));
    expect(both.detail).toEqual({ stage1: 'ParameterOutOfBounds' });
    expect(await h.sim.listSeries()).toHaveLength(0);
    // the bounds themselves are accepted, and the series records what it was created with
    const lo = await create(h, { commitDurationSeconds: HOUR, revealDurationSeconds: HOUR, nonRevealChargeBps: 0 });
    const hi = await create(h, { commitDurationSeconds: 30 * DAY, revealDurationSeconds: 7 * DAY, nonRevealChargeBps: 1000 });
    expect((await h.sim.getSeries(lo))!.terms).toMatchObject({ commitDurationSeconds: HOUR, revealDurationSeconds: HOUR, nonRevealChargeBps: 0 });
    expect((await h.sim.getSeries(hi))!.terms).toMatchObject({ commitDurationSeconds: 30 * DAY, revealDurationSeconds: 7 * DAY, nonRevealChargeBps: 1000 });
  });

  // cause S3-CT (was: the raise's terms unchecked on a curve series, which carried the sealed lockup and wallet cap)
  it('a curve series takes Stage 1\'s zeros: lockup, wallet cap and raise durations 0, else CurveTermsNotZero', async () => {
    const h = await issuerHarness('solana');
    const curve = { raiseStyle: 'curve' as const, minimumRaise: USDC(2000).toString(), reservePrice: USDC(5).toString(), unitsOffered: '1000' };
    // the harness gives a curve series the zeros; the series records them (cap 0: no wallet cap at any stage)
    const { terms } = defaultTerms(h.sim, curve);
    expect([terms.lockupSeconds, terms.walletCapBps, terms.commitDurationSeconds, terms.revealDurationSeconds]).toEqual([0, 0, 0, 0]);
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms });
    expect(types(created.events)).toEqual(['SeriesCreated', 'CurveSeriesCreated']);
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    expect((await h.sim.getSeries(seriesId))!.terms).toMatchObject({ lockupSeconds: 0, walletCapBps: 0, commitDurationSeconds: 0, revealDurationSeconds: 0 });
    // any other value is refused, field by field (Stage 1 curve_mode.rs:630-643: lockup 1, wallet cap 1,000 bps)
    for (const over of [{ lockupSeconds: 1 }, { walletCapBps: 1000 }, { commitDurationSeconds: DAY }, { revealDurationSeconds: HOUR }]) {
      const e = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { ...curve, ...over }).terms }));
      expect([e.code, e.detail]).toEqual(['InvalidTerms', { stage1: 'CurveTermsNotZero' }]);
      expect(e.message).toMatch(/must be 0 on a curve series$/);
    }
    // the sealed bounds on them are not checked (Stage 1 bounds its defaults there), nor the held non-reveal charge
    const charged = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { ...curve, nonRevealChargeBps: 1001 }).terms });
    expect(types(charged.events)).toEqual(['SeriesCreated', 'CurveSeriesCreated']);
    // the other bounds still hold on a curve series
    const e = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { ...curve, auctionFeeBps: 1001 }).terms }));
    expect(e.detail).toEqual({ stage1: 'ParameterOutOfBounds' });
    expect(await h.sim.listSeries()).toHaveLength(2);
  });

  it('a curve series needs a threshold and USDC; the sealed-only rules do not apply (cause S3-CT)', async () => {
    const h = await issuerHarness('solana');
    const curve = { raiseStyle: 'curve' as const, minimumRaise: USDC(2000).toString(), reservePrice: USDC(5).toString(), unitsOffered: '1000' };
    // a zero threshold (curve_mode.rs:645-649)
    const zero = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { ...curve, minimumRaise: '0' }).terms }));
    expect([zero.code, zero.detail]).toEqual(['InvalidTerms', { stage1: 'CurveThresholdZero' }]);
    // a USDG quote (curve_mode.rs:625-629): the curve quotes in USDC
    const usdg = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { ...curve, stablecoin: 'USDG' }).terms }));
    expect([usdg.code, usdg.detail]).toEqual(['InvalidTerms', { stage1: 'CurveQuoteMintMismatch' }]);
    // the threshold is the curve's target, not bounded by reserve × units, and there is no one-unit cap rule
    const big = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { ...curve, unitsOffered: '1', reservePrice: '1', minimumRaise: USDC(1_000_000).toString() }).terms });
    expect(types(big.events)).toEqual(['SeriesCreated', 'CurveSeriesCreated']);
    // the registry's order: the threshold before the zeros, the zeros before the quote mint
    const first = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { ...curve, minimumRaise: '0', walletCapBps: 1000, stablecoin: 'USDG' }).terms }));
    expect(first.detail).toEqual({ stage1: 'CurveThresholdZero' });
    const second = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { ...curve, walletCapBps: 1000, stablecoin: 'USDG' }).terms }));
    expect(second.detail).toEqual({ stage1: 'CurveTermsNotZero' });
  });

  it('the EVM refuses a curve series first, whatever its terms (CurveModeUnsupported; cause S3-CT)', async () => {
    const h = await issuerHarness('monad');
    for (const terms of [defaultTerms(h.sim, { raiseStyle: 'curve', minimumRaise: USDC(2000).toString() }).terms, { ...defaultTerms(h.sim).terms, raiseStyle: 'curve' as const, stablecoin: 'USDG' as const }]) {
      const e = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms }));
      expect([e.code, e.detail]).toEqual(['NotPermitted', { stage1: 'CurveModeUnsupported' }]);
    }
    expect(await h.sim.listSeries()).toHaveLength(0);
  });
});

describe('openRaise on Stage 1 open_raise (S2-AD, S2-E)', () => {
  it('derives the phase ends from the terms: commit end = now + commit duration, reveal end = commit end + reveal duration', async () => {
    const h = await issuerHarness('monad');
    const seriesId = await create(h, { commitDurationSeconds: 2 * HOUR, revealDurationSeconds: HOUR });
    const now = await h.sim.now();
    const opened = await h.exec(h.issuer, { kind: 'openRaise', seriesId });
    expect(opened.events.map((e) => [e.type, e.payload])).toEqual([['RaiseOpened', { seriesId, commitEndsAt: now + 2 * HOUR, revealEndsAt: now + 3 * HOUR }]]);
    expect(await h.sim.getAuction(seriesId)).toMatchObject({ phase: 'Open', commitEndsAt: now + 2 * HOUR, revealEndsAt: now + 3 * HOUR });
    expect((await h.sim.getSeries(seriesId))!.openedAt).toBe(now);
    // the harness's terms: a 3-day commit and a 1-day reveal (Stage 1's defaults are 7 and 2 days)
    const harnessSeries = await create(h);
    await h.exec(h.issuer, { kind: 'openRaise', seriesId: harnessSeries });
    expect(await h.sim.getAuction(harnessSeries)).toMatchObject({ commitEndsAt: now + 3 * DAY, revealEndsAt: now + 4 * DAY });
    expect([DEFAULTS.commitDurationSeconds, DEFAULTS.revealDurationSeconds]).toEqual([7 * DAY, 2 * DAY]);
  });

  it('refuses a second openRaise (RaiseNotDraft) and a non-issuer (NotIssuer), in Stage 1 order', async () => {
    const h = await issuerHarness('solana');
    const seriesId = await create(h);
    const stranger = h.backers[0]!;
    const notIssuer = await rejection(h.exec(stranger, { kind: 'openRaise', seriesId }));
    expect([notIssuer.code, notIssuer.detail]).toEqual(['Unauthorized', { stage1: 'NotIssuer' }]);
    await h.exec(h.issuer, { kind: 'openRaise', seriesId });
    const again = await rejection(h.exec(h.issuer, { kind: 'openRaise', seriesId }));
    expect([again.code, again.detail]).toEqual(['WrongPhase', { stage1: 'RaiseNotDraft' }]);
    // the issuer check comes first (SIM:873-874)
    const strangerAgain = await rejection(h.exec(stranger, { kind: 'openRaise', seriesId }));
    expect(strangerAgain.detail).toEqual({ stage1: 'NotIssuer' });
    // a cancelled raise is not Draft either (cause S2-E: Stage 1 cancels an Open raise only; a Draft one is RaiseNotOpen)
    const cancelled = await create(h);
    expect((await rejection(h.exec(h.issuer, { kind: 'cancelRaise', seriesId: cancelled }))).detail).toEqual({ stage1: 'RaiseNotOpen' });
    await h.exec(h.issuer, { kind: 'openRaise', seriesId: cancelled });
    await h.exec(h.issuer, { kind: 'cancelRaise', seriesId: cancelled });
    expect((await rejection(h.exec(h.issuer, { kind: 'openRaise', seriesId: cancelled }))).detail).toEqual({ stage1: 'RaiseNotDraft' });
  });

  it('refuses an issuer taken off the allowlist (NotAllowlisted) before the new-raises pause, and after RaiseNotDraft', async () => {
    const h = await issuerHarness('monad');
    const seriesId = await create(h);
    const open = await create(h);
    await h.exec(h.issuer, { kind: 'openRaise', seriesId: open });
    await h.sim.submit({ kind: 'setAllowlist', wallet: h.issuer.address, allowed: false }, 'allowlistManager');
    await h.exec(h.admin, { kind: 'pauseNewRaises', paused: true });
    const e = await rejection(h.exec(h.issuer, { kind: 'openRaise', seriesId }));
    expect([e.code, e.detail]).toEqual(['NotAllowlisted', { stage1: 'NotAllowlisted' }]);
    expect(e.message).toBe('the issuer is not allowlisted');
    expect((await rejection(h.exec(h.issuer, { kind: 'openRaise', seriesId: open }))).detail).toEqual({ stage1: 'RaiseNotDraft' });
    // allowlisted again: the pause refuses next (SIM:876-877)
    await h.sim.submit({ kind: 'setAllowlist', wallet: h.issuer.address, allowed: true }, 'allowlistManager');
    expect((await rejection(h.exec(h.issuer, { kind: 'openRaise', seriesId }))).detail).toEqual({ stage1: 'NewRaisesPaused' });
    await h.exec(h.admin, { kind: 'pauseNewRaises', paused: false });
    expect(types((await h.exec(h.issuer, { kind: 'openRaise', seriesId })).events)).toEqual(['RaiseOpened']);
  });

  it('refuses a series without a contract hash (ContractHashMissing) after RaiseNotDraft and before the allowlist', async () => {
    // createSeries refuses a zero contract hash, so Stage 1's check is unreachable through commands: the state is seeded
    const h = await issuerHarness('solana');
    const seriesId = await create(h);
    seriesOf(h.sim, seriesId).terms.contractHash = '0x' + '00'.repeat(32);
    await h.sim.submit({ kind: 'setAllowlist', wallet: h.issuer.address, allowed: false }, 'allowlistManager');
    const e = await rejection(h.exec(h.issuer, { kind: 'openRaise', seriesId }));
    expect([e.code, e.detail]).toEqual(['InvalidTerms', { stage1: 'ContractHashMissing' }]);
  });

  it('a bid from a wallet off the allowlist carries Stage 1 NotAllowlisted', async () => {
    const h = await issuerHarness('solana');
    const seriesId = await create(h);
    await h.exec(h.issuer, { kind: 'openRaise', seriesId });
    const stranger = h.sim.address('wallet:registry-stranger');
    await h.sim.fund(stranger, 'USDC', USDC(1000));
    const tx = await h.sim.build({ kind: 'commitBid', seriesId, commitment: '0x' + '00'.repeat(32), deposit: '1' }, stranger);
    const e = await rejection(h.sim.send({ tx, signatures: { [stranger]: `sim:${stranger}` } }));
    expect([e.code, e.detail]).toEqual(['NotAllowlisted', { stage1: 'NotAllowlisted' }]);
  });
});
