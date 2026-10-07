// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Shared enums and structs for the Merces EVM contracts (SPEC §1.6, §1.7, §3.1).
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
}

/// @notice Issuer-chosen series parameters at creation (bounds-checked against SPEC §1.6).
struct SeriesParams {
    address stablecoin;
    uint64 unitsOffered;
    uint64 reservePrice;
    uint64 minRaise;
    uint64 capMultipleWad;
    uint64 hurdleRateWad;
    uint16 payoutMultipleK;
    uint64 lockupSeconds;
    uint64 commitDuration;
    uint64 revealDuration;
    uint64 windowCommitDuration;
    uint64 windowRevealDuration;
}

struct ReleaseTranche {
    uint64 atOffsetSeconds;
    uint16 bps;
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

struct FxPairConfig {
    bytes32 feedId;
    bool inverted;
    address crosscheck;
    bool enabled;
}

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
}
