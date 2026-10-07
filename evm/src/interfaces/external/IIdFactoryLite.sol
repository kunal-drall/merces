// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice ABI-compatible subset of ONCHAINID `IIdFactory` (onchain-id/solidity 2.2.1).
interface IIdFactoryLite {
    function createIdentity(address wallet, string memory salt) external returns (address);
    function getIdentity(address wallet) external view returns (address);
    function isSaltTaken(string calldata salt) external view returns (bool);
    function implementationAuthority() external view returns (address);
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}
