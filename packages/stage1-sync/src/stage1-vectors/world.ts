import type { Call } from '@merces/reference';
import type { Raised } from './errors.ts';
import type { LoadedVector } from './load.ts';

/** The backends a vector replays on (S1 plan D7). */
export type Backend = 'reference' | 'merces';
export const PERSONALITIES = ['solana', 'monad'] as const;
export type VectorPersonality = (typeof PERSONALITIES)[number];

/**
 * How a world carried out a Stage 1 op (S1 plan §5.1, §5.3):
 * - `direct`: one call with the same meaning;
 * - `shim`: our call does the job in another shape (`shimId` names the row of the shim table; not parity);
 * - `blocked`: the op cannot run on this backend yet; nothing was executed;
 * - `n/a`: the op has no meaning on this backend (e.g. a transfer our model cannot express); nothing was executed.
 */
export type OpKind = 'direct' | 'shim' | 'blocked' | 'n/a';
export interface Applied {
  kind: OpKind;
  shimId?: string;
  /** why a blocked or n/a op did not run (public text) */
  note?: string;
}

/** `expect.fx` request: pair id → the periods whose quarter averages the step checks. */
export type FxRequest = Record<string, number[]>;

/**
 * One fresh protocol instance a vector replays on. Everything it returns is public (vector actors' balances, ledger
 * views, error names); it never persists anything.
 */
export interface World {
  readonly backend: Backend;
  /** "reference", "merces/solana", … */
  readonly label: string;
  /** Warp the clock to `t` (the vector's block time) before a step, `expect` and `expect_revert` included (SIM:475-482). */
  setTime(t: bigint): void;
  /** Run one action. Throws what the protocol raised when it reverts. */
  apply(call: Call): Promise<Applied>;
  /** Classify an error `apply` threw. */
  classify(e: unknown): Raised;
  /**
   * The `expect` view (Stage 1 `Simulator.expect`, SIM:1760-1804): `balances`, `feeCollector` and, for a series,
   * `treasury`, `vault`, `auctionEscrow`, window escrows, `ledger`, `auction`, `holders`; `fx` on request.
   */
  snapshot(series: string | null, fx?: FxRequest): Record<string, unknown>;
  /** Deterministic serialisation of everything a reverted call must leave unchanged (state, clock, events, bookkeeping). */
  serialize(): string;
  /** Σ stablecoin over every account and pool; only `fund` changes it. */
  totalStable(): bigint;
  /** Holder units + escrows = supply for the series; throws a `RunnerError` with public counts otherwise (SIM:1833-1839). */
  checkUnitSupply(series: string): void;
  close(): Promise<void>;
}

export interface WorldOptions {
  personality?: VectorPersonality;
}

export type WorldFactory = (vector: LoadedVector, opts: WorldOptions) => Promise<World>;
