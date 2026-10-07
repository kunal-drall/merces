// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Smoke is ReentrancyGuard {
    uint256 public x;
    function bump() external nonReentrant { x += 1; }
}
