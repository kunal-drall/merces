// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @dev Test stand-in for the vault's holder registration used by the auction while the real vault is not
/// part of the fixture under test.
contract MockVault {
    mapping(uint256 => mapping(address => bool)) public registered;
    mapping(uint256 => uint256) public registrations;

    function registerHolder(uint256 seriesId, address wallet) external {
        if (!registered[seriesId][wallet]) {
            registered[seriesId][wallet] = true;
            registrations[seriesId] += 1;
        }
    }

    function settleHolder(uint256, address) external {}
}
