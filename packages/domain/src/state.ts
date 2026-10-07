import type { LifecycleStatus, RaisePhase, SeriesTerms } from './events.ts';
import type { Address, ChainFamily, ChainKey, ChainMode, Stablecoin } from './ids.ts';
import type { Money, Units, Wad } from './money.ts';

/** Read-side state shapes returned by ChainPort. Money as strings; nothing chain-specific. */

export interface ChainInfo {
  chain: ChainKey;
  family: ChainFamily;
  mode: ChainMode;
  /** devnet / testnet / simulator-<personality> */
  network: string;
  stablecoins: Partial<Record<Stablecoin, { mint: Address; decimals: number }>>;
  /** program ids / contract addresses by module, when known */
  modules: Record<string, Address>;
  admin: Address;
  feeCollector: Address;
  newRaisesPaused: boolean;
}

export interface HealthReport {
  ok: boolean;
  mode: ChainMode;
  latency_ms: number;
  detail: string;
}

export interface IssuerState {
  issuer: Address;
  registeredAt: number;
  issuanceStopped: boolean;
  seriesIds: string[];
}

export interface SeriesState {
  seriesId: string;
  chain: ChainKey;
  issuer: Address;
  terms: SeriesTerms;
  phase: RaisePhase;
  status: LifecycleStatus;
  createdAt: number;
  openedAt: number | null;
  settledAt: number | null;
  issuePrice: Money | null;
  unitsSold: Units;
  unitsOutstanding: Units;
  capPerUnit: Money | null;
  paidPerUnitWad: Wad;
  accNetWad: Wad;
  lockupEndsAt: number | null;
  releasesPaused: boolean;
  releasesPausedByIssuer: boolean;
  pause: { requestedUntil: number | null; approvedUntil: number | null; startedAt: number | null } | null;
  pausedSecondsTotal: number;
  redemption: RedemptionState | null;
  extinguishedAt: number | null;
  /** life-to-date gross accepted, for cap displays */
  grossPaidTotal: Money;
  feesTotal: Money;
}

export interface AuctionState {
  seriesId: string;
  phase: RaisePhase;
  commitEndsAt: number | null;
  revealEndsAt: number | null;
  bidCount: number;
  revealedCount: number;
  clearingPrice: Money | null;
  unitsSold: Units;
  proceeds: Money;
}

export interface BidState {
  seriesId: string;
  bidder: Address;
  commitment: string;
  deposit: Money;
  order: number;
  revealed: { pricePerUnit: Money; quantity: Units } | null;
  allocatedUnits: Units;
  refunded: Money;
  settled: boolean;
}

export interface TreasuryState {
  seriesId: string;
  total: Money;
  released: Money;
  balance: Money;
  paused: boolean;
  tranches: { index: number; afterSeconds: number; bps: number; amount: Money; drawableAt: number | null; drawn: boolean }[];
}

export interface VaultState {
  seriesId: string;
  balance: Money;
  accNetWad: Wad;
  grossTotal: Money;
  feesTotal: Money;
  dust: Money;
}

export interface PositionState {
  seriesId: string;
  wallet: Address;
  units: Units;
  rewardDebt: Money;
  claimable: Money;
  claimedTotal: Money;
  redeemedUnits: Units;
  tailClaimable: Money;
}

export interface PeriodState {
  seriesId: string;
  periodId: string;
  dueAt: number;
  graceEndsAt: number;
  formalNoticeAt: number;
  reportAccepted: boolean;
  tier: number | null;
  paymentDue: Money;
  accrual: Money;
  paid: Money;
  splitReceived: Money;
  settled: boolean;
  standing: 'NotDue' | 'OnTime' | 'InGrace' | 'Late' | 'FormalNoticeDue' | 'Deferred';
  incomeCommitment: string | null;
  liquidityEvent: boolean;
}

export interface RedemptionState {
  openedAt: number;
  pricePerUnit: Money;
  unitsAtRedemption: Units;
  deposit: Money;
  claimed: Money;
  tailCapPerUnit: Money;
  tailEndsAt: number;
  tailPaidPerUnit: Money;
}

export interface RateAccumulatorState {
  pair: string;
  sumWad: Wad;
  count: number;
  lastDayIndex: number | null;
  lastRateWad: Wad | null;
}

export interface QuarterRateState {
  pair: string;
  periodId: string;
  avgWad: Wad | null;
  snapshots: number;
  daysInQuarter: number;
  coverageOk: boolean;
  needsFallback: boolean;
  fallbackReason: 'coverage' | 'deviation' | null;
}

export interface TransferWindowState {
  seriesId: string;
  windowId: number;
  commitEndsAt: number;
  revealEndsAt: number;
  cleared: boolean;
  clearingPrice: Money | null;
  orderCount: number;
}

export interface CurveState {
  seriesId: string;
  quoteStablecoin: Stablecoin;
  raised: Money;
  unitsOutstanding: Units;
  spotPrice: Money;
  graduationThreshold: Money;
  graduated: boolean;
}
