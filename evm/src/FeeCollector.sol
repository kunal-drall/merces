// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeCollector} from "./interfaces/IFeeCollector.sol";
import {ZeroAddress} from "./types/MercesErrors.sol";

/// @notice Pull-only fee sink. Owner is the protocol `TimelockController`. Non-upgradeable.
contract FeeCollector is IFeeCollector, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    constructor(address owner_) Ownable(owner_) {}

    /// @inheritdoc IFeeCollector
    function withdraw(IERC20 token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit FeesWithdrawn(address(token), to, amount);
    }
}
