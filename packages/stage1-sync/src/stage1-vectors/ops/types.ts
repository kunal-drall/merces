import type { AdminCommand, ServiceCommand, ServiceRole, TxResult, UserCommand } from '@merces/domain';
import type { Call, CallOp } from '@merces/reference';
import type { SimSeries, SimulatorChain, SimWallet } from '@merces/simulator';
import type { Actors } from '../actors.ts';
import type { Book, SeriesBook } from '../book.ts';
import type { VectorKeyring } from '../keys.ts';
import type { LoadedVector } from '../load.ts';
import type { OpKind } from '../world.ts';

/**
 * How the merces backend runs one Stage 1 op (S1 plan §5.1, §5.3): its kind, the shim-table row when it is a shim
 * (or blocked / n/a), and `run`, the canonical call(s). `blocked` and `n/a` have no `run`: nothing is executed.
 *
 * `run` performs the engine calls first, each through `OpContext.send` or `submit` (the only way a translator changes
 * the engine, apart from `fund`'s faucet credit), and updates the runner's bookkeeping only after they succeeded. The world checks that a transaction
 * that raises leaves the engine as it found it, then restores the whole op (state, events and bookkeeping), so a
 * multi-call shim reverts as one Stage 1 call does; such a shim's row is marked `runnerAtomic` (shims.ts).
 */
export interface Translation {
  kind: OpKind;
  shimId?: string;
  /** why a blocked or n/a op does not run (public text) */
  note?: string;
  run?: () => Promise<void>;
}

export type Translator<C extends Call = Call> = (ctx: OpContext, call: C) => Translation;
export type TranslatorTable = { [K in CallOp]?: Translator<Extract<Call, { op: K }>> };

/** What a translator sees of the merces world. */
export interface OpContext {
  readonly vector: LoadedVector;
  readonly chain: SimulatorChain;
  readonly actors: Actors;
  readonly keyring: VectorKeyring;
  /** the runner bookkeeping (read it fresh inside `run`: an atomic restore replaces it) */
  readonly book: Book;
  /** the USDC mint every vector series uses */
  readonly mint: string;
  now(): number;
  /** the bookkeeping of a vector series name; throws a RunnerError for a series the vector has not created */
  seriesBook(name: string): SeriesBook;
  /** the engine's live state of a vector series name (read it after the calls: a failed call replaces the state) */
  seriesState(name: string): SimSeries;
  /** build, sign and send a user or admin command (one transaction, one signer: nobody co-signs, S4 WP13) */
  send(signer: SimWallet, cmd: UserCommand | AdminCommand): Promise<TxResult>;
  /** submit a service command under one of the backend's roles (one transaction) */
  submit(cmd: ServiceCommand, role: ServiceRole): Promise<TxResult>;
}

export const direct = (run: () => Promise<void>): Translation => ({ kind: 'direct', run });
export const shim = (shimId: string, run: () => Promise<void>): Translation => ({ kind: 'shim', shimId, run });
export const blocked = (shimId: string | undefined, note: string): Translation => ({ kind: 'blocked', ...(shimId ? { shimId } : {}), note });
export const notApplicable = (shimId: string, note: string): Translation => ({ kind: 'n/a', shimId, note });

/** The payload of the first event of `type` a transaction emitted (public fields only). */
export function eventOf<T = Record<string, unknown>>(r: TxResult, type: string): T | null {
  const e = r.events.find((x) => x.type === type);
  return e ? (e.payload as T) : null;
}
