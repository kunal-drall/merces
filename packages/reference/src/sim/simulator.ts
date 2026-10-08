/**
 * In-memory model of the whole protocol (SPEC v1.1 §3–§7) driven by the vector steps of §11.
 * Chain-neutral: wallets are actor names, signatures are modelled as "signed by a registered key"
 * (each chain's harness builds and verifies the real §1.4 messages), Groth16 proofs are verified
 * for real with the dev verification key.
 */
import {
  DAY,
  DEFAULT_PARAMETERS,
  PARAMETER_BOUNDS,
  RaiseState,
  SeriesStatus,
  Tier,
  U64_MAX,
  WAD,
  ZERO_INCOME_COMMITMENT,
  bytes32ToField,
  bytesToHex,
  fieldToBytes32,
  fxPairId,
  hexToBytes,
  periodEnd,
  periodOf,
  periodStart,
  quarterIndex,
  routerIncomeCommitment,
  settlementYear,
  tierEnabled,
  yearOf,
  type ErrorName,
  type Parameters,
  type Pause,
} from "@merces/sdk";
import { verifyReport, type Groth16Proof } from "@merces/circuits";
import * as M from "../math/index.js";
import type { AuctionExpect, Call, ExpectRevertStep, ExpectStep, FxExpect, HolderExpect, LedgerExpect, Step, WindowExpect } from "./types.js";

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

function u64(v: bigint, what: string): bigint {
  if (v < 0n || v > U64_MAX) fail("AmountOutOfRange", `${what}=${v}`);
  return v;
}

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
  allocation: bigint;
  pendingUnits: bigint;
  pendingRefund: bigint;
  delivered: boolean;
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
  priorIncomeCommitment: bigint;
  due: bigint;
  accrualPaid: bigint;
  paidAt: bigint | null;
}

interface Order extends M.WindowOrder {
  salt: string;
  processed: boolean;
}

interface WindowState {
  period: number;
  state: "Commit" | "Reveal" | "Settling" | "Settled" | "NoMatch" | "Done";
  opensAt: bigint;
  commitEnd: bigint;
  revealEnd: bigint;
  orders: Order[];
  revealed: number;
  escrowUnits: bigint;
  escrowStable: bigint;
  tallyRound: number;
  roundRejected: boolean;
  proposal: bigint | null | undefined; // undefined = no proposal yet; null = NO_MATCH
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
  routerCredit: bigint;
  trueupNonce: bigint;
  trueupDue: bigint;
  trueupAttestedAt: bigint;
  trueupYear: number | null;
  lastTrueupYear: number | null;
  pauseNonce: bigint;
  pauseRequested: boolean;
  pauseRequestedAt: bigint;
  pauses: Pause[];
  pausedTotal: bigint;
  formalNoticeEmittedFor: number | null;
  trueupNoticeEmitted: boolean;
  unitsOutstanding: bigint;
  lastIncomeCommitment: bigint;
  lastIncomePeriod: number | null;
  redemptionTs: bigint;
  redemptionPrice: bigint;
  unitsAtRedemption: bigint;
  tail: M.TailState;
  extinguishedAt: bigint;
  final: M.FinalState;
  extinguishNonce: bigint;
}

interface Auction {
  validCount: number;
  tallyRound: number;
  roundRejected: boolean;
  rejectionReason: string | null;
  proposal: M.Proposal | null;
  clearingPrice: bigint;
  qAbove: bigint;
  qAt: bigint;
  R: bigint;
  unitsSold: bigint;
  proceeds: bigint;
  bidsProcessed: number;
  unitsMinted: bigint;
  mintFinalized: boolean;
  /** minted-but-undelivered units held by the auction escrow */
  escrowUnits: bigint;
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
  settlementTs: bigint;
  auction: Auction;
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
  feedId: string;
  inverted: boolean;
  crosscheck: boolean;
  crosscheckEffectivePeriod: number;
  state: M.FxPairState;
}

interface KeyRecord {
  active: boolean;
  revokedAt: bigint;
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
  readonly attestors = new Map<string, KeyRecord>();
  readonly verifierKeys = new Map<string, KeyRecord>();
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
    return this.accounts.get(actor)?.units.get(seriesId) ?? 0n;
  }

  private addUnits(actor: string, seriesId: string, delta: bigint): void {
    if (delta === 0n) return;
    const a = this.account(actor);
    const v = (a.units.get(seriesId) ?? 0n) + delta;
    if (v < 0n) throw new Error(`negative units for ${actor}`);
    a.units.set(seriesId, v);
  }

  private debit(actor: string, amount: bigint, what: string): void {
    if (amount < 0n) throw new Error("negative debit");
    if (amount === 0n) return;
    const a = this.accounts.get(actor);
    if (!a || a.stable < amount) fail("InsufficientEscrow", `${actor} has ${a?.stable ?? 0n} < ${amount} for ${what}`);
    a.stable -= amount;
  }

  private credit(actor: string, amount: bigint): void {
    if (amount < 0n) throw new Error("negative credit");
    if (amount === 0n) return;
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
    const k = this.attestors.get(key);
    if (!k || !k.active) fail("InvalidAttestorSignature", `${key} is not an active attestor`);
  }

  /** Report attestations accept a key revoked after the period ended, for report_due + grace days (SPEC §1.4). */
  private reportKeyValid(record: KeyRecord | undefined, period: number): boolean {
    if (!record) return false;
    if (record.active) return true;
    const grace = BigInt(this.params.reportDueDays + this.params.graceDays) * DAY;
    return periodEnd(period) <= record.revokedAt && this.now <= record.revokedAt + grace;
  }

  private clock(s: SeriesState): M.LedgerClock {
    const l = s.ledger;
    return {
      status: l.status,
      firstPeriod: l.firstPeriod,
      lastAcceptedPeriod: l.lastAcceptedPeriod,
      openDuePeriod: l.openDuePeriod,
      openDueAmount: l.openDueAmount,
      pauses: l.pauses,
      trueupDue: l.trueupDue,
      trueupAttestedAt: l.trueupAttestedAt,
    };
  }

  private statusParams(s: SeriesState): M.StatusParams {
    return {
      reportDueDays: this.params.reportDueDays,
      graceDays: this.params.graceDays,
      formalNoticeDays: this.params.formalNoticeDays,
      trueupDays: this.params.trueupDays,
      hurdleRateWad: s.terms.hurdleRateWad,
    };
  }

  derivedStatus(s: SeriesState): SeriesStatus {
    if (s.raiseState !== RaiseState.Settled) return s.ledger.status;
    return M.deriveStatus(this.clock(s), this.now, this.statusParams(s));
  }

  /** `cap_per_unit()` read live from the amendable cap multiple. */
  capPerUnit(s: SeriesState): bigint {
    return M.capPerUnit(s.capMultipleWad, s.auction.clearingPrice);
  }

  /** `sync_status(now)`: stores the derived status and records formal notices. */
  syncStatus(s: SeriesState): void {
    if (s.raiseState !== RaiseState.Settled) return;
    const l = s.ledger;
    const next = this.derivedStatus(s);
    if (next !== l.status) {
      this.emit(s, `StatusChanged ${SeriesStatus[l.status]} -> ${SeriesStatus[next]}`);
      l.status = next;
    }
    if (!M.isTerminal(l.status)) {
      const c = this.clock(s);
      const p = M.earliestUnpaid(c);
      if (M.formalNoticeDue(p, c, this.now, this.statusParams(s)) && l.formalNoticeEmittedFor !== p) {
        l.formalNoticeEmittedFor = p;
        this.emit(s, `FormalNoticeDue period=${p}`);
      }
      if (!l.trueupNoticeEmitted && M.trueupNoticeDue(c, this.now, this.statusParams(s))) {
        l.trueupNoticeEmitted = true;
        this.emit(s, "FormalNoticeDue trueup");
      }
    }
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

  /** `accrual_units(w) = balance + undelivered auction units + ask-escrow units` (SPEC §6.1). */
  accrualUnits(s: SeriesState, actor: string): bigint {
    let units = this.unitsOf(actor, s.id);
    const bid = s.bids.get(actor);
    if (bid && bid.processed && !bid.delivered) units += bid.pendingUnits;
    const w = s.window;
    if (w && (w.state !== "Done" || false)) {
      for (const o of w.orders) if (o.owner === actor && o.side === 1 && !o.processed) units += o.escrow;
    }
    return units;
  }

  private settleHolder(s: SeriesState, actor: string): Holder {
    const h = s.holders.get(actor);
    if (!h || !h.registered) fail("HolderNotRegistered", actor);
    h.pending += M.settleHolderDelta(s.vault.netAccWad, h.lastNetAccWad, this.accrualUnits(s, actor));
    h.lastNetAccWad = s.vault.netAccWad;
    return h;
  }

  private burn(s: SeriesState, actor: string, units: bigint, reason: string): void {
    if (units === 0n) return;
    this.addUnits(actor, s.id, -units);
    s.ledger.unitsOutstanding -= units;
    this.emit(s, `UnitsBurned ${actor} ${units} ${reason}`);
  }

  private retire(s: SeriesState, refund: bigint): void {
    const l = s.ledger;
    if (l.status === SeriesStatus.Retired) return;
    l.status = SeriesStatus.Retired;
    l.openDuePeriod = null;
    l.openDueAmount = 0n;
    l.trueupDue = 0n;
    l.trueupAttestedAt = 0n;
    this.emit(s, `SeriesRetired paidPerUnitWad=${s.vault.paidPerUnitWad} refund=${refund}`);
  }

  /** `vault_receive_gross(G, source, period_for_year)`; moves fee and refund, retires on cap. */
  private vaultReceive(s: SeriesState, gross: bigint, source: "Payment" | "Router", refundTo: string, anchorTs: bigint): M.ReceiveResult {
    if (!s.auction.mintFinalized) fail("MintNotFinalized");
    const N = s.ledger.unitsOutstanding;
    if (N === 0n) fail("NoUnitsOutstanding");
    const { state, result } = M.vaultReceiveGross(s.vault, gross, N, this.capPerUnit(s), s.terms.payoutFeeBps, settlementYear(anchorTs, s.settlementTs));
    s.vault = state;
    s.vaultBalance += result.accepted - result.fee;
    this.feeCollector += result.fee;
    if (result.refund > 0n) this.credit(refundTo, result.refund);
    this.emit(s, `PayoutDistributed source=${source} gross=${gross} accepted=${result.accepted} fee=${result.fee} deltaAcc=${result.deltaAccWad} retired=${result.retired}`);
    if (result.retired) this.retire(s, result.refund);
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
      await this.call(step.call);
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
    const actual = this.expect(step.series ?? null, step.fx ? { fx: Object.fromEntries(Object.entries(step.fx).map(([k, v]) => [k, Object.keys(v.quarters).map(Number)])) } : {});
    const ex = JSON.parse(JSON.stringify(step)) as Record<string, unknown>;
    const ac = JSON.parse(JSON.stringify(actual)) as Record<string, unknown>;
    for (const [k, v] of Object.entries(ex)) {
      if (k === "op" || k === "series" || k === "t" || k === "note") continue;
      if (JSON.stringify(v) !== JSON.stringify(ac[k])) {
        throw new Error(`expect mismatch at ${k}: expected ${JSON.stringify(v)} got ${JSON.stringify(ac[k])}`);
      }
    }
  }

  async call(c: Call): Promise<void> {
    switch (c.op) {
      case "fund":
        this.credit(c.actor, u64(B(c.amount), "amount"));
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
        this.attestors.set(c.key, { active: true, revokedAt: 0n });
        return;
      case "revoke_attestor":
        this.attestors.set(c.key, { active: false, revokedAt: this.now });
        return;
      case "register_verifier_key":
        this.verifierKeys.set(c.key, { active: true, revokedAt: 0n });
        return;
      case "revoke_verifier_key":
        this.verifierKeys.set(c.key, { active: false, revokedAt: this.now });
        return;
      case "set_flags":
        if (c.newRaisesPaused !== undefined) this.flags.newRaisesPaused = c.newRaisesPaused;
        if (c.windowsEnabled !== undefined) this.flags.windowsEnabled = c.windowsEnabled;
        if (c.tier4Enabled !== undefined) this.flags.tier4Enabled = c.tier4Enabled;
        return;
      case "set_fx_pair": {
        const pairId = H(fxPairId(c.feedId, c.inverted));
        if (this.fxPairs.has(pairId)) fail("FxPairExists", pairId);
        this.fxPairs.set(pairId, { pairId, feedId: c.feedId.toLowerCase(), inverted: c.inverted, crosscheck: c.crosscheck, crosscheckEffectivePeriod: c.crosscheck ? periodOf(this.now) : 0, state: M.newFxPairState() });
        this.emit(null, `FxPairSet ${pairId} feed=${c.feedId} inverted=${c.inverted} crosscheck=${c.crosscheck}`);
        return;
      }
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
      case "begin_settlement":
        return this.beginSettlement(c);
      case "finalize_settlement":
        return this.finalizeSettlement(c);
      case "process_bid":
        return this.processBid(c);
      case "deliver_bid":
        return this.deliverBid(c);
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
        if (s.ledger.status !== SeriesStatus.Retired) fail("TerminalStatus", "series is not Retired");
        const bal = this.unitsOf(c.holder, s.id);
        if (bal === 0n) fail("NothingToClaim", "no units to burn");
        this.settleHolder(s, c.holder);
        this.burn(s, c.holder, bal, "Retired");
        return;
      }
      case "retire_if_capped": {
        const s = this.getSeries(c.series);
        if (!s.auction.mintFinalized) fail("MintNotFinalized");
        if (M.isTerminal(s.ledger.status)) fail("TerminalStatus");
        if (!M.isCapped(s.vault, this.capPerUnit(s))) fail("NothingDue", "cap not met");
        this.retire(s, 0n);
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
        if (s.raiseState !== RaiseState.Settled) fail("RaiseNotSettled");
        if (M.isTerminal(this.derivedStatus(s))) fail("TerminalStatus");
        const l = s.ledger;
        l.pauseRequested = true;
        l.pauseRequestedAt = this.now;
        l.pauseNonce += 1n;
        this.emit(s, `PauseRequested nonce=${l.pauseNonce}`);
        return;
      }
      case "withdraw_pause_request": {
        const s = this.getSeries(c.series);
        this.requireIssuer(s, c.actor);
        const l = s.ledger;
        if (!l.pauseRequested) fail("PauseNotRequested");
        l.pauseRequested = false;
        l.pauseNonce += 1n;
        this.emit(s, `PauseRequestWithdrawn nonce=${l.pauseNonce}`);
        return;
      }
      case "approve_pause":
        return this.approvePause(c);
      case "end_pause": {
        const s = this.getSeries(c.series);
        this.requireIssuer(s, c.actor);
        const l = s.ledger;
        const open = l.pauses.find((p) => p.start <= this.now && this.now < p.end);
        if (!open) fail("NotPaused");
        l.pausedTotal -= open.end - this.now;
        open.end = this.now;
        this.emit(s, `PauseEnded pausedTotal=${l.pausedTotal}`);
        this.syncStatus(s);
        return;
      }
      case "route_income":
        return this.routeIncome(c);
      case "close_router_period": {
        const s = this.getSeries(c.series);
        if (!s.router) fail("RouterNotEnabled");
        const period = Number(c.period);
        if (this.now < periodEnd(period)) fail("ReportTooEarly", `period ${period} has not ended`);
        s.router = M.closeRouterPeriod(s.router, period);
        this.emit(s, `RouterPeriodClosed period=${period} ytdAtEnd=${M.ytdAtEnd(s.router, period)}`);
        return;
      }
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
      case "begin_window_settlement":
        return this.beginWindowSettlement(c);
      case "finalize_window":
        return this.finalizeWindow(c);
      case "process_orders":
        return this.processOrders(c);
      case "transfer_units": {
        this.getSeries(c.series);
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
      unitsOffered: u64(B(c.terms.unitsOffered), "unitsOffered"),
      reservePrice: u64(B(c.terms.reservePrice), "reservePrice"),
      minRaise: u64(B(c.terms.minRaise), "minRaise"),
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
    if (M.walletCapUnitsAtAuction(t.unitsOffered, t.walletCapBps) < 1n) fail("InvalidTerms", "wallet cap below one unit");
    const schedule: M.ReleaseTranche[] = c.releaseSchedule.map((r) => ({ atOffsetSeconds: B(r.atOffsetSeconds), bps: Number(r.bps) }));
    if (M.validateReleaseSchedule(schedule).length > 0) fail("InvalidReleaseSchedule", M.validateReleaseSchedule(schedule).join(","));
    const tier1 = tierEnabled(c.tierFlags, Tier.Tier1Split);
    if (c.router && !tier1) fail("RouterNotEnabled", "router given without tier-1 flag");
    if (!c.router && tier1) fail("RouterNotEnabled", "tier-1 flag requires router terms");
    if (tier1 && c.fxPairId) fail("InvalidTerms", "tier-1 series must have stablecoin income");
    if (c.router && B(c.router.rWad) * t.unitsOffered > WAD) fail("InvalidTerms", "r_wad × units_offered > WAD");
    if (c.fxPairId && !this.fxPairs.has(c.fxPairId.toLowerCase())) fail("UnknownFxPair", c.fxPairId);
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
      settlementTs: 0n,
      auction: { validCount: 0, tallyRound: 0, roundRejected: false, rejectionReason: null, proposal: null, clearingPrice: 0n, qAbove: 0n, qAt: 0n, R: 0n, unitsSold: 0n, proceeds: 0n, bidsProcessed: 0, unitsMinted: 0n, mintFinalized: false, escrowUnits: 0n },
      treasury: { balance: 0n, proceeds: 0n, releasedTotal: 0n, issuerPaused: false },
      vault: M.newVaultState(),
      vaultBalance: 0n,
      ledger: {
        status: SeriesStatus.OnTime,
        firstPeriod: 0,
        lastAcceptedPeriod: null,
        lastPaidPeriod: null,
        openDuePeriod: null,
        openDueAmount: 0n,
        routerCredit: 0n,
        trueupNonce: 0n,
        trueupDue: 0n,
        trueupAttestedAt: 0n,
        trueupYear: null,
        lastTrueupYear: null,
        pauseNonce: 0n,
        pauseRequested: false,
        pauseRequestedAt: 0n,
        pauses: [],
        pausedTotal: 0n,
        formalNoticeEmittedFor: null,
        trueupNoticeEmitted: false,
        unitsOutstanding: 0n,
        lastIncomeCommitment: ZERO_INCOME_COMMITMENT,
        lastIncomePeriod: null,
        redemptionTs: 0n,
        redemptionPrice: 0n,
        unitsAtRedemption: 0n,
        tail: M.newTailState(0n),
        extinguishedAt: 0n,
        final: M.newFinalState(),
        extinguishNonce: 0n,
      },
      holders: new Map(),
      router: c.router ? M.newRouterState(B(c.router.theta), B(c.router.rWad), 0) : null,
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
    if (M.isTerminal(s.ledger.status)) fail("AmendmentAfterTerminal");
    this.requireActiveAttestor(c.attestor);
    const newCap = B(c.newCapMultipleWad);
    const b = PARAMETER_BOUNDS.capMultipleWad;
    if (newCap > s.capMultipleWad || newCap < b.min || newCap > b.max) fail("UnfavourableAmendment", `cap ${newCap} vs ${s.capMultipleWad}`);
    s.termsCommitment = bytes32ToField(hexToBytes(c.newTermsCommitment));
    s.capMultipleWad = newCap;
    s.amendmentNonce += 1n;
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
    const escrow = u64(B(c.escrow), "escrow");
    if (escrow <= 0n) fail("ZeroEscrow");
    u64(B(c.price), "price");
    u64(B(c.quantity), "quantity");
    this.debit(c.actor, escrow, "bid escrow");
    s.escrowTotal += escrow;
    s.bids.set(c.actor, { bidder: c.actor, price: B(c.price), quantity: B(c.quantity), salt: c.salt.toLowerCase(), escrow, revealed: false, valid: false, revealIndex: -1, processed: false, allocation: 0n, pendingUnits: 0n, pendingRefund: 0n, delivered: false });
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
    if (b.valid) s.auction.validCount++;
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

  private beginSettlement(c: Extract<Call, { op: "begin_settlement" }>): void {
    const s = this.getSeries(c.series);
    const a = s.auction;
    if (s.raiseState !== RaiseState.Open && s.raiseState !== RaiseState.Settling) fail("RaiseNotOpen", `state ${RaiseState[s.raiseState]}`);
    if (this.now < s.revealEnd) fail("SettlementNotReady");
    if (!(a.tallyRound === 0 || a.roundRejected)) fail("TallyInProgress");
    const p = u64(B(c.clearingPrice), "clearingPrice");
    a.proposal = M.beginSettlement(s.terms.unitsOffered, p, u64(B(c.qAboveClaim), "qAboveClaim"), u64(B(c.qAtClaim), "qAtClaim"));
    a.tallyRound += 1;
    a.roundRejected = false;
    a.rejectionReason = null;
    s.raiseState = RaiseState.Settling;
    this.emit(s, `SettlementProposed p=${p} round=${a.tallyRound} claims=${a.proposal.qAboveClaim}/${a.proposal.qAtClaim} r=${a.proposal.rClaim}`);
  }

  /** Tally every revealed bid (all pages) and finalize; a wrong proposal is recorded, not reverted. */
  private finalizeSettlement(c: Extract<Call, { op: "finalize_settlement" }>): void {
    const s = this.getSeries(c.series);
    const a = s.auction;
    if (s.raiseState !== RaiseState.Settling || !a.proposal || a.roundRejected) fail("NotSettling");
    const revealed = [...s.bids.values()].filter((b) => b.revealed);
    const tally = M.tallyBids(revealed, a.proposal);
    const outcome = M.finalizeSettlement(tally, a.validCount, this.auctionRules(s), a.proposal);
    if (outcome.kind === "rejected") {
      a.roundRejected = true;
      a.rejectionReason = outcome.reason;
      this.emit(s, `SettlementRejected round=${a.tallyRound} p=${a.proposal.clearingPrice} reason=${outcome.reason}`);
      return;
    }
    a.clearingPrice = outcome.clearingPrice;
    a.qAbove = tally.qAbove;
    a.qAt = tally.qAt;
    a.unitsSold = outcome.unitsSold;
    a.proceeds = outcome.proceeds;
    if (outcome.kind === "failed") {
      a.R = 0n;
      s.raiseState = RaiseState.Failed;
      this.emit(s, `RaiseFailed p=${outcome.clearingPrice} proceeds=${outcome.proceeds} minRaise=${s.terms.minRaise} reason=${outcome.reason}`);
      if (s.bids.size === 0) this.finalizeMint(s);
      return;
    }
    a.R = outcome.R;
    s.raiseState = RaiseState.Settled;
    s.settlementTs = this.now;
    s.ledger.firstPeriod = periodOf(this.now);
    s.ledger.status = SeriesStatus.OnTime;
    if (s.router) s.router = M.newRouterState(s.router.theta, s.router.rWad, s.ledger.firstPeriod);
    this.emit(s, `RaiseSettled p=${outcome.clearingPrice} unitsSold=${outcome.unitsSold} proceeds=${outcome.proceeds}`);
  }

  private finalizeMint(s: SeriesState): void {
    const a = s.auction;
    if (s.raiseState === RaiseState.Settled && a.unitsMinted !== a.unitsSold) throw new Error(`units_minted ${a.unitsMinted} != units_sold ${a.unitsSold}`);
    a.mintFinalized = true;
    if (s.raiseState === RaiseState.Settled) s.ledger.unitsOutstanding = a.unitsSold;
    this.emit(s, `RaiseMintFinalized unitsSold=${a.unitsSold} proceeds=${a.proceeds}`);
  }

  private processBid(c: Extract<Call, { op: "process_bid" }>): void {
    const s = this.getSeries(c.series);
    const a = s.auction;
    if (s.raiseState !== RaiseState.Settled && s.raiseState !== RaiseState.Failed) fail("RaiseNotSettled");
    const b = s.bids.get(c.bidder);
    if (!b) fail("BidNotFound", c.bidder);
    if (b.processed) fail("AlreadyProcessed", c.bidder);
    const o = M.processBid(b, { failed: s.raiseState === RaiseState.Failed, clearingPrice: a.clearingPrice, R: a.R, qAt: a.qAt }, this.auctionRules(s));
    b.processed = true;
    b.allocation = o.alloc;
    b.pendingUnits = o.alloc;
    b.pendingRefund = o.pendingRefund;
    s.escrowTotal -= o.cost + o.fee + o.charge; // the refund stays in the auction escrow until delivery
    s.treasury.balance += o.cost;
    s.treasury.proceeds += o.cost;
    this.feeCollector += o.fee + o.charge;
    if (o.alloc > 0n) {
      a.escrowUnits += o.alloc;
      a.unitsMinted += o.alloc;
      this.registerHolder(s, b.bidder);
      this.emit(s, `UnitsAllocated ${b.bidder} units=${o.alloc} cost=${o.cost} fee=${o.fee} refund=${o.pendingRefund}`);
    } else {
      this.emit(s, `BidProcessed ${b.bidder} refund=${o.pendingRefund} charge=${o.charge}`);
    }
    a.bidsProcessed++;
    if (a.bidsProcessed === s.bids.size) this.finalizeMint(s);
  }

  private deliverBid(c: Extract<Call, { op: "deliver_bid" }>): void {
    const s = this.getSeries(c.series);
    const b = s.bids.get(c.bidder);
    if (!b) fail("BidNotFound", c.bidder);
    if (!b.processed) fail("NotProcessed", c.bidder);
    if (b.delivered) fail("AlreadyDelivered", c.bidder);
    b.delivered = true;
    s.escrowTotal -= b.pendingRefund;
    this.credit(b.bidder, b.pendingRefund);
    if (b.pendingUnits > 0n) {
      s.auction.escrowUnits -= b.pendingUnits;
      this.addUnits(b.bidder, s.id, b.pendingUnits);
    }
    this.emit(s, `BidDelivered ${b.bidder} units=${b.pendingUnits} refund=${b.pendingRefund}`);
  }

  private claimRelease(c: Extract<Call, { op: "claim_release" }>): void {
    const s = this.getSeries(c.series);
    this.requireIssuer(s, c.actor);
    if (s.raiseState !== RaiseState.Settled) fail("RaiseNotSettled");
    if (!s.auction.mintFinalized) fail("MintNotFinalized");
    if (s.treasury.issuerPaused) fail("ReleasesPaused");
    if (this.derivedStatus(s) === SeriesStatus.Late || M.isLateUnderlying(this.clock(s), this.now, this.statusParams(s))) fail("SeriesLate");
    const amount = M.releasable(this.now, s.settlementTs, s.releaseSchedule, s.treasury.proceeds, s.treasury.releasedTotal, s.ledger.extinguishedAt);
    if (amount === 0n) fail("NothingVested");
    s.treasury.balance -= amount;
    s.treasury.releasedTotal += amount;
    this.credit(s.issuer, amount);
    this.emit(s, `ReleaseClaimed amount=${amount} releasedTotal=${s.treasury.releasedTotal}`);
    this.syncStatus(s);
  }

  // ------------------------------------------------------------------------------------------
  // repayment path
  // ------------------------------------------------------------------------------------------

  private async submitReport(c: Extract<Call, { op: "submit_report" }>): Promise<void> {
    const s = this.getSeries(c.series);
    this.requireIssuer(s, c.actor);
    if (s.raiseState !== RaiseState.Settled) fail("RaiseNotSettled");
    const l = s.ledger;
    const period = Number(c.period);
    const paymentUsd = u64(B(c.paymentUsd), "paymentUsd");
    const fxAvgWad = u64(B(c.fxAvgWad), "fxAvgWad");
    const incomeCommitment = bytes32ToField(hexToBytes(c.incomeCommitment));
    const priorSupplied = bytes32ToField(hexToBytes(c.priorIncomeCommitment));

    // 2. preconditions (derived status; nothing stored before the effects phase)
    if (!s.auction.mintFinalized) fail("MintNotFinalized");
    const status = this.derivedStatus(s);
    if (status === SeriesStatus.Retired || status === SeriesStatus.Extinguished) fail("TerminalStatus", SeriesStatus[status]);
    const next = M.nextExpectedPeriod(this.clock(s));
    if (period !== next) fail("WrongPeriod", `expected ${next} got ${period}`);
    if (this.now < periodEnd(period)) fail("ReportTooEarly");
    if (l.openDueAmount > 0n) fail("PaymentOutstanding");
    if (s.reports.has(period)) fail("WrongPeriod", "report already stored");
    const isTail = status === SeriesStatus.Redeemed;
    if (isTail) {
      if (periodStart(period) > l.redemptionTs + this.params.tailSeconds) fail("TailEnded");
      if (c.liquidityEvent && (l.tail.tailCapPerUnit === 0n || l.tail.tailExhausted)) fail("NoTailDue");
    }
    // 3. tier
    if (c.tier < 1 || c.tier > 4 || !tierEnabled(s.tierFlags, c.tier as Tier)) fail("TierNotEnabled", `tier ${c.tier}`);
    if (c.tier === Tier.Tier1Split && s.tierFlags !== 1) fail("TierNotEnabled", "tier 1 is a report tier only for pure tier-1 series");
    if (c.tier === Tier.Tier4Self && !this.flags.tier4Enabled) fail("TierNotEnabled", "tier4 flag off");
    // 4. fx
    let fxFallback = false;
    if (s.fxPairId === null) {
      if (fxAvgWad !== WAD) fail("FxMismatch", "stablecoin income requires fx = WAD");
      if (c.fxFallback) fail("FxFallbackNotAllowed");
    } else {
      const pair = this.fxPairs.get(s.fxPairId)!;
      const qa = M.quarterAverage(pair.state, period, this.params, this.now);
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
    const chained = l.lastIncomePeriod !== null && l.lastIncomePeriod === period - 1 && yearOf(l.lastIncomePeriod) === yearOf(period);
    const firstReport = l.lastAcceptedPeriod === null;
    let prior: bigint;
    if (chained) prior = l.lastIncomeCommitment;
    else if (firstReport && quarterIndex(period) !== 0) prior = priorSupplied;
    else prior = ZERO_INCOME_COMMITMENT;
    if (priorSupplied !== prior) fail("InvalidProof", `prior commitment mismatch`);
    // 6. proof
    const unitsPublic = isTail ? l.unitsAtRedemption : l.unitsOutstanding;
    const expectedSignals = [s.termsCommitment, unitsPublic, fxAvgWad, prior, incomeCommitment, paymentUsd].map(D);
    if (c.publicSignals.length !== 6 || c.publicSignals.some((v, i) => B(v) !== B(expectedSignals[i]!))) {
      fail("InvalidProof", `public signals mismatch: expected ${expectedSignals.join(",")} got ${c.publicSignals.join(",")}`);
    }
    if (this.verifyProofs) {
      const ok = await verifyReport(c.proof as unknown as Groth16Proof, c.publicSignals);
      if (!ok) fail("InvalidProof", "groth16 verification failed");
    }
    // 7. source binding
    if (c.tier === Tier.Tier2Zktls) {
      if (!c.attestation || !this.reportKeyValid(this.verifierKeys.get(c.attestation), period)) fail("InvalidVerifierSignature", c.attestation ?? "none");
    } else if (c.tier === Tier.Tier3Attestor) {
      if (!c.attestation || !this.reportKeyValid(this.attestors.get(c.attestation), period)) fail("InvalidAttestorSignature", c.attestation ?? "none");
    } else if (c.tier === Tier.Tier1Split) {
      const r = s.router!;
      const ytd = M.ytdAtEnd(r, period);
      if (ytd === null) fail("RouterPeriodNotClosed", `period ${period}`);
      if (incomeCommitment !== routerIncomeCommitment(ytd)) fail("InvalidProof", "tier-1 income commitment does not match the router checkpoint");
      if (quarterIndex(period) !== 0) {
        const prevYtd = M.ytdAtEnd(r, period - 1);
        if (prevYtd === null) fail("RouterPeriodNotClosed", `period ${period - 1}`);
        if (prior !== routerIncomeCommitment(prevYtd)) fail("InvalidProof", "tier-1 prior commitment does not match the router checkpoint");
      } else if (prior !== ZERO_INCOME_COMMITMENT) fail("InvalidProof", "tier-1 prior at a year start must be zero");
    }
    // 8. effects
    const creditUsed = l.routerCredit < paymentUsd ? l.routerCredit : paymentUsd;
    l.routerCredit -= creditUsed;
    const due = isTail && !c.liquidityEvent ? 0n : paymentUsd - creditUsed;
    const report: Report = { period, acceptedAt: this.now, paymentUsd, fxAvgWad, fxFallback, tier: c.tier, liquidityEvent: c.liquidityEvent, incomeCommitment, priorIncomeCommitment: prior, due, accrualPaid: 0n, paidAt: null };
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
    }
    this.emit(s, `ReportAccepted period=${period} paymentUsd=${paymentUsd} fx=${fxAvgWad} fallback=${fxFallback} tier=${c.tier} liq=${c.liquidityEvent} due=${due}`);
    this.syncStatus(s);
  }

  private pay(c: Extract<Call, { op: "pay" }>): void {
    const s = this.getSeries(c.series);
    const l = s.ledger;
    if (!s.auction.mintFinalized) fail("MintNotFinalized");
    if (l.openDueAmount === 0n || l.openDuePeriod === null) fail("NothingDue");
    const period = l.openDuePeriod;
    const report = s.reports.get(period)!;
    if (l.status === SeriesStatus.Redeemed) {
      const total = l.openDueAmount;
      this.debit(c.actor, total, "tail payment");
      const { state, result } = M.tailReceive(l.tail, total, l.unitsAtRedemption, s.terms.payoutFeeBps);
      l.tail = state;
      s.vaultBalance += result.accepted - result.fee;
      this.feeCollector += result.fee;
      if (result.refund > 0n) this.credit(s.issuer, result.refund);
      report.paidAt = this.now;
      l.lastPaidPeriod = period;
      l.openDuePeriod = null;
      l.openDueAmount = 0n;
      this.emit(s, `TailDistributed period=${period} gross=${total} accepted=${result.accepted} fee=${result.fee} refunded=${result.refund} exhausted=${result.exhausted}`);
      return;
    }
    const accrual = M.lateAccrual(period, l.openDueAmount, this.clock(s), this.now, this.statusParams(s));
    const total = u64(l.openDueAmount + accrual, "due + accrual");
    this.debit(c.actor, total, "payment");
    const anchor = periodEnd(period) + BigInt(this.params.reportDueDays) * DAY;
    const result = this.vaultReceive(s, total, "Payment", s.issuer, anchor);
    report.accrualPaid = accrual;
    report.paidAt = this.now;
    l.lastPaidPeriod = period;
    l.openDuePeriod = null;
    l.openDueAmount = 0n;
    this.emit(s, `PaymentSettled period=${period} gross=${total} accrual=${accrual} fee=${result.fee} accepted=${result.accepted} refunded=${result.refund}`);
    this.syncStatus(s);
  }

  private submitTrueup(c: Extract<Call, { op: "submit_trueup" }>): void {
    const s = this.getSeries(c.series);
    this.requireIssuer(s, c.actor);
    if (!s.auction.mintFinalized) fail("MintNotFinalized");
    if (!tierEnabled(s.tierFlags, Tier.Tier3Attestor)) fail("TierNotEnabled", "tier 3");
    this.requireActiveAttestor(c.attestor);
    const l = s.ledger;
    const year = Number(c.year);
    const adj = B(c.adjustment);
    if (adj < -(1n << 63n) || adj > (1n << 63n) - 1n) fail("AmountOutOfRange", "adjustment");
    if (l.trueupDue > 0n) fail("TrueUpOutstanding");
    if (l.lastTrueupYear !== null && l.lastTrueupYear >= year) fail("TrueUpYearInvalid", "already trued up");
    if (year >= yearOf(periodOf(this.now))) fail("TrueUpYearInvalid", "year not complete");
    const lastQ = year * 4 + 3;
    for (let p = Math.max(l.firstPeriod, year * 4); p <= lastQ; p++) if (!s.reports.has(p)) fail("TrueUpYearInvalid", `period ${p} unreported`);
    if (adj < 0n) {
      let accepted = 0n;
      for (let p = year * 4; p <= lastQ; p++) accepted += s.reports.get(p)?.paymentUsd ?? 0n;
      if (-adj > accepted) fail("TrueUpAdjustmentTooLarge");
    }
    l.trueupNonce += 1n;
    l.lastTrueupYear = year;
    if (adj > 0n) {
      l.trueupDue = adj;
      l.trueupAttestedAt = u64(B(c.attestationTs), "attestationTs");
      l.trueupYear = year;
      l.trueupNoticeEmitted = false;
    } else if (adj < 0n) {
      l.routerCredit += -adj;
    }
    this.emit(s, `TrueUpRecorded year=${year} adjustment=${adj} nonce=${l.trueupNonce}`);
    this.syncStatus(s);
  }

  private payTrueup(c: Extract<Call, { op: "pay_trueup" }>): void {
    const s = this.getSeries(c.series);
    const l = s.ledger;
    if (!s.auction.mintFinalized) fail("MintNotFinalized");
    if (l.trueupDue === 0n) fail("NothingDue");
    const accrual = M.lateAccrualTrueup(this.clock(s), this.now, this.statusParams(s));
    const total = u64(l.trueupDue + accrual, "trueup + accrual");
    this.debit(c.actor, total, "true-up");
    const result = this.vaultReceive(s, total, "Payment", s.issuer, l.trueupAttestedAt);
    l.trueupDue = 0n;
    l.trueupAttestedAt = 0n;
    l.trueupYear = null;
    this.emit(s, `TrueUpPaid amount=${total} accrual=${accrual} accepted=${result.accepted}`);
    this.syncStatus(s);
  }

  private routeIncome(c: Extract<Call, { op: "route_income" }>): void {
    const s = this.getSeries(c.series);
    if (!s.router) fail("RouterNotEnabled");
    const amount = u64(B(c.amount), "amount");
    this.debit(c.payer, amount, "routed income");
    if (!s.auction.mintFinalized) {
      // receipts accumulate in the router's receiving account until the mint is final
      s.routerBalance += amount;
      s.router = { ...s.router, heldBeforeFinalization: s.router.heldBeforeFinalization + amount };
      this.emit(s, `IncomeHeld amount=${amount} held=${s.router.heldBeforeFinalization}`);
      return;
    }
    if (M.isTerminal(s.ledger.status)) fail("TerminalStatus");
    const total = amount + s.routerBalance;
    s.routerBalance = 0n;
    const r = M.routeIncome(s.router, total, s.ledger.unitsOutstanding, this.now);
    s.router = { ...r.state, heldBeforeFinalization: 0n };
    this.credit(s.issuer, r.passThrough);
    if (r.share > 0n) {
      const result = this.vaultReceive(s, r.share, "Router", s.issuer, this.now);
      s.ledger.routerCredit += result.accepted;
    }
    this.emit(s, `IncomeRouted amount=${total} passThrough=${r.passThrough} routed=${r.share} ytd=${s.router.ytdReceived}`);
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
    const end = u64(B(c.pauseEnd), "pauseEnd");
    const err = M.pauseApprovalError(l.pauses, l.pausedTotal, this.now, end, this.params);
    if (err) fail(err);
    l.pauses.push({ start: this.now, end });
    l.pausedTotal += end - this.now;
    l.pauseRequested = false;
    this.emit(s, `PauseApproved start=${this.now} end=${end} attestor=${c.attestor}`);
    this.syncStatus(s);
  }

  // ------------------------------------------------------------------------------------------
  // fx
  // ------------------------------------------------------------------------------------------

  private fxSnapshot(c: Extract<Call, { op: "fx_snapshot" }>): void {
    const pair = this.fxPairs.get(c.pairId.toLowerCase());
    if (!pair) fail("UnknownFxPair", c.pairId);
    // once per UTC day (the day requirement precedes the price validation in SPEC §6.6)
    if (this.now / DAY <= pair.state.lastDay) fail("SnapshotAlreadyTaken");
    const price = { price: B(c.price), conf: B(c.conf), expo: c.expo, publishTime: B(c.publishTime) };
    const bad = M.validatePythPrice(price, this.now, this.params);
    if (bad === "StalePrice" || bad === "NonPositivePrice") fail("StalePrice", bad);
    if (bad === "ConfidenceTooWide") fail("ConfidenceTooWide");
    let rate = M.normalizePythPrice(price.price, price.expo);
    if (pair.inverted) rate = M.invertRate(rate);
    let cross: bigint | null = null;
    if (pair.crosscheck && c.crosscheckPrice !== undefined && periodOf(this.now) >= pair.crosscheckEffectivePeriod) {
      cross = M.normalizePythPrice(B(c.crosscheckPrice), c.crosscheckExpo ?? c.expo);
      if (pair.inverted) cross = M.invertRate(cross);
    }
    const r = M.snapshot(pair.state, this.now, rate, cross, this.params);
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
    if (!s.auction.mintFinalized) fail("MintNotFinalized");
    const l = s.ledger;
    const status = this.derivedStatus(s);
    if (M.isTerminal(status)) fail("TerminalStatus");
    if (status === SeriesStatus.Late) fail("SeriesLate");
    if (this.now < s.settlementTs + s.terms.lockupSeconds) fail("LockupActive");
    if (l.openDueAmount > 0n) fail("PaymentOutstanding");
    if (l.trueupDue > 0n) fail("TrueUpOutstanding");
    const lastEnded = periodOf(this.now) - 1;
    if (!(lastEnded < l.firstPeriod || (l.lastAcceptedPeriod !== null && l.lastAcceptedPeriod >= lastEnded))) fail("UnreportedPeriods");
    const q = M.redemptionQuote({
      p0: s.auction.clearingPrice,
      hurdleRateWad: s.terms.hurdleRateWad,
      payoutMultipleK: s.terms.payoutMultipleK,
      t: this.now - s.settlementTs,
      capPerUnit: this.capPerUnit(s),
      paidPerUnitWad: s.vault.paidPerUnitWad,
      yearGross: s.vault.yearGross,
      unitsOutstanding: l.unitsOutstanding,
    });
    this.syncStatus(s);
    if (q.cRemaining === 0n) {
      this.retire(s, 0n);
      this.emit(s, "redeem: C_rem == 0 → retired instead");
      return;
    }
    u64(q.deposit, "deposit");
    this.debit(c.actor, q.deposit, "redemption deposit");
    s.vaultBalance += q.deposit;
    l.status = SeriesStatus.Redeemed;
    l.redemptionTs = this.now;
    l.redemptionPrice = q.pRedeem;
    l.unitsAtRedemption = l.unitsOutstanding;
    l.tail = M.newTailState(q.tailCapPerUnit);
    this.emit(s, `SeriesRedeemed price=${q.pRedeem} hurdle=${q.pHurdle} dAvg=${q.dAvg ?? "none"} capRemaining=${q.cRemaining} units=${l.unitsOutstanding} deposit=${q.deposit} decidedBy=${q.decidedBy}`);
  }

  /** Delivers a pending auction allocation to its bidder (used before redemption/final claims). */
  private deliverPending(s: SeriesState, actor: string): void {
    const b = s.bids.get(actor);
    if (b && b.processed && !b.delivered) this.deliverBid({ op: "deliver_bid", series: s.id, bidder: actor });
  }

  private claimRedemptionBody(s: SeriesState, actor: string): { units: bigint; amount: bigint } {
    const l = s.ledger;
    this.deliverPending(s, actor);
    const h = this.settleHolder(s, actor);
    const units = this.unitsOf(actor, s.id);
    if (units > 0n && h.redeemedUnits === 0n) h.redeemedUnits = units;
    else if (units > 0n) h.redeemedUnits += units;
    const amount = h.pending + l.redemptionPrice * units;
    h.pending = 0n;
    this.burn(s, actor, units, "Redeemed");
    if (amount > s.vaultBalance) throw new Error("vault underflow in redemption");
    s.vaultBalance -= amount;
    this.credit(actor, amount);
    return { units, amount };
  }

  private claimRedemption(c: Extract<Call, { op: "claim_redemption" }>): void {
    const s = this.getSeries(c.series);
    const l = s.ledger;
    if (l.redemptionTs === 0n || (l.status !== SeriesStatus.Redeemed && l.status !== SeriesStatus.Extinguished)) fail("NotRedeemed");
    const { units, amount } = this.claimRedemptionBody(s, c.actor);
    this.emit(s, `RedemptionClaimed ${c.actor} units=${units} amount=${amount}`);
  }

  private claimTail(c: Extract<Call, { op: "claim_tail" }>): void {
    const s = this.getSeries(c.series);
    const l = s.ledger;
    if (l.redemptionTs === 0n) fail("NotRedeemed");
    const h = s.holders.get(c.actor);
    if (!h || !h.registered) fail("HolderNotRegistered", c.actor);
    if (h.redeemedUnits === 0n && this.accrualUnits(s, c.actor) > 0n) this.claimRedemptionBody(s, c.actor);
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
    if (!s.auction.mintFinalized) fail("MintNotFinalized");
    const l = s.ledger;
    if (l.status === SeriesStatus.Extinguished) fail("TerminalStatus", "already Extinguished");
    const wasRedeemed = l.status === SeriesStatus.Redeemed;
    const finalUnits = wasRedeemed ? l.unitsAtRedemption : l.unitsOutstanding;
    const vestedNow = M.vested(this.now, s.settlementTs, s.releaseSchedule, s.treasury.proceeds);
    const unreleased = s.treasury.proceeds - vestedNow;
    this.syncStatus(s);
    if (unreleased > 0n) {
      s.treasury.balance -= unreleased;
      s.vaultBalance += unreleased;
    }
    l.final = M.finalDistribute(l.final, unreleased, finalUnits).state;
    l.status = SeriesStatus.Extinguished;
    l.extinguishedAt = this.now;
    l.openDuePeriod = null;
    l.openDueAmount = 0n;
    l.trueupDue = 0n;
    l.trueupAttestedAt = 0n;
    l.extinguishNonce += 1n;
    this.emit(s, `SeriesExtinguished unreleased=${unreleased} finalUnits=${finalUnits} attestors=${a},${b}${wasRedeemed ? " (tail ended)" : ""}`);
  }

  private claimFinal(c: Extract<Call, { op: "claim_final" }>): void {
    const s = this.getSeries(c.series);
    const l = s.ledger;
    if (l.status !== SeriesStatus.Extinguished) fail("TerminalStatus", "not Extinguished");
    this.deliverPending(s, c.actor);
    let h = this.settleHolder(s, c.actor);
    let weight: bigint;
    if (l.redemptionTs !== 0n) {
      // an unredeemed balance is redeemed first (pays P_redeem × balance), then weight = redeemed units
      if (this.unitsOf(c.actor, s.id) > 0n) this.claimRedemptionBody(s, c.actor);
      h = s.holders.get(c.actor)!;
      weight = h.redeemedUnits;
    } else {
      weight = this.accrualUnits(s, c.actor);
    }
    const finalAmount = h.finalClaimed ? 0n : M.settleHolderDelta(l.final.finalAccWad, h.lastFinalAccWad, weight);
    h.lastFinalAccWad = l.final.finalAccWad;
    h.finalClaimed = true;
    const amount = h.pending + finalAmount;
    h.pending = 0n;
    const burned = this.unitsOf(c.actor, s.id);
    this.burn(s, c.actor, burned, "Extinguished");
    if (amount > s.vaultBalance) throw new Error("vault underflow in final claim");
    s.vaultBalance -= amount;
    this.credit(c.actor, amount);
    this.emit(s, `FinalClaimed ${c.actor} units=${weight} amount=${amount}`);
  }

  // ------------------------------------------------------------------------------------------
  // transfer window
  // ------------------------------------------------------------------------------------------

  private windowRules(s: SeriesState): M.WindowRules {
    return { unitsOutstanding: s.ledger.unitsOutstanding, walletCapBps: s.terms.walletCapBps, windowFeeBps: s.terms.windowFeeBps };
  }

  private openWindow(c: Extract<Call, { op: "open_window" }>): void {
    const s = this.getSeries(c.series);
    if (!this.flags.windowsEnabled) fail("WindowsDisabled");
    if (s.raiseState !== RaiseState.Settled) fail("RaiseNotSettled");
    if (!s.auction.mintFinalized) fail("MintNotFinalized");
    const status = this.derivedStatus(s);
    if (status !== SeriesStatus.OnTime && status !== SeriesStatus.InGrace) fail("WindowNotEligible", `status ${SeriesStatus[status]}`);
    if (this.now < s.settlementTs + s.terms.lockupSeconds) fail("LockupActive");
    const period = Number(c.period);
    if (s.ledger.lastPaidPeriod === null || s.ledger.lastPaidPeriod < period) fail("WindowNotEligible", `period ${period} not paid`);
    if (period !== periodOf(this.now) - 1) fail("WindowNotEligible", `period ${period} is not the previous quarter`);
    if (s.window && s.window.state !== "Done") fail("WindowOpen");
    this.syncStatus(s);
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
      tallyRound: 0,
      roundRejected: false,
      proposal: undefined,
      clearing: null,
    };
    this.emit(s, `WindowOpened period=${period} commitEnd=${s.window.commitEnd} revealEnd=${s.window.revealEnd}`);
  }

  private commitOrder(c: Extract<Call, { op: "commit_ask" | "window_commit_bid" }>): void {
    const s = this.getSeries(c.series);
    const w = s.window;
    if (!w || w.state !== "Commit" || this.now >= w.commitEnd) fail("WindowNotOpen");
    if (w.orders.some((o) => o.owner === c.actor)) fail("OrderExists", c.actor);
    const side = c.op === "commit_ask" ? 1 : 0;
    let escrow: bigint;
    if (c.op === "commit_ask") {
      escrow = u64(B(c.units), "units");
      if (escrow <= 0n || this.unitsOf(c.actor, s.id) < escrow) fail("InsufficientUnits", c.actor);
      this.settleHolder(s, c.actor);
      this.addUnits(c.actor, s.id, -escrow);
      w.escrowUnits += escrow;
    } else {
      if (!this.allowlist.has(c.actor)) fail("NotAllowlisted", c.actor);
      escrow = u64(B(c.escrow), "escrow");
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
    if (!w || (w.state !== "Commit" && w.state !== "Reveal")) fail("WindowNotOpen");
    if (this.now < w.commitEnd || this.now >= w.revealEnd) fail("RevealPhaseClosed");
    w.state = "Reveal";
    const o = w.orders.find((x) => x.owner === c.actor);
    if (!o) fail("BidNotFound", c.actor);
    if (o.revealed) fail("AlreadyRevealed", c.actor);
    if (o.price !== B(c.price) || o.quantity !== B(c.quantity) || o.salt !== c.salt.toLowerCase()) fail("CommitmentMismatch", c.actor);
    o.revealed = true;
    o.revealIndex = w.revealed++;
    o.valid = M.isOrderValid(o.side, o.price, o.quantity, o.escrow, this.unitsOf(c.actor, s.id), this.windowRules(s));
    this.emit(s, `OrderRevealed ${c.actor} side=${o.side === 1 ? "Ask" : "Bid"} price=${o.price} qty=${o.quantity} valid=${o.valid}`);
  }

  private beginWindowSettlement(c: Extract<Call, { op: "begin_window_settlement" }>): void {
    const s = this.getSeries(c.series);
    const w = s.window;
    if (!w || (w.state !== "Commit" && w.state !== "Reveal" && w.state !== "Settling")) fail("WindowNotOpen");
    if (this.now < w.revealEnd) fail("SettlementNotReady");
    if (!(w.tallyRound === 0 || w.roundRejected)) fail("TallyInProgress");
    w.proposal = c.clearingPrice === "NO_MATCH" ? null : u64(B(c.clearingPrice), "clearingPrice");
    w.tallyRound += 1;
    w.roundRejected = false;
    w.state = "Settling";
    this.emit(s, `WindowSettlementProposed p=${w.proposal === null ? "NO_MATCH" : w.proposal} round=${w.tallyRound}`);
  }

  private finalizeWindow(c: Extract<Call, { op: "finalize_window" }>): void {
    const s = this.getSeries(c.series);
    const w = s.window;
    if (!w || w.state !== "Settling" || w.proposal === undefined || w.roundRejected) fail("WindowNotOpen", "no settlement round");
    const t = M.tallyOrders(w.orders, w.proposal);
    const f = M.finalizeWindow(t, w.proposal);
    if (f.kind === "rejected") {
      w.roundRejected = true;
      this.emit(s, `WindowSettlementRejected period=${w.period} p=${w.proposal === null ? "NO_MATCH" : w.proposal} reason=${f.reason}`);
      return;
    }
    if (f.kind === "nomatch") {
      w.state = "NoMatch";
      this.emit(s, `WindowNoMatch period=${w.period}`);
      return;
    }
    w.clearing = f.clearing;
    w.state = "Settled";
    this.emit(s, `WindowCleared period=${w.period} p=${f.clearing.clearingPrice} matched=${f.clearing.matchedUnits} branch=${f.clearing.branch}`);
  }

  private processOrders(c: Extract<Call, { op: "process_orders" }>): void {
    const s = this.getSeries(c.series);
    const w = s.window;
    if (!w || (w.state !== "Settled" && w.state !== "NoMatch")) fail("WindowNotOpen");
    if (w.state === "NoMatch") {
      for (const o of w.orders) {
        if (o.side === 1) {
          this.settleHolder(s, o.owner);
          o.processed = true;
          this.addUnits(o.owner, s.id, o.escrow);
          w.escrowUnits -= o.escrow;
        } else {
          this.credit(o.owner, o.escrow);
          w.escrowStable -= o.escrow;
          o.processed = true;
        }
        this.emit(s, `OrderFilled ${o.owner} side=${o.side === 1 ? "Ask" : "Bid"} fill=0 refund=${o.escrow}`);
      }
      w.state = "Done";
      return;
    }
    const cl = w.clearing!;
    const fills = M.computeFills(w.orders, cl, s.terms.windowFeeBps, (owner) => this.allowlist.has(owner));
    // buyers pay first (their escrow funds the sellers)
    for (const [i, o] of w.orders.entries()) {
      const f = fills[i]!;
      if (o.side !== 0) continue;
      this.feeCollector += f.fee;
      this.credit(o.owner, f.refund);
      w.escrowStable -= f.fee + f.refund;
    }
    // sellers: settle accrual before their ask-escrow units leave the accounting, then pay and return
    for (const [i, o] of w.orders.entries()) {
      const f = fills[i]!;
      if (o.side !== 1) continue;
      this.settleHolder(s, o.owner);
      o.processed = true;
      this.credit(o.owner, f.cost);
      w.escrowStable -= f.cost;
      this.addUnits(o.owner, s.id, f.refund);
      w.escrowUnits -= f.refund;
      this.emit(s, `OrderFilled ${o.owner} side=Ask fill=${f.fill} price=${cl.clearingPrice} refund=${f.refund}`);
    }
    // buyers receive units
    for (const [i, o] of w.orders.entries()) {
      const f = fills[i]!;
      if (o.side !== 0) continue;
      if (f.fill > 0n) {
        this.registerHolder(s, o.owner);
        this.settleHolder(s, o.owner);
        this.addUnits(o.owner, s.id, f.fill);
        w.escrowUnits -= f.fill;
      }
      o.processed = true;
      this.emit(s, `OrderFilled ${o.owner} side=Bid fill=${f.fill} price=${cl.clearingPrice} fee=${f.fee} refund=${f.refund}${f.cancelled ? " CANCELLED" : ""}`);
    }
    if (w.escrowUnits !== 0n) throw new Error(`window units not conserved: ${w.escrowUnits}`);
    if (w.escrowStable !== 0n) throw new Error(`window stablecoin not conserved: ${w.escrowStable}`);
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
      mintFinalized: s.auction.mintFinalized,
      unitsOutstanding: D(l.unitsOutstanding),
      unitsSold: D(s.auction.unitsSold),
      clearingPrice: D(s.auction.clearingPrice),
      proceeds: D(s.treasury.proceeds),
      releasedTotal: D(s.treasury.releasedTotal),
      capPerUnit: D(s.raiseState === RaiseState.Settled ? this.capPerUnit(s) : 0n),
      capMultipleWad: D(s.capMultipleWad),
      termsCommitment: H(fieldToBytes32(s.termsCommitment)),
      amendmentNonce: D(s.amendmentNonce),
      paidPerUnitWad: D(s.vault.paidPerUnitWad),
      netAccWad: D(s.vault.netAccWad),
      carryWad: D(s.vault.carryWad),
      carry: D(s.vault.carryWad / WAD),
      grossReceived: D(s.vault.grossReceived),
      feeCollected: D(s.vault.feeCollected),
      refundedToIssuer: D(s.vault.refundedToIssuer),
      lastAcceptedPeriod: l.lastAcceptedPeriod === null ? null : D(l.lastAcceptedPeriod),
      lastPaidPeriod: l.lastPaidPeriod === null ? null : D(l.lastPaidPeriod),
      openDuePeriod: l.openDuePeriod === null ? null : D(l.openDuePeriod),
      openDueAmount: D(l.openDueAmount),
      routerCredit: D(l.routerCredit),
      trueupNonce: D(l.trueupNonce),
      trueupDue: D(l.trueupDue),
      pauseNonce: D(l.pauseNonce),
      pauseCount: D(l.pauses.length),
      pausedTotal: D(l.pausedTotal),
      formalNoticeEmittedFor: l.formalNoticeEmittedFor === null ? null : D(l.formalNoticeEmittedFor),
      redemptionPrice: D(l.redemptionPrice),
      unitsAtRedemption: D(l.unitsAtRedemption),
      tailCapPerUnit: D(l.tail.tailCapPerUnit),
      tailAccWad: D(l.tail.tailAccWad),
      tailExhausted: l.tail.tailExhausted,
      extinguishedAt: D(l.extinguishedAt),
      finalAccWad: D(l.final.finalAccWad),
      finalUnits: D(l.final.finalUnits),
      extinguishNonce: D(l.extinguishNonce),
    };
  }

  auctionExpect(s: SeriesState): AuctionExpect {
    const a = s.auction;
    return {
      bidCount: D(s.bids.size),
      revealedCount: D(s.revealedCount),
      validCount: D(a.validCount),
      escrowTotal: D(s.escrowTotal),
      auctionEscrowUnits: D(a.escrowUnits),
      tallyRound: D(a.tallyRound),
      roundRejected: a.roundRejected,
      rejectionReason: a.rejectionReason,
      clearingPrice: D(a.clearingPrice),
      qAbove: D(a.qAbove),
      qAt: D(a.qAt),
      R: D(a.R),
      unitsSold: D(a.unitsSold),
      proceeds: D(a.proceeds),
      unitsMinted: D(a.unitsMinted),
      bidsProcessed: D(a.bidsProcessed),
      mintFinalized: a.mintFinalized,
    };
  }

  windowExpect(w: WindowState): WindowExpect {
    return {
      period: D(w.period),
      state: w.state,
      tallyRound: D(w.tallyRound),
      roundRejected: w.roundRejected,
      clearingPrice: w.clearing ? D(w.clearing.clearingPrice) : null,
      branch: w.clearing ? w.clearing.branch : null,
      matchedUnits: D(w.clearing?.matchedUnits ?? 0n),
      escrowStable: D(w.escrowStable),
      escrowUnits: D(w.escrowUnits),
    };
  }

  fxExpect(pairId: string, periods: number[]): FxExpect {
    const pair = this.fxPairs.get(pairId.toLowerCase());
    if (!pair) throw new Error(`unknown pair ${pairId}`);
    const quarters: FxExpect["quarters"] = {};
    for (const p of periods) {
      const qa = M.quarterAverage(pair.state, p, this.params, this.now);
      quarters[D(p)] = { ok: qa.ok, avgWad: qa.avgWad === null ? null : D(qa.avgWad), n: D(qa.n), flagged: qa.flagged };
    }
    return { sumWad: D(pair.state.sumWad), count: D(pair.state.count), quarters };
  }

  /** Full `expect` snapshot: every funded actor's balances plus the series' money and ledger views. */
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
        out.window = this.windowExpect(s.window);
      }
      out.ledger = this.ledgerExpect(s);
      out.auction = this.auctionExpect(s);
      const holders: Record<string, HolderExpect> = {};
      for (const [name, h] of [...s.holders.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!h.registered) continue;
        const bid = s.bids.get(name);
        holders[name] = {
          pending: D(h.pending),
          redeemedUnits: D(h.redeemedUnits),
          pendingUnits: D(bid && bid.processed && !bid.delivered ? bid.pendingUnits : 0n),
          pendingRefund: D(bid && bid.processed && !bid.delivered ? bid.pendingRefund : 0n),
          delivered: bid ? bid.delivered : true,
        };
      }
      out.holders = holders;
    }
    if (opts.fx) {
      out.fx = {};
      for (const [pairId, periods] of Object.entries(opts.fx)) out.fx[pairId] = this.fxExpect(pairId, periods);
    }
    return out;
  }

  /** Deterministic serialization of the whole state (revert-atomicity checks and tests). */
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
      { now: this.now, flags: this.flags, allowlist: this.allowlist, issuers: this.issuers, attestors: this.attestors, verifierKeys: this.verifierKeys, feeCollector: this.feeCollector, accounts, series, fxPairs: this.fxPairs },
      replacer,
    );
  }

  /** Σ stablecoin across every account and pool — constant apart from `fund` steps. */
  totalStable(): bigint {
    let total = this.feeCollector;
    for (const a of this.accounts.values()) total += a.stable;
    for (const s of this.series.values()) total += s.treasury.balance + s.vaultBalance + s.escrowTotal + s.routerBalance + (s.window?.escrowStable ?? 0n);
    return total;
  }

  /** Holder balances + auction escrow + window escrow equal the stored supply (after mint finalization). */
  checkUnitSupply(seriesId: string): void {
    const s = this.getSeries(seriesId);
    let total = (s.window?.escrowUnits ?? 0n) + s.auction.escrowUnits;
    for (const a of this.accounts.values()) total += a.units.get(seriesId) ?? 0n;
    const expected = s.auction.mintFinalized ? s.ledger.unitsOutstanding : s.auction.unitsMinted;
    if (total !== expected) throw new Error(`unit supply mismatch for ${seriesId}: ${total} != ${expected}`);
  }
}

