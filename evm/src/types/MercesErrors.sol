// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Every Merces error has a distinct name (SPEC §12). Names that SPEC fixes are kept verbatim.

// ---- generic ----
error ZeroAddress();
error AmountExceedsU64(uint256 amount);
error ParameterOutOfBounds(bytes32 parameter);
error SeriesNotFound(uint256 seriesId);
error Unauthorized();

// ---- registry: roles ----
error NotAdmin();
error NotPendingAdmin();
error NotAllowlistManager();
error NotIssuer();
error NotProtocolContract();
error ChainIdMismatch(uint256 expected, uint256 actual);
error ProtocolContractsAlreadySet();
error ProtocolContractsNotSet();

// ---- registry: issuers and series ----
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
error UnknownFxPair(bytes32 pairId);
error CurveModeUnsupported();
error SeriesNotDraft();
error ContractHashZero();
error SeriesTerminal();
error CapMultipleIncrease();
error AttestorNotRegistered(address signer);
error InvalidRaiseTransition();
error UnitsSoldIncrease();
error AlreadyTerminal();
error InvalidTerminalStatus();

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
error TallyPageTooLarge();
error TallyRangeInvalid();
error TallyIncomplete();
error InvalidClearingPrice();
error NotSettledOrFailed();
error BidAlreadyProcessed();
error TooManyBids();

// ---- treasury ----
error NotTreasury();
error MintNotFinalized();
error ReleasesPausedByIssuer();
error SeriesIsLate();
error SeriesIsExtinguished();
error NothingToRelease();
error EarlyDrawsDisabled();
error EarlyDrawNotApproved();
error EarlyDrawExceedsProceeds();
error ProceedsAlreadyFinalized();

// ---- income / verifier ----
error NotIncome();
error NotSettled();
error ReportsClosed();
error LiquidityEventRequired();
error TailWindowClosed();
error NoTailDue();
error WrongPeriod(uint32 expected, uint32 actual);
error PeriodNotEnded();
error PreviousPeriodUnpaid();
error TierNotEnabled(uint8 tier);
error Tier4Disabled();
error FxMustBeWad();
error FxMismatch(uint64 expected, uint64 actual);
error FxFallbackNotNeeded();
error FxFallbackSignatureRequired();
error InvalidProof();
error VerifierKeyNotRegistered(address signer);
error AttestationRequired();
error NothingDue();
error ZeroAdjustment();
error TrueUpSignatureUsed();
error NoTrueUpDue();
error PauseNotRequested();
error PauseAlreadyRequested();
error AlreadyPaused();
error NotPaused();
error PauseEndInPast();
error NotTierOne();
error RouterNotConfigured();
error FxPairDisabled(bytes32 pairId);
error SnapshotAlreadyTaken();
error InvalidPythPrice();
error PythConfidenceTooWide();
error PythUpdateFeeInsufficient();
error NoProofRequired();

// ---- vault ----
error NotVault();
error NoUnitsOutstanding();
error HolderNotRegistered(address holder);
error NothingToClaim();
error SeriesNotRetired();
error SeriesNotRedeemed();
error SeriesNotExtinguished();
error LockupActive();
error OutstandingDue();
error DuplicateAttestor();
error InvalidSource();

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
error OrdersAlreadyProcessed();
error NothingHeld();
error CannotReceiveUnits();
error InvalidProposal();

// ---- token-facing (mirrors the Solana hook error names) ----
error DirectTransferForbidden();
