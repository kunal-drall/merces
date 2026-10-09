// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {MercesDeploy} from "./lib/MercesDeploy.sol";
import {MercesRegistry} from "../src/MercesRegistry.sol";
import {IAgentRole} from "../src/interfaces/external/IAgentRole.sol";
import {Parameters, ProtocolContracts} from "../src/types/MercesTypes.sol";

/// @notice Shared deployment flow for the Merces EVM stack (SPEC v1.1 §0, §3, §4.2): deploy and wire through
/// `MercesDeploy` (timelock, fee collector, T-REX 4.1.6 implementation authority and implementations, shared
/// identity-registry stack, ONCHAINID factory, Poseidon hashers, Groth16 verifier, seven UUPS proxies, token
/// governor, compliance module, token factory, registry), verify the wiring on chain, apply the admin's
/// first-day configuration when the broadcaster is the admin, and record every address in
/// `deployments/<name>.json`.
abstract contract MercesScriptBase is Script {
    struct Settings {
        address admin;
        address allowlistManager;
        address timelockProposer;
        uint256 timelockDelay;
        address pyth;
        address stablecoin;
        bool windowsEnabled;
        address[] attestors;
        address[] verifierKeys;
    }

    /// @notice SPEC v1.1 §1.6 defaults (editable by the admin for future series only).
    function defaults() public pure returns (Parameters memory) {
        return Parameters({
            capMultipleWad: 2.5e18,
            hurdleRateWad: 0.08e18,
            payoutMultipleK: 5,
            lockupSeconds: 47_336_400,
            walletCapBps: 1000,
            auctionFeeBps: 100,
            payoutFeeBps: 500,
            windowFeeBps: 100,
            nonRevealChargeBps: 100,
            commitDuration: 7 days,
            revealDuration: 2 days,
            windowCommitDuration: 3 days,
            windowRevealDuration: 1 days,
            fxMinCoverageBps: 8000,
            fxMaxStalenessSeconds: 3600,
            fxMaxConfBps: 100,
            fxDeviationBandBps: 200,
            maxPauseSeconds: 31_536_000,
            maxCumulativePauseSeconds: 63_072_000
        });
    }

    /// @dev Optional comma-separated address list from the environment (empty when unset).
    function _envAddresses(string memory key) internal view returns (address[] memory list) {
        if (!vm.envExists(key) || bytes(vm.envString(key)).length == 0) return new address[](0);
        return vm.envAddress(key, ",");
    }

    function _deploy(Settings memory s) internal returns (MercesDeploy.Deployment memory d) {
        require(s.pyth.code.length > 0, "MercesScript: no Pyth contract at the configured address");
        require(s.stablecoin.code.length > 0, "MercesScript: no stablecoin contract at the configured address");
        address deployer = msg.sender;
        vm.startBroadcast(deployer);
        d = MercesDeploy.deploy(
            vm,
            deployer,
            MercesDeploy.Config({
                admin: s.admin,
                allowlistManager: s.allowlistManager,
                timelockProposer: s.timelockProposer,
                timelockDelay: s.timelockDelay,
                pyth: s.pyth,
                defaults: defaults()
            })
        );
        if (s.admin == deployer) _configure(MercesRegistry(d.registry), s);
        vm.stopBroadcast();
        _verify(d, s);
    }

    /// @dev The admin's first-day configuration (only when the broadcaster is the admin; with a multisig admin
    /// these calls are proposed separately, see script/README.md).
    function _configure(MercesRegistry registry, Settings memory s) internal {
        registry.setStablecoin(s.stablecoin, true);
        for (uint256 i = 0; i < s.attestors.length; i++) {
            registry.registerAttestor(s.attestors[i]);
        }
        for (uint256 i = 0; i < s.verifierKeys.length; i++) {
            registry.registerVerifierKey(s.verifierKeys[i]);
        }
        if (s.windowsEnabled) registry.setFlags(false, true, false);
    }

    /// @dev Read-back of the deployed wiring; any mismatch aborts the script before the record is written.
    function _verify(MercesDeploy.Deployment memory d, Settings memory s) internal view {
        MercesRegistry registry = MercesRegistry(d.registry);
        require(registry.admin() == s.admin, "verify: admin");
        require(registry.allowlistManager() == s.allowlistManager, "verify: allowlist manager");
        require(registry.feeCollector() == d.feeCollector, "verify: fee collector");
        require(registry.chainId() == block.chainid, "verify: chain id");
        ProtocolContracts memory c = registry.getProtocolContracts();
        require(
            c.auction == d.auction && c.treasury == d.treasury && c.income == d.income && c.vault == d.vault
                && c.window == d.window && c.tokenFactory == d.tokenFactory,
            "verify: protocol contracts"
        );
        address[8] memory owned = [d.auction, d.treasury, d.vault, d.income, d.router, d.window, d.fx, d.feeCollector];
        for (uint256 i = 0; i < owned.length; i++) {
            require(IAgentRole(owned[i]).owner() == d.timelock, "verify: money contract owner");
        }
        require(IAgentRole(d.trex.implementationAuthority).owner() == d.timelock, "verify: T-REX IA owner");
        require(IAgentRole(d.trex.identityRegistry).owner() == d.governor, "verify: identity registry owner");
        require(IAgentRole(d.trex.identityRegistry).isAgent(d.registry), "verify: identity registry agent");
        TimelockController tl = TimelockController(payable(d.timelock));
        require(tl.getMinDelay() == s.timelockDelay, "verify: timelock delay");
        require(tl.hasRole(tl.PROPOSER_ROLE(), s.timelockProposer), "verify: timelock proposer");
        if (s.admin == msg.sender) require(registry.isStablecoinAllowed(s.stablecoin), "verify: stablecoin");
    }

    /// @dev Writes `deployments/<name>.json`.
    function _record(string memory name, MercesDeploy.Deployment memory d, Settings memory s) internal {
        string memory k = "contracts";
        vm.serializeAddress(k, "registry", d.registry);
        vm.serializeAddress(k, "auction", d.auction);
        vm.serializeAddress(k, "treasury", d.treasury);
        vm.serializeAddress(k, "vault", d.vault);
        vm.serializeAddress(k, "income", d.income);
        vm.serializeAddress(k, "router", d.router);
        vm.serializeAddress(k, "window", d.window);
        vm.serializeAddress(k, "fxAccumulator", d.fx);
        vm.serializeAddress(k, "feeCollector", d.feeCollector);
        vm.serializeAddress(k, "timelock", d.timelock);
        vm.serializeAddress(k, "tokenGovernor", d.governor);
        vm.serializeAddress(k, "complianceModule", d.complianceModule);
        vm.serializeAddress(k, "tokenFactory", d.tokenFactory);
        vm.serializeAddress(k, "groth16Verifier", d.groth16Verifier);
        vm.serializeAddress(k, "poseidon2", d.poseidon2);
        string memory contracts = vm.serializeAddress(k, "poseidon5", d.poseidon5);

        string memory im = "implementations";
        vm.serializeAddress(im, "auction", d.auctionImpl);
        vm.serializeAddress(im, "treasury", d.treasuryImpl);
        vm.serializeAddress(im, "vault", d.vaultImpl);
        vm.serializeAddress(im, "income", d.incomeImpl);
        vm.serializeAddress(im, "router", d.routerImpl);
        vm.serializeAddress(im, "window", d.windowImpl);
        string memory impls = vm.serializeAddress(im, "fxAccumulator", d.fxImpl);

        string memory tk = "trex";
        vm.serializeAddress(tk, "implementationAuthority", d.trex.implementationAuthority);
        vm.serializeAddress(tk, "tokenImplementation", d.trex.tokenImpl);
        vm.serializeAddress(tk, "modularComplianceImplementation", d.trex.mcImpl);
        vm.serializeAddress(tk, "identityRegistry", d.trex.identityRegistry);
        vm.serializeAddress(tk, "identityRegistryStorage", d.trex.identityRegistryStorage);
        vm.serializeAddress(tk, "claimTopicsRegistry", d.trex.claimTopicsRegistry);
        vm.serializeAddress(tk, "trustedIssuersRegistry", d.trex.trustedIssuersRegistry);
        vm.serializeAddress(tk, "identityImplementation", d.trex.identityImpl);
        vm.serializeAddress(tk, "identityImplementationAuthority", d.trex.identityImplementationAuthority);
        string memory trex = vm.serializeAddress(tk, "idFactory", d.trex.idFactory);

        string memory cf = "config";
        vm.serializeAddress(cf, "admin", s.admin);
        vm.serializeAddress(cf, "allowlistManager", s.allowlistManager);
        vm.serializeAddress(cf, "timelockProposer", s.timelockProposer);
        vm.serializeUint(cf, "timelockDelay", s.timelockDelay);
        vm.serializeAddress(cf, "pyth", s.pyth);
        vm.serializeAddress(cf, "stablecoin", s.stablecoin);
        vm.serializeBool(cf, "windowsEnabled", s.windowsEnabled);
        vm.serializeAddress(cf, "attestors", s.attestors);
        string memory config = vm.serializeAddress(cf, "verifierKeys", s.verifierKeys);

        string memory root = "deployment";
        vm.serializeString(root, "network", name);
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "deployedAtBlock", block.number);
        vm.serializeAddress(root, "deployer", msg.sender);
        vm.serializeBytes32(root, "domain", MercesRegistry(d.registry).domain());
        vm.serializeString(root, "specVersion", "1.1");
        vm.serializeString(root, "contracts", contracts);
        vm.serializeString(root, "implementations", impls);
        vm.serializeString(root, "trex", trex);
        string memory json = vm.serializeString(root, "config", config);
        vm.writeJson(json, string.concat("deployments/", name, ".json"));
    }
}
