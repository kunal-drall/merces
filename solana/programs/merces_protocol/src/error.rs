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
    // ---- raise
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
    #[msg("A settlement tally is in progress; it cannot be reset")]
    TallyInProgress,
    #[msg("Auction is not settling")]
    NotSettling,
    #[msg("Bid account is not a bid of this series")]
    BidSeriesMismatch,
    #[msg("Bid account is not the expected PDA")]
    BidPdaMismatch,
    #[msg("Too many accounts in one tally page")]
    TallyPageTooLarge,
    #[msg("Not every revealed bid has been tallied in this round")]
    TallyIncomplete,
    #[msg("Auction has not settled or failed")]
    NotSettledOrFailed,
    #[msg("The raise is not Settled")]
    RaiseNotSettled,
    #[msg("Bid already processed")]
    BidAlreadyProcessed,
    #[msg("Bid has not been processed yet")]
    BidNotProcessed,
    #[msg("Bid already delivered")]
    BidAlreadyDelivered,
    #[msg("Minted units do not equal units sold")]
    MintedUnitsMismatch,
    #[msg("Treasury deposits do not sum to the proceeds")]
    ProceedsMismatch,
    #[msg("Escrow token account is not the recorded protocol escrow")]
    EscrowAccountMismatch,
    // ---- tokens
    #[msg("Stablecoin account mint mismatch")]
    StablecoinMismatch,
    #[msg("Token program is not the mint's owner")]
    TokenProgramMismatch,
    #[msg("Stablecoin transfer fee is not zero")]
    TransferFeeNotZero,
    #[msg("Mint account could not be read")]
    InvalidMint,
    #[msg("Token account is not the expected associated token account")]
    AtaMismatch,
    #[msg("Unit mint does not match the series")]
    UnitMintMismatch,
    // ---- treasury
    #[msg("Mint is not finalised")]
    MintNotFinalized,
    #[msg("Issuer has paused releases")]
    ReleasesPausedByIssuer,
    #[msg("Series is Late; releases are blocked")]
    SeriesLate,
    #[msg("Series is extinguished")]
    SeriesExtinguished,
    #[msg("Nothing vested to release")]
    NothingVested,
    #[msg("Early-draw approver is not configured")]
    EarlyDrawApproverUnset,
    #[msg("Early-draw approver must co-sign")]
    EarlyDrawApproverMismatch,
    #[msg("Early draw exceeds the remaining proceeds")]
    EarlyDrawExceedsProceeds,
    // ---- reports
    #[msg("Series is in a terminal status")]
    TerminalStatus,
    #[msg("Report period is not the next expected period")]
    WrongPeriod,
    #[msg("The period has not ended yet")]
    PeriodNotEnded,
    #[msg("A previous due amount is still open")]
    DueOutstanding,
    #[msg("Tail reporting window has ended")]
    TailEnded,
    #[msg("No tail is due for this series")]
    NoTailDue,
    #[msg("Tier is not enabled for this series")]
    TierNotEnabled,
    #[msg("Tier 1 reports are only valid for pure on-chain-income series")]
    Tier1NotExclusive,
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
    #[msg("FX accumulator or checkpoint account mismatch")]
    FxCheckpointMismatch,
    #[msg("Prior income commitment does not match the chain")]
    PriorCommitmentMismatch,
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
    #[msg("Verifier key is not active (or outside its revocation grace)")]
    VerifierKeyInactive,
    #[msg("Attestor key is not active (or outside its revocation grace)")]
    AttestorInactive,
    #[msg("Attestation key account is not the expected registry PDA")]
    KeyAccountMismatch,
    #[msg("Attestation required for this tier")]
    AttestationRequired,
    #[msg("Router checkpoint for the period is missing")]
    RouterPeriodNotClosed,
    #[msg("Router account required for a tier 1 report")]
    RouterRequired,
    #[msg("Income commitment does not match the router checkpoint")]
    RouterCommitmentMismatch,
    #[msg("No due amount to pay")]
    NothingDue,
    #[msg("Units outstanding is zero")]
    NoUnitsOutstanding,
    // ---- true-ups
    #[msg("A true-up was already recorded for this year")]
    TrueUpYearUsed,
    #[msg("True-up year has not ended")]
    TrueUpYearNotEnded,
    #[msg("Not every period of the true-up year has an accepted report")]
    TrueUpYearIncomplete,
    #[msg("The previous true-up is still unpaid")]
    TrueUpOutstanding,
    #[msg("Negative true-up exceeds the year's accepted payments")]
    TrueUpExceedsYear,
    #[msg("True-up attestation timestamp is in the future")]
    TrueUpTimestampInFuture,
    #[msg("No true-up is due")]
    NoTrueUpDue,
    // ---- holders
    #[msg("Holder is not registered for this series")]
    HolderNotRegistered,
    #[msg("Series is not retired")]
    NotRetired,
    #[msg("Series is not redeemed")]
    NotRedeemed,
    #[msg("Series is not extinguished")]
    NotExtinguished,
    #[msg("Lockup has not ended")]
    LockupActive,
    #[msg("Holder has no redeemed units")]
    NoRedeemedUnits,
    #[msg("Pending auction or window units must be delivered first (deliver_bid / deliver_order)")]
    DeliverFirst,
    #[msg("Units escrowed in a window must be processed before redemption")]
    AskEscrowOutstanding,
    #[msg("Units must be positive")]
    ZeroUnits,
    // ---- pauses
    #[msg("Pause not requested by the issuer")]
    PauseNotRequested,
    #[msg("Series is already paused")]
    AlreadyPaused,
    #[msg("Series is not paused")]
    NotPaused,
    #[msg("Pause end must be in the future")]
    PauseEndInPast,
    #[msg("Pause exceeds max_pause_seconds")]
    PauseTooLong,
    #[msg("Cumulative pause exceeds max_cumulative_pause_seconds")]
    PauseCumulativeExceeded,
    #[msg("Pause history is full")]
    TooManyPauses,
    // ---- redemption / extinguishment
    #[msg("Ended periods are unreported")]
    UnreportedPeriods,
    #[msg("The two extinguishment attestors must be distinct")]
    AttestorsNotDistinct,
    #[msg("Cap is not yet met")]
    NotCapped,
    // ---- router
    #[msg("Series is not a tier 1 (split) series")]
    NotTierOne,
    #[msg("Nothing to route")]
    NothingToRoute,
    #[msg("Router period has not ended")]
    RouterPeriodNotEnded,
    #[msg("Router period already closed")]
    RouterPeriodAlreadyClosed,
    // ---- fx
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
    #[msg("The pair's cross-check price update is required for this period")]
    CrosscheckRequired,
    // ---- window
    #[msg("Transfer windows are disabled")]
    WindowsDisabled,
    #[msg("Series status does not allow a window")]
    WindowStatusNotAllowed,
    #[msg("The report for this period is not paid")]
    ReportNotPaid,
    #[msg("Window period must be the quarter before the current one")]
    WindowWrongPeriod,
    #[msg("Window already open for this series")]
    WindowAlreadyOpen,
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
    #[msg("Order account mismatch")]
    OrderMismatch,
    #[msg("Order already processed")]
    OrderAlreadyProcessed,
    #[msg("Orders must be processed in reveal order: bids first, then asks")]
    OutOfOrder,
    #[msg("Ask quantity exceeds the holder's unit balance")]
    AskExceedsBalance,
    #[msg("Wrong side for this instruction")]
    WrongSide,
    #[msg("Escrow arm is busy")]
    EscrowArmBusy,
    #[msg("Order has not been processed yet")]
    OrderNotProcessed,
    #[msg("Order already delivered")]
    OrderAlreadyDelivered,
    #[msg("Cancelled buyer units exceed the at-price asks: a take-back threshold must be settled first")]
    TakebackRequired,
    #[msg("No take-back threshold is needed for this window")]
    TakebackNotRequired,
    #[msg("A take-back round is in progress; it cannot be reset")]
    TakebackInProgress,
    #[msg("No take-back round is being tallied")]
    TakebackNotTallying,
    #[msg("The take-back threshold is already settled")]
    TakebackAlreadySettled,
    #[msg("Every revealed bid must be processed before asks and take-back rounds")]
    BidsNotProcessed,
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
