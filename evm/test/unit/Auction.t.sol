// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {ProtocolFixture} from "../utils/ProtocolFixture.sol";
import {IMercesAuction} from "../../src/interfaces/IMercesAuction.sol";
import {IMercesTreasury} from "../../src/interfaces/IMercesTreasury.sol";
import {IMercesRegistry} from "../../src/interfaces/IMercesRegistry.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Parameters, RaiseState, SeriesCore, SeriesMode, SeriesParams} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

contract AuctionTest is ProtocolFixture {
    uint256 internal sid;

    function setUp() public override {
        super.setUp();
        sid = createSeries(keccak256("terms"));
        allow(b1);
        allow(b2);
        allow(b3);
    }

    // ------------------------------------------------------------ open / cancel

    function test_openRaise() public {
        vm.prank(issuer);
        vm.expectEmit(true, false, false, false);
        emit IMercesAuction.RaiseOpened(sid, address(0), 0, 0, 0);
        auction.openRaise(sid);
        IMercesAuction.Auction memory a = auction.getAuction(sid);
        assertEq(uint8(a.state), uint8(RaiseState.Open));
        assertEq(a.openedAt, T0);
        assertEq(a.commitEnd, T0 + 7 days);
        assertEq(a.revealEnd, T0 + 9 days);
        SeriesCore memory c = registry.getSeriesCore(sid);
        assertEq(uint8(c.raiseState), uint8(RaiseState.Open));
        assertEq(c.unitToken, a.unitToken);
        assertEq(unitToken(sid).decimals(), 0);
        assertEq(unitToken(sid).name(), string.concat("Merces HEU ", vm.toString(sid)));
        assertTrue(unitToken(sid).isAgent(address(auction)));
        assertTrue(unitToken(sid).isAgent(address(mockVault)));
        assertEq(tokenFactory.tokenOf(sid), a.unitToken);
    }

    function test_openRaiseGuards() public {
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        auction.openRaise(sid);

        // no contract hash
        vm.prank(issuer);
        uint256 draft = registry.createSeries(
            defaultSeriesParams(), defaultSchedule(), keccak256("t2"), 2, bytes32(0), SeriesMode.SealedBid, false
        );
        vm.prank(issuer);
        vm.expectRevert(ContractHashNotSet.selector);
        auction.openRaise(draft);

        // new raises paused
        vm.prank(admin);
        registry.setFlags(true, false, false);
        vm.prank(issuer);
        vm.expectRevert(NewRaisesPaused.selector);
        auction.openRaise(sid);
        vm.prank(admin);
        registry.setFlags(false, false, false);

        // issuer no longer allowlisted
        disallow(issuer);
        vm.prank(issuer);
        vm.expectRevert(IssuerNotAllowlisted.selector);
        auction.openRaise(sid);
        allow(issuer);

        openRaise(sid);
        vm.prank(issuer);
        vm.expectRevert(RaiseNotDraft.selector);
        auction.openRaise(sid);
    }

    function test_cancelOnlyBeforeBids() public {
        vm.prank(issuer);
        vm.expectRevert(RaiseNotOpen.selector);
        auction.cancelRaise(sid);
        openRaise(sid);
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        auction.cancelRaise(sid);
        commit(sid, plan(b1, 1e6, 10, escrowFor(1e6, 10)));
        vm.prank(issuer);
        vm.expectRevert(BidsExist.selector);
        auction.cancelRaise(sid);

        uint256 sid2 = createSeries(keccak256("t2"));
        openRaise(sid2);
        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.RaiseCancelled(sid2);
        auction.cancelRaise(sid2);
        assertEq(uint8(registry.getSeriesCore(sid2).raiseState), uint8(RaiseState.Cancelled));
        assertEq(uint8(auction.getAuction(sid2).state), uint8(RaiseState.Cancelled));
    }

    // ------------------------------------------------------------ commit / reveal

    function test_commitGuards() public {
        BidPlan memory b = plan(b1, 1e6, 10, escrowFor(1e6, 10));
        vm.expectRevert(RaiseNotOpen.selector);
        auction.commitBid(sid, bytes32(0), 1);
        openRaise(sid);
        fund(stranger, 1e6);
        vm.startPrank(stranger);
        usdc.approve(address(auction), 1e6);
        vm.expectRevert(abi.encodeWithSelector(WalletNotAllowlisted.selector, stranger));
        auction.commitBid(sid, bytes32(0), 1e6);
        vm.stopPrank();
        vm.prank(b1);
        vm.expectRevert(ZeroEscrow.selector);
        auction.commitBid(sid, bytes32(0), 0);
        commit(sid, b);
        fund(b1, 1e6);
        vm.startPrank(b1);
        usdc.approve(address(auction), 1e6);
        vm.expectRevert(BidAlreadyExists.selector);
        auction.commitBid(sid, bytes32(0), 1e6);
        vm.stopPrank();
        warpToReveal(sid);
        vm.prank(b2);
        vm.expectRevert(CommitPhaseOver.selector);
        auction.commitBid(sid, bytes32(0), 1e6);
        // escrow pulled
        assertEq(usdc.balanceOf(address(auction)), b.escrow);
        assertEq(auction.getAuction(sid).escrowTotal, b.escrow);
        (bool exists, uint256 idx) = auction.bidIndexOf(sid, b1);
        assertTrue(exists);
        assertEq(idx, 0);
    }

    function test_revealGuardsAndValidity() public {
        openRaise(sid);
        BidPlan memory ok = plan(b1, 1e6, 10, escrowFor(1e6, 10));
        BidPlan memory belowReserve = plan(b2, 999_999, 10, escrowFor(999_999, 10));
        BidPlan memory overCap = plan(b3, 1e6, 101, escrowFor(1e6, 101)); // cap = 10% of 1000 = 100
        commit(sid, ok);
        commit(sid, belowReserve);
        commit(sid, overCap);

        vm.prank(b1);
        vm.expectRevert(NotRevealPhase.selector);
        auction.revealBid(sid, ok.price, ok.quantity, ok.salt);
        warpToReveal(sid);
        vm.prank(stranger);
        vm.expectRevert(BidNotFound.selector);
        auction.revealBid(sid, 1, 1, bytes32(0));
        vm.prank(b1);
        vm.expectRevert(CommitmentMismatch.selector);
        auction.revealBid(sid, ok.price, ok.quantity + 1, ok.salt);

        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IMercesAuction.BidRevealed(sid, b1, 1e6, 10, true);
        auction.revealBid(sid, ok.price, ok.quantity, ok.salt);
        vm.prank(b1);
        vm.expectRevert(BidAlreadyRevealed.selector);
        auction.revealBid(sid, ok.price, ok.quantity, ok.salt);

        reveal(sid, belowReserve);
        assertFalse(auction.getBid(sid, 1).valid);
        reveal(sid, overCap);
        assertFalse(auction.getBid(sid, 2).valid);
        assertEq(auction.getAuction(sid).revealedCount, 3);
        assertEq(auction.getAuction(sid).validCount, 1);
        assertEq(auction.getBid(sid, 0).revealIndex, 0);
        assertEq(auction.getBid(sid, 2).revealIndex, 2);

        warpToSettle(sid);
        vm.prank(b1);
        vm.expectRevert(NotRevealPhase.selector);
        auction.revealBid(sid, ok.price, ok.quantity, ok.salt);
    }

    function test_revealInsufficientEscrowIsInvalid() public {
        openRaise(sid);
        // escrow covers price × quantity but not the 1% fee
        BidPlan memory b = plan(b1, 1e6, 10, 10e6);
        commit(sid, b);
        warpToReveal(sid);
        reveal(sid, b);
        assertFalse(auction.getBid(sid, 0).valid);
        assertEq(auction.requiredEscrow(sid, 1e6, 10), 10_100_000);
        assertEq(auction.walletCapUnitsAtAuction(sid), 100);
    }

    // ------------------------------------------------------------ settlement

    function test_happyPathUniformPrice() public {
        // 1000 units offered, min raise 200 USDC; b1: 100 @ 1.20, b2: 100 @ 1.10, b3: 100 @ 1.00 → all win,
        // D = 300 < N so p* must be the lowest valid price (1.00)
        vm.prank(issuer);
        sid = registry.createSeries(
            smallParams(1000, 1e6, 200e6), defaultSchedule(), keccak256("hp"), 2, bytes32(0), SeriesMode.SealedBid, false
        );
        vm.prank(issuer);
        registry.setContractHash(sid, keccak256("c"));
        openRaise(sid);
        BidPlan memory p1 = plan(b1, 1_200_000, 100, escrowFor(1_200_000, 100));
        BidPlan memory p2 = plan(b2, 1_100_000, 100, escrowFor(1_100_000, 100) + 5e6); // over-collateralised
        BidPlan memory p3 = plan(b3, 1_000_000, 100, escrowFor(1_000_000, 100));
        commit(sid, p1);
        commit(sid, p2);
        commit(sid, p3);
        warpToReveal(sid);
        reveal(sid, p1);
        reveal(sid, p2);
        reveal(sid, p3);
        warpToSettle(sid);

        // wrong proposals
        vm.startPrank(keeper);
        auction.beginSettlement(sid, 1_100_000);
        auction.tallyBids(sid, 0, 3);
        vm.expectRevert(InvalidClearingPrice.selector); // a valid bid sits below p* and D < N
        auction.finalizeSettlement(sid);
        auction.beginSettlement(sid, 900_000);
        auction.tallyBids(sid, 0, 3);
        vm.expectRevert(InvalidClearingPrice.selector); // no bid exactly at p*
        auction.finalizeSettlement(sid);
        vm.stopPrank();

        uint64 p = 1_000_000;
        uint64 ts = uint64(block.timestamp);
        vm.prank(keeper);
        auction.beginSettlement(sid, p);
        vm.prank(keeper);
        auction.tallyBids(sid, 0, 3);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.RaiseSettled(sid, p, 300, 300e6, ts);
        auction.finalizeSettlement(sid);

        IMercesAuction.Auction memory a = auction.getAuction(sid);
        assertEq(uint8(a.state), uint8(RaiseState.Settled));
        assertEq(a.unitsSoldUpper, 300);
        assertEq(a.remainderAtMargin, 100);
        SeriesCore memory c = registry.getSeriesCore(sid);
        assertEq(c.unitsSold, 300);
        assertEq(c.clearingPrice, p);
        assertEq(c.settlementTs, ts);

        // process: every winner pays p* × q + 1%; excess escrow back
        processAll(sid);
        assertEq(unitToken(sid).balanceOf(b1), 100);
        assertEq(unitToken(sid).balanceOf(b2), 100);
        assertEq(unitToken(sid).balanceOf(b3), 100);
        assertEq(unitToken(sid).totalSupply(), 300);
        uint256 costEach = 100e6;
        uint256 feeEach = 1e6;
        assertEq(usdc.balanceOf(b1), p1.escrow - costEach - feeEach);
        assertEq(usdc.balanceOf(b2), p2.escrow - costEach - feeEach);
        assertEq(usdc.balanceOf(b3), p3.escrow - costEach - feeEach);
        assertEq(usdc.balanceOf(address(treasury)), 300e6);
        assertEq(usdc.balanceOf(address(feeCollector)), 3e6);
        assertEq(usdc.balanceOf(address(auction)), 0);
        a = auction.getAuction(sid);
        assertEq(a.unitsSold, 300);
        assertEq(a.proceeds, 300e6);
        assertTrue(a.mintAuthorityRevoked);
        assertTrue(auction.mintFinalized(sid));
        assertEq(a.refundedTotal + a.proceedsTransferred + a.feesTotal + a.chargesTotal, a.escrowTotal);
        IMercesTreasury.Ledger memory t = treasury.getTreasury(sid);
        assertTrue(t.finalized);
        assertEq(t.proceeds, 300e6);
        assertEq(mockVault.registrations(sid), 3);
        // processed bids cannot be processed twice
        vm.expectRevert(BidAlreadyProcessed.selector);
        auction.processBid(sid, 0);
    }

    function test_marginalProRataAndExactUnitsSold() public {
        // offered 1000; cap per wallet 100. b1 100 @ 1.5 (above), b2 60 @ 1.0 and b3 60 @ 1.0 at the margin
        // → D = 220 < N = 1000 so p* = 1.0 is the lowest valid price and everyone is filled (R = q_at).
        // To get a real margin use a smaller series.
        vm.prank(issuer);
        uint256 s = registry.createSeries(
            smallParams(150, 1e6, 100e6), defaultSchedule(), keccak256("t3"), 2, bytes32(0), SeriesMode.SealedBid, false
        );
        vm.prank(issuer);
        registry.setContractHash(s, keccak256("c"));
        // wallet cap = 10% of 150 = 15 units
        vm.prank(admin);
        registry.setDefaults(walletCap(10_000)); // allow full-size bids for this test
        vm.prank(issuer);
        s = registry.createSeries(
            smallParams(150, 1e6, 100e6), defaultSchedule(), keccak256("t4"), 2, bytes32(0), SeriesMode.SealedBid, false
        );
        vm.prank(issuer);
        registry.setContractHash(s, keccak256("c"));
        openRaise(s);
        BidPlan memory p1 = plan(b1, 1_500_000, 100, escrowFor(1_500_000, 100));
        BidPlan memory p2 = plan(b2, 1_000_000, 70, escrowFor(1_000_000, 70));
        BidPlan memory p3 = plan(b3, 1_000_000, 50, escrowFor(1_000_000, 50));
        commit(s, p1);
        commit(s, p2);
        commit(s, p3);
        warpToReveal(s);
        reveal(s, p1);
        reveal(s, p2);
        reveal(s, p3);
        warpToSettle(s);
        settle(s, 1_000_000);
        IMercesAuction.Auction memory a = auction.getAuction(s);
        // q_above = 100, q_at = 120, R = min(150 − 100, 120) = 50; upper = 150
        assertEq(a.remainderAtMargin, 50);
        assertEq(a.unitsSoldUpper, 150);
        processAll(s);
        // b2: floor(50 × 70 / 120) = 29; b3: floor(50 × 50 / 120) = 20 → exact units sold 149
        assertEq(unitToken(s).balanceOf(b1), 100);
        assertEq(unitToken(s).balanceOf(b2), 29);
        assertEq(unitToken(s).balanceOf(b3), 20);
        a = auction.getAuction(s);
        assertEq(a.unitsSold, 149);
        assertEq(a.proceeds, 149e6);
        assertEq(registry.getSeriesCore(s).unitsSold, 149);
        assertEq(treasury.getTreasury(s).proceeds, 149e6);
        assertEq(usdc.balanceOf(address(treasury)), 149e6);
        // b2 paid 29 × 1.0 + 1% fee, refund rest
        assertEq(usdc.balanceOf(b2), p2.escrow - 29e6 - 290_000);
        assertEq(usdc.balanceOf(b3), p3.escrow - 20e6 - 200_000);
        assertEq(usdc.balanceOf(address(feeCollector)), 1_000_000 + 290_000 + 200_000); // everyone pays p* = 1.0
        assertEq(a.refundedTotal + a.proceedsTransferred + a.feesTotal + a.chargesTotal, a.escrowTotal);
    }

    function test_oversubscribedClearingPriceIsLowestWinningBid() public {
        vm.prank(admin);
        registry.setDefaults(walletCap(10_000));
        vm.prank(issuer);
        uint256 s = registry.createSeries(
            smallParams(100, 1e6, 50e6), defaultSchedule(), keccak256("t5"), 2, bytes32(0), SeriesMode.SealedBid, false
        );
        vm.prank(issuer);
        registry.setContractHash(s, keccak256("c"));
        openRaise(s);
        BidPlan memory p1 = plan(b1, 3_000_000, 60, escrowFor(3_000_000, 60));
        BidPlan memory p2 = plan(b2, 2_000_000, 60, escrowFor(2_000_000, 60));
        BidPlan memory p3 = plan(b3, 1_000_000, 60, escrowFor(1_000_000, 60));
        commit(s, p1);
        commit(s, p2);
        commit(s, p3);
        warpToReveal(s);
        reveal(s, p1);
        reveal(s, p2);
        reveal(s, p3);
        warpToSettle(s);
        // p* = 1.0 would have q_above = 120 ≥ N → invalid; p* = 2.0: q_above = 60 < 100, q_at = 60, D = 120 ≥ N ok
        vm.startPrank(keeper);
        auction.beginSettlement(s, 1_000_000);
        auction.tallyBids(s, 0, 3);
        vm.expectRevert(InvalidClearingPrice.selector);
        auction.finalizeSettlement(s);
        auction.beginSettlement(s, 3_000_000);
        auction.tallyBids(s, 0, 3);
        vm.expectRevert(InvalidClearingPrice.selector); // D = 60 < N and lower valid bids exist
        auction.finalizeSettlement(s);
        vm.stopPrank();
        settle(s, 2_000_000);
        processAll(s);
        assertEq(unitToken(s).balanceOf(b1), 60);
        assertEq(unitToken(s).balanceOf(b2), 40); // R = 40 → floor(40 × 60 / 60)
        assertEq(unitToken(s).balanceOf(b3), 0);
        // everyone pays 2.0
        assertEq(usdc.balanceOf(b1), p1.escrow - 120e6 - 1_200_000);
        assertEq(usdc.balanceOf(b2), p2.escrow - 80e6 - 800_000);
        assertEq(usdc.balanceOf(b3), p3.escrow); // losing bid refunded in full, no fee
        assertEq(treasury.getTreasury(s).proceeds, 200e6);
    }

    function test_failedRaiseFullRefundsNoFees() public {
        openRaise(sid); // min raise 500 USDC
        BidPlan memory p1 = plan(b1, 1e6, 100, escrowFor(1e6, 100));
        BidPlan memory p2 = plan(b2, 1e6, 100, escrowFor(1e6, 100) + 1e6);
        BidPlan memory unrevealed = plan(b3, 1e6, 100, escrowFor(1e6, 100));
        commit(sid, p1);
        commit(sid, p2);
        commit(sid, unrevealed);
        warpToReveal(sid);
        reveal(sid, p1);
        reveal(sid, p2);
        warpToSettle(sid);
        vm.startPrank(keeper);
        auction.beginSettlement(sid, 1e6);
        auction.tallyBids(sid, 0, 3);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.RaiseFailed(sid, 1e6, 200e6, 500e6);
        auction.finalizeSettlement(sid);
        vm.stopPrank();
        assertEq(uint8(registry.getSeriesCore(sid).raiseState), uint8(RaiseState.Failed));
        processAll(sid);
        assertEq(usdc.balanceOf(b1), p1.escrow);
        assertEq(usdc.balanceOf(b2), p2.escrow);
        assertEq(usdc.balanceOf(b3), unrevealed.escrow); // no non-reveal charge on a failed raise
        assertEq(usdc.balanceOf(address(feeCollector)), 0);
        assertEq(usdc.balanceOf(address(treasury)), 0);
        assertEq(usdc.balanceOf(address(auction)), 0);
        assertEq(unitToken(sid).totalSupply(), 0);
        assertFalse(auction.mintFinalized(sid));
        assertTrue(registry.isTransferLocked(sid, type(uint64).max));
    }

    function test_noValidBidsFails() public {
        openRaise(sid);
        BidPlan memory bad = plan(b1, 1, 10, 1000); // below reserve
        commit(sid, bad);
        warpToReveal(sid);
        reveal(sid, bad);
        warpToSettle(sid);
        settle(sid, 123); // proposal irrelevant
        assertEq(uint8(auction.getAuction(sid).state), uint8(RaiseState.Failed));
        processAll(sid);
        assertEq(usdc.balanceOf(b1), 1000);
    }

    function test_zeroBidsFails() public {
        openRaise(sid);
        warpToSettle(sid);
        vm.prank(keeper);
        auction.beginSettlement(sid, 1e6);
        vm.prank(keeper);
        auction.finalizeSettlement(sid);
        assertEq(uint8(auction.getAuction(sid).state), uint8(RaiseState.Failed));
    }

    function test_unrevealedBidChargedOnePercent() public {
        openRaise(sid);
        BidPlan memory p1 = plan(b1, 1e6, 100, escrowFor(1e6, 100));
        BidPlan memory p2 = plan(b2, 1e6, 100, escrowFor(1e6, 100));
        BidPlan memory p3 = plan(b3, 1e6, 100, escrowFor(1e6, 100));
        BidPlan memory p4 = plan(makeAddr("b4"), 1e6, 100, escrowFor(1e6, 100));
        BidPlan memory p5 = plan(makeAddr("b5"), 1e6, 100, escrowFor(1e6, 100));
        allow(p4.bidder);
        allow(p5.bidder);
        BidPlan memory silent = plan(makeAddr("silent"), 1e6, 100, 50e6);
        allow(silent.bidder);
        commit(sid, p1);
        commit(sid, p2);
        commit(sid, p3);
        commit(sid, p4);
        commit(sid, p5);
        commit(sid, silent);
        warpToReveal(sid);
        reveal(sid, p1);
        reveal(sid, p2);
        reveal(sid, p3);
        reveal(sid, p4);
        reveal(sid, p5);
        warpToSettle(sid);
        settle(sid, 1e6); // 500 units × 1.0 = 500 USDC = min raise
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IMercesAuction.NonRevealCharged(sid, silent.bidder, 500_000);
        auction.processBid(sid, 5);
        assertEq(usdc.balanceOf(silent.bidder), 50e6 - 500_000);
        assertEq(usdc.balanceOf(address(feeCollector)), 500_000);
        processAll_except(sid, 5);
        IMercesAuction.Auction memory a = auction.getAuction(sid);
        assertEq(a.chargesTotal, 500_000);
        assertEq(a.refundedTotal + a.proceedsTransferred + a.feesTotal + a.chargesTotal, a.escrowTotal);
        assertEq(usdc.balanceOf(address(auction)), 0);
    }

    function test_deallowlistedWinnerRefundedUnitsStayUnsold() public {
        openRaise(sid);
        BidPlan memory p1 = plan(b1, 1e6, 100, escrowFor(1e6, 100));
        BidPlan memory p2 = plan(b2, 1e6, 100, escrowFor(1e6, 100));
        BidPlan memory p3 = plan(b3, 1e6, 100, escrowFor(1e6, 100));
        BidPlan memory p4 = plan(makeAddr("b4"), 1e6, 100, escrowFor(1e6, 100));
        BidPlan memory p5 = plan(makeAddr("b5"), 1e6, 100, escrowFor(1e6, 100));
        allow(p4.bidder);
        allow(p5.bidder);
        commit(sid, p1);
        commit(sid, p2);
        commit(sid, p3);
        commit(sid, p4);
        commit(sid, p5);
        warpToReveal(sid);
        reveal(sid, p1);
        reveal(sid, p2);
        reveal(sid, p3);
        reveal(sid, p4);
        reveal(sid, p5);
        warpToSettle(sid);
        settle(sid, 1e6);
        disallow(b2);
        processAll(sid);
        assertEq(unitToken(sid).balanceOf(b2), 0);
        assertEq(usdc.balanceOf(b2), p2.escrow);
        assertEq(unitToken(sid).totalSupply(), 400);
        assertEq(auction.getAuction(sid).unitsSold, 400);
        assertEq(registry.getSeriesCore(sid).unitsSold, 400);
        assertEq(treasury.getTreasury(sid).proceeds, 400e6);
    }

    function test_tallyPagingAndIncompleteTally() public {
        openRaise(sid);
        BidPlan memory p1 = plan(b1, 1e6, 100, escrowFor(1e6, 100));
        BidPlan memory p2 = plan(b2, 1e6, 100, escrowFor(1e6, 100));
        commit(sid, p1);
        commit(sid, p2);
        warpToReveal(sid);
        reveal(sid, p1);
        reveal(sid, p2);
        warpToSettle(sid);
        vm.startPrank(keeper);
        vm.expectRevert(InvalidSettlementState.selector);
        auction.tallyBids(sid, 0, 2);
        auction.beginSettlement(sid, 1e6);
        vm.expectRevert(TallyRangeInvalid.selector);
        auction.tallyBids(sid, 0, 3);
        vm.expectRevert(TallyRangeInvalid.selector);
        auction.tallyBids(sid, 1, 1);
        auction.tallyBids(sid, 0, 1);
        vm.expectRevert(TallyIncomplete.selector);
        auction.finalizeSettlement(sid);
        auction.tallyBids(sid, 0, 2); // overlapping page is harmless
        assertEq(auction.getAuction(sid).talliedCount, 2);
        assertEq(auction.getAuction(sid).qAt, 200);
        // re-proposal resets the round
        auction.beginSettlement(sid, 1e6);
        assertEq(auction.getAuction(sid).talliedCount, 0);
        assertEq(auction.getAuction(sid).tallyRound, 2);
        auction.tallyBids(sid, 0, 2);
        auction.finalizeSettlement(sid); // 200 USDC < 500 min raise → failed
        assertEq(uint8(auction.getAuction(sid).state), uint8(RaiseState.Failed));
        vm.expectRevert(InvalidSettlementState.selector);
        auction.beginSettlement(sid, 1e6);
        vm.stopPrank();
    }

    function test_settlementTimingGuards() public {
        openRaise(sid);
        vm.expectRevert(RevealNotOver.selector);
        auction.beginSettlement(sid, 1e6);
        vm.expectRevert(NotSettledOrFailed.selector);
        auction.processBid(sid, 0);
        warpToSettle(sid);
        vm.prank(keeper);
        auction.beginSettlement(sid, 1e6);
        vm.prank(b1);
        vm.expectRevert(RaiseNotOpen.selector); // committing after settlement began
        auction.commitBid(sid, bytes32(0), 1);
    }

    function test_tallyPageLimit() public {
        openRaise(sid);
        // 201 bids would be needed to exceed the page; check the explicit guard on the range instead
        BidPlan memory p1 = plan(b1, 1e6, 100, escrowFor(1e6, 100));
        commit(sid, p1);
        warpToSettle(sid);
        vm.prank(keeper);
        auction.beginSettlement(sid, 1e6);
        vm.expectRevert(TallyRangeInvalid.selector);
        auction.tallyBids(sid, 0, 201);
    }

    function test_maxBidsPerAuction() public {
        vm.prank(admin);
        registry.setDefaults(walletCap(10_000));
        vm.prank(issuer);
        uint256 s = registry.createSeries(
            smallParams(10_000, 1e6, 0), defaultSchedule(), keccak256("big"), 2, bytes32(0), SeriesMode.SealedBid, false
        );
        vm.prank(issuer);
        registry.setContractHash(s, keccak256("c"));
        openRaise(s);
        for (uint256 i = 0; i < 4096; i++) {
            address bidder = address(uint160(0x100000 + i));
            allow(bidder);
            fund(bidder, 1_010_000);
            vm.startPrank(bidder);
            usdc.approve(address(auction), 1_010_000);
            auction.commitBid(s, keccak256(abi.encode(i)), 1_010_000);
            vm.stopPrank();
        }
        address extra = address(uint160(0x200000));
        allow(extra);
        fund(extra, 1_010_000);
        vm.startPrank(extra);
        usdc.approve(address(auction), 1_010_000);
        vm.expectRevert(TooManyBids.selector);
        auction.commitBid(s, keccak256("x"), 1_010_000);
        vm.stopPrank();
        assertEq(auction.getAuction(s).bidCount, 4096);
        // a page of 200 over a 4096-bid array tallies within gas; a 201 page is rejected
        warpToSettle(s);
        vm.startPrank(keeper);
        auction.beginSettlement(s, 1e6);
        vm.expectRevert(TallyPageTooLarge.selector);
        auction.tallyBids(s, 0, 201);
        for (uint256 from = 0; from < 4096; from += 200) {
            uint256 to = from + 200 > 4096 ? 4096 : from + 200;
            auction.tallyBids(s, from, to);
        }
        auction.finalizeSettlement(s); // nothing revealed → failed
        vm.stopPrank();
        assertEq(uint8(auction.getAuction(s).state), uint8(RaiseState.Failed));
    }

    // ------------------------------------------------------------ helpers

    function processAll_except(uint256 seriesId, uint256 skip) internal {
        uint256 n = auction.getAuction(seriesId).bidCount;
        for (uint256 i = 0; i < n; i++) {
            if (i == skip) continue;
            vm.prank(keeper);
            auction.processBid(seriesId, i);
        }
    }

    function smallParams(uint64 units, uint64 reserve, uint64 minRaise) internal view returns (SeriesParams memory) {
        SeriesParams memory p = defaultSeriesParams();
        p.unitsOffered = units;
        p.reservePrice = reserve;
        p.minRaise = minRaise;
        return p;
    }

    function walletCap(uint16 bps) internal pure returns (Parameters memory) {
        Parameters memory d = defaultParameters();
        d.walletCapBps = bps;
        return d;
    }
}
