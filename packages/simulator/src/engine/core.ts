import type { EventPayload, EventType, LifecycleStatus } from '@merces/domain';
import type { SimClock } from '../clock.ts';
import type { SimSeries, SimState } from '../state.ts';

export interface EngineOptions {
  /** Optional real Groth16 verifier (wired once Stage 1's circuit exists). */
  groth16Verifier?: (proof: string, publicInputs: string[]) => boolean;
}

/**
 * What every engine module sees of the engine: the state, the clock, the options and the shared guards and
 * balance moves. `state` is replaced when a transaction fails, so modules read `e.state` each time and never keep it.
 */
export interface EngineCore {
  readonly state: SimState;
  readonly clock: SimClock;
  readonly opts: EngineOptions;
  series(id: string): SimSeries;
  requireIssuer(s: SimSeries, signer: string): void;
  requireAllowlisted(wallet: string): void;
  requireAttestor(a: string): void;
  credit(wallet: string, mint: string, amount: bigint): void;
  debit(wallet: string, mint: string, amount: bigint): void;
}

export type Emit = <T extends EventType>(type: T, payload: EventPayload<T>) => void;

export const TERMINAL: ReadonlySet<LifecycleStatus> = new Set(['Retired', 'Redeemed', 'Extinguished']);

export function big(x: string): bigint {
  return BigInt(x);
}
export function str(x: bigint): string {
  return x.toString();
}
export function balKey(wallet: string, mint: string): string {
  return `${wallet}|${mint}`;
}
