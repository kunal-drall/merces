import type { LifecycleStatus, RaiseStateName, Stablecoin } from '@merces/domain';
import type { FinalState, Pause, Proposal, TailState, VaultState as Stage1VaultState } from '@merces/math';
import type { PersonalityConfig } from './addresses.ts';

/**
 * Internal simulator state. bigint everywhere money or ratios appear.
 *
 * Version 2 (S1) carries Stage 1's own state objects beside ours: the series ledger (`SimLedger`, Stage 1's field
 * names), the payout vault, the tail and the final pool (Stage 1 types from `@merces/reference`).
 *
 * Version 3 (S2) adds the raise's own terms (the commit and reveal durations and the non-reveal charge, `SimTerms`)
 * and Stage 1's multi-step auction settlement (`SimAuction`, `SimBid`).
 *
 * Version 4 (S3) adds the unit scale and curve staking: `SimSeries.unitScale` (accounting units per whole unit, Stage 1's
 * `Ledger.unit_scale`), the stake and tender totals and the census time, and each holder's `stakedUnits`. Every money
 * path takes the unit scale through `@merces/math`'s scale-aware family (Stage 1's own functions at scale 1). The
 * curve record (`SimCurve`: the stand-in pool, its base-mint accounts and its proceeds) was completed under the same
 * version before anything was deployed (S3 WP8). States of another version are never upgraded in place.
 */
export const SIM_STATE_VERSION = 4;

/** A persisted simulator state from another layout (version 1 before S1, 2 before S2, 3 before S3): never upgraded in place, reset it. */
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
  /** recorded as created; settlement applies `appliedNonRevealChargeBps` of it (0 while the charge is held) */
  nonRevealChargeBps: number;
  /** `openRaise` sets the commit end to now + this, and the reveal end to the commit end + `revealDurationSeconds` */
  commitDurationSeconds: number;
  revealDurationSeconds: number;
  dueDays: number;
  graceDays: number;
  formalNoticeDays: number;
  contractHash: string;
  termsCommitment: string;
  tierFlags: { tier1: boolean; tier2: boolean; tier3: boolean; tier4: boolean };
  reportingCurrency: string;
  raiseStyle: 'sealed' | 'curve';
}

/** A sealed bid (Stage 1 `Bid`, SIM:66-80; SPEC.md:281-286). The bid commitment stays ours until S4. */
export interface SimBid {
  bidder: string;
  commitment: string;
  /** Stage 1 `escrow` */
  deposit: bigint;
  /** commit order */
  order: number;
  revealed: { pricePerUnit: bigint; quantity: bigint } | null;
  /** Stage 1 `reveal_index`: -1 until revealed */
  revealIndex: number;
  /** fixed at reveal (Stage 1 `isBidValid`; never reverts the reveal); false until revealed */
  valid: boolean;
  /** the settlement round that last tallied this bid (0: never), so an overlapping page skips it */
  talliedRound: number;
  processed: boolean;
  /** units allocated when processed (Stage 1 `allocation`) */
  allocation: bigint;
  /** units and stablecoin owed to the bidder from processing; `deliverBid` pays them (kept after delivery, as Stage 1 does) */
  pendingUnits: bigint;
  pendingRefund: bigint;
  delivered: boolean;
}

/** One round's running tally (Stage 1 `Tally`): the sum of every `tallyBids` page of the round. */
export interface SimTally {
  qAbove: bigint;
  qAt: bigint;
  allocSum: bigint;
  /** lowest valid revealed price tallied; null while none */
  minValidPrice: bigint | null;
  talliedCount: number;
}

/**
 * The sealed-bid auction record (Stage 1 `Auction` with the series' `revealedCount` and `escrowTotal`, SIM:179-196;
 * SPEC.md:268-280). The engine only orders the steps, stores what Stage 1's math returns and moves balances.
 */
export interface SimAuction {
  /** stablecoin held: deposits, less cost and fee at processing, less refunds at delivery (Stage 1 `escrowTotal`) */
  escrowTotal: bigint;
  revealedCount: number;
  validCount: number;
  /** Stage 1 `tally_round`: 0 before the first proposal */
  tallyRound: number;
  roundRejected: boolean;
  rejectionReason: 'ClaimMismatch' | 'InvalidClearingPrice' | null;
  /** the current round's proposal (Stage 1 `beginSettlement`); null before the first */
  proposal: Proposal | null;
  tally: SimTally;
  // results, written once by finalizeSettlement (for a MinRaise failure the would-be values)
  /** null before finalize and when no bid was valid (Stage 1 keeps 0) */
  clearingPrice: bigint | null;
  qAbove: bigint;
  qAt: bigint;
  R: bigint;
  unitsSold: bigint;
  proceeds: bigint;
  failureReason: 'NoValidBids' | 'MinRaise' | null;
  finalizedAt: number | null;
  // processing
  bidsProcessed: number;
  unitsMinted: bigint;
  /** Stage 1's money gate (SPEC §6.1): set by the last `processBid` (or a curve's graduation) */
  mintFinalized: boolean;
  /** units minted to winners and not yet delivered */
  escrowUnits: bigint;
}

/** A fresh auction record (Stage 1 initial values, SIM:807). */
export function newAuction(): SimAuction {
  return {
    escrowTotal: 0n, revealedCount: 0, validCount: 0, tallyRound: 0, roundRejected: false, rejectionReason: null, proposal: null, tally: emptyTally(),
    clearingPrice: null, qAbove: 0n, qAt: 0n, R: 0n, unitsSold: 0n, proceeds: 0n, failureReason: null, finalizedAt: null,
    bidsProcessed: 0, unitsMinted: 0n, mintFinalized: false, escrowUnits: 0n,
  };
}

/** A round's tally before its first page. */
export function emptyTally(): SimTally {
  return { qAbove: 0n, qAt: 0n, allocSum: 0n, minValidPrice: null, talliedCount: 0 };
}

export interface SimPosition {
  wallet: string;
  units: bigint;
  /** units held back for an open transfer-window sell order; they stay in `units` for payout accounting */
  escrowed: bigint;
  /** payouts settled into a pending balance on unit changes (burn, transfer) */
  pending: bigint;
  claimedTotal: bigint;
  redeemedUnits: bigint;
  // ---- Stage 1 holder record (SIM:82-90); set by `registerHolder` (SIM:406-416)
  registered: boolean;
  /** `vault.netAccWad` at the holder's last settlement */
  lastNetAccWad: bigint;
  /** tail and final cursors start at 0, not at the live accumulators (Stage 1 C-S20) */
  lastTailAccWad: bigint;
  lastFinalAccWad: bigint;
  finalClaimed: boolean;
  /**
   * Curve mode: the holder's units in the series' stake vault (Stage 1 `HolderRecord.staked_units`, accounting units).
   * On a curve series payouts accrue on these only; 0 on a sealed-bid series.
   */
  stakedUnits: bigint;
}

export interface SimPeriod {
  periodId: string;
  /** Stage 1's period id (year × 4 + quarter − 1; 2026Q1 = 8104) */
  pid: number;
  reportAccepted: boolean;
  tier: number | null;
  paymentStable: bigint;
  /** the due as the reads show it: the report's `due`, then the total paid (due + accrual) once settled */
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

/** The protocol-side base-mint accounts of a curve series (their balances are in `SimState.balances` under `baseMint`). */
export interface SimCurveAccounts {
  /** the DBC pool's base vault: the swap base not sold yet, and before migration the migration base, the issuer's locked allocation and the leftover */
  dbcBaseVault: string;
  /** the DAMM v2 pool's base vault after migration */
  dammBaseVault: string;
  /** the Jupiter locker's escrow of the issuer's locked allocation after migration */
  lockerEscrow: string;
  /** the leftover receiver (the curve authority PDA) after `withdraw_leftover` */
  leftoverReceiver: string;
  /** the series' stake vault (Stage 1 `ATA(PDA["curve_stake", series], base_mint)`; used from S3 WP10); not protocol-held */
  stakeVault: string;
}

/**
 * A curve series' bonding curve (curve mode, Solana only; S3 WP8). Meteora's Dynamic Bonding Curve is not in the
 * checkout, so the simulator runs a **labelled stand-in** (`venue`) for it, never a Merces instruction: it sells the swap
 * base at the constant price P0 (exactly X per swap base, so the curve fills when its base is sold and its reserve
 * reaches X), takes Stage 1's generated config's trading fee (1%, 20% of it Meteora's, the rest the partner's), fills
 * the last buy partially at X, and holds the unit mint's fixed supply in protocol accounts. Migration, the locker and
 * DAMM trades are harness hooks that only move base lamports. Meteora's own venue (Stage 1's DBC math through the
 * Meteora port) replaces it in S5. Quote amounts here are the pool's accounting; the treasury holds none of them until
 * `collectCurveProceeds`.
 */
export interface SimCurve {
  venue: 'simulator-stand-in';
  quoteStablecoin: Stablecoin;
  dbcConfig: string;
  dbcPool: string;
  /** the pool's creator: the issuer */
  dbcCreator: string;
  /** the unit mint (6 decimals); base lamports are its base units */
  baseMint: string;
  accounts: SimCurveAccounts;
  /** X: the pool's migration quote threshold, the terms' minimum raise (Stage 1 requires them equal) */
  migrationQuoteThreshold: bigint;
  /** base lamports the curve sells (`unitsOffered × 10^6`; Stage 1 `units_sold`) */
  swapBaseAmount: bigint;
  /** base lamports deposited into the DAMM v2 pool at migration */
  migrationBaseAmount: bigint;
  /** the issuer's locked allocation, base lamports (to the locker escrow at migration) */
  lockedVestingAmount: bigint;
  /** base lamports left over after migration (to the leftover receiver) */
  leftoverAmount: bigint;
  /** the unit mint's fixed supply: swap base + migration base + locked vesting + leftover */
  supply: bigint;
  /** P0 per whole unit, `floor(X × 10^6 / swapBaseAmount)` (Stage 1 `clearing_price`) */
  p0: bigint;
  /** the trading fee on every buy and sell, bps (Stage 1's config: 1%) */
  tradingFeeBps: bigint;
  /** Meteora's share of every trading fee, percent (20; the rest is the partner's with no creator share) */
  protocolFeePercent: bigint;
  /** Meteora's migration fee, percent of X (99), and the creator's share of it (0: the issuer creates the pool) */
  migrationFeePercentage: number;
  creatorMigrationFeePercentage: number;
  /** the quote the pool holds for the curve: buys net of the fee, less sells (DBC `quote_reserve`) */
  quoteReserve: bigint;
  /** Meteora's share of the trading fees (never collected by Merces) */
  protocolQuoteFee: bigint;
  /** the partner's trading fees accrued and not collected yet (DBC `partner_quote_fee`) */
  partnerQuoteFee: bigint;
  /** swap base bought out of the pool, net of sells */
  baseSold: bigint;
  /** when the pool filled (DBC `finish_curve_timestamp`); null before */
  finishTs: number | null;
  /** the partner migration fee and the partner surplus were withdrawn (each once, DBC's flags) */
  migrationFeeWithdrawn: boolean;
  surplusWithdrawn: boolean;
  /** the migration hook ran (base moved to the DAMM pool, the locker and the leftover receiver) */
  migrated: boolean;
  /** what `collectCurveProceeds` moved so far */
  collected: { migrationFee: bigint; surplus: bigint; tradingFee: bigint };
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
  /**
   * Accounting units per whole unit (Stage 1 `Ledger.unit_scale`): 1 for a sealed-bid series, 10^6 base lamports for a
   * curve series. Units outstanding, weights, stakes and tenders are in accounting units,
   * prices (the issue price, the cap, `P_redeem`) per whole unit; the vault's per-unit WAD figures are per accounting
   * unit. Every money path passes it to `@merces/math`'s scale-aware functions, which run Stage 1's own at scale 1.
   */
  unitScale: bigint;
  /** Stage 1's stored raise state (`raise_state`); the reveal phase is time-derived (`auctionPhase`), never stored */
  phase: RaiseStateName;
  status: LifecycleStatus;
  createdAt: number;
  openedAt: number | null;
  commitEndsAt: number | null;
  revealEndsAt: number | null;
  settledAt: number | null;
  /** a settled raise's clearing price, or a curve's P0 from its activation; null otherwise (a failed raise's price is `auction.clearingPrice`) */
  issuePrice: bigint | null;
  /** a settled raise's units sold, or a curve's swap base from its activation (base lamports); 0 otherwise */
  unitsSold: bigint;
  /** 0 until the mint is final (`auction.mintFinalized`): Stage 1 sets it after the last `processBid` */
  unitsOutstanding: bigint;
  capPerUnit: bigint | null;
  vaultBalance: bigint;
  vaultDistributedNet: bigint;
  treasuryTotal: bigint;
  treasuryReleased: bigint;
  /** unvested treasury returned to holders at extinguishment */
  treasuryReturned: bigint;
  tranches: SimTranche[];
  releasesPausedByIssuer: boolean;
  bids: Map<string, SimBid>;
  bidOrder: number;
  /** the sealed-bid auction (Stage 1's record; a curve series keeps the initial one, with `mintFinalized` set by `completeCurve`) */
  auction: SimAuction;
  positions: Map<string, SimPosition>;
  periods: Map<string, SimPeriod>;
  redemption: SimRedemption | null;
  extinguishedAt: number | null;
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
  // ---- curve staking (Stage 1 curve mode; 0 / null on a sealed-bid series)
  /** Σ holders' `stakedUnits` (Stage 1 `Ledger.staked_total`, accounting units) */
  stakedTotal: bigint;
  /** units tendered at a curve redemption (Stage 1 `Ledger.tendered_total`, accounting units) */
  tenderedTotal: bigint;
  /** when `unitsOutstanding` was last taken from the curve's census (Stage 1 `Ledger.units_synced_at`); null before the first */
  unitsSyncedAt: number | null;
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

/** Parse a persisted state. Throws `SimStateVersionError` unless it is version 4: older states are never upgraded. */
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
