// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Pull-only fee sink (brief C5, D11). Protocol contracts push fees in; only the owner (timelock)
/// can withdraw. It never pulls from protocol contracts.
interface IFeeCollector {
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);

    function withdraw(IERC20 token, address to, uint256 amount) external;
}
