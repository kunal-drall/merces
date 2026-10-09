// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {MercesScriptBase} from "./MercesScriptBase.sol";
import {MercesDeploy} from "./lib/MercesDeploy.sol";

/// @notice Generic deployment to any EVM chain, configured entirely from the environment (script/README.md):
/// `MERCES_NETWORK` (record name), `MERCES_PYTH`, `MERCES_STABLECOIN`, optional `MERCES_ADMIN`,
/// `MERCES_ALLOWLIST_MANAGER`, `MERCES_TIMELOCK_PROPOSER`, `MERCES_TIMELOCK_DELAY` (seconds),
/// `MERCES_ATTESTORS`, `MERCES_VERIFIER_KEYS` (comma-separated), `MERCES_WINDOWS_ENABLED`.
contract Deploy is MercesScriptBase {
    function run() external returns (MercesDeploy.Deployment memory d) {
        Settings memory s = settingsFromEnv(vm.envAddress("MERCES_PYTH"), vm.envAddress("MERCES_STABLECOIN"));
        d = _deploy(s);
        _record(vm.envString("MERCES_NETWORK"), d, s);
    }

    function settingsFromEnv(address pyth, address stablecoin) public view returns (Settings memory s) {
        s.admin = vm.envOr("MERCES_ADMIN", msg.sender);
        s.allowlistManager = vm.envOr("MERCES_ALLOWLIST_MANAGER", s.admin);
        s.timelockProposer = vm.envOr("MERCES_TIMELOCK_PROPOSER", s.admin);
        s.timelockDelay = vm.envOr("MERCES_TIMELOCK_DELAY", uint256(2 days));
        s.pyth = pyth;
        s.stablecoin = stablecoin;
        s.windowsEnabled = vm.envOr("MERCES_WINDOWS_ENABLED", false);
        s.attestors = _envAddresses("MERCES_ATTESTORS");
        s.verifierKeys = _envAddresses("MERCES_VERIFIER_KEYS");
    }
}
