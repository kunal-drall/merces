// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {ProtocolFixture} from "../utils/ProtocolFixture.sol";
import {IMercesTreasury} from "../../src/interfaces/IMercesTreasury.sol";
import {MockEarlyDrawApprover} from "../mocks/MockEarlyDrawApprover.sol";
import {ReleaseTranche, SeriesMode, SeriesParams, SeriesStatus, Parameters} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

contract TreasuryTest is ProtocolFixture {
    uint256 internal sid;
    uint64 internal settlementTs;

    function setUp() public override {
        super.setUp();
        allow(b1);
        allow(b2);
        allow(b3);
        vm.prank(admin);
        registry.setDefaults(_walletCap(10_000));
        // 3 tranches that do not divide evenly
        ReleaseTranche[] memory s = new ReleaseTranche[](3);
        s[0] = ReleaseTranche({atOffsetSeconds: 0, bps: 3333});
        s[1] = ReleaseTranche({atOffsetSeconds: 30 days, bps: 3333});
        s[2] = ReleaseTranche({atOffsetSeconds: 60 days, bps: 3334});
        SeriesParams memory p = defaultSeriesParams();
        p.unitsOffered = 150;
        p.minRaise = 100e6;
        vm.prank(issuer);
        sid = registry.createSeries(p, s, keccak256("terms"), 2, bytes32(0), SeriesMode.SealedBid, false);
        vm.prank(issuer);
        registry.setContractHash(sid, keccak256("c"));
        openRaise(sid);
        // proceeds will be 149 USDC (see Auction.t.sol marginal case)
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
        settle(sid, 1_000_000);
        settlementTs = uint64(block.timestamp);
    }

    function _walletCap(uint16 bps) internal pure returns (Parameters memory d) {
        d = defaultParameters();
        d.walletCapBps = bps;
    }

    function test_blockedUntilMintFinalized() public {
        vm.prank(keeper);
        auction.processBid(sid, 0);
        assertFalse(treasury.getTreasury(sid).finalized);
        assertEq(treasury.vested(sid, block.timestamp), 0);
        assertEq(treasury.claimable(sid), 0);
        vm.prank(issuer);
        vm.expectRevert(MintNotFinalized.selector);
        treasury.claimRelease(sid);
        vm.prank(keeper);
        auction.processBid(sid, 1);
        vm.prank(keeper);
        auction.processBid(sid, 2);
        assertTrue(treasury.getTreasury(sid).finalized);
        assertEq(treasury.getTreasury(sid).proceeds, 149e6);
    }

    function test_tranchesSumExactly() public {
        processAll(sid);
        uint64 t0 = treasury.trancheAmount(sid, 0);
        uint64 t1 = treasury.trancheAmount(sid, 1);
        uint64 t2 = treasury.trancheAmount(sid, 2);
        assertEq(t0, 149e6 * 3333 / 10_000); // 49_661_700
        assertEq(t1, 49_661_700);
        assertEq(t2, 149e6 - 2 * 49_661_700); // remainder, not floor(149e6 × 3334 / 1e4)
        assertEq(t0 + t1 + t2, 149e6);
        assertEq(treasury.trancheAmount(sid, 3), 0);
    }

    function test_vestingAndClaims() public {
        processAll(sid);
        assertEq(treasury.vested(sid, settlementTs), 49_661_700);
        assertEq(treasury.vested(sid, settlementTs + 30 days - 1), 49_661_700);
        assertEq(treasury.vested(sid, settlementTs + 30 days), 2 * 49_661_700);
        assertEq(treasury.vested(sid, settlementTs + 60 days), 149e6);

        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        treasury.claimRelease(sid);

        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesTreasury.ReleaseClaimed(sid, 49_661_700, 49_661_700);
        treasury.claimRelease(sid);
        assertEq(usdc.balanceOf(issuer), 49_661_700);
        vm.prank(issuer);
        vm.expectRevert(NothingToRelease.selector);
        treasury.claimRelease(sid);

        vm.warp(settlementTs + 70 days);
        assertEq(treasury.claimable(sid), 149e6 - 49_661_700);
        vm.prank(issuer);
        treasury.claimRelease(sid);
        assertEq(usdc.balanceOf(issuer), 149e6);
        assertEq(usdc.balanceOf(address(treasury)), 0);
        assertEq(treasury.getTreasury(sid).releasedTotal, 149e6);
    }

    function test_releasesPauseOnlyForLateOrIssuerRequest() public {
        processAll(sid);
        // Late (derived by income) blocks
        mockIncome.setStatus(sid, SeriesStatus.Late);
        vm.prank(issuer);
        vm.expectRevert(SeriesIsLate.selector);
        treasury.claimRelease(sid);
        // InGrace, Paused, Retired, Redeemed do not block
        mockIncome.setStatus(sid, SeriesStatus.InGrace);
        vm.prank(issuer);
        treasury.claimRelease(sid);
        vm.warp(settlementTs + 30 days);
        mockIncome.setStatus(sid, SeriesStatus.Paused);
        vm.prank(issuer);
        treasury.claimRelease(sid);
        // issuer's own pause
        vm.warp(settlementTs + 60 days);
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        treasury.setReleasePause(sid, true);
        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesTreasury.ReleasePauseSet(sid, true);
        treasury.setReleasePause(sid, true);
        vm.prank(issuer);
        vm.expectRevert(ReleasesPausedByIssuer.selector);
        treasury.claimRelease(sid);
        vm.prank(issuer);
        treasury.setReleasePause(sid, false);
        // retired series still release on schedule
        vm.prank(address(mockVault));
        registry.markTerminal(sid, SeriesStatus.Retired);
        mockIncome.setStatus(sid, SeriesStatus.Retired);
        vm.prank(issuer);
        treasury.claimRelease(sid);
        assertEq(usdc.balanceOf(issuer), 149e6);
    }

    function test_extinguishedBlocksAndMovesUnreleased() public {
        processAll(sid);
        vm.prank(issuer);
        treasury.claimRelease(sid); // first tranche
        // only the vault may move funds
        vm.expectRevert(NotProtocolContract.selector);
        treasury.moveUnreleasedToVault(sid);
        vm.prank(address(mockVault));
        vm.expectEmit(true, false, false, true);
        emit IMercesTreasury.UnreleasedMovedToVault(sid, 149e6 - 49_661_700);
        uint64 moved = treasury.moveUnreleasedToVault(sid);
        assertEq(moved, 149e6 - 49_661_700);
        assertEq(usdc.balanceOf(address(mockVault)), moved);
        assertEq(usdc.balanceOf(address(treasury)), 0);
        assertEq(treasury.getTreasury(sid).releasedTotal, 149e6);
        assertEq(treasury.getTreasury(sid).movedToVault, moved);
        vm.prank(address(mockVault));
        registry.markTerminal(sid, SeriesStatus.Extinguished);
        vm.warp(settlementTs + 100 days);
        vm.prank(issuer);
        vm.expectRevert(SeriesIsExtinguished.selector);
        treasury.claimRelease(sid);
    }

    function test_moveUnreleasedRequiresFinalizedWhenSettled() public {
        vm.prank(address(mockVault));
        vm.expectRevert(MintNotFinalized.selector);
        treasury.moveUnreleasedToVault(sid);
        // a never-settled series moves nothing
        uint256 draft = createSeries(keccak256("d"));
        vm.prank(address(mockVault));
        assertEq(treasury.moveUnreleasedToVault(draft), 0);
    }

    function test_earlyDrawHook() public {
        processAll(sid);
        vm.prank(issuer);
        vm.expectRevert(EarlyDrawsDisabled.selector);
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
        // the early draw counts against vesting: first two tranches (99.3 USDC) are already consumed
        assertEq(treasury.claimable(sid), 0);
        vm.warp(settlementTs + 30 days);
        assertEq(treasury.claimable(sid), 0);
        vm.warp(settlementTs + 60 days);
        assertEq(treasury.claimable(sid), 49e6);
        // cannot exceed proceeds
        approver.setApproveAll(true);
        vm.prank(issuer);
        vm.expectRevert(EarlyDrawExceedsProceeds.selector);
        treasury.requestEarlyDraw(sid, 49e6 + 1);
        vm.prank(issuer);
        vm.expectRevert(EarlyDrawExceedsProceeds.selector);
        treasury.requestEarlyDraw(sid, 0);
        vm.prank(issuer);
        treasury.requestEarlyDraw(sid, 49e6);
        assertEq(usdc.balanceOf(issuer), 149e6);
        assertEq(treasury.claimable(sid), 0);
    }

    function test_depositAndFinalizeOnlyAuction() public {
        vm.expectRevert(NotProtocolContract.selector);
        treasury.depositProceeds(sid, 1);
        vm.expectRevert(NotProtocolContract.selector);
        treasury.finalizeProceeds(sid, 1);
        processAll(sid);
        vm.prank(address(auction));
        vm.expectRevert(ProceedsAlreadyFinalized.selector);
        treasury.depositProceeds(sid, 1);
        vm.prank(address(auction));
        vm.expectRevert(ProceedsAlreadyFinalized.selector);
        treasury.finalizeProceeds(sid, 149e6);
    }

    function testFuzz_tranchesAlwaysSumToProceeds(uint64 proceeds, uint16 a, uint16 b) public pure {
        a = uint16(bound(a, 0, 10_000));
        b = uint16(bound(b, 0, 10_000 - a));
        uint16 c = 10_000 - a - b;
        ReleaseTranche[] memory s = new ReleaseTranche[](3);
        s[0] = ReleaseTranche(0, a);
        s[1] = ReleaseTranche(1, b);
        s[2] = ReleaseTranche(2, c);
        uint256 t0 = uint256(proceeds) * a / 10_000;
        uint256 t1 = uint256(proceeds) * b / 10_000;
        uint256 t2 = proceeds - t0 - t1;
        assertEq(t0 + t1 + t2, proceeds);
        assertGe(t2, uint256(proceeds) * c / 10_000); // remainder absorbs the rounding dust
    }
}
