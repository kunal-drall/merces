// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {
    IMercesAuction, REJECT_CLAIM_MISMATCH, REJECT_INVALID_CLEARING_PRICE
} from "../../src/interfaces/IMercesAuction.sol";
import {IMercesTreasury} from "../../src/interfaces/IMercesTreasury.sol";
import {IMercesRegistry} from "../../src/interfaces/IMercesRegistry.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {RaiseState, SeriesCore, SeriesMode, SeriesParams} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

contract AuctionTest is FullFixture {
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
        assertTrue(unitToken(sid).isAgent(address(vault)));
        assertTrue(unitToken(sid).isAgent(address(window)));
        assertEq(tokenFactory.tokenOf(sid), a.unitToken);
    }

    function test_openRaiseGuards() public {
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        auction.openRaise(sid);

        // no contract hash
        vm.prank(issuer);
        uint256 draft = registry.createSeries(
            defaultSeriesParams(), defaultSchedule(), keccak256("t2"), 2, bytes32(0), SeriesMode.SealedBid, false, noTier1()
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
        sid = createSeriesWith(
            smallParams(1000, 1e6, 200e6), defaultSchedule(), keccak256("hp"), 2, bytes32(0), noTier1()
        );
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

        // wrong proposals are rejected, never reverted; a new proposal may follow
        vm.startPrank(keeper);
        auction.beginSettlement(sid, 1_100_000, 100, 100);
        auction.tallyBids(sid, 0, 3);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.SettlementRejected(sid, 1, 1_100_000, REJECT_INVALID_CLEARING_PRICE); // valid bid below p*
        auction.finalizeSettlement(sid);
        assertTrue(auction.getAuction(sid).roundRejected);
        vm.expectRevert(InvalidSettlementState.selector); // nothing to finalize after a rejection
        auction.finalizeSettlement(sid);
        auction.beginSettlement(sid, 900_000, 300, 0);
        auction.tallyBids(sid, 0, 3);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.SettlementRejected(sid, 2, 900_000, REJECT_INVALID_CLEARING_PRICE); // no bid at p*
        auction.finalizeSettlement(sid);
        auction.beginSettlement(sid, 1_000_000, 200, 99); // wrong claim
        auction.tallyBids(sid, 0, 3);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.SettlementRejected(sid, 3, 1_000_000, REJECT_CLAIM_MISMATCH);
        auction.finalizeSettlement(sid);
        vm.stopPrank();

        uint64 p = 1_000_000;
        uint64 ts = uint64(block.timestamp);
        vm.prank(keeper);
        auction.beginSettlement(sid, p, 200, 100);
        vm.prank(keeper);
        auction.tallyBids(sid, 0, 3);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.RaiseSettled(sid, p, 300, 300e6, ts);
        auction.finalizeSettlement(sid);

        IMercesAuction.Auction memory a = auction.getAuction(sid);
        assertEq(uint8(a.state), uint8(RaiseState.Settled));
        assertEq(a.unitsSold, 300);
        assertEq(a.proceeds, 300e6);
        assertEq(a.rClaim, 100);
        assertEq(a.tallyRound, 4);
        SeriesCore memory c = registry.getSeriesCore(sid);
        assertEq(c.unitsSold, 300);
        assertEq(c.clearingPrice, p);
        assertEq(c.settlementTs, ts);
        assertFalse(c.mintFinalized);
        assertEq(treasury.getTreasury(sid).proceeds, 300e6);
        assertTrue(treasury.getTreasury(sid).proceedsSet);

        // process: every winner pays p* × q + 1%; units are minted to the auction escrow; refunds recorded
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IMercesAuction.UnitsAllocated(sid, b1, 100, 100e6, 1e6, p1.escrow - 101e6);
        auction.processBid(sid, 0);
        assertEq(unitToken(sid).balanceOf(address(auction)), 100);
        assertEq(unitToken(sid).balanceOf(b1), 0);
        assertEq(auction.pendingUnitsOf(sid, b1), 100);
        assertEq(vault.accrualUnits(sid, b1), 100); // escrowed units count toward accrual
        vm.prank(keeper);
        auction.processBid(sid, 1);
        assertFalse(auction.mintFinalized(sid));
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.RaiseMintFinalized(sid, 300, 300e6);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.MintAuthorityRevoked(sid);
        auction.processBid(sid, 2);
        assertTrue(auction.mintFinalized(sid));
        assertTrue(registry.getSeriesCore(sid).mintFinalized);
        assertEq(vault.unitsOutstanding(sid), 300);
        assertEq(unitToken(sid).totalSupply(), 300);
        assertEq(usdc.balanceOf(address(treasury)), 300e6);
        assertEq(usdc.balanceOf(address(feeCollector)), 3e6);
        assertEq(treasury.getTreasury(sid).deposited, 300e6);
        a = auction.getAuction(sid);
        assertEq(a.unitsMinted, 300);
        assertEq(a.pendingUnitsTotal, 300);
        assertEq(usdc.balanceOf(address(auction)), a.pendingRefundTotal);
        _assertConserved(sid);

        // delivery pushes units and refunds to the bidders' own addresses
        vm.prank(stranger); // anyone
        vm.expectEmit(true, true, false, true);
        emit IMercesAuction.BidDelivered(sid, b1, 100, p1.escrow - 101e6);
        auction.deliverBid(sid, 0);
        assertEq(unitToken(sid).balanceOf(b1), 100);
        assertEq(usdc.balanceOf(b1), p1.escrow - 101e6);
        assertEq(auction.pendingUnitsOf(sid, b1), 0);
        vm.expectRevert(BidAlreadyDelivered.selector);
        auction.deliverBid(sid, 0);
        deliverAll(sid);
        assertEq(unitToken(sid).balanceOf(b2), 100);
        assertEq(unitToken(sid).balanceOf(b3), 100);
        assertEq(usdc.balanceOf(b2), p2.escrow - 101e6);
        assertEq(usdc.balanceOf(b3), p3.escrow - 101e6);
        assertEq(usdc.balanceOf(address(auction)), 0);
        assertEq(unitToken(sid).balanceOf(address(auction)), 0);
        _assertConserved(sid);
        vm.expectRevert(BidAlreadyProcessed.selector);
        auction.processBid(sid, 0);
    }

    function test_marginalProRataExactInOnePass() public {
        // offered 150, wallet cap 100%; b1 100 @ 1.5 (above), b2 70 and b3 50 at 1.0 (margin)
        vm.prank(admin);
        registry.setDefaults(walletCap(10_000));
        uint256 s = createSeriesWith(
            smallParams(150, 1e6, 100e6), defaultSchedule(), keccak256("t4"), 2, bytes32(0), noTier1()
        );
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
        // q_above = 100, q_at = 120, R = min(150 − 100, 120) = 50; b2 floor(50×70/120) = 29, b3 floor(50×50/120) = 20
        vm.prank(keeper);
        auction.beginSettlement(s, 1_000_000, 100, 120);
        vm.prank(keeper);
        auction.tallyBids(s, 0, 3);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.RaiseSettled(s, 1_000_000, 149, 149e6, uint64(block.timestamp));
        auction.finalizeSettlement(s);
        IMercesAuction.Auction memory a = auction.getAuction(s);
        assertEq(a.rClaim, 50);
        assertEq(a.allocSum, 49);
        assertEq(a.unitsSold, 149);
        assertEq(registry.getSeriesCore(s).unitsSold, 149);
        assertEq(treasury.getTreasury(s).proceeds, 149e6);
        processAll(s);
        deliverAll(s);
        assertEq(unitToken(s).balanceOf(b1), 100);
        assertEq(unitToken(s).balanceOf(b2), 29);
        assertEq(unitToken(s).balanceOf(b3), 20);
        assertEq(unitToken(s).totalSupply(), 149);
        assertEq(vault.unitsOutstanding(s), 149);
        assertEq(usdc.balanceOf(address(treasury)), 149e6);
        assertEq(usdc.balanceOf(b2), p2.escrow - 29e6 - 290_000);
        assertEq(usdc.balanceOf(b3), p3.escrow - 20e6 - 200_000);
        assertEq(usdc.balanceOf(address(feeCollector)), 1_000_000 + 290_000 + 200_000); // everyone pays p* = 1.0
        _assertConserved(s);
    }

    function test_oversubscribedClearingPriceIsLowestWinningBid() public {
        vm.prank(admin);
        registry.setDefaults(walletCap(10_000));
        uint256 s = createSeriesWith(
            smallParams(100, 1e6, 50e6), defaultSchedule(), keccak256("t5"), 2, bytes32(0), noTier1()
        );
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
        // p* = 1.0 would have q_above = 120 ≥ N → rejected; p* = 3.0: D = 60 < N and lower valid bids exist → rejected
        vm.startPrank(keeper);
        auction.beginSettlement(s, 1_000_000, 120, 60);
        auction.tallyBids(s, 0, 3);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.SettlementRejected(s, 1, 1_000_000, REJECT_INVALID_CLEARING_PRICE);
        auction.finalizeSettlement(s);
        auction.beginSettlement(s, 3_000_000, 0, 60);
        auction.tallyBids(s, 0, 3);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.SettlementRejected(s, 2, 3_000_000, REJECT_INVALID_CLEARING_PRICE);
        auction.finalizeSettlement(s);
        vm.stopPrank();
        settle(s, 2_000_000, 60, 60); // q_above = 60 < 100, q_at = 60, D = 120 ≥ N
        processAll(s);
        deliverAll(s);
        assertEq(unitToken(s).balanceOf(b1), 60);
        assertEq(unitToken(s).balanceOf(b2), 40); // R = 40 → floor(40 × 60 / 60)
        assertEq(unitToken(s).balanceOf(b3), 0);
        // everyone pays 2.0
        assertEq(usdc.balanceOf(b1), p1.escrow - 120e6 - 1_200_000);
        assertEq(usdc.balanceOf(b2), p2.escrow - 80e6 - 800_000);
        assertEq(usdc.balanceOf(b3), p3.escrow); // losing bid refunded in full, no fee
        assertEq(treasury.getTreasury(s).proceeds, 200e6);
        assertEq(auction.getAuction(s).unitsSold, 100);
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
        auction.beginSettlement(sid, 1e6, 0, 200);
        auction.tallyBids(sid, 0, 3);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.RaiseFailed(sid, 1e6, 200e6, 500e6);
        auction.finalizeSettlement(sid);
        vm.stopPrank();
        assertEq(uint8(registry.getSeriesCore(sid).raiseState), uint8(RaiseState.Failed));
        processAll(sid);
        deliverAll(sid);
        assertEq(usdc.balanceOf(b1), p1.escrow);
        assertEq(usdc.balanceOf(b2), p2.escrow);
        assertEq(usdc.balanceOf(b3), unrevealed.escrow); // no non-reveal charge on a failed raise
        assertEq(usdc.balanceOf(address(feeCollector)), 0);
        assertEq(usdc.balanceOf(address(treasury)), 0);
        assertEq(usdc.balanceOf(address(auction)), 0);
        assertEq(unitToken(sid).totalSupply(), 0);
        assertFalse(auction.mintFinalized(sid));
        assertFalse(treasury.getTreasury(sid).proceedsSet);
        assertTrue(registry.isTransferLocked(sid, type(uint64).max));
        vm.prank(keeper);
        vm.expectRevert(InvalidSettlementState.selector);
        auction.beginSettlement(sid, 1e6, 0, 200);
    }

    function test_noValidBidsFailsWithZeroPrice() public {
        openRaise(sid);
        BidPlan memory bad = plan(b1, 1, 10, 1000); // below reserve
        commit(sid, bad);
        warpToReveal(sid);
        reveal(sid, bad);
        warpToSettle(sid);
        vm.startPrank(keeper);
        auction.beginSettlement(sid, 123, 7, 7); // proposal irrelevant
        auction.tallyBids(sid, 0, 1);
        vm.expectEmit(true, false, false, true);
        emit IMercesAuction.RaiseFailed(sid, 0, 0, 500e6);
        auction.finalizeSettlement(sid);
        vm.stopPrank();
        assertEq(uint8(auction.getAuction(sid).state), uint8(RaiseState.Failed));
        assertEq(auction.getAuction(sid).clearingPrice, 0);
        processAll(sid);
        deliverAll(sid);
        assertEq(usdc.balanceOf(b1), 1000);
    }

    function test_zeroBidsFails() public {
        openRaise(sid);
        warpToSettle(sid);
        vm.prank(keeper);
        auction.beginSettlement(sid, 1e6, 0, 0);
        vm.prank(keeper);
        auction.finalizeSettlement(sid);
        assertEq(uint8(auction.getAuction(sid).state), uint8(RaiseState.Failed));
    }

    function test_unrevealedBidChargedOnePercent() public {
        openRaise(sid);
        BidPlan[5] memory ps;
        address[5] memory bidders = [b1, b2, b3, makeAddr("b4"), makeAddr("b5")];
        for (uint256 i = 0; i < 5; i++) {
            allow(bidders[i]);
            ps[i] = plan(bidders[i], 1e6, 100, escrowFor(1e6, 100));
            commit(sid, ps[i]);
        }
        BidPlan memory silent = plan(makeAddr("silent"), 1e6, 100, 50e6);
        allow(silent.bidder);
        commit(sid, silent);
        warpToReveal(sid);
        for (uint256 i = 0; i < 5; i++) {
            reveal(sid, ps[i]);
        }
        warpToSettle(sid);
        settle(sid, 1e6, 0, 500); // 500 units × 1.0 = 500 USDC = min raise
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IMercesAuction.NonRevealCharged(sid, silent.bidder, 500_000);
        auction.processBid(sid, 5);
        assertEq(usdc.balanceOf(address(feeCollector)), 500_000); // charge goes to the collector now
        assertEq(auction.getBid(sid, 5).pendingRefund, 50e6 - 500_000);
        vm.prank(keeper);
        auction.deliverBid(sid, 5);
        assertEq(usdc.balanceOf(silent.bidder), 50e6 - 500_000);
        processAll_except(sid, 5);
        deliverAll(sid);
        IMercesAuction.Auction memory a = auction.getAuction(sid);
        assertEq(a.chargesTotal, 500_000);
        assertTrue(a.mintFinalized);
        _assertConserved(sid);
        assertEq(usdc.balanceOf(address(auction)), 0);
    }

    function test_deallowlistedWinnerStillReceives() public {
        // validity is fixed at reveal (brief C10): a wallet removed from the allowlist before processing keeps its
        // units; processing never depends on the recipient and delivery works because identities persist.
        openRaise(sid);
        address[5] memory bidders = [b1, b2, b3, makeAddr("b4"), makeAddr("b5")];
        BidPlan[5] memory ps;
        for (uint256 i = 0; i < 5; i++) {
            allow(bidders[i]);
            ps[i] = plan(bidders[i], 1e6, 100, escrowFor(1e6, 100));
            commit(sid, ps[i]);
        }
        warpToReveal(sid);
        for (uint256 i = 0; i < 5; i++) {
            reveal(sid, ps[i]);
        }
        warpToSettle(sid);
        settle(sid, 1e6, 0, 500);
        disallow(b2);
        processAll(sid);
        assertTrue(auction.mintFinalized(sid));
        assertEq(auction.getAuction(sid).unitsSold, 500);
        assertEq(vault.getHolder(sid, b2).registered, true);
        deliverAll(sid);
        assertEq(unitToken(sid).balanceOf(b2), 100);
        assertEq(usdc.balanceOf(b2), 0);
        assertEq(unitToken(sid).totalSupply(), 500);
        assertEq(vault.unitsOutstanding(sid), 500);
    }

    function test_tallyPagingTallyInProgressAndIncompleteTally() public {
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
        auction.beginSettlement(sid, 1e6, 0, 200);
        vm.expectRevert(TallyRangeInvalid.selector);
        auction.tallyBids(sid, 0, 3);
        vm.expectRevert(TallyRangeInvalid.selector);
        auction.tallyBids(sid, 1, 1);
        auction.tallyBids(sid, 0, 1);
        vm.expectRevert(TallyIncomplete.selector);
        auction.finalizeSettlement(sid);
        // nobody can reset an in-progress round (SPEC §5.2 liveness)
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(TallyInProgress.selector);
        auction.beginSettlement(sid, 1e6, 0, 200);
        vm.startPrank(keeper);
        auction.tallyBids(sid, 0, 2); // overlapping page is harmless
        assertEq(auction.getAuction(sid).talliedCount, 2);
        assertEq(auction.getAuction(sid).qAt, 200);
        // a completed round may be finalized by anyone; here 200 USDC < 500 min raise → failed
        auction.finalizeSettlement(sid);
        assertEq(uint8(auction.getAuction(sid).state), uint8(RaiseState.Failed));
        vm.expectRevert(InvalidSettlementState.selector);
        auction.beginSettlement(sid, 1e6, 0, 200);
        vm.stopPrank();
    }

    function test_settlementTimingGuards() public {
        openRaise(sid);
        vm.expectRevert(RevealNotOver.selector);
        auction.beginSettlement(sid, 1e6, 0, 0);
        vm.expectRevert(NotSettledOrFailed.selector);
        auction.processBid(sid, 0);
        vm.expectRevert(BidNotFound.selector);
        auction.deliverBid(sid, 0);
        warpToSettle(sid);
        vm.prank(keeper);
        auction.beginSettlement(sid, 1e6, 0, 0);
        vm.prank(b1);
        vm.expectRevert(RaiseNotOpen.selector); // committing after settlement began
        auction.commitBid(sid, bytes32(0), 1);
    }

    function test_deliverRequiresProcessed() public {
        openRaise(sid);
        BidPlan memory p1 = plan(b1, 1e6, 100, escrowFor(1e6, 100));
        commit(sid, p1);
        warpToSettle(sid);
        vm.startPrank(keeper);
        auction.beginSettlement(sid, 1e6, 0, 0);
        auction.finalizeSettlement(sid); // unrevealed only → no valid bids → failed
        vm.expectRevert(BidNotProcessed.selector);
        auction.deliverBid(sid, 0);
        auction.processBid(sid, 0);
        auction.deliverBid(sid, 0);
        vm.stopPrank();
        assertEq(usdc.balanceOf(b1), p1.escrow);
    }

    function test_maxBidsPerAuction() public {
        vm.prank(admin);
        registry.setDefaults(walletCap(10_000));
        uint256 s = createSeriesWith(
            smallParams(10_000, 1e6, 0), defaultSchedule(), keccak256("big"), 2, bytes32(0), noTier1()
        );
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
        warpToSettle(s);
        vm.startPrank(keeper);
        auction.beginSettlement(s, 1e6, 0, 0);
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

    /// @dev Escrow conservation: everything that came in is recorded as a refund (pending or delivered), proceeds,
    /// fee or non-reveal charge.
    function _assertConserved(uint256 s) internal view {
        IMercesAuction.Auction memory a = auction.getAuction(s);
        assertEq(
            uint256(a.pendingRefundTotal) + a.refundsDelivered + a.proceedsTransferred + a.feesTotal + a.chargesTotal,
            a.escrowTotal
        );
        assertEq(usdc.balanceOf(address(auction)), a.pendingRefundTotal);
        assertEq(unitToken(s).balanceOf(address(auction)), a.pendingUnitsTotal);
    }

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
}
