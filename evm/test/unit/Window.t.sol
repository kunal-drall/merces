// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {
    IMercesWindow,
    REJECT_WINDOW_CROSSING_EXISTS,
    REJECT_WINDOW_NO_BRANCH,
    REJECT_WINDOW_PRICE_NOT_REVEALED
} from "../../src/interfaces/IMercesWindow.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {SeriesStatus, TierFlags} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

/// @notice Quarterly transfer window (D9, SPEC v1.1 §7): two-branch clearing, first-come margin, exhaustive
/// processing, armed escrow deposits, buyer allowlist re-check.
contract WindowTest is FullFixture {
    uint8 internal constant FLAGS = TierFlags.TIER2_ZKTLS | TierFlags.TIER3_ATTESTOR;
    uint256 internal sid;
    address internal b4 = makeAddr("b4");
    address internal b5 = makeAddr("b5");
    address internal b6 = makeAddr("b6");
    address internal b7 = makeAddr("b7");
    address internal b8 = makeAddr("b8");

    struct O {
        address owner;
        bool ask;
        uint64 price;
        uint64 quantity;
        uint64 escrow;
    }

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        registry.setFlags(false, true, false); // windows enabled
        sid = runStandardRaise(FLAGS, bytes32(0), Proofs.q1().termsCommitment, P0, 0); // no lockup
        address[5] memory buyers = [b4, b5, b6, b7, b8];
        for (uint256 i = 0; i < 5; i++) {
            allow(buyers[i]);
        }
        reportAndPay(sid, Q1_2026, Proofs.q1()); // paid report for Q1; now = 2026-04-01 (Q2)
    }

    // ---------------------------------------------------------------- helpers

    function _salt(address who) internal pure returns (bytes32) {
        return keccak256(abi.encode("w", who));
    }

    function _escrowBid(uint64 price, uint64 q) internal pure returns (uint64) {
        uint256 cost = uint256(price) * q;
        return uint64(cost + cost * 100 / 10_000);
    }

    function _ask(address who, uint64 price, uint64 q, uint64 units) internal {
        vm.startPrank(who);
        unitToken(sid).approve(address(window), units);
        window.commitAsk(sid, MercesMessages.orderCommitment(price, q, _salt(who), who), units);
        vm.stopPrank();
    }

    function _bid(address who, uint64 price, uint64 q, uint64 escrow) internal {
        fund(who, escrow);
        vm.startPrank(who);
        usdc.approve(address(window), escrow);
        window.commitBid(sid, MercesMessages.orderCommitment(price, q, _salt(who), who), escrow);
        vm.stopPrank();
    }

    function _reveal(address who, uint64 price, uint64 q) internal {
        vm.prank(who);
        window.revealOrder(sid, price, q, _salt(who));
    }

    function _open(uint32 period) internal {
        vm.prank(keeper);
        window.openWindow(sid, period);
    }

    function _settleAt(uint64 p) internal {
        (, uint32 period) = window.activeWindow(sid);
        vm.warp(window.getWindow(sid, period).revealEnd);
        vm.startPrank(keeper);
        window.beginWindowSettlement(sid, p, false);
        window.tallyOrders(sid, 0, window.getWindow(sid, period).orderCount);
        window.finalizeWindow(sid);
        vm.stopPrank();
    }

    function _idx(uint32 period, address who) internal view returns (uint256 i) {
        (bool exists, uint256 index) = window.orderIndexOf(sid, period, who);
        assertTrue(exists);
        return index;
    }

    function _process(uint32 period, address who) internal {
        vm.prank(keeper);
        window.processOrder(sid, period, _idx(period, who));
    }

    // ---------------------------------------------------------------- guards

    function test_openWindowGuards() public {
        vm.prank(admin);
        registry.setFlags(false, false, false);
        vm.expectRevert(WindowsDisabled.selector);
        window.openWindow(sid, Q1_2026);
        vm.prank(admin);
        registry.setFlags(false, true, false);
        uint256 draft = createSeries(keccak256("d"));
        vm.expectRevert(MintNotFinalized.selector);
        window.openWindow(draft, Q1_2026);
        uint256 locked = runStandardRaise(); // 18-month lockup
        vm.expectRevert(LockupActive.selector);
        window.openWindow(locked, Q1_2026);
        vm.expectRevert(abi.encodeWithSelector(WrongWindowPeriod.selector, Q1_2026, Q1_2026 - 1));
        window.openWindow(sid, Q1_2026 - 1);
        vm.expectRevert(ReportNotPaid.selector);
        window.openWindow(sid, Q1_2026 + 1); // not even ended
        _open(Q1_2026);
        vm.expectRevert(WindowAlreadyOpen.selector);
        window.openWindow(sid, Q1_2026);
        (bool active, uint32 period) = window.activeWindow(sid);
        assertTrue(active);
        assertEq(period, Q1_2026);
        assertTrue(window.hasPendingOrders(sid));
        // redemption waits while a window is pending
        vm.prank(issuer);
        vm.expectRevert(WindowOpen.selector);
        vault.redeem(sid);
        // a Late series cannot open a window
        uint256 s2 = runStandardRaise(FLAGS, bytes32(0), Proofs.q1().termsCommitment, P0, 0);
        vm.warp(Periods.periodEnd(Q1_2026 + 1) + 60 days);
        assertEq(uint8(income.deriveStatus(s2)), uint8(SeriesStatus.Late));
        vm.expectRevert(WindowNotEligibleStatus.selector);
        window.openWindow(s2, Q1_2026 + 1);
    }

    function test_commitRevealRules() public {
        _open(Q1_2026);
        // the escrow only admits armed deposits
        vm.prank(b1);
        vm.expectRevert(bytes("Transfer not possible"));
        unitToken(sid).transfer(address(window), 10);
        vm.prank(b1);
        vm.expectRevert(ZeroUnits.selector);
        window.commitAsk(sid, bytes32(0), 0);
        _ask(b1, 90e6, 50, 50);
        assertEq(unitToken(sid).balanceOf(address(window)), 50);
        assertEq(window.askEscrowUnits(sid, b1), 50);
        assertEq(vault.accrualUnits(sid, b1), 100); // escrowed units keep earning
        assertEq(window.armedDeposit(b1), 0);
        // one order per wallet, on either side
        fund(b1, 1e6);
        vm.startPrank(b1);
        usdc.approve(address(window), 1e6);
        vm.expectRevert(OrderAlreadyExists.selector);
        window.commitBid(sid, bytes32(0), 1e6);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(WalletNotAllowlisted.selector, stranger));
        window.commitBid(sid, bytes32(0), 1e6);
        vm.prank(b4);
        vm.expectRevert(ZeroEscrow.selector);
        window.commitBid(sid, bytes32(0), 0);
        _bid(b4, 100e6, 30, _escrowBid(100e6, 30));
        _bid(b5, 100e6, 31, _escrowBid(100e6, 31)); // over the 30-unit wallet cap → invalid at reveal
        _bid(b6, 100e6, 10, 1_000e6); // escrow short of 10 × 100 + 1% → invalid
        _ask(b2, 100e6, 40, 30); // asks more than escrowed → invalid
        // reveal phase
        vm.prank(b1);
        vm.expectRevert(NotRevealPhase.selector);
        window.revealOrder(sid, 90e6, 50, _salt(b1));
        vm.warp(window.getWindow(sid, Q1_2026).commitEnd);
        vm.prank(b1);
        vm.expectRevert(CommitPhaseOver.selector);
        window.commitAsk(sid, bytes32(0), 1);
        vm.prank(stranger);
        vm.expectRevert(OrderNotFound.selector);
        window.revealOrder(sid, 1, 1, bytes32(0));
        vm.prank(b1);
        vm.expectRevert(CommitmentMismatch.selector);
        window.revealOrder(sid, 90e6, 49, _salt(b1));
        vm.prank(b1);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderRevealed(sid, Q1_2026, b1, IMercesWindow.Side.Ask, 90e6, 50, true);
        window.revealOrder(sid, 90e6, 50, _salt(b1));
        vm.prank(b1);
        vm.expectRevert(OrderAlreadyRevealed.selector);
        window.revealOrder(sid, 90e6, 50, _salt(b1));
        _reveal(b4, 100e6, 30);
        _reveal(b5, 100e6, 31);
        _reveal(b6, 100e6, 10);
        _reveal(b2, 100e6, 40);
        assertTrue(window.getOrder(sid, Q1_2026, _idx(Q1_2026, b4)).valid);
        assertFalse(window.getOrder(sid, Q1_2026, _idx(Q1_2026, b5)).valid);
        assertFalse(window.getOrder(sid, Q1_2026, _idx(Q1_2026, b6)).valid);
        assertFalse(window.getOrder(sid, Q1_2026, _idx(Q1_2026, b2)).valid);
        assertEq(window.walletCapUnits(sid), 30);
        assertEq(window.requiredBidEscrow(sid, 100e6, 10), 1_010e6);
        // settle: S = 50 (b1 below), D = 30 (b4 at p*) → demand-limited at 100: matched 30
        _settleAt(100e6);
        IMercesWindow.Window memory w = window.getWindow(sid, Q1_2026);
        assertEq(uint8(w.state), uint8(IMercesWindow.WindowState.Settled));
        assertEq(uint8(w.branch), uint8(IMercesWindow.Branch.DemandLimited));
        assertEq(w.matchedUnits, 30);
        assertEq(w.validCount, 2);
        // invalid orders get everything back, any time
        _process(Q1_2026, b5);
        _process(Q1_2026, b2);
        assertEq(usdc.balanceOf(b5), _escrowBid(100e6, 31));
        assertEq(unitToken(sid).balanceOf(b2), 100);
        assertEq(window.askEscrowUnits(sid, b2), 0);
        _process(Q1_2026, b4);
        _process(Q1_2026, b6);
        _process(Q1_2026, b1);
        assertEq(unitToken(sid).balanceOf(b4), 30);
        assertEq(unitToken(sid).balanceOf(b1), 70); // 50 escrowed, 30 sold, 20 returned
        assertEq(usdc.balanceOf(b1), 3_000e6 + 3_800e6 * 0); // proceeds only (pending payouts are claimed separately)
        assertFalse(window.hasPendingOrders(sid));
    }

    // ---------------------------------------------------------------- supply-limited (A) then demand-limited (B)

    function test_supplyLimitedClearingFirstComeAtTheMargin() public {
        _open(Q1_2026);
        _ask(b1, 90e6, 50, 50);
        _ask(b2, 100e6, 30, 30);
        _bid(b4, 110e6, 30, _escrowBid(110e6, 30));
        _bid(b5, 100e6, 30, _escrowBid(100e6, 30));
        _bid(b6, 100e6, 30, _escrowBid(100e6, 30));
        vm.warp(window.getWindow(sid, Q1_2026).commitEnd);
        _reveal(b1, 90e6, 50);
        _reveal(b2, 100e6, 30);
        _reveal(b4, 110e6, 30);
        _reveal(b5, 100e6, 30);
        _reveal(b6, 100e6, 30);
        vm.warp(window.getWindow(sid, Q1_2026).revealEnd);
        // wrong proposals are rejected and may be followed by another; an incomplete round cannot be reset
        vm.startPrank(keeper);
        window.beginWindowSettlement(sid, 0, true); // NO_MATCH while a crossing exists
        window.tallyOrders(sid, 0, 2);
        vm.expectRevert(TallyInProgress.selector);
        window.beginWindowSettlement(sid, 100e6, false);
        window.tallyOrders(sid, 0, 5);
        vm.expectEmit(true, true, false, true);
        emit IMercesWindow.WindowSettlementRejected(sid, Q1_2026, 0, REJECT_WINDOW_CROSSING_EXISTS);
        window.finalizeWindow(sid);
        window.beginWindowSettlement(sid, 95e6, false); // nobody revealed 95
        window.tallyOrders(sid, 0, 5);
        vm.expectEmit(true, true, false, true);
        emit IMercesWindow.WindowSettlementRejected(sid, Q1_2026, 95e6, REJECT_WINDOW_PRICE_NOT_REVEALED);
        window.finalizeWindow(sid);
        window.beginWindowSettlement(sid, 110e6, false); // S = 80 > D = 30 but s_below = 80 > D: no branch
        window.tallyOrders(sid, 0, 5);
        vm.expectEmit(true, true, false, true);
        emit IMercesWindow.WindowSettlementRejected(sid, Q1_2026, 110e6, REJECT_WINDOW_NO_BRANCH);
        window.finalizeWindow(sid);
        // p* = 100: S = 80 (50 below + 30 at), D = 90 (30 above + 60 at): supply-limited, margin 50 for the bids
        window.beginWindowSettlement(sid, 100e6, false);
        window.tallyOrders(sid, 0, 5);
        vm.expectEmit(true, true, false, true);
        emit IMercesWindow.WindowCleared(sid, Q1_2026, 100e6, 80, IMercesWindow.Branch.SupplyLimited);
        window.finalizeWindow(sid);
        vm.stopPrank();
        IMercesWindow.Window memory w = window.getWindow(sid, Q1_2026);
        assertEq(w.marginalRemaining, 50);
        assertEq(w.tallyRound, 4);
        (bool active,) = window.activeWindow(sid);
        assertFalse(active);
        assertTrue(window.hasPendingOrders(sid));

        // asks wait for the bids; marginal bids go in reveal order
        vm.prank(keeper);
        vm.expectRevert(BidsPending.selector);
        window.processOrder(sid, Q1_2026, _idx(Q1_2026, b1));
        vm.prank(keeper);
        vm.expectRevert(OutOfOrder.selector);
        window.processOrder(sid, Q1_2026, _idx(Q1_2026, b6));
        (bool hasNext, uint256 nextIdx) = window.nextMarginalOrder(sid, Q1_2026);
        assertTrue(hasNext);
        assertEq(nextIdx, _idx(Q1_2026, b5));
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderFilled(sid, Q1_2026, b5, IMercesWindow.Side.Bid, 30, 100e6, 30e6, 0);
        window.processOrder(sid, Q1_2026, _idx(Q1_2026, b5));
        _process(Q1_2026, b4); // non-marginal bid, any order
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderFilled(sid, Q1_2026, b6, IMercesWindow.Side.Bid, 20, 100e6, 20e6, 1_010e6);
        window.processOrder(sid, Q1_2026, _idx(Q1_2026, b6));
        vm.prank(keeper);
        vm.expectRevert(OrderAlreadyProcessed.selector);
        window.processOrder(sid, Q1_2026, _idx(Q1_2026, b6));
        assertEq(window.getWindow(sid, Q1_2026).unitsPool, 80);
        // asks in reveal order, full fills
        vm.prank(keeper);
        vm.expectRevert(OutOfOrder.selector);
        window.processOrder(sid, Q1_2026, _idx(Q1_2026, b2));
        (hasNext, nextIdx) = window.nextAskOrder(sid, Q1_2026);
        assertEq(nextIdx, _idx(Q1_2026, b1));
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderFilled(sid, Q1_2026, b1, IMercesWindow.Side.Ask, 50, 100e6, 0, 0);
        window.processOrder(sid, Q1_2026, _idx(Q1_2026, b1));
        _process(Q1_2026, b2);
        // balances: units
        assertEq(unitToken(sid).balanceOf(b1), 50);
        assertEq(unitToken(sid).balanceOf(b2), 70);
        assertEq(unitToken(sid).balanceOf(b4), 30);
        assertEq(unitToken(sid).balanceOf(b5), 30);
        assertEq(unitToken(sid).balanceOf(b6), 20);
        assertEq(unitToken(sid).balanceOf(address(window)), 0);
        assertEq(unitToken(sid).totalSupply(), 300);
        // money conservation: Σ buyer cost = p* × 80 = Σ seller proceeds; fees 1 %
        assertEq(usdc.balanceOf(b1), 5_000e6);
        assertEq(usdc.balanceOf(b2), 3_000e6);
        assertEq(usdc.balanceOf(b4), _escrowBid(110e6, 30) - 3_000e6 - 30e6);
        assertEq(usdc.balanceOf(b5), 0);
        assertEq(usdc.balanceOf(b6), _escrowBid(100e6, 30) - 2_000e6 - 20e6);
        assertEq(usdc.balanceOf(address(window)), 0);
        assertEq(usdc.balanceOf(address(feeCollector)), 300e6 + 600e6 + 80e6);
        w = window.getWindow(sid, Q1_2026);
        assertEq(w.stableToSellers, 8_000e6);
        assertEq(w.feesTotal, 80e6);
        assertEq(w.unitsDelivered, 80);
        assertEq(w.unitsReturned, 0);
        assertEq(w.processedCount, 5);
        assertFalse(window.hasPendingOrders(sid));
        // payouts: pre-window accruals are preserved, post-window accruals follow the new balances
        assertEq(vault.pendingOf(sid, b1), 3_800e6);
        assertEq(vault.pendingOf(sid, b4), 0);
        assertTrue(vault.getHolder(sid, b4).registered);
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2()); // 38 USDC/unit
        assertEq(vault.pendingOf(sid, b1), 3_800e6 + 50 * 38e6);
        assertEq(vault.pendingOf(sid, b2), 3_800e6 + 70 * 38e6);
        assertEq(vault.pendingOf(sid, b3), 3_800e6 + 100 * 38e6);
        assertEq(vault.pendingOf(sid, b4), 30 * 38e6);
        assertEq(vault.pendingOf(sid, b6), 20 * 38e6);

        // ---- Q2 window: demand-limited branch (B)
        _open(Q1_2026 + 1);
        uint32 p2 = Q1_2026 + 1;
        _ask(b1, 100e6, 50, 50);
        _ask(b2, 100e6, 50, 50);
        _bid(b7, 110e6, 30, _escrowBid(110e6, 30));
        _bid(b8, 100e6, 30, _escrowBid(100e6, 30));
        vm.warp(window.getWindow(sid, p2).commitEnd);
        _reveal(b2, 100e6, 50); // b2 reveals first this time
        _reveal(b1, 100e6, 50);
        _reveal(b7, 110e6, 30);
        _reveal(b8, 100e6, 30);
        vm.warp(window.getWindow(sid, p2).revealEnd);
        vm.startPrank(keeper);
        window.beginWindowSettlement(sid, 100e6, false); // S = 100 at p*, D = 60 → demand-limited, margin 60 for asks
        window.tallyOrders(sid, 0, 4);
        vm.expectEmit(true, true, false, true);
        emit IMercesWindow.WindowCleared(sid, p2, 100e6, 60, IMercesWindow.Branch.DemandLimited);
        window.finalizeWindow(sid);
        vm.stopPrank();
        _process(p2, b8); // bids first, any order in branch B
        _process(p2, b7);
        _process(p2, b2); // marginal asks in reveal order: b2 60 → 50, b1 → 10
        _process(p2, b1);
        assertEq(unitToken(sid).balanceOf(b2), 20); // 70 − 50
        assertEq(unitToken(sid).balanceOf(b1), 40); // 50 − 10
        assertEq(unitToken(sid).balanceOf(b7), 30);
        assertEq(unitToken(sid).balanceOf(b8), 30);
        assertEq(usdc.balanceOf(b2), 3_000e6 + 5_000e6);
        assertEq(usdc.balanceOf(b1), 5_000e6 + 1_000e6);
        assertEq(unitToken(sid).totalSupply(), 300);
        assertEq(usdc.balanceOf(address(window)), 0);
    }

    function test_noMatchReturnsEverything() public {
        _open(Q1_2026);
        _ask(b1, 120e6, 50, 50);
        _bid(b4, 100e6, 30, _escrowBid(100e6, 30));
        address silent = b5;
        _bid(silent, 100e6, 30, _escrowBid(100e6, 30)); // never reveals: uncharged (A28)
        vm.warp(window.getWindow(sid, Q1_2026).commitEnd);
        _reveal(b1, 120e6, 50);
        _reveal(b4, 100e6, 30);
        vm.warp(window.getWindow(sid, Q1_2026).revealEnd);
        vm.startPrank(keeper);
        window.beginWindowSettlement(sid, 100e6, false); // a price proposal cannot clear: D = 30, S = 0
        window.tallyOrders(sid, 0, 3);
        vm.expectEmit(true, true, false, true);
        emit IMercesWindow.WindowSettlementRejected(sid, Q1_2026, 100e6, REJECT_WINDOW_NO_BRANCH);
        window.finalizeWindow(sid);
        window.beginWindowSettlement(sid, 0, true);
        window.tallyOrders(sid, 0, 3);
        vm.expectEmit(true, true, false, true);
        emit IMercesWindow.WindowNoMatch(sid, Q1_2026);
        window.finalizeWindow(sid);
        vm.stopPrank();
        _process(Q1_2026, b4);
        _process(Q1_2026, silent);
        _process(Q1_2026, b1);
        assertEq(unitToken(sid).balanceOf(b1), 100);
        assertEq(usdc.balanceOf(b4), _escrowBid(100e6, 30));
        assertEq(usdc.balanceOf(silent), _escrowBid(100e6, 30));
        assertEq(usdc.balanceOf(address(feeCollector)), 900e6); // no window fees
        assertFalse(window.hasPendingOrders(sid));
        // the next quarter's window can open once its report is paid
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        _open(Q1_2026 + 1);
    }

    function test_buyerRemovedFromAllowlistIsCancelledAtFill() public {
        _open(Q1_2026);
        _ask(b1, 90e6, 50, 50);
        _ask(b2, 100e6, 30, 30);
        _bid(b4, 110e6, 30, _escrowBid(110e6, 30));
        _bid(b5, 100e6, 30, _escrowBid(100e6, 30));
        _bid(b6, 100e6, 30, _escrowBid(100e6, 30));
        vm.warp(window.getWindow(sid, Q1_2026).commitEnd);
        _reveal(b1, 90e6, 50);
        _reveal(b2, 100e6, 30);
        _reveal(b4, 110e6, 30);
        _reveal(b5, 100e6, 30);
        _reveal(b6, 100e6, 30);
        _settleAt(100e6); // matched 80, marginal 50 (b5 30, b6 20)
        disallow(b6);
        _process(Q1_2026, b5);
        _process(Q1_2026, b4);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderFilled(sid, Q1_2026, b6, IMercesWindow.Side.Bid, 0, 100e6, 0, _escrowBid(100e6, 30));
        window.processOrder(sid, Q1_2026, _idx(Q1_2026, b6)); // cancelled: full refund, its 20 units stay unmatched
        assertEq(usdc.balanceOf(b6), _escrowBid(100e6, 30));
        assertEq(unitToken(sid).balanceOf(b6), 0);
        assertEq(window.getWindow(sid, Q1_2026).unitsPool, 60);
        _process(Q1_2026, b1); // 50 of the 60 pooled units
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderFilled(sid, Q1_2026, b2, IMercesWindow.Side.Ask, 10, 100e6, 0, 20);
        window.processOrder(sid, Q1_2026, _idx(Q1_2026, b2)); // the last seller absorbs the cancellation
        assertEq(unitToken(sid).balanceOf(b2), 90);
        assertEq(usdc.balanceOf(b1), 5_000e6);
        assertEq(usdc.balanceOf(b2), 1_000e6);
        assertEq(unitToken(sid).balanceOf(address(window)), 0);
        assertEq(usdc.balanceOf(address(window)), 0);
        assertEq(unitToken(sid).totalSupply(), 300);
        // a removed wallet keeps and can later sell what it already holds (C10)
        assertEq(unitToken(sid).balanceOf(b4), 30);
    }

    function test_extinguishedDuringWindowBlocksFinalClaimsUntilProcessed() public {
        _open(Q1_2026);
        _ask(b1, 90e6, 50, 50);
        _bid(b4, 100e6, 30, _escrowBid(100e6, 30));
        (bytes memory a, bytes memory b) = extinguishSigs(sid, 0);
        vault.extinguish(sid, a, b); // allowed in every status
        vm.prank(b2);
        vm.expectRevert(WindowOpen.selector);
        vault.claimFinal(sid);
        vm.warp(window.getWindow(sid, Q1_2026).commitEnd);
        _reveal(b1, 90e6, 50);
        _reveal(b4, 100e6, 30);
        _settleAt(100e6); // B: D = 30 < S = 50 → matched 30
        _process(Q1_2026, b4);
        _process(Q1_2026, b1);
        assertFalse(window.hasPendingOrders(sid));
        vm.prank(b1);
        vault.claimFinal(sid);
        assertEq(unitToken(sid).balanceOf(b1), 0);
        // final weights follow the post-window balances: 70 for b1, 30 for b4
        assertEq(vault.getLedger(sid).finalUnits, 300);
        vm.prank(b4);
        vault.claimFinal(sid);
        vm.prank(b2);
        vault.claimFinal(sid);
        vm.prank(b3);
        vault.claimFinal(sid);
        assertEq(unitToken(sid).totalSupply(), 0);
    }
}
