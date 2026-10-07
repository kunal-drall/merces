/**
 * In-memory model of the whole protocol (SPEC §3–§7) driven by the vector steps of SPEC §11.
 * Chain-neutral: wallets are actor names, signatures are modelled as "signed by a registered key"
 * (each chain's harness builds and verifies the real §1.4 messages), Groth16 proofs are verified
 * for real with the dev verification key.
 */
import {
  BPS_DENOMINATOR,
  DAY,
  DEFAULT_PARAMETERS,
  PARAMETER_BOUNDS,
  RaiseState,
  SeriesStatus,
  Tier,
  WAD,
  YEAR,
  ZERO_INCOME_COMMITMENT,
  bytes32ToField,
  bytesToHex,
  fieldToBytes32,
  hexToBytes,
  periodEnd,
  periodOf,
  tierEnabled,
  yearOf,
  type ErrorName,
  type Parameters,
} from "@merces/sdk";
import { verifyReport, type Groth16Proof } from "@merces/circuits";
import * as M from "../math/index.js";
import type { ActionStep, AuctionExpect, Call, ExpectRevertStep, ExpectStep, FxExpect, LedgerExpect, Step } from "./types.js";

export class SimError extends Error {
  constructor(
    public readonly code: ErrorName,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SimError";
  }
}

function fail(code: ErrorName, detail?: string): never {
  throw new SimError(code, detail);
}

const D = (v: bigint | number): string => v.toString();
const B = (s: string | number | bigint): bigint => BigInt(s);
const H = (b: Uint8Array): string => bytesToHex(b);

export interface Account {
  stable: bigint;
  units: Map<string, bigint>;
}

interface Bid {
  bidder: string;
  price: bigint;
  quantity: bigint;
  salt: string;
  escrow: bigint;
  revealed: boolean;
  valid: boolean;
  revealIndex: number;
  processed: boolean;
}

interface Holder {
  registered: boolean;
  lastNetAccWad: bigint;
  pending: bigint;
  redeemedUnits: bigint;
  lastTailAccWad: bigint;
  lastFinalAccWad: bigint;
  finalClaimed: boolean;
}

interface Report {
  period: number;
  acceptedAt: bigint;
  paymentUsd: bigint;
  fxAvgWad: bigint;
  fxFallback: boolean;
  tier: number;
  liquidityEvent: boolean;
  incomeCommitment: bigint;
  accrualPaid: bigint;
  paidAt: bigint | null;
  tail: boolean;
}

interface Order extends M.WindowOrder {
  salt: string;
  processed: boolean;
}

interface WindowState {
  period: number;
  state: "Commit" | "Reveal" | "Settled" | "NoMatch" | "Done";
  opensAt: bigint;
  commitEnd: bigint;
  revealEnd: bigint;
  orders: Order[];
  revealed: number;
  escrowUnits: bigint;
  escrowStable: bigint;
  clearing: M.WindowClearing | null;
}

export interface Terms {
  unitsOffered: bigint;
  reservePrice: bigint;
  minRaise: bigint;
  capMultipleWad: bigint;
  hurdleRateWad: bigint;
  payoutMultipleK: number;
  lockupSeconds: bigint;
  walletCapBps: number;
  auctionFeeBps: number;
  payoutFeeBps: number;
  windowFeeBps: number;
  nonRevealChargeBps: number;
  commitDuration: bigint;
  revealDuration: bigint;
  windowCommitDuration: bigint;
  windowRevealDuration: bigint;
}

interface Ledger {
  status: SeriesStatus;
  firstPeriod: number;
  lastAcceptedPeriod: number | null;
  lastPaidPeriod: number | null;
  openDuePeriod: number | null;
  openDueAmount: bigint;
  openDueTier: number;
  openDueIsTail: boolean;
  routerCredit: bigint;
  trueupDue: bigint;
  trueupDeadline: bigint;
  pauseNonce: bigint;
  pauseRequested: boolean;
  pauseStart: bigint;
  pauseEnd: bigint;
  pausedTotal: bigint;
  formalNoticeEmittedFor: number | null;
  lastIncomeCommitment: bigint;
  lastIncomePeriod: number | null;
  redemptionTs: bigint;
  redemptionPrice: bigint;
  unitsAtRedemption: bigint;
  tail: M.TailState;
  final: M.FinalState;
  extinguishNonce: bigint;
}

export interface SeriesState {
  id: string;
  issuer: string;
  terms: Terms;
  releaseSchedule: M.ReleaseTranche[];
  contractHash: string | null;
  tierFlags: number;
  fxPairId: string | null;
  termsCommitment: bigint;
  capMultipleWad: bigint;
  amendmentNonce: bigint;
  raiseState: RaiseState;
  openedAt: bigint;
  commitEnd: bigint;
  revealEnd: bigint;
  bids: Map<string, Bid>;
  revealedCount: number;
  escrowTotal: bigint;
  clearingPrice: bigint;
  R: bigint;
  qAt: bigint;
  qAbove: bigint;
  unitsSoldUpper: bigint;
  unitsMinted: bigint;
  bidsProcessed: number;
  settlementTs: bigint;
  mintFinalized: boolean;
  supply: bigint;
  treasury: { balance: bigint; proceeds: bigint; releasedTotal: bigint; issuerPaused: boolean };
  vault: M.VaultState;
  vaultBalance: bigint;
  ledger: Ledger;
  holders: Map<string, Holder>;
  router: M.RouterState | null;
  routerBalance: bigint;
  reports: Map<number, Report>;
  window: WindowState | null;
  events: string[];
}

interface FxPair {
  pairId: string;
  inverted: boolean;
  crosscheck: boolean;
  state: M.FxPairState;
}

export interface SimulatorOptions {
  parameters?: Parameters;
  flags?: { newRaisesPaused?: boolean; windowsEnabled?: boolean; tier4Enabled?: boolean };
  /** verify embedded Groth16 proofs (default true) */
  verifyProofs?: boolean;
}

export class Simulator {
  now = 0n;
  readonly params: Parameters;
  flags = { newRaisesPaused: false, windowsEnabled: false, tier4Enabled: false };
  readonly verifyProofs: boolean;
  readonly allowlist = new Set<string>();
  readonly issuers = new Map<string, { active: boolean; issuanceStopped: boolean }>();
  readonly attestors = new Map<string, boolean>();
  readonly verifierKeys = new Map<string, boolean>();
  feeCollector = 0n;
  readonly accounts = new Map<string, Account>();
  readonly series = new Map<string, SeriesState>();
  readonly fxPairs = new Map<string, FxPair>();
  readonly events: string[] = [];

  constructor(opts: SimulatorOptions = {}) {
    this.params = opts.parameters ?? DEFAULT_PARAMETERS;
    this.flags = { ...this.flags, ...(opts.flags ?? {}) };
    this.verifyProofs = opts.verifyProofs ?? true;
  }

  // ------------------------------------------------------------------------------------------
  // accounts and helpers
  // ------------------------------------------------------------------------------------------

  account(name: string): Account {
    let a = this.accounts.get(name);
    if (!a) {
      a = { stable: 0n, units: new Map() };
      this.accounts.set(name, a);
    }
    return a;
  }

  unitsOf(actor: string, seriesId: string): bigint {
    return this.account(actor).units.get(seriesId) ?? 0n;
  }

  private addUnits(actor: string, seriesId: string, delta: bigint): void {
    const a = this.account(actor);
    const v = (a.units.get(seriesId) ?? 0n) + delta;
    if (v < 0n) throw new Error(`negative units for ${actor}`);
    a.units.set(seriesId, v);
  }

  private debit(actor: string, amount: bigint, what: string): void {
    const a = this.account(actor);
    if (amount < 0n) throw new Error("negative debit");
    if (a.stable < amount) fail("InsufficientEscrow", `${actor} has ${a.stable} < ${amount} for ${what}`);
    a.stable -= amount;
  }

  private credit(actor: string, amount: bigint): void {
    if (amount < 0n) throw new Error("negative credit");
    this.account(actor).stable += amount;
  }

  private getSeries(id: string): SeriesState {
    const s = this.series.get(id);
    if (!s) throw new Error(`unknown series ${id}`);
    return s;
  }

  private emit(s: SeriesState | null, event: string): void {
    const line = `[t=${this.now}] ${s ? s.id + " " : ""}${event}`;
    this.events.push(line);
    s?.events.push(line);
  }

  private requireIssuer(s: SeriesState, actor: string): void {
    if (s.issuer !== actor) fail("NotIssuer", `${actor} is not the issuer of ${s.id}`);
  }

  private requireActiveAttestor(key: string): void {
    if (this.attestors.get(key) !== true) fail("InvalidAttestorSignature", `${key} is not an active attestor`);
  }

  private clock(s: SeriesState): M.LedgerClock {
    const l = s.ledger;
    return {
      status: l.status,
      firstPeriod: l.firstPeriod,
      lastAcceptedPeriod: l.lastAcceptedPeriod,
      openDuePeriod: l.openDuePeriod,
      openDueAmount: l.openDueAmount,
      pauseStart: l.pauseStart,
      pauseEnd: l.pauseEnd,
      pausedTotal: l.pausedTotal,
    };
  }

  private statusParams(s: SeriesState): M.StatusParams {
    return { reportDueDays: this.params.reportDueDays, graceDays: this.params.graceDays, formalNoticeDays: this.params.formalNoticeDays, hurdleRateWad: s.terms.hurdleRateWad };
  }

  derivedStatus(s: SeriesState): SeriesStatus {
    if (s.raiseState !== RaiseState.Settled) return s.ledger.status;
    return M.deriveStatus(this.clock(s), this.now, this.statusParams(s));
  }

  /** `sync_status(now)`: closes expired pauses, stores the derived status, records formal notices. */
  syncStatus(s: SeriesState): void {
    if (s.raiseState !== RaiseState.Settled) return;
    const l = s.ledger;
    Object.assign(l, M.closeExpiredPause(this.clock(s), this.now));
    const next = this.derivedStatus(s);
    if (next !== l.status) {
      this.emit(s, `StatusChanged ${SeriesStatus[l.status]} -> ${SeriesStatus[next]}`);
      l.status = next;
    }
    if (!M.isTerminal(l.status)) {
      const p = M.earliestUnpaid(this.clock(s));
      if (M.formalNoticeDue(p, this.clock(s), this.now, this.statusParams(s)) && l.formalNoticeEmittedFor !== p) {
        l.formalNoticeEmittedFor = p;
        this.emit(s, `FormalNoticeDue period=${p}`);
      }
    }
  }

  private settlementYear(s: SeriesState): number {
    return Number((this.now - s.settlementTs) / YEAR);
  }

  private holder(s: SeriesState, actor: string): Holder {
    let h = s.holders.get(actor);
    if (!h) {
      h = { registered: false, lastNetAccWad: 0n, pending: 0n, redeemedUnits: 0n, lastTailAccWad: 0n, lastFinalAccWad: 0n, finalClaimed: false };
      s.holders.set(actor, h);
    }
    return h;
  }

  private registerHolder(s: SeriesState, actor: string): void {
    const h = this.holder(s, actor);
    if (h.registered) return;
    h.registered = true;
    h.lastNetAccWad = s.vault.netAccWad;
    h.lastTailAccWad = s.ledger.tail.tailAccWad;
    h.lastFinalAccWad = s.ledger.final.finalAccWad;
    this.emit(s, `HolderRegistered ${actor}`);
  }

  /** `settle_holder`: accrue pending against the net accumulator before any balance change. */
  private settleHolder(s: SeriesState, actor: string): Holder {
    const h = s.holders.get(actor);
    if (!h || !h.registered) fail("HolderNotRegistered", actor);
    const bal = this.unitsOf(actor, s.id);
    h.pending += M.settleHolderDelta(s.vault.netAccWad, h.lastNetAccWad, bal);
    h.lastNetAccWad = s.vault.netAccWad;
    return h;
  }

  private burn(s: SeriesState, actor: string, units: bigint, reason: string): void {
    if (units === 0n) return;
    this.addUnits(actor, s.id, -units);
    s.supply -= units;
    this.emit(s, `UnitsBurned ${actor} ${units} ${reason}`);
  }

  /** Vault receive for Payment/Router sources; moves fee and refund, retires on cap. */
  private vaultReceive(s: SeriesState, gross: bigint, source: "Payment" | "Router", refundTo: string): M.ReceiveResult {
    if (s.supply === 0n) fail("NoUnitsOutstanding");
    const { state, result } = M.vaultReceiveGross(s.vault, gross, s.supply, s.terms.payoutFeeBps, this.settlementYear(s));
    s.vault = state;
    s.vaultBalance += result.accepted - result.fee;
    this.feeCollector += result.fee;
    if (result.refund > 0n) this.credit(refundTo, result.refund);
    this.emit(s, `PayoutDistributed source=${source} gross=${gross} accepted=${result.accepted} fee=${result.fee} deltaAcc=${result.deltaAccWad} retired=${result.retired}`);
    if (result.retired && s.ledger.status !== SeriesStatus.Retired) {
      s.ledger.status = SeriesStatus.Retired;
      this.emit(s, `SeriesRetired paidPerUnitWad=${s.vault.paidPerUnitWad} refund=${result.refund}`);
    }
    return result;
  }

  // ------------------------------------------------------------------------------------------
  // step execution
  // ------------------------------------------------------------------------------------------

  async apply(step: Step): Promise<void> {
    const t = B(step.t);
    if (t < this.now) throw new Error(`time cursor went backwards: ${t} < ${this.now} at op ${step.op}`);
    this.now = t;
    if (step.op === "expect") return this.checkExpect(step);
    if (step.op === "expect_revert") return this.checkRevert(step);
    await this.call(step);
  }

  async run(steps: Step[]): Promise<void> {
    for (const s of steps) await this.apply(s);
  }

  private async checkRevert(step: ExpectRevertStep): Promise<void> {
    const before = this.serialize();
    try {
      await this.call({ ...step.call, t: step.t });
    } catch (e) {
      if (e instanceof SimError) {
        if (e.code !== step.error) throw new Error(`expected revert ${step.error} but got ${e.code} (${e.message})`);
        if (this.serialize() !== before) throw new Error(`state changed during a reverted call ${step.call.op}`);
        return;
      }
      throw e;
    }
    throw new Error(`expected revert ${step.error} for ${step.call.op} but the call succeeded`);
  }

  private checkExpect(step: ExpectStep): void {
    const actual = this.expect(step.series ?? null);
    const expected = JSON.stringify({ ...step, t: undefined, note: undefined });
    const got = JSON.stringify({ ...actual, t: undefined, note: undefined, op: "expect", series: step.series });
    const ex = JSON.parse(expected) as Record<string, unknown>;
    const ac = JSON.parse(got) as Record<string, unknown>;
    for (const [k, v] of Object.entries(ex)) {
      if (k === "op" || k === "series") continue;
      if (JSON.stringify(v) !== JSON.stringify(ac[k])) {
        throw new Error(`expect mismatch at ${k}: expected ${JSON.stringify(v)} got ${JSON.stringify(ac[k])}`);
      }
    }
  }

  async call(c: Call & { t?: string }): Promise<void> {
    switch (c.op) {
      case "fund":
        this.credit(c.actor, B(c.amount));
        return;
      case "allowlist":
        for (const w of c.wallets) {
          if (c.allowed === false) this.allowlist.delete(w);
          else this.allowlist.add(w);
          this.emit(null, `AllowlistUpdated ${w} ${c.allowed !== false}`);
        }
        return;
      case "register_issuer":
        this.issuers.set(c.wallet, { active: true, issuanceStopped: false });
        return;
      case "deactivate_issuer": {
        const i = this.issuers.get(c.wallet);
        if (i) i.active = false;
        return;
      }
      case "register_attestor":
        this.attestors.set(c.key, true);
        return;
      case "revoke_attestor":
        this.attestors.set(c.key, false);
        return;
      case "register_verifier_key":
        this.verifierKeys.set(c.key, true);
        return;
      case "revoke_verifier_key":
        this.verifierKeys.set(c.key, false);
        return;
      case "set_flags":
        if (c.newRaisesPaused !== undefined) this.flags.newRaisesPaused = c.newRaisesPaused;
        if (c.windowsEnabled !== undefined) this.flags.windowsEnabled = c.windowsEnabled;
        if (c.tier4Enabled !== undefined) this.flags.tier4Enabled = c.tier4Enabled;
        return;
      case "set_fx_pair":
        this.fxPairs.set(c.pairId.toLowerCase(), { pairId: c.pairId.toLowerCase(), inverted: c.inverted, crosscheck: c.crosscheck, state: M.newFxPairState() });
        return;
      case "create_series":
        return this.createSeries(c);
      case "set_contract_hash": {
        const s = this.getSeries(c.series);
        this.requireIssuer(s, c.actor);
        if (s.raiseState !== RaiseState.Draft) fail("SeriesNotDraft");
        if (/^0x0*$/.test(c.contractHash)) fail("ContractHashMissing", "zero hash");
        s.contractHash = c.contractHash;
        return;
      }
      case "stop_issuance":
      case "resume_issuance": {
        const i = this.issuers.get(c.actor);
        if (!i) fail("IssuerInactive");
        i.issuanceStopped = c.op === "stop_issuance";
        return;
      }
      case "open_raise":
        return this.openRaise(c);
      case "cancel_raise": {
        const s = this.getSeries(c.series);
        this.requireIssuer(s, c.actor);
        if (s.raiseState !== RaiseState.Open) fail("RaiseNotOpen");
        if (s.bids.size > 0) fail("BidsExist");
        s.raiseState = RaiseState.Cancelled;
        this.emit(s, "RaiseCancelled");
        return;
      }
      case "commit_bid":
        return this.commitBid(c);
      case "reveal_bid":
        return this.revealBid(c);
      case "settle":
        return this.settle(c);
      case "process_bid":
        return this.processBid(c);
      case "claim_release":
        return this.claimRelease(c);
      case "set_release_pause": {
        const s = this.getSeries(c.series);
        this.requireIssuer(s, c.actor);
        s.treasury.issuerPaused = c.paused;
        this.emit(s, `ReleasePauseSet ${c.paused}`);
        return;
      }
      case "submit_report":
        return this.submitReport(c);
      case "pay":
        return this.pay(c);
      case "submit_trueup":
        return this.submitTrueup(c);
      case "pay_trueup":
        return this.payTrueup(c);
      case "claim":
        return this.claim(c);
      case "register_holder": {
        const s = this.getSeries(c.series);
        if (!this.allowlist.has(c.holder)) fail("NotAllowlisted", c.holder);
        this.registerHolder(s, c.holder);
        return;
      }
      case "burn_retired": {
        const s = this.getSeries(c.series);
        if (s.ledger.status !== SeriesStatus.Retired) fail("SeriesTerminal", "series is not Retired");
        this.settleHolder(s, c.holder);
        this.burn(s, c.holder, this.unitsOf(c.holder, s.id), "Retired");
        return;
      }
      case "crank_status": {
        const s = this.getSeries(c.series);
        this.syncStatus(s);
        return;
      }
      case "request_pause": {
        const s = this.getSeries(c.series);
        this.requireIssuer(s, c.actor);
        if (M.isTerminal(s.ledger.status)) fail("SeriesTerminal");
        s.ledger.pauseRequested = true;
        this.emit(s, "PauseRequested");
        return;
      }
      case "approve_pause":
        return this.approvePause(c);
      case "end_pause": {
        const s = this.getSeries(c.series);
        this.requireIssuer(s, c.actor);
        const l = s.ledger;
        if (!M.isPaused(this.clock(s), this.now)) fail("NotPaused");
        l.pausedTotal += this.now - l.pauseStart;
        l.pauseStart = 0n;
        l.pauseEnd = 0n;
        this.emit(s, `PauseEnded pausedTotal=${l.pausedTotal}`);
        this.syncStatus(s);
        return;
      }
      case "route_income":
        return this.routeIncome(c);
      case "fx_snapshot":
        return this.fxSnapshot(c);
      case "redeem":
        return this.redeem(c);
      case "claim_redemption":
        return this.claimRedemption(c);
      case "claim_tail":
        return this.claimTail(c);
      case "extinguish":
        return this.extinguish(c);
      case "claim_final":
        return this.claimFinal(c);
      case "amend_terms":
        return this.amendTerms(c);
      case "open_window":
        return this.openWindow(c);
      case "commit_ask":
      case "window_commit_bid":
        return this.commitOrder(c);
      case "reveal_order":
        return this.revealOrder(c);
      case "settle_window":
        return this.settleWindow(c);
      case "process_orders":
        return this.processOrders(c);
      case "transfer_units": {
        const s = this.getSeries(c.series);
        void s;
        fail("DirectTransferForbidden", `${c.actor} -> ${c.to}`);
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // registry
  // ------------------------------------------------------------------------------------------

  private createSeries(c: Extract<Call, { op: "create_series" }>): void {
    const issuer = this.issuers.get(c.actor);
    if (!issuer || !issuer.active) fail("IssuerInactive", c.actor);
    if (issuer.issuanceStopped) fail("IssuanceStopped", c.actor);
    if (!this.allowlist.has(c.actor)) fail("NotAllowlisted", c.actor);
    if (this.series.has(c.series)) throw new Error(`series ${c.series} exists`);
    const t: Terms = {
      unitsOffered: B(c.terms.unitsOffered),
      reservePrice: B(c.terms.reservePrice),
      minRaise: B(c.terms.minRaise),
      capMultipleWad: B(c.terms.capMultipleWad),
      hurdleRateWad: B(c.terms.hurdleRateWad),
      payoutMultipleK: Number(c.terms.payoutMultipleK),
      lockupSeconds: B(c.terms.lockupSeconds),
      walletCapBps: Number(c.terms.walletCapBps),
      auctionFeeBps: Number(c.terms.auctionFeeBps),
      payoutFeeBps: Number(c.terms.payoutFeeBps),
      windowFeeBps: Number(c.terms.windowFeeBps),
      nonRevealChargeBps: Number(c.terms.nonRevealChargeBps),
      commitDuration: B(c.terms.commitDuration),
      revealDuration: B(c.terms.revealDuration),
      windowCommitDuration: B(c.terms.windowCommitDuration),
      windowRevealDuration: B(c.terms.windowRevealDuration),
    };
    const bounded: [keyof Parameters, bigint][] = [
      ["capMultipleWad", t.capMultipleWad],
      ["hurdleRateWad", t.hurdleRateWad],
      ["payoutMultipleK", BigInt(t.payoutMultipleK)],
      ["lockupSeconds", t.lockupSeconds],
      ["walletCapBps", BigInt(t.walletCapBps)],
      ["auctionFeeBps", BigInt(t.auctionFeeBps)],
      ["payoutFeeBps", BigInt(t.payoutFeeBps)],
      ["windowFeeBps", BigInt(t.windowFeeBps)],
      ["nonRevealChargeBps", BigInt(t.nonRevealChargeBps)],
      ["commitDuration", t.commitDuration],
      ["revealDuration", t.revealDuration],
      ["windowCommitDuration", t.windowCommitDuration],
      ["windowRevealDuration", t.windowRevealDuration],
    ];
    for (const [name, v] of bounded) {
      const b = PARAMETER_BOUNDS[name];
      if (v < b.min || v > b.max) fail("ParameterOutOfBounds", `${name}=${v}`);
    }
    if (t.unitsOffered < 1n || t.reservePrice < 1n || t.minRaise > t.reservePrice * t.unitsOffered) fail("InvalidTerms");
    const schedule: M.ReleaseTranche[] = c.releaseSchedule.map((r) => ({ atOffsetSeconds: B(r.atOffsetSeconds), bps: Number(r.bps) }));
    if (M.validateReleaseSchedule(schedule).length > 0) fail("InvalidReleaseSchedule", M.validateReleaseSchedule(schedule).join(","));
    if (c.router && !tierEnabled(c.tierFlags, Tier.Tier1Split)) fail("RouterNotEnabled", "router given without tier-1 flag");
    if (!c.router && tierEnabled(c.tierFlags, Tier.Tier1Split)) fail("RouterNotEnabled", "tier-1 flag requires router terms");
    if (c.fxPairId && !this.fxPairs.has(c.fxPairId.toLowerCase())) throw new Error(`unknown fx pair ${c.fxPairId}`);
    const s: SeriesState = {
      id: c.series,
      issuer: c.actor,
      terms: t,
      releaseSchedule: schedule,
      contractHash: c.contractHash && !/^0x0*$/.test(c.contractHash) ? c.contractHash : null,
      tierFlags: c.tierFlags,
      fxPairId: c.fxPairId ? c.fxPairId.toLowerCase() : null,
      termsCommitment: bytes32ToField(hexToBytes(c.termsCommitment)),
      capMultipleWad: t.capMultipleWad,
      amendmentNonce: 0n,
      raiseState: RaiseState.Draft,
      openedAt: 0n,
      commitEnd: 0n,
      revealEnd: 0n,
      bids: new Map(),
      revealedCount: 0,
      escrowTotal: 0n,
      clearingPrice: 0n,
      R: 0n,
      qAt: 0n,
      qAbove: 0n,
      unitsSoldUpper: 0n,
      unitsMinted: 0n,
      bidsProcessed: 0,
      settlementTs: 0n,
      mintFinalized: false,
      supply: 0n,
      treasury: { balance: 0n, proceeds: 0n, releasedTotal: 0n, issuerPaused: false },
      vault: M.newVaultState(0n),
      vaultBalance: 0n,
      ledger: {
        status: SeriesStatus.OnTime,
        firstPeriod: 0,
        lastAcceptedPeriod: null,
        lastPaidPeriod: null,
        openDuePeriod: null,
        openDueAmount: 0n,
        openDueTier: 0,
        openDueIsTail: false,
        routerCredit: 0n,
        trueupDue: 0n,
        trueupDeadline: 0n,
        pauseNonce: 0n,
        pauseRequested: false,
        pauseStart: 0n,
        pauseEnd: 0n,
        pausedTotal: 0n,
        formalNoticeEmittedFor: null,
        lastIncomeCommitment: ZERO_INCOME_COMMITMENT,
        lastIncomePeriod: null,
        redemptionTs: 0n,
        redemptionPrice: 0n,
        unitsAtRedemption: 0n,
        tail: M.newTailState(0n),
        final: { finalAccWad: 0n, finalCarryWad: 0n, unreleasedDistributed: 0n },
        extinguishNonce: 0n,
      },
      holders: new Map(),
      router: c.router ? { theta: B(c.router.theta), rWad: B(c.router.rWad), ytdYear: 0, ytdReceived: 0n } : null,
      routerBalance: 0n,
      reports: new Map(),
      window: null,
      events: [],
    };
    this.series.set(s.id, s);
    this.emit(s, `SeriesCreated issuer=${c.actor}`);
  }

  private amendTerms(c: Extract<Call, { op: "amend_terms" }>): void {
    const s = this.getSeries(c.series);
    this.requireIssuer(s, c.actor);
    if (M.isTerminal(s.ledger.status)) fail("SeriesTerminal");
    this.requireActiveAttestor(c.attestor);
    const newCap = B(c.newCapMultipleWad);
    const b = PARAMETER_BOUNDS.capMultipleWad;
    if (newCap > s.capMultipleWad || newCap < b.min || newCap > b.max) fail("UnfavourableAmendment", `cap ${newCap} > ${s.capMultipleWad}`);
    s.termsCommitment = bytes32ToField(hexToBytes(c.newTermsCommitment));
    s.capMultipleWad = newCap;
    s.amendmentNonce += 1n;
    if (s.raiseState === RaiseState.Settled) s.vault = { ...s.vault, capPerUnit: M.capPerUnit(newCap, s.clearingPrice) };
    this.emit(s, `TermsAmended nonce=${s.amendmentNonce} cap=${newCap} attestor=${c.attestor}`);
  }

  // ------------------------------------------------------------------------------------------
  // raise path
  // ------------------------------------------------------------------------------------------

  private openRaise(c: Extract<Call, { op: "open_raise" }>): void {
    const s = this.getSeries(c.series);
    this.requireIssuer(s, c.actor);
    if (s.raiseState !== RaiseState.Draft) fail("RaiseNotDraft");
    if (!s.contractHash) fail("ContractHashMissing");
    if (!this.allowlist.has(s.issuer)) fail("NotAllowlisted", s.issuer);
    if (this.flags.newRaisesPaused) fail("NewRaisesPaused");
    s.raiseState = RaiseState.Open;
    s.openedAt = this.now;
    s.commitEnd = this.now + s.terms.commitDuration;
    s.revealEnd = s.commitEnd + s.terms.revealDuration;
    this.emit(s, `RaiseOpened commitEnd=${s.commitEnd} revealEnd=${s.revealEnd}`);
  }

  private commitBid(c: Extract<Call, { op: "commit_bid" }>): void {
    const s = this.getSeries(c.series);
    if (s.raiseState !== RaiseState.Open) fail("RaiseNotOpen");
    if (!this.allowlist.has(c.actor)) fail("NotAllowlisted", c.actor);
    if (this.now >= s.commitEnd) fail("CommitPhaseClosed");
    if (s.bids.has(c.actor)) fail("BidExists", c.actor);
    const escrow = B(c.escrow);
    if (escrow <= 0n) fail("ZeroEscrow");
    this.debit(c.actor, escrow, "bid escrow");
    s.escrowTotal += escrow;
    s.bids.set(c.actor, { bidder: c.actor, price: B(c.price), quantity: B(c.quantity), salt: c.salt.toLowerCase(), escrow, revealed: false, valid: false, revealIndex: -1, processed: false });
    this.emit(s, `BidCommitted ${c.actor} escrow=${escrow}`);
  }

  private revealBid(c: Extract<Call, { op: "reveal_bid" }>): void {
    const s = this.getSeries(c.series);
    if (s.raiseState !== RaiseState.Open) fail("RaiseNotOpen");
    if (this.now < s.commitEnd) fail("RevealNotStarted");
    if (this.now >= s.revealEnd) fail("RevealPhaseClosed");
    const b = s.bids.get(c.actor);
    if (!b) fail("BidNotFound", c.actor);
    if (b.revealed) fail("AlreadyRevealed", c.actor);
    if (b.price !== B(c.price) || b.quantity !== B(c.quantity) || b.salt !== c.salt.toLowerCase()) fail("CommitmentMismatch", c.actor);
    b.revealed = true;
    b.revealIndex = s.revealedCount++;
    b.valid = M.isBidValid(b.price, b.quantity, b.escrow, this.auctionRules(s));
    this.emit(s, `BidRevealed ${c.actor} price=${b.price} qty=${b.quantity} valid=${b.valid}`);
  }

  private auctionRules(s: SeriesState): M.AuctionRules {
    return {
      unitsOffered: s.terms.unitsOffered,
      reservePrice: s.terms.reservePrice,
      minRaise: s.terms.minRaise,
      walletCapBps: s.terms.walletCapBps,
      auctionFeeBps: s.terms.auctionFeeBps,
      nonRevealChargeBps: s.terms.nonRevealChargeBps,
    };
  }

  private settle(c: Extract<Call, { op: "settle" }>): void {
    const s = this.getSeries(c.series);
    if (s.raiseState !== RaiseState.Open && s.raiseState !== RaiseState.Settling) fail("RaiseNotOpen", `state ${RaiseState[s.raiseState]}`);
    if (this.now < s.revealEnd) fail("SettlementNotReady");
    const p = B(c.clearingPrice);
    const revealed = [...s.bids.values()].filter((b) => b.revealed);
    const tally = M.tallyBids(revealed, p);
    let outcome: M.SettlementOutcome;
    try {
      outcome = M.finalizeSettlement(tally, this.auctionRules(s), p);
    } catch (e) {
      if ((e as Error).message === "InvalidClearingPrice") fail("InvalidClearingPrice", `p=${p}`);
      throw e;
    }
    this.emit(s, `SettlementProposed p=${p}`);
    s.clearingPrice = p;
    s.R = outcome.R;
    s.qAt = outcome.qAt;
    s.qAbove = outcome.qAbove;
    s.unitsSoldUpper = outcome.unitsSoldUpper;
    s.settlementTs = this.now;
    if (outcome.failed) {
      s.raiseState = RaiseState.Failed;
      this.emit(s, `RaiseFailed p=${p} proceedsUpper=${outcome.proceedsUpper} minRaise=${s.terms.minRaise}`);
      if (s.bids.size === 0) this.finalizeMint(s);
      return;
    }
    s.raiseState = RaiseState.Settled;
    s.vault = M.newVaultState(M.capPerUnit(s.capMultipleWad, p));
    s.ledger.firstPeriod = periodOf(this.now);
    s.ledger.status = SeriesStatus.OnTime;
    if (s.router) s.router = { ...s.router, ytdYear: yearOf(periodOf(this.now)) };
    this.emit(s, `RaiseSettled p=${p} unitsSoldUpper=${outcome.unitsSoldUpper} proceedsUpper=${outcome.proceedsUpper}`);
  }

  private finalizeMint(s: SeriesState): void {
    s.mintFinalized = true;
    this.emit(s, `RaiseMintFinalized unitsSold=${s.unitsMinted} proceeds=${s.treasury.proceeds}`);
  }

  private processBid(c: Extract<Call, { op: "process_bid" }>): void {
    const s = this.getSeries(c.series);
    if (s.raiseState !== RaiseState.Settled && s.raiseState !== RaiseState.Failed) fail("RaiseNotSettled");
    const b = s.bids.get(c.bidder);
    if (!b) fail("BidNotFound", c.bidder);
    if (b.processed) fail("AlreadyProcessed", c.bidder);
    const o = M.processBid(b, { failed: s.raiseState === RaiseState.Failed, clearingPrice: s.clearingPrice, R: s.R, qAt: s.qAt }, this.auctionRules(s));
    b.processed = true;
    s.escrowTotal -= b.escrow;
    s.treasury.balance += o.cost;
    s.treasury.proceeds += o.cost;
    this.feeCollector += o.fee + o.charge;
    this.credit(b.bidder, o.refund);
    if (o.alloc > 0n) {
      this.registerHolder(s, b.bidder);
      this.addUnits(b.bidder, s.id, o.alloc);
      s.supply += o.alloc;
      s.unitsMinted += o.alloc;
      this.emit(s, `UnitsAllocated ${b.bidder} units=${o.alloc} cost=${o.cost} fee=${o.fee} refund=${o.refund}`);
    } else {
      this.emit(s, `BidRefunded ${b.bidder} refund=${o.refund} charge=${o.charge}`);
    }
    s.bidsProcessed++;
    if (s.bidsProcessed === s.bids.size) this.finalizeMint(s);
  }

  private claimRelease(c: Extract<Call, { op: "claim_release" }>): void {
    const s = this.getSeries(c.series);
    this.requireIssuer(s, c.actor);
    if (s.raiseState !== RaiseState.Settled) fail("RaiseNotSettled");
    if (!s.mintFinalized) fail("MintNotFinalized");
    if (s.treasury.issuerPaused) fail("ReleasesPaused");
    const status = this.derivedStatus(s);
    if (status === SeriesStatus.Extinguished) fail("SeriesTerminal", "Extinguished");
    if (status === SeriesStatus.Late) fail("SeriesLate");
    const amount = M.releasable(this.now, s.settlementTs, s.releaseSchedule, s.treasury.proceeds, s.treasury.releasedTotal);
    if (amount === 0n) fail("NothingToRelease");
    s.treasury.balance -= amount;
    s.treasury.releasedTotal += amount;
    this.credit(s.issuer, amount);
    this.emit(s, `ReleaseClaimed amount=${amount} releasedTotal=${s.treasury.releasedTotal}`);
    this.syncStatus(s);
  }

  // ------------------------------------------------------------------------------------------
  // repayment path
  // ------------------------------------------------------------------------------------------

  private nextExpectedPeriod(s: SeriesState): number {
    return M.nextExpectedPeriod(this.clock(s));
  }

  private async submitReport(c: Extract<Call, { op: "submit_report" }>): Promise<void> {
    const s = this.getSeries(c.series);
    this.requireIssuer(s, c.actor);
    if (s.raiseState !== RaiseState.Settled) fail("RaiseNotSettled");
    const l = s.ledger;
    const period = Number(c.period);
    const paymentUsd = B(c.paymentUsd);
    const fxAvgWad = B(c.fxAvgWad);
    const incomeCommitment = bytes32ToField(hexToBytes(c.incomeCommitment));

    // 2. status gates
    this.syncStatus(s);
    if (l.status === SeriesStatus.Extinguished) fail("SeriesTerminal", "Extinguished");
    if (l.status === SeriesStatus.Retired) fail("SeriesRetired");
    const isTail = l.status === SeriesStatus.Redeemed;
    if (isTail) {
      if (!c.liquidityEvent) fail("NotLiquidityEvent");
      if (this.now > l.redemptionTs + this.params.tailSeconds) fail("TailExpired");
      if (l.tail.tailCapPerUnit === 0n) fail("NoTailDue");
    }
    if (period !== this.nextExpectedPeriod(s)) fail("WrongPeriod", `expected ${this.nextExpectedPeriod(s)} got ${period}`);
    if (this.now < periodEnd(period)) fail("ReportTooEarly");
    if (l.openDueAmount > 0n) fail("PaymentOutstanding");
    // 3. tier
    if (c.tier < 1 || c.tier > 4 || !tierEnabled(s.tierFlags, c.tier as Tier)) fail("TierNotEnabled", `tier ${c.tier}`);
    if (c.tier === Tier.Tier4Self && !this.flags.tier4Enabled) fail("TierNotEnabled", "tier4 flag off");
    // 4. fx
    let fxFallback = false;
    if (s.fxPairId === null) {
      if (fxAvgWad !== WAD) fail("FxMismatch", "stablecoin income requires fx = WAD");
      if (c.fxFallback) fail("FxFallbackNotAllowed");
    } else {
      const pair = this.fxPairs.get(s.fxPairId)!;
      const qa = M.quarterAverage(pair.state, period, this.params);
      if (qa.ok) {
        if (c.fxFallback) fail("FxFallbackNotAllowed");
        if (fxAvgWad !== qa.avgWad) fail("FxMismatch", `accumulator ${qa.avgWad} != ${fxAvgWad}`);
      } else {
        if (!c.fxFallback) fail("FxFallbackRequired");
        this.requireActiveAttestor(c.fxFallback.attestor);
        fxFallback = true;
      }
    }
    // 5. prior commitment
    const prior = l.lastIncomePeriod !== null && yearOf(l.lastIncomePeriod) === yearOf(period) && l.lastIncomePeriod === period - 1 ? l.lastIncomeCommitment : ZERO_INCOME_COMMITMENT;
    // 6. proof
    const unitsPublic = isTail ? l.unitsAtRedemption : s.supply;
    const expectedSignals = [s.termsCommitment, unitsPublic, fxAvgWad, prior, incomeCommitment, paymentUsd].map(D);
    if (c.publicSignals.length !== 6 || c.publicSignals.some((v, i) => B(v) !== B(expectedSignals[i]!))) {
      fail("InvalidProof", `public signals mismatch: expected ${expectedSignals.join(",")} got ${c.publicSignals.join(",")}`);
    }
    if (this.verifyProofs) {
      const ok = await verifyReport(c.proof as unknown as Groth16Proof, c.publicSignals);
      if (!ok) fail("InvalidProof", "groth16 verification failed");
    }
    // 7. attestation
    if (c.tier === Tier.Tier2Zktls) {
      if (!c.attestation || this.verifierKeys.get(c.attestation) !== true) fail("InvalidVerifierSignature", c.attestation ?? "none");
    } else if (c.tier === Tier.Tier3Attestor) {
      if (!c.attestation) fail("InvalidAttestorSignature", "none");
      this.requireActiveAttestor(c.attestation);
    }
    // 8. effects
    const creditUsed = l.routerCredit < paymentUsd ? l.routerCredit : paymentUsd;
    l.routerCredit -= creditUsed;
    const due = paymentUsd - creditUsed;
    const report: Report = { period, acceptedAt: this.now, paymentUsd, fxAvgWad, fxFallback, tier: c.tier, liquidityEvent: c.liquidityEvent, incomeCommitment, accrualPaid: 0n, paidAt: null, tail: isTail };
    s.reports.set(period, report);
    l.lastAcceptedPeriod = period;
    l.lastIncomeCommitment = incomeCommitment;
    l.lastIncomePeriod = period;
    if (due === 0n) {
      l.lastPaidPeriod = period;
      report.paidAt = this.now;
      this.emit(s, `PaymentSettled period=${period} gross=0`);
    } else {
      l.openDuePeriod = period;
      l.openDueAmount = due;
      l.openDueTier = c.tier;
      l.openDueIsTail = isTail;
    }
    this.emit(s, `ReportAccepted period=${period} paymentUsd=${paymentUsd} fx=${fxAvgWad} fallback=${fxFallback} tier=${c.tier} liq=${c.liquidityEvent} due=${due}`);
    this.syncStatus(s);
  }

  private pay(c: Extract<Call, { op: "pay" }>): void {
    const s = this.getSeries(c.series);
    const l = s.ledger;
    if (l.openDueAmount === 0n || l.openDuePeriod === null) fail("NothingDue");
    const period = l.openDuePeriod;
    if (l.openDueIsTail) {
      const total = l.openDueAmount;
      this.debit(c.actor, total, "tail payment");
      const { state, result } = M.tailReceive(l.tail, total, l.unitsAtRedemption, s.terms.payoutFeeBps);
      l.tail = state;
      s.vaultBalance += result.accepted - result.fee;
      this.feeCollector += result.fee;
      if (result.refund > 0n) this.credit(s.issuer, result.refund);
      const r = s.reports.get(period)!;
      r.paidAt = this.now;
      l.lastPaidPeriod = period;
      l.openDuePeriod = null;
      l.openDueAmount = 0n;
      l.openDueIsTail = false;
      this.emit(s, `TailDistributed period=${period} gross=${total} accepted=${result.accepted} fee=${result.fee} refunded=${result.refund}`);
      return;
    }
    const accrual = M.lateAccrual(period, l.openDueAmount, this.clock(s), this.now, this.statusParams(s));
    const total = l.openDueAmount + accrual;
    this.debit(c.actor, total, "payment");
    const result = this.vaultReceive(s, total, "Payment", s.issuer);
    const r = s.reports.get(period)!;
    r.accrualPaid = accrual;
    r.paidAt = this.now;
    l.lastPaidPeriod = period;
    l.openDuePeriod = null;
    l.openDueAmount = 0n;
    this.emit(s, `PaymentSettled period=${period} gross=${total} accrual=${accrual} fee=${result.fee} accepted=${result.accepted} refunded=${result.refund}`);
    this.syncStatus(s);
  }

  private submitTrueup(c: Extract<Call, { op: "submit_trueup" }>): void {
    const s = this.getSeries(c.series);
    this.requireIssuer(s, c.actor);
    if (!tierEnabled(s.tierFlags, Tier.Tier3Attestor)) fail("TierNotEnabled", "tier 3");
    this.requireActiveAttestor(c.attestor);
    const adj = B(c.adjustment);
    const l = s.ledger;
    if (adj > 0n) {
      l.trueupDue += adj;
      l.trueupDeadline = B(c.attestationTs) + BigInt(this.params.trueupDays) * DAY;
    } else if (adj < 0n) {
      l.routerCredit += -adj;
    }
    this.emit(s, `TrueUpRecorded year=${c.year} adjustment=${adj} deadline=${l.trueupDeadline}`);
  }

  private payTrueup(c: Extract<Call, { op: "pay_trueup" }>): void {
    const s = this.getSeries(c.series);
    const l = s.ledger;
    if (l.trueupDue === 0n) fail("NothingDue");
    const accrual = M.accrualFromGraceEnd(l.trueupDue, l.trueupDeadline, this.clock(s), this.now, s.terms.hurdleRateWad);
    const total = l.trueupDue + accrual;
    this.debit(c.actor, total, "true-up");
    const result = this.vaultReceive(s, total, "Payment", s.issuer);
    l.trueupDue = 0n;
    l.trueupDeadline = 0n;
    this.emit(s, `TrueUpPaid amount=${total} accrual=${accrual} accepted=${result.accepted}`);
    this.syncStatus(s);
  }

  private routeIncome(c: Extract<Call, { op: "route_income" }>): void {
    const s = this.getSeries(c.series);
    if (!s.router) fail("RouterNotEnabled");
    if (s.raiseState !== RaiseState.Settled) fail("RaiseNotSettled");
    if (M.isTerminal(s.ledger.status)) fail("SeriesTerminal");
    const amount = B(c.amount);
    this.debit(c.payer, amount, "routed income");
    const yearNow = yearOf(periodOf(this.now));
    const r = M.routeIncome(s.router, amount, s.supply, yearNow);
    s.router = r.state;
    this.credit(s.issuer, r.passThrough);
    if (r.share > 0n) {
      const result = this.vaultReceive(s, r.share, "Router", s.issuer);
      s.ledger.routerCredit += result.accepted;
    }
    this.emit(s, `IncomeRouted amount=${amount} passThrough=${r.passThrough} routed=${r.share} ytd=${s.router.ytdReceived}`);
    this.syncStatus(s);
  }

  private claim(c: Extract<Call, { op: "claim" }>): void {
    const s = this.getSeries(c.series);
    const h = this.settleHolder(s, c.actor);
    const amount = h.pending;
    h.pending = 0n;
    let burned = 0n;
    if (s.ledger.status === SeriesStatus.Retired) {
      burned = this.unitsOf(c.actor, s.id);
      this.burn(s, c.actor, burned, "Retired");
    }
    if (amount > s.vaultBalance) throw new Error(`vault underflow: claim ${amount} > balance ${s.vaultBalance}`);
    s.vaultBalance -= amount;
    this.credit(c.actor, amount);
    this.emit(s, `PayoutClaimed ${c.actor} amount=${amount} burned=${burned}`);
  }

  private approvePause(c: Extract<Call, { op: "approve_pause" }>): void {
    const s = this.getSeries(c.series);
    const l = s.ledger;
    this.requireActiveAttestor(c.attestor);
    if (!l.pauseRequested) fail("PauseNotRequested");
    const end = B(c.pauseEnd);
    if (end <= this.now) fail("InvalidPauseEnd");
    if (M.isPaused(this.clock(s), this.now)) fail("AlreadyPaused");
    this.syncStatus(s);
    l.pauseStart = this.now;
    l.pauseEnd = end;
    l.pauseNonce += 1n;
    l.pauseRequested = false;
    this.emit(s, `PauseApproved start=${this.now} end=${end} attestor=${c.attestor}`);
    this.syncStatus(s);
  }

  // ------------------------------------------------------------------------------------------
  // fx
  // ------------------------------------------------------------------------------------------

  private fxSnapshot(c: Extract<Call, { op: "fx_snapshot" }>): void {
    const pair = this.fxPairs.get(c.pairId.toLowerCase());
    if (!pair) throw new Error(`unknown fx pair ${c.pairId}`);
    const price = { price: B(c.price), conf: B(c.conf), expo: c.expo, publishTime: B(c.publishTime) };
    const bad = M.validatePythPrice(price, this.now, this.params);
    if (bad) fail("FxMismatch", `pyth update rejected: ${bad}`);
    let rate = M.normalizePythPrice(price.price, price.expo);
    if (pair.inverted) rate = M.invertRate(rate);
    let cross: bigint | null = null;
    if (pair.crosscheck && c.crosscheckPrice !== undefined) {
      cross = M.normalizePythPrice(B(c.crosscheckPrice), c.crosscheckExpo ?? c.expo);
      if (pair.inverted) cross = M.invertRate(cross);
    }
    let r: M.SnapshotResult;
    try {
      r = M.snapshot(pair.state, this.now, rate, cross, this.params);
    } catch (e) {
      if ((e as Error).message === "SnapshotAlreadyTaken") fail("FxMismatch", "snapshot already taken today");
      throw e;
    }
    pair.state = r.state;
    this.emit(null, `FxSnapshot ${pair.pairId} day=${r.day} rate=${r.rateWad} sum=${r.state.sumWad} count=${r.state.count}${r.flagged ? " DEVIATION" : ""}`);
  }

  // ------------------------------------------------------------------------------------------
  // exit path
  // ------------------------------------------------------------------------------------------

  private redeem(c: Extract<Call, { op: "redeem" }>): void {
    const s = this.getSeries(c.series);
    this.requireIssuer(s, c.actor);
    if (s.raiseState !== RaiseState.Settled) fail("RaiseNotSettled");
    this.syncStatus(s);
    const l = s.ledger;
    if (M.isTerminal(l.status)) fail("SeriesTerminal");
    if (this.now < s.settlementTs + s.terms.lockupSeconds) fail("LockupActive");
    if (l.openDueAmount > 0n) fail("PaymentOutstanding");
    const q = M.redemptionQuote({
      p0: s.clearingPrice,
      hurdleRateWad: s.terms.hurdleRateWad,
      payoutMultipleK: s.terms.payoutMultipleK,
      t: this.now - s.settlementTs,
      capPerUnit: s.vault.capPerUnit,
      paidPerUnitWad: s.vault.paidPerUnitWad,
      yearGrossWad: s.vault.yearGrossWad,
      unitsOutstanding: s.supply,
    });
    this.debit(c.actor, q.deposit, "redemption deposit");
    s.vaultBalance += q.deposit;
    l.status = SeriesStatus.Redeemed;
    l.redemptionTs = this.now;
    l.redemptionPrice = q.pRedeem;
    l.unitsAtRedemption = s.supply;
    l.tail = M.newTailState(q.tailCapPerUnit);
    this.emit(s, `SeriesRedeemed price=${q.pRedeem} hurdle=${q.pHurdle} dAvg=${q.dAvg ?? "none"} capRemaining=${q.cRemaining} units=${s.supply} deposit=${q.deposit} decidedBy=${q.decidedBy}`);
  }

  private claimRedemption(c: Extract<Call, { op: "claim_redemption" }>): void {
    const s = this.getSeries(c.series);
    const l = s.ledger;
    if (l.status !== SeriesStatus.Redeemed && !(l.status === SeriesStatus.Extinguished && l.redemptionTs !== 0n)) fail("NotRedeemed");
    const h = this.settleHolder(s, c.actor);
    const units = this.unitsOf(c.actor, s.id);
    if (units > 0n && h.redeemedUnits === 0n) h.redeemedUnits = units;
    const amount = h.pending + l.redemptionPrice * units;
    h.pending = 0n;
    this.burn(s, c.actor, units, "Redeemed");
    if (amount > s.vaultBalance) throw new Error("vault underflow in redemption");
    s.vaultBalance -= amount;
    this.credit(c.actor, amount);
    this.emit(s, `RedemptionClaimed ${c.actor} units=${units} amount=${amount}`);
  }

  private claimTail(c: Extract<Call, { op: "claim_tail" }>): void {
    const s = this.getSeries(c.series);
    const l = s.ledger;
    if (l.redemptionTs === 0n) fail("NotRedeemed");
    const h = s.holders.get(c.actor);
    if (!h || !h.registered) fail("HolderNotRegistered", c.actor);
    if (h.redeemedUnits === 0n) fail("NoRedeemedUnits", c.actor);
    const amount = M.settleHolderDelta(l.tail.tailAccWad, h.lastTailAccWad, h.redeemedUnits);
    h.lastTailAccWad = l.tail.tailAccWad;
    if (amount > s.vaultBalance) throw new Error("vault underflow in tail");
    s.vaultBalance -= amount;
    this.credit(c.actor, amount);
    this.emit(s, `TailClaimed ${c.actor} amount=${amount}`);
  }

  private extinguish(c: Extract<Call, { op: "extinguish" }>): void {
    const s = this.getSeries(c.series);
    const [a, b] = c.attestors;
    if (a === b) fail("SameAttestor");
    this.requireActiveAttestor(a);
    this.requireActiveAttestor(b);
    if (s.raiseState !== RaiseState.Settled) fail("RaiseNotSettled");
    this.syncStatus(s);
    const l = s.ledger;
    if (l.status === SeriesStatus.Retired || l.status === SeriesStatus.Extinguished) fail("SeriesTerminal");
    if (l.status === SeriesStatus.Redeemed && this.now > l.redemptionTs + this.params.tailSeconds) fail("SeriesTerminal", "tail ended");
    const N = l.status === SeriesStatus.Redeemed ? l.unitsAtRedemption : s.supply;
    const unreleased = s.treasury.proceeds - s.treasury.releasedTotal;
    const wasRedeemed = l.status === SeriesStatus.Redeemed;
    if (unreleased > 0n) {
      if (N === 0n) fail("NoUnitsOutstanding");
      s.treasury.balance -= unreleased;
      s.treasury.releasedTotal += unreleased;
      s.vaultBalance += unreleased;
      l.final = M.finalDistribute(l.final, unreleased, N).state;
    }
    l.status = SeriesStatus.Extinguished;
    l.openDuePeriod = null;
    l.openDueAmount = 0n;
    l.openDueIsTail = false;
    l.trueupDue = 0n;
    l.extinguishNonce += 1n;
    this.emit(s, `SeriesExtinguished unreleased=${unreleased} attestors=${a},${b}${wasRedeemed ? " (tail ended)" : ""}`);
  }

  private claimFinal(c: Extract<Call, { op: "claim_final" }>): void {
    const s = this.getSeries(c.series);
    const l = s.ledger;
    if (l.status !== SeriesStatus.Extinguished) fail("SeriesTerminal", "not Extinguished");
    const h = this.settleHolder(s, c.actor);
    const units = l.redemptionTs !== 0n ? h.redeemedUnits : this.unitsOf(c.actor, s.id);
    const finalAmount = h.finalClaimed ? 0n : M.settleHolderDelta(l.final.finalAccWad, h.lastFinalAccWad, units);
    h.lastFinalAccWad = l.final.finalAccWad;
    h.finalClaimed = true;
    const amount = h.pending + finalAmount;
    h.pending = 0n;
    const burned = this.unitsOf(c.actor, s.id);
    this.burn(s, c.actor, burned, "Extinguished");
    if (amount > s.vaultBalance) throw new Error("vault underflow in final claim");
    s.vaultBalance -= amount;
    this.credit(c.actor, amount);
    this.emit(s, `FinalClaimed ${c.actor} units=${units} amount=${amount}`);
  }

  // ------------------------------------------------------------------------------------------
  // transfer window
  // ------------------------------------------------------------------------------------------

  private windowRules(s: SeriesState): M.WindowRules {
    return { unitsOutstanding: s.supply, walletCapBps: s.terms.walletCapBps, windowFeeBps: s.terms.windowFeeBps };
  }

  private openWindow(c: Extract<Call, { op: "open_window" }>): void {
    const s = this.getSeries(c.series);
    if (!this.flags.windowsEnabled) fail("WindowsDisabled");
    if (s.raiseState !== RaiseState.Settled) fail("RaiseNotSettled");
    this.syncStatus(s);
    const status = this.derivedStatus(s);
    if (status !== SeriesStatus.OnTime && status !== SeriesStatus.InGrace) fail("WindowNotEligible", `status ${SeriesStatus[status]}`);
    if (this.now < s.settlementTs + s.terms.lockupSeconds) fail("LockupActive");
    const period = Number(c.period);
    if (s.ledger.lastPaidPeriod === null || s.ledger.lastPaidPeriod < period) fail("WindowNotEligible", `period ${period} not paid`);
    if (period !== periodOf(this.now) - 1) fail("WindowNotEligible", `period ${period} is not the previous quarter`);
    if (s.window && s.window.state !== "Done" && s.window.state !== "NoMatch") fail("WindowOpen");
    s.window = {
      period,
      state: "Commit",
      opensAt: this.now,
      commitEnd: this.now + s.terms.windowCommitDuration,
      revealEnd: this.now + s.terms.windowCommitDuration + s.terms.windowRevealDuration,
      orders: [],
      revealed: 0,
      escrowUnits: 0n,
      escrowStable: 0n,
      clearing: null,
    };
    this.emit(s, `WindowOpened period=${period} commitEnd=${s.window.commitEnd} revealEnd=${s.window.revealEnd}`);
  }

  private commitOrder(c: Extract<Call, { op: "commit_ask" | "window_commit_bid" }>): void {
    const s = this.getSeries(c.series);
    const w = s.window;
    if (!w || w.state !== "Commit" || this.now >= w.commitEnd) fail("WindowNotOpen");
    const side = c.op === "commit_ask" ? 1 : 0;
    if (w.orders.some((o) => o.owner === c.actor && o.side === side)) fail("OrderExists", c.actor);
    let escrow: bigint;
    if (c.op === "commit_ask") {
      escrow = B(c.units);
      if (escrow <= 0n || this.unitsOf(c.actor, s.id) < escrow) fail("InsufficientUnits", c.actor);
      this.settleHolder(s, c.actor);
      this.addUnits(c.actor, s.id, -escrow);
      w.escrowUnits += escrow;
    } else {
      if (!this.allowlist.has(c.actor)) fail("NotAllowlisted", c.actor);
      escrow = B(c.escrow);
      if (escrow <= 0n) fail("ZeroEscrow");
      this.debit(c.actor, escrow, "window bid escrow");
      w.escrowStable += escrow;
    }
    w.orders.push({ owner: c.actor, side, escrow, revealed: false, valid: false, price: B(c.price), quantity: B(c.quantity), revealIndex: -1, salt: c.salt.toLowerCase(), processed: false });
    this.emit(s, `OrderCommitted ${c.actor} side=${side === 1 ? "Ask" : "Bid"} escrow=${escrow}`);
  }

  private revealOrder(c: Extract<Call, { op: "reveal_order" }>): void {
    const s = this.getSeries(c.series);
    const w = s.window;
    if (!w || w.state !== "Commit" && w.state !== "Reveal") fail("WindowNotOpen");
    if (this.now < w.commitEnd || this.now >= w.revealEnd) fail("RevealPhaseClosed");
    w.state = "Reveal";
    const o = w.orders.find((x) => x.owner === c.actor && !x.revealed && x.price === B(c.price) && x.quantity === B(c.quantity) && x.salt === c.salt.toLowerCase());
    if (!o) {
      if (w.orders.some((x) => x.owner === c.actor && !x.revealed)) fail("CommitmentMismatch", c.actor);
      fail("BidNotFound", c.actor);
    }
    o.revealed = true;
    o.revealIndex = w.revealed++;
    o.valid = M.isOrderValid(o.side, o.price, o.quantity, o.escrow, this.unitsOf(c.actor, s.id), this.windowRules(s));
    this.emit(s, `OrderRevealed ${c.actor} side=${o.side === 1 ? "Ask" : "Bid"} price=${o.price} qty=${o.quantity} valid=${o.valid}`);
  }

  private settleWindow(c: Extract<Call, { op: "settle_window" }>): void {
    const s = this.getSeries(c.series);
    const w = s.window;
    if (!w || (w.state !== "Commit" && w.state !== "Reveal")) fail("WindowNotOpen");
    if (this.now < w.revealEnd) fail("SettlementNotReady");
    if (c.clearingPrice === "NO_MATCH") {
      if (!M.isNoMatchValid(M.tallyOrders(w.orders, null))) fail("InvalidWindowPrice", "NO_MATCH but max_bid ≥ min_ask");
      w.state = "NoMatch";
      this.emit(s, `WindowNoMatch period=${w.period}`);
      return;
    }
    const p = B(c.clearingPrice);
    const t = M.tallyOrders(w.orders, p);
    if (!M.isWindowPriceValid(t)) fail("InvalidWindowPrice", `p=${p}`);
    w.clearing = M.finalizeWindow(t, p);
    w.state = "Settled";
    this.emit(s, `WindowCleared period=${w.period} p=${p} matched=${w.clearing.matchedUnits}`);
  }

  private processOrders(c: Extract<Call, { op: "process_orders" }>): void {
    const s = this.getSeries(c.series);
    const w = s.window;
    if (!w || (w.state !== "Settled" && w.state !== "NoMatch")) fail("WindowNotOpen");
    if (w.state === "NoMatch") {
      for (const o of w.orders) {
        if (o.side === 1) {
          this.addUnits(o.owner, s.id, o.escrow);
          w.escrowUnits -= o.escrow;
        } else {
          this.credit(o.owner, o.escrow);
          w.escrowStable -= o.escrow;
        }
        o.processed = true;
      }
      w.state = "Done";
      return;
    }
    const fills = M.computeFills(w.orders, w.clearing!, s.terms.windowFeeBps);
    const cap = M.walletCapUnits(s.supply, s.terms.walletCapBps);
    // sellers first (stablecoin comes from the window escrow funded by the buyers below)
    let proceedsPool = 0n;
    for (const [i, o] of w.orders.entries()) {
      const f = fills[i]!;
      if (o.side === 0) {
        proceedsPool += f.cost;
        this.feeCollector += f.fee;
        this.credit(o.owner, f.refund);
        w.escrowStable -= o.escrow;
      }
    }
    for (const [i, o] of w.orders.entries()) {
      const f = fills[i]!;
      if (o.side === 1) {
        this.credit(o.owner, f.cost);
        proceedsPool -= f.cost;
        this.addUnits(o.owner, s.id, f.refund);
        w.escrowUnits -= o.escrow;
        w.escrowUnits += f.fill; // sold units stay in escrow until buyers take them below
      }
    }
    if (proceedsPool !== 0n) throw new Error(`window stablecoin not conserved: ${proceedsPool}`);
    for (const [i, o] of w.orders.entries()) {
      const f = fills[i]!;
      if (o.side === 0 && f.fill > 0n) {
        if (!this.allowlist.has(o.owner)) fail("NotAllowlisted", o.owner);
        this.registerHolder(s, o.owner);
        this.settleHolder(s, o.owner);
        if (this.unitsOf(o.owner, s.id) + f.fill > cap) fail("WalletCapExceeded", o.owner);
        this.addUnits(o.owner, s.id, f.fill);
        w.escrowUnits -= f.fill;
      }
      o.processed = true;
      this.emit(s, `OrderFilled ${o.owner} side=${o.side === 1 ? "Ask" : "Bid"} fill=${f.fill} price=${w.clearing!.clearingPrice} fee=${f.fee} refund=${f.refund}`);
    }
    if (w.escrowUnits !== 0n) throw new Error(`window units not conserved: ${w.escrowUnits}`);
    w.state = "Done";
  }

  // ------------------------------------------------------------------------------------------
  // snapshots
  // ------------------------------------------------------------------------------------------

  ledgerExpect(s: SeriesState): LedgerExpect {
    const l = s.ledger;
    return {
      status: SeriesStatus[this.derivedStatus(s)]!,
      raiseState: RaiseState[s.raiseState]!,
      unitsOutstanding: D(s.supply),
      unitsSold: D(s.unitsMinted),
      clearingPrice: D(s.clearingPrice),
      proceeds: D(s.treasury.proceeds),
      releasedTotal: D(s.treasury.releasedTotal),
      capPerUnit: D(s.vault.capPerUnit),
      capMultipleWad: D(s.capMultipleWad),
      termsCommitment: H(fieldToBytes32(s.termsCommitment)),
      amendmentNonce: D(s.amendmentNonce),
      paidPerUnitWad: D(s.vault.paidPerUnitWad),
      netAccWad: D(s.vault.netAccWad),
      carryWad: D(s.vault.carryWad),
      grossReceived: D(s.vault.grossReceived),
      feeCollected: D(s.vault.feeCollected),
      refundedToIssuer: D(s.vault.refundedToIssuer),
      lastAcceptedPeriod: l.lastAcceptedPeriod === null ? null : D(l.lastAcceptedPeriod),
      lastPaidPeriod: l.lastPaidPeriod === null ? null : D(l.lastPaidPeriod),
      openDuePeriod: l.openDuePeriod === null ? null : D(l.openDuePeriod),
      openDueAmount: D(l.openDueAmount),
      routerCredit: D(l.routerCredit),
      trueupDue: D(l.trueupDue),
      pausedTotal: D(l.pausedTotal + M.pauseElapsed(this.clock(s), this.now)),
      pauseNonce: D(l.pauseNonce),
      formalNoticeEmittedFor: l.formalNoticeEmittedFor === null ? null : D(l.formalNoticeEmittedFor),
      redemptionPrice: D(l.redemptionPrice),
      unitsAtRedemption: D(l.unitsAtRedemption),
      tailCapPerUnit: D(l.tail.tailCapPerUnit),
      tailAccWad: D(l.tail.tailAccWad),
      finalAccWad: D(l.final.finalAccWad),
      extinguishNonce: D(l.extinguishNonce),
    };
  }

  auctionExpect(s: SeriesState): AuctionExpect {
    return {
      bidCount: D(s.bids.size),
      revealedCount: D(s.revealedCount),
      escrowTotal: D(s.escrowTotal),
      R: D(s.R),
      qAt: D(s.qAt),
      qAbove: D(s.qAbove),
      unitsSoldUpper: D(s.unitsSoldUpper),
      bidsProcessed: D(s.bidsProcessed),
    };
  }

  fxExpect(pairId: string, periods: number[]): FxExpect {
    const pair = this.fxPairs.get(pairId.toLowerCase());
    if (!pair) throw new Error(`unknown pair ${pairId}`);
    const quarters: FxExpect["quarters"] = {};
    for (const p of periods) {
      const qa = M.quarterAverage(pair.state, p, this.params);
      quarters[D(p)] = { ok: qa.ok, avgWad: qa.avgWad === null ? null : D(qa.avgWad), n: D(qa.n), flagged: qa.flagged };
    }
    return { sumWad: D(pair.state.sumWad), count: D(pair.state.count), quarters };
  }

  /** Full `expect` snapshot: every actor's balances plus the series' money and ledger views. */
  expect(seriesId: string | null, opts: { fx?: Record<string, number[]> } = {}): Omit<ExpectStep, "t"> {
    const out: Omit<ExpectStep, "t"> = { op: "expect" };
    if (seriesId) out.series = seriesId;
    const balances: NonNullable<ExpectStep["balances"]> = {};
    for (const name of [...this.accounts.keys()].sort()) {
      const a = this.account(name);
      const entry: { stable: string; units?: string } = { stable: D(a.stable) };
      if (seriesId) entry.units = D(a.units.get(seriesId) ?? 0n);
      balances[name] = entry;
    }
    out.balances = balances;
    out.feeCollector = D(this.feeCollector);
    if (seriesId) {
      const s = this.getSeries(seriesId);
      out.treasury = D(s.treasury.balance);
      out.vault = D(s.vaultBalance);
      out.auctionEscrow = D(s.escrowTotal);
      if (s.router) out.routerBalance = D(s.routerBalance);
      if (s.window) {
        out.windowEscrowStable = D(s.window.escrowStable);
        out.windowEscrowUnits = D(s.window.escrowUnits);
      }
      out.ledger = this.ledgerExpect(s);
      out.auction = this.auctionExpect(s);
      const holders: NonNullable<ExpectStep["holders"]> = {};
      for (const [name, h] of [...s.holders.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!h.registered) continue;
        holders[name] = { pending: D(h.pending), redeemedUnits: D(h.redeemedUnits) };
      }
      out.holders = holders;
    }
    if (opts.fx) {
      out.fx = {};
      for (const [pairId, periods] of Object.entries(opts.fx)) out.fx[pairId] = this.fxExpect(pairId, periods);
    }
    return out;
  }

  /**
   * Deterministic serialization of the whole state (for revert-atomicity checks and tests).
   * Empty accounts and unregistered holder records are omitted: they are lazily created by reads.
   */
  serialize(): string {
    const replacer = (_k: string, v: unknown): unknown => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), x]));
      if (v instanceof Set) return [...v];
      return v;
    };
    const accounts = new Map([...this.accounts.entries()].filter(([, a]) => a.stable !== 0n || [...a.units.values()].some((u) => u !== 0n)));
    const series = new Map(
      [...this.series.entries()].map(([k, s]) => [k, { ...s, events: undefined, holders: new Map([...s.holders.entries()].filter(([, h]) => h.registered)) }]),
    );
    return JSON.stringify(
      {
        now: this.now,
        flags: this.flags,
        allowlist: this.allowlist,
        issuers: this.issuers,
        attestors: this.attestors,
        verifierKeys: this.verifierKeys,
        feeCollector: this.feeCollector,
        accounts,
        series,
        fxPairs: this.fxPairs,
      },
      replacer,
    );
  }

  /** Σ stablecoin across every account and pool — must be constant apart from `fund` steps. */
  totalStable(): bigint {
    let total = this.feeCollector;
    for (const a of this.accounts.values()) total += a.stable;
    for (const s of this.series.values()) total += s.treasury.balance + s.vaultBalance + s.escrowTotal + s.routerBalance + (s.window?.escrowStable ?? 0n);
    return total;
  }

  /** Σ units across holders and the window escrow equals the mint supply. */
  checkUnitSupply(seriesId: string): void {
    const s = this.getSeries(seriesId);
    let total = s.window?.escrowUnits ?? 0n;
    for (const a of this.accounts.values()) total += a.units.get(seriesId) ?? 0n;
    if (total !== s.supply) throw new Error(`unit supply mismatch for ${seriesId}: ${total} != ${s.supply}`);
  }
}

export type { ActionStep, Step };
export { BPS_DENOMINATOR };
