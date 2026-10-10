import { ChainError, type ChainErrorCode } from '@merces/domain';
import type { ErrorName } from '@merces/math';

/**
 * Stage 1 error names on simulator errors (S1 plan D4, §5.4).
 *
 * Every `ChainError` raised on a Stage 1 path carries `detail.stage1`, Stage 1's own error name (SPEC §11,
 * `@merces/sdk` `ERRORS`), beside our chain-neutral `ChainErrorCode`. The vector runner compares `detail.stage1`;
 * the API returns `detail` as is. `STAGE1_CODE` fixes the code each name travels with.
 */
export const STAGE1_CODE = {
  NotIssuer: 'Unauthorized',
  RaiseNotSettled: 'WrongPhase',
  TerminalStatus: 'WrongStatus',
  WrongPeriod: 'WrongPhase',
  ReportTooEarly: 'TooEarly',
  PaymentOutstanding: 'WrongStatus',
  TrueUpOutstanding: 'WrongStatus',
  TailEnded: 'TooLate',
  NoTailDue: 'WrongStatus',
  TierNotEnabled: 'NotPermitted',
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

/** The Stage 1 error names the simulator raises. */
export type Stage1Error = keyof typeof STAGE1_CODE;

/**
 * Throw the `ChainError` for Stage 1 error `name`: its code from `STAGE1_CODE`, `detail.stage1 = name`.
 * The message is ours; it must never carry an income figure, salt, opening or document (callers pass public
 * facts only: names, ids, public amounts).
 */
export function fail(name: Stage1Error, message: string = name, extra?: Record<string, unknown>): never {
  throw new ChainError(STAGE1_CODE[name], message, { ...extra, stage1: name });
}

/**
 * Run a call into Stage 1 code (sdk, reference, circuits). A `ChainError` passes through unchanged; anything else
 * (Stage 1's `RangeError`s and plain `Error`s, whose messages can embed the offending value, SDK bytes.ts
 * `assertRange`) becomes `ChainError('ChainSpecific', 'stage1 math rejected the inputs', {stage1: name})` with the
 * original message and stack dropped.
 */
export function guardStage1<T>(fn: () => T, name: ErrorName): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ChainError) throw e;
    throw new ChainError('ChainSpecific', 'stage1 math rejected the inputs', { stage1: name });
  }
}
