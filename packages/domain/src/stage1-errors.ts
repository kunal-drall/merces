import {ChainError,type ChainErrorCode} from './port.ts';
import type {ErrorName} from '@merces/math';

export const STAGE1_CODE = {
  IssuerInactive: 'NotPermitted',
  IssuanceStopped: 'NotPermitted',
  RouterNotEnabled: 'NotPermitted',
  RouterPeriodNotClosed: 'WrongStatus',
  OutOfOrder: 'WrongPhase',
  BidsNotProcessed: 'WrongPhase',
  DeliverFirst: 'WrongStatus',
  WindowsDisabled: 'NotPermitted',
  WindowNotEligible: 'WrongStatus',
  WindowOpen: 'Duplicate',
  WindowNotOpen: 'WrongPhase',
  OrderExists: 'Duplicate',
  InsufficientUnits: 'InsufficientFunds',
  NotIssuer: 'Unauthorized',
  RaiseNotSettled: 'WrongPhase',
  TerminalStatus: 'WrongStatus',
  WrongPeriod: 'WrongPhase',
  ReportTooEarly: 'TooEarly',
  PaymentOutstanding: 'WrongStatus',
  TrueUpOutstanding: 'WrongStatus',
  TrueUpYearInvalid: 'InvalidTerms',
  TrueUpAdjustmentTooLarge: 'InvalidTerms',
  TailEnded: 'TooLate',
  NoTailDue: 'WrongStatus',
  TierNotEnabled: 'NotPermitted',
  DirectTransferForbidden: 'NotPermitted',
  InvalidProof: 'InvalidProof',
  InvalidVerifierSignature: 'InvalidAttestation',
  InvalidAttestorSignature: 'InvalidAttestation',
  SameAttestor: 'InvalidTerms',
  AmendmentAfterTerminal: 'WrongStatus',
  UnfavourableAmendment: 'InvalidTerms',
  NothingDue: 'WrongStatus',
  HolderNotRegistered: 'NotFound',
  NothingVested: 'TooEarly',
  SeriesLate: 'Paused',
  ReleasesPaused: 'Paused',
  LockupActive: 'TooEarly',
  UnreportedPeriods: 'WrongStatus',
  NotRedeemed: 'WrongStatus',
  // the claim family (S3): `claim_tail` for a holder that has redeemed nothing and has nothing left to redeem
  NoRedeemedUnits: 'WrongStatus',
  PauseNotRequested: 'WrongStatus',
  AlreadyPaused: 'WrongStatus',
  NotPaused: 'WrongStatus',
  InvalidPauseEnd: 'InvalidTerms',
  PauseTooLong: 'InvalidTerms',
  TooManyPauses: 'InvalidTerms',
  AmountOutOfRange: 'InvalidTerms',
  ParameterOutOfBounds: 'InvalidTerms',
  InvalidTerms: 'InvalidTerms',
  InvalidReleaseSchedule: 'InvalidTerms',
  NewRaisesPaused: 'Paused',
  RaiseNotDraft: 'WrongPhase',
  ContractHashMissing: 'InvalidTerms',
  NotAllowlisted: 'NotAllowlisted',
  FxMismatch: 'InvalidTerms',
  FxPairExists: 'Duplicate',
  UnknownFxPair: 'NotFound',
  SnapshotAlreadyTaken: 'Duplicate',
  StalePrice: 'TooLate',
  ConfidenceTooWide: 'InvalidTerms',
  FxFallbackRequired: 'InvalidTerms',
  FxFallbackNotAllowed: 'InvalidTerms',
  InsufficientEscrow: 'InsufficientFunds',
  NoUnitsOutstanding: 'WrongStatus',
  MintNotFinalized: 'WrongPhase',
  // the sealed-bid raise and its multi-step settlement (S2; codes kept from the one-step auction)
  RaiseNotOpen: 'WrongPhase',
  CommitPhaseClosed: 'WrongPhase',
  RevealNotStarted: 'WrongPhase',
  RevealPhaseClosed: 'WrongPhase',
  TallyInProgress: 'WrongPhase',
  TallyIncomplete: 'WrongPhase',
  NotSettling: 'WrongPhase',
  NotProcessed: 'WrongPhase',
  BidExists: 'Duplicate',
  AlreadyRevealed: 'Duplicate',
  AlreadyProcessed: 'Duplicate',
  AlreadyDelivered: 'Duplicate',
  BidsExist: 'TooLate',
  ZeroEscrow: 'InvalidTerms',
  BidNotFound: 'NotFound',
  CommitmentMismatch: 'InvalidCommitment',
  SettlementNotReady: 'TooEarly',
} as const satisfies Partial<Record<ErrorName, ChainErrorCode>>;

/**
 * Stage 1 error names that only the Solana programs raise, so `@merces/sdk`'s `ERRORS` (the chain-neutral list) does
 * not have them (S3 D16). Each is checked against the pinned `merces_protocol` or `merces_registry` `error.rs` by
 * `errors.test.ts`. Curve mode is Solana only, so its names live here.
 */
export const STAGE1_SOLANA_CODE = {
  RouterPeriodAlreadyClosed: 'Duplicate',
  RouterPeriodNotEnded: 'TooEarly',
  NothingToRoute: 'WrongStatus',
  Tier1TermsMismatch: 'InvalidCommitment',
  CrosscheckRequired: 'InvalidTerms',
  TrueUpTimestampInFuture: 'InvalidTerms',
  // the registry's curve terms (create_series, lib.rs:470-485; S3 WP7)
  CurveThresholdZero: 'InvalidTerms',
  CurveTermsNotZero: 'InvalidTerms',
  CurveQuoteMintMismatch: 'InvalidTerms',
  // curve activation (activate_curve, curve.rs:799-805; S3 WP8): P0 = floor(X × 10^6 / swap base) must be at least 1
  CurveThresholdMismatch: 'InvalidTerms',
  // the curve's lifecycle (S3 WP8): a curve command on a sealed-bid series, a sealed-bid command on a curve series (the
  // raise, the settlement and the window; Stage 1 fails the settlement steps on the missing auction account, ours by
  // name), completion before the pool filled, and the sealed-bid exits closed on a curve (claims.rs:252, :342)
  NotCurveMode: 'WrongPhase',
  NotSealedBid: 'WrongPhase',
  CurveNotComplete: 'TooEarly',
  CurveModeNoBurn: 'NotPermitted',
  CurveUsesTender: 'NotPermitted',
  // the census (S3 WP9): protocol-held units past the supply (curve.rs:477), a count below the stakes (:478-481), and a
  // report whose census does not postdate its period's end (require_units_synced_for, :1532-1541)
  CurveUnitsInconsistent: 'ChainSpecific',
  CurveUnitsBelowStake: 'WrongStatus',
  CurveUnitsNotSynced: 'WrongStatus',
  // staking and tender (S3 WP10): a stake, unstake or tender of 0 units (curve.rs:1264, :1343, :1439), more than the
  // holder's stake unstaked or tendered (:1345, :1441-1444), stakes past the last census (:1269-1276), and wallet
  // units past the tender quota (`wallet_tender_fits`, :1445-1454)
  ZeroUnits: 'InvalidTerms',
  InsufficientStake: 'InsufficientFunds',
  StakeExceedsOutstanding: 'WrongStatus',
  TenderQuotaExhausted: 'WrongStatus',
  // the key registry (S4 WP5, D9; merces_registry lib.rs:218-260): a zero key address, a revoke of a key that is not
  // active, and a revoke that would leave no active key of its kind (`attestor_count >= 2`). The codes are shared with
  // the EVM's names for the same cases, so each case has one chain-neutral code on both personalities
  ZeroAttestorAddress: 'InvalidTerms',
  KeyAlreadyRevoked: 'WrongStatus',
  LastKeyOfKind: 'NotPermitted',
  // Anchor's built-in error 3012 (not in Stage 1's error.rs): a revoke of a key whose account was never created (the
  // key was never registered). errors.test.ts checks Stage 1's own harness constant for it
  // (solana/tests/src/vectors.rs `ACCOUNT_NOT_INITIALIZED: u32 = 3012`)
  AccountNotInitialized: 'WrongStatus',
} as const satisfies Record<string, ChainErrorCode>;

/**
 * Stage 1 error names that only the EVM contracts raise (not in `ERRORS`), checked against the pinned
 * `evm/src/types/MercesErrors.sol` by `errors.test.ts`.
 */
export const STAGE1_EVM_CODE = {
  ZeroAmount: 'WrongStatus',
  TermsCommitmentMismatch: 'InvalidCommitment',
  AttestationInFuture: 'InvalidTerms',
  // the EVM registry refuses curve mode right after the issuer check (MercesRegistry.sol:479-481)
  CurveModeUnsupported: 'NotPermitted',
  // the key registry (S4 WP5, D9; MercesRegistry.sol:315-345): a zero key address, a register of a key that is
  // already active, a revoke of a key that is not active (revoked or never registered alike), and a revoke of the last
  // active key; codes as the Solana names for the same cases
  ZeroAddress: 'InvalidTerms',
  KeyAlreadyActive: 'Duplicate',
  KeyNotRegistered: 'WrongStatus',
  LastActiveKey: 'NotPermitted',
} as const satisfies Record<string, ChainErrorCode>;

/** Every Stage 1 error name and its code: the chain-neutral names, then each chain's own. */
const ALL_CODES: Record<Stage1Error, ChainErrorCode> = { ...STAGE1_CODE, ...STAGE1_SOLANA_CODE, ...STAGE1_EVM_CODE };

/** The Stage 1 error names the simulator raises: `@merces/sdk`'s and the chain-only ones. */
export type Stage1Error = keyof typeof STAGE1_CODE | keyof typeof STAGE1_SOLANA_CODE | keyof typeof STAGE1_EVM_CODE;

export function stage1ChainError(name:string):ChainError { return new ChainError((ALL_CODES as Record<string,ChainErrorCode>)[name]??'ChainSpecific',name,{stage1:name}); }
