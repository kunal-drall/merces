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
 * Since S3 a segregated family is ported from Stage 1's Rust (merces-common @1bfc66b; A-MATH-3), because Stage 1's
 * TypeScript has no `unit_scale` and no curve code: the unit scale, the vault, tail and redemption at a scale, and
 * curve mode's P0, offer check, units outstanding, migration-fee split and tender quota. They are not Stage 1 objects.
 * At scale 1 each scale-aware function returns Stage 1's own function's result (it calls it), so sealed-bid series
 * still run only Stage 1's functions; `stage1:sync` lists the family as ported and checks its Rust sources at the pin.
 *
 * Since S4 it is also the one gateway to Stage 1's signing primitives (A-SIG-1): the six signed messages, secp256k1
 * signing and recovery, the deployment domain, the series key, the keccak bid commitment and the wallet encodings, all
 * Stage 1's own objects. Stage 1's test-key derivation (`deriveTestPrivateKey`) is deliberately not exported here: it
 * lives on the subpath `@merces/math/testing`, which only tests, the harness, the vector runner, the local KMS and the
 * dev seeds may import (a grep gate in `test/math.test.ts` keeps it out of every other `src`).
 *
 * The interim Merces math (Part C) survives only under `interim.*`, and since S2 only the window cap (`walletCapUnits`;
 * S5; a curve raise has no cap since S3) and the FX family (`quarterAverageRate`, `coverageOk`, `deviationBps`, `withinBand`,
 * `pythToWad`; S5). The sealed-bid auction is Stage 1's family below (S2).
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
  // signed messages (SPEC §1.4, messages.ts): the digest is the raw keccak256 of the pre-image, no EIP-191 prefix.
  // `@merces/domain` wraps them as hex-in, hex-out `reportDigest` … `trueUpDigest` (signing.ts); these keep the SDK's names.
  MAGIC,
  reportAttestationMessage,
  fxFallbackMessage,
  amendmentMessage,
  pauseApprovalMessage,
  extinguishMessage,
  trueUpMessage,
  type MagicName,
  type SignedMessage,
  // secp256k1 signatures (SPEC §1.4, signatures.ts): 65 bytes r ‖ s ‖ v, v ∈ {27, 28}, low-s; a key is its 20-byte
  // address. The test-key derivation is not here: it is `@merces/math/testing` (test, harness and dev seeds only).
  SECP256K1_N,
  SECP256K1_HALF_N,
  isLowS,
  signDigest,
  parseSignature,
  publicKeyFromPrivate,
  addressFromPublicKey,
  addressFromPrivateKey,
  recoverAddress,
  verifySignature,
  toChecksumAddress,
  type Signature65,
  // keccak commitments and identifiers (SPEC §1.3, commitments.ts). Stage 1's `bidCommitment(price, quantity, salt,
  // wallet32)` returns bytes and is `bidCommitmentBytes` here; `@merces/domain`'s `bidCommitment` returns the 0x-hex.
  ChainKind,
  SOLANA_CLUSTER_TAGS,
  EVM_CHAIN_IDS,
  bidCommitment as bidCommitmentBytes,
  bidCommitmentPreimage,
  computeDomain,
  seriesKeyFromId,
  // wallets (32 bytes on both chains, bytes.ts) and keccak256 (hash.ts)
  walletFromSolanaPubkey,
  walletFromEvmAddress,
  evmAddressFromWallet,
  keccak256,
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
  lateAccrualTrueup,
  trueupNoticeDue,
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

// ---------------------------------------------------------------- curve (ported from merces-common @1bfc66b; not Stage 1 objects)
// A-MATH-3. Stage 1's TypeScript has no `unit_scale`; until it ships one these are ports of its Rust, pinned to Stage 1's
// Rust tests and fixtures. At scale 1 the scale-aware ones call Stage 1's own function (`vaultReceiveGross`,
// `tailReceive`, `redemptionQuote`, `isCapped`; `capRemainingScaled` our `capRemaining`, Stage 1's `C_remaining`).
export {
  // the unit scale (curve.rs:13-22, vault.rs:125-156)
  CURVE_BASE_DECIMALS,
  CURVE_UNIT_SCALE,
  unitScaleFor,
  wadPerScaledUnit,
  scaledCapWad,
  scaledAmount,
  // the vault, the tail and the redemption at a scale (vault.rs:48-78, :167-170; redemption.rs:101-141)
  isCappedScaled,
  vaultReceiveGrossScaled,
  tailReceiveScaled,
  capRemainingScaled,
  redemptionQuoteScaled,
  type RedemptionInputsScaled,
  // curve mode (curve.rs:24-112)
  p0PerUnit,
  swapBaseMatchesOffer,
  unitsOutstanding,
  migrationFeeSplit,
  walletTenderFits,
  type MigrationFeeSplit,
} from './curve/index.ts';
