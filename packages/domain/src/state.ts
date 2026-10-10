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
  /** Stage 1's reporting ledger (SPEC v1.1 §6.4): which period is next, what is open, and the income chain head */
  reporting: SeriesReporting;
  /** hardship pauses as Stage 1 records them */
  pauses: SeriesPauses;
  /** the period whose formal notice has been recorded, if any */
  formalNoticeEmittedFor: string | null;
  /** the vault's undistributed remainder, WAD-scaled (`0 ≤ carryWad < unitsOutstanding`) */
  carryWad: Wad;
  /** gross refunded to the issuer because it would have passed the cap */
  refundedToIssuer: Money;
  /** gross accepted per settlement year (Stage 1's four-slot ring; `year` null = slot never written) */
  yearGross: { year: number | null; grossWad: Wad }[];
  /** the final pool of an extinguished series */
  final: { accWad: Wad; units: Units; distributed: Money };
  amendmentNonce: number;
  extinguishNonce: number;
}

export interface SeriesReporting {
  /** the settlement quarter; null before settlement */
  firstPeriod: string | null;
  /** the only period a report may be submitted for next; null before settlement */
  nextExpectedPeriod: string | null;
  lastAcceptedPeriod: string | null;
  lastPaidPeriod: string | null;
  /** the period whose due is unpaid, when `openDueAmount` > 0 */
  openDuePeriod: string | null;
  /** the unpaid due, before lateness accrual */
  openDueAmount: Money;
  lastIncomePeriod: string | null;
  /** the income commitment the next report chains from (Poseidon(0, 0) at the start of a reporting year) */
  lastIncomeCommitment: string;
}

export interface SeriesPauses {
  /** pauses approved so far */
  count: number;
  /** Σ approved pause lengths */
  pausedTotalSeconds: number;
  nonce: number;
  /** an issuer request is waiting for an attestor */
  requested: boolean;
  /** the end the issuer asked for (advisory; the attestor approves the actual end) */
  requestedUntil: number | null;
  /** the pause active now, if any */
  current: { start: number; end: number } | null;
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
  /** the regular (net) payout claimable now; the tail and the final pool are separate fields, never included here */
  claimable: Money;
  claimedTotal: Money;
  redeemedUnits: Units;
  /**
   * the tail owed to the holder after a redemption: Stage 1's `claimableTail` view, on its redeemed units or, before it
   * redeems, on the units its redemption would redeem (Stage 1's `claim_tail` redeems first; until S3 the holder sends
   * claimRedemption, then claimPayout pays it)
   */
  tailClaimable: Money;
  /** the final-pool share claimable now (after an extinguishment) */
  finalClaimable: Money;
  /** a Stage 1 registered holder (payouts accrue to registered holders only) */
  registered: boolean;
  /** payouts already settled into the holder's balance and not yet claimed */
  pending: Money;
  /** the vault accumulator at the holder's last settlement (its claim cursor) */
  lastAccWad: Wad;
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
  /** the commitment this period's report chained from; null until reported */
  priorIncomeCommitment: string | null;
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
  /** @deprecated use `tailPaidPerUnitWad` (the per-unit tail paid, WAD-scaled) */
  tailPaidPerUnit: Money;
  /** tail gross paid per unit so far, WAD-scaled (Stage 1 tail state) */
  tailPaidPerUnitWad: Wad;
  /** the tail accumulator (net per unit, WAD-scaled) */
  tailAccWad: Wad;
  /** the tail cap is reached: no further tail is due */
  tailExhausted: boolean;
  /** tail gross refunded to the issuer above the tail cap */
  tailRefunded: Money;
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
  /** stablecoin held for the window's buy orders (their deposits not yet paid out or refunded); "0" once cleared */
  escrowStable: Money;
  /** units held for the window's ask orders (still in the sellers' positions, earning payouts); "0" once cleared */
  escrowUnits: Units;
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
