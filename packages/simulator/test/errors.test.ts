import { describe, expect, it } from 'vitest';
import { ChainError, bidCommitment } from '@merces/domain';
import { isErrorName } from '@merces/math';
import { SimHarness, defaultTerms } from '../src/index.ts';
import { STAGE1_CODE, fail, guardStage1 } from '../src/engine/errors.ts';
import { GENESIS } from './helpers.ts';

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

  it('a debit beyond the balance is InsufficientFunds with Stage 1 name InsufficientEscrow', async () => {
    const h = await SimHarness.create('monad', { genesis: GENESIS });
    const { seriesId } = await (async () => {
      await h.exec(h.issuer, { kind: 'registerIssuer' });
      const created = await h.exec(h.issuer, { kind: 'createSeries', terms: defaultTerms(h.sim).terms });
      return { seriesId: (created.events[0]!.payload as { seriesId: string }).seriesId };
    })();
    const now = await h.sim.now();
    await h.exec(h.issuer, { kind: 'openRaise', seriesId, commitEndsAt: now + 86_400, revealEndsAt: now + 2 * 86_400 });
    const w = h.backers[0]!;
    const commitment = bidCommitment({ seriesId, bidder: w.address, pricePerUnit: 10n, quantity: 1n, salt: '0x' + '01'.repeat(32) });
    const e = await rejection(h.exec(w, { kind: 'commitBid', seriesId, commitment, deposit: (2_000_000_000_000n).toString() }));
    expect(e.code).toBe('InsufficientFunds');
    expect(e.detail).toEqual({ stage1: 'InsufficientEscrow' });
  });
});
