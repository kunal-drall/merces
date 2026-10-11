import {
  ChainError, parseSeriesId,
  type Command, type DomainEvent, type EventPayload, type EventType, type ServiceRole, type TxResult,
} from '@merces/domain';
import type { Period } from '@merces/math';
import type { SimClock } from '../clock.ts';
import type { SimSeries, SimState } from '../state.ts';
import { balKey, type EngineCore, type EngineOptions, type Emit, type ExecContext } from './core.ts';
import { fail } from './errors.ts';
import { auctionPhase, cancelRaise, commitBid, openRaise, revealBid } from './auction.ts';
import { collectCurveProceeds, completeCurve, curveSwap, syncCurveUnits } from './curve.ts';
import { flagFxFallback, quarterRate, snapshotRate } from './fx.ts';
import { burnRetired, claimPayout, payIn, postSplitReceipt } from './payments.ts';
import { claimRedemption, claimTail, quote, redeem } from './redemption.ts';
import { createSeries, registerIssuer, setAllowlist, stopIssuance } from './registry.ts';
import { attestorUsable, registerKey, revokeKey, rotateKey } from './keys.ts';
import { submitReport } from './reports.ts';
import { stakeUnits, tenderUnits, unstakeUnits } from './stake.ts';
import { beginSettlement, deliverBid, finalizeSettlement, processBid, registerHolder, tallyBids } from './settlement.ts';
import { accrualNow, approvePause, crankPause, crankStatus, deadlines, reportablePeriods, requestPause, withdrawPauseRequest, type PeriodDeadlines } from './status.ts';
import { amendTerms, claimFinal, extinguish } from './terminal.ts';
import { drawRelease, pauseReleases } from './treasury.ts';
import { clearTransferWindow, commitWindowOrder, openTransferWindow, revealWindowOrder } from './window.ts';

export type { EngineOptions, ExecContext, ReportProofVerifier } from './core.ts';

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
  /** `ctx` carries what was established outside the engine for this transaction (the Groth16 verdict, ExecContext). */
  execute(cmd: Command, actor: Actor, ctx: ExecContext = {}): TxResult {
    return this.executeAll([cmd], actor, ctx);
  }

  /**
   * One transaction of several commands (`ChainPort.build` with a list; owner direction of 2026-10-10): they run in
   * order against the state each one leaves, under one transaction id, and either all apply, their events in order, or
   * the first refusal is thrown and the state is left untouched (one rollback), as a Solana transaction of several
   * instructions does.
   */
  executeAll(cmds: readonly Command[], actor: Actor, ctx: ExecContext = {}): TxResult {
    if (cmds.length === 0) throw new ChainError('NotPermitted', 'a transaction needs at least one command');
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
      for (const cmd of cmds) this.dispatch(cmd, actor, now, emit, ctx);
      this.state.txCount = txIndex;
      this.events.push(...emitted);
      return { txId, blockTime: now, blockRef: String(txIndex), events: emitted };
    } catch (e) {
      this.state = backup;
      throw e;
    }
  }

  private dispatch(cmd: Command, actor: Actor, now: number, emit: Emit, ctx: ExecContext): void {
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
      // Stage 1's multi-step settlement and holder registration: permissionless (any wallet, or the keeper)
      case 'beginSettlement': service('any'); return beginSettlement(this, cmd, now, emit);
      case 'tallyBids': service('any'); return tallyBids(this, cmd, emit);
      case 'finalizeSettlement': service('any'); return finalizeSettlement(this, cmd, now, emit);
      case 'processBid': service('any'); return processBid(this, cmd, emit);
      case 'deliverBid': service('any'); return deliverBid(this, cmd, emit);
      case 'registerHolder': service('any'); return registerHolder(this, cmd, emit);
      // Stage 1's Retired burn and a curve's completion and proceeds: permissionless (any wallet, or the keeper)
      case 'burnRetired': service('any'); return burnRetired(this, cmd, emit);
      case 'completeCurve': service('any'); return completeCurve(this, cmd, emit);
      case 'collectCurveProceeds': service('any'); return collectCurveProceeds(this, cmd, emit);
      case 'syncCurveUnits': service('any'); return syncCurveUnits(this, cmd, now, emit);
      case 'drawRelease': return drawRelease(this, user(), cmd, now, emit);
      case 'pauseReleases': return pauseReleases(this, user(), cmd, emit);
      case 'submitReport': return submitReport(this, actor.kind === 'user' ? actor.signers : [], cmd, now, emit, ctx);
      case 'payIn': return payIn(this, user(), cmd, now, emit);
      case 'claimPayout': return claimPayout(this, user(), cmd, emit);
      case 'requestPause': return requestPause(this, user(), cmd, now, emit);
      case 'withdrawPauseRequest': return withdrawPauseRequest(this, user(), cmd, emit);
      // Stage 1's approve_pause takes the attestor's PAUSE signature as an argument: anyone sends it (S4 WP10)
      case 'approvePause': service('any'); return approvePause(this, cmd, now, emit);
      case 'crankPause': service('any'); return crankPause(this, cmd, now, emit);
      case 'crankStatus': service('any'); return crankStatus(this, cmd, now, emit);
      case 'redeem': return redeem(this, user(), cmd, now, emit);
      case 'claimRedemption': return claimRedemption(this, user(), cmd, emit);
      case 'claimTail': return claimTail(this, user(), cmd, emit);
      case 'claimFinal': return claimFinal(this, user(), cmd, emit);
      // the issuer sends Stage 1's amend_terms with the attestor's AMEND signature as an argument (S4 WP11)
      case 'amendTerms': return amendTerms(this, actor.kind === 'user' ? (actor.signers[0] ?? null) : null, cmd, now, emit);
      // Stage 1's extinguish takes the two attestors' EXTINGUISH signatures as arguments: anyone sends it (S4 WP12)
      case 'extinguish': service('any'); return extinguish(this, cmd, now, emit);
      case 'snapshotRate': service('keeper'); return snapshotRate(this, cmd, now, emit);
      case 'flagFxFallback': service('keeper'); return flagFxFallback(this, cmd, now, emit);
      case 'openTransferWindow': service('any'); return openTransferWindow(this, cmd, now, emit);
      case 'commitWindowOrder': return commitWindowOrder(this, user(), cmd, now, emit);
      case 'revealWindowOrder': return revealWindowOrder(this, user(), cmd, now, emit);
      case 'clearTransferWindow': service('any'); return clearTransferWindow(this, cmd, now, emit);
      // a trade on the curve's venue (Meteora's DBC on live chains; the stand-in pool here)
      case 'curveSwap': return curveSwap(this, user(), cmd, now, emit);
      // curve staking and tender (Stage 1 curve mode): the holder signs
      case 'stakeUnits': return stakeUnits(this, user(), cmd, emit);
      case 'unstakeUnits': return unstakeUnits(this, user(), cmd, emit);
      case 'tenderUnits': return tenderUnits(this, user(), cmd, emit);
      case 'setAllowlist': service('allowlistManager'); return setAllowlist(this, cmd, emit);
      // Stage 1's key registry (S4 WP5 attestor keys, WP6 verifier keys): each personality's rules and names (keys.ts)
      case 'registerAttestor': admin(); return registerKey(this, 'attestor', cmd.attestor, emit);
      case 'revokeAttestor': admin(); return revokeKey(this, 'attestor', cmd.attestor, now, emit);
      case 'rotateAttestor': admin(); return rotateKey(this, 'attestor', cmd.from, cmd.to, now, emit);
      case 'registerVerifierKey': admin(); return registerKey(this, 'verifier', cmd.key, emit);
      case 'revokeVerifierKey': admin(); return revokeKey(this, 'verifier', cmd.key, now, emit);
      case 'rotateVerifierKey': admin(); return rotateKey(this, 'verifier', cmd.from, cmd.to, now, emit);
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
  /** Stage 1 `requireIssuer` (NotIssuer, code Unauthorized). */
  requireIssuer(s: SimSeries, signer: string): void {
    if (s.issuer !== signer) fail('NotIssuer', 'only the issuer may do this');
  }
  /** Stage 1's allowlist check (NotAllowlisted, code NotAllowlisted). */
  requireAllowlisted(wallet: string): void {
    if (!this.state.allowlist.has(wallet)) fail('NotAllowlisted', `${wallet} is not allowlisted`);
  }
  attestorUsable(a: string, now: number, opts: { reportPeriod?: string } = {}): boolean {
    return attestorUsable(this, a, now, opts);
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
    if (b < amount) fail('InsufficientEscrow', `${wallet} has ${b} < ${amount}`); // Stage 1 debit (SIM:297-303)
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
  /** Stage 1's lateness accrual on `amount` owed for `period` at `now` (`lateAccrual`, unpaused late days). */
  accrualNow(s: SimSeries, period: Period, amount: bigint, now: number): bigint {
    return accrualNow(s, period, amount, now);
  }
  /** The period's deadline instants from Stage 1's countdown (`projectDeadlines`): due, grace end, formal notice. */
  deadlines(s: SimSeries, period: Period, now: number): PeriodDeadlines {
    return deadlines(s, period, now);
  }
  /** For display: an Open raise split by time into its commit, reveal and settle-due phases (see `auctionPhase`). */
  auctionPhase(s: SimSeries, now: number): ReturnType<typeof auctionPhase> {
    return auctionPhase(s, now);
  }
  /** Stage 1's redemption quote at `now` (`redemptionQuote` over the vault's year ring and the live cap). */
  quote(s: SimSeries, now: number): ReturnType<typeof quote> {
    return quote(s, now);
  }
  quarterRate(pair: string, periodId: string): ReturnType<typeof quarterRate> {
    return quarterRate(this, pair, periodId);
  }
}

export { parseSeriesId };
