import { createPublicKey, verify as edVerify } from 'node:crypto';
import {
  ChainError, DEFAULTS, attestationMessage, bidCommitment, mockVerify, orderCommitment, parseSeriesId, reportPublicInputs,
  type Command, type DomainEvent, type EventPayload, type EventType, type LifecycleStatus, type ServiceRole, type TxResult,
} from '@merces/domain';
import {
  WAD, accrueNet, applyGrossPayment, bpsOf, claimable, clearAuction, coverageOk, daysLate, deadlinesFor, lateAccrual, min, mulDiv,
  parsePeriod, payoutFee, perUnitCap, periodOf, periodStanding, periodsBetween, quarterAverageRate, redemptionQuote, rewardDebt,
  tailPayoutPerUnit, utcDayIndex, walletCapUnits, type Deadlines, type Period,
} from '@merces/math';
import type { SimClock } from './clock.ts';
import { deriveAddress } from './addresses.ts';
import type { SimBid, SimPeriod, SimPosition, SimSeries, SimState, SimTerms, SimTransferWindow } from './state.ts';


export interface EngineOptions {
  /** Optional real Groth16 verifier (wired once Stage 1's circuit exists). */
  groth16Verifier?: (proof: string, publicInputs: string[]) => boolean;
}

export type Actor = { kind: 'user'; signers: string[] } | { kind: 'service'; role: ServiceRole } | { kind: 'router'; router: string };

const TERMINAL: ReadonlySet<LifecycleStatus> = new Set(['Retired', 'Redeemed', 'Extinguished']);

function big(x: string): bigint {
  return BigInt(x);
}
function str(x: bigint): string {
  return x.toString();
}
function balKey(wallet: string, mint: string): string {
  return `${wallet}|${mint}`;
}

/**
 * The simulator engine: Part C as TypeScript. One `execute` = one transaction; it either applies fully
 * (emitting canonical events) or throws a ChainError and leaves the state untouched.
 */
export class SimEngine {
  public events: DomainEvent[] = [];
  constructor(
    public state: SimState,
    public readonly clock: SimClock,
    private readonly opts: EngineOptions = {},
  ) {}

  // ------------------------------------------------------------------ tx plumbing
  execute(cmd: Command, actor: Actor): TxResult {
    const backup = structuredClone(this.state);
    const now = this.clock.now();
    const txIndex = this.state.txCount + 1;
    const txId = `sim-${this.state.config.chain}-${txIndex}`;
    const emitted: DomainEvent[] = [];
    const emit = <T extends EventType>(type: T, payload: EventPayload<T>): void => {
      const seq = ++this.state.seq;
      emitted.push({ chain: this.state.config.chain, cursor: seq.toString().padStart(12, '0'), seq, blockTime: now, blockRef: String(txIndex), txId, finality: 'finalized', type, payload });
    };
    try {
      this.dispatch(cmd, actor, now, emit);
      this.state.txCount = txIndex;
      this.events.push(...emitted);
      return { txId, blockTime: now, blockRef: String(txIndex), events: emitted };
    } catch (e) {
      this.state = backup;
      throw e;
    }
  }

  private dispatch(cmd: Command, actor: Actor, now: number, emit: Emit): void {
    const user = (): string => {
      if (actor.kind !== 'user') throw new ChainError('Unauthorized', `${cmd.kind} must be signed by a wallet`);
      const s = actor.signers[0];
      if (!s) throw new ChainError('Unauthorized', 'no signer');
      return s;
    };
    const service = (role: ServiceRole | 'any'): void => {
      if (actor.kind === 'user' && role === 'any') return; // permissionless cranks may also be sent by any wallet
      if (actor.kind !== 'service') throw new ChainError('Unauthorized', `${cmd.kind} is a service command`);
      if (role !== 'any' && actor.role !== role) throw new ChainError('Unauthorized', `${cmd.kind} requires role ${role}`);
    };
    const admin = (): void => {
      if (actor.kind !== 'user' || actor.signers[0] !== this.state.admin) throw new ChainError('Unauthorized', `${cmd.kind} requires the protocol admin`);
    };
    switch (cmd.kind) {
      case 'registerIssuer': return this.registerIssuer(user(), now, emit);
      case 'stopIssuance': return this.stopIssuance(user(), emit);
      case 'createSeries': return this.createSeries(user(), cmd, now, emit);
      case 'openRaise': return this.openRaise(user(), cmd, now, emit);
      case 'cancelRaise': return this.cancelRaise(user(), cmd, emit);
      case 'commitBid': return this.commitBid(user(), cmd, now, emit);
      case 'revealBid': return this.revealBid(user(), cmd, now, emit);
      case 'settleAuction': service('any'); return this.settleAuction(cmd, now, emit);
      case 'claimRefund': return this.claimRefund(user(), cmd, emit);
      case 'drawRelease': return this.drawRelease(user(), cmd, now, emit);
      case 'pauseReleases': return this.pauseReleases(user(), cmd, emit);
      case 'submitReport': return this.submitReport(actor.kind === 'user' ? actor.signers : [], cmd, now, emit);
      case 'payIn': return this.payIn(user(), cmd, now, emit);
      case 'claimPayout': return this.claimPayout(user(), cmd, emit);
      case 'crankBurn': service('any'); return this.crankBurn(cmd, emit);
      case 'requestPause': return this.requestPause(user(), cmd, now, emit);
      case 'approvePause': return this.approvePause(user(), cmd, now, emit);
      case 'crankPause': service('any'); return this.crankPause(cmd, now, emit);
      case 'crankStatus': service('any'); return this.crankStatus(cmd, now, emit);
      case 'redeem': return this.redeem(user(), cmd, now, emit);
      case 'claimRedemption': return this.claimRedemption(user(), cmd, emit);
      case 'amendTerms': return this.amendTerms(actor.kind === 'user' ? actor.signers : [], cmd, now, emit);
      case 'extinguish': return this.extinguish(actor.kind === 'user' ? actor.signers : [], cmd, now, emit);
      case 'snapshotRate': service('keeper'); return this.snapshotRate(cmd, now, emit);
      case 'flagFxFallback': service('keeper'); return this.flagFxFallback(cmd, now, emit);
      case 'openTransferWindow': service('any'); return this.openTransferWindow(cmd, now, emit);
      case 'commitWindowOrder': return this.commitWindowOrder(user(), cmd, now, emit);
      case 'revealWindowOrder': return this.revealWindowOrder(user(), cmd, now, emit);
      case 'clearTransferWindow': service('any'); return this.clearTransferWindow(cmd, now, emit);
      case 'buyCurve': return this.buyCurve(user(), cmd, now, emit);
      case 'graduateCurve': service('any'); return this.graduateCurve(cmd, emit);
      case 'setAllowlist': service('allowlistManager'); return this.setAllowlist(cmd, emit);
      case 'registerAttestor': admin(); this.state.attestors.set(cmd.attestor, cmd.active); emit('AttestorRegistered', { attestor: cmd.attestor, active: cmd.active }); return;
      case 'registerVerifierKey': admin(); this.state.verifierKeys.set(cmd.keyId, { publicKey: cmd.publicKey, active: cmd.active }); emit('VerifierKeyRegistered', { keyId: cmd.keyId, publicKey: cmd.publicKey, active: cmd.active }); return;
      case 'pauseNewRaises': admin(); this.state.newRaisesPaused = cmd.paused; return;
      case 'setFeeCollector': admin(); this.state.feeCollector = cmd.feeCollector; return;
      case 'registerSplitRouter': admin(); this.series(cmd.seriesId).splitRouter = cmd.router; return;
      case 'postSplitReceipt': {
        if (actor.kind !== 'router') throw new ChainError('Unauthorized', 'postSplitReceipt must come from a registered router');
        return this.postSplitReceipt(actor.router, cmd, now, emit);
      }
      default: {
        const never: never = cmd;
        throw new ChainError('NotImplemented', `unknown command ${(never as { kind: string }).kind}`);
      }
    }
  }

  // ------------------------------------------------------------------ helpers
  private series(id: string): SimSeries {
    const s = this.state.series.get(id);
    if (!s) throw new ChainError('NotFound', `series ${id} not found`);
    return s;
  }
  private requireIssuer(s: SimSeries, signer: string): void {
    if (s.issuer !== signer) throw new ChainError('Unauthorized', 'only the issuer may do this');
  }
  private requireAllowlisted(wallet: string): void {
    if (!this.state.allowlist.has(wallet)) throw new ChainError('NotAllowlisted', `${wallet} is not allowlisted`);
  }
  private requireAttestor(a: string): void {
    if (!this.state.attestors.get(a)) throw new ChainError('Unauthorized', `${a} is not a registered attestor`);
  }
  balance(wallet: string, mint: string): bigint {
    return this.state.balances.get(balKey(wallet, mint)) ?? 0n;
  }
  credit(wallet: string, mint: string, amount: bigint): void {
    if (amount < 0n) throw new ChainError('ChainSpecific', 'negative credit');
    this.state.balances.set(balKey(wallet, mint), this.balance(wallet, mint) + amount);
  }
  debit(wallet: string, mint: string, amount: bigint): void {
    if (amount < 0n) throw new ChainError('ChainSpecific', 'negative debit');
    const b = this.balance(wallet, mint);
    if (b < amount) throw new ChainError('InsufficientFunds', `${wallet} has ${b} < ${amount}`);
    this.state.balances.set(balKey(wallet, mint), b - amount);
  }
  /** test faucet; not reachable through ChainPort */
  fund(wallet: string, mint: string, amount: bigint): void {
    this.credit(wallet, mint, amount);
  }
  private position(s: SimSeries, wallet: string): SimPosition {
    let p = s.positions.get(wallet);
    if (!p) {
      p = { wallet, units: 0n, rewardDebt: 0n, pending: 0n, claimedTotal: 0n, redeemedUnits: 0n, tailDebt: 0n, redemptionClaimed: false };
      s.positions.set(wallet, p);
    }
    return p;
  }
  /** Settle accrued payouts into `pending` before a unit change, then re-base the debt. */
  private settlePosition(s: SimSeries, p: SimPosition): void {
    p.pending += claimable(p.units, s.accNetWad, p.rewardDebt);
    p.rewardDebt = rewardDebt(p.units, s.accNetWad);
  }
  private setUnits(s: SimSeries, p: SimPosition, units: bigint): void {
    this.settlePosition(s, p);
    p.units = units;
    p.rewardDebt = rewardDebt(units, s.accNetWad);
  }

  /** Completed quarters a settled series must report, oldest first (A-REP-1: the settlement quarter counts). */
  reportablePeriods(s: SimSeries, now: number): Period[] {
    if (s.settledAt === null) return [];
    return periodsBetween(s.settledAt, now).filter((p) => p.end <= now);
  }
  private period(s: SimSeries, periodId: string): SimPeriod {
    let p = s.periods.get(periodId);
    if (!p) {
      p = { periodId, reportAccepted: false, tier: null, paymentStable: 0n, accrual: 0n, paymentDue: 0n, paid: 0n, splitReceived: 0n, settled: false, incomeCommitment: null, liquidityEvent: false, formalNoticeEmitted: false, acceptedAt: null, isTail: false };
      s.periods.set(periodId, p);
    }
    return p;
  }
  /** Seconds of approved pause overlapping [from, now). Deadlines shift by this (C8.5). */
  pausedSecondsSince(s: SimSeries, from: number, now: number): number {
    let total = 0;
    const intervals = [...s.pauseIntervals];
    if (s.status === 'Paused' && s.pause?.startedAt != null) intervals.push({ from: s.pause.startedAt, to: now });
    for (const iv of intervals) {
      const a = Math.max(iv.from, from);
      const b = Math.min(iv.to, now);
      if (b > a) total += b - a;
    }
    return total;
  }
  deadlines(s: SimSeries, period: Period, now: number): Deadlines {
    return deadlinesFor(period, { dueDays: s.terms.dueDays, graceDays: s.terms.graceDays, formalNoticeDays: s.terms.formalNoticeDays, pausedSeconds: this.pausedSecondsSince(s, period.end, now) });
  }
  private isPeriodSettled(s: SimSeries, periodId: string): boolean {
    const p = s.periods.get(periodId);
    return !!p && p.settled;
  }
  /** Derive OnTime/InGrace/Late from unsettled completed periods. */
  derivedStanding(s: SimSeries, now: number): { status: 'OnTime' | 'InGrace' | 'Late'; worst: Period | null } {
    let status: 'OnTime' | 'InGrace' | 'Late' = 'OnTime';
    let worst: Period | null = null;
    for (const p of this.reportablePeriods(s, now)) {
      if (this.isPeriodSettled(s, p.id)) continue;
      const st = periodStanding(this.deadlines(s, p, now), now, false);
      if (st === 'Late' || st === 'FormalNoticeDue') {
        status = 'Late';
        worst = worst ?? p;
      } else if (st === 'InGrace' && status === 'OnTime') {
        status = 'InGrace';
        worst = worst ?? p;
      }
    }
    return { status, worst };
  }
  private setStatus(s: SimSeries, to: LifecycleStatus, emit: Emit): void {
    if (s.status === to) return;
    const from = s.status;
    s.status = to;
    emit('StatusChanged', { seriesId: s.seriesId, from, to });
  }
  /** After a payment or report: if the issuer is current again, lift the Late pause. */
  private refreshStanding(s: SimSeries, now: number, emit: Emit): void {
    if (TERMINAL.has(s.status) || s.status === 'Paused') return;
    const { status } = this.derivedStanding(s, now);
    this.setStatus(s, status, emit);
    if (status === 'Late') {
      if (!s.releasesPausedLate) {
        s.releasesPausedLate = true;
        if (!s.releasesPausedByIssuer) emit('ReleasesPaused', { seriesId: s.seriesId, reason: 'Late' });
      }
    } else if (s.releasesPausedLate) {
      s.releasesPausedLate = false;
      if (!s.releasesPausedByIssuer) emit('ReleasesResumed', { seriesId: s.seriesId });
    }
  }
  private yearIndex(s: SimSeries, now: number): number {
    return Math.floor((now - (s.settledAt ?? now)) / (365 * 86_400));
  }
  /** Per-unit gross for each FULL year since settlement (for D_avg). */
  annualGrossPerUnit(s: SimSeries, now: number): bigint[] {
    const full = this.yearIndex(s, now);
    const out: bigint[] = [];
    for (let y = 0; y < full; y++) {
      const g = s.grossByYear.get(y) ?? 0n;
      out.push(s.unitsSold > 0n ? g / s.unitsSold : 0n);
    }
    return out;
  }

  /** Common path for money entering the vault: fee, cap, accumulator, events. Returns accepted gross. */
  private receivePayment(s: SimSeries, payer: string, gross: bigint, periodId: string | null, source: 'payIn' | 'split' | 'tail', now: number, emit: Emit): { accepted: bigint; refunded: bigint; net: bigint } {
    if (s.unitsOutstanding <= 0n) throw new ChainError('WrongStatus', 'no units outstanding');
    const mint = s.terms.stablecoinMint;
    this.debit(payer, mint, gross);
    const cap = applyGrossPayment(gross, s.unitsOutstanding, s.paidPerUnitWad, s.capPerUnit!);
    if (cap.refunded > 0n) {
      this.credit(payer, mint, cap.refunded);
      emit('PaymentRefunded', { seriesId: s.seriesId, periodId, amount: str(cap.refunded), reason: 'cap' });
    }
    const accepted = cap.accepted;
    const { fee, net } = payoutFee(accepted, s.terms.payoutFeeBps);
    if (fee > 0n) {
      this.credit(this.state.feeCollector, mint, fee);
      emit('FeeTaken', { seriesId: s.seriesId, kind: 'payout', amount: str(fee), payer });
    }
    s.paidPerUnitWad = cap.paidPerUnitWad;
    s.accNetWad = accrueNet(s.accNetWad, net, s.unitsOutstanding);
    s.vaultBalance += net;
    s.vaultGrossTotal += accepted;
    s.vaultFeesTotal += fee;
    s.grossPaidTotal += accepted;
    s.feesTotal += fee;
    const y = this.yearIndex(s, now);
    s.grossByYear.set(y, (s.grossByYear.get(y) ?? 0n) + accepted);
    emit('PaymentReceived', { seriesId: s.seriesId, periodId, gross: str(accepted), fee: str(fee), net: str(net), source, paidPerUnitWad: str(s.paidPerUnitWad) });
    if (cap.retired && s.status !== 'Retired') {
      this.setStatus(s, 'Retired', emit);
      emit('SeriesRetired', { seriesId: s.seriesId, paidPerUnitWad: str(s.paidPerUnitWad) });
    }
    return { accepted, refunded: cap.refunded, net };
  }

  // ------------------------------------------------------------------ issuers and series
  private registerIssuer(signer: string, now: number, emit: Emit): void {
    this.requireAllowlisted(signer);
    if (this.state.issuers.has(signer)) throw new ChainError('Duplicate', 'issuer already registered');
    this.state.issuers.set(signer, { issuer: signer, registeredAt: now, issuanceStopped: false, seriesIds: [] });
    emit('IssuerRegistered', { issuer: signer });
  }
  private stopIssuance(signer: string, emit: Emit): void {
    const i = this.state.issuers.get(signer);
    if (!i) throw new ChainError('NotFound', 'issuer not registered');
    i.issuanceStopped = true;
    emit('IssuanceStopped', { issuer: signer });
  }

  private createSeries(signer: string, cmd: Extract<Command, { kind: 'createSeries' }>, now: number, emit: Emit): void {
    const issuer = this.state.issuers.get(signer);
    if (!issuer) throw new ChainError('Unauthorized', 'issuer not registered');
    if (issuer.issuanceStopped) throw new ChainError('NotPermitted', 'issuer stopped issuance');
    if (this.state.newRaisesPaused) throw new ChainError('Paused', 'new raises are paused by the protocol admin');
    const t = cmd.terms;
    const coin = this.state.config.stablecoins[t.stablecoin];
    if (!coin) throw new ChainError('InvalidTerms', `${t.stablecoin} is not available on ${this.state.config.chain}`);
    if (coin.mint !== t.stablecoinMint) throw new ChainError('InvalidTerms', 'stablecoin mint does not match the chain catalogue');
    const capWad = big(t.capMultipleWad);
    if (capWad < DEFAULTS.capMultipleMinWad || capWad > DEFAULTS.capMultipleMaxWad) throw new ChainError('InvalidTerms', 'cap multiple out of bounds (2.0–3.0)');
    const bpsSum = t.releaseSchedule.reduce((a, x) => a + x.bps, 0);
    if (bpsSum !== 10_000) throw new ChainError('InvalidTerms', 'release schedule must sum to 10000 bps');
    if (big(t.unitsOffered) <= 0n) throw new ChainError('InvalidTerms', 'unitsOffered must be positive');
    if (/^0x0{64}$/.test(t.contractHash)) throw new ChainError('InvalidTerms', 'contract hash required: a raise needs a signed contract');
    if (t.raiseStyle === 'curve' && this.state.config.family !== 'solana') throw new ChainError('InvalidTerms', 'curve-mode raises exist on Solana only');
    if (t.tierFlags.tier4) throw new ChainError('InvalidTerms', 'tier 4 is switched off');
    const address = cmd.seriesAddressHint ?? deriveAddress(this.state.config.family, `series:${signer}:${issuer.seriesIds.length}`);
    const seriesId = `${this.state.config.chain}:${address}`;
    if (this.state.series.has(seriesId)) throw new ChainError('Duplicate', 'series exists');
    const terms: SimTerms = {
      stablecoin: t.stablecoin,
      stablecoinMint: t.stablecoinMint,
      unitsOffered: big(t.unitsOffered),
      reservePrice: big(t.reservePrice),
      minimumRaise: big(t.minimumRaise),
      capMultipleWad: capWad,
      lockupSeconds: t.lockupSeconds,
      releaseSchedule: t.releaseSchedule.map((x) => ({ ...x })),
      auctionFeeBps: BigInt(t.auctionFeeBps),
      payoutFeeBps: BigInt(t.payoutFeeBps),
      hurdleWad: big(t.hurdleWad),
      payoutMultipleK: BigInt(t.payoutMultipleK),
      walletCapBps: BigInt(t.walletCapBps),
      dueDays: t.dueDays,
      graceDays: t.graceDays,
      formalNoticeDays: t.formalNoticeDays,
      contractHash: t.contractHash,
      termsCommitment: t.termsCommitment,
      tierFlags: { ...t.tierFlags },
      reportingCurrency: t.reportingCurrency,
      raiseStyle: t.raiseStyle,
    };
    const s: SimSeries = {
      seriesId, address, issuer: signer, terms, phase: 'Draft', status: 'OnTime', createdAt: now, openedAt: null, commitEndsAt: null, revealEndsAt: null, settledAt: null,
      issuePrice: null, unitsSold: 0n, unitsOutstanding: 0n, capPerUnit: null, paidPerUnitWad: 0n, accNetWad: 0n, vaultBalance: 0n, vaultGrossTotal: 0n, vaultFeesTotal: 0n, vaultDistributedNet: 0n,
      treasuryTotal: 0n, treasuryReleased: 0n, tranches: [], releasesPausedByIssuer: false, releasesPausedLate: false, bids: new Map(), bidOrder: 0, positions: new Map(), periods: new Map(),
      pause: null, pauseIntervals: [], pausedSecondsTotal: 0, redemption: null, extinguishedAt: null, grossByYear: new Map(), grossPaidTotal: 0n, feesTotal: 0n, transferWindows: [], curve: null, splitRouter: null, amendments: [],
    };
    this.state.series.set(seriesId, s);
    issuer.seriesIds.push(seriesId);
    emit('SeriesCreated', { seriesId, issuer: signer, terms: t });
    if (t.raiseStyle === 'curve') {
      const threshold = terms.minimumRaise;
      s.curve = { quoteStablecoin: 'USDC', raised: 0n, basePrice: terms.reservePrice, slopeWad: WAD / 1000n, graduationThreshold: threshold, graduated: false };
      emit('CurveSeriesCreated', { seriesId, issuer: signer, quoteStablecoin: 'USDC', graduationThreshold: str(threshold) });
    }
  }

  // ------------------------------------------------------------------ auction
  private openRaise(signer: string, cmd: Extract<Command, { kind: 'openRaise' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    this.requireIssuer(s, signer);
    if (s.phase !== 'Draft') throw new ChainError('WrongPhase', `series is ${s.phase}`);
    if (s.terms.raiseStyle !== 'sealed') throw new ChainError('WrongPhase', 'curve-mode series do not run a sealed-bid raise');
    if (this.state.newRaisesPaused) throw new ChainError('Paused', 'new raises are paused');
    if (cmd.commitEndsAt <= now || cmd.revealEndsAt <= cmd.commitEndsAt) throw new ChainError('InvalidTerms', 'bad auction timings');
    s.phase = 'Open';
    s.openedAt = now;
    s.commitEndsAt = cmd.commitEndsAt;
    s.revealEndsAt = cmd.revealEndsAt;
    emit('RaiseOpened', { seriesId: s.seriesId, commitEndsAt: cmd.commitEndsAt, revealEndsAt: cmd.revealEndsAt });
  }
  private cancelRaise(signer: string, cmd: Extract<Command, { kind: 'cancelRaise' }>, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    this.requireIssuer(s, signer);
    if (s.phase !== 'Open' && s.phase !== 'Draft') throw new ChainError('WrongPhase', `series is ${s.phase}`);
    if (s.bids.size > 0) throw new ChainError('TooLate', 'bids exist; the raise can no longer be cancelled');
    s.phase = 'Cancelled';
    emit('RaiseCancelled', { seriesId: s.seriesId });
  }
  /** The reveal phase is time-derived: commitEndsAt ≤ now < revealEndsAt. */
  auctionPhase(s: SimSeries, now: number): 'Draft' | 'Open' | 'Reveal' | 'SettleDue' | 'Settled' | 'Failed' | 'Cancelled' {
    if (s.phase !== 'Open') return s.phase;
    if (now < s.commitEndsAt!) return 'Open';
    if (now < s.revealEndsAt!) return 'Reveal';
    return 'SettleDue';
  }
  private commitBid(signer: string, cmd: Extract<Command, { kind: 'commitBid' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    this.requireAllowlisted(signer);
    if (this.auctionPhase(s, now) !== 'Open') throw new ChainError('WrongPhase', 'commit phase is over or not started');
    if (s.bids.has(signer)) throw new ChainError('Duplicate', 'one bid per wallet (A-AUC-2)');
    const deposit = big(cmd.deposit);
    if (deposit <= 0n) throw new ChainError('InvalidTerms', 'deposit must be positive');
    this.debit(signer, s.terms.stablecoinMint, deposit);
    const order = s.bidOrder++;
    s.bids.set(signer, { bidder: signer, commitment: cmd.commitment, deposit, order, revealed: null, allocatedUnits: 0n, refundable: 0n, refunded: 0n, settled: false });
    emit('BidCommitted', { seriesId: s.seriesId, bidder: signer, commitment: cmd.commitment, deposit: cmd.deposit, order });
  }
  private revealBid(signer: string, cmd: Extract<Command, { kind: 'revealBid' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    if (this.auctionPhase(s, now) !== 'Reveal') throw new ChainError('WrongPhase', 'not in the reveal phase');
    const b = s.bids.get(signer);
    if (!b) throw new ChainError('NotFound', 'no bid to reveal');
    if (b.revealed) throw new ChainError('Duplicate', 'already revealed');
    const price = big(cmd.pricePerUnit);
    const qty = big(cmd.quantity);
    const expected = bidCommitment({ seriesId: s.seriesId, bidder: signer, pricePerUnit: price, quantity: qty, salt: cmd.salt });
    if (expected !== b.commitment) throw new ChainError('InvalidCommitment', 'reveal does not match the commitment');
    const needed = price * qty + bpsOf(price * qty, s.terms.auctionFeeBps);
    if (needed > b.deposit) throw new ChainError('InsufficientFunds', 'deposit does not cover price × quantity plus the fee');
    b.revealed = { pricePerUnit: price, quantity: qty };
    emit('BidRevealed', { seriesId: s.seriesId, bidder: signer, pricePerUnit: cmd.pricePerUnit, quantity: cmd.quantity });
  }
  private settleAuction(cmd: Extract<Command, { kind: 'settleAuction' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    if (this.auctionPhase(s, now) !== 'SettleDue') throw new ChainError('TooEarly', 'reveal phase has not ended');
    const mint = s.terms.stablecoinMint;
    const revealed = [...s.bids.values()].filter((b) => b.revealed).map((b) => ({ bidder: b.bidder, pricePerUnit: b.revealed!.pricePerUnit, quantity: b.revealed!.quantity, order: b.order }));
    const res = clearAuction({ bids: revealed, unitsOffered: s.terms.unitsOffered, reservePrice: s.terms.reservePrice, minimumRaise: s.terms.minimumRaise, walletCapUnits: walletCapUnits(s.terms.unitsOffered, s.terms.walletCapBps), auctionFeeBps: s.terms.auctionFeeBps });
    if (!res.success) {
      for (const b of s.bids.values()) {
        b.refundable = b.deposit;
        b.settled = true;
      }
      s.phase = 'Failed';
      emit('AuctionFailed', { seriesId: s.seriesId, reason: res.reason! });
      return;
    }
    for (const b of s.bids.values()) {
      const alloc = res.allocations.find((a) => a.bidder === b.bidder);
      if (alloc) {
        if (!this.state.allowlist.has(b.bidder)) throw new ChainError('NotAllowlisted', `${b.bidder} lost allowlisting before settlement`);
        b.allocatedUnits = alloc.units;
        b.refundable = b.deposit - alloc.amount - alloc.fee;
        this.credit(this.state.feeCollector, mint, alloc.fee);
        emit('FeeTaken', { seriesId: s.seriesId, kind: 'auction', amount: str(alloc.fee), payer: b.bidder });
        const p = this.position(s, b.bidder);
        this.setUnits(s, p, p.units + alloc.units);
        emit('UnitsMinted', { seriesId: s.seriesId, holder: b.bidder, units: str(alloc.units) });
      } else {
        b.refundable = b.deposit;
      }
      b.settled = true;
    }
    s.phase = 'Settled';
    s.settledAt = now;
    s.issuePrice = res.clearingPrice;
    s.unitsSold = res.unitsSold;
    s.unitsOutstanding = res.unitsSold;
    s.capPerUnit = perUnitCap(s.terms.capMultipleWad, res.clearingPrice);
    s.treasuryTotal = res.proceeds;
    let allocated = 0n;
    s.tranches = s.terms.releaseSchedule.map((t, i, arr) => {
      const amount = i === arr.length - 1 ? res.proceeds - allocated : bpsOf(res.proceeds, BigInt(t.bps));
      allocated += amount;
      return { index: i, afterSeconds: t.afterSeconds, bps: t.bps, amount, drawn: false };
    });
    emit('AuctionSettled', { seriesId: s.seriesId, clearingPrice: str(res.clearingPrice), unitsSold: str(res.unitsSold), proceeds: str(res.proceeds), totalFees: str(res.totalFees), settledAt: now });
    emit('TreasuryFunded', { seriesId: s.seriesId, amount: str(res.proceeds) });
  }
  private claimRefund(signer: string, cmd: Extract<Command, { kind: 'claimRefund' }>, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    const b = s.bids.get(signer);
    if (!b) throw new ChainError('NotFound', 'no bid');
    if (!b.settled) throw new ChainError('TooEarly', 'auction not settled');
    if (b.refundable === 0n) throw new ChainError('NotFound', 'nothing to refund');
    const amount = b.refundable;
    b.refundable = 0n;
    b.refunded += amount;
    this.credit(signer, s.terms.stablecoinMint, amount);
    emit('BidRefunded', { seriesId: s.seriesId, bidder: signer, amount: str(amount) });
  }

  // ------------------------------------------------------------------ treasury
  private drawRelease(signer: string, cmd: Extract<Command, { kind: 'drawRelease' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    this.requireIssuer(s, signer);
    if (s.phase !== 'Settled') throw new ChainError('WrongPhase', 'auction not settled');
    if (s.status === 'Extinguished') throw new ChainError('WrongStatus', 'series extinguished');
    if (s.releasesPausedLate || s.releasesPausedByIssuer) throw new ChainError('Paused', 'releases are paused');
    let any = false;
    for (const t of s.tranches) {
      if (t.drawn || s.settledAt! + t.afterSeconds > now) continue;
      t.drawn = true;
      s.treasuryReleased += t.amount;
      this.credit(signer, s.terms.stablecoinMint, t.amount);
      emit('FundsReleased', { seriesId: s.seriesId, amount: str(t.amount), trancheIndex: t.index });
      any = true;
    }
    if (!any) throw new ChainError('TooEarly', 'no tranche is drawable yet');
  }
  private pauseReleases(signer: string, cmd: Extract<Command, { kind: 'pauseReleases' }>, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    this.requireIssuer(s, signer);
    if (s.releasesPausedByIssuer === cmd.paused) return;
    s.releasesPausedByIssuer = cmd.paused;
    if (cmd.paused) {
      if (!s.releasesPausedLate) emit('ReleasesPaused', { seriesId: s.seriesId, reason: 'IssuerRequest' });
    } else if (!s.releasesPausedLate) emit('ReleasesResumed', { seriesId: s.seriesId });
  }

  // ------------------------------------------------------------------ reporting and paying in
  private verifyAttestation(a: NonNullable<Extract<Command, { kind: 'submitReport' }>['attestation']>, cmd: Extract<Command, { kind: 'submitReport' }>): void {
    const key = this.state.verifierKeys.get(a.keyId);
    if (!key || !key.active) throw new ChainError('InvalidAttestation', `verifier key ${a.keyId} not registered`);
    if (a.seriesId !== cmd.seriesId || a.periodId !== cmd.periodId || a.incomeCommitment !== cmd.incomeCommitment || a.tier !== cmd.tier || a.source !== cmd.source) {
      throw new ChainError('InvalidAttestation', 'attestation fields do not match the report');
    }
    const msg = attestationMessage({ seriesId: a.seriesId, periodId: a.periodId, incomeCommitment: a.incomeCommitment, tier: a.tier, source: a.source });
    let ok = false;
    try {
      const pub = createPublicKey({ key: Buffer.from(key.publicKey, 'hex'), format: 'der', type: 'spki' });
      ok = edVerify(null, Buffer.from(msg), pub, Buffer.from(a.signature.replace(/^0x/, ''), 'hex'));
    } catch {
      ok = false;
    }
    if (!ok) throw new ChainError('InvalidAttestation', 'bad verifier signature');
  }
  /** Public input layout v0 — see reportPublicInputs() in @merces/domain. */
  static publicInputs(p: { termsCommitment: string; incomeCommitment: string; unitsOutstanding: bigint; paymentStable: bigint; fxAvgWad: bigint; periodId: string }): string[] {
    return reportPublicInputs(p);
  }
  private verifyProof(cmd: Extract<Command, { kind: 'submitReport' }>, s: SimSeries): void {
    const units = s.redemption ? s.redemption.unitsAtRedemption : s.unitsOutstanding;
    const expected = SimEngine.publicInputs({ termsCommitment: cmd.termsCommitment, incomeCommitment: cmd.incomeCommitment, unitsOutstanding: units, paymentStable: big(cmd.paymentStable), fxAvgWad: big(cmd.fxAvgWad), periodId: cmd.periodId });
    if (expected.length !== cmd.proof.publicInputs.length || expected.some((x, i) => x !== cmd.proof.publicInputs[i])) throw new ChainError('InvalidProof', 'public inputs do not match the report');
    if (cmd.proof.system === 'mock') {
      if (!mockVerify(cmd.proof.proof, cmd.proof.publicInputs)) throw new ChainError('InvalidProof', 'mock proof failed');
    } else {
      if (!this.opts.groth16Verifier) throw new ChainError('InvalidProof', 'no Groth16 verifier configured in the simulator');
      if (!this.opts.groth16Verifier(cmd.proof.proof, cmd.proof.publicInputs)) throw new ChainError('InvalidProof', 'Groth16 proof failed');
    }
  }
  private submitReport(signers: string[], cmd: Extract<Command, { kind: 'submitReport' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    const issuer = signers[0];
    if (!issuer) throw new ChainError('Unauthorized', 'no signer');
    this.requireIssuer(s, issuer);
    if (s.phase !== 'Settled') throw new ChainError('WrongPhase', 'auction not settled');
    if (s.status === 'Retired' || s.status === 'Extinguished') throw new ChainError('WrongStatus', `series is ${s.status}`);
    if (cmd.termsCommitment !== s.terms.termsCommitment) throw new ChainError('InvalidTerms', 'terms commitment mismatch');
    const tierOk = (cmd.tier === 1 && s.terms.tierFlags.tier1) || (cmd.tier === 2 && s.terms.tierFlags.tier2) || (cmd.tier === 3 && s.terms.tierFlags.tier3) || (cmd.tier === 4 && s.terms.tierFlags.tier4);
    if (!tierOk) throw new ChainError('NotPermitted', `tier ${cmd.tier} is not enabled for this series`);
    const period = parsePeriod(cmd.periodId);
    if (period.end > now) throw new ChainError('TooEarly', 'period has not ended');
    const isTail = s.status === 'Redeemed';
    if (isTail) {
      if (!cmd.liquidityEvent) throw new ChainError('WrongStatus', 'after redemption only liquidity-event (tail) reports are accepted');
      if (now > s.redemption!.tailEndsAt) throw new ChainError('TooLate', 'tail window closed');
    } else if (period.end <= s.settledAt!) {
      throw new ChainError('InvalidTerms', 'period predates settlement');
    }
    const p = this.period(s, cmd.periodId);
    if (p.reportAccepted) throw new ChainError('Duplicate', 'report already accepted for this period');
    // tier-specific authorisation
    if (cmd.tier === 2) {
      if (!cmd.attestation) throw new ChainError('InvalidAttestation', 'tier 2 needs a verifier attestation');
      this.verifyAttestation(cmd.attestation, cmd);
    } else if (cmd.tier === 3) {
      if (!cmd.attestor || !signers.includes(cmd.attestor)) throw new ChainError('Unauthorized', 'tier 3 needs the attestor as co-signer');
      this.requireAttestor(cmd.attestor);
    }
    // FX
    const fx = big(cmd.fxAvgWad);
    if (cmd.fxBasis === 'unity') {
      if (s.terms.reportingCurrency !== 'USD') throw new ChainError('InvalidTerms', 'unity FX only for USD reporting');
      if (fx !== WAD) throw new ChainError('InvalidTerms', 'unity FX must be 1e18');
    } else {
      if (!cmd.pair || cmd.pair !== `${s.terms.reportingCurrency}/USD`) throw new ChainError('InvalidTerms', 'pair must be <reporting currency>/USD');
      const q = this.quarterRate(cmd.pair, cmd.periodId);
      if (cmd.fxBasis === 'accumulator') {
        if (!q || q.avgWad === null || q.needsFallback) throw new ChainError('InvalidTerms', 'accumulator rate unavailable or flagged; use an attestor rate');
        if (fx !== q.avgWad) throw new ChainError('InvalidTerms', 'fxAvg does not match the accumulator');
      } else {
        if (!(q === null || q.avgWad === null || q.needsFallback)) throw new ChainError('InvalidTerms', 'accumulator rate is available; attestor rate not allowed');
        if (!cmd.attestorRate || !signers.includes(cmd.attestorRate.attestor)) throw new ChainError('Unauthorized', 'attestor rate needs the attestor as co-signer');
        this.requireAttestor(cmd.attestorRate.attestor);
        if (big(cmd.attestorRate.rateWad) !== fx || cmd.attestorRate.pair !== cmd.pair) throw new ChainError('InvalidTerms', 'attestor rate mismatch');
      }
    }
    this.verifyProof(cmd, s);
    const paymentStable = big(cmd.paymentStable);
    let accrual = 0n;
    let due: bigint;
    if (isTail) {
      const r = s.redemption!;
      const perUnit = tailPayoutPerUnit(paymentStable / r.unitsAtRedemption, r.tailCapPerUnit, r.tailPaidPerUnit);
      due = perUnit * r.unitsAtRedemption;
      p.isTail = true;
    } else {
      const outstanding = paymentStable > p.splitReceived ? paymentStable - p.splitReceived : 0n;
      const d = this.deadlines(s, period, now);
      accrual = s.status === 'Paused' ? 0n : lateAccrual(outstanding, s.terms.hurdleWad, daysLate(d.graceEndsAt, now));
      due = outstanding + accrual;
    }
    p.reportAccepted = true;
    p.tier = cmd.tier;
    p.paymentStable = paymentStable;
    p.accrual = accrual;
    p.paymentDue = due;
    p.incomeCommitment = cmd.incomeCommitment;
    p.liquidityEvent = cmd.liquidityEvent;
    p.acceptedAt = now;
    if (due === 0n) p.settled = true;
    emit('ReportAccepted', { seriesId: s.seriesId, periodId: cmd.periodId, tier: cmd.tier, paymentDue: str(due), accrual: str(accrual), incomeCommitment: cmd.incomeCommitment, termsCommitment: cmd.termsCommitment, fxBasis: cmd.fxBasis, fxAvgWad: cmd.fxAvgWad, liquidityEvent: cmd.liquidityEvent });
    this.refreshStanding(s, now, emit);
  }
  private payIn(signer: string, cmd: Extract<Command, { kind: 'payIn' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    this.requireIssuer(s, signer);
    const p = s.periods.get(cmd.periodId);
    if (!p || !p.reportAccepted) throw new ChainError('NotFound', 'no accepted report for this period');
    if (p.settled) throw new ChainError('Duplicate', 'period already paid');
    const amount = big(cmd.amount);
    const remaining = p.paymentDue - p.paid;
    if (amount !== remaining) throw new ChainError('InvalidTerms', `payIn must equal the remaining due ${remaining}`);
    if (p.isTail) {
      const r = s.redemption!;
      const mint = s.terms.stablecoinMint;
      this.debit(signer, mint, amount);
      const { fee, net } = payoutFee(amount, s.terms.payoutFeeBps);
      if (fee > 0n) {
        this.credit(this.state.feeCollector, mint, fee);
        emit('FeeTaken', { seriesId: s.seriesId, kind: 'payout', amount: str(fee), payer: signer });
      }
      r.accTailNetWad += mulDiv(net, WAD, r.unitsAtRedemption);
      r.tailPaidPerUnit += amount / r.unitsAtRedemption;
      s.vaultBalance += net;
      s.grossPaidTotal += amount;
      s.feesTotal += fee;
      emit('PaymentReceived', { seriesId: s.seriesId, periodId: cmd.periodId, gross: str(amount), fee: str(fee), net: str(net), source: 'tail', paidPerUnitWad: str(s.paidPerUnitWad) });
      emit('TailPayout', { seriesId: s.seriesId, periodId: cmd.periodId, perUnit: str(amount / r.unitsAtRedemption), total: str(amount) });
    } else {
      this.receivePayment(s, signer, amount, cmd.periodId, 'payIn', now, emit);
    }
    p.paid += amount;
    p.settled = true;
    this.refreshStanding(s, now, emit);
  }
  private postSplitReceipt(router: string, cmd: Extract<Command, { kind: 'postSplitReceipt' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    if (s.splitRouter !== router) throw new ChainError('Unauthorized', 'router not registered for this series');
    if (s.phase !== 'Settled' || TERMINAL.has(s.status)) throw new ChainError('WrongStatus', 'series cannot receive split income');
    const amount = big(cmd.amount);
    const periodId = periodOf(now).id;
    const { accepted } = this.receivePayment(s, router, amount, periodId, 'split', now, emit);
    this.period(s, periodId).splitReceived += accepted;
    emit('SplitReceipt', { seriesId: s.seriesId, periodId, amount: str(accepted), router });
  }

  // ------------------------------------------------------------------ payouts, burns
  private claimPayout(signer: string, cmd: Extract<Command, { kind: 'claimPayout' }>, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    const p = s.positions.get(signer);
    if (!p) throw new ChainError('NotFound', 'no position');
    this.settlePosition(s, p);
    let amount = p.pending;
    p.pending = 0n;
    if (s.redemption && p.redeemedUnits > 0n) {
      const tail = claimable(p.redeemedUnits, s.redemption.accTailNetWad, p.tailDebt);
      p.tailDebt = rewardDebt(p.redeemedUnits, s.redemption.accTailNetWad);
      amount += tail;
    }
    if (amount <= 0n) throw new ChainError('NotFound', 'nothing to claim');
    if (amount > s.vaultBalance) throw new ChainError('ChainSpecific', 'vault invariant violated'); // never happens: every division floors
    s.vaultBalance -= amount;
    s.vaultDistributedNet += amount;
    p.claimedTotal += amount;
    this.credit(signer, s.terms.stablecoinMint, amount);
    emit('PayoutClaimed', { seriesId: s.seriesId, holder: signer, amount: str(amount) });
    if ((s.status === 'Retired' || s.status === 'Extinguished') && p.units > 0n) this.burn(s, p, s.status === 'Retired' ? 'cap' : 'extinguishment', emit);
  }
  private burn(s: SimSeries, p: SimPosition, reason: 'cap' | 'redemption' | 'extinguishment', emit: Emit): void {
    const units = p.units;
    if (units === 0n) return;
    this.setUnits(s, p, 0n);
    s.unitsOutstanding -= units;
    emit('UnitsBurned', { seriesId: s.seriesId, holder: p.wallet, units: str(units), reason });
  }
  private crankBurn(cmd: Extract<Command, { kind: 'crankBurn' }>, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    if (s.status !== 'Retired' && s.status !== 'Extinguished') throw new ChainError('WrongStatus', 'units are burnable only when Retired or Extinguished');
    let any = false;
    for (const h of cmd.holders) {
      const p = s.positions.get(h);
      if (p && p.units > 0n) {
        this.burn(s, p, s.status === 'Retired' ? 'cap' : 'extinguishment', emit);
        any = true;
      }
    }
    if (!any) throw new ChainError('NotFound', 'nothing to burn');
  }

  // ------------------------------------------------------------------ pauses and status
  private requestPause(signer: string, cmd: Extract<Command, { kind: 'requestPause' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    this.requireIssuer(s, signer);
    if (s.phase !== 'Settled' || TERMINAL.has(s.status) || s.status === 'Paused') throw new ChainError('WrongStatus', `cannot request a pause while ${s.status}`);
    if (cmd.until <= now) throw new ChainError('InvalidTerms', 'pause end must be in the future');
    s.pause = { requestedUntil: cmd.until, approvedUntil: null, startedAt: null };
    emit('PauseRequested', { seriesId: s.seriesId, until: cmd.until });
  }
  private approvePause(signer: string, cmd: Extract<Command, { kind: 'approvePause' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    this.requireAttestor(signer);
    if (!s.pause || s.pause.requestedUntil === null || s.pause.startedAt !== null) throw new ChainError('WrongStatus', 'no pending pause request');
    if (cmd.until <= now || cmd.until > s.pause.requestedUntil) throw new ChainError('InvalidTerms', 'approved end must be in the future and not after the requested end');
    s.pause.approvedUntil = cmd.until;
    s.pause.startedAt = now;
    emit('PauseApproved', { seriesId: s.seriesId, attestor: signer, until: cmd.until });
    this.setStatus(s, 'Paused', emit);
  }
  private crankPause(cmd: Extract<Command, { kind: 'crankPause' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    if (s.status !== 'Paused' || !s.pause?.startedAt || s.pause.approvedUntil === null) throw new ChainError('WrongStatus', 'not paused');
    if (now < s.pause.approvedUntil) throw new ChainError('TooEarly', 'pause has not ended');
    const paused = s.pause.approvedUntil - s.pause.startedAt;
    s.pauseIntervals.push({ from: s.pause.startedAt, to: s.pause.approvedUntil });
    s.pausedSecondsTotal += paused;
    s.pause = null;
    emit('PauseEnded', { seriesId: s.seriesId, pausedSeconds: paused });
    s.status = 'OnTime';
    const { status } = this.derivedStanding(s, now);
    s.status = 'Paused';
    this.setStatus(s, status, emit);
    this.refreshStanding(s, now, emit);
  }
  private crankStatus(cmd: Extract<Command, { kind: 'crankStatus' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    if (s.phase !== 'Settled') throw new ChainError('WrongPhase', 'auction not settled');
    if (TERMINAL.has(s.status) || s.status === 'Paused') return;
    this.refreshStanding(s, now, emit);
    for (const per of this.reportablePeriods(s, now)) {
      if (this.isPeriodSettled(s, per.id)) continue;
      const st = periodStanding(this.deadlines(s, per, now), now, false);
      const p = this.period(s, per.id);
      if (st === 'FormalNoticeDue' && !p.formalNoticeEmitted) {
        p.formalNoticeEmitted = true;
        emit('FormalNoticeDue', { seriesId: s.seriesId, periodId: per.id });
      }
    }
  }

  // ------------------------------------------------------------------ redemption
  quote(s: SimSeries, now: number) {
    return redemptionQuote({ capPerUnit: s.capPerUnit!, paidPerUnitWad: s.paidPerUnitWad, issuePrice: s.issuePrice!, hurdleWad: s.terms.hurdleWad, payoutMultipleK: s.terms.payoutMultipleK, settlementTs: s.settledAt!, nowTs: now, annualGrossPerUnit: this.annualGrossPerUnit(s, now) });
  }
  private redeem(signer: string, cmd: Extract<Command, { kind: 'redeem' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    this.requireIssuer(s, signer);
    if (s.phase !== 'Settled') throw new ChainError('WrongPhase', 'auction not settled');
    if (TERMINAL.has(s.status) || s.status === 'Paused') throw new ChainError('WrongStatus', `cannot redeem while ${s.status}`);
    if (now < s.settledAt! + s.terms.lockupSeconds) throw new ChainError('TooEarly', 'lockup has not ended');
    for (const per of this.reportablePeriods(s, now)) if (!this.isPeriodSettled(s, per.id)) throw new ChainError('WrongStatus', `period ${per.id} must be reported and paid before redemption (A-RED-1)`);
    const q = this.quote(s, now);
    if (q.pricePerUnit > big(cmd.maxPricePerUnit)) throw new ChainError('InvalidTerms', `price ${q.pricePerUnit} exceeds maxPricePerUnit`);
    const deposit = q.pricePerUnit * s.unitsOutstanding;
    this.debit(signer, s.terms.stablecoinMint, deposit);
    const tailEndsAt = now + DEFAULTS.tailMonths * 30 * 86_400;
    s.redemption = { openedAt: now, pricePerUnit: q.pricePerUnit, unitsAtRedemption: s.unitsOutstanding, deposit, claimed: 0n, tailCapPerUnit: q.tailCapPerUnit, tailEndsAt, tailPaidPerUnit: 0n, accTailNetWad: 0n };
    for (const p of s.positions.values()) {
      p.redeemedUnits = p.units;
      p.tailDebt = 0n;
    }
    emit('RedemptionOpened', { seriesId: s.seriesId, pricePerUnit: str(q.pricePerUnit), unitsOutstanding: str(s.unitsOutstanding), deposit: str(deposit), tailCapPerUnit: str(q.tailCapPerUnit), tailEndsAt });
    this.setStatus(s, 'Redeemed', emit);
  }
  private claimRedemption(signer: string, cmd: Extract<Command, { kind: 'claimRedemption' }>, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    const r = s.redemption;
    if (!r) throw new ChainError('WrongStatus', 'no redemption open');
    const p = s.positions.get(signer);
    if (!p || p.units === 0n) throw new ChainError('NotFound', 'no units to redeem');
    const units = p.units;
    const amount = r.pricePerUnit * units;
    // settle any outstanding payouts first so nothing is stranded by the burn
    this.settlePosition(s, p);
    const pending = p.pending;
    p.pending = 0n;
    if (pending > 0n) {
      s.vaultBalance -= pending;
      s.vaultDistributedNet += pending;
      p.claimedTotal += pending;
      this.credit(signer, s.terms.stablecoinMint, pending);
      emit('PayoutClaimed', { seriesId: s.seriesId, holder: signer, amount: str(pending) });
    }
    r.claimed += amount;
    p.redemptionClaimed = true;
    this.credit(signer, s.terms.stablecoinMint, amount);
    this.burn(s, p, 'redemption', emit);
    emit('RedemptionClaimed', { seriesId: s.seriesId, holder: signer, units: str(units), amount: str(amount) });
  }

  // ------------------------------------------------------------------ amendments and extinguishment
  private amendTerms(signers: string[], cmd: Extract<Command, { kind: 'amendTerms' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    const issuer = signers[0];
    if (!issuer) throw new ChainError('Unauthorized', 'no signer');
    this.requireIssuer(s, issuer);
    if (!signers.includes(cmd.attestor)) throw new ChainError('Unauthorized', 'attestor must co-sign the amendment');
    this.requireAttestor(cmd.attestor);
    if (TERMINAL.has(s.status)) throw new ChainError('WrongStatus', 'series ended');
    const newCap = big(cmd.capMultipleWad);
    if (newCap > s.terms.capMultipleWad) throw new ChainError('InvalidTerms', 'the cap multiple may only decrease');
    if (newCap < DEFAULTS.capMultipleMinWad) throw new ChainError('InvalidTerms', 'cap multiple below the floor');
    const previous = s.terms.termsCommitment;
    s.terms.termsCommitment = cmd.termsCommitment;
    s.terms.capMultipleWad = newCap;
    if (s.issuePrice !== null) s.capPerUnit = perUnitCap(newCap, s.issuePrice);
    s.amendments.push({ at: now, termsCommitment: cmd.termsCommitment, capMultipleWad: newCap, attestor: cmd.attestor });
    emit('TermsAmended', { seriesId: s.seriesId, termsCommitment: cmd.termsCommitment, previousCommitment: previous, capMultipleWad: cmd.capMultipleWad, attestor: cmd.attestor });
  }
  private extinguish(signers: string[], cmd: Extract<Command, { kind: 'extinguish' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    const [a1, a2] = cmd.attestors;
    if (!a1 || !a2 || a1 === a2) throw new ChainError('InvalidTerms', 'two distinct attestors required');
    if (!signers.includes(a1) || !signers.includes(a2)) throw new ChainError('Unauthorized', 'both attestors must sign');
    this.requireAttestor(a1);
    this.requireAttestor(a2);
    if (s.status === 'Extinguished') throw new ChainError('Duplicate', 'already extinguished');
    let returned = 0n;
    if (s.phase === 'Settled' && s.unitsOutstanding > 0n) {
      const unreleased = s.treasuryTotal - s.treasuryReleased;
      for (const t of s.tranches) t.drawn = true;
      s.treasuryReleased = s.treasuryTotal;
      if (unreleased > 0n) {
        // Returned to holders pro rata, no fee, outside the cap (A-C11-6).
        s.accNetWad = accrueNet(s.accNetWad, unreleased, s.unitsOutstanding);
        s.vaultBalance += unreleased;
        returned = unreleased;
        emit('PaymentReceived', { seriesId: s.seriesId, periodId: null, gross: str(unreleased), fee: '0', net: str(unreleased), source: 'extinguishment', paidPerUnitWad: str(s.paidPerUnitWad) });
      }
    }
    s.extinguishedAt = now;
    s.pause = null;
    emit('SeriesExtinguished', { seriesId: s.seriesId, attestors: [a1, a2], returnedToHolders: str(returned) });
    this.setStatus(s, 'Extinguished', emit);
  }

  // ------------------------------------------------------------------ rate accumulator
  private snapshotRate(cmd: Extract<Command, { kind: 'snapshotRate' }>, now: number, emit: Emit): void {
    if (now - cmd.publishTime > DEFAULTS.maxRateAgeSeconds || cmd.publishTime > now + 60) throw new ChainError('TooLate', 'stale price update');
    const rate = big(cmd.rateWad);
    const conf = big(cmd.confWad);
    if (rate <= 0n) throw new ChainError('InvalidTerms', 'rate must be positive');
    if (conf * 100n > rate) throw new ChainError('InvalidTerms', 'confidence interval too wide (>1%)');
    let acc = this.state.rates.get(cmd.pair);
    if (!acc) {
      acc = { pair: cmd.pair, sumWad: 0n, count: 0, days: [] };
      this.state.rates.set(cmd.pair, acc);
    }
    const day = utcDayIndex(now);
    const last = acc.days[acc.days.length - 1];
    if (last && last.dayIndex >= day) throw new ChainError('Duplicate', 'one snapshot per UTC day per feed');
    acc.sumWad += rate;
    acc.count += 1;
    acc.days.push({ dayIndex: day, rateWad: rate, cumSumWad: acc.sumWad, cumCount: acc.count });
    emit('RateSnapshot', { pair: cmd.pair, rateWad: cmd.rateWad, confWad: cmd.confWad, publishTime: cmd.publishTime, dayIndex: day, sumWad: str(acc.sumWad), count: acc.count });
  }
  quarterRate(pair: string, periodId: string): { avgWad: bigint | null; snapshots: number; days: number; coverageOk: boolean; needsFallback: boolean; reason: 'coverage' | 'deviation' | null } | null {
    const acc = this.state.rates.get(pair);
    const per = parsePeriod(periodId);
    const flag = this.state.fxFallbacks.get(`${pair}|${periodId}`) ?? null;
    if (!acc) return { avgWad: null, snapshots: 0, days: per.days, coverageOk: false, needsFallback: true, reason: flag ?? 'coverage' };
    const startDay = utcDayIndex(per.start);
    const endDay = utcDayIndex(per.end);
    const before = acc.days.filter((d) => d.dayIndex < startDay).at(-1);
    const upTo = acc.days.filter((d) => d.dayIndex < endDay).at(-1);
    const sumStart = before?.cumSumWad ?? 0n;
    const countStart = before?.cumCount ?? 0;
    const sumEnd = upTo?.cumSumWad ?? 0n;
    const countEnd = upTo?.cumCount ?? 0;
    const n = countEnd - countStart;
    const cov = coverageOk(n, per.days, BigInt(DEFAULTS.minCoverageBps));
    const needsFallback = !cov || flag !== null;
    return { avgWad: n > 0 ? quarterAverageRate(sumEnd, sumStart, countEnd, countStart) : null, snapshots: n, days: per.days, coverageOk: cov, needsFallback, reason: flag ?? (cov ? null : 'coverage') };
  }
  private flagFxFallback(cmd: Extract<Command, { kind: 'flagFxFallback' }>, now: number, emit: Emit): void {
    const per = parsePeriod(cmd.periodId);
    if (per.end > now) throw new ChainError('TooEarly', 'quarter not over');
    const key = `${cmd.pair}|${cmd.periodId}`;
    if (this.state.fxFallbacks.has(key)) throw new ChainError('Duplicate', 'already flagged');
    if (cmd.reason === 'coverage') {
      const q = this.quarterRate(cmd.pair, cmd.periodId);
      if (q && q.coverageOk) throw new ChainError('InvalidTerms', 'coverage is sufficient');
    }
    // 'deviation': the live contracts check Chainlink themselves; the simulator trusts the keeper's evidence (A-FX-2).
    this.state.fxFallbacks.set(key, cmd.reason);
    emit('FxFallbackFlagged', { pair: cmd.pair, periodId: cmd.periodId, reason: cmd.reason });
  }

  // ------------------------------------------------------------------ transfer windows (built, switched off at the service layer)
  private openTransferWindow(cmd: Extract<Command, { kind: 'openTransferWindow' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    if (s.phase !== 'Settled' || TERMINAL.has(s.status)) throw new ChainError('WrongStatus', 'series cannot open a window');
    if (now < s.settledAt! + s.terms.lockupSeconds) throw new ChainError('TooEarly', 'lockup has not ended');
    if (s.transferWindows.some((w) => !w.cleared)) throw new ChainError('Duplicate', 'a window is already open');
    if (cmd.commitEndsAt <= now || cmd.revealEndsAt <= cmd.commitEndsAt) throw new ChainError('InvalidTerms', 'bad window timings');
    const windowId = s.transferWindows.length;
    s.transferWindows.push({ windowId, commitEndsAt: cmd.commitEndsAt, revealEndsAt: cmd.revealEndsAt, cleared: false, clearingPrice: null, orders: new Map() });
    emit('TransferWindowOpened', { seriesId: s.seriesId, windowId, commitEndsAt: cmd.commitEndsAt, revealEndsAt: cmd.revealEndsAt });
  }
  private window(s: SimSeries, id: number): SimTransferWindow {
    const w = s.transferWindows[id];
    if (!w) throw new ChainError('NotFound', 'no such window');
    return w;
  }
  private commitWindowOrder(signer: string, cmd: Extract<Command, { kind: 'commitWindowOrder' }>, now: number, _emit: Emit): void {
    const s = this.series(cmd.seriesId);
    const w = this.window(s, cmd.windowId);
    if (w.cleared || now >= w.commitEndsAt) throw new ChainError('WrongPhase', 'commit phase over');
    if (w.orders.has(signer)) throw new ChainError('Duplicate', 'one order per wallet per window');
    const deposit = big(cmd.deposit);
    const units = big(cmd.units);
    if (cmd.side === 'buy') {
      this.requireAllowlisted(signer); // removed wallets may still SELL (C10: never strand value)
      if (deposit <= 0n) throw new ChainError('InvalidTerms', 'deposit required');
      this.debit(signer, s.terms.stablecoinMint, deposit);
      w.orders.set(signer, { wallet: signer, side: 'buy', commitment: cmd.commitment, deposit, escrowedUnits: 0n, order: w.orders.size, revealed: null });
    } else {
      const p = s.positions.get(signer);
      if (!p || p.units < units || units <= 0n) throw new ChainError('InsufficientFunds', 'not enough units');
      this.setUnits(s, p, p.units - units); // escrow
      w.orders.set(signer, { wallet: signer, side: 'sell', commitment: cmd.commitment, deposit: 0n, escrowedUnits: units, order: w.orders.size, revealed: null });
    }
  }
  private revealWindowOrder(signer: string, cmd: Extract<Command, { kind: 'revealWindowOrder' }>, now: number, _emit: Emit): void {
    const s = this.series(cmd.seriesId);
    const w = this.window(s, cmd.windowId);
    if (w.cleared || now < w.commitEndsAt || now >= w.revealEndsAt) throw new ChainError('WrongPhase', 'not in the reveal phase');
    const o = w.orders.get(signer);
    if (!o || o.side !== cmd.side) throw new ChainError('NotFound', 'no matching order');
    if (o.revealed) throw new ChainError('Duplicate', 'already revealed');
    const price = big(cmd.pricePerUnit);
    const qty = big(cmd.quantity);
    const expected = orderCommitment({ seriesId: s.seriesId, windowId: w.windowId, wallet: signer, side: cmd.side, pricePerUnit: price, quantity: qty, salt: cmd.salt });
    if (expected !== o.commitment) throw new ChainError('InvalidCommitment', 'reveal mismatch');
    if (o.side === 'buy' && price * qty > o.deposit) throw new ChainError('InsufficientFunds', 'deposit too small');
    if (o.side === 'sell' && qty > o.escrowedUnits) throw new ChainError('InsufficientFunds', 'more than escrowed');
    o.revealed = { pricePerUnit: price, quantity: qty };
  }
  private clearTransferWindow(cmd: Extract<Command, { kind: 'clearTransferWindow' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    const w = this.window(s, cmd.windowId);
    if (w.cleared) throw new ChainError('Duplicate', 'already cleared');
    if (now < w.revealEndsAt) throw new ChainError('TooEarly', 'reveal phase not over');
    const mint = s.terms.stablecoinMint;
    const buys = [...w.orders.values()].filter((o) => o.side === 'buy' && o.revealed).sort((a, b) => (a.revealed!.pricePerUnit === b.revealed!.pricePerUnit ? a.order - b.order : a.revealed!.pricePerUnit > b.revealed!.pricePerUnit ? -1 : 1));
    const sells = [...w.orders.values()].filter((o) => o.side === 'sell' && o.revealed).sort((a, b) => (a.revealed!.pricePerUnit === b.revealed!.pricePerUnit ? a.order - b.order : a.revealed!.pricePerUnit < b.revealed!.pricePerUnit ? -1 : 1));
    const cap = walletCapUnits(s.unitsOutstanding, s.terms.walletCapBps);
    const fills: { buyer: string; seller: string; units: bigint }[] = [];
    let clearing = 0n;
    let bi = 0;
    let si = 0;
    const buyLeft = buys.map((b) => b.revealed!.quantity);
    const sellLeft = sells.map((x) => x.revealed!.quantity);
    while (bi < buys.length && si < sells.length) {
      const b = buys[bi]!;
      const x = sells[si]!;
      if (b.revealed!.pricePerUnit < x.revealed!.pricePerUnit) break;
      const held = (s.positions.get(b.wallet)?.units ?? 0n) + fills.filter((f) => f.buyer === b.wallet).reduce((a, f) => a + f.units, 0n);
      const room = cap > held ? cap - held : 0n;
      const units = min(min(buyLeft[bi]!, sellLeft[si]!), room);
      if (units === 0n) {
        bi++;
        continue;
      }
      fills.push({ buyer: b.wallet, seller: x.wallet, units });
      clearing = b.revealed!.pricePerUnit;
      buyLeft[bi] = buyLeft[bi]! - units;
      sellLeft[si] = sellLeft[si]! - units;
      if (buyLeft[bi] === 0n) bi++;
      if (sellLeft[si] === 0n) si++;
    }
    let transferred = 0n;
    for (const f of fills) {
      const buyer = this.position(s, f.buyer);
      const seller = this.position(s, f.seller);
      const sellOrder = w.orders.get(f.seller)!;
      sellOrder.escrowedUnits -= f.units;
      this.setUnits(s, buyer, buyer.units + f.units);
      const amount = f.units * clearing;
      const buyOrder = w.orders.get(f.buyer)!;
      buyOrder.deposit -= amount;
      this.credit(f.seller, mint, amount);
      transferred += f.units;
      void seller;
      emit('UnitsTransferred', { seriesId: s.seriesId, from: f.seller, to: f.buyer, units: str(f.units), windowId: w.windowId });
    }
    // refunds: leftover deposits and un-sold escrowed units
    for (const o of w.orders.values()) {
      if (o.side === 'buy' && o.deposit > 0n) {
        this.credit(o.wallet, mint, o.deposit);
        o.deposit = 0n;
      }
      if (o.side === 'sell' && o.escrowedUnits > 0n) {
        const p = this.position(s, o.wallet);
        this.setUnits(s, p, p.units + o.escrowedUnits);
        o.escrowedUnits = 0n;
      }
    }
    w.cleared = true;
    w.clearingPrice = transferred > 0n ? clearing : null;
    emit('TransferWindowCleared', { seriesId: s.seriesId, windowId: w.windowId, clearingPrice: str(transferred > 0n ? clearing : 0n), unitsTransferred: str(transferred) });
  }

  // ------------------------------------------------------------------ curve mode (Solana only; toy linear curve)
  private buyCurve(signer: string, cmd: Extract<Command, { kind: 'buyCurve' }>, now: number, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    const c = s.curve;
    if (!c) throw new ChainError('WrongPhase', 'not a curve-mode series');
    if (c.graduated) throw new ChainError('WrongPhase', 'curve graduated; trade on the DEX');
    const amountIn = big(cmd.amountIn);
    if (amountIn <= 0n) throw new ChainError('InvalidTerms', 'amountIn must be positive');
    const spot = c.basePrice + mulDiv(c.basePrice, c.slopeWad * s.unitsOutstanding, WAD);
    const units = amountIn / spot;
    if (units < big(cmd.minUnitsOut) || units === 0n) throw new ChainError('InvalidTerms', 'slippage: fewer units than minUnitsOut');
    this.debit(signer, s.terms.stablecoinMint, amountIn);
    c.raised += amountIn;
    s.treasuryTotal += amountIn;
    const p = this.position(s, signer);
    this.setUnits(s, p, p.units + units);
    s.unitsOutstanding += units;
    s.unitsSold += units;
    emit('UnitsMinted', { seriesId: s.seriesId, holder: signer, units: str(units) });
    emit('TreasuryFunded', { seriesId: s.seriesId, amount: str(amountIn) });
    if (c.raised >= c.graduationThreshold) this.graduate(s, now, emit);
  }
  private graduate(s: SimSeries, now: number, emit: Emit): void {
    const c = s.curve!;
    c.graduated = true;
    s.phase = 'Settled';
    s.settledAt = now;
    s.issuePrice = s.unitsSold > 0n ? c.raised / s.unitsSold : c.basePrice;
    s.capPerUnit = perUnitCap(s.terms.capMultipleWad, s.issuePrice);
    s.tranches = s.terms.releaseSchedule.map((t, i) => ({ index: i, afterSeconds: t.afterSeconds, bps: t.bps, amount: bpsOf(s.treasuryTotal, BigInt(t.bps)), drawn: false }));
    emit('CurveGraduated', { seriesId: s.seriesId, raised: str(c.raised), unitsOutstanding: str(s.unitsOutstanding) });
  }
  private graduateCurve(cmd: Extract<Command, { kind: 'graduateCurve' }>, emit: Emit): void {
    const s = this.series(cmd.seriesId);
    if (!s.curve || s.curve.graduated) throw new ChainError('WrongPhase', 'not graduatable');
    if (s.curve.raised < s.curve.graduationThreshold) throw new ChainError('TooEarly', 'threshold not reached');
    this.graduate(s, this.clock.now(), emit);
  }

  // ------------------------------------------------------------------ allowlist
  private setAllowlist(cmd: Extract<Command, { kind: 'setAllowlist' }>, emit: Emit): void {
    if (cmd.allowed) this.state.allowlist.add(cmd.wallet);
    else this.state.allowlist.delete(cmd.wallet);
    emit('AllowlistUpdated', { wallet: cmd.wallet, allowed: cmd.allowed });
  }
}

type Emit = <T extends EventType>(type: T, payload: EventPayload<T>) => void;
export { parseSeriesId };
