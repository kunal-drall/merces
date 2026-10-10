import type { AdminCommand, ServiceCommand, ServiceRole, TxResult, UserCommand } from '@merces/domain';
import type { Call } from '@merces/reference';
import { SimulatorChain, serialiseState, type SimSeries, type SimState, type SimWallet } from '@merces/simulator';
import { Actors } from './actors.ts';
import type { Book, SeriesBook } from './book.ts';
import { RunnerError, classifyChainError, type Raised } from './errors.ts';
import { VectorKeyring } from './keys.ts';
import type { LoadedVector } from './load.ts';
import { translate, type OpContext } from './ops/index.ts';
import type { Translation, Translator, TranslatorTable } from './ops/types.ts';
import { verifyReportCached } from './proofs.ts';
import { SHIM_BY_ID, type Shim } from './shims.ts';
import { checkUnitSupply, mercesSnapshot, seenAfter, totalStable } from './view.ts';
import type { Applied, Attempt, FxRequest, VectorPersonality, World, WorldOptions } from './world.ts';

/** One op in flight: the engine as the op found it, and its transactions so far (`MercesWorld.attempt`). */
interface OpTrace {
  state: SimState;
  events: number;
  /** transactions that went through */
  committed: number;
  /** a transaction raised and left the engine's state or event log changed (before the runner restored anything) */
  leaked: boolean;
}

/**
 * Shim rows of the caller's own and the translators that use them, for one world: tests only. No row of the shim table
 * is runner-atomic since S3 (SH-CLM-2 became the direct `claimTail`), so the runner-atomic mechanism is exercised on a
 * synthetic row. A translator here replaces the table's for its op; a row here is looked up before the table's.
 */
export interface SyntheticShims {
  rows: readonly Shim[];
  translators: TranslatorTable;
}

export interface MercesWorldOptions extends WorldOptions {
  synthetic?: SyntheticShims;
}

/** What a reverted transaction must leave as it found it: the protocol state and the event log. */
function engineFingerprint(state: SimState, events: number): string {
  return `${events}:${serialiseState(state)}`;
}

/**
 * The merces backend (S1 plan D7, §5): our `SimulatorChain` replaying a Stage 1 vector through the op translators
 * (`ops/`) and the shim table, one fresh chain per vector and personality.
 *
 * - The chain is `createSync` (never persisted) with `acceptMockProofs: false` and, as its `reportProofVerifier`,
 *   the ports' `Groth16ReportVerifier` (Stage 1's verifier, as the API's simulator chains run it) behind the runner's
 *   per-process tally: every report proof is checked for real.
 * - The clock is set to each step's `t` before the step, `expect` and `expect_revert` included (SIM:475-482).
 * - A transaction that raises must leave the engine's state and event log as it found them, checked right after it
 *   raised and before the runner restores anything, so the `expect_revert` check sees the engine's own atomicity
 *   (`Attempt.leaked`). Then the op is undone as a whole: a translator that sends several transactions (or updates the
 *   runner's bookkeeping after one) leaves state, events and bookkeeping byte-identical, as a reverted Stage 1 call
 *   does. Undoing transactions that went through is the runner's atomicity, not the engine's: such a revert is
 *   reported as runner-atomic (`Attempt.rolledBack`). A shim may send more than one transaction only if its row is
 *   marked `runnerAtomic` (no row of the table is since S3; tests use a synthetic row, `SyntheticShims`); the direct
 *   ops that do are `allowlist`, one `setAllowlist` per wallet of its list, and `finalize_settlement`, every tally page
 *   then the finalize.
 * - Errors are compared by their Stage 1 name (`ChainError.detail.stage1`); anything else is reported by class only.
 *
 * Privacy: the vector's `witness` and `seriesPrivate` were dropped at load; the vector keys live only in `keyring`;
 * nothing is persisted or logged.
 */
export class MercesWorld implements World, OpContext {
  readonly backend = 'merces' as const;
  readonly label: string;
  readonly chain: SimulatorChain;
  readonly actors: Actors;
  readonly keyring: VectorKeyring;
  readonly mint: string;
  private bookState: Book;
  /** the op `attempt` is running, while it runs */
  private op: OpTrace | null = null;

  private constructor(
    readonly vector: LoadedVector,
    readonly personality: VectorPersonality,
    private readonly synthetic: SyntheticShims | undefined,
  ) {
    this.label = `merces/${personality}`;
    const genesis = vector.steps.length ? Number(vector.steps[0]!.t) : undefined;
    this.chain = SimulatorChain.createSync({
      personality,
      ...(genesis !== undefined ? { genesis } : {}),
      acceptMockProofs: false,
      reportProofVerifier: { verify: (proof, publicInputs) => verifyReportCached(proof, publicInputs) },
    });
    this.actors = new Actors(this.chain.family, vector.name, vector.actors, vector.keys);
    this.keyring = new VectorKeyring(vector.keys);
    this.mint = this.chain.mintOf('USDC');
    this.bookState = { series: {}, seen: [], windowsEnabled: vector.flags.windowsEnabled };
  }

  static async create(vector: LoadedVector, opts: MercesWorldOptions = {}): Promise<MercesWorld> {
    const w = new MercesWorld(vector, opts.personality ?? 'solana', opts.synthetic);
    // Stage 1 refuses open_raise while new raises are paused (NewRaisesPaused); so does the canonical flag (openRaise)
    if (vector.flags.newRaisesPaused) await w.send(w.actors.admin, { kind: 'pauseNewRaises', paused: true });
    return w;
  }

  // ---------------------------------------------------------------- OpContext
  get book(): Book {
    return this.bookState;
  }

  now(): number {
    return this.chain.clock.now();
  }

  seriesBook(name: string): SeriesBook {
    const b = this.bookState.series[name];
    if (!b) throw new RunnerError(`unknown series ${name}`);
    return b;
  }

  seriesState(name: string): SimSeries {
    const s = this.chain.state.series.get(this.seriesBook(name).seriesId);
    if (!s) throw new RunnerError(`series ${name} is missing from the chain state`);
    return s;
  }

  async send(signer: SimWallet, cmd: UserCommand | AdminCommand, coSigners: SimWallet[] = []): Promise<TxResult> {
    const tx = await this.chain.build(cmd, signer.address, coSigners.map((c) => c.address));
    let signed = await signer.sign(tx);
    for (const c of coSigners) signed = await c.coSign(signed);
    return this.transact(() => this.chain.send(signed));
  }

  submit(cmd: ServiceCommand, role: ServiceRole): Promise<TxResult> {
    return this.transact(() => this.chain.submit(cmd, role));
  }

  /**
   * One transaction of the op in flight. If it raises, the engine must be as it was just before it (the op's own
   * snapshot for its first transaction): a difference is recorded as a leak before anything is restored.
   */
  private async transact(fn: () => Promise<TxResult>): Promise<TxResult> {
    const op = this.op;
    if (!op) return fn();
    const engine = this.chain.engine;
    const before = op.committed === 0 ? undefined : engineFingerprint(engine.state, engine.events.length);
    try {
      const r = await fn();
      op.committed++;
      return r;
    } catch (e) {
      if (engineFingerprint(engine.state, engine.events.length) !== (before ?? engineFingerprint(op.state, op.events))) op.leaked = true;
      throw e;
    }
  }

  // ---------------------------------------------------------------- World
  setTime(t: bigint): void {
    const ts = Number(t);
    if (!Number.isSafeInteger(ts)) throw new RunnerError('step time does not fit a safe integer');
    if (ts < this.chain.clock.now()) throw new RunnerError(`time cursor went backwards: ${ts} < ${this.chain.clock.now()}`);
    this.chain.clock.set(ts);
  }

  async apply(call: Call): Promise<Applied> {
    const a = await this.attempt(call);
    if (!a.ok) throw a.error;
    return a.applied;
  }

  /**
   * Translate and run one call. If any part throws, the transactions' own atomicity has already been checked
   * (`transact`); then the chain state, its event log and the bookkeeping are restored as the op found them.
   */
  async attempt(call: Call): Promise<Attempt> {
    let tr: Translation;
    try {
      const own = this.synthetic?.translators[call.op] as Translator | undefined;
      tr = own ? own(this, call) : translate(this, call);
    } catch (error) {
      return { ok: false, error, leaked: false, rolledBack: 0 };
    }
    const applied: Applied = { kind: tr.kind, ...(tr.shimId ? { shimId: tr.shimId } : {}), ...(tr.note ? { note: tr.note } : {}) };
    if (!tr.run) return { ok: true, applied };
    const engine = this.chain.engine;
    const op: OpTrace = { state: structuredClone(engine.state), events: engine.events.length, committed: 0, leaked: false };
    const book = JSON.stringify(this.bookState);
    this.op = op;
    try {
      await tr.run();
      // the shim table says which rows are runner-atomic; a row that is not must stay one transaction
      if (op.committed > 1 && applied.kind === 'shim' && !this.shimRow(applied.shimId!)?.runnerAtomic) {
        throw new RunnerError(`${call.op} went through ${op.committed} transactions, but shim row ${applied.shimId} is not marked runner-atomic`);
      }
    } catch (error) {
      engine.state = op.state;
      engine.events.length = op.events;
      this.bookState = JSON.parse(book) as Book;
      return { ok: false, error, applied, leaked: op.leaked, rolledBack: op.committed };
    } finally {
      this.op = null;
    }
    this.bookState.seen = seenAfter(this);
    return { ok: true, applied };
  }

  /** A shim row by id: the synthetic rows first (tests), then the shim table. */
  private shimRow(id: string): Shim | undefined {
    return this.synthetic?.rows.find((r) => r.id === id) ?? SHIM_BY_ID.get(id);
  }

  classify(e: unknown): Raised {
    return classifyChainError(e);
  }

  /** The Stage 1 `expect` view. FX accumulators are not modelled before S5, so an `fx` request is not answered. */
  snapshot(series: string | null, _fx?: FxRequest): Record<string, unknown> {
    return mercesSnapshot(this, series, this.now());
  }

  serialize(): string {
    return JSON.stringify({ state: serialiseState(this.chain.state), now: this.chain.clock.now(), events: this.chain.engine.events.length, book: this.bookState });
  }

  totalStable(): bigint {
    return totalStable(this);
  }

  checkUnitSupply(series: string): void {
    checkUnitSupply(this, series);
  }

  async close(): Promise<void> {
    await this.chain.close();
  }
}
