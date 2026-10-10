import { describe, expect, it } from 'vitest';
import { DAY, DEFAULT_PARAMETERS, YEAR, pauseApprovalError, type Pause } from '@merces/math';
import { PAUSE_APPROVAL_MESSAGE, noPauseApprovable, pauseApprovalRefusal, pauseBounds, type SeriesPauses } from '../src/index.ts';

/**
 * S1 review: the attestor service recorded 'approved' for pauses Stage 1's approve_pause refuses. It now checks a decision
 * with `pauseApprovalRefusal` over the chain's pause read (`SeriesState.pauses`), which must answer exactly as Stage 1's
 * `pauseApprovalError` does over the full pause list.
 */
const T0 = 1_800_000_000;
const D = Number(DAY);
const Y = Number(YEAR);

/** The chain's read of a pause list at `now`, as the simulator projects it (reads/series.ts). */
function viewOf(pauses: Pause[], now: number): Pick<SeriesPauses, 'count' | 'pausedTotalSeconds' | 'current'> {
  const cur = pauses.find((p) => p.start <= BigInt(now) && BigInt(now) < p.end) ?? null;
  return { count: pauses.length, pausedTotalSeconds: Number(pauses.reduce((a, p) => a + (p.end - p.start), 0n)), current: cur ? { start: Number(cur.start), end: Number(cur.end) } : null };
}

/** A deterministic generator (xorshift32), so a failure reproduces. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

describe('hardship pause approval rules (Stage 1 approve_pause)', () => {
  it('uses Stage 1\'s pause parameters', () => {
    expect(pauseBounds()).toEqual({ maxPauseSeconds: DEFAULT_PARAMETERS.maxPauseSeconds, maxCumulativePauseSeconds: DEFAULT_PARAMETERS.maxCumulativePauseSeconds, maxPauses: DEFAULT_PARAMETERS.maxPauses });
  });

  it('answers each rule as Stage 1 does', () => {
    const none = { count: 0, pausedTotalSeconds: 0, current: null };
    expect(pauseApprovalRefusal(none, T0, T0)).toBe('InvalidPauseEnd');
    expect(pauseApprovalRefusal(none, T0, T0 - 1)).toBe('InvalidPauseEnd');
    expect(pauseApprovalRefusal(none, T0, T0 + 1)).toBeNull();
    // one year per pause, inclusive
    expect(pauseApprovalRefusal(none, T0, T0 + Y)).toBeNull();
    expect(pauseApprovalRefusal(none, T0, T0 + Y + 1)).toBe('PauseTooLong');
    // two years in total, inclusive, counting every approved length
    const used = { count: 2, pausedTotalSeconds: 2 * Y - 30 * D, current: null };
    expect(pauseApprovalRefusal(used, T0, T0 + 30 * D)).toBeNull();
    expect(pauseApprovalRefusal(used, T0, T0 + 30 * D + 1)).toBe('PauseTooLong');
    // 16 pauses
    expect(pauseApprovalRefusal({ count: 15, pausedTotalSeconds: 15 * D, current: null }, T0, T0 + D)).toBeNull();
    expect(pauseApprovalRefusal({ count: 16, pausedTotalSeconds: 16 * D, current: null }, T0, T0 + D)).toBe('TooManyPauses');
    // a running pause, until its end (exclusive)
    const running = { count: 1, pausedTotalSeconds: 10 * D, current: { start: T0 - 5 * D, end: T0 + 5 * D } };
    expect(pauseApprovalRefusal(running, T0, T0 + D)).toBe('AlreadyPaused');
    expect(pauseApprovalRefusal({ ...running, current: null }, T0 + 5 * D, T0 + 6 * D)).toBeNull();
    // Stage 1's order: the end first, then a running pause, the lengths, the count
    expect(pauseApprovalRefusal({ count: 16, pausedTotalSeconds: 2 * Y, current: running.current }, T0, T0)).toBe('InvalidPauseEnd');
    expect(pauseApprovalRefusal({ count: 16, pausedTotalSeconds: 2 * Y, current: running.current }, T0, T0 + D)).toBe('AlreadyPaused');
    expect(pauseApprovalRefusal({ count: 16, pausedTotalSeconds: 2 * Y, current: null }, T0, T0 + D)).toBe('PauseTooLong');
  });

  it('over the chain\'s pause read, agrees with Stage 1\'s pauseApprovalError over the full pause list', () => {
    const next = rng(0x5eed);
    const bounds = pauseBounds();
    let checked = 0;
    for (let run = 0; run < 400; run++) {
      // a history Stage 1 could hold: approved pauses one after another, each within the bounds, gaps between them
      const pauses: Pause[] = [];
      let t = T0;
      let total = 0;
      const n = Math.floor(next() * 18);
      for (let i = 0; i < n && pauses.length < bounds.maxPauses; i++) {
        t += Math.floor(next() * 120 * D);
        const len = 1 + Math.floor(next() * Math.min(Y, 2 * Y - total));
        if (total + len > 2 * Y) break;
        pauses.push({ start: BigInt(t), end: BigInt(t + len) });
        total += len;
        t += len;
      }
      // decide at a moment inside or after the history, for ends around every bound
      const last = pauses.length ? Number(pauses[pauses.length - 1]!.end) : T0;
      const nows = [last - 1, last, last + 1 + Math.floor(next() * 90 * D)];
      if (pauses.length) nows.push(Number(pauses[pauses.length - 1]!.start) + Math.floor(next() * Number(pauses[pauses.length - 1]!.end - pauses[pauses.length - 1]!.start)));
      for (const now of nows) {
        const left = 2 * Y - total;
        for (const len of [-1, 0, 1, D, left, left + 1, Y, Y + 1, Math.floor(next() * 2 * Y)]) {
          const until = now + len;
          expect(pauseApprovalRefusal(viewOf(pauses, now), now, until), `run ${run} now ${now} len ${len}`).toBe(pauseApprovalError(pauses, BigInt(total), BigInt(now), BigInt(until), bounds));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it('knows when no pause can be approved at all (a request is refused before it is sent)', () => {
    expect(noPauseApprovable({ count: 0, pausedTotalSeconds: 0, current: null }, T0)).toBeNull();
    expect(noPauseApprovable({ count: 3, pausedTotalSeconds: 2 * Y - 1, current: null }, T0)).toBeNull();
    expect(noPauseApprovable({ count: 3, pausedTotalSeconds: 2 * Y, current: null }, T0)).toBe('PauseTooLong');
    expect(noPauseApprovable({ count: 16, pausedTotalSeconds: 16 * D, current: null }, T0)).toBe('TooManyPauses');
    // a running pause is the 409 for a paused series, not this check
    expect(noPauseApprovable({ count: 1, pausedTotalSeconds: 10 * D, current: { start: T0 - D, end: T0 + 9 * D } }, T0)).toBeNull();
  });

  it('messages name the rule and the protocol bound, never a date', () => {
    expect(PAUSE_APPROVAL_MESSAGE).toEqual({
      InvalidPauseEnd: 'the pause end must be in the future',
      AlreadyPaused: 'a pause is already running',
      PauseTooLong: 'a pause may last at most 365 days, and the series\' pauses 730 days in total',
      TooManyPauses: 'the series has used all 16 of its pauses',
    });
  });
});
