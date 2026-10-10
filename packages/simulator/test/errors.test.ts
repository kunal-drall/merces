import { describe, expect, it } from 'vitest';
import { ChainError, bidCommitment } from '@merces/domain';
import { isErrorName } from '@merces/math';
import { SimHarness, defaultTerms } from '../src/index.ts';
import { STAGE1_CODE, fail, guardStage1 } from '../src/engine/errors.ts';
import { GENESIS } from './helpers.ts';

/*
 * S2 cause codes:
 *  - S2-AD: commit and reveal durations are series terms; `openRaise` derives the phase ends from them;
 *  - S2-CR: Stage 1's creation rules on the raise's own terms (commit 1 hour–30 days, reveal 1 hour–7 days, non-reveal
 *    charge 0–1,000 bps).
 */
async function rejection(p: Promise<unknown>): Promise<ChainError> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ChainError);
  return e as ChainError;
}

describe('Stage 1 error names on simulator errors', () => {
  it('every STAGE1_CODE key is a Stage 1 error name', () => {
    for (const name of Object.keys(STAGE1_CODE)) expect(isErrorName(name), name).toBe(true);
  });

  it('fail() throws the mapped ChainError code with detail.stage1', () => {
    const e = (() => {
      try {
        fail('HolderNotRegistered', 'no registration', { wallet: 'w' });
      } catch (x) {
        return x as ChainError;
      }
    })()!;
    expect(e).toBeInstanceOf(ChainError);
    expect(e.code).toBe('NotFound');
    expect(e.message).toBe('no registration');
    expect(e.detail).toEqual({ wallet: 'w', stage1: 'HolderNotRegistered' });
  });

  it('guardStage1 drops the message of a Stage 1 exception, so no value leaks', () => {
    let caught: unknown;
    try {
      guardStage1(() => {
        throw new RangeError('x out of range: 123');
      }, 'AmountOutOfRange');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ChainError);
    const e = caught as ChainError;
    expect(e.code).toBe('ChainSpecific');
    // no digit at all once the word "stage1" (the message and the detail key) is set aside
    const digits = (x: string): boolean => /\d/.test(x.replace(/stage1/gi, ''));
    expect(e.message).toBe('stage1 math rejected the inputs');
    expect(digits(e.message)).toBe(false);
    expect(digits(JSON.stringify(e.detail))).toBe(false);
    expect(e.stack ?? '').not.toContain('123');
    expect(e.detail).toEqual({ stage1: 'AmountOutOfRange' });
    // a ChainError passes through untouched, and a result is returned as is
    const own = new ChainError('WrongStatus', 'mine', { stage1: 'TerminalStatus' });
    expect(() => guardStage1(() => { throw own; }, 'AmountOutOfRange')).toThrow(own);
    expect(guardStage1(() => 7n, 'AmountOutOfRange')).toBe(7n);
  });

  it('createSeries refuses due, grace and notice days other than Stage 1 fixed values (ParameterOutOfBounds)', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    for (const over of [{ graceDays: 14 }, { dueDays: 31 }, { formalNoticeDays: 120 }]) {
      const { terms } = defaultTerms(h.sim, over);
      const e = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms }));
      expect(e.code).toBe('InvalidTerms');
      expect(e.detail).toEqual({ stage1: 'ParameterOutOfBounds' });
    }
    const ok = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms });
    expect(ok.events[0]!.type).toBe('SeriesCreated');
  });

  // Stage 1 create_series (SIM:756-781): every bounded parameter (PARAMETER_BOUNDS), the units, reserve and minimum raise,
  // a wallet cap of at least one unit, and the release schedule (review finding: createSeries checked only the cap, the
  // fixed day counts and the bps sum)
  it('createSeries refuses what Stage 1 create_series refuses, with its error name, and accepts the bounds themselves', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    const WAD = 10n ** 18n;
    const YEAR = 365 * 86_400;
    const decreasing = [{ afterSeconds: 90 * 86_400, bps: 5000 }, { afterSeconds: 0, bps: 5000 }];
    const tranches = (n: number) => Array.from({ length: n }, (_, i) => ({ afterSeconds: i * 86_400, bps: i < n - 1 ? 400 : 10_000 - 400 * (n - 1) }));
    const cases: [string, Parameters<typeof defaultTerms>[1], string][] = [
      ['cap above 3.0', { capMultipleWad: String(3n * WAD + 1n) }, 'ParameterOutOfBounds'],
      ['cap below 2.0', { capMultipleWad: String(2n * WAD - 1n) }, 'ParameterOutOfBounds'],
      ['hurdle above 0.25', { hurdleWad: String(WAD / 4n + 1n) }, 'ParameterOutOfBounds'],
      ['k above 20', { payoutMultipleK: 21 }, 'ParameterOutOfBounds'],
      ['lockup above 5 years', { lockupSeconds: 5 * YEAR + 1 }, 'ParameterOutOfBounds'],
      ['wallet cap below 1%', { walletCapBps: 99 }, 'ParameterOutOfBounds'],
      ['auction fee above 10%', { auctionFeeBps: 1001 }, 'ParameterOutOfBounds'],
      ['payout fee above 20%', { payoutFeeBps: 2001 }, 'ParameterOutOfBounds'],
      // cause S2-CR: the raise's own terms (S2), bounded on a sealed raise
      ['non-reveal charge above 10%', { nonRevealChargeBps: 1001 }, 'ParameterOutOfBounds'],
      ['commit phase below an hour', { commitDurationSeconds: 3599 }, 'ParameterOutOfBounds'],
      ['commit phase above 30 days', { commitDurationSeconds: 30 * 86_400 + 1 }, 'ParameterOutOfBounds'],
      ['reveal phase below an hour', { revealDurationSeconds: 3599 }, 'ParameterOutOfBounds'],
      ['reveal phase above 7 days', { revealDurationSeconds: 7 * 86_400 + 1 }, 'ParameterOutOfBounds'],
      ['reserve price 0', { reservePrice: '0', minimumRaise: '0' }, 'InvalidTerms'],
      ['minimum raise above reserve × units', { minimumRaise: String(500n * 8_000_000n + 1n) }, 'InvalidTerms'],
      ['wallet cap below one unit', { unitsOffered: '9', walletCapBps: 1000, minimumRaise: '0' }, 'InvalidTerms'],
      ['release offsets decrease', { releaseSchedule: decreasing }, 'InvalidReleaseSchedule'],
      ['25 release tranches', { releaseSchedule: tranches(25) }, 'InvalidReleaseSchedule'],
      ['release bps sum 9000', { releaseSchedule: [{ afterSeconds: 0, bps: 9000 }] }, 'InvalidReleaseSchedule'],
      // Stage 1's order: the bounded parameters before the terms, the terms before the release schedule
      ['hurdle and schedule', { hurdleWad: String(WAD / 2n), releaseSchedule: decreasing }, 'ParameterOutOfBounds'],
      ['unreachable raise and schedule', { minimumRaise: String(500n * 8_000_000n + 1n), releaseSchedule: decreasing }, 'InvalidTerms'],
    ];
    for (const [name, over, stage1] of cases) {
      const e = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, over).terms }));
      expect(e.code, name).toBe('InvalidTerms');
      expect(e.detail, name).toEqual({ stage1 });
    }
    // the message names the field and the bound, never the submitted value
    const hurdle = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, { hurdleWad: String(WAD / 2n) }).terms }));
    expect(hurdle.message).toBe('hurdle rate must be between 0 and 0.25');
    expect(JSON.stringify([hurdle.message, hurdle.detail])).not.toMatch(/0\.5|500000000000000000/);
    // nothing was created by the refusals; terms at every bound are accepted
    expect(await h.sim.listSeries()).toHaveLength(0);
    const atBounds = defaultTerms(h.sim, { capMultipleWad: String(2n * WAD), hurdleWad: String(WAD / 4n), payoutMultipleK: 20, lockupSeconds: 5 * YEAR, walletCapBps: 100, auctionFeeBps: 1000, payoutFeeBps: 2000, releaseSchedule: tranches(24) }).terms;
    expect((await h.exec(h.issuer, { kind: 'createSeries', terms: atBounds })).events[0]!.type).toBe('SeriesCreated');
    // cause S2-CR: the raise's own terms at their bounds, both ends
    for (const over of [{ nonRevealChargeBps: 1000, commitDurationSeconds: 30 * 86_400, revealDurationSeconds: 7 * 86_400 }, { nonRevealChargeBps: 0, commitDurationSeconds: 3600, revealDurationSeconds: 3600 }]) {
      expect((await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim, over).terms })).events[0]!.type).toBe('SeriesCreated');
    }
  });

  // Stage 1 refuses open_raise while new raises are paused (NewRaisesPaused, SIM:875), not create_series; a curve raise
  // starts at creation, which Stage 1 refuses as the curve's activation (registry mark_curve_activated)
  it('new raises paused: a sealed series is still created and openRaise refuses NewRaisesPaused; a curve raise is refused', async () => {
    const h = await SimHarness.create('solana', { genesis: GENESIS });
    await h.exec(h.issuer, { kind: 'registerIssuer' });
    await h.exec(h.admin, { kind: 'pauseNewRaises', paused: true });
    const created = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms });
    expect(created.events[0]!.type).toBe('SeriesCreated');
    const seriesId = (created.events[0]!.payload as { seriesId: string }).seriesId;
    const open = await rejection(h.exec(h.issuer, { kind: 'openRaise', seriesId })); // cause S2-AD: the ends come from the terms
    expect(open.code).toBe('Paused');
    expect(open.detail).toEqual({ stage1: 'NewRaisesPaused' });
    const curve = defaultTerms(h.sim, { raiseStyle: 'curve', minimumRaise: '2000000000', reservePrice: '5000000', unitsOffered: '1000' }).terms;
    const refused = await rejection(h.exec(h.issuer, { kind: 'createSeries', terms: curve }));
    expect(refused.code).toBe('Paused');
    expect(refused.detail).toEqual({ stage1: 'NewRaisesPaused' });
    await h.exec(h.admin, { kind: 'pauseNewRaises', paused: false });
    await h.exec(h.issuer, { kind: 'openRaise', seriesId });
    expect((await h.exec(h.issuer, { kind: 'createSeries', terms: curve })).events.map((x) => x.type)).toEqual(['SeriesCreated', 'CurveSeriesCreated']);
  });

  it('a debit beyond the balance is InsufficientFunds with Stage 1 name InsufficientEscrow', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await (async () => {
      await h.exec(h.issuer, { kind: 'registerIssuer' });
      const created = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms });
      return { seriesId: (created.events[0]!.payload as { seriesId: string }).seriesId };
    })();
    await h.exec(h.issuer, { kind: 'openRaise', seriesId }); // cause S2-AD
    const w = h.backers[0]!;
    const commitment = bidCommitment({ seriesId, bidder: w.address, pricePerUnit: 10n, quantity: 1n, salt: '0x' + '01'.repeat(32) });
    const e = await rejection(h.exec(w, { kind: 'commitBid', seriesId, commitment, deposit: (2_000_000_000_000n).toString() }));
    expect(e.code).toBe('InsufficientFunds');
    expect(e.detail).toEqual({ stage1: 'InsufficientEscrow' });
  });
});
