import {
  ChainError, adminCommandSchema, serviceCommandSchema, userCommandSchema,
  type AdminCommand, type AuctionState, type BidState, type ChainInfo, type ChainPort, type CurveState, type DomainEvent, type HealthReport,
  type IssuerState, type PeriodState, type PositionState, type QuarterRateState, type RateAccumulatorState, type RedemptionState, type SeriesState,
  type ServiceCommand, type ServiceRole, type SignedTx, type Stablecoin, type TransferWindowState, type TreasuryState, type TxResult, type UnsignedTx,
  type UserCommand, type VaultState,
} from '@merces/domain';
import { claimable, parsePeriod, periodStanding, wadToDecimal } from '@merces/math';
import { DEFAULT_GENESIS, SimClock } from './clock.ts';
import { deriveAddress, personalityConfig, type Personality } from './addresses.ts';
import { SimEngine, type EngineOptions } from './engine.ts';
import type { SimSeries, SimState } from './state.ts';
import type { SimPersistence } from './persistence.ts';

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
    this.engine = new SimEngine(state, clock, { groth16Verifier: opts.groth16Verifier });
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

  /** Synchronous creation for tests without persistence. */
  static createSync(opts: Omit<SimulatorOptions, 'persistence'>): SimulatorChain {
    const cfg = personalityConfig(opts.personality, opts.chainKey);
    const state: SimState = {
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
    return { chain: this.chain, family: this.family, mode: 'mock', network: st.config.network, stablecoins: st.config.stablecoins, modules: { simulator: this.address('program:simulator') }, admin: st.admin, feeCollector: st.feeCollector, newRaisesPaused: st.newRaisesPaused };
  }
  async health(): Promise<HealthReport> {
    return { ok: true, mode: 'mock', latency_ms: 0, detail: `simulator ${this.personality} at t=${this.clock.now()}` };
  }
  async now(): Promise<number> {
    return this.clock.now();
  }

  // ---------------------------------------------------------------- reads
  async getIssuer(issuer: string): Promise<IssuerState | null> {
    const i = this.state.issuers.get(issuer);
    return i ? { issuer: i.issuer, registeredAt: i.registeredAt, issuanceStopped: i.issuanceStopped, seriesIds: [...i.seriesIds] } : null;
  }
  private toSeriesState(x: SimSeries): SeriesState {
    const t = x.terms;
    return {
      seriesId: x.seriesId, chain: this.chain, issuer: x.issuer,
      terms: {
        stablecoin: t.stablecoin, stablecoinMint: t.stablecoinMint, unitsOffered: s(t.unitsOffered), reservePrice: s(t.reservePrice), minimumRaise: s(t.minimumRaise), capMultipleWad: s(t.capMultipleWad), lockupSeconds: t.lockupSeconds,
        releaseSchedule: t.releaseSchedule.map((r) => ({ ...r })), auctionFeeBps: Number(t.auctionFeeBps), payoutFeeBps: Number(t.payoutFeeBps), hurdleWad: s(t.hurdleWad), payoutMultipleK: Number(t.payoutMultipleK), walletCapBps: Number(t.walletCapBps),
        dueDays: t.dueDays, graceDays: t.graceDays, formalNoticeDays: t.formalNoticeDays, contractHash: t.contractHash, termsCommitment: t.termsCommitment, tierFlags: { ...t.tierFlags }, reportingCurrency: t.reportingCurrency, raiseStyle: t.raiseStyle,
      },
      phase: x.phase, status: x.status, createdAt: x.createdAt, openedAt: x.openedAt, settledAt: x.settledAt, issuePrice: x.issuePrice === null ? null : s(x.issuePrice), unitsSold: s(x.unitsSold), unitsOutstanding: s(x.unitsOutstanding),
      capPerUnit: x.capPerUnit === null ? null : s(x.capPerUnit), paidPerUnitWad: s(x.paidPerUnitWad), accNetWad: s(x.accNetWad), lockupEndsAt: x.settledAt === null ? null : x.settledAt + t.lockupSeconds,
      releasesPaused: x.releasesPausedLate || x.releasesPausedByIssuer, releasesPausedByIssuer: x.releasesPausedByIssuer, pause: x.pause ? { ...x.pause } : null, pausedSecondsTotal: x.pausedSecondsTotal,
      redemption: x.redemption ? this.toRedemption(x) : null, extinguishedAt: x.extinguishedAt, grossPaidTotal: s(x.grossPaidTotal), feesTotal: s(x.feesTotal),
    };
  }
  private toRedemption(x: SimSeries): RedemptionState {
    const r = x.redemption!;
    return { openedAt: r.openedAt, pricePerUnit: s(r.pricePerUnit), unitsAtRedemption: s(r.unitsAtRedemption), deposit: s(r.deposit), claimed: s(r.claimed), tailCapPerUnit: s(r.tailCapPerUnit), tailEndsAt: r.tailEndsAt, tailPaidPerUnit: s(r.tailPaidPerUnit) };
  }
  async listSeries(): Promise<SeriesState[]> {
    return [...this.state.series.values()].map((x) => this.toSeriesState(x));
  }
  async getSeries(seriesId: string): Promise<SeriesState | null> {
    const x = this.state.series.get(seriesId);
    return x ? this.toSeriesState(x) : null;
  }
  async getAuction(seriesId: string): Promise<AuctionState | null> {
    const x = this.state.series.get(seriesId);
    if (!x) return null;
    const phase = this.engine.auctionPhase(x, this.clock.now());
    return {
      seriesId, phase: phase === 'SettleDue' ? 'Reveal' : phase, commitEndsAt: x.commitEndsAt, revealEndsAt: x.revealEndsAt, bidCount: x.bids.size, revealedCount: [...x.bids.values()].filter((b) => b.revealed).length,
      clearingPrice: x.phase === 'Settled' && x.issuePrice !== null ? s(x.issuePrice) : null, unitsSold: s(x.unitsSold), proceeds: s(x.treasuryTotal),
    };
  }
  private toBid(seriesId: string, b: SimSeries['bids'] extends Map<string, infer B> ? B : never): BidState {
    return { seriesId, bidder: b.bidder, commitment: b.commitment, deposit: s(b.deposit), order: b.order, revealed: b.revealed ? { pricePerUnit: s(b.revealed.pricePerUnit), quantity: s(b.revealed.quantity) } : null, allocatedUnits: s(b.allocatedUnits), refunded: s(b.refunded), settled: b.settled };
  }
  async getBid(seriesId: string, bidder: string): Promise<BidState | null> {
    const b = this.state.series.get(seriesId)?.bids.get(bidder);
    return b ? this.toBid(seriesId, b) : null;
  }
  async listBids(seriesId: string): Promise<BidState[]> {
    const x = this.state.series.get(seriesId);
    return x ? [...x.bids.values()].map((b) => this.toBid(seriesId, b)) : [];
  }
  async getTreasury(seriesId: string): Promise<TreasuryState | null> {
    const x = this.state.series.get(seriesId);
    if (!x) return null;
    return {
      seriesId, total: s(x.treasuryTotal), released: s(x.treasuryReleased), balance: s(x.treasuryTotal - x.treasuryReleased), paused: x.releasesPausedLate || x.releasesPausedByIssuer,
      tranches: x.tranches.map((t) => ({ index: t.index, afterSeconds: t.afterSeconds, bps: t.bps, amount: s(t.amount), drawableAt: x.settledAt === null ? null : x.settledAt + t.afterSeconds, drawn: t.drawn })),
    };
  }
  async getVault(seriesId: string): Promise<VaultState | null> {
    const x = this.state.series.get(seriesId);
    if (!x) return null;
    const entitled = [...x.positions.values()].reduce((a, p) => a + claimable(p.units, x.accNetWad, p.rewardDebt) + p.pending, 0n);
    return { seriesId, balance: s(x.vaultBalance), accNetWad: s(x.accNetWad), grossTotal: s(x.vaultGrossTotal), feesTotal: s(x.vaultFeesTotal), dust: s(x.vaultBalance - entitled < 0n ? 0n : x.vaultBalance - entitled) };
  }
  private toPosition(x: SimSeries, p: NonNullable<ReturnType<SimSeries['positions']['get']>>): PositionState {
    const tail = x.redemption && p.redeemedUnits > 0n ? claimable(p.redeemedUnits, x.redemption.accTailNetWad, p.tailDebt) : 0n;
    return { seriesId: x.seriesId, wallet: p.wallet, units: s(p.units), rewardDebt: s(p.rewardDebt), claimable: s(claimable(p.units, x.accNetWad, p.rewardDebt) + p.pending), claimedTotal: s(p.claimedTotal), redeemedUnits: s(p.redeemedUnits), tailClaimable: s(tail) };
  }
  async getPosition(seriesId: string, wallet: string): Promise<PositionState | null> {
    const x = this.state.series.get(seriesId);
    const p = x?.positions.get(wallet);
    return x && p ? this.toPosition(x, p) : null;
  }
  async listPositions(seriesId: string): Promise<PositionState[]> {
    const x = this.state.series.get(seriesId);
    return x ? [...x.positions.values()].filter((p) => p.units > 0n || p.pending > 0n || p.redeemedUnits > 0n).map((p) => this.toPosition(x, p)) : [];
  }
  private toPeriodState(x: SimSeries, periodId: string, now: number): PeriodState {
    const period = parsePeriod(periodId);
    const d = this.engine.deadlines(x, period, now);
    const p = x.periods.get(periodId);
    const settled = !!p?.settled;
    // interest keeps running until paid: show the live amount due
    const liveAccrual = p && p.reportAccepted && !settled && !p.isTail ? this.engine.accrualNow(x, period, p.outstanding, now) : (p?.accrual ?? 0n);
    const liveDue = p && p.reportAccepted && !settled && !p.isTail ? p.outstanding + liveAccrual : (p?.paymentDue ?? 0n);
    const standing: PeriodState['standing'] = x.status === 'Paused' && !settled ? 'Deferred' : periodStanding(d, now, settled);
    return {
      seriesId: x.seriesId, periodId, dueAt: d.dueAt, graceEndsAt: d.graceEndsAt, formalNoticeAt: d.formalNoticeAt, reportAccepted: !!p?.reportAccepted, tier: p?.tier ?? null,
      paymentDue: s(liveDue), accrual: s(liveAccrual), paid: s(p?.paid ?? 0n), splitReceived: s(p?.splitReceived ?? 0n), settled, standing, incomeCommitment: p?.incomeCommitment ?? null, liquidityEvent: !!p?.liquidityEvent,
    };
  }
  async getPeriod(seriesId: string, periodId: string): Promise<PeriodState | null> {
    const x = this.state.series.get(seriesId);
    if (!x || x.settledAt === null) return null;
    return this.toPeriodState(x, periodId, this.clock.now());
  }
  async listPeriods(seriesId: string): Promise<PeriodState[]> {
    const x = this.state.series.get(seriesId);
    if (!x || x.settledAt === null) return [];
    const now = this.clock.now();
    const ids = new Set<string>(this.engine.reportablePeriods(x, now).map((p) => p.id));
    for (const k of x.periods.keys()) ids.add(k);
    return [...ids].sort().map((id) => this.toPeriodState(x, id, now));
  }
  async getRedemption(seriesId: string): Promise<RedemptionState | null> {
    const x = this.state.series.get(seriesId);
    return x?.redemption ? this.toRedemption(x) : null;
  }
  async getRateAccumulator(pair: string): Promise<RateAccumulatorState | null> {
    const a = this.state.rates.get(pair);
    if (!a) return null;
    const last = a.days.at(-1);
    return { pair, sumWad: s(a.sumWad), count: a.count, lastDayIndex: last?.dayIndex ?? null, lastRateWad: last ? s(last.rateWad) : null };
  }
  async getQuarterRate(pair: string, periodId: string): Promise<QuarterRateState | null> {
    const q = this.engine.quarterRate(pair, periodId);
    if (!q) return null;
    return { pair, periodId, avgWad: q.avgWad === null ? null : s(q.avgWad), snapshots: q.snapshots, daysInQuarter: q.days, coverageOk: q.coverageOk, needsFallback: q.needsFallback, fallbackReason: q.reason };
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
    return w ? { seriesId, windowId: w.windowId, commitEndsAt: w.commitEndsAt, revealEndsAt: w.revealEndsAt, cleared: w.cleared, clearingPrice: w.clearingPrice === null ? null : s(w.clearingPrice), orderCount: w.orders.size } : null;
  }
  async getCurve(seriesId: string): Promise<CurveState | null> {
    const x = this.state.series.get(seriesId);
    if (!x?.curve) return null;
    const c = x.curve;
    const spot = c.basePrice + (c.basePrice * c.slopeWad * x.unitsOutstanding) / 10n ** 18n;
    return { seriesId, quoteStablecoin: c.quoteStablecoin, raised: s(c.raised), unitsOutstanding: s(x.unitsOutstanding), spotPrice: s(spot), graduationThreshold: s(c.graduationThreshold), graduated: c.graduated };
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
  async build(command: UserCommand | AdminCommand, signer: string, coSigners: string[] = []): Promise<UnsignedTx> {
    const parsed = (userCommandSchema.safeParse(command).success ? userCommandSchema.parse(command) : adminCommandSchema.parse(command)) as UserCommand | AdminCommand;
    return { chain: this.chain, family: this.family, signer, coSigners, command: parsed, payload: JSON.stringify({ command: parsed, signer, coSigners }), encoding: 'simulator-json', summary: `${parsed.kind} on ${this.chain}`, expiresAt: null };
  }
  async send(signed: SignedTx): Promise<TxResult> {
    const { tx } = signed;
    if (tx.chain !== this.chain) throw new ChainError('ChainSpecific', 'transaction is for another chain');
    for (const who of [tx.signer, ...tx.coSigners]) {
      if (signed.signatures[who] !== `sim:${who}`) throw new ChainError('Unauthorized', `missing or invalid signature for ${who}`);
    }
    return this.run(() => this.engine.execute(tx.command, { kind: 'user', signers: [tx.signer, ...tx.coSigners] }));
  }
  async submit(command: ServiceCommand, role: ServiceRole): Promise<TxResult> {
    const parsed = serviceCommandSchema.parse(command) as ServiceCommand;
    return this.run(() => this.engine.execute(parsed, { kind: 'service', role }));
  }

  /** Human-readable snapshot for debugging. */
  describe(): string {
    const st = this.state;
    const lines = [`${this.chain} (${this.personality}) t=${this.clock.now()} series=${st.series.size} events=${this.engine.events.length}`];
    for (const x of st.series.values()) lines.push(`  ${x.seriesId} ${x.phase}/${x.status} units=${x.unitsOutstanding} paid/unit=${wadToDecimal(x.paidPerUnitWad)} vault=${x.vaultBalance}`);
    return lines.join('\n');
  }
}
