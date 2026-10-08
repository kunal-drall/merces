/**
 * Canonical error names used by `expect_revert` steps in the parity vectors. Both chain
 * implementations map their own error codes to these names (SPEC §11, §12 "every error has a
 * distinct code"). Names that appear verbatim in SPEC.md are marked.
 */
export const ERRORS = {
  // conventions
  AmountOutOfRange: "an externally supplied amount, price, quantity, escrow, payment, fx rate, adjustment or timestamp exceeds u64 (i64 for signed), or a derived due does not fit u64",
  // registry
  NotAdmin: "caller is not the protocol admin",
  NotAllowlistManager: "caller is not the allowlist manager",
  NotIssuer: "caller is not the series issuer",
  IssuerInactive: "issuer is not registered or was deactivated",
  IssuanceStopped: "issuer has stopped new issuance",
  NotAllowlisted: "wallet is not allowlisted",
  ParameterOutOfBounds: "a series parameter is outside its bounds (SPEC §1.6)",
  InvalidReleaseSchedule: "release schedule bps do not sum to 10000, are empty, exceed 24 tranches or offsets decrease",
  InvalidTerms: "units_offered, reserve_price, min_raise or wallet cap (floor(units_offered × wallet_cap_bps / 10000) ≥ 1) violate SPEC §3.2 / §1.6",
  ContractHashMissing: "contract hash not set",
  SeriesNotDraft: "series is no longer in Draft",
  TermsFrozen: "charter terms cannot change after the raise opened",
  UnfavourableAmendment: "new cap multiple is above the current one or out of bounds",
  AmendmentAfterTerminal: "amend_terms after Retired/Redeemed/Extinguished",
  FxPairExists: "feed_id ‖ inverted already registered (write-once)",
  UnknownFxPair: "series references an unregistered or disabled FX pair",
  InvalidAttestorSignature: "signature does not recover to an active attestor",
  InvalidVerifierSignature: "signature does not recover to an active report-verifier key",
  NewRaisesPaused: "protocol flag new_raises_paused is set",
  // auction
  RaiseNotOpen: "raise is not in the Open state",
  RaiseNotDraft: "raise is not in Draft",
  BidsExist: "cannot cancel after the first bid",
  CommitPhaseClosed: "now ≥ commit_end",
  RevealPhaseClosed: "outside [commit_end, reveal_end)",
  RevealNotStarted: "now < commit_end",
  BidExists: "wallet already has a bid in this auction",
  BidNotFound: "no bid for this wallet",
  AlreadyRevealed: "bid already revealed",
  CommitmentMismatch: "keccak256(price ‖ quantity ‖ salt ‖ bidder) != commitment",
  ZeroEscrow: "escrow must be > 0",
  SettlementNotReady: "now < reveal_end",
  TallyInProgress: "begin_settlement while a tally round is incomplete and not rejected",
  TallyIncomplete: "tallied_count != revealed_count",
  InvalidClearingPrice: "rejection reason (not a revert): the proposal fails SPEC §5.2 step 3",
  ClaimMismatch: "rejection reason (not a revert): q_above/q_at claims differ from the tally",
  NotSettling: "finalize without a settlement round",
  AlreadyProcessed: "bid already processed",
  NotProcessed: "deliver_bid before process_bid",
  AlreadyDelivered: "deliver_bid twice",
  RaiseNotSettled: "raise is neither Settled nor Failed",
  // treasury
  ReleasesPaused: "issuer paused releases",
  SeriesLate: "derive_status(now) == Late or is_late_underlying(now): releases pause until current",
  MintNotFinalized: "money operations are blocked until RaiseMintFinalized (SPEC §6.1 gate)",
  NothingVested: "no vested amount to release (was NothingToRelease)",
  EarlyDrawDisabled: "early_draw_approver unset",
  EarlyDrawNotApproved: "approver rejected the early draw",
  ExceedsProceeds: "released_total + amount > proceeds",
  // reports and payments
  TerminalStatus: "series status forbids the call: Retired/Extinguished for reports, any terminal status for redeem/pause/window (was SeriesTerminal)",
  WrongPeriod: "period is not the next expected period",
  ReportTooEarly: "now < period_end(period)",
  PaymentOutstanding: "the previous period's due amount is unpaid",
  UnreportedPeriods: "redeem while an ended period has no accepted report",
  TierNotEnabled: "tier not enabled for the series, tier 1 on a mixed series, or tier4 flag off",
  RouterPeriodNotClosed: "tier-1 report without a router checkpoint for the period",
  FxMismatch: "fx_avg_wad does not match the accumulator (or WAD for stablecoin income)",
  StalePrice: "Pyth update older than fx_max_staleness_seconds (or wrong feed)",
  ConfidenceTooWide: "conf × 10000 > price × fx_max_conf_bps",
  SnapshotAlreadyTaken: "a snapshot for this UTC day already exists",
  FxFallbackRequired: "quarter is NeedsFallback: an attestor-signed rate is required",
  FxFallbackNotAllowed: "fallback signature supplied although the accumulator is valid",
  InvalidProof: "Groth16 verification failed",
  NothingDue: "open_due_amount == 0 (or trueup_due == 0 for pay_trueup)",
  TrueUpOutstanding: "submit_trueup while a previous true-up is unpaid, or redeem with trueup_due > 0",
  TrueUpYearInvalid: "true-up year not complete, already trued up, or missing reports",
  TrueUpAdjustmentTooLarge: "negative adjustment exceeds the year's accepted payments",
  NoUnitsOutstanding: "SPEC §6.3: units_outstanding == 0",
  TransferFeeNotZero: "SPEC §5.3: stablecoin mint has a non-zero transfer fee",
  // holders
  HolderNotRegistered: "holder has no registration",
  NothingToClaim: "nothing claimable",
  // status / pause
  PauseNotRequested: "approve_pause / withdraw_pause_request without a pending request",
  AlreadyPaused: "a hardship pause is already active",
  NotPaused: "no active pause",
  InvalidPauseEnd: "pause_end ≤ now",
  PauseTooLong: "pause_end − now > max_pause_seconds or cumulative pause > max_cumulative_pause_seconds",
  TooManyPauses: "pause_count == max_pauses",
  // redemption / tail / extinguishment
  LockupActive: "now < settlement_ts + lockup_seconds",
  NotRedeemed: "series is not Redeemed",
  NoTailDue: "SPEC §6.8: liquidity report while tail_cap_per_unit == 0 or tail_exhausted",
  TailEnded: "period_start(period) > redemption_ts + tail_seconds (was TailExpired)",
  NoRedeemedUnits: "holder had no units at redemption",
  SameAttestor: "extinguishment needs two distinct attestors",
  // router
  RouterNotEnabled: "series has no tier-1 router",
  // transfers / windows
  DirectTransferForbidden: "SPEC §4: wallet-to-wallet transfers never pass",
  WindowsDisabled: "protocol flag windows_enabled is false",
  WindowNotEligible: "status, lockup, report or period precondition of open_window failed",
  WindowOpen: "a window is already open for this series",
  WindowNotOpen: "no window in the required phase",
  OrderExists: "wallet already has an order in this window (one order per wallet, either side)",
  OutOfOrder: "marginal window order processed ahead of the reveal-index cursor",
  UnarmedEscrowDeposit: "unit transfer into the window escrow without an armed commit_ask",
  WalletCapExceeded: "destination balance would exceed floor(units_outstanding × wallet_cap_bps / 10000)",
  InsufficientUnits: "ask quantity exceeds escrowed units",
  InsufficientEscrow: "bid escrow below price × quantity + fee",
  InvalidWindowPrice: "rejection reason (not a revert): window proposal fails the crossing conditions",
} as const;

/** v1.0 → v1.1 renames, for harnesses that mapped the earlier names. */
export const ERROR_ALIASES: Readonly<Record<string, ErrorName>> = Object.freeze({
  SeriesTerminal: "TerminalStatus",
  TailExpired: "TailEnded",
  NothingToRelease: "NothingVested",
  NotLiquidityEvent: "WrongPeriod",
});

export type ErrorName = keyof typeof ERRORS;

export const ERROR_NAMES = Object.keys(ERRORS) as ErrorName[];

export function isErrorName(s: string): s is ErrorName {
  return Object.prototype.hasOwnProperty.call(ERRORS, s);
}
