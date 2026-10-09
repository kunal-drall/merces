// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {MercesFixture} from "./MercesFixture.sol";
import {Proofs} from "./Proofs.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {IMercesAuction} from "../../src/interfaces/IMercesAuction.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {SeriesParams, Tier1Terms, TierFlags} from "../../src/types/MercesTypes.sol";

/// @notice Fixture with the standard raise (300 units at P0 = 100 USDC to b1..b3) and report / payment helpers.
abstract contract FullFixture is MercesFixture {
    uint64 internal constant P0 = 100e6; // 100 USDC per unit
    uint64 internal constant UNITS = 300;
    uint32 internal constant Q1_2026 = 8104;

    // ---------------------------------------------------------------- auction helpers

    struct BidPlan {
        address bidder;
        uint64 price;
        uint64 quantity;
        uint64 escrow;
        bytes32 salt;
    }

    function plan(address bidder, uint64 price, uint64 quantity, uint64 escrow) internal pure returns (BidPlan memory) {
        return BidPlan({
            bidder: bidder,
            price: price,
            quantity: quantity,
            escrow: escrow,
            salt: keccak256(abi.encode(bidder, price, quantity))
        });
    }

    /// @dev `p × q` plus the 1% auction fee.
    function escrowFor(uint64 price, uint64 quantity) internal pure returns (uint64) {
        uint256 cost = uint256(price) * quantity;
        return uint64(cost + cost * 100 / 10_000);
    }

    function commit(uint256 seriesId, BidPlan memory b) internal {
        fund(b.bidder, b.escrow);
        vm.startPrank(b.bidder);
        usdc.approve(address(auction), b.escrow);
        auction.commitBid(seriesId, MercesMessages.orderCommitment(b.price, b.quantity, b.salt, b.bidder), b.escrow);
        vm.stopPrank();
    }

    function reveal(uint256 seriesId, BidPlan memory b) internal {
        vm.prank(b.bidder);
        auction.revealBid(seriesId, b.price, b.quantity, b.salt);
    }

    function openRaise(uint256 seriesId) internal {
        vm.prank(issuer);
        auction.openRaise(seriesId);
    }

    function warpToReveal(uint256 seriesId) internal {
        vm.warp(auction.getAuction(seriesId).commitEnd);
    }

    function warpToSettle(uint256 seriesId) internal {
        vm.warp(auction.getAuction(seriesId).revealEnd);
    }

    /// @dev Proposes `(p*, q_above, q_at)`, tallies every page and finalizes, as a keeper.
    function settle(uint256 seriesId, uint64 clearingPrice, uint64 qAbove, uint64 qAt) internal {
        vm.startPrank(keeper);
        auction.beginSettlement(seriesId, clearingPrice, qAbove, qAt);
        tallyAll(seriesId);
        auction.finalizeSettlement(seriesId);
        vm.stopPrank();
    }

    function tallyAll(uint256 seriesId) internal {
        uint256 n = auction.getAuction(seriesId).bidCount;
        for (uint256 from = 0; from < n; from += 200) {
            uint256 to = from + 200 > n ? n : from + 200;
            auction.tallyBids(seriesId, from, to);
        }
    }

    function processAll(uint256 seriesId) internal {
        uint256 n = auction.getAuction(seriesId).bidCount;
        for (uint256 i = 0; i < n; i++) {
            vm.prank(keeper);
            auction.processBid(seriesId, i);
        }
    }

    function deliverAll(uint256 seriesId) internal {
        uint256 n = auction.getAuction(seriesId).bidCount;
        for (uint256 i = 0; i < n; i++) {
            if (auction.getBid(seriesId, i).delivered) continue;
            vm.prank(keeper);
            auction.deliverBid(seriesId, i);
        }
    }

    // ---------------------------------------------------------------- standard raise

    /// @dev 1000 units offered at reserve 100 USDC, min raise 20,000 USDC; b1..b3 each buy 100 units at the reserve
    /// so P0 = 100 USDC, 300 units, proceeds 30,000 USDC, cap 250 USDC/unit.
    function standardSeries(uint8 tierFlags, bytes32 fxPairId) internal returns (uint256 sid) {
        return standardSeries(tierFlags, fxPairId, Proofs.q1().termsCommitment);
    }

    function standardSeries(uint8 tierFlags, bytes32 fxPairId, bytes32 termsCommitment) internal returns (uint256 sid) {
        return standardSeries(tierFlags, fxPairId, termsCommitment, P0, 47_336_400);
    }

    function standardSeries(uint8 tierFlags, bytes32 fxPairId, bytes32 termsCommitment, uint64 reserve, uint64 lockup)
        internal
        returns (uint256 sid)
    {
        SeriesParams memory p = defaultSeriesParams();
        p.unitsOffered = 1000;
        p.reservePrice = reserve;
        p.minRaise = 20_000e6;
        p.lockupSeconds = lockup;
        Tier1Terms memory t1 = tierFlags & TierFlags.TIER1_SPLIT != 0 ? proofTier1Terms() : noTier1();
        sid = createSeriesWith(p, defaultSchedule(), termsCommitment, tierFlags, fxPairId, t1);
    }

    function runStandardRaise(uint8 tierFlags, bytes32 fxPairId) internal returns (uint256 sid) {
        return runStandardRaise(tierFlags, fxPairId, Proofs.q1().termsCommitment);
    }

    function runStandardRaise(uint8 tierFlags, bytes32 fxPairId, bytes32 termsCommitment)
        internal
        returns (uint256 sid)
    {
        return runStandardRaise(tierFlags, fxPairId, termsCommitment, P0, 47_336_400);
    }

    /// @dev Same raise at a different reserve price (P0 = `reserve`) and lockup; the bids follow the reserve.
    function runStandardRaise(uint8 tierFlags, bytes32 fxPairId, bytes32 termsCommitment, uint64 reserve, uint64 lockup)
        internal
        returns (uint256 sid)
    {
        sid = standardSeries(tierFlags, fxPairId, termsCommitment, reserve, lockup);
        allow(b1);
        allow(b2);
        allow(b3);
        openRaise(sid);
        address[3] memory bidders = [b1, b2, b3];
        uint64 escrow = escrowFor(reserve, 100);
        for (uint256 i = 0; i < 3; i++) {
            commit(sid, plan(bidders[i], reserve, 100, escrow));
        }
        warpToReveal(sid);
        for (uint256 i = 0; i < 3; i++) {
            reveal(sid, plan(bidders[i], reserve, 100, escrow));
        }
        warpToSettle(sid);
        settle(sid, reserve, 0, 300);
        processAll(sid);
        deliverAll(sid);
    }

    function runStandardRaise() internal returns (uint256 sid) {
        return runStandardRaise(TierFlags.TIER2_ZKTLS | TierFlags.TIER3_ATTESTOR, bytes32(0));
    }

    // ---------------------------------------------------------------- reports

    function reportInput(uint256 sid, uint32 period, Proofs.Proof memory p, uint8 tier, bool liquidityEvent)
        internal
        view
        returns (IMercesIncome.ReportInput memory r)
    {
        r.seriesId = sid;
        r.period = period;
        r.paymentUsd = p.paymentUsd;
        r.fxAvgWad = p.fxAvgWad;
        r.priorIncomeCommitment = p.priorCommitment;
        r.incomeCommitment = p.incomeCommitment;
        r.tier = tier;
        r.liquidityEvent = liquidityEvent;
        r.proof = IMercesIncome.Groth16Proof({a: p.a, b: p.b, c: p.c});
        bytes32 digest = MercesMessages.reportDigest(
            domain, sid, period, p.priorCommitment, p.incomeCommitment, tier, liquidityEvent
        );
        if (tier == 2) r.attestationSignature = sign(verifierKey, digest);
        else if (tier == 3) r.attestationSignature = sign(attestorKey, digest);
    }

    /// @dev Warps to the end of `period` (if earlier) and submits a tier-2 report.
    function submitReport(uint256 sid, uint32 period, Proofs.Proof memory p) internal {
        if (block.timestamp < Periods.periodEnd(period)) vm.warp(Periods.periodEnd(period));
        vm.prank(issuer);
        income.submitReport(reportInput(sid, period, p, 2, false));
    }

    function payDue(uint256 sid, address payer) internal returns (uint64 total) {
        (uint64 due, uint32 period) = income.openDue(sid);
        total = due + income.lateAccrual(sid, period, due, block.timestamp);
        fund(payer, total);
        vm.startPrank(payer);
        usdc.approve(address(income), total);
        income.pay(sid);
        vm.stopPrank();
    }

    function reportAndPay(uint256 sid, uint32 period, Proofs.Proof memory p) internal {
        submitReport(sid, period, p);
        (uint64 due,) = income.openDue(sid);
        if (due > 0) payDue(sid, issuer);
    }

    function pauseSig(uint256 sid, uint64 nonce, uint64 pauseEnd) internal view returns (bytes memory) {
        return sign(attestorKey, MercesMessages.pauseDigest(domain, sid, nonce, pauseEnd));
    }

    function extinguishSigs(uint256 sid, uint64 nonce) internal view returns (bytes memory a, bytes memory b) {
        bytes32 dg = MercesMessages.extinguishDigest(domain, sid, nonce);
        return (sign(attestorKey, dg), sign(attestor2Key, dg));
    }

    function trueupSig(uint256 sid, uint64 nonce, uint16 year, int64 adjustment, uint64 attestationTs)
        internal
        view
        returns (bytes memory)
    {
        return sign(attestorKey, MercesMessages.trueupDigest(domain, sid, nonce, year, adjustment, attestationTs));
    }
}
