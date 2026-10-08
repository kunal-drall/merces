// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Every Merces error has a distinct name (SPEC §12). Names that SPEC fixes are kept verbatim.

// ---- generic ----
error ZeroAddress();
error AmountOutOfRange(uint256 amount);
error ParameterOutOfBounds(bytes32 parameter);
error SeriesNotFound(uint256 seriesId);

// ---- registry: roles ----
error NotAdmin();
error NotPendingAdmin();
error NotAllowlistManager();
error NotIssuer();
error NotProtocolContract();
error ChainIdMismatch(uint256 expected, uint256 actual);

// ---- registry: keys, pairs, issuers, series ----
error LastActiveKey();
error KeyNotRegistered(address key);
error KeyAlreadyActive(address key);
error FxPairExists(bytes32 pairId);
error UnknownFxPair(bytes32 pairId);
error IssuerNotActive();
error IssuanceStoppedByIssuer();
error IssuerNotAllowlisted();
error WalletNotAllowlisted(address wallet);
error StablecoinNotAllowed(address token);
error InvalidReleaseSchedule();
error MinRaiseTooHigh();
error InvalidUnitsOffered();
error InvalidReservePrice();
error InvalidTierFlags();
error WalletCapTooSmall();
error Tier1RequiresStablecoinIncome();
error Tier1RateTooHigh();
error TermsCommitmentMismatch();
error CurveModeUnsupported();
error SeriesNotDraft();
error ContractHashZero();
error SeriesTerminal();
error CapMultipleIncrease();
error AttestorNotRegistered(address signer);
error InvalidRaiseTransition();
error AlreadyTerminal();
error InvalidTerminalStatus();
error IdentityAlreadyRegistered();

// ---- auction ----
error NotAuction();
error RaiseNotDraft();
error ContractHashNotSet();
error NewRaisesPaused();
error NotSealedBid();
error RaiseNotOpen();
error BidsExist();
error CommitPhaseOver();
error BidAlreadyExists();
error ZeroEscrow();
error NotRevealPhase();
error BidNotFound();
error BidAlreadyRevealed();
error CommitmentMismatch();
error RevealNotOver();
error InvalidSettlementState();
error TallyInProgress();
error TallyPageTooLarge();
error TallyRangeInvalid();
error TallyIncomplete();
error InvalidClearingPrice();
error NotSettledOrFailed();
error BidAlreadyProcessed();
error BidNotProcessed();
error BidAlreadyDelivered();
error TooManyBids();
error UnitsMintedMismatch();

// ---- treasury ----
error NotTreasury();
error MintNotFinalized();
error ReleasesPausedByIssuer();
error SeriesIsLate();
error NothingVested();
error EarlyDrawsDisabled();
error EarlyDrawNotApproved();
error EarlyDrawExceedsProceeds();
error ProceedsAlreadySet();
error ProceedsMismatch();

// ---- income / verifier ----
error NotIncome();
error NotSettled();
error TerminalStatus();
error LiquidityEventRequired();
error TailEnded();
error NoTailDue();
error WrongPeriod(uint32 expected, uint32 actual);
error PeriodNotEnded();
error PreviousPeriodUnpaid();
error ReportExists();
error TierNotEnabled(uint8 tier);
error Tier4Disabled();
error FxMustBeWad();
error FxMismatch(uint64 expected, uint64 actual);
error FxFallbackNotNeeded();
error FxFallbackSignatureRequired();
error PriorCommitmentMismatch();
error InvalidProof();
error VerifierKeyNotRegistered(address signer);
error AttestationRequired();
error RouterPeriodNotClosed(uint32 period);
error NothingDue();
error ZeroAdjustment();
error TrueUpOutstanding();
error TrueUpYearNotEnded();
error TrueUpYearAlreadyRecorded();
error TrueUpYearUnreported();
error TrueUpExceedsPayments();
error NoTrueUpDue();
error PauseNotRequested();
error PauseAlreadyRequested();
error AlreadyPaused();
error NotPaused();
error PauseEndInPast();
error PauseTooLong();
error CumulativePauseExceeded();
error TooManyPauses();
error NotTierOne();
error RouterNotConfigured();
error PeriodNotEndedYet(uint32 period);
error FxPairDisabled(bytes32 pairId);
error SnapshotAlreadyTaken();
error InvalidPythPrice();
error PythConfidenceTooWide();
error PythUpdateFeeInsufficient();

// ---- vault ----
error NotVault();
error NoUnitsOutstanding();
error HolderNotRegistered(address holder);
error SeriesNotRetired();
error SeriesNotRedeemed();
error SeriesNotExtinguished();
error LockupActive();
error OutstandingDue();
error UnreportedPeriods();
error DuplicateAttestor();
error InvalidSource();
error SupplyAlreadySet();
error NotCapped();

// ---- window ----
error WindowsDisabled();
error WindowNotEligibleStatus();
error ReportNotPaid();
error WrongWindowPeriod(uint32 expected, uint32 actual);
error WindowAlreadyOpen();
error NoActiveWindow();
error OrderAlreadyExists();
error OrderNotFound();
error OrderAlreadyRevealed();
error OrderAlreadyProcessed();
error ZeroUnits();
error WindowNotSettled();
error OutOfOrder();
error BidsPending();
error NothingHeld();
error CannotReceiveUnits();
error InvalidProposal();
error TooManyOrders();

// ---- token-facing (mirrors the Solana hook error names) ----
error DirectTransferForbidden();
error UnarmedEscrowDeposit();
