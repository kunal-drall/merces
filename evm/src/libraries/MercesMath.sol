// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AmountExceedsU64} from "../types/MercesErrors.sol";

/// @notice Arithmetic helpers (SPEC §1.1): mulDiv in 256-bit, floor division, uint64 domain checks.
library MercesMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    /// @dev floor(a × b / c) without intermediate overflow.
    function mulDiv(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        return Math.mulDiv(a, b, c);
    }

    /// @dev Reverts when `x` does not fit the shared uint64 numeric domain.
    function toU64(uint256 x) internal pure returns (uint64) {
        if (x > type(uint64).max) revert AmountExceedsU64(x);
        return uint64(x);
    }

    /// @dev floor(amount × bps / 10_000).
    function bpsOf(uint256 amount, uint256 bps) internal pure returns (uint256) {
        return amount * bps / BPS;
    }

    /// @dev ceil(x / WAD).
    function ceilWad(uint256 x) internal pure returns (uint256) {
        return x == 0 ? 0 : (x - 1) / WAD + 1;
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
