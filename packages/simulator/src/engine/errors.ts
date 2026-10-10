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
  // the registry's curve terms (create_series, lib.rs:470-485; S3 WP7)
  CurveThresholdZero: 'InvalidTerms',
  CurveTermsNotZero: 'InvalidTerms',
  CurveQuoteMintMismatch: 'InvalidTerms',
} as const satisfies Record<string, ChainErrorCode>;

/**
 * Stage 1 error names that only the EVM contracts raise (not in `ERRORS`), checked against the pinned
 * `evm/src/types/MercesErrors.sol` by `errors.test.ts`.
 */
export const STAGE1_EVM_CODE = {
  // the EVM registry refuses curve mode right after the issuer check (MercesRegistry.sol:479-481)
  CurveModeUnsupported: 'NotPermitted',
} as const satisfies Record<string, ChainErrorCode>;

/** Every Stage 1 error name and its code: the chain-neutral names, then each chain's own. */
const ALL_CODES: Record<Stage1Error, ChainErrorCode> = { ...STAGE1_CODE, ...STAGE1_SOLANA_CODE, ...STAGE1_EVM_CODE };

/** The Stage 1 error names the simulator raises: `@merces/sdk`'s and the chain-only ones. */
export type Stage1Error = keyof typeof STAGE1_CODE | keyof typeof STAGE1_SOLANA_CODE | keyof typeof STAGE1_EVM_CODE;

/**
 * Throw the `ChainError` for Stage 1 error `name`: its code from `STAGE1_CODE` (or a chain's own table),
 * `detail.stage1 = name`. The message is ours; it must never carry an income figure, salt, opening or document
 * (callers pass public facts only: names, ids, public amounts).
 */
export function fail(name: Stage1Error, message: string = name, extra?: Record<string, unknown>): never {
  throw new ChainError(ALL_CODES[name], message, { ...extra, stage1: name });
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
