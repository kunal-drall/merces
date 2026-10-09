// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {MercesScriptBase} from "./MercesScriptBase.sol";
import {MercesDeploy} from "./lib/MercesDeploy.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Monad testnet deployment (chain id 10143). The Pyth contract is the one Pyth documents for Monad
/// testnet (VERSIONS.md: `0x2880aB155794e7179c9eE2e38200202908C17B43`). There is no Monad-specific code; the
/// stablecoin is `MERCES_STABLECOIN` when set, otherwise a test "USDC" (6 decimals, open mint) is deployed and
/// recorded. Admin, allowlist manager and timelock proposer default to the broadcaster (SPEC §2: a keypair on
/// testnet). Writes `deployments/monad-testnet.json`.
contract DeployMonadTestnet is MercesScriptBase {
    uint256 public constant CHAIN_ID = 10_143;
    address public constant PYTH = 0x2880aB155794e7179c9eE2e38200202908C17B43;

    function run() external returns (MercesDeploy.Deployment memory d) {
        require(block.chainid == CHAIN_ID, "DeployMonadTestnet: wrong chain (expected 10143)");
        address stablecoin = vm.envOr("MERCES_STABLECOIN", address(0));
        if (stablecoin == address(0)) {
            vm.broadcast(msg.sender);
            stablecoin = address(new MockUSDC());
        }
        Settings memory s;
        s.admin = vm.envOr("MERCES_ADMIN", msg.sender);
        s.allowlistManager = vm.envOr("MERCES_ALLOWLIST_MANAGER", s.admin);
        s.timelockProposer = vm.envOr("MERCES_TIMELOCK_PROPOSER", s.admin);
        s.timelockDelay = vm.envOr("MERCES_TIMELOCK_DELAY", uint256(1 days));
        s.pyth = PYTH;
        s.stablecoin = stablecoin;
        s.windowsEnabled = vm.envOr("MERCES_WINDOWS_ENABLED", false);
        s.attestors = _envAddresses("MERCES_ATTESTORS");
        s.verifierKeys = _envAddresses("MERCES_VERIFIER_KEYS");
        d = _deploy(s);
        _record(vm.envOr("MERCES_NETWORK", string("monad-testnet")), d, s);
    }
}
