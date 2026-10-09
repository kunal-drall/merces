// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {ITrexImplementationAuthorityLite} from "../../src/interfaces/external/ITrexImplementationAuthorityLite.sol";
import {IIdentityRegistryStorageLite} from "../../src/interfaces/external/IIdentityRegistryLite.sol";

/// @notice Deploys the shared T-REX 4.1.6 suite and ONCHAINID 2.2.1 identity infrastructure from the build
/// artifacts (docs/research/TREX.md §4.2). Used by the deploy scripts and the test fixtures so that the
/// 0.8.30 compilation unit never imports the 0.8.17 T-REX sources. The caller (script contract under
/// broadcast, or the test contract) becomes the initial owner of every deployed contract.
library TrexDeploy {
    struct Stack {
        // implementations (never used directly)
        address tokenImpl;
        address ctrImpl;
        address irImpl;
        address irsImpl;
        address tirImpl;
        address mcImpl;
        // reference implementation authority
        address implementationAuthority;
        // shared registry proxies
        address claimTopicsRegistry;
        address trustedIssuersRegistry;
        address identityRegistryStorage;
        address identityRegistry;
        // ONCHAINID
        address identityImpl;
        address identityImplementationAuthority;
        address idFactory;
    }

    function deploy(Vm vm) internal returns (Stack memory s) {
        s.tokenImpl = _create(vm, "Token.sol:Token", "");
        s.ctrImpl = _create(vm, "ClaimTopicsRegistry.sol:ClaimTopicsRegistry", "");
        s.irImpl = _create(vm, "IdentityRegistry.sol:IdentityRegistry", "");
        s.irsImpl = _create(vm, "IdentityRegistryStorage.sol:IdentityRegistryStorage", "");
        s.tirImpl = _create(vm, "TrustedIssuersRegistry.sol:TrustedIssuersRegistry", "");
        s.mcImpl = _create(vm, "ModularCompliance.sol:ModularCompliance", "");

        s.implementationAuthority = _create(
            vm, "TREXImplementationAuthority.sol:TREXImplementationAuthority", abi.encode(true, address(0), address(0))
        );
        ITrexImplementationAuthorityLite(s.implementationAuthority)
            .addAndUseTREXVersion(
                ITrexImplementationAuthorityLite.Version({major: 4, minor: 1, patch: 6}),
                ITrexImplementationAuthorityLite.TREXContracts({
                tokenImplementation: s.tokenImpl,
                ctrImplementation: s.ctrImpl,
                irImplementation: s.irImpl,
                irsImplementation: s.irsImpl,
                tirImplementation: s.tirImpl,
                mcImplementation: s.mcImpl
            })
            );

        s.claimTopicsRegistry =
            _create(vm, "ClaimTopicsRegistryProxy.sol:ClaimTopicsRegistryProxy", abi.encode(s.implementationAuthority));
        s.trustedIssuersRegistry = _create(
            vm, "TrustedIssuersRegistryProxy.sol:TrustedIssuersRegistryProxy", abi.encode(s.implementationAuthority)
        );
        s.identityRegistryStorage = _create(
            vm, "IdentityRegistryStorageProxy.sol:IdentityRegistryStorageProxy", abi.encode(s.implementationAuthority)
        );
        s.identityRegistry = _create(
            vm,
            "IdentityRegistryProxy.sol:IdentityRegistryProxy",
            abi.encode(
                s.implementationAuthority, s.trustedIssuersRegistry, s.claimTopicsRegistry, s.identityRegistryStorage
            )
        );
        IIdentityRegistryStorageLite(s.identityRegistryStorage).bindIdentityRegistry(s.identityRegistry);

        // ONCHAINID: library-mode Identity implementation, its implementation authority and the IdFactory.
        // library-mode Identity: the management key argument must be non-zero but is never used (no `address(this)`,
        // which forge forbids in scripts)
        s.identityImpl = _create(vm, "Identity.sol:Identity", abi.encode(msg.sender, true));
        s.identityImplementationAuthority =
            _create(vm, "ImplementationAuthority.sol:ImplementationAuthority", abi.encode(s.identityImpl));
        s.idFactory = _create(vm, "IdFactory.sol:IdFactory", abi.encode(s.identityImplementationAuthority));
    }

    function _create(Vm vm, string memory artifact, bytes memory args) private returns (address addr) {
        bytes memory bytecode = abi.encodePacked(vm.getCode(artifact), args);
        assembly ("memory-safe") {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), string.concat("TrexDeploy: deployment failed: ", artifact));
    }
}
