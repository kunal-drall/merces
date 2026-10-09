// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {IMercesRouter} from "../../src/interfaces/IMercesRouter.sol";
import {MercesRouterReceiver} from "../../src/MercesRouterReceiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {TierFlags} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

/// @notice Tier-1 split router (D5, SPEC v1.1 §6.5): θ = 80,000 USDC, r = 0.1 %/unit × 300 units = 30 %.
contract RouterTest is FullFixture {
    uint256 internal sid; // pure tier-1 series
    address internal payer = makeAddr("client");

    function setUp() public override {
        super.setUp();
        sid = runStandardRaise(TierFlags.TIER1_SPLIT, bytes32(0));
    }

    function _route(uint256 s, uint64 amount) internal {
        fund(payer, amount);
        vm.startPrank(payer);
        usdc.approve(address(router), amount);
        router.route(s, amount);
        vm.stopPrank();
    }

    function test_receiverIsDeterministic() public {
        address predicted = router.routerReceiver(sid);
        assertTrue(predicted != address(0));
        assertEq(predicted.code.length, 0);
        vm.prank(stranger);
        vm.expectEmit(true, false, false, true);
        emit IMercesRouter.RouterReceiverCreated(sid, predicted);
        address created = router.createRouterReceiver(sid);
        assertEq(created, predicted);
        assertEq(router.routerReceiver(sid), predicted);
        assertEq(router.createRouterReceiver(sid), predicted); // idempotent
        assertEq(MercesRouterReceiver(predicted).router(), address(router));
        assertEq(MercesRouterReceiver(predicted).seriesId(), sid);
        uint256 nonTier1 = runStandardRaise(TierFlags.TIER2_ZKTLS, bytes32(0));
        vm.expectRevert(RouterNotEnabled.selector);
        router.createRouterReceiver(nonTier1);
    }

    function test_routeGuards() public {
        uint256 nonTier1 = runStandardRaise(TierFlags.TIER2_ZKTLS, bytes32(0));
        vm.expectRevert(RouterNotEnabled.selector);
        router.route(nonTier1, 1);
        uint256 draft = createSeriesWith(
            defaultSeriesParams(), defaultSchedule(), Proofs.q1().termsCommitment, 1, bytes32(0), proofTier1Terms()
        );
        vm.expectRevert(RaiseNotSettled.selector);
        router.route(draft, 1);
        vm.expectRevert(ZeroAmount.selector);
        router.route(sid, 0);
        vm.expectRevert(RouterNotConfigured.selector);
        router.sweep(sid);
        router.createRouterReceiver(sid);
        vm.expectRevert(ZeroAmount.selector);
        router.sweep(sid);
        address receiver = router.routerReceiver(sid);
        usdc.mint(receiver, 1);
        vm.prank(stranger);
        vm.expectRevert(NotRouter.selector);
        MercesRouterReceiver(receiver).forward(IERC20(address(usdc)), 1);
    }

    function test_splitAndPureTier1Report() public {
        // 50,000 below θ: all to the issuer
        fund(payer, 50_000e6);
        vm.startPrank(payer);
        usdc.approve(address(router), 50_000e6);
        vm.expectEmit(true, false, false, true);
        emit IMercesRouter.IncomeRouted(sid, 50_000e6, 50_000e6, 0, 50_000e6);
        router.route(sid, 50_000e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(issuer), 50_000e6);
        assertEq(income.getLedger(sid).routerCredit, 0);
        // 70,000 more: 30,000 passes through, 40,000 above → share 12,000 to the vault
        _route(sid, 70_000e6);
        assertEq(usdc.balanceOf(issuer), 50_000e6 + 58_000e6);
        assertEq(income.getLedger(sid).routerCredit, 12_000e6);
        IMercesRouter.Router memory r = router.getRouter(sid);
        assertEq(r.ytdReceived, 120_000e6);
        assertEq(r.ytdYear, 2026);
        assertEq(r.lastReceiptPeriod, Q1_2026);
        assertEq(r.routedTotal, 12_000e6);
        assertEq(r.passedThroughTotal, 108_000e6);
        assertEq(vault.getLedger(sid).grossReceived, 12_000e6);
        assertEq(usdc.balanceOf(address(vault)), 11_400e6);
        assertEq(usdc.balanceOf(address(router)), 0);

        // the Q1 report binds to the router checkpoint: it must be closed first
        vm.warp(Periods.periodEnd(Q1_2026));
        IMercesIncome.ReportInput memory r1 = reportInput(sid, Q1_2026, Proofs.t1q1(), 1, false);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(RouterPeriodNotClosed.selector, Q1_2026));
        income.submitReport(r1);
        vm.expectRevert(abi.encodeWithSelector(PeriodNotEndedYet.selector, Q1_2026 + 1));
        router.closeRouterPeriod(sid, Q1_2026 + 1);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesRouter.RouterPeriodClosed(sid, Q1_2026, 120_000e6);
        router.closeRouterPeriod(sid, Q1_2026);
        (bool exists, uint64 ytd) = router.ytdAtEnd(sid, Q1_2026);
        assertTrue(exists);
        assertEq(ytd, 120_000e6);
        router.closeRouterPeriod(sid, Q1_2026); // idempotent
        // a salted (tier 2 style) commitment does not match the public YTD
        vm.prank(issuer);
        vm.expectRevert(IncomeCommitmentMismatch.selector);
        income.submitReport(reportInput(sid, Q1_2026, Proofs.q1(), 1, false));
        // the pure tier-1 report needs no signature and is fully covered by the routed credit
        vm.prank(issuer);
        income.submitReport(r1);
        (uint64 due,) = income.openDue(sid);
        assertEq(due, 0);
        assertEq(income.getLedger(sid).routerCredit, 0);
        (bool hasPaid, uint32 lp) = income.lastPaidPeriod(sid);
        assertTrue(hasPaid);
        assertEq(lp, Q1_2026);
        assertEq(vault.pendingOf(sid, b1), 3_800e6);

        // Q2: 40,000 more (YTD 160,000) → share 12,000; the Q2 report binds to both checkpoints
        _route(sid, 40_000e6);
        assertEq(income.getLedger(sid).routerCredit, 12_000e6);
        vm.warp(Periods.periodEnd(Q1_2026 + 1));
        router.closeRouterPeriod(sid, Q1_2026 + 1);
        (, ytd) = router.ytdAtEnd(sid, Q1_2026 + 1);
        assertEq(ytd, 160_000e6);
        vm.prank(issuer);
        income.submitReport(reportInput(sid, Q1_2026 + 1, Proofs.t1q2(), 1, false));
        (due,) = income.openDue(sid);
        assertEq(due, 0);
        // a tier-1 report whose prior does not match the previous checkpoint is refused
    }

    function test_checkpointsAcrossYears() public {
        _route(sid, 100_000e6); // Q1 2026; 20,000 above θ → 6,000 routed
        (bool exists,) = router.ytdAtEnd(sid, Q1_2026);
        assertFalse(exists);
        (exists,) = router.ytdAtEnd(sid, Q1_2026 - 1);
        assertTrue(exists); // before the first period: 0 by definition
        vm.warp(Periods.periodEnd(Q1_2026 + 3)); // 2027-01-01
        vm.prank(keeper);
        router.closeRouterPeriod(sid, Q1_2026 + 3); // closes Q1..Q4 2026 at the year total
        for (uint32 q = 0; q < 4; q++) {
            (, uint64 y) = router.ytdAtEnd(sid, Q1_2026 + q);
            assertEq(y, 100_000e6);
        }
        IMercesRouter.Router memory r = router.getRouter(sid);
        assertTrue(r.hasCheckpoint);
        assertEq(r.lastCheckpointPeriod, Q1_2026 + 3);
        // a new year without receipts checkpoints at 0
        vm.warp(Periods.periodEnd(Q1_2026 + 4));
        router.closeRouterPeriod(sid, Q1_2026 + 4);
        (, uint64 y27) = router.ytdAtEnd(sid, Q1_2026 + 4);
        assertEq(y27, 0);
        // a receipt in Q3 2027 closes Q2 2027 at 0 and starts the new YTD
        vm.warp(Periods.periodStart(Q1_2026 + 6) + 1);
        _route(sid, 50_000e6);
        (, uint64 q2) = router.ytdAtEnd(sid, Q1_2026 + 5);
        assertEq(q2, 0);
        r = router.getRouter(sid);
        assertEq(r.ytdYear, 2027);
        assertEq(r.ytdReceived, 50_000e6);
        assertEq(r.lastCheckpointPeriod, Q1_2026 + 5);
        assertEq(vault.getLedger(sid).grossReceived, 6_000e6);
    }

    function test_shortfallAndExcessReconcileThroughAttestedReports() public {
        // tier 1 + tier 2: the router credits, the attested quarterly proof remains the source of truth
        uint256 s = runStandardRaise(TierFlags.TIER1_SPLIT | TierFlags.TIER2_ZKTLS, bytes32(0));
        _route(s, 100_000e6); // routes 30% of 20,000 = 6,000; the proof says 12,000 is owed
        assertEq(income.getLedger(s).routerCredit, 6_000e6);
        vm.warp(Periods.periodEnd(Q1_2026));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(TierNotEnabled.selector, 1));
        income.submitReport(reportInput(s, Q1_2026, Proofs.q1(), 1, false));
        vm.prank(issuer);
        income.submitReport(reportInput(s, Q1_2026, Proofs.q1(), 2, false));
        (uint64 due,) = income.openDue(s);
        assertEq(due, 6_000e6); // shortfall collected at report time
        payDue(s, issuer);
        assertEq(vault.getLedger(s).grossReceived, 12_000e6);
        // excess: route more than owed in Q2 → the credit carries forward
        _route(s, 100_000e6); // all above θ now (ytd 200,000) → share 30,000
        assertEq(income.getLedger(s).routerCredit, 30_000e6);
        vm.warp(Periods.periodEnd(Q1_2026 + 1));
        vm.prank(issuer);
        income.submitReport(reportInput(s, Q1_2026 + 1, Proofs.q2(), 2, false)); // owed 12,000
        (due,) = income.openDue(s);
        assertEq(due, 0);
        assertEq(income.getLedger(s).routerCredit, 18_000e6);
    }

    function test_sweepFromReceiver() public {
        address receiver = router.createRouterReceiver(sid);
        _route(sid, 80_000e6); // θ consumed
        usdc.mint(receiver, 1_000e6); // income arrives directly at the receiving account
        uint256 before = usdc.balanceOf(issuer);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesRouter.IncomeRouted(sid, 1_000e6, 700e6, 300e6, 81_000e6);
        router.sweep(sid);
        assertEq(usdc.balanceOf(receiver), 0);
        assertEq(usdc.balanceOf(issuer), before + 700e6);
        assertEq(vault.getLedger(sid).grossReceived, 300e6);
    }

    function test_incomeBeforeFinalizationWaitsInReceiver() public {
        uint256 s = standardSeries(TierFlags.TIER1_SPLIT, bytes32(0));
        // before settlement the raise may still fail: nothing is accepted
        fund(payer, 1);
        vm.startPrank(payer);
        usdc.approve(address(router), 1);
        vm.expectRevert(RaiseNotSettled.selector);
        router.route(s, 1);
        vm.stopPrank();
        allow(b1);
        allow(b2);
        allow(b3);
        openRaise(s);
        address[3] memory bidders = [b1, b2, b3];
        uint64 escrow = escrowFor(P0, 100);
        for (uint256 i = 0; i < 3; i++) {
            commit(s, plan(bidders[i], P0, 100, escrow));
        }
        warpToReveal(s);
        for (uint256 i = 0; i < 3; i++) {
            reveal(s, plan(bidders[i], P0, 100, escrow));
        }
        warpToSettle(s);
        settle(s, P0, 0, 300);
        // settled but not yet mint-finalized: income waits in the receiving account (SPEC §6.5)
        address receiver = router.routerReceiver(s);
        fund(payer, 30_000e6);
        vm.startPrank(payer);
        usdc.approve(address(router), 30_000e6);
        vm.expectEmit(true, false, false, true);
        emit IMercesRouter.IncomeHeld(s, 30_000e6, 30_000e6);
        router.route(s, 30_000e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(receiver), 30_000e6);
        assertEq(router.getRouter(s).heldBeforeFinalization, 30_000e6);
        vm.expectRevert(MintNotFinalized.selector);
        router.sweep(s);
        processAll(s);
        deliverAll(s);
        // the next receipt collects the held income: 90,000 YTD → 10,000 above θ → 30 % = 3,000 to the vault
        fund(payer, 60_000e6);
        vm.startPrank(payer);
        usdc.approve(address(router), 60_000e6);
        vm.expectEmit(true, false, false, true);
        emit IMercesRouter.IncomeRouted(s, 90_000e6, 87_000e6, 3_000e6, 90_000e6);
        router.route(s, 60_000e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(receiver), 0);
        assertEq(vault.getLedger(s).grossReceived, 3_000e6);
    }

    function test_retiredSeriesPassesEverythingThrough() public {
        uint256 s = runStandardRaise(TierFlags.TIER1_SPLIT | TierFlags.TIER2_ZKTLS, bytes32(0));
        reportAndPay(s, Q1_2026, Proofs.q1());
        reportAndPay(s, Q1_2026 + 1, Proofs.q2());
        reportAndPay(s, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(s, Q1_2026 + 3, Proofs.q4());
        reportAndPay(s, Q1_2026 + 4, Proofs.y2q1());
        reportAndPay(s, Q1_2026 + 5, Proofs.y2q2cap()); // retired
        uint256 before = usdc.balanceOf(issuer);
        _route(s, 200_000e6);
        assertEq(usdc.balanceOf(issuer), before + 200_000e6);
    }
}
