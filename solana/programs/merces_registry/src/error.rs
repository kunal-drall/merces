//! Registry error codes. Every failure has a distinct code and message (SPEC §12).

use anchor_lang::prelude::*;

#[error_code]
pub enum RegistryError {
    #[msg("Caller is not authorised for this instruction")]
    Unauthorized,
    #[msg("Caller is not the protocol authority PDA")]
    NotProtocolAuthority,
    #[msg("Caller is not the pending admin")]
    NotPendingAdmin,
    #[msg("Address must not be zero")]
    ZeroAddress,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Issuer is not active")]
    IssuerInactive,
    #[msg("Issuer has stopped new issuance")]
    IssuanceStopped,
    #[msg("Wallet is not allowlisted")]
    NotAllowlisted,
    #[msg("Allowlist entry does not belong to this wallet")]
    AllowlistEntryMismatch,
    #[msg("units_offered must be at least 1")]
    UnitsOfferedZero,
    #[msg("reserve_price must be at least 1")]
    ReservePriceZero,
    #[msg("min_raise exceeds reserve_price × units_offered")]
    MinRaiseTooHigh,
    #[msg(
        "Release schedule must have 1..=24 tranches, bps summing to 10000, non-decreasing offsets"
    )]
    InvalidReleaseSchedule,
    #[msg("Tier flags must be non-zero and use only bits 0..=3")]
    InvalidTierFlags,
    #[msg("Unknown series mode")]
    InvalidMode,
    #[msg("Curve-mode series require issuer_accepts_public_price = true")]
    PublicPriceNotAccepted,
    #[msg("Metadata URI exceeds 200 bytes")]
    MetadataUriTooLong,
    #[msg("FX pair account missing, disabled or does not match fx_pair_id")]
    FxPairMismatch,
    #[msg("Stablecoin mint has a non-zero transfer fee")]
    TransferFeeNotZero,
    #[msg("Stablecoin mint could not be read")]
    InvalidStablecoinMint,
    #[msg("Series is not in Draft state")]
    NotDraft,
    #[msg("Contract hash must be non-zero")]
    ZeroContractHash,
    #[msg("Contract hash is not set; the raise cannot open")]
    ContractHashNotSet,
    #[msg("New raises are paused")]
    NewRaisesPaused,
    #[msg("Series is terminal")]
    SeriesTerminal,
    #[msg("Series is not a sealed-bid series")]
    NotSealedBid,
    #[msg("Series is not a curve-mode series")]
    NotCurveMode,
    #[msg("Invalid raise state transition")]
    InvalidRaiseTransition,
    #[msg("Raise results are written once")]
    RaiseResultAlreadyWritten,
    #[msg("Mint already finalised")]
    MintAlreadyFinalized,
    #[msg("Invalid terminal status")]
    InvalidTerminalStatus,
    #[msg("Terminal status transition not allowed")]
    InvalidTerminalTransition,
    #[msg("Attestor signature is malformed")]
    MalformedSignature,
    #[msg("Attestor signature recovery failed")]
    SignatureRecoveryFailed,
    #[msg("Recovered signer is not the supplied attestor address")]
    AttestorMismatch,
    #[msg("Attestor key is not active")]
    AttestorInactive,
    #[msg("Cap multiple may only decrease")]
    CapMultipleIncrease,
    #[msg("Attestor address must be non-zero")]
    ZeroAttestorAddress,
    #[msg("Invalid chain id")]
    InvalidChainId,
    #[msg("Key is already revoked")]
    KeyAlreadyRevoked,
    #[msg("The last active key of a kind cannot be revoked without a replacement")]
    LastKeyOfKind,
    #[msg("pair_id must equal keccak256(feed_id ‖ inverted)")]
    FxPairIdMismatch,
    #[msg("feed_id and inverted are write-once for an FX pair")]
    FxPairImmutable,
    #[msg("Wallet cap allows no bid: floor(units_offered × wallet_cap_bps / 10000) < 1")]
    WalletCapTooSmall,
    #[msg("Tier-1 series must supply plaintext router terms")]
    Tier1TermsRequired,
    #[msg("Tier-1 series must use stablecoin income (fx_pair_id = 0)")]
    Tier1NeedsStablecoinIncome,
    #[msg("Tier-1 series require r_wad × units_offered ≤ WAD")]
    Tier1ShareTooLarge,
    #[msg("Tier-1 terms do not hash to terms_commitment")]
    Tier1TermsMismatch,
    #[msg("Router terms supplied for a series without tier 1")]
    Tier1TermsUnexpected,
    #[msg("Poseidon hashing failed")]
    PoseidonFailed,
    // Parameter bounds (SPEC §1.6), one code per field
    #[msg("cap_multiple_wad out of bounds [2.0e18, 3.0e18]")]
    BoundCapMultiple,
    #[msg("hurdle_rate_wad out of bounds [0, 0.25e18]")]
    BoundHurdleRate,
    #[msg("payout_multiple_k out of bounds [1, 20]")]
    BoundPayoutMultiple,
    #[msg("lockup_seconds out of bounds [0, 157680000]")]
    BoundLockup,
    #[msg("wallet_cap_bps out of bounds [100, 10000]")]
    BoundWalletCap,
    #[msg("auction_fee_bps out of bounds [0, 1000]")]
    BoundAuctionFee,
    #[msg("payout_fee_bps out of bounds [0, 2000]")]
    BoundPayoutFee,
    #[msg("window_fee_bps out of bounds [0, 1000]")]
    BoundWindowFee,
    #[msg("non_reveal_charge_bps out of bounds [0, 1000]")]
    BoundNonRevealCharge,
    #[msg("commit_duration out of bounds [1 h, 30 d]")]
    BoundCommitDuration,
    #[msg("reveal_duration out of bounds [1 h, 7 d]")]
    BoundRevealDuration,
    #[msg("window_commit_duration out of bounds [1 h, 14 d]")]
    BoundWindowCommitDuration,
    #[msg("window_reveal_duration out of bounds [1 h, 7 d]")]
    BoundWindowRevealDuration,
    #[msg("fx_min_coverage_bps out of bounds [5000, 10000]")]
    BoundFxMinCoverage,
    #[msg("fx_max_staleness_seconds out of bounds [60, 86400]")]
    BoundFxMaxStaleness,
    #[msg("fx_max_conf_bps out of bounds [1, 1000]")]
    BoundFxMaxConf,
    #[msg("fx_deviation_band_bps out of bounds [10, 5000]")]
    BoundFxDeviationBand,
    #[msg("max_pause_seconds out of bounds [30 d, 730 d]")]
    BoundMaxPause,
    #[msg("max_cumulative_pause_seconds out of bounds [max_pause_seconds, 5 y]")]
    BoundMaxCumulativePause,
}

impl From<merces_common::params::ParamField> for RegistryError {
    fn from(f: merces_common::params::ParamField) -> Self {
        use merces_common::params::ParamField as F;
        match f {
            F::CapMultiple => RegistryError::BoundCapMultiple,
            F::HurdleRate => RegistryError::BoundHurdleRate,
            F::PayoutMultiple => RegistryError::BoundPayoutMultiple,
            F::Lockup => RegistryError::BoundLockup,
            F::WalletCap => RegistryError::BoundWalletCap,
            F::AuctionFee => RegistryError::BoundAuctionFee,
            F::PayoutFee => RegistryError::BoundPayoutFee,
            F::WindowFee => RegistryError::BoundWindowFee,
            F::NonRevealCharge => RegistryError::BoundNonRevealCharge,
            F::CommitDuration => RegistryError::BoundCommitDuration,
            F::RevealDuration => RegistryError::BoundRevealDuration,
            F::WindowCommitDuration => RegistryError::BoundWindowCommitDuration,
            F::WindowRevealDuration => RegistryError::BoundWindowRevealDuration,
            F::FxMinCoverage => RegistryError::BoundFxMinCoverage,
            F::FxMaxStaleness => RegistryError::BoundFxMaxStaleness,
            F::FxMaxConf => RegistryError::BoundFxMaxConf,
            F::FxDeviationBand => RegistryError::BoundFxDeviationBand,
            F::MaxPause => RegistryError::BoundMaxPause,
            F::MaxCumulativePause => RegistryError::BoundMaxCumulativePause,
        }
    }
}
