import type { LifecycleStatus, RaisePhase, Stablecoin } from '@merces/domain';
import type { FinalState, Pause, TailState, VaultState as Stage1VaultState } from '@merces/math';
import type { PersonalityConfig } from './addresses.ts';

/**
 * Internal simulator state. bigint everywhere money or ratios appear.
 *
 * Version 2 (S1) carries Stage 1's own state objects beside ours: the series ledger (`SimLedger`, Stage 1's field
 * names), the payout vault, the tail and the final pool (Stage 1 types from `@merces/reference`). Fields marked
 * `@deprecated` are the version-1 bookkeeping the named work package stops using; WP13 deletes them.
 */
export const SIM_STATE_VERSION = 2;

/** A persisted simulator state from another layout. Version 1 (before S1) is never upgraded in place: reset it. */
export class SimStateVersionError extends Error {
  constructor(readonly found: unknown) {
    super(`simulator state version ${String(found ?? 1)} is not supported (this build needs version ${SIM_STATE_VERSION}); reset the simulator chains with \`pnpm --filter @merces/simulator sim:reset\` (RUNBOOK.md)`);
    this.name = 'SimStateVersionError';
  }
}

export interface SimTerms {
  stablecoin: Stablecoin;
  stablecoinMint: string;
  unitsOffered: bigint;
  reservePrice: bigint;
  minimumRaise: bigint;
  capMultipleWad: bigint;
  lockupSeconds: number;
  releaseSchedule: { afterSeconds: number; bps: number }[];
  auctionFeeBps: bigint;
  payoutFeeBps: bigint;
  hurdleWad: bigint;
  payoutMultipleK: bigint;
  walletCapBps: bigint;
  dueDays: number;
  graceDays: number;
  formalNoticeDays: number;
  contractHash: string;
  termsCommitment: string;
  tierFlags: { tier1: boolean; tier2: boolean; tier3: boolean; tier4: boolean };
  reportingCurrency: string;
  raiseStyle: 'sealed' | 'curve';
}

export interface SimBid {
  bidder: string;
  commitment: string;
  deposit: bigint;
  order: number;
  revealed: { pricePerUnit: bigint; quantity: bigint } | null;
  allocatedUnits: bigint;
  /** set at settlement; claimRefund pays it out */
  refundable: bigint;
  refunded: bigint;
  settled: boolean;
}

export interface SimPosition {
  wallet: string;
  units: bigint;
  /** units held back for an open transfer-window sell order; they stay in `units` for payout accounting */
  escrowed: bigint;
  /** @deprecated WP5 (the claim cursor is `lastNetAccWad`; no longer read or written) */
  rewardDebt: bigint;
  /** payouts settled into a pending balance on unit changes (burn, transfer) */
  pending: bigint;
  claimedTotal: bigint;
  redeemedUnits: bigint;
  /** @deprecated WP6 (the tail cursor becomes `lastTailAccWad`) */
  tailDebt: bigint;
  /** @deprecated WP6 */
  redemptionClaimed: boolean;
  // ---- Stage 1 holder record (SIM:82-90); set by `registerHolder` (SIM:406-416)
  registered: boolean;
  /** `vault.netAccWad` at the holder's last settlement */
  lastNetAccWad: bigint;
  /** tail and final cursors start at 0, not at the live accumulators (Stage 1 C-S20) */
  lastTailAccWad: bigint;
  lastFinalAccWad: bigint;
  finalClaimed: boolean;
}

export interface SimPeriod {
  periodId: string;
  /** Stage 1's period id (year × 4 + quarter − 1; 2026Q1 = 8104) */
  pid: number;
  reportAccepted: boolean;
  tier: number | null;
  paymentStable: bigint;
  /**
   * owed before lateness (payment minus split receipts, or the tail amount)
   * @deprecated WP4 and WP5 (the ledger's `openDueAmount` and the report's `due`)
   */
  outstanding: bigint;
  /** @deprecated WP4 and WP5 (accrual is computed at pay time; `accrualPaid` records it) */
  accrual: bigint;
  paymentDue: bigint;
  paid: bigint;
  splitReceived: bigint;
  settled: boolean;
  incomeCommitment: string | null;
  /** the previous report's income commitment this report chains from (Stage 1 prior chain); null until reported */
  priorIncomeCommitment: string | null;
  /** the due the report set, before lateness accrual (Stage 1 `Report.due`) */
  due: bigint;
  /** lateness accrual paid with the due (Stage 1 `Report.accrualPaid`) */
  accrualPaid: bigint;
  paidAt: number | null;
  liquidityEvent: boolean;
  /** @deprecated WP4 (the ledger's `formalNoticeEmittedFor`) */
  formalNoticeEmitted: boolean;
  acceptedAt: number | null;
  isTail: boolean;
}

export interface SimTranche {
  index: number;
  afterSeconds: number;
  bps: number;
  amount: bigint;
  drawn: boolean;
  /** returned to holders through the final pool at extinguishment (unvested) */
  returned: boolean;
}

export interface SimRedemption {
  openedAt: number;
  pricePerUnit: bigint;
  unitsAtRedemption: bigint;
  deposit: bigint;
  claimed: bigint;
  tailCapPerUnit: bigint;
  tailEndsAt: number;
  /** @deprecated WP6 (`SimSeries.tail.tailPaidPerUnitWad`) */
  tailPaidPerUnit: bigint;
  /** @deprecated WP6 (`SimSeries.tail.tailAccWad`) */
  accTailNetWad: bigint;
}

export interface SimWindowOrder {
  wallet: string;
  side: 'buy' | 'sell';
  commitment: string;
  deposit: bigint;
  escrowedUnits: bigint;
  order: number;
  revealed: { pricePerUnit: bigint; quantity: bigint } | null;
}

export interface SimTransferWindow {
  windowId: number;
  commitEndsAt: number;
  revealEndsAt: number;
  cleared: boolean;
  clearingPrice: bigint | null;
  orders: Map<string, SimWindowOrder>;
}

export interface SimCurve {
  quoteStablecoin: Stablecoin;
  raised: bigint;
  basePrice: bigint;
  slopeWad: bigint;
  graduationThreshold: bigint;
  graduated: boolean;
}

/**
 * The series ledger, in Stage 1's field names (SIM:147-177). Status itself stays on `SimSeries.status` (the stored
 * status; the derived one comes from `engine/ledger.ts`), units outstanding on `SimSeries.unitsOutstanding`, the
 * redemption on `SimSeries.redemption` and the extinguishment time on `SimSeries.extinguishedAt`. Periods are
 * Stage 1 period ids (2026Q1 = 8104); times are unix seconds as bigint, like Stage 1's.
 */
export interface SimLedger {
  /** `periodOf(settlement)`; null before the raise settles (Stage 1 keeps 0) */
  firstPeriod: number | null;
  lastAcceptedPeriod: number | null;
  lastPaidPeriod: number | null;
  openDuePeriod: number | null;
  openDueAmount: bigint;
  /** the income commitment the next report must chain from; starts at Poseidon(0, 0) */
  lastIncomeCommitment: string;
  lastIncomePeriod: number | null;
  /** approved hardship pauses `{start, end}` (an early end shortens `end`) */
  pauses: Pause[];
  /** Σ approved pause lengths */
  pausedTotal: bigint;
  pauseNonce: bigint;
  pauseRequested: boolean;
  pauseRequestedAt: bigint;
  /**
   * The end the issuer asked for in `requestPause.until`. Advisory only: stored and emitted, never enforced onchain
   * (Stage 1's request has no end); the attestor service holds the approval to it offchain.
   */
  pauseRequestedUntil: bigint | null;
  /** how many recorded pauses have had their `PauseEnded` event emitted */
  pauseEndedEmitted: number;
  formalNoticeEmittedFor: number | null;
  /** releases are blocked because the series is (or underlies) Late; drives the ReleasesPaused/Resumed events */
  releasesBlockedLate: boolean;
  amendmentNonce: bigint;
  extinguishNonce: bigint;
  // router and true-up (tier 1 and tier 3 annual true-up): fixed at 0 / null until S5
  routerCredit: bigint;
  trueupNonce: bigint;
  trueupDue: bigint;
  trueupAttestedAt: bigint;
  lastTrueupYear: number | null;
}

export interface SimSeries {
  seriesId: string;
  address: string;
  issuer: string;
  terms: SimTerms;
  phase: RaisePhase;
  status: LifecycleStatus;
  createdAt: number;
  openedAt: number | null;
  commitEndsAt: number | null;
  revealEndsAt: number | null;
  settledAt: number | null;
  issuePrice: bigint | null;
  unitsSold: bigint;
  unitsOutstanding: bigint;
  capPerUnit: bigint | null;
  /**
   * @deprecated WP5 (`vault.paidPerUnitWad`). Kept equal to it by `vaultReceive` only for the version-1 redemption
   * quote, until WP6 moves the quote to Stage 1's `redemptionQuote`.
   */
  paidPerUnitWad: bigint;
  /** @deprecated WP5 (`vault.netAccWad`; no longer read or written) */
  accNetWad: bigint;
  vaultBalance: bigint;
  /** @deprecated WP5 (`vault.grossReceived`; the API vault totals are `grossPaidTotal`/`feesTotal`). Only the tail (WP6) still adds to it. */
  vaultGrossTotal: bigint;
  /** @deprecated WP5 (`vault.feeCollected`; see `vaultGrossTotal`) */
  vaultFeesTotal: bigint;
  vaultDistributedNet: bigint;
  treasuryTotal: bigint;
  treasuryReleased: bigint;
  /** unvested treasury returned to holders at extinguishment */
  treasuryReturned: bigint;
  tranches: SimTranche[];
  releasesPausedByIssuer: boolean;
  /** @deprecated WP4 (`ledger.releasesBlockedLate`) */
  releasesPausedLate: boolean;
  bids: Map<string, SimBid>;
  bidOrder: number;
  positions: Map<string, SimPosition>;
  periods: Map<string, SimPeriod>;
  /** @deprecated WP4 (`ledger.pauses`, `ledger.pauseRequested`, `ledger.pauseRequestedUntil`) */
  pause: { requestedUntil: number | null; approvedUntil: number | null; startedAt: number | null } | null;
  /** @deprecated WP4 (`ledger.pauses`) */
  pauseIntervals: { from: number; to: number }[];
  /** @deprecated WP4 (`ledger.pausedTotal`) */
  pausedSecondsTotal: number;
  redemption: SimRedemption | null;
  extinguishedAt: number | null;
  /**
   * gross accepted per settlement-year index (0 = first year after settlement), for D_avg
   * @deprecated WP5 (`vault.yearGross`). Still filled by `vaultReceive` for the version-1 redemption quote until WP6.
   */
  grossByYear: Map<number, bigint>;
  /** life-to-date gross the vault accepted (regular, split and tail payments; not an extinguishment return): the API vault total */
  grossPaidTotal: bigint;
  /** life-to-date payout fees (regular, split and tail) */
  feesTotal: bigint;
  transferWindows: SimTransferWindow[];
  curve: SimCurve | null;
  splitRouter: string | null;
  amendments: { at: number; termsCommitment: string; capMultipleWad: bigint; attestor: string }[];
  // ---- Stage 1 state (types from @merces/reference)
  ledger: SimLedger;
  /** payout vault (SPEC v1.1 §6.3); `vaultBalance` stays the stablecoin it holds */
  vault: Stage1VaultState;
  /** tail clause after a redemption (SPEC v1.1 §6.8) */
  tail: TailState;
  /** final pool after an extinguishment (SPEC v1.1 §6.9) */
  final: FinalState;
}

export interface SimIssuer {
  issuer: string;
  registeredAt: number;
  issuanceStopped: boolean;
  seriesIds: string[];
}

export interface SimRateAccumulator {
  pair: string;
  sumWad: bigint;
  count: number;
  /** per day snapshots, ascending by dayIndex */
  days: { dayIndex: number; rateWad: bigint; cumSumWad: bigint; cumCount: number }[];
}

export interface SimState {
  /** layout version; persisted states of another version are refused (see `deserialiseState`) */
  version: typeof SIM_STATE_VERSION;
  config: PersonalityConfig;
  admin: string;
  feeCollector: string;
  keeper: string;
  allowlistManager: string;
  newRaisesPaused: boolean;
  seq: number;
  txCount: number;
  balances: Map<string, bigint>;
  allowlist: Set<string>;
  attestors: Map<string, boolean>;
  verifierKeys: Map<string, { publicKey: string; active: boolean }>;
  issuers: Map<string, SimIssuer>;
  series: Map<string, SimSeries>;
  rates: Map<string, SimRateAccumulator>;
  fxFallbacks: Map<string, 'coverage' | 'deviation'>;
}

// ---- serialisation (bigint, Map, Set) for persistence and snapshots ----
export function serialiseState(s: SimState): string {
  return JSON.stringify(s, (_k, v) => {
    if (typeof v === 'bigint') return { $big: v.toString() };
    if (v instanceof Map) return { $map: [...v.entries()] };
    if (v instanceof Set) return { $set: [...v.values()] };
    return v;
  });
}

/** Parse a persisted state. Throws `SimStateVersionError` unless it is version 2: version-1 states are never upgraded. */
export function deserialiseState(json: string): SimState {
  const state = JSON.parse(json, (_k, v) => {
    if (v && typeof v === 'object') {
      if ('$big' in v && typeof v.$big === 'string') return BigInt(v.$big);
      if ('$map' in v && Array.isArray(v.$map)) return new Map(v.$map);
      if ('$set' in v && Array.isArray(v.$set)) return new Set(v.$set);
    }
    return v;
  }) as { version?: unknown };
  if (state?.version !== SIM_STATE_VERSION) throw new SimStateVersionError(state?.version);
  return state as SimState;
}
