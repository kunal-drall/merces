/** A controllable clock. Tests advance it to cross deadlines, grace periods, lockups and quarters. */
export class SimClock {
  private ts: number;
  constructor(initial: number) {
    this.ts = Math.floor(initial);
  }
  now(): number {
    return this.ts;
  }
  advance(seconds: number): number {
    if (seconds < 0) throw new RangeError('cannot go backwards in time');
    this.ts += Math.floor(seconds);
    return this.ts;
  }
  set(ts: number): number {
    if (ts < this.ts) throw new RangeError('cannot go backwards in time');
    this.ts = Math.floor(ts);
    return this.ts;
  }
}

export const DEFAULT_GENESIS = Date.UTC(2026, 0, 1) / 1000;
