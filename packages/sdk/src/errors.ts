/**
 * Canonical error names used by `expect_revert` steps in the parity vectors. Both chain
 * implementations map their own error codes to these names (SPEC §11, §12 "every error has a
 * distinct code"). Names that appear verbatim in SPEC.md are marked.
 */
export const ERRORS = {
  // registry
  NotAdmin: "caller is not the protocol admin",
  NotAllowlistManager: "caller is not the allowlist manager",
  NotIssuer: "caller is not the series issuer",
  IssuerInactive: "issuer is not registered or was deactivated",
  IssuanceStopped: "issuer has stopped new issuance",
  NotAllowlisted: "wallet is not allowlisted",
  ParameterOutOfBounds: "a series parameter is outside its bounds (SPEC §1.6)",
  InvalidReleaseSchedule: "release schedule bps do not sum to 10000, are empty, exceed 24 tranches or offsets decrease",
  InvalidTerms: "units_offered, reserve_price or min_raise violate SPEC §3.2",
  ContractHashMissing: "contract hash not set",
  SeriesNotDraft: "series is no longer in Draft",
  TermsFrozen: "charter terms cannot change after the raise opened",
  UnfavourableAmendment: "new cap multiple is above the current one or out of bounds",
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
  TallyIncomplete: "tallied_count != revealed_count",
  InvalidClearingPrice: "SPEC §5.2: proposal fails validity conditions",
  AlreadyProcessed: "bid already processed",
  RaiseNotSettled: "raise is neither Settled nor Failed",
  // treasury
  ReleasesPaused: "issuer paused releases",
  SeriesLate: "derive_status(now) == Late: releases pause until current",
  MintNotFinalized: "releases blocked until RaiseMintFinalized",
  NothingToRelease: "no vested amount to release",
  EarlyDrawDisabled: "early_draw_approver unset",
  EarlyDrawNotApproved: "approver rejected the early draw",
  ExceedsProceeds: "released_total + amount > proceeds",
  // reports and payments
  SeriesTerminal: "series is Retired, Redeemed or Extinguished (not allowed for this call)",
  SeriesRetired: "reports are not accepted on a Retired series",
  WrongPeriod: "period is not the next expected period",
  ReportTooEarly: "now < period_end(period)",
  PaymentOutstanding: "the previous period's due amount is unpaid",
  TierNotEnabled: "tier not enabled for the series (or tier4 flag off)",
  FxMismatch: "fx_avg_wad does not match the accumulator (or WAD for stablecoin income)",
  StalePrice: "Pyth update older than fx_max_staleness_seconds (or wrong feed)",
  ConfidenceTooWide: "conf × 10000 > price × fx_max_conf_bps",
  SnapshotAlreadyTaken: "a snapshot for this UTC day already exists",
  FxFallbackRequired: "quarter is NeedsFallback: an attestor-signed rate is required",
  FxFallbackNotAllowed: "fallback signature supplied although the accumulator is valid",
  InvalidProof: "Groth16 verification failed",
  NothingDue: "open_due_amount == 0",
  NoUnitsOutstanding: "SPEC §6.3: units_outstanding == 0",
  TransferFeeNotZero: "SPEC §5.3: stablecoin mint has a non-zero transfer fee",
  // holders
  HolderNotRegistered: "holder has no registration",
  NothingToClaim: "nothing claimable",
  // status / pause
  PauseNotRequested: "approve_pause without a pending request",
  AlreadyPaused: "a hardship pause is already active",
  NotPaused: "no active pause",
  InvalidPauseEnd: "pause_end ≤ now",
  // redemption / tail / extinguishment
  LockupActive: "now < settlement_ts + lockup_seconds",
  NotRedeemed: "series is not Redeemed",
  NoTailDue: "SPEC §6.8: tail_cap_per_unit == 0",
  TailExpired: "now > redemption_ts + tail_seconds",
  NotLiquidityEvent: "a report after redemption must flag a liquidity event",
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
  OrderExists: "wallet already has an order on this side",
  WalletCapExceeded: "destination balance would exceed floor(units_outstanding × wallet_cap_bps / 10000)",
  InsufficientUnits: "ask quantity exceeds escrowed units",
  InsufficientEscrow: "bid escrow below price × quantity + fee",
  InvalidWindowPrice: "window clearing proposal fails the crossing conditions",
} as const;

export type ErrorName = keyof typeof ERRORS;

export const ERROR_NAMES = Object.keys(ERRORS) as ErrorName[];

export function isErrorName(s: string): s is ErrorName {
  return Object.prototype.hasOwnProperty.call(ERRORS, s);
}
