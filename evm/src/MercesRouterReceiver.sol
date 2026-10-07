// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {NotIncome} from "./types/MercesErrors.sol";

/// @notice Per-series receiving account of the tier-1 split router (D5, SPEC §6.5). Income arriving as
/// stablecoin at this address is swept into `MercesIncome.sweep`, which splits it between the issuer and
/// the payout vault. Only the income contract that deployed it can move funds out.
contract MercesRouterReceiver {
    using SafeERC20 for IERC20;

    address public immutable income;
    uint256 public immutable seriesId;

    constructor(uint256 seriesId_) {
        income = msg.sender;
        seriesId = seriesId_;
    }

    function forward(IERC20 token, uint256 amount) external {
        if (msg.sender != income) revert NotIncome();
        token.safeTransfer(income, amount);
    }
}
