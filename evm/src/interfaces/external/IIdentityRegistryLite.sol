// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice ABI-compatible subset of T-REX `IIdentityRegistry` (identities are plain addresses here).
interface IIdentityRegistryLite {
    function isVerified(address userAddress) external view returns (bool);
    function contains(address userAddress) external view returns (bool);
    function identity(address userAddress) external view returns (address);
    function investorCountry(address userAddress) external view returns (uint16);
    function registerIdentity(address userAddress, address identity, uint16 country) external;
    function deleteIdentity(address userAddress) external;
    function identityStorage() external view returns (address);
    function topicsRegistry() external view returns (address);
    function issuersRegistry() external view returns (address);
}

/// @notice ABI-compatible subset of T-REX `IIdentityRegistryStorage`.
interface IIdentityRegistryStorageLite {
    function bindIdentityRegistry(address identityRegistry) external;
    function linkedIdentityRegistries() external view returns (address[] memory);
}
