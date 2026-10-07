// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {SeriesStatus} from "../../src/types/MercesTypes.sol";

/// @dev Test stand-in for the income contract's derived status, used by treasury tests.
contract MockIncome {
    mapping(uint256 => SeriesStatus) internal _status;

    function setStatus(uint256 seriesId, SeriesStatus s) external {
        _status[seriesId] = s;
    }

    function deriveStatus(uint256 seriesId) external view returns (SeriesStatus) {
        return _status[seriesId];
    }
}
