// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Early-draw hook (brief D4 / R7). Unset by default, so early draws are off. A futarchy market or
/// any other approver implements this view; the treasury executes the draw only when it returns true.
interface IEarlyDrawApprover {
    function approveEarlyDraw(uint256 seriesId, uint256 amount, uint256 nonce) external view returns (bool);
}
