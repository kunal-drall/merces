// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {MercesScriptBase} from "./MercesScriptBase.sol";
import {MercesDeploy} from "./lib/MercesDeploy.sol";
import {MercesRegistry} from "../src/MercesRegistry.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockPyth} from "../src/mocks/MockPyth.sol";

/// @notice Local rehearsal on anvil: mock stablecoin and mock Pyth, the broadcaster as admin, allowlist manager
/// and timelock proposer, a 60-second timelock (override with `MERCES_TIMELOCK_DELAY`), windows enabled, the
/// broadcaster registered as issuer and allowlisted, and the first anvil-derived keys (or `MERCES_ATTESTORS` /
/// `MERCES_VERIFIER_KEYS`) registered as attestors and report-verifier key. Writes `deployments/anvil.json`.
contract DeployLocal is MercesScriptBase {
    function run() external returns (MercesDeploy.Deployment memory d) {
        vm.startBroadcast(msg.sender);
        address usdc = address(new MockUSDC());
        address pyth = address(new MockPyth(0));
        vm.stopBroadcast();

        Settings memory s;
        s.admin = msg.sender;
        s.allowlistManager = msg.sender;
        s.timelockProposer = msg.sender;
        s.timelockDelay = vm.envOr("MERCES_TIMELOCK_DELAY", uint256(60));
        s.pyth = pyth;
        s.stablecoin = usdc;
        s.windowsEnabled = true;
        s.attestors = _envAddresses("MERCES_ATTESTORS");
        if (s.attestors.length == 0) {
            s.attestors = new address[](2);
            s.attestors[0] = vm.addr(uint256(keccak256("merces.local.attestor.1")));
            s.attestors[1] = vm.addr(uint256(keccak256("merces.local.attestor.2")));
        }
        s.verifierKeys = _envAddresses("MERCES_VERIFIER_KEYS");
        if (s.verifierKeys.length == 0) {
            s.verifierKeys = new address[](1);
            s.verifierKeys[0] = vm.addr(uint256(keccak256("merces.local.verifier")));
        }
        d = _deploy(s);

        // a ready-to-use issuer: the broadcaster, registered and allowlisted, with test USDC
        vm.startBroadcast(msg.sender);
        MercesRegistry(d.registry).registerIssuer(msg.sender);
        MercesRegistry(d.registry).setAllowed(msg.sender, true);
        MockUSDC(usdc).mint(msg.sender, 1_000_000e6);
        vm.stopBroadcast();
        _record(vm.envOr("MERCES_NETWORK", string("anvil")), d, s);
    }
}
