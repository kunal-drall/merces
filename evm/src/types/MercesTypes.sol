// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Shared enums and structs for the Merces EVM contracts (SPEC v1.1 §1.6, §1.7, §3.1).
/// All money amounts are stablecoin base units and must fit in uint64; ratios are WAD (1e18) fixed point;
/// basis points are uint16 with 10_000 = 100%.

enum SeriesMode {
    SealedBid,
    Curve
}

enum RaiseState {
    Draft,
    Open,
    Reveal,
    Settling,
    Settled,
    Failed,
    Cancelled
}

enum SeriesStatus {
    OnTime,
    InGrace,
    Late,
    Paused,
    Retired,
    Redeemed,
    Extinguished
}

enum PayoutSource {
    Payment,
    Router,
    Tail,
    Final
}

/// @notice Protocol-level defaults (SPEC §1.6). Editable by the admin for future series only.
struct Parameters {
    uint64 capMultipleWad;
    uint64 hurdleRateWad;
    uint16 payoutMultipleK;
    uint64 lockupSeconds;
    uint16 walletCapBps;
    uint16 auctionFeeBps;
    uint16 payoutFeeBps;
    uint16 windowFeeBps;
    uint16 nonRevealChargeBps;
    uint64 commitDuration;
    uint64 revealDuration;
    uint64 windowCommitDuration;
    uint64 windowRevealDuration;
    uint16 fxMinCoverageBps;
    uint64 fxMaxStalenessSeconds;
    uint16 fxMaxConfBps;
    uint16 fxDeviationBandBps;
    uint64 maxPauseSeconds;
    uint64 maxCumulativePauseSeconds;
}

/// @notice Issuer-chosen series parameters at creation (SPEC §3.2 `create_series`). Every field is a full word so
/// out-of-domain inputs revert with the canonical error (`AmountOutOfRange` for the money amounts, bounds for the
/// rest, SPEC §1.1 / §1.6) instead of failing ABI decoding. Fee rates, the non-reveal charge and the pause
/// limits are protocol economics and are copied from the registry defaults in force at creation.
struct SeriesParams {
    address stablecoin;
    uint256 unitsOffered;
    uint256 reservePrice;
    uint256 minRaise;
    uint256 capMultipleWad;
    uint256 hurdleRateWad;
    uint256 payoutMultipleK;
    uint256 lockupSeconds;
    uint256 walletCapBps;
    uint256 commitDuration;
    uint256 revealDuration;
    uint256 windowCommitDuration;
    uint256 windowRevealDuration;
}

/// @notice Plaintext terms of a tier-1 (on-chain income) series (SPEC §6.5). Public by the issuer's choice;
/// checked on-chain against the Poseidon(5) terms commitment. `theta` and `rWad` must fit uint64.
struct Tier1Terms {
    uint256 theta;
    uint256 rWad;
    uint32 currencyCode;
    uint32 indexingRule;
    uint256 termsSalt;
}

struct ReleaseTranche {
    uint64 atOffsetSeconds;
    uint16 bps;
}

/// @notice Router terms as stored (range-checked from `Tier1Terms`).
struct RouterTerms {
    uint64 theta;
    uint64 rWad;
}

/// @notice Charter terms of a series. Immutable once the raise opens (SPEC §3.3), except `capMultipleWad`
/// which may only decrease through `amendTerms`.
struct SeriesTerms {
    uint64 unitsOffered;
    uint64 reservePrice;
    uint64 minRaise;
    uint64 capMultipleWad;
    uint64 hurdleRateWad;
    uint16 payoutMultipleK;
    uint64 lockupSeconds;
    uint16 walletCapBps;
    uint16 auctionFeeBps;
    uint16 payoutFeeBps;
    uint16 windowFeeBps;
    uint16 nonRevealChargeBps;
    uint64 commitDuration;
    uint64 revealDuration;
    uint64 windowCommitDuration;
    uint64 windowRevealDuration;
    uint64 maxPauseSeconds;
    uint64 maxCumulativePauseSeconds;
}

/// @notice Identity, raise results and amendable fields of a series.
struct SeriesCore {
    address issuer;
    SeriesMode mode;
    uint8 stablecoinDecimals;
    RaiseState raiseState;
    /// @dev 0 = none, otherwise uint8(SeriesStatus) ∈ {Retired, Redeemed, Extinguished}.
    uint8 terminalStatus;
    uint8 tierFlags;
    bool issuerAcceptsPublicPrice;
    bool mintFinalized;
    address stablecoin;
    uint64 openedAt;
    address unitToken;
    uint64 settlementTs;
    uint64 unitsSold;
    uint64 clearingPrice;
    uint64 amendmentNonce;
    bytes32 contractHash;
    bytes32 termsCommitment;
    bytes32 fxPairId;
}

struct Issuer {
    bool registered;
    bool active;
    bool issuanceStopped;
    uint32 seriesCount;
}

/// @notice Attestor / report-verifier key record (SPEC §1.4): revocation is forward-only with a grace window.
struct KeyInfo {
    bool registered;
    bool active;
    uint64 revokedAt;
}

/// @notice FX pair configuration (SPEC §3.1). `feedId` and `inverted` are write-once (the pair id commits to
/// them); `crosscheck` changes take effect from `crosscheckEffectivePeriod`.
struct FxPairConfig {
    bool exists;
    bytes32 feedId;
    bool inverted;
    address crosscheck;
    uint32 crosscheckEffectivePeriod;
    bool enabled;
    /// @dev The feed in force before `crosscheckEffectivePeriod` (B-S10): it keeps applying to the running period.
    address prevCrosscheck;
}

/// @notice The protocol contracts allowed to call the registry's narrow write interface; fixed at init.
struct ProtocolContracts {
    address auction;
    address treasury;
    address income;
    address vault;
    address window;
    address tokenFactory;
}

struct Flags {
    bool newRaisesPaused;
    bool windowsEnabled;
    bool tier4Enabled;
}

/// @dev Tier flag bits (SPEC §3.1 `tier_flags`).
library TierFlags {
    uint8 internal constant TIER1_SPLIT = 1 << 0;
    uint8 internal constant TIER2_ZKTLS = 1 << 1;
    uint8 internal constant TIER3_ATTESTOR = 1 << 2;
    uint8 internal constant TIER4_SELF = 1 << 3;
    uint8 internal constant ALL = 0x0f;

    function has(uint8 flags, uint8 tier) internal pure returns (bool) {
        if (tier == 0 || tier > 4) return false;
        return flags & (uint8(1) << (tier - 1)) != 0;
    }

    /// @dev A pure tier-1 series (SPEC §6.2 step 3): tier 1 is a report tier only when nothing else is enabled.
    function isPureTier1(uint8 flags) internal pure returns (bool) {
        return flags == TIER1_SPLIT;
    }
}
