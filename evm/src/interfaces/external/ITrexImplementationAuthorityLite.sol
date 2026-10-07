// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice ABI-compatible subset of T-REX `ITREXImplementationAuthority` (4.1.6).
interface ITrexImplementationAuthorityLite {
    struct TREXContracts {
        address tokenImplementation;
        address ctrImplementation;
        address irImplementation;
        address irsImplementation;
        address tirImplementation;
        address mcImplementation;
    }

    struct Version {
        uint8 major;
        uint8 minor;
        uint8 patch;
    }

    function addAndUseTREXVersion(Version calldata version, TREXContracts calldata trex) external;
    function addTREXVersion(Version calldata version, TREXContracts calldata trex) external;
    function useTREXVersion(Version calldata version) external;
    function getCurrentVersion() external view returns (Version memory);
    function getContracts(Version calldata version) external view returns (TREXContracts memory);
    function getTokenImplementation() external view returns (address);
    function getCTRImplementation() external view returns (address);
    function getIRImplementation() external view returns (address);
    function getIRSImplementation() external view returns (address);
    function getTIRImplementation() external view returns (address);
    function getMCImplementation() external view returns (address);
    function isReferenceContract() external view returns (bool);
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}
