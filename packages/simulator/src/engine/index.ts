import {
  ChainError, parseSeriesId,
  type Command, type DomainEvent, type EventPayload, type EventType, type ServiceRole, type TxResult,
} from '@merces/domain';
import type { Deadlines, Period } from '@merces/math';
import type { SimClock } from '../clock.ts';
import type { SimSeries, SimState } from '../state.ts';
import { balKey, type EngineCore, type EngineOptions, type Emit } from './core.ts';
import { auctionPhase, cancelRaise, claimRefund, commitBid, openRaise, revealBid, settleAuction } from './auction.ts';
import { buyCurve, graduateCurve } from './curve.ts';
import { flagFxFallback, quarterRate, snapshotRate } from './fx.ts';
import { claimPayout, crankBurn, payIn, postSplitReceipt } from './payments.ts';
import { annualGrossPerUnit, claimRedemption, quote, redeem } from './redemption.ts';
import { createSeries, registerIssuer, setAllowlist, stopIssuance } from './registry.ts';
import { publicInputs, submitReport } from './reports.ts';
import { accrualNow, approvePause, crankPause, crankStatus, deadlines, derivedStanding, pausedSecondsSince, reportablePeriods, requestPause } from './status.ts';
import { amendTerms, extinguish } from './terminal.ts';
import { drawRelease, pauseReleases } from './treasury.ts';
import { clearTransferWindow, commitWindowOrder, openTransferWindow, revealWindowOrder } from './window.ts';

export type { EngineOptions } from './core.ts';

export type Actor = { kind: 'user'; signers: string[] } | { kind: 'service'; role: ServiceRole } | { kind: 'router'; router: string };

/**
 * The simulator engine: Part C as TypeScript. One `execute` = one transaction; it either applies fully
 * (emitting canonical events) or throws a ChainError and leaves the state untouched.
 * Each area lives in its own module under `engine/`; this class holds the transaction plumbing, the shared guards
 * and the public helpers `chain.ts` and the harness call.
 */
export class SimEngine implements EngineCore {
  public events: DomainEvent[] = [];
  constructor(
    public state: SimState,
    public readonly clock: SimClock,
    public readonly opts: EngineOptions = {},
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
      case 'registerIssuer': return registerIssuer(this, user(), now, emit);
      case 'stopIssuance': return stopIssuance(this, user(), emit);
      case 'createSeries': return createSeries(this, user(), cmd, now, emit);
      case 'openRaise': return openRaise(this, user(), cmd, now, emit);
      case 'cancelRaise': return cancelRaise(this, user(), cmd, emit);
      case 'commitBid': return commitBid(this, user(), cmd, now, emit);
      case 'revealBid': return revealBid(this, user(), cmd, now, emit);
      case 'settleAuction': service('any'); return settleAuction(this, cmd, now, emit);
      case 'claimRefund': return claimRefund(this, user(), cmd, emit);
      case 'drawRelease': return drawRelease(this, user(), cmd, now, emit);
      case 'pauseReleases': return pauseReleases(this, user(), cmd, emit);
      case 'submitReport': return submitReport(this, actor.kind === 'user' ? actor.signers : [], cmd, now, emit);
      case 'payIn': return payIn(this, user(), cmd, now, emit);
      case 'claimPayout': return claimPayout(this, user(), cmd, emit);
      case 'crankBurn': service('any'); return crankBurn(this, cmd, emit);
      case 'requestPause': return requestPause(this, user(), cmd, now, emit);
      case 'approvePause': return approvePause(this, user(), cmd, now, emit);
      case 'crankPause': service('any'); return crankPause(this, cmd, now, emit);
      case 'crankStatus': service('any'); return crankStatus(this, cmd, now, emit);
      case 'redeem': return redeem(this, user(), cmd, now, emit);
      case 'claimRedemption': return claimRedemption(this, user(), cmd, emit);
      case 'amendTerms': return amendTerms(this, actor.kind === 'user' ? actor.signers : [], cmd, now, emit);
      case 'extinguish': return extinguish(this, actor.kind === 'user' ? actor.signers : [], cmd, now, emit);
      case 'snapshotRate': service('keeper'); return snapshotRate(this, cmd, now, emit);
      case 'flagFxFallback': service('keeper'); return flagFxFallback(this, cmd, now, emit);
      case 'openTransferWindow': service('any'); return openTransferWindow(this, cmd, now, emit);
      case 'commitWindowOrder': return commitWindowOrder(this, user(), cmd, now, emit);
      case 'revealWindowOrder': return revealWindowOrder(this, user(), cmd, now, emit);
      case 'clearTransferWindow': service('any'); return clearTransferWindow(this, cmd, now, emit);
      case 'buyCurve': return buyCurve(this, user(), cmd, now, emit);
      case 'graduateCurve': service('any'); return graduateCurve(this, cmd, emit);
      case 'setAllowlist': service('allowlistManager'); return setAllowlist(this, cmd, emit);
      case 'registerAttestor': admin(); this.state.attestors.set(cmd.attestor, cmd.active); emit('AttestorRegistered', { attestor: cmd.attestor, active: cmd.active }); return;
      case 'registerVerifierKey': admin(); this.state.verifierKeys.set(cmd.keyId, { publicKey: cmd.publicKey, active: cmd.active }); emit('VerifierKeyRegistered', { keyId: cmd.keyId, publicKey: cmd.publicKey, active: cmd.active }); return;
      case 'pauseNewRaises': admin(); this.state.newRaisesPaused = cmd.paused; return;
      case 'setFeeCollector': admin(); this.state.feeCollector = cmd.feeCollector; return;
      case 'registerSplitRouter': admin(); this.series(cmd.seriesId).splitRouter = cmd.router; return;
      case 'postSplitReceipt': {
        if (actor.kind !== 'router') throw new ChainError('Unauthorized', 'postSplitReceipt must come from a registered router');
        return postSplitReceipt(this, actor.router, cmd, now, emit);
      }
      default: {
        const never: never = cmd;
        throw new ChainError('NotImplemented', `unknown command ${(never as { kind: string }).kind}`);
      }
    }
  }

  // ------------------------------------------------------------------ helpers (EngineCore)
  series(id: string): SimSeries {
    const s = this.state.series.get(id);
    if (!s) throw new ChainError('NotFound', `series ${id} not found`);
    return s;
  }
  requireIssuer(s: SimSeries, signer: string): void {
    if (s.issuer !== signer) throw new ChainError('Unauthorized', 'only the issuer may do this');
  }
  requireAllowlisted(wallet: string): void {
    if (!this.state.allowlist.has(wallet)) throw new ChainError('NotAllowlisted', `${wallet} is not allowlisted`);
  }
  requireAttestor(a: string): void {
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

  // ------------------------------------------------------------------ public delegates (reads, harness, tests)
  /** Completed quarters a settled series must report, oldest first (A-REP-1: the settlement quarter counts). */
  reportablePeriods(s: SimSeries, now: number): Period[] {
    return reportablePeriods(s, now);
  }
  /** Seconds of approved pause overlapping [from, now). Deadlines shift by this (C8.5). */
  pausedSecondsSince(s: SimSeries, from: number, now: number): number {
    return pausedSecondsSince(s, from, now);
  }
  /** Simple-interest accrual on the outstanding amount, from the end of grace to `now`; the deadlines already shift by paused seconds. */
  accrualNow(s: SimSeries, period: Period, outstanding: bigint, now: number): bigint {
    return accrualNow(s, period, outstanding, now);
  }
  deadlines(s: SimSeries, period: Period, now: number): Deadlines {
    return deadlines(s, period, now);
  }
  /** Derive OnTime/InGrace/Late from unsettled completed periods. */
  derivedStanding(s: SimSeries, now: number): { status: 'OnTime' | 'InGrace' | 'Late'; worst: Period | null } {
    return derivedStanding(s, now);
  }
  /** Per-unit gross for each FULL year since settlement (for D_avg). */
  annualGrossPerUnit(s: SimSeries, now: number): bigint[] {
    return annualGrossPerUnit(s, now);
  }
  /** The reveal phase is time-derived: commitEndsAt ≤ now < revealEndsAt. */
  auctionPhase(s: SimSeries, now: number): 'Draft' | 'Open' | 'Reveal' | 'SettleDue' | 'Settled' | 'Failed' | 'Cancelled' {
    return auctionPhase(s, now);
  }
  /** Public input layout v0 — see reportPublicInputs() in @merces/domain. */
  static publicInputs(p: { termsCommitment: string; incomeCommitment: string; unitsOutstanding: bigint; paymentStable: bigint; fxAvgWad: bigint; periodId: string }): string[] {
    return publicInputs(p);
  }
  quote(s: SimSeries, now: number): ReturnType<typeof quote> {
    return quote(s, now);
  }
  quarterRate(pair: string, periodId: string): ReturnType<typeof quarterRate> {
    return quarterRate(this, pair, periodId);
  }
}

export { parseSeriesId };
