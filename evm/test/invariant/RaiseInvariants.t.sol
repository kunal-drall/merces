// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {RaiseHandler} from "./RaiseHandler.sol";
import {IMercesAuction} from "../../src/interfaces/IMercesAuction.sol";
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
import {
    RaiseState,
    ReleaseTranche,
    SeriesCore,
    SeriesParams,
    SeriesTerms,
    TierFlags
} from "../../src/types/MercesTypes.sol";

/// @notice Raise-path invariants (brief F2, SPEC v1.1 §5): checked after every handler call.
/// - refunds + proceeds + fees + what the auction still holds == total escrow (at every step, exactly);
/// - the auction's balance equals its ledger; proceeds reach the treasury in full (no fee from the issuer);
/// - units: minted == supply, held within the wallet cap and the bid, never more than offered, never moved
///   wallet to wallet; charter fields frozen from the moment the raise opened;
/// - liveness: no honest settlement step ever reverts, whatever the allowlist does, and `afterInvariant` drives
///   every run to a final, fully refunded and delivered state.
contract RaiseInvariantTest is FullFixture {
    RaiseHandler internal handler;
    uint256 internal sid;
    bytes32 internal charterAtOpen;

    function setUp() public override {
        super.setUp();
        SeriesParams memory p = defaultSeriesParams();
        p.unitsOffered = 60;
        p.reservePrice = 10e6;
        p.minRaise = 150e6;
        p.walletCapBps = 3000; // 18 units
        sid = createSeriesWith(
            p, defaultSchedule(), keccak256("raise inv"), TierFlags.TIER3_ATTESTOR, bytes32(0), noTier1()
        );
        openRaise(sid);
        charterAtOpen = _charter();
        handler = new RaiseHandler(registry, auction, treasury, usdc, admin, allowlistManager, sid, 60, 18, 10e6);
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            allow(handler.actors(i));
        }
        targetContract(address(handler));
    }

    function _charter() internal view returns (bytes32) {
        SeriesCore memory c = registry.getSeriesCore(sid);
        SeriesTerms memory t = registry.getSeriesTerms(sid);
        ReleaseTranche[] memory s = registry.getReleaseSchedule(sid);
        return
            keccak256(
                abi.encode(t, s, c.issuer, c.stablecoin, c.tierFlags, c.fxPairId, c.contractHash, c.termsCommitment)
            );
    }

    function _bidderBalances() internal view returns (uint256 stable, uint256 units) {
        IERC3643Token token = IERC3643Token(auction.getAuction(sid).unitToken);
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            stable += usdc.balanceOf(a);
            units += token.balanceOf(a);
        }
    }

    function invariant_escrowConservation() public view {
        (uint256 refunds,) = _bidderBalances();
        uint256 held = usdc.balanceOf(address(auction));
        uint256 proceeds = usdc.balanceOf(address(treasury));
        uint256 fees = usdc.balanceOf(address(feeCollector));
        assertEq(handler.escrowIn(), held + refunds + proceeds + fees, "refunds + proceeds + fees != escrow");
    }

    function invariant_auctionLedgerMatchesBalances() public view {
        IMercesAuction.Auction memory a = auction.getAuction(sid);
        assertEq(usdc.balanceOf(address(auction)), a.escrowTotal);
        assertEq(usdc.balanceOf(address(treasury)), a.proceedsTransferred);
        assertEq(usdc.balanceOf(address(feeCollector)), uint256(a.feesTotal) + a.chargesTotal);
        if (a.mintFinalized && a.state == RaiseState.Settled) {
            assertEq(usdc.balanceOf(address(treasury)), uint256(a.clearingPrice) * a.unitsSold, "proceeds in full");
        }
        if (a.state == RaiseState.Failed) {
            assertEq(usdc.balanceOf(address(treasury)), 0);
            assertEq(usdc.balanceOf(address(feeCollector)), 0, "no fee on a failed raise");
        }
        assertEq(usdc.balanceOf(issuer), 0, "the issuer never pays anything in a raise");
    }

    function invariant_units() public view {
        IMercesAuction.Auction memory a = auction.getAuction(sid);
        IERC3643Token token = IERC3643Token(a.unitToken);
        (, uint256 held) = _bidderBalances();
        assertEq(token.totalSupply(), a.unitsMinted);
        assertEq(held + token.balanceOf(address(auction)), token.totalSupply());
        assertEq(token.balanceOf(address(auction)), a.escrowUnits);
        assertLe(a.unitsMinted, handler.n());
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address w = handler.actors(i);
            (,,, uint64 price, uint64 qty,) = handler.book(w);
            uint256 bal = token.balanceOf(w);
            assertLe(bal, handler.capUnits(), "wallet cap");
            assertLe(bal, qty, "more than bid for");
            if (bal > 0) assertGe(price, a.clearingPrice);
        }
    }

    function invariant_charterFrozen() public view {
        assertEq(_charter(), charterAtOpen, "charter fields changed after the raise opened");
    }

    function invariant_noForbiddenPathAndLiveness() public view {
        assertFalse(handler.forbiddenSucceeded(), handler.lastFailure());
        assertFalse(handler.livenessBroken(), handler.lastFailure());
    }

    /// @dev Settlement liveness: from any reachable state, honest keepers finish the raise.
    function afterInvariant() external {
        IMercesAuction.Auction memory a = auction.getAuction(sid);
        if (vm.getBlockTimestamp() < a.revealEnd) vm.warp(a.revealEnd);
        vm.startPrank(keeper);
        a = auction.getAuction(sid);
        if (a.state == RaiseState.Settling && !a.roundRejected) {
            if (a.bidCount > 0) auction.tallyBids(sid, 0, a.bidCount);
            auction.finalizeSettlement(sid);
        }
        a = auction.getAuction(sid);
        if (a.state == RaiseState.Open || a.state == RaiseState.Settling) {
            uint64 p = handler.correctPrice();
            uint64 qAbove;
            uint64 qAt;
            for (uint256 i = 0; i < handler.actorCount(); i++) {
                (,, bool valid, uint64 price, uint64 qty,) = handler.book(handler.actors(i));
                if (!valid) continue;
                if (price > p) qAbove += qty;
                else if (price == p) qAt += qty;
            }
            auction.beginSettlement(sid, p == 0 ? 10e6 : p, qAbove, qAt);
            if (a.bidCount > 0) auction.tallyBids(sid, 0, a.bidCount);
            auction.finalizeSettlement(sid);
        }
        a = auction.getAuction(sid);
        assertTrue(a.state == RaiseState.Settled || a.state == RaiseState.Failed, "settlement did not complete");
        for (uint256 i = 0; i < a.bidCount; i++) {
            IMercesAuction.Bid memory b = auction.getBidAt(sid, i);
            if (!b.processed) auction.processBid(sid, b.bidder);
        }
        for (uint256 i = 0; i < a.bidCount; i++) {
            IMercesAuction.Bid memory b = auction.getBidAt(sid, i);
            if (!b.delivered) auction.deliverBid(sid, b.bidder);
        }
        vm.stopPrank();
        a = auction.getAuction(sid);
        assertTrue(a.mintFinalized || a.bidCount == 0);
        assertEq(usdc.balanceOf(address(auction)), 0, "escrow left behind");
        assertEq(a.escrowUnits, 0);
        invariant_escrowConservation();
        invariant_units();
    }
}
