// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Every Merces error has a distinct name (SPEC §12). Names that SPEC fixes are kept verbatim.

// ---- generic ----
error ZeroAddress();
error ZeroAmount();
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
error IssuerInactive();
error IssuerIssuanceStopped(); // canonical name `IssuanceStopped` is taken by the SPEC §10 event
error IssuerNotAllowlisted();
error NotAllowlisted(address wallet);
error StablecoinNotAllowed(address token);
error InvalidReleaseSchedule();
/// @dev `reason` ∈ {"unitsOffered", "reservePrice", "minRaise", "walletCap", "tier1Rate"} (SPEC §3.2 / §1.6).
error InvalidTerms(bytes32 reason);
error InvalidTierFlags();
error Tier1RequiresStablecoinIncome();
error RouterNotEnabled();
error TermsCommitmentMismatch();
error CurveModeUnsupported();
error SeriesNotDraft();
error ContractHashZero();
error AmendmentAfterTerminal();
error UnfavourableAmendment();
error InvalidAttestorSignature(address signer);
error InvalidRaiseTransition();
error AlreadyTerminal();
error InvalidTerminalStatus();
error IdentityAlreadyRegistered();

// ---- auction ----
error NotAuction();
error RaiseNotDraft();
error ContractHashMissing();
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

// ---- treasury ----
error NotTreasury();
error MintNotFinalized();
error ReleasesPaused();
error SeriesLate();
error NothingVested();
error EarlyDrawDisabled();
error EarlyDrawNotApproved();
error ExceedsProceeds();
error ProceedsAlreadySet();
error ProceedsMismatch();

// ---- income / verifier ----
error NotIncome();
error TailEnded();
error NoTailDue();
error WrongPeriod(uint32 expected, uint32 actual);
error ReportTooEarly();
error PaymentOutstanding();
error ReportExists();
/// @dev Tier not enabled for the series, tier 1 on a mixed series, or the tier-4 flag off (SPEC §6.2 step 3).
error TierNotEnabled(uint8 tier);
error FxMustBeWad();
error FxMismatch(uint256 expected, uint256 actual);
error FxFallbackNotAllowed();
error FxFallbackRequired();
error PriorCommitmentMismatch();
error IncomeCommitmentMismatch();
error InvalidProof();
error InvalidVerifierSignature(address signer);
error AttestationRequired();
error RouterPeriodNotClosed(uint32 period);
error NothingDue();
error ZeroAdjustment();
error TrueUpOutstanding();
/// @dev True-up year not complete, already trued up, or missing reports (SPEC §6.2).
error TrueUpYearInvalid();
error TrueUpAdjustmentTooLarge();
error PauseNotRequested();
error PauseAlreadyRequested();
error AlreadyPaused();
error NotPaused();
error InvalidPauseEnd();
/// @dev One approval above `max_pause_seconds` or the lifetime above `max_cumulative_pause_seconds`.
error PauseTooLong();
error TooManyPauses();
error NotRouter();
error AttestationInFuture();
error RouterNotConfigured();
error PeriodNotEndedYet(uint32 period);
error FxPairDisabled(bytes32 pairId);
error SnapshotAlreadyTaken();
error InvalidPythPrice();
error ConfidenceTooWide();
error PythUpdateFeeInsufficient();

// ---- vault ----
error NotVault();
error NoUnitsOutstanding();
error HolderNotRegistered(address holder);
error SeriesNotRetired();
error NotRedeemed();
error SeriesNotExtinguished();
error LockupActive();
error UnreportedPeriods();
/// @dev Redemption / final claims wait until the series' window has no open or unprocessed orders.
error WindowPending();
error SameAttestor();
error InvalidSource();
error SupplyAlreadySet();

// ---- window ----
error WindowsDisabled();
/// @dev Status, report or period precondition of `open_window` failed (SPEC §7).
error WindowNotEligible();
error WindowOpen();
error WindowNotOpen();
error OrderExists();
error OrderNotFound();
error OrderAlreadyRevealed();
error OrderAlreadyProcessed();
error ZeroUnits();
error InsufficientUnits();
error OutOfOrder();
error BidsPending();
error InvalidProposal();
error TooManyOrders();

// ---- token-facing (mirrors the Solana hook error names) ----
error DirectTransferForbidden();
error UnarmedEscrowDeposit();
