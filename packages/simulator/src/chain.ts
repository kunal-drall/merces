import {
  ChainError, adminCommandSchema, permissionlessCommandSchema, serviceCommandSchema, userCommandSchema,
  type AdminCommand, type AuctionState, type BidState, type ChainInfo, type ChainPort, type CurveState, type CurveSwapQuote, type DomainEvent, type HealthReport,
  type Groth16ProofJson, type IssuerState, type PeriodState, type PositionState, type QuarterRateState, type RateAccumulatorState, type RedemptionState, type SeriesState,
  type PermissionlessCommand, type ServiceCommand, type ServiceRole, type SignedTx, type Stablecoin, type TransferWindowState, type TreasuryState, type TxResult, type UnsignedTx,
  type UserCommand, type VaultState,
} from '@merces/domain';
import { wadToDecimal } from '@merces/math';
import { DEFAULT_GENESIS, SimClock } from './clock.ts';
import { deriveAddress, personalityConfig, personalityLimits, type Personality } from './addresses.ts';
import { SimEngine, type EngineOptions } from './engine.ts';
import { SIM_STATE_VERSION, type SimState } from './state.ts';
import { stage1View, type Stage1View } from './stage1-view.ts';
import type { SimPersistence } from './persistence.ts';
import { toAuctionState, toBid } from './reads/auction.ts';
import { toCurveState, toCurveSwapQuote } from './reads/curve.ts';
import { curveOf, dammTrade, migrateCurve, releaseLockedUnits } from './engine/curve.ts';
import { balKey } from './engine/core.ts';
import { toQuarterRate, toRateAccumulator } from './reads/fx.ts';
import { listPeriodStates, toPeriodState } from './reads/periods.ts';
import { listPositionStates, toPosition } from './reads/positions.ts';
import { toRedemption } from './reads/redemption.ts';
import { toIssuerState, toSeriesState } from './reads/series.ts';
import { toTreasuryState } from './reads/treasury.ts';
import { toVaultState } from './reads/vault.ts';
import { toTransferWindow } from './reads/window.ts';

/**
 * `acceptMockProofs` (default false) and `reportProofVerifier` come from `EngineOptions`: a simulator accepts mock
 * report proofs only when told to, and verifies Groth16 proofs only with a verifier. They are process configuration,
 * never persisted with the chain state.
 */
export interface SimulatorOptions extends EngineOptions {
  personality: Personality;
  /** chain key used in ids (defaults to the personality name) */
  chainKey?: string;
  genesis?: number;
  persistence?: SimPersistence;
  /** pre-funded test addresses (see wallets.ts) */
  seedAllowlist?: string[];
}

const s = (x: bigint): string => x.toString();

export class SimulatorChain implements ChainPort {
  readonly family;
  readonly mode = 'mock' as const;
  readonly chain: string;
  readonly clock: SimClock;
  readonly engine: SimEngine;
  readonly personality: Personality;
  private readonly persistence: SimPersistence | null;
  private chainQueue: Promise<void> = Promise.resolve();

  private constructor(opts: SimulatorOptions, state: SimState, events: DomainEvent[], clock: SimClock) {
    this.personality = opts.personality;
    const cfg = state.config;
    this.family = cfg.family;
    this.chain = cfg.chain;
    this.clock = clock;
    this.engine = new SimEngine(state, clock, { acceptMockProofs: opts.acceptMockProofs ?? false, reportProofVerifier: opts.reportProofVerifier });
    this.engine.events = events;
    this.persistence = opts.persistence ?? null;
  }

  static async create(opts: SimulatorOptions): Promise<SimulatorChain> {
    const cfg = personalityConfig(opts.personality, opts.chainKey);
    if (opts.persistence) {
      const loaded = await opts.persistence.load();
      if (loaded) {
        return new SimulatorChain(opts, loaded.state, loaded.events, new SimClock(loaded.clock));
      }
    }
    const state: SimState = {
      version: SIM_STATE_VERSION,
      config: cfg,
      admin: deriveAddress(cfg.family, 'role:admin'),
      feeCollector: deriveAddress(cfg.family, 'role:feeCollector'),
      keeper: deriveAddress(cfg.family, 'role:keeper'),
      allowlistManager: deriveAddress(cfg.family, 'role:allowlistManager'),
      newRaisesPaused: false,
      seq: 0,
      txCount: 0,
      balances: new Map(),
      allowlist: new Set(opts.seedAllowlist ?? []),
      attestors: new Map(),
      verifierKeys: new Map(),
      issuers: new Map(),
      series: new Map(),
      rates: new Map(),
      fxFallbacks: new Map(),
    };
    const sim = new SimulatorChain(opts, state, [], new SimClock(opts.genesis ?? DEFAULT_GENESIS));
    if (opts.persistence) await opts.persistence.save(state, [], sim.clock.now(), 0);
    return sim;
  }

  /** Release the persisted chain (its single-writer lock) so another process may open it. */
  async close(): Promise<void> {
    // let an in-flight write finish its save before the lock is released
    await this.chainQueue;
    await this.persistence?.close?.();
  }

  /** Synchronous creation for tests without persistence. */
  static createSync(opts: Omit<SimulatorOptions, 'persistence'>): SimulatorChain {
    const cfg = personalityConfig(opts.personality, opts.chainKey);
    const state: SimState = {
      version: SIM_STATE_VERSION,
      config: cfg,
      admin: deriveAddress(cfg.family, 'role:admin'),
      feeCollector: deriveAddress(cfg.family, 'role:feeCollector'),
      keeper: deriveAddress(cfg.family, 'role:keeper'),
      allowlistManager: deriveAddress(cfg.family, 'role:allowlistManager'),
      newRaisesPaused: false, seq: 0, txCount: 0, balances: new Map(), allowlist: new Set(opts.seedAllowlist ?? []), attestors: new Map(), verifierKeys: new Map(), issuers: new Map(), series: new Map(), rates: new Map(), fxFallbacks: new Map(),
    };
    return new SimulatorChain(opts, state, [], new SimClock(opts.genesis ?? DEFAULT_GENESIS));
  }

  // ---------------------------------------------------------------- test hooks (not part of ChainPort)
  get state(): SimState {
    return this.engine.state;
  }
  get admin(): string {
    return this.state.admin;
  }
  address(label: string): string {
    return deriveAddress(this.family, label);
  }
  mintOf(coin: Stablecoin): string {
    const c = this.state.config.stablecoins[coin];
    if (!c) throw new ChainError('NotFound', `${coin} not on ${this.chain}`);
    return c.mint;
  }
  /** Faucet. */
  async fund(wallet: string, coin: Stablecoin, amount: bigint): Promise<void> {
    this.engine.fund(wallet, this.mintOf(coin), amount);
    await this.persist();
  }
  async advanceTime(seconds: number): Promise<number> {
    const t = this.clock.advance(seconds);
    await this.persist();
    return t;
  }
  async setTime(ts: number): Promise<number> {
    const t = this.clock.set(ts);
    await this.persist();
    return t;
  }
  /**
   * Stage 1's view of a series at the current time: the vector `expect` ledger, the money pools and the registered
   * holders, built from the simulator state (see stage1-view.ts). The vector runner and white-box tests read it.
   */
  stage1View(seriesId: string): Stage1View {
    const x = this.state.series.get(seriesId);
    if (!x) throw new ChainError('NotFound', `series ${seriesId} not found`);
    return stage1View(x, this.clock.now());
  }
  /** A wallet's base lamports of a curve series' unit mint (its token balance; a curve's units live in wallets). */
  curveUnitsOf(seriesId: string, wallet: string): bigint {
    const x = this.state.series.get(seriesId);
    if (!x?.curve) throw new ChainError('NotFound', `curve series ${seriesId} not found`);
    return this.state.balances.get(balKey(wallet, x.curve.baseMint)) ?? 0n;
  }
  /**
   * Curve stand-in hooks (base lamports only; like `fund`, not reachable through ChainPort): the migration to the DAMM
   * pool, a locker release to `to` and a DAMM trade (`units > 0` to the wallet, `< 0` from it). Atomic: a refused hook
   * changes nothing.
   */
  async curveHook(seriesId: string, hook: { kind: 'migrate'; protocolBaseFee?: bigint; leftover?: bigint } | { kind: 'lockerRelease'; to: string; units: bigint } | { kind: 'dammTrade'; wallet: string; units: bigint }): Promise<void> {
    await this.run(() => {
      const backup = structuredClone(this.engine.state);
      try {
        const x = this.engine.series(seriesId);
        curveOf(x);
        if (hook.kind === 'migrate') migrateCurve(this.engine, x, hook);
        else if (hook.kind === 'lockerRelease') releaseLockedUnits(this.engine, x, hook.to, hook.units);
        else dammTrade(this.engine, x, hook.wallet, hook.units);
      } catch (e) {
        this.engine.state = backup;
        throw e;
      }
    });
  }
  /** Tier-1 router hook: a registered split router posts a receipt. */
  async postSplitReceipt(router: string, seriesId: string, amount: bigint): Promise<TxResult> {
    return this.run(() => this.engine.execute({ kind: 'postSplitReceipt', seriesId, amount: s(amount) }, { kind: 'router', router }));
  }
  private async persist(): Promise<void> {
    if (this.persistence) await this.persistence.save(this.state, this.engine.events, this.clock.now(), this.engine.events.length);
  }
  private async run<T>(fn: () => T): Promise<T> {
    // serialise all writes so persistence sees a consistent state
    let result!: T;
    const p = this.chainQueue.then(async () => {
      result = fn();
      await this.persist();
    });
    this.chainQueue = p.catch(() => undefined);
    await p;
    return result;
  }

  // ---------------------------------------------------------------- info
  async info(): Promise<ChainInfo> {
    const st = this.state;
    return { chain: this.chain, family: this.family, mode: 'mock', network: st.config.network, stablecoins: st.config.stablecoins, modules: { simulator: this.address('program:simulator') }, admin: st.admin, feeCollector: st.feeCollector, newRaisesPaused: st.newRaisesPaused, limits: personalityLimits(st.config.personality) };
  }
  async health(): Promise<HealthReport> {
    return { ok: true, mode: 'mock', latency_ms: 0, detail: `simulator ${this.personality} at t=${this.clock.now()}` };
  }
  async now(): Promise<number> {
    return this.clock.now();
  }

  // ---------------------------------------------------------------- reads (the mappers live in ./reads/)
  async getIssuer(issuer: string): Promise<IssuerState | null> {
    const i = this.state.issuers.get(issuer);
    return i ? toIssuerState(i) : null;
  }
  async listSeries(): Promise<SeriesState[]> {
    return [...this.state.series.values()].map((x) => toSeriesState(this.chain, x, this.clock.now()));
  }
  async getSeries(seriesId: string): Promise<SeriesState | null> {
    const x = this.state.series.get(seriesId);
    return x ? toSeriesState(this.chain, x, this.clock.now()) : null;
  }
  async getAuction(seriesId: string): Promise<AuctionState | null> {
    const x = this.state.series.get(seriesId);
    if (!x) return null;
    return toAuctionState(seriesId, x, this.clock.now());
  }
  async getBid(seriesId: string, bidder: string): Promise<BidState | null> {
    const b = this.state.series.get(seriesId)?.bids.get(bidder);
    return b ? toBid(seriesId, b) : null;
  }
  async listBids(seriesId: string): Promise<BidState[]> {
    const x = this.state.series.get(seriesId);
    return x ? [...x.bids.values()].map((b) => toBid(seriesId, b)) : [];
  }
  async getTreasury(seriesId: string): Promise<TreasuryState | null> {
    const x = this.state.series.get(seriesId);
    if (!x) return null;
    return toTreasuryState(seriesId, x, this.clock.now());
  }
  async getVault(seriesId: string): Promise<VaultState | null> {
    const x = this.state.series.get(seriesId);
    if (!x) return null;
    return toVaultState(seriesId, x);
  }
  async getPosition(seriesId: string, wallet: string): Promise<PositionState | null> {
    const x = this.state.series.get(seriesId);
    const p = x?.positions.get(wallet);
    return x && p ? toPosition(x, p) : null;
  }
  async listPositions(seriesId: string): Promise<PositionState[]> {
    const x = this.state.series.get(seriesId);
    return x ? listPositionStates(x) : [];
  }
  async getPeriod(seriesId: string, periodId: string): Promise<PeriodState | null> {
    const x = this.state.series.get(seriesId);
    if (!x || x.settledAt === null) return null;
    return toPeriodState(x, periodId, this.clock.now());
  }
  async listPeriods(seriesId: string): Promise<PeriodState[]> {
    const x = this.state.series.get(seriesId);
    if (!x || x.settledAt === null) return [];
    return listPeriodStates(x, this.clock.now());
  }
  async getRedemption(seriesId: string): Promise<RedemptionState | null> {
    const x = this.state.series.get(seriesId);
    return x?.redemption ? toRedemption(x) : null;
  }
  async getRateAccumulator(pair: string): Promise<RateAccumulatorState | null> {
    const a = this.state.rates.get(pair);
    if (!a) return null;
    return toRateAccumulator(pair, a);
  }
  async getQuarterRate(pair: string, periodId: string): Promise<QuarterRateState | null> {
    const q = this.engine.quarterRate(pair, periodId);
    if (!q) return null;
    return toQuarterRate(pair, periodId, q);
  }
  async isAllowlisted(wallet: string): Promise<boolean> {
    return this.state.allowlist.has(wallet);
  }
  async listAttestors(): Promise<string[]> {
    return [...this.state.attestors.entries()].filter(([, a]) => a).map(([k]) => k);
  }
  async listVerifierKeys(): Promise<{ keyId: string; publicKey: string }[]> {
    return [...this.state.verifierKeys.entries()].filter(([, v]) => v.active).map(([keyId, v]) => ({ keyId, publicKey: v.publicKey }));
  }
  async getTransferWindow(seriesId: string): Promise<TransferWindowState | null> {
    const w = this.state.series.get(seriesId)?.transferWindows.at(-1);
    return w ? toTransferWindow(seriesId, w) : null;
  }
  async getCurve(seriesId: string): Promise<CurveState | null> {
    const x = this.state.series.get(seriesId);
    if (!x?.curve) return null;
    return toCurveState(seriesId, x);
  }
  async quoteCurveSwap(seriesId: string, side: 'buy' | 'sell', amountIn: string): Promise<CurveSwapQuote> {
    const x = this.state.series.get(seriesId);
    if (!x) throw new ChainError('NotFound', `series ${seriesId} not found`);
    curveOf(x);
    return toCurveSwapQuote(seriesId, x, side, amountIn);
  }
  async getBalance(wallet: string, stablecoin: Stablecoin): Promise<string> {
    const c = this.state.config.stablecoins[stablecoin];
    return c ? s(this.engine.balance(wallet, c.mint)) : '0';
  }

  // ---------------------------------------------------------------- events
  async readEvents(cursor: string | null, limit: number): Promise<{ events: DomainEvent[]; nextCursor: string | null }> {
    const all = this.engine.events;
    const start = cursor === null ? 0 : all.findIndex((e) => e.cursor > cursor);
    if (start < 0) return { events: [], nextCursor: cursor };
    const events = all.slice(start, start + Math.max(1, limit));
    return { events, nextCursor: events.length ? events[events.length - 1]!.cursor : cursor };
  }

  // ---------------------------------------------------------------- writes
  async build(command: UserCommand | AdminCommand | PermissionlessCommand, signer: string, coSigners: string[] = []): Promise<UnsignedTx> {
    // a user command, a permissionless one (any wallet may send it) or an admin one; anything else is refused here
    const parsed = (userCommandSchema.safeParse(command).success
      ? userCommandSchema.parse(command)
      : permissionlessCommandSchema.safeParse(command).success
        ? permissionlessCommandSchema.parse(command)
        : adminCommandSchema.parse(command)) as UserCommand | AdminCommand | PermissionlessCommand;
    return { chain: this.chain, family: this.family, signer, coSigners, command: parsed, payload: JSON.stringify({ command: parsed, signer, coSigners }), encoding: 'simulator-json', summary: `${parsed.kind} on ${this.chain}`, expiresAt: null };
  }
  async send(signed: SignedTx): Promise<TxResult> {
    const { tx } = signed;
    if (tx.chain !== this.chain) throw new ChainError('ChainSpecific', 'transaction is for another chain');
    for (const who of [tx.signer, ...tx.coSigners]) {
      if (signed.signatures[who] !== `sim:${who}`) throw new ChainError('Unauthorized', `missing or invalid signature for ${who}`);
    }
    // Groth16 verification is asynchronous and the engine is not: verify outside the write queue and hand the verdict
    // in. Sound because the engine still checks the public signals against its own state before it uses the verdict.
    const cmd = tx.command;
    const proofVerdict = cmd.kind === 'submitReport' && cmd.proof?.system === 'groth16-bn254' ? await this.verifyReportProof(cmd.proof.proof, cmd.proof.publicInputs) : undefined;
    return this.run(() => this.engine.execute(cmd, { kind: 'user', signers: [tx.signer, ...tx.coSigners] }, { proofVerdict }));
  }
  /** The configured verifier's verdict; undefined without a verifier, false when it throws (malformed proof or signals). */
  private async verifyReportProof(proof: Groth16ProofJson, publicInputs: string[]): Promise<boolean | undefined> {
    const v = this.engine.opts.reportProofVerifier;
    if (!v) return undefined;
    try {
      return (await v.verify(proof, [...publicInputs])) === true;
    } catch {
      return false;
    }
  }
  async submit(command: ServiceCommand, role: ServiceRole): Promise<TxResult> {
    const parsed = serviceCommandSchema.parse(command) as ServiceCommand;
    return this.run(() => this.engine.execute(parsed, { kind: 'service', role }));
  }

  /** Human-readable snapshot for debugging. */
  describe(): string {
    const st = this.state;
    const lines = [`${this.chain} (${this.personality}) t=${this.clock.now()} series=${st.series.size} events=${this.engine.events.length}`];
    for (const x of st.series.values()) lines.push(`  ${x.seriesId} ${x.phase}/${x.status} units=${x.unitsOutstanding} paid/unit=${wadToDecimal(x.vault.paidPerUnitWad)} vault=${x.vaultBalance}`);
    return lines.join('\n');
  }
}
