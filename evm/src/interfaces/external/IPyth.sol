// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Subset of the Pyth Solidity SDK 4.3.1 `PythStructs` (docs/research/PYTH.md §4.2).
library PythStructs {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    struct PriceFeed {
        bytes32 id;
        Price price;
        Price emaPrice;
    }
}

/// @notice Subset of `IPyth` (docs/research/PYTH.md §4.1). `getPriceNoOlderThan` reverts `StalePrice` when
/// the stored price is older than `age` seconds.
interface IPyth {
    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory price);
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (PythStructs.Price memory price);
    function updatePriceFeeds(bytes[] calldata updateData) external payable;
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount);
}
