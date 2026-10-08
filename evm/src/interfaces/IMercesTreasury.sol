// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Per-series proceeds treasury with an immutable release schedule (D4, SPEC v1.1 §5.3).
interface IMercesTreasury {
    struct Ledger {
        bool proceedsSet;
        uint64 proceeds;
        uint64 deposited;
        uint64 releasedTotal;
        bool issuerPausedReleases;
        uint64 earlyDrawTotal;
        uint64 earlyDrawNonce;
        uint64 movedToVault;
        uint64 extinguishedAt;
    }

    event ProceedsSet(uint256 indexed series, uint64 proceeds);
    event ProceedsDeposited(uint256 indexed series, uint64 amount, uint64 deposited);
    event ReleaseClaimed(uint256 indexed series, uint64 amount, uint64 releasedTotal);
    event ReleasePauseSet(uint256 indexed series, bool paused);
    event EarlyDrawExecuted(uint256 indexed series, uint64 amount, address indexed approver);
    event UnreleasedMovedToVault(uint256 indexed series, uint64 amount);

    /// @dev Auction only: the exact proceeds from `finalize_settlement`, written once.
    function setProceeds(uint256 seriesId, uint64 proceeds) external;
    /// @dev Auction only, from `process_bid`; the stablecoin has already been transferred here.
    function depositProceeds(uint256 seriesId, uint64 amount) external;
    /// @dev Auction only, at mint finalization: deposits must equal the proceeds.
    function confirmDeposits(uint256 seriesId) external;
    function claimRelease(uint256 seriesId) external;
    function setReleasePause(uint256 seriesId, bool paused) external;
    function requestEarlyDraw(uint256 seriesId, uint64 amount) external;
    /// @dev Vault only, on extinguishment: `proceeds − vested(now)` (capped by the balance) moves to the vault.
    function moveUnreleasedToVault(uint256 seriesId) external returns (uint64 unreleased);

    function getTreasury(uint256 seriesId) external view returns (Ledger memory);
    function vested(uint256 seriesId, uint256 timestamp) external view returns (uint64);
    function trancheAmount(uint256 seriesId, uint256 index) external view returns (uint64);
    function claimable(uint256 seriesId) external view returns (uint64);
}
