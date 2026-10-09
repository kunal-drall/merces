// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Every Merces error has a distinct name (SPEC §12). Where SPEC v1.1 / `@merces/sdk` `errors.ts` fixes a
/// canonical name (the parity vectors' `expect_revert` names) it is used verbatim; EVM-only conditions carry their
/// own distinct names. Selectors are what the vector runner matches (`test/parity/VectorRunner.t.sol`).

// ---- conventions (SPEC §1.1) ----
error ZeroAddress();
error ZeroAmount();
/// @dev Entry-point range rule: an externally supplied amount, price, quantity, escrow, `payment_usd`,
/// `fx_avg_wad`, adjustment or timestamp above `2^64 − 1` (`i64` for signed), or a derived due that does not fit.
error AmountOutOfRange(uint256 amount);
error TransferFailed();
error ParameterOutOfBounds(bytes32 parameter);
error SeriesNotFound(uint256 seriesId);

// ---- registry: roles ----
error NotAdmin();
error NotPendingAdmin();
error NotAllowlistManager();
error NotIssuer();
error NotProtocolContract();
error ChainIdMismatch(uint256 expected, uint256 actual);
error RaiseNotSettled();
error TerminalStatus();

// ---- registry: keys, pairs, issuers, series ----
error LastActiveKey();
error KeyNotRegistered(address key);
error KeyAlreadyActive(address key);
error FxPairExists(bytes32 pairId);
error UnknownFxPair(bytes32 pairId);
error CrosscheckUnchanged(bytes32 pairId);
error IssuerInactive();
// The canonical error `IssuanceStopped` shares its name with the SPEC §10 registry event; it is declared in
// `RegistryErrors` below so both keep their canonical names.
error NotAllowlisted(address wallet);
error StablecoinNotAllowed(address token);
error InvalidReleaseSchedule();
/// @dev `reason` ∈ {"unitsOffered", "reservePrice", "minRaise", "walletCap", "tier1Rate", "tier1Fx"}.
error InvalidTerms(bytes32 reason);
error InvalidTierFlags();
error RouterNotEnabled();
error TermsCommitmentMismatch();
error CurveModeUnsupported();
error SeriesNotDraft();
error ContractHashMissing();
error AmendmentAfterTerminal();
error UnfavourableAmendment();
error InvalidAttestorSignature(address signer);
error InvalidRaiseTransition();
error AlreadyTerminal();
error InvalidTerminalStatus();

// ---- auction (SPEC §5.2) ----
error RaiseNotDraft();
error NewRaisesPaused();
error NotSealedBid();
error RaiseNotOpen();
error BidsExist();
error CommitPhaseClosed();
error BidExists();
error ZeroEscrow();
error RevealNotStarted();
error RevealPhaseClosed();
error BidNotFound();
error AlreadyRevealed();
error CommitmentMismatch();
error SettlementNotReady();
error NotSettling();
error TallyInProgress();
error TallyPageTooLarge();
error TallyRangeInvalid();
error TallyIncomplete();
error AlreadyProcessed();
error NotProcessed();
error AlreadyDelivered();
error TooManyBids();
error UnitsMintedMismatch();

// ---- treasury (SPEC §5.3) ----
error MintNotFinalized();
error ReleasesPaused();
error SeriesLate();
error NothingVested();
error EarlyDrawDisabled();
error EarlyDrawNotApproved();
error ExceedsProceeds();
error ProceedsAlreadySet();
error ProceedsMismatch();

// ---- reports, payments, true-up, pauses (SPEC §6.2, §6.4) ----
error TailEnded();
error NoTailDue();
error WrongPeriod(uint32 expected, uint32 actual);
error ReportTooEarly();
error PaymentOutstanding();
/// @dev Tier not enabled for the series, tier 1 on a mixed series, or the tier-4 flag off (SPEC §6.2 step 3).
error TierNotEnabled(uint8 tier);
error FxMismatch(uint256 expected, uint256 actual);
error FxFallbackNotAllowed();
error FxFallbackRequired();
/// @dev Groth16 verification failed, or a commitment the proof opens does not match the chain (prior commitment,
/// tier-1 router binding).
error InvalidProof();
error InvalidVerifierSignature(address signer);
error RouterPeriodNotClosed(uint32 period);
error NothingDue();
error TrueUpOutstanding();
/// @dev True-up year not complete, already trued up, before the settlement year, or with unreported periods.
error TrueUpYearInvalid();
error TrueUpAdjustmentTooLarge();
error AttestationInFuture();
error PauseNotRequested();
error AlreadyPaused();
error NotPaused();
error InvalidPauseEnd();
/// @dev One approval above `max_pause_seconds` or the lifetime above `max_cumulative_pause_seconds`.
error PauseTooLong();
error TooManyPauses();
error NotRouter();

// ---- FX accumulator (SPEC §6.6) ----
/// @dev Pyth update older than `fx_max_staleness_seconds`, non-positive, or for another feed. Same selector as
/// Pyth's own `PythErrors.StalePrice()`.
error StalePrice();
error ConfidenceTooWide();
error SnapshotAlreadyTaken();
error UnsupportedExponent(int32 expo);
error PythUpdateFeeInsufficient();

// ---- vault and exit path (SPEC §6.3, §6.7–§6.9) ----
error NoUnitsOutstanding();
error HolderNotRegistered(address holder);
error NotRedeemed();
error NoRedeemedUnits(address holder);
error LockupActive();
error UnreportedPeriods();
error SameAttestor();
error InvalidSource();
error SupplyAlreadySet();

// ---- transfer window (SPEC §7) ----
error WindowsDisabled();
/// @dev Status, report or period precondition of `open_window` failed (SPEC §7).
error WindowNotEligible();
error WindowOpen();
error WindowNotOpen();
error OrderExists();
error InsufficientUnits();
/// @dev A window order processed ahead of the order its fill depends on (asks wait for every bid).
error OutOfOrder();
error InvalidProposal();
error TooManyOrders();
/// @dev A cancelled buyer's units reach below the clearing price and the ask price index is not complete yet.
error PriceIndexIncomplete();
error PriceIndexInvalid();

// ---- token-facing (mirrors the Solana hook error names; raised by `MercesComplianceModule`) ----
error DirectTransferForbidden();
error UnarmedEscrowDeposit();

/// @notice Errors whose canonical name collides with a SPEC §10 event name in the same contract.
library RegistryErrors {
    /// @dev Canonical `IssuanceStopped`: the issuer has stopped new issuance.
    error IssuanceStopped();
}
