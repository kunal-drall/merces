// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {IMercesAuction, REJECT_CLAIM_MISMATCH} from "../../src/interfaces/IMercesAuction.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {RaiseState, SeriesParams, TierFlags} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

/// @notice Property tests of the sealed-bid auction (SPEC v1.1 §5.2, brief F2): random bid books (ties, invalid
/// and unrevealed bids, over- and under-collateralised escrow, failed raises).
/// - exactly one clearing price is accepted, and it is the one the model predicts (uniqueness, ARCHITECTURE §5.1);
/// - a wrong claim is rejected without blocking settlement (liveness);
/// - refunds + proceeds + fees == total escrow, to the base unit; nothing stays in the auction;
/// - proceeds = p* × units sold reach the treasury in full (no fee from the issuer);
/// - no wallet receives more than its bid quantity or the wallet cap; units sold ≤ units offered.
contract AuctionFuzzTest is FullFixture {
    uint64 internal constant RESERVE = 10e6;
    uint256 internal constant MAX_BIDS = 12;

    struct B {
        address who;
        uint64 price;
        uint64 qty;
        uint64 escrow;
        bool reveal;
        bool valid;
    }

    struct Book {
        uint256 sid;
        uint64 n;
        uint64 capUnits;
        uint64 minRaise;
        B[] bids;
        uint64 minValid;
        uint256 validCount;
        uint256 escrowTotal;
    }

    function _rand(uint256 seed, uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i)));
    }

    function _required(uint64 price, uint64 qty) internal pure returns (uint256) {
        uint256 cost = uint256(price) * qty;
        return cost + cost * 100 / 10_000;
    }

    function _book(uint256 seed) internal returns (Book memory k) {
        k.n = uint64(bound(_rand(seed, 0), 5, 200));
        uint256 capBps = bound(_rand(seed, 3), 1000, 5000);
        k.capUnits = uint64(k.n * capBps / 10_000);
        if (k.capUnits == 0) (capBps, k.capUnits) = (10_000, k.n);
        k.minRaise = uint64(uint256(RESERVE) * k.n * bound(_rand(seed, 1), 1, 60) / 100);
        if (k.minRaise == 0) k.minRaise = 1;
        SeriesParams memory p = defaultSeriesParams();
        p.unitsOffered = k.n;
        p.reservePrice = RESERVE;
        p.minRaise = k.minRaise;
        p.walletCapBps = capBps;
        k.sid = createSeriesWith(
            p, defaultSchedule(), keccak256("fuzz terms"), TierFlags.TIER3_ATTESTOR, bytes32(0), noTier1()
        );
        uint256 count = bound(_rand(seed, 2), 1, MAX_BIDS);
        k.bids = new B[](count);
        k.minValid = type(uint64).max;
        for (uint256 i = 0; i < count; i++) {
            uint256 r = _rand(seed, 100 + i);
            B memory b = k.bids[i];
            b.who = makeAddr(string.concat("fuzzBidder", vm.toString(i)));
            b.price = uint64(uint256(RESERVE) * (3 + r % 10) / 4); // 0.75x .. 3x reserve, many ties
            uint256 qMode = (r >> 48) % 10; // mostly within the cap, sometimes zero or above it
            uint64 lo = k.capUnits / 3 + 1;
            b.qty = qMode == 0
                ? 0
                : qMode == 1 ? k.capUnits + 1 + uint64((r >> 8) % 2) : lo + uint64((r >> 8) % (k.capUnits - lo + 1));
            uint256 req = _required(b.price, b.qty);
            uint256 mode = (r >> 16) % 10; // under-collateralised, random, else exact or over-collateralised
            uint256 escrow = mode == 0
                ? req - (req > 0 ? 1 : 0)
                : mode == 1 ? (r >> 24) % (2 * req + 1) : mode < 6 ? req : req + (r >> 24) % (req + 1);
            b.escrow = uint64(escrow == 0 ? 1 : escrow);
            b.reveal = (r >> 40) % 100 < 85;
            b.valid = b.reveal && b.price >= RESERVE && b.qty >= 1 && b.qty <= k.capUnits && b.escrow >= req;
            if (b.valid) {
                k.validCount++;
                if (b.price < k.minValid) k.minValid = b.price;
            }
            k.escrowTotal += b.escrow;
        }
    }

    function _tally(Book memory k, uint64 p) internal pure returns (uint64 qAbove, uint64 qAt) {
        for (uint256 i = 0; i < k.bids.length; i++) {
            if (!k.bids[i].valid) continue;
            if (k.bids[i].price > p) qAbove += k.bids[i].qty;
            else if (k.bids[i].price == p) qAt += k.bids[i].qty;
        }
    }

    function _modelAccepts(Book memory k, uint64 p) internal pure returns (bool) {
        (uint64 qAbove, uint64 qAt) = _tally(k, p);
        bool over = qAt > 0 && qAbove < k.n && qAbove + qAt >= k.n;
        bool under = qAbove + qAt < k.n && k.minValid == p;
        return over || under;
    }

    function _propose(uint256 sid, uint64 p, uint64 qAbove, uint64 qAt)
        internal
        returns (IMercesAuction.Auction memory)
    {
        vm.startPrank(keeper);
        auction.beginSettlement(sid, p, qAbove, qAt);
        tallyAll(sid);
        auction.finalizeSettlement(sid);
        vm.stopPrank();
        return auction.getAuction(sid);
    }

    function testFuzz_raiseClearsUniquelyAndConservesEscrow(uint256 seed) public {
        Book memory k = _book(seed);
        openRaise(k.sid);
        for (uint256 i = 0; i < k.bids.length; i++) {
            B memory b = k.bids[i];
            allow(b.who);
            commit(k.sid, BidPlan({bidder: b.who, price: b.price, quantity: b.qty, escrow: b.escrow, salt: bytes32(i)}));
        }
        assertEq(usdc.balanceOf(address(auction)), k.escrowTotal);
        warpToReveal(k.sid);
        for (uint256 i = 0; i < k.bids.length; i++) {
            if (!k.bids[i].reveal) continue;
            vm.prank(k.bids[i].who);
            auction.revealBid(k.sid, k.bids[i].price, k.bids[i].qty, bytes32(i));
            assertEq(auction.getBid(k.sid, k.bids[i].who).valid, k.bids[i].valid, "validity rule");
        }
        warpToSettle(k.sid);

        uint64 pStar;
        if (k.validCount == 0) {
            IMercesAuction.Auction memory a = _propose(k.sid, RESERVE, 0, 0);
            assertEq(uint8(a.state), uint8(RaiseState.Failed));
            assertEq(a.clearingPrice, 0);
        } else {
            // every candidate price, each tried on its own copy of the state: exactly one is accepted
            uint256 accepted;
            for (uint256 i = 0; i < k.bids.length; i++) {
                B memory c = k.bids[i];
                if (!c.valid || _seenBefore(k, i)) continue;
                (uint64 qa, uint64 qt) = _tally(k, c.price);
                uint256 snap = vm.snapshotState();
                IMercesAuction.Auction memory a = _propose(k.sid, c.price, qa, qt);
                bool ok = a.state != RaiseState.Settling;
                assertEq(ok, _modelAccepts(k, c.price), "on-chain acceptance differs from the model");
                if (ok) {
                    accepted++;
                    pStar = c.price;
                }
                vm.revertToState(snap);
            }
            assertEq(accepted, 1, "clearing price is not unique");
            // a wrong claim is rejected and does not block the honest proposal
            (uint64 qAbove, uint64 qAt) = _tally(k, pStar);
            IMercesAuction.Auction memory w = _propose(k.sid, pStar, qAbove + 1, qAt);
            assertTrue(w.roundRejected);
            assertEq(w.rejectionReason, REJECT_CLAIM_MISMATCH);
            IMercesAuction.Auction memory s = _propose(k.sid, pStar, qAbove, qAt);
            assertTrue(s.state == RaiseState.Settled || s.state == RaiseState.Failed);
        }

        processAll(k.sid);
        deliverAll(k.sid);
        _checkOutcome(k, pStar);
    }

    function _seenBefore(Book memory k, uint256 i) internal pure returns (bool) {
        for (uint256 j = 0; j < i; j++) {
            if (k.bids[j].valid && k.bids[j].price == k.bids[i].price) return true;
        }
        return false;
    }

    function _checkOutcome(Book memory k, uint64 pStar) internal view {
        IMercesAuction.Auction memory a = auction.getAuction(k.sid);
        bool settled = a.state == RaiseState.Settled;
        uint256 refunds;
        uint256 units;
        uint256 expectedFees;
        for (uint256 i = 0; i < k.bids.length; i++) {
            B memory b = k.bids[i];
            IMercesAuction.Bid memory onchain = auction.getBid(k.sid, b.who);
            uint256 held = settled ? unitToken(k.sid).balanceOf(b.who) : 0;
            refunds += usdc.balanceOf(b.who);
            units += held;
            assertTrue(onchain.delivered);
            assertLe(held, b.qty, "more units than bid for");
            assertLe(held, k.capUnits, "wallet cap");
            if (held > 0) assertTrue(b.valid && b.price >= pStar, "a losing or invalid bid received units");
            if (!settled) {
                assertEq(usdc.balanceOf(b.who), b.escrow, "failed raise: full refund");
                continue;
            }
            uint256 cost = uint256(pStar) * held;
            uint256 fee = cost * 100 / 10_000;
            uint256 charge = b.reveal ? 0 : uint256(b.escrow) * 100 / 10_000;
            expectedFees += fee + charge;
            assertEq(usdc.balanceOf(b.who), b.escrow - cost - fee - charge, "uniform price, exact refund");
        }
        uint256 fees = usdc.balanceOf(address(feeCollector));
        uint256 proceeds = usdc.balanceOf(address(treasury));
        assertEq(refunds + proceeds + fees, k.escrowTotal, "refunds + proceeds + fees == escrow");
        assertEq(usdc.balanceOf(address(auction)), 0);
        assertEq(a.escrowTotal, 0);
        assertEq(a.escrowUnits, 0);
        if (settled) {
            assertEq(proceeds, uint256(a.clearingPrice) * a.unitsSold, "proceeds reach the treasury in full");
            assertGe(proceeds, k.minRaise);
            assertEq(fees, expectedFees);
            assertEq(units, a.unitsSold);
            assertEq(unitToken(k.sid).totalSupply(), a.unitsSold);
            assertLe(a.unitsSold, k.n);
            assertEq(a.clearingPrice, pStar);
        } else {
            assertEq(proceeds, 0);
            assertEq(fees, 0, "no fee on a failed raise");
        }
    }

    /// @dev SPEC §1.1 entry rule: prices and quantities at or above 2^64 never reach the auction.
    function testFuzz_commitmentEntryRule(uint256 price, uint256 quantity) public {
        price = bound(price, uint256(type(uint64).max) + 1, type(uint256).max);
        quantity = bound(quantity, 0, type(uint64).max);
        vm.expectRevert(abi.encodeWithSelector(AmountOutOfRange.selector, price));
        auction.bidCommitment(price, quantity, bytes32(0), b1);
        assertEq(
            auction.bidCommitment(quantity, quantity, bytes32(0), b1),
            MercesMessages.orderCommitment(uint64(quantity), uint64(quantity), bytes32(0), b1)
        );
    }
}
