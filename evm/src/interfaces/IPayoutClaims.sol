// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice The holder-facing claim path of the payout vault (D7, SPEC v1.1 §6.3, §6.7–6.9). Kept behind its own
/// interface so a private-payout implementation can replace it without touching the accounting. Every claim
/// may be pushed by anyone to the rightful holder's own address (pull payments, SPEC §12), never requires the
/// holder to be *currently* allowlisted, and succeeds as a no-op (zero event) when nothing is due
/// (zero-amount rule, SPEC §1.1).
interface IPayoutClaims {
    event HolderRegistered(uint256 indexed series, address indexed holder);
    event PayoutClaimed(uint256 indexed series, address indexed holder, uint64 amount, uint64 burnedUnits);
    event UnitsBurned(uint256 indexed series, address indexed holder, uint64 units, uint8 reason);
    event RedemptionClaimed(uint256 indexed series, address indexed holder, uint64 units, uint64 amount);
    event TailClaimed(uint256 indexed series, address indexed holder, uint64 amount);
    event FinalClaimed(uint256 indexed series, address indexed holder, uint64 units, uint64 amount);

    /// @dev Anyone may register a wallet that is allowlisted now; the auction and the window register the
    /// wallets they allocate to (validity was fixed at reveal / fill).
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
