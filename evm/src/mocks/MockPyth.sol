// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IPyth, PythStructs} from "../interfaces/external/IPyth.sol";

/// @notice Minimal Pyth stand-in for tests and local deployments: prices are set directly, `updatePriceFeeds`
/// accepts `abi.encode(id, price, conf, expo, publishTime)` blobs and charges `updateFee` per blob.
contract MockPyth is IPyth {
    error StalePrice();
    error PriceFeedNotFound();
    error InsufficientFee();

    uint256 public updateFee;
    mapping(bytes32 => PythStructs.Price) internal _prices;

    constructor(uint256 updateFee_) {
        updateFee = updateFee_;
    }

    function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        _prices[id] = PythStructs.Price({price: price, conf: conf, expo: expo, publishTime: publishTime});
    }

    function getPriceUnsafe(bytes32 id) public view returns (PythStructs.Price memory price) {
        price = _prices[id];
        if (price.publishTime == 0) revert PriceFeedNotFound();
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (PythStructs.Price memory price) {
        price = getPriceUnsafe(id);
        uint256 diff = block.timestamp > price.publishTime
            ? block.timestamp - price.publishTime
            : price.publishTime - block.timestamp;
        if (diff > age) revert StalePrice();
    }

    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        if (msg.value < updateData.length * updateFee) revert InsufficientFee();
        for (uint256 i = 0; i < updateData.length; i++) {
            (bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) =
                abi.decode(updateData[i], (bytes32, int64, uint64, int32, uint256));
            if (publishTime > _prices[id].publishTime) {
                _prices[id] = PythStructs.Price({price: price, conf: conf, expo: expo, publishTime: publishTime});
            }
        }
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        return updateData.length * updateFee;
    }
}
