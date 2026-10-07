// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Smoke} from "../src/Smoke.sol";

contract SmokeTest is Test {
    function test_bump() public {
        Smoke s = new Smoke();
        s.bump();
        assertEq(s.x(), 1);
    }
    function testFuzz_bump(uint8 n) public {
        Smoke s = new Smoke();
        for (uint256 i = 0; i < n; i++) s.bump();
        assertEq(s.x(), n);
    }
}
