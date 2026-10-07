// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice The holder-facing claim path of the payout vault (D7, SPEC §6.3). Kept behind its own interface so a
/// private-payout implementation can replace it without touching the accounting (`VaultAccounting`). Every
/// claim may be pushed by anyone to the rightful holder's own address (pull payments, SPEC §12).
interface IPayoutClaims {
    event HolderRegistered(uint256 indexed series, address indexed holder);
    event PayoutClaimed(uint256 indexed series, address indexed holder, uint64 amount, uint64 burnedUnits);
    event UnitsBurned(uint256 indexed series, address indexed holder, uint64 units, uint8 reason);
    event RedemptionClaimed(uint256 indexed series, address indexed holder, uint64 units, uint64 amount);
    event TailClaimed(uint256 indexed series, address indexed holder, uint64 amount);
    event FinalClaimed(uint256 indexed series, address indexed holder, uint64 units, uint64 amount);

    function registerHolder(uint256 seriesId, address wallet) external;
    function settleHolder(uint256 seriesId, address wallet) external;
    function claim(uint256 seriesId) external;
    function claimFor(uint256 seriesId, address holder) external;
    function burnRetired(uint256 seriesId, address holder) external;
    function claimRedemption(uint256 seriesId) external;
    function claimRedemptionFor(uint256 seriesId, address holder) external;
    function claimTail(uint256 seriesId) external;
    function claimTailFor(uint256 seriesId, address holder) external;
    function claimFinal(uint256 seriesId) external;
    function claimFinalFor(uint256 seriesId, address holder) external;

    function pendingOf(uint256 seriesId, address holder) external view returns (uint256 pending);
    function claimableTail(uint256 seriesId, address holder) external view returns (uint256);
    function claimableFinal(uint256 seriesId, address holder) external view returns (uint256);
}
