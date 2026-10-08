// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMercesRegistry} from "../interfaces/IMercesRegistry.sol";
import {ProtocolContracts} from "../types/MercesTypes.sol";
import {NotProtocolContract, ZeroAddress} from "../types/MercesErrors.sol";

/// @notice Base for the money-handling contracts (SPEC §0): UUPS proxies owned by the protocol
/// `TimelockController`, which is the only address allowed to upgrade them. `ReentrancyGuard` (OZ 5, ERC-7201
/// namespaced storage) guards every external function that moves tokens. Peer contracts are resolved through
/// the registry's `ProtocolContracts` record, fixed at registry construction, so no admin can re-point them.
abstract contract MercesUpgradeable is Initializable, UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {
    /// @custom:storage-location erc7201:merces.storage.MercesUpgradeable
    struct MercesUpgradeableStorage {
        IMercesRegistry registry;
    }

    // keccak256(abi.encode(uint256(keccak256("merces.storage.MercesUpgradeable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant MERCES_UPGRADEABLE_STORAGE =
        0x29f3c60d48769ae04c4927efea650106c04eed20b6f8765316477ae5485d1300;

    function _mercesStorage() private pure returns (MercesUpgradeableStorage storage $) {
        assembly ("memory-safe") {
            $.slot := MERCES_UPGRADEABLE_STORAGE
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function __MercesUpgradeable_init(address owner_, address registry_) internal onlyInitializing {
        if (owner_ == address(0) || registry_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        _mercesStorage().registry = IMercesRegistry(registry_);
    }

    function registry() public view returns (IMercesRegistry) {
        return _mercesStorage().registry;
    }

    function _contracts() internal view returns (ProtocolContracts memory) {
        return _mercesStorage().registry.getProtocolContracts();
    }

    function _requireCaller(address expected) internal view {
        if (msg.sender != expected || expected == address(0)) revert NotProtocolContract();
    }

    /// @dev Only the owner (timelock) may upgrade.
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
