// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

// Compiled with solc 0.8.17. This file only imports the vendored T-REX 4.1.6 and ONCHAINID 2.2.1 contracts
// that the Merces deploy scripts and test fixtures instantiate from their build artifacts (forge-std
// `deployCode`), so that Foundry compiles them. Nothing here is deployed.
import {Token} from "@tokenysolutions/t-rex/contracts/token/Token.sol";
import {IdentityRegistry} from "@tokenysolutions/t-rex/contracts/registry/implementation/IdentityRegistry.sol";
import {IdentityRegistryStorage} from
    "@tokenysolutions/t-rex/contracts/registry/implementation/IdentityRegistryStorage.sol";
import {ClaimTopicsRegistry} from "@tokenysolutions/t-rex/contracts/registry/implementation/ClaimTopicsRegistry.sol";
import {TrustedIssuersRegistry} from
    "@tokenysolutions/t-rex/contracts/registry/implementation/TrustedIssuersRegistry.sol";
import {ModularCompliance} from "@tokenysolutions/t-rex/contracts/compliance/modular/ModularCompliance.sol";
import {TREXImplementationAuthority} from
    "@tokenysolutions/t-rex/contracts/proxy/authority/TREXImplementationAuthority.sol";
import {IdentityRegistryProxy} from "@tokenysolutions/t-rex/contracts/proxy/IdentityRegistryProxy.sol";
import {IdentityRegistryStorageProxy} from "@tokenysolutions/t-rex/contracts/proxy/IdentityRegistryStorageProxy.sol";
import {ClaimTopicsRegistryProxy} from "@tokenysolutions/t-rex/contracts/proxy/ClaimTopicsRegistryProxy.sol";
import {TrustedIssuersRegistryProxy} from "@tokenysolutions/t-rex/contracts/proxy/TrustedIssuersRegistryProxy.sol";
import {Identity} from "@onchain-id/solidity/contracts/Identity.sol";
import {ImplementationAuthority} from "@onchain-id/solidity/contracts/proxy/ImplementationAuthority.sol";
import {IdFactory} from "@onchain-id/solidity/contracts/factory/IdFactory.sol";
