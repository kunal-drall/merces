// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Per-series proceeds treasury with an immutable release schedule (D4, SPEC §5.3).
interface IMercesTreasury {
    struct Ledger {
        uint64 proceedsReceived;
        uint64 proceeds;
        bool finalized;
        uint64 releasedTotal;
        bool issuerPausedReleases;
        uint64 earlyDrawTotal;
        uint64 earlyDrawNonce;
        uint64 movedToVault;
    }

    event ProceedsDeposited(uint256 indexed series, uint64 amount, uint64 proceedsReceived);
    event ProceedsFinalized(uint256 indexed series, uint64 proceeds);
    event ReleaseClaimed(uint256 indexed series, uint64 amount, uint64 releasedTotal);
    event ReleasePauseSet(uint256 indexed series, bool paused);
    event EarlyDrawExecuted(uint256 indexed series, uint64 amount, address indexed approver);
    event UnreleasedMovedToVault(uint256 indexed series, uint64 amount);

    function depositProceeds(uint256 seriesId, uint64 amount) external;
    function finalizeProceeds(uint256 seriesId, uint64 proceeds) external;
    function claimRelease(uint256 seriesId) external;
    function setReleasePause(uint256 seriesId, bool paused) external;
    function requestEarlyDraw(uint256 seriesId, uint64 amount) external;
    function moveUnreleasedToVault(uint256 seriesId) external returns (uint64 unreleased);

    function getTreasury(uint256 seriesId) external view returns (Ledger memory);
    function vested(uint256 seriesId, uint256 timestamp) external view returns (uint64);
    function trancheAmount(uint256 seriesId, uint256 index) external view returns (uint64);
    function claimable(uint256 seriesId) external view returns (uint64);
}
