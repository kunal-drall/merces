/**
 * @merces/math — the one gateway to Stage 1's mechanism math (SPEC v1.1.2).
 *
 * Product code imports Stage 1 math only through the named re-exports below (`@merces/sdk` and `@merces/reference`,
 * the `stage1` submodule's own packages): they are Stage 1's function objects, not copies, so a Stage 1 change
 * arrives with the submodule bump. `stage1:sync`'s math step (`checkMathPin`) checks both the pin and that identity.
 *
 * Beside them sit the few helpers Stage 1 has no counterpart for: the `"YYYYQn"` period codec, decimal parsing, the
 * term builder's per-unit rate, a value-free payment wrapper, deadline projection and a display cap.
 *
 * The interim Merces math (Part C) survives only under `interim.*`, and since the end of S1 only the auction family
 * (`clearAuction`, `walletCapUnits`, `bidDeposit`, `auctionFee`; S2 moves its callers to Stage 1's auction family below
 * and deletes it in WP8) and the FX family (`quarterAverageRate`, `coverageOk`, `deviationBps`, `withinBand`,
 * `pythToWad`; S5).
 */
export * as interim from './interim/index.ts';

// ---------------------------------------------------------------- Stage 1 client helpers (@merces/sdk)
export {
  // fixed point (SPEC §1.1)
  WAD,
  BPS_DENOMINATOR,
  mulDiv,
  mulDivCeil,
  ceilDiv,
  wadMul,
  wadDiv,
  bpsOf,
  // time and periods (SPEC §1.2); Stage 1's `periodOf(ts: bigint): pid` is `pidAt` here
  DAY,
  YEAR,
  periodStart,
  periodEnd,
  quarterIndex,
  yearOf,
  periodLabel,
  tradingDaysInPeriod,
  periodOf as pidAt,
  // hardship pauses (SPEC §6.4)
  unpaused,
  isPausedAt,
  pausedWithin,
  type Pause,
  // tagged year_gross ring (SPEC §6.3)
  newYearGross,
  settlementYear,
  yearGrossAdd,
  yearGrossGet,
  type YearGrossRing,
  // parameters and enumerations (SPEC §1.6, §1.7)
  DEFAULT_PARAMETERS,
  PARAMETER_BOUNDS,
  parametersFromStrings,
  SeriesStatus,
  RaiseState,
  TIER_FLAG,
  tierEnabled,
  type Parameters,
  // canonical error names (SPEC §11)
  ERRORS,
  ERROR_ALIASES,
  isErrorName,
  type ErrorName,
  // commitments (SPEC §1.5): Poseidon over BN254 with circomlib's parameters. The commitment helpers return the
  // field element; `@merces/domain` wraps them into the 0x-hex the canonical model carries.
  BN254_FR,
  assertField,
  poseidon2,
  poseidon5,
  termsCommitment as termsCommitmentField,
  incomeCommitment as incomeCommitmentField,
  routerIncomeCommitment as routerIncomeCommitmentField,
  CURRENCY_CODES,
  INDEXING_RULES,
  // other
  U64_MAX,
  ZERO_INCOME_COMMITMENT,
  bytes32ToField,
  fieldToBytes32,
} from '@merces/sdk';

// ---------------------------------------------------------------- Stage 1 reference math (@merces/reference)
// Not re-exported: Stage 1's positional `quarterPayment(r, N, θ, x, prior)` (θ third; use `paymentStable`) and
// Stage 1's `walletCapUnits` (the redemption-window cap, `window.ts`; S5). The auction's cap is
// `walletCapUnitsAtAuction` below; it has no minimum of one (the creation rule keeps it ≥ 1).
export {
  // status, deadlines and accrual (SPEC v1.1 §6.4)
  isTerminal,
  deadlineSeconds,
  graceSeconds,
  noticeSeconds,
  countdown,
  nextExpectedPeriod,
  earliestUnpaid,
  deriveStatus,
  isLateUnderlying,
  lateDays,
  lateAccrual,
  formalNoticeDue,
  pauseApprovalError,
  type StatusParams,
  type LedgerClock,
  type PauseBounds,
  // payout vault (SPEC v1.1 §6.3)
  newVaultState,
  capPerUnit,
  capEffWad,
  isCapped,
  vaultReceiveGross,
  settleHolderDelta,
  accumulate,
  type VaultState,
  type ReceiveResult,
  // redemption, tail and extinguishment (SPEC v1.1 §6.7–§6.9)
  hurdlePrice,
  averageAnnualGross,
  redemptionQuote,
  newTailState,
  tailReceive,
  newFinalState,
  finalDistribute,
  type HurdleResult,
  type RedemptionInputs,
  type RedemptionQuote,
  type TailState,
  type TailReceiveResult,
  type FinalState,
  // treasury (SPEC v1.1 §5.3)
  MAX_RELEASE_TRANCHES,
  validateReleaseSchedule,
  trancheAmounts,
  vested,
  releasable,
  type ReleaseTranche,
  // income (SPEC §8)
  owedYtd,
  paymentUsd,
  // sealed-bid auction and multi-step settlement (SPEC v1.1 §5.1–§5.2)
  walletCapUnitsAtAuction,
  requiredEscrow,
  isBidValid,
  beginSettlement,
  tallyBids,
  isClearingPriceValid,
  finalizeSettlement,
  marginalAllocation,
  processBid,
  claimsFor,
  findClearingPrice,
  type AuctionRules,
  type RevealedBid,
  type Proposal,
  type Tally,
  type FinalizeOutcome,
  type BidOutcome,
  type SettledState,
  type RejectionReason,
} from '@merces/reference';

// The shapes of Stage 1's vector `expect` views (types only, nothing runs): the simulator's stage1 view builds them.
export type { LedgerExpect, AuctionExpect, HolderExpect } from '@merces/reference';

// ---------------------------------------------------------------- ours (no Stage 1 counterpart)
export { type Period, periodOf, periodOfPid, periodFrom, parsePeriod, periodsBetween, toPid, fromPid } from './periods.ts';
export { wadFromDecimal, wadToDecimal, utcDayIndex } from './decimal.ts';
export { ratePerUnit } from './rate.ts';
export { paymentStable, PAYMENT_RANGE_ERROR, type PaymentInputs } from './payment.ts';
export { statusParamsOf, projectDeadlines, standingOf, type StatusTerms, type ProjectedDeadlines, type Standing } from './status.ts';
export { capRemaining } from './cap.ts';
