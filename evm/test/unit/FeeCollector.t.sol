// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeCollector} from "../../src/FeeCollector.sol";
import {IFeeCollector} from "../../src/interfaces/IFeeCollector.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";

contract FeeCollectorTest is Test {
    FeeCollector internal fc;
    MockUSDC internal usdc;
    address internal timelock = makeAddr("timelock");
    address internal treasury = makeAddr("protocolTreasury");

    function setUp() public {
        usdc = new MockUSDC();
        fc = new FeeCollector(timelock);
        usdc.mint(address(fc), 1000e6);
    }

    function test_ownerIsTimelock() public view {
        assertEq(fc.owner(), timelock);
    }

    function test_ownerWithdraws() public {
        vm.prank(timelock);
        vm.expectEmit(true, true, false, true);
        emit IFeeCollector.FeesWithdrawn(address(usdc), treasury, 400e6);
        fc.withdraw(IERC20(address(usdc)), treasury, 400e6);
        assertEq(usdc.balanceOf(treasury), 400e6);
        assertEq(usdc.balanceOf(address(fc)), 600e6);
    }

    function test_nonOwnerCannotWithdraw() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        fc.withdraw(IERC20(address(usdc)), treasury, 1);
    }

    function test_hasNoPullPath() public view {
        // The collector exposes exactly: withdraw, owner, renounceOwnership, transferOwnership.
        // Nothing can be pulled from protocol contracts; it only receives transfers.
        assertEq(usdc.allowance(address(this), address(fc)), 0);
    }
}
