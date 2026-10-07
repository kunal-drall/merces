//! Protocol error codes. Every failure has a distinct code and message (SPEC §12).

use anchor_lang::prelude::*;

#[error_code]
pub enum ProtocolError {
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Division by zero")]
    DivisionByZero,
    #[msg("Invalid input")]
    InvalidInput,
    #[msg("Clock returned a negative timestamp")]
    NegativeTimestamp,
    #[msg("Caller is not the series issuer")]
    NotIssuer,
    #[msg("Series is not a sealed-bid series")]
    NotSealedBid,
    #[msg("Series is not in Draft state")]
    NotDraft,
    #[msg("Contract hash is not set")]
    ContractHashNotSet,
    #[msg("New raises are paused")]
    NewRaisesPaused,
    #[msg("Wallet is not allowlisted")]
    NotAllowlisted,
    #[msg("Allowlist entry does not match the wallet")]
    AllowlistEntryMismatch,
    #[msg("Raise is not open")]
    RaiseNotOpen,
    #[msg("Raise already has bids")]
    RaiseHasBids,
    #[msg("Commit phase has ended")]
    CommitPhaseOver,
    #[msg("Not in the reveal phase")]
    NotRevealPhase,
    #[msg("Reveal phase has not ended")]
    RevealPhaseNotOver,
    #[msg("Escrow must be positive")]
    ZeroEscrow,
    #[msg("Bid already revealed")]
    AlreadyRevealed,
    #[msg("Commitment does not match the revealed values")]
    CommitmentMismatch,
    #[msg("Auction is not settling")]
    NotSettling,
    #[msg("Bid account is not a bid of this series")]
    BidSeriesMismatch,
    #[msg("Bid account is not the expected PDA")]
    BidPdaMismatch,
    #[msg("Too many bids in one tally page")]
    TallyPageTooLarge,
    #[msg("Not every revealed bid has been tallied in this round")]
    TallyIncomplete,
    #[msg("Proposed clearing price is not the uniform clearing price")]
    InvalidClearingPrice,
    #[msg("Auction has not settled or failed")]
    NotSettledOrFailed,
    #[msg("Bid already processed")]
    BidAlreadyProcessed,
    #[msg("Not every bid has been processed")]
    BidsNotProcessed,
    #[msg("Mint authority already revoked")]
    MintAuthorityAlreadyRevoked,
    #[msg("Stablecoin account mint mismatch")]
    StablecoinMismatch,
    #[msg("Token account owner mismatch")]
    TokenOwnerMismatch,
    #[msg("Token program is not the mint's owner")]
    TokenProgramMismatch,
    #[msg("Stablecoin transfer fee is not zero")]
    TransferFeeNotZero,
    #[msg("Mint account could not be read")]
    InvalidMint,
    #[msg("Fee collector token account is not owned by the configured fee collector")]
    FeeCollectorMismatch,
    #[msg("Unit mint does not match the series")]
    UnitMintMismatch,
    #[msg("Treasury releases are blocked until the mint is finalised")]
    MintNotFinalized,
    #[msg("Issuer has paused releases")]
    ReleasesPausedByIssuer,
    #[msg("Series is Late; releases are paused")]
    SeriesLate,
    #[msg("Series is extinguished")]
    SeriesExtinguished,
    #[msg("Nothing to release")]
    NothingToRelease,
    #[msg("Early-draw approver is not configured")]
    EarlyDrawApproverUnset,
    #[msg("Early-draw approver must co-sign")]
    EarlyDrawApproverMismatch,
    #[msg("Early draw exceeds the remaining proceeds")]
    EarlyDrawExceedsProceeds,
    #[msg("Series is terminal")]
    SeriesTerminal,
    #[msg("Series is retired; no reports are accepted")]
    SeriesRetired,
    #[msg("Series is redeemed; only tail reports within the tail window are accepted")]
    SeriesRedeemed,
    #[msg("Report period is not the next expected period")]
    WrongPeriod,
    #[msg("The period has not ended yet")]
    PeriodNotEnded,
    #[msg("A previous due amount is still open")]
    DueOutstanding,
    #[msg("Tier is not enabled for this series")]
    TierNotEnabled,
    #[msg("Tier 4 self-attestation is disabled")]
    Tier4Disabled,
    #[msg("fx_avg_wad must equal WAD for stablecoin income")]
    FxMustBeOne,
    #[msg("fx_avg_wad does not match the quarter average")]
    FxAverageMismatch,
    #[msg("FX pair needs a fallback rate; an attestor signature is required")]
    FxNeedsFallback,
    #[msg("FX fallback signature supplied but the pair did not need a fallback")]
    FxFallbackNotNeeded,
    #[msg("FX checkpoint account mismatch")]
    FxCheckpointMismatch,
    #[msg("Groth16 proof is invalid")]
    InvalidProof,
    #[msg("Proof bytes are malformed")]
    MalformedProof,
    #[msg("Public input is not a canonical field element")]
    PublicInputNotCanonical,
    #[msg("Attestation signature is malformed")]
    MalformedSignature,
    #[msg("Attestation signature recovery failed")]
    SignatureRecoveryFailed,
    #[msg("Recovered signer is not the supplied key")]
    SignerMismatch,
    #[msg("Verifier key is not active")]
    VerifierKeyInactive,
    #[msg("Attestor key is not active")]
    AttestorInactive,
    #[msg("Attestation key account is not the expected registry PDA")]
    KeyAccountMismatch,
    #[msg("Attestation required for this tier")]
    AttestationRequired,
    #[msg("No due amount to pay")]
    NothingDue,
    #[msg("Units outstanding is zero")]
    NoUnitsOutstanding,
    #[msg("Holder is not registered for this series")]
    HolderNotRegistered,
    #[msg("Holder token account is not the holder's associated token account")]
    HolderAtaMismatch,
    #[msg("Series is not retired")]
    NotRetired,
    #[msg("Series is not redeemed")]
    NotRedeemed,
    #[msg("Series is not extinguished")]
    NotExtinguished,
    #[msg("Lockup has not ended")]
    LockupActive,
    #[msg("No tail is due for this series")]
    NoTailDue,
    #[msg("Tail window has closed")]
    TailWindowClosed,
    #[msg("Holder has no redeemed units")]
    NoRedeemedUnits,
    #[msg("Pause not requested by the issuer")]
    PauseNotRequested,
    #[msg("Series is already paused")]
    AlreadyPaused,
    #[msg("Series is not paused")]
    NotPaused,
    #[msg("Pause end must be in the future")]
    PauseEndInPast,
    #[msg("The two extinguishment attestors must be distinct")]
    AttestorsNotDistinct,
    #[msg("True-up adjustment must be non-zero")]
    ZeroAdjustment,
    #[msg("No true-up is due")]
    NoTrueUpDue,
    #[msg("Series is not a tier 1 (split) series")]
    NotTierOne,
    #[msg("Router already initialised")]
    RouterAlreadyInitialized,
    #[msg("Nothing to route")]
    NothingToRoute,
    #[msg("FX pair is disabled in the registry")]
    FxPairDisabled,
    #[msg("A snapshot was already taken today")]
    SnapshotAlreadyTaken,
    #[msg("Pyth price feed id mismatch")]
    FeedIdMismatch,
    #[msg("Pyth price is stale")]
    PriceStale,
    #[msg("Pyth price is not positive")]
    PriceNotPositive,
    #[msg("Pyth confidence interval too wide")]
    ConfidenceTooWide,
    #[msg("Pyth price update is not fully verified")]
    InsufficientVerification,
    #[msg("Transfer windows are disabled")]
    WindowsDisabled,
    #[msg("Series status does not allow a window")]
    WindowStatusNotAllowed,
    #[msg("The report for this period is not paid")]
    ReportNotPaid,
    #[msg("Window period must be the quarter before the current one")]
    WindowWrongPeriod,
    #[msg("Window is not in the commit phase")]
    WindowNotCommit,
    #[msg("Window is not in the reveal phase")]
    WindowNotReveal,
    #[msg("Window reveal phase has not ended")]
    WindowRevealNotOver,
    #[msg("Window is not settling")]
    WindowNotSettling,
    #[msg("Window is not settled")]
    WindowNotSettled,
    #[msg("Invalid window clearing proposal")]
    InvalidWindowClearing,
    #[msg("Order account mismatch")]
    OrderMismatch,
    #[msg("Order already processed")]
    OrderAlreadyProcessed,
    #[msg("Bids must be processed before asks")]
    BidsBeforeAsks,
    #[msg("Dust must be fully returned before asks are processed")]
    DustNotReturned,
    #[msg("Return-dust order must be price-descending then reveal-index-descending")]
    DustOrderViolation,
    #[msg("Ask quantity exceeds escrowed units")]
    AskExceedsEscrow,
    #[msg("Destination balance would exceed the wallet cap")]
    WalletCapExceeded,
    #[msg("Window already open for this series")]
    WindowAlreadyOpen,
    #[msg("Wrong side for this instruction")]
    WrongSide,
    #[msg("Units must be positive")]
    ZeroUnits,
    #[msg("Per-year accumulator index out of range (series older than 64 years)")]
    YearIndexOutOfRange,
    #[msg("Proceeds must be known (mint finalised) before this action")]
    ProceedsUnknown,
    #[msg("Holder units must be zero or the holder's full balance")]
    PartialBurn,
}

impl From<merces_common::MathError> for ProtocolError {
    fn from(e: merces_common::MathError) -> Self {
        match e {
            merces_common::MathError::Overflow => ProtocolError::MathOverflow,
            merces_common::MathError::DivisionByZero => ProtocolError::DivisionByZero,
            merces_common::MathError::InvalidInput => ProtocolError::InvalidInput,
        }
    }
}

/// Maps a `MathError` into an Anchor error.
pub fn math(e: merces_common::MathError) -> Error {
    ProtocolError::from(e).into()
}
