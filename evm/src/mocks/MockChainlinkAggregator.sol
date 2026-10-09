// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {AggregatorV3Interface} from "../interfaces/external/AggregatorV3Interface.sol";

/// @notice Minimal Chainlink aggregator stand-in for the FX cross-check in tests and local deployments.
contract MockChainlinkAggregator is AggregatorV3Interface {
    uint8 internal _decimals;
    string internal _description;
    int256 internal _answer;
    uint256 internal _updatedAt;
    uint80 internal _roundId;

    constructor(uint8 decimals_, string memory description_) {
        _decimals = decimals_;
        _description = description_;
    }

    /// @dev Test helper: feeds quoted with another exponent (vector cross-check prices carry their own exponent).
    function setDecimals(uint8 decimals_) external {
        _decimals = decimals_;
    }

    function setAnswer(int256 answer, uint256 updatedAt) external {
        _roundId += 1;
        _answer = answer;
        _updatedAt = updatedAt;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}
