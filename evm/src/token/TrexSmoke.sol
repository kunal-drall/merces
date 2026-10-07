// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

// Compilation-unit smoke test: this file is compiled with solc 0.8.17 together with T-REX (OpenZeppelin 4.9.6).
import {Token} from "@tokenysolutions/t-rex/contracts/token/Token.sol";
import {IModule} from "@tokenysolutions/t-rex/contracts/compliance/modular/modules/IModule.sol";

contract TrexSmoke {
    function tokenVersion() external pure returns (string memory) {
        return "4.1.6";
    }
}
