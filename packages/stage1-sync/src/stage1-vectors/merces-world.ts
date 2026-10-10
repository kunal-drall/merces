import type { AdminCommand, ServiceCommand, ServiceRole, TxResult, UserCommand } from '@merces/domain';
import type { Call } from '@merces/reference';
import { SimulatorChain, serialiseState, type SimSeries, type SimWallet } from '@merces/simulator';
import { Actors } from './actors.ts';
import type { Book, SeriesBook } from './book.ts';
import { RunnerError, classifyChainError, type Raised } from './errors.ts';
import { VectorKeyring } from './keys.ts';
import type { LoadedVector } from './load.ts';
import { translate, type OpContext } from './ops/index.ts';
import { verifyReportCached } from './proofs.ts';
import { checkUnitSupply, mercesSnapshot, seenAfter, totalStable } from './view.ts';
import type { Applied, FxRequest, VectorPersonality, World, WorldOptions } from './world.ts';

/**
 * The merces backend (S1 plan D7, §5): our `SimulatorChain` replaying a Stage 1 vector through the op translators
 * (`ops/`) and the shim table, one fresh chain per vector and personality.
 *
 * - The chain is `createSync` (never persisted) with `acceptMockProofs: false` and, as its `reportProofVerifier`,
 *   the ports' `Groth16ReportVerifier` (Stage 1's verifier, as the API's simulator chains run it) behind the runner's
 *   per-process tally: every report proof is checked for real.
 * - The clock is set to each step's `t` before the step, `expect` and `expect_revert` included (SIM:475-482).
 * - Each op runs atomically: a translator that sends several transactions (or updates the runner's bookkeeping after
 *   one) is undone as a whole if any part throws, so an expected revert leaves state, events and bookkeeping
 *   byte-identical, as a reverted Stage 1 call does.
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

  private constructor(
    readonly vector: LoadedVector,
    readonly personality: VectorPersonality,
  ) {
    this.label = `merces/${personality}`;
    const genesis = vector.steps.length ? Number(vector.steps[0]!.t) : undefined;
    this.chain = SimulatorChain.createSync({
      personality,
      ...(genesis !== undefined ? { genesis } : {}),
      acceptMockProofs: false,
      reportProofVerifier: { verify: (proof, publicInputs) => verifyReportCached(proof, publicInputs) },
    });
    this.actors = new Actors(this.chain.family, vector.name, vector.actors);
    this.keyring = new VectorKeyring(vector.keys);
    this.mint = this.chain.mintOf('USDC');
    this.bookState = { series: {}, seen: [], windowsEnabled: vector.flags.windowsEnabled };
  }

  static async create(vector: LoadedVector, opts: WorldOptions = {}): Promise<MercesWorld> {
    const w = new MercesWorld(vector, opts.personality ?? 'solana');
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
    return this.chain.send(signed);
  }

  submit(cmd: ServiceCommand, role: ServiceRole): Promise<TxResult> {
    return this.chain.submit(cmd, role);
  }

  // ---------------------------------------------------------------- World
  setTime(t: bigint): void {
    const ts = Number(t);
    if (!Number.isSafeInteger(ts)) throw new RunnerError('step time does not fit a safe integer');
    if (ts < this.chain.clock.now()) throw new RunnerError(`time cursor went backwards: ${ts} < ${this.chain.clock.now()}`);
    this.chain.clock.set(ts);
  }

  async apply(call: Call): Promise<Applied> {
    const tr = translate(this, call);
    const applied: Applied = { kind: tr.kind, ...(tr.shimId ? { shimId: tr.shimId } : {}), ...(tr.note ? { note: tr.note } : {}) };
    if (!tr.run) return applied;
    await this.atomic(tr.run);
    this.bookState.seen = seenAfter(this);
    return applied;
  }

  /** Run `fn`; if it throws, restore the chain state, its event log and the bookkeeping, then rethrow. */
  private async atomic(fn: () => Promise<void>): Promise<void> {
    const engine = this.chain.engine;
    const state = structuredClone(engine.state);
    const events = engine.events.length;
    const book = JSON.stringify(this.bookState);
    try {
      await fn();
    } catch (e) {
      engine.state = state;
      engine.events.length = events;
      this.bookState = JSON.parse(book) as Book;
      throw e;
    }
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
