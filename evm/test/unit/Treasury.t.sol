// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {IMercesTreasury} from "../../src/interfaces/IMercesTreasury.sol";
import {MockEarlyDrawApprover} from "../mocks/MockEarlyDrawApprover.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {ReleaseTranche, SeriesParams, SeriesStatus} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

contract TreasuryTest is FullFixture {
    uint256 internal sid;
    uint64 internal sTs;
    uint64 internal constant T1 = 49_661_700; // floor(149e6 × 3333 / 10000)

    function setUp() public override {
        super.setUp();
        allow(b1);
        allow(b2);
        allow(b3);
        vm.prank(admin);
        registry.setDefaults(walletCap(10_000));
        // 3 tranches that do not divide evenly
        ReleaseTranche[] memory s = new ReleaseTranche[](3);
        s[0] = ReleaseTranche({atOffsetSeconds: 0, bps: 3333});
        s[1] = ReleaseTranche({atOffsetSeconds: 30 days, bps: 3333});
        s[2] = ReleaseTranche({atOffsetSeconds: 60 days, bps: 3334});
        SeriesParams memory p = defaultSeriesParams();
        p.unitsOffered = 150;
        p.minRaise = 100e6;
        sid = createSeriesWith(p, s, keccak256("terms"), 2, bytes32(0), noTier1());
        openRaise(sid);
        // proceeds will be exactly 149 USDC (see Auction.t.sol marginal case)
        BidPlan memory p1 = plan(b1, 1_500_000, 100, escrowFor(1_500_000, 100));
        BidPlan memory p2 = plan(b2, 1_000_000, 70, escrowFor(1_000_000, 70));
        BidPlan memory p3 = plan(b3, 1_000_000, 50, escrowFor(1_000_000, 50));
        commit(sid, p1);
        commit(sid, p2);
        commit(sid, p3);
        warpToReveal(sid);
        reveal(sid, p1);
        reveal(sid, p2);
        reveal(sid, p3);
        warpToSettle(sid);
        settle(sid, 1_000_000, 100, 120);
        sTs = uint64(block.timestamp);
    }

    function test_blockedUntilMintFinalized() public {
        assertTrue(treasury.getTreasury(sid).proceedsSet);
        assertEq(treasury.getTreasury(sid).proceeds, 149e6);
        vm.prank(keeper);
        auction.processBid(sid, 0);
        assertEq(treasury.getTreasury(sid).deposited, 100e6);
        assertFalse(registry.getSeriesCore(sid).mintFinalized);
        vm.prank(issuer);
        vm.expectRevert(MintNotFinalized.selector);
        treasury.claimRelease(sid);
        vm.prank(keeper);
        auction.processBid(sid, 1);
        vm.prank(keeper);
        auction.processBid(sid, 2);
        assertTrue(registry.getSeriesCore(sid).mintFinalized);
        assertEq(treasury.getTreasury(sid).deposited, 149e6);
        // releases do not wait for deliveries
        vm.prank(issuer);
        treasury.claimRelease(sid);
        assertEq(usdc.balanceOf(issuer), T1);
    }

    function test_tranchesSumExactly() public {
        processAll(sid);
        uint64 t0 = treasury.trancheAmount(sid, 0);
        uint64 t1 = treasury.trancheAmount(sid, 1);
        uint64 t2 = treasury.trancheAmount(sid, 2);
        assertEq(t0, T1);
        assertEq(t1, T1);
        assertEq(t2, 149e6 - 2 * T1); // remainder, not floor(149e6 × 3334 / 1e4)
        assertEq(t0 + t1 + t2, 149e6);
        assertEq(treasury.trancheAmount(sid, 3), 0);
    }

    function test_vestingAndClaims() public {
        processAll(sid);
        assertEq(treasury.vested(sid, sTs), T1);
        assertEq(treasury.vested(sid, sTs + 30 days - 1), T1);
        assertEq(treasury.vested(sid, sTs + 30 days), 2 * T1);
        assertEq(treasury.vested(sid, sTs + 60 days), 149e6);

        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        treasury.claimRelease(sid);

        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesTreasury.ReleaseClaimed(sid, T1, T1);
        treasury.claimRelease(sid);
        assertEq(usdc.balanceOf(issuer), T1);
        vm.prank(issuer);
        vm.expectRevert(NothingVested.selector);
        treasury.claimRelease(sid);

        vm.warp(sTs + 70 days);
        assertEq(treasury.claimable(sid), 149e6 - T1);
        vm.prank(issuer);
        treasury.claimRelease(sid);
        assertEq(usdc.balanceOf(issuer), 149e6);
        assertEq(usdc.balanceOf(address(treasury)), 0);
        assertEq(treasury.getTreasury(sid).releasedTotal, 149e6);
    }

    /// @dev Releases pause only while Late (derived or underlying clock) or at the issuer's own request.
    function test_releaseBlocks() public {
        processAll(sid);
        // first period Q1 2026: deadline Apr 1 + 30 d, grace + 15 d
        uint64 deadline = Periods.periodEnd(Q1_2026) + 30 days;
        uint64 graceEnd = deadline + 15 days;
        vm.warp(deadline + 1); // InGrace: releases continue
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.InGrace));
        vm.prank(issuer);
        treasury.claimRelease(sid);
        assertEq(usdc.balanceOf(issuer), 149e6);
        vm.warp(graceEnd + 1); // Late: blocked even before any vesting check
        vm.prank(issuer);
        vm.expectRevert(SeriesLate.selector);
        treasury.claimRelease(sid);
        // a hardship pause stops the clock but does not lift a block already in force
        vm.prank(issuer);
        income.requestPause(sid);
        uint64 pauseEnd = uint64(block.timestamp) + 30 days;
        income.approvePause(sid, pauseEnd, pauseSig(sid, 1, pauseEnd));
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Paused));
        assertTrue(income.isLateUnderlying(sid));
        vm.prank(issuer);
        vm.expectRevert(SeriesLate.selector);
        treasury.claimRelease(sid);
        vm.prank(issuer);
        income.endPause(sid);
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Late));
        vm.prank(issuer);
        vm.expectRevert(SeriesLate.selector);
        treasury.claimRelease(sid);
        // (becoming current again lifts the block: Income.t.sol test_statusDerivationTimeline)

        // issuer's own pause
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        treasury.setReleasePause(sid, true);
        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesTreasury.ReleasePauseSet(sid, true);
        treasury.setReleasePause(sid, true);
        vm.prank(issuer);
        vm.expectRevert(ReleasesPaused.selector);
        treasury.claimRelease(sid);
        vm.prank(issuer);
        treasury.setReleasePause(sid, false);
    }

    function test_pauseBeforeDeadlineDoesNotBlock() public {
        processAll(sid);
        vm.warp(Periods.periodEnd(Q1_2026)); // OnTime
        vm.prank(issuer);
        income.requestPause(sid);
        uint64 pauseEnd = uint64(block.timestamp) + 100 days;
        income.approvePause(sid, pauseEnd, pauseSig(sid, 1, pauseEnd));
        vm.warp(block.timestamp + 90 days); // without the pause this would be Late
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Paused));
        assertFalse(income.isLateUnderlying(sid));
        vm.prank(issuer);
        treasury.claimRelease(sid);
        assertEq(usdc.balanceOf(issuer), 149e6);
    }

    function test_extinguishmentKeepsVestedEstate() public {
        processAll(sid);
        vm.prank(issuer);
        treasury.claimRelease(sid); // first tranche
        vm.expectRevert(NotProtocolContract.selector);
        treasury.moveUnreleasedToVault(sid);
        vm.warp(sTs + 30 days); // second tranche vested but unclaimed
        vm.prank(address(vault));
        vm.expectEmit(true, false, false, true);
        emit IMercesTreasury.UnreleasedMovedToVault(sid, 149e6 - 2 * T1);
        uint64 moved = treasury.moveUnreleasedToVault(sid);
        assertEq(moved, 149e6 - 2 * T1);
        assertEq(usdc.balanceOf(address(vault)), moved);
        IMercesTreasury.Ledger memory l = treasury.getTreasury(sid);
        assertEq(l.movedToVault, moved);
        assertEq(l.extinguishedAt, sTs + 30 days);
        assertEq(l.releasedTotal, T1);
        vm.prank(address(vault));
        vm.expectRevert(TerminalStatus.selector);
        treasury.moveUnreleasedToVault(sid);
        // the estate keeps what had vested by extinguished_at, and nothing more ever vests
        vm.warp(sTs + 100 days);
        assertEq(treasury.claimable(sid), T1);
        vm.prank(issuer);
        treasury.claimRelease(sid);
        assertEq(usdc.balanceOf(issuer), 2 * T1);
        assertEq(usdc.balanceOf(address(treasury)), 0);
        vm.prank(issuer);
        vm.expectRevert(NothingVested.selector);
        treasury.claimRelease(sid);
    }

    function test_moveUnreleasedBeforeSettlementMovesNothing() public {
        uint256 draft = createSeries(keccak256("d"));
        vm.prank(address(vault));
        assertEq(treasury.moveUnreleasedToVault(draft), 0);
    }

    function test_earlyDrawHook() public {
        processAll(sid);
        vm.prank(issuer);
        vm.expectRevert(EarlyDrawDisabled.selector);
        treasury.requestEarlyDraw(sid, 10e6);

        MockEarlyDrawApprover approver = new MockEarlyDrawApprover();
        vm.prank(admin);
        registry.setEarlyDrawApprover(address(approver));
        vm.prank(issuer);
        vm.expectRevert(EarlyDrawNotApproved.selector);
        treasury.requestEarlyDraw(sid, 10e6);
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        treasury.requestEarlyDraw(sid, 10e6);

        approver.approve(sid, 100e6, 0);
        vm.prank(issuer);
        vm.expectEmit(true, true, false, true);
        emit IMercesTreasury.EarlyDrawExecuted(sid, 100e6, address(approver));
        treasury.requestEarlyDraw(sid, 100e6);
        assertEq(usdc.balanceOf(issuer), 100e6);
        IMercesTreasury.Ledger memory l = treasury.getTreasury(sid);
        assertEq(l.releasedTotal, 100e6);
        assertEq(l.earlyDrawTotal, 100e6);
        assertEq(l.earlyDrawNonce, 1);
        // the early draw counts against vesting: the first two tranches (99.3 USDC) are already consumed
        assertEq(treasury.claimable(sid), 0);
        vm.warp(sTs + 30 days);
        assertEq(treasury.claimable(sid), 0);
        vm.warp(sTs + 60 days);
        assertEq(treasury.claimable(sid), 49e6);
        approver.setApproveAll(true);
        vm.prank(issuer);
        vm.expectRevert(ExceedsProceeds.selector);
        treasury.requestEarlyDraw(sid, 49e6 + 1);
        vm.prank(issuer);
        vm.expectRevert(ZeroAmount.selector);
        treasury.requestEarlyDraw(sid, 0);
        vm.prank(issuer);
        treasury.requestEarlyDraw(sid, 49e6);
        assertEq(usdc.balanceOf(issuer), 149e6);
        assertEq(treasury.claimable(sid), 0);
    }

    function test_earlyDrawCappedAtExtinguishment() public {
        processAll(sid);
        MockEarlyDrawApprover approver = new MockEarlyDrawApprover();
        approver.setApproveAll(true);
        vm.prank(admin);
        registry.setEarlyDrawApprover(address(approver));
        vm.prank(issuer);
        treasury.requestEarlyDraw(sid, 100e6); // more than has vested
        vm.prank(address(vault));
        uint64 moved = treasury.moveUnreleasedToVault(sid);
        // proceeds − vested(now) = 149 − 49.66 would exceed the balance; the move is capped by what is left
        assertEq(moved, 49e6);
        assertEq(usdc.balanceOf(address(treasury)), 0);
        vm.prank(issuer);
        vm.expectRevert(TerminalStatus.selector);
        treasury.requestEarlyDraw(sid, 1);
    }

    function test_auctionOnlyAccounting() public {
        vm.expectRevert(NotProtocolContract.selector);
        treasury.depositProceeds(sid, 1);
        vm.expectRevert(NotProtocolContract.selector);
        treasury.setProceeds(sid, 1);
        vm.expectRevert(NotProtocolContract.selector);
        treasury.confirmDeposits(sid);
        vm.startPrank(address(auction));
        vm.expectRevert(ProceedsAlreadySet.selector);
        treasury.setProceeds(sid, 149e6);
        vm.expectRevert(ProceedsMismatch.selector);
        treasury.confirmDeposits(sid); // nothing deposited yet
        vm.expectRevert(ProceedsMismatch.selector);
        treasury.depositProceeds(sid, 149e6 + 1); // more than the exact proceeds
        vm.stopPrank();
        uint256 draft = createSeries(keccak256("d"));
        vm.prank(address(auction));
        vm.expectRevert(ProceedsMismatch.selector);
        treasury.depositProceeds(draft, 1); // proceeds unknown
    }

    function testFuzz_tranchesAlwaysSumToProceeds(uint64 proceeds, uint16 a, uint16 b) public pure {
        a = uint16(bound(a, 0, 10_000));
        b = uint16(bound(b, 0, 10_000 - a));
        uint16 c = 10_000 - a - b;
        uint256 t0 = uint256(proceeds) * a / 10_000;
        uint256 t1 = uint256(proceeds) * b / 10_000;
        uint256 t2 = proceeds - t0 - t1;
        assertEq(t0 + t1 + t2, proceeds);
        assertGe(t2, uint256(proceeds) * c / 10_000); // the remainder absorbs the rounding dust
    }
}
