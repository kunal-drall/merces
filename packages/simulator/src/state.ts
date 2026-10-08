import type { LifecycleStatus, RaisePhase, Stablecoin } from '@merces/domain';
import type { PersonalityConfig } from './addresses.ts';

/** Internal simulator state. bigint everywhere money or ratios appear. */

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
  rewardDebt: bigint;
  /** payouts settled into a pending balance on unit changes (burn, transfer) */
  pending: bigint;
  claimedTotal: bigint;
  redeemedUnits: bigint;
  tailDebt: bigint;
  redemptionClaimed: boolean;
}

export interface SimPeriod {
  periodId: string;
  reportAccepted: boolean;
  tier: number | null;
  paymentStable: bigint;
  /** owed before lateness (payment minus split receipts, or the tail amount) */
  outstanding: bigint;
  accrual: bigint;
  paymentDue: bigint;
  paid: bigint;
  splitReceived: bigint;
  settled: boolean;
  incomeCommitment: string | null;
  liquidityEvent: boolean;
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
}

export interface SimRedemption {
  openedAt: number;
  pricePerUnit: bigint;
  unitsAtRedemption: bigint;
  deposit: bigint;
  claimed: bigint;
  tailCapPerUnit: bigint;
  tailEndsAt: number;
  tailPaidPerUnit: bigint;
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
  paidPerUnitWad: bigint;
  accNetWad: bigint;
  vaultBalance: bigint;
  vaultGrossTotal: bigint;
  vaultFeesTotal: bigint;
  vaultDistributedNet: bigint;
  treasuryTotal: bigint;
  treasuryReleased: bigint;
  tranches: SimTranche[];
  releasesPausedByIssuer: boolean;
  releasesPausedLate: boolean;
  bids: Map<string, SimBid>;
  bidOrder: number;
  positions: Map<string, SimPosition>;
  periods: Map<string, SimPeriod>;
  pause: { requestedUntil: number | null; approvedUntil: number | null; startedAt: number | null } | null;
  pauseIntervals: { from: number; to: number }[];
  pausedSecondsTotal: number;
  redemption: SimRedemption | null;
  extinguishedAt: number | null;
  /** gross accepted per settlement-year index (0 = first year after settlement), for D_avg */
  grossByYear: Map<number, bigint>;
  grossPaidTotal: bigint;
  feesTotal: bigint;
  transferWindows: SimTransferWindow[];
  curve: SimCurve | null;
  splitRouter: string | null;
  amendments: { at: number; termsCommitment: string; capMultipleWad: bigint; attestor: string }[];
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

export function deserialiseState(json: string): SimState {
  return JSON.parse(json, (_k, v) => {
    if (v && typeof v === 'object') {
      if ('$big' in v && typeof v.$big === 'string') return BigInt(v.$big);
      if ('$map' in v && Array.isArray(v.$map)) return new Map(v.$map);
      if ('$set' in v && Array.isArray(v.$set)) return new Set(v.$set);
    }
    return v;
  }) as SimState;
}
