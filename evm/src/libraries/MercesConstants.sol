// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Fixed constants and parameter bounds (SPEC §1.1, §1.2, §1.6).
library MercesConstants {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant DAY = 86_400;
    uint256 internal constant YEAR = 31_536_000; // 365 days
    uint256 internal constant MONTH_SECONDS = 2_629_800; // 30.4375 days

    // fixed by the brief
    uint64 internal constant REPORT_DUE_DAYS = 30;
    uint64 internal constant GRACE_DAYS = 15;
    uint64 internal constant FORMAL_NOTICE_DAYS = 90;
    uint64 internal constant TRUEUP_DAYS = 60;
    uint64 internal constant TAIL_SECONDS = 31_536_000;
    uint256 internal constant MAX_RELEASE_TRANCHES = 24;
    uint256 internal constant MAX_BIDS_PER_AUCTION = 4096;
    uint256 internal constant MAX_TALLY_PAGE = 200;
    uint256 internal constant MAX_ORDERS_PER_WINDOW = 4096;
    uint256 internal constant MAX_PAUSES = 16;
    uint256 internal constant ROUTER_CHECKPOINTS = 8;
    uint256 internal constant YEAR_GROSS_SLOTS = 4;

    uint8 internal constant CHAIN_KIND_EVM = 2;

    // derived seconds
    uint256 internal constant DEADLINE_SECONDS = REPORT_DUE_DAYS * DAY;
    uint256 internal constant GRACE_SECONDS = (REPORT_DUE_DAYS + GRACE_DAYS) * DAY;
    uint256 internal constant NOTICE_SECONDS = FORMAL_NOTICE_DAYS * DAY;
    uint256 internal constant TRUEUP_SECONDS = TRUEUP_DAYS * DAY;

    // bounds (SPEC §1.6)
    uint64 internal constant CAP_MULTIPLE_MIN = 2e18;
    uint64 internal constant CAP_MULTIPLE_MAX = 3e18;
    uint64 internal constant HURDLE_MAX = 0.25e18;
    uint16 internal constant K_MIN = 1;
    uint16 internal constant K_MAX = 20;
    uint64 internal constant LOCKUP_MAX = 157_680_000; // 5 years
    uint16 internal constant WALLET_CAP_MIN = 100;
    uint16 internal constant WALLET_CAP_MAX = 10_000;
    uint16 internal constant AUCTION_FEE_MAX = 1000;
    uint16 internal constant PAYOUT_FEE_MAX = 2000;
    uint16 internal constant WINDOW_FEE_MAX = 1000;
    uint16 internal constant NON_REVEAL_MAX = 1000;
    uint64 internal constant COMMIT_MIN = 1 hours;
    uint64 internal constant COMMIT_MAX = 30 days;
    uint64 internal constant REVEAL_MIN = 1 hours;
    uint64 internal constant REVEAL_MAX = 7 days;
    uint64 internal constant WINDOW_COMMIT_MIN = 1 hours;
    uint64 internal constant WINDOW_COMMIT_MAX = 14 days;
    uint64 internal constant WINDOW_REVEAL_MIN = 1 hours;
    uint64 internal constant WINDOW_REVEAL_MAX = 7 days;
    uint16 internal constant FX_COVERAGE_MIN = 5000;
    uint16 internal constant FX_COVERAGE_MAX = 10_000;
    uint64 internal constant FX_STALENESS_MIN = 60;
    uint64 internal constant FX_STALENESS_MAX = 86_400;
    uint16 internal constant FX_CONF_MIN = 1;
    uint16 internal constant FX_CONF_MAX = 1000;
    uint16 internal constant FX_BAND_MIN = 10;
    uint16 internal constant FX_BAND_MAX = 5000;
    uint64 internal constant MAX_PAUSE_MIN = 2_592_000; // 30 days
    uint64 internal constant MAX_PAUSE_MAX = 63_072_000; // 2 years
    uint64 internal constant MAX_CUMULATIVE_PAUSE_MAX = 157_680_000; // 5 years
}
