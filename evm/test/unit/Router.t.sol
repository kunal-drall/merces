// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {MercesRouterReceiver} from "../../src/MercesRouterReceiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {TierFlags} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

contract RouterTest is FullFixture {
    uint256 internal sid;
    address internal payer = makeAddr("client");

    function setUp() public override {
        super.setUp();
        sid = runStandardRaise(TierFlags.TIER1_SPLIT | TierFlags.TIER2_ZKTLS, bytes32(0));
    }

    function _route(uint64 amount) internal {
        fund(payer, amount);
        vm.startPrank(payer);
        usdc.approve(address(income), amount);
        income.route(sid, amount);
        vm.stopPrank();
    }

    function test_setRouterTermsGuards() public {
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        income.setRouterTerms(sid, 80_000e6, 1e15);
        uint256 nonTier1 = runStandardRaise(TierFlags.TIER2_ZKTLS, bytes32(0));
        vm.prank(issuer);
        vm.expectRevert(NotTierOne.selector);
        income.setRouterTerms(nonTier1, 80_000e6, 1e15);
        vm.expectRevert(RouterNotConfigured.selector);
        income.route(sid, 1);
        vm.prank(issuer);
        income.setRouterTerms(sid, 80_000e6, 1e15);
        IMercesIncome.Router memory r = income.getRouter(sid);
        assertTrue(r.configured);
        assertEq(r.theta, 80_000e6);
        assertEq(r.rWad, 1e15);
        assertTrue(r.receiver != address(0));
        assertEq(MercesRouterReceiver(r.receiver).income(), address(income));
        assertEq(MercesRouterReceiver(r.receiver).seriesId(), sid);
        // updating keeps the receiver
        vm.prank(issuer);
        income.setRouterTerms(sid, 90_000e6, 1e15);
        assertEq(income.getRouter(sid).receiver, r.receiver);
    }

    function test_splitBelowAndAboveThreshold() public {
        vm.prank(issuer);
        income.setRouterTerms(sid, 80_000e6, 1e15); // r × 300 units = 30% of income above θ
        // 50,000 below θ: all to the issuer
        fund(payer, 50_000e6);
        vm.startPrank(payer);
        usdc.approve(address(income), 50_000e6);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.IncomeRouted(sid, 50_000e6, 50_000e6, 0, 50_000e6);
        income.route(sid, 50_000e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(issuer), 50_000e6);
        assertEq(income.getLedger(sid).routerCredit, 0);
        // 70,000 more: 30,000 passes through, 40,000 above → share 12,000 to the vault
        _route(70_000e6);
        assertEq(usdc.balanceOf(issuer), 50_000e6 + 58_000e6);
        assertEq(income.getLedger(sid).routerCredit, 12_000e6);
        assertEq(income.getRouter(sid).ytdReceived, 120_000e6);
        assertEq(vault.getLedger(sid).grossReceived, 12_000e6);
        assertEq(usdc.balanceOf(address(vault)), 11_400e6);
        // the quarterly proof (income YTD 120,000 → payment 12,000) is fully covered by the credit: due 0
        vm.warp(Periods.periodEnd(Q1_2026));
        vm.prank(issuer);
        income.submitReport(reportInput(sid, Q1_2026, Proofs.q1(), 1, false));
        (uint64 due,) = income.openDue(sid);
        assertEq(due, 0);
        assertEq(income.getLedger(sid).routerCredit, 0);
        (bool hasPaid, uint32 lp) = income.lastPaidPeriod(sid);
        assertTrue(hasPaid);
        assertEq(lp, Q1_2026);
        // holders accrued from the routed share
        assertEq(vault.pendingOf(sid, b1), 3_800e6);
    }

    function test_shortfallAndExcessReconcile() public {
        vm.prank(issuer);
        income.setRouterTerms(sid, 100_000e6, 1e15); // router θ set higher than the committed θ (80,000)
        _route(120_000e6); // routes 30% of 20,000 = 6,000; proof says 12,000 is owed
        assertEq(income.getLedger(sid).routerCredit, 6_000e6);
        vm.warp(Periods.periodEnd(Q1_2026));
        vm.prank(issuer);
        income.submitReport(reportInput(sid, Q1_2026, Proofs.q1(), 1, false));
        (uint64 due,) = income.openDue(sid);
        assertEq(due, 6_000e6); // shortfall collected at report time
        payDue(sid, issuer);
        assertEq(vault.getLedger(sid).grossReceived, 12_000e6);
        // excess: route more than owed in Q2 → credit carries forward
        _route(100_000e6); // all above θ now (ytd 220,000) → share 30,000
        assertEq(income.getLedger(sid).routerCredit, 30_000e6);
        vm.warp(Periods.periodEnd(Q1_2026 + 1));
        vm.prank(issuer);
        income.submitReport(reportInput(sid, Q1_2026 + 1, Proofs.q2(), 1, false)); // owed 12,000
        (due,) = income.openDue(sid);
        assertEq(due, 0);
        assertEq(income.getLedger(sid).routerCredit, 18_000e6); // excess credited forward
    }

    function test_sweepFromReceiver() public {
        vm.prank(issuer);
        income.setRouterTerms(sid, 0, 1e15);
        address receiver = income.getRouter(sid).receiver;
        vm.expectRevert(ZeroUnits.selector);
        income.sweep(sid);
        usdc.mint(receiver, 1_000e6); // income arrives directly at the receiving account
        vm.prank(keeper);
        income.sweep(sid);
        assertEq(usdc.balanceOf(receiver), 0);
        assertEq(usdc.balanceOf(issuer), 700e6);
        assertEq(vault.getLedger(sid).grossReceived, 300e6);
        // only the income contract can pull from the receiver
        usdc.mint(receiver, 1);
        vm.prank(stranger);
        vm.expectRevert(NotIncome.selector);
        MercesRouterReceiver(receiver).forward(IERC20(address(usdc)), 1);
    }

    function test_ytdResetsOnNewYear() public {
        vm.prank(issuer);
        income.setRouterTerms(sid, 80_000e6, 1e15);
        _route(100_000e6); // 20,000 above → 6,000 routed
        assertEq(income.getRouter(sid).ytdYear, 2026);
        vm.warp(Periods.periodStart(Q1_2026 + 4)); // 2027-01-01
        _route(50_000e6); // new year: all below θ
        assertEq(income.getRouter(sid).ytdYear, 2027);
        assertEq(income.getRouter(sid).ytdReceived, 50_000e6);
        assertEq(vault.getLedger(sid).grossReceived, 6_000e6);
    }

    function test_retiredSeriesPassesEverythingThrough() public {
        vm.prank(issuer);
        income.setRouterTerms(sid, 0, 1e15);
        reportAndPay(sid, Q1_2026, Proofs.q1());
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        reportAndPay(sid, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(sid, Q1_2026 + 3, Proofs.q4());
        reportAndPay(sid, Q1_2026 + 4, Proofs.y2q1());
        reportAndPay(sid, Q1_2026 + 5, Proofs.y2q2cap()); // retired
        uint256 before = usdc.balanceOf(issuer);
        _route(1_000e6);
        assertEq(usdc.balanceOf(issuer), before + 1_000e6);
    }
}
