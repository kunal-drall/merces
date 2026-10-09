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
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
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
        (, uint32 period) = window.currentWindow(sid);
        vm.warp(window.getWindow(sid, period).revealEnd);
        vm.startPrank(keeper);
        window.beginWindowSettlement(sid, p, false);
        window.tallyOrders(sid, 0, window.getWindow(sid, period).orderCount);
        window.finalizeWindow(sid);
        vm.stopPrank();
    }

    /// @dev Accounting step then delivery (B-S13).
    function _process(uint32 period, address who) internal {
        vm.prank(keeper);
        window.processOrder(sid, who);
        vm.prank(keeper);
        window.deliverOrder(sid, period, who);
    }

    function _state() internal view returns (IMercesWindow.WindowState) {
        (, uint32 period) = window.currentWindow(sid);
        return window.getWindow(sid, period).state;
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
        vm.expectRevert(RaiseNotSettled.selector);
        window.openWindow(draft, Q1_2026);
        uint256 locked = runStandardRaise(); // 18-month lockup
        vm.expectRevert(LockupActive.selector);
        window.openWindow(locked, Q1_2026);
        vm.expectRevert(WindowNotEligible.selector);
        window.openWindow(sid, Q1_2026 - 1);
        vm.expectRevert(WindowNotEligible.selector);
        window.openWindow(sid, Q1_2026 + 1); // not even ended
        _open(Q1_2026);
        vm.expectRevert(WindowOpen.selector);
        window.openWindow(sid, Q1_2026);
        (bool exists, uint32 period) = window.currentWindow(sid);
        assertTrue(exists);
        assertEq(period, Q1_2026);
        assertEq(uint8(_state()), uint8(IMercesWindow.WindowState.Commit));
        // a Late series cannot open a window
        uint256 s2 = runStandardRaise(FLAGS, bytes32(0), Proofs.q1().termsCommitment, P0, 0);
        vm.warp(Periods.periodEnd(Q1_2026 + 1) + 60 days);
        assertEq(uint8(income.deriveStatus(s2)), uint8(SeriesStatus.Late));
        vm.expectRevert(WindowNotEligible.selector);
        window.openWindow(s2, Q1_2026 + 1);
    }

    function test_commitRevealRules() public {
        _open(Q1_2026);
        IERC3643Token token = unitToken(sid);
        // the escrow only admits armed deposits
        vm.prank(b1);
        vm.expectRevert(UnarmedEscrowDeposit.selector);
        token.transfer(address(window), 10);
        vm.prank(b1);
        vm.expectRevert(DirectTransferForbidden.selector);
        token.transfer(b2, 10);
        vm.prank(b1);
        vm.expectRevert(InsufficientUnits.selector);
        window.commitAsk(sid, bytes32(0), 0);
        vm.prank(b1);
        vm.expectRevert(InsufficientUnits.selector);
        window.commitAsk(sid, bytes32(0), 101); // b1 holds 100 units
        _ask(b1, 90e6, 50, 50);
        assertEq(unitToken(sid).balanceOf(address(window)), 50);
        assertEq(window.askEscrowUnits(sid, b1), 50);
        assertEq(vault.accrualUnits(sid, b1), 100); // escrowed units keep earning
        assertEq(window.armedDeposit(b1), 0);
        // one order per wallet, on either side
        fund(b1, 1e6);
        vm.startPrank(b1);
        usdc.approve(address(window), 1e6);
        vm.expectRevert(OrderExists.selector);
        window.commitBid(sid, bytes32(0), 1e6);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(NotAllowlisted.selector, stranger));
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
        vm.expectRevert(RevealPhaseClosed.selector); // before commit_end (reference error)
        window.revealOrder(sid, 90e6, 50, _salt(b1));
        vm.warp(window.getWindow(sid, Q1_2026).commitEnd);
        vm.prank(b1);
        vm.expectRevert(WindowNotOpen.selector); // commit phase over
        window.commitAsk(sid, bytes32(0), 1);
        vm.prank(stranger);
        vm.expectRevert(BidNotFound.selector);
        window.revealOrder(sid, 1, 1, bytes32(0));
        assertEq(uint8(_state()), uint8(IMercesWindow.WindowState.Commit)); // no reveal yet
        vm.prank(b1);
        vm.expectRevert(CommitmentMismatch.selector);
        window.revealOrder(sid, 90e6, 49, _salt(b1));
        vm.prank(b1);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderRevealed(sid, Q1_2026, b1, IMercesWindow.Side.Ask, 90e6, 50, true);
        window.revealOrder(sid, 90e6, 50, _salt(b1));
        assertEq(uint8(_state()), uint8(IMercesWindow.WindowState.Reveal));
        vm.prank(b1);
        vm.expectRevert(AlreadyRevealed.selector);
        window.revealOrder(sid, 90e6, 50, _salt(b1));
        _reveal(b4, 100e6, 30);
        _reveal(b5, 100e6, 31);
        _reveal(b6, 100e6, 10);
        _reveal(b2, 100e6, 40);
        assertTrue(window.getOrder(sid, Q1_2026, b4).valid);
        assertFalse(window.getOrder(sid, Q1_2026, b5).valid);
        assertFalse(window.getOrder(sid, Q1_2026, b6).valid);
        assertFalse(window.getOrder(sid, Q1_2026, b2).valid);
        assertEq(window.walletCapUnits(sid), 30);
        assertEq(window.requiredBidEscrow(sid, 100e6, 10), 1_010e6);
        // settle: the only crossing price is the seller's 90 (S = 50 at p*, D = 30 above): demand-limited, 30 matched
        _settleAt(90e6);
        IMercesWindow.Window memory w = window.getWindow(sid, Q1_2026);
        assertEq(uint8(w.state), uint8(IMercesWindow.WindowState.Settled));
        assertEq(uint8(w.branch), uint8(IMercesWindow.Branch.DemandLimited));
        assertEq(w.matchedUnits, 30);
        assertEq(w.validCount, 2);
        // revealed orders follow the reveal sequence, valid or not (B-S9): bids b4, b5, b6, then asks b1, b2;
        // invalid orders get everything back
        _process(Q1_2026, b4);
        _process(Q1_2026, b5);
        _process(Q1_2026, b6);
        assertEq(usdc.balanceOf(b5), _escrowBid(100e6, 31));
        _process(Q1_2026, b1);
        _process(Q1_2026, b2);
        assertEq(unitToken(sid).balanceOf(b2), 100);
        assertEq(window.askEscrowUnits(sid, b2), 0);
        assertEq(unitToken(sid).balanceOf(b4), 30);
        assertEq(unitToken(sid).balanceOf(b1), 70); // 50 escrowed, 30 sold, 20 returned
        assertEq(usdc.balanceOf(b1), 2_700e6 + 1e6); // proceeds (+ the 1 USDC funded above); payouts are claimed separately
        assertEq(usdc.balanceOf(b4), _escrowBid(100e6, 30) - 2_700e6 - 27e6);
        assertEq(uint8(_state()), uint8(IMercesWindow.WindowState.Done));
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
        emit IMercesWindow.WindowSettlementRejected(sid, Q1_2026, type(uint64).max, REJECT_WINDOW_CROSSING_EXISTS);
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
        assertEq(uint8(w.state), uint8(IMercesWindow.WindowState.Settled));

        // bids in reveal order, then asks in reveal order (B-S9); marginal bids fill first-come
        vm.prank(keeper);
        vm.expectRevert(BidsNotProcessed.selector);
        window.processOrder(sid, b1);
        vm.prank(keeper);
        vm.expectRevert(OutOfOrder.selector);
        window.processOrder(sid, b6);
        _process(Q1_2026, b4);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderFilled(sid, Q1_2026, b5, IMercesWindow.Side.Bid, 30, 100e6, 30e6, 0);
        window.processOrder(sid, b5);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderFilled(sid, Q1_2026, b6, IMercesWindow.Side.Bid, 20, 100e6, 20e6, 1_010e6);
        window.processOrder(sid, b6); // revealed after b5: gets what b5 leaves of the 50-unit margin
        vm.prank(keeper);
        vm.expectRevert(AlreadyProcessed.selector);
        window.processOrder(sid, b6);
        // delivery is a separate, owner-only push, once
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderDelivered(sid, Q1_2026, b6, IMercesWindow.Side.Bid, 20, 1_010e6);
        window.deliverOrder(sid, Q1_2026, b6);
        vm.prank(keeper);
        vm.expectRevert(AlreadyDelivered.selector);
        window.deliverOrder(sid, Q1_2026, b6);
        vm.prank(keeper);
        window.deliverOrder(sid, Q1_2026, b5);
        vm.prank(keeper);
        vm.expectRevert(OutOfOrder.selector);
        window.processOrder(sid, b2);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderFilled(sid, Q1_2026, b1, IMercesWindow.Side.Ask, 50, 100e6, 0, 0);
        window.processOrder(sid, b1);
        vm.prank(keeper);
        vm.expectRevert(NotProcessed.selector);
        window.deliverOrder(sid, Q1_2026, b2);
        vm.prank(keeper);
        window.deliverOrder(sid, Q1_2026, b1);
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
        assertEq(w.feesTotal, 80e6);
        assertEq(w.processedCount, 5);
        assertEq(uint8(w.state), uint8(IMercesWindow.WindowState.Done));
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
        _process(p2, b7); // bids in reveal order, then asks in reveal order
        _process(p2, b8);
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
        assertEq(uint8(_state()), uint8(IMercesWindow.WindowState.Done));
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
        _process(Q1_2026, b4);
        _process(Q1_2026, b5);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderFilled(sid, Q1_2026, b6, IMercesWindow.Side.Bid, 0, 100e6, 0, _escrowBid(100e6, 30));
        window.processOrder(sid, b6); // cancelled: full refund, its 20 units are taken back from the sellers
        vm.prank(keeper);
        window.deliverOrder(sid, Q1_2026, b6);
        assertEq(usdc.balanceOf(b6), _escrowBid(100e6, 30));
        assertEq(unitToken(sid).balanceOf(b6), 0);
        assertEq(window.getWindow(sid, Q1_2026).cancelledUnits, 20);
        assertFalse(window.priceIndexRequired(sid)); // 20 ≤ the 30 units sold at p*
        // take-back from the asks at p* first (descending reveal index): b1 below p* sells 50; b2 sells 10 of 30
        _process(Q1_2026, b1);
        vm.prank(keeper);
        vm.expectEmit(true, true, true, true);
        emit IMercesWindow.OrderFilled(sid, Q1_2026, b2, IMercesWindow.Side.Ask, 10, 100e6, 0, 20);
        window.processOrder(sid, b2);
        vm.prank(keeper);
        window.deliverOrder(sid, Q1_2026, b2);
        assertEq(unitToken(sid).balanceOf(b2), 90);
        assertEq(unitToken(sid).balanceOf(b1), 50);
        assertEq(usdc.balanceOf(b1), 5_000e6);
        assertEq(usdc.balanceOf(b2), 1_000e6);
        assertEq(unitToken(sid).balanceOf(address(window)), 0);
        assertEq(usdc.balanceOf(address(window)), 0);
        assertEq(unitToken(sid).totalSupply(), 300);
        // a removed wallet keeps and can later sell what it already holds (C10)
        assertEq(unitToken(sid).balanceOf(b4), 30);
    }

    function test_takeBackBelowClearingPriceNeedsThePriceIndex() public {
        address b9 = makeAddr("b9");
        allow(b9);
        _open(Q1_2026);
        _ask(b1, 90e6, 50, 50);
        _ask(b3, 95e6, 20, 20);
        _ask(b2, 100e6, 30, 30);
        _bid(b4, 110e6, 30, _escrowBid(110e6, 30));
        _bid(b5, 105e6, 30, _escrowBid(105e6, 30));
        _bid(b9, 100e6, 30, _escrowBid(100e6, 30));
        _bid(b6, 100e6, 10, _escrowBid(100e6, 10));
        vm.warp(window.getWindow(sid, Q1_2026).commitEnd);
        _reveal(b1, 90e6, 50);
        _reveal(b3, 95e6, 20);
        _reveal(b2, 100e6, 30);
        _reveal(b4, 110e6, 30);
        _reveal(b5, 105e6, 30);
        _reveal(b9, 100e6, 30);
        _reveal(b6, 100e6, 10);
        // p* = 100: S = 100 (70 below + 30 at), D = 100 (60 above + 40 at) → supply-limited, matched 100
        _settleAt(100e6);
        assertEq(uint8(window.getWindow(sid, Q1_2026).branch), uint8(IMercesWindow.Branch.SupplyLimited));
        disallow(b4);
        disallow(b5);
        _process(Q1_2026, b4); // cancelled 30
        _process(Q1_2026, b5); // cancelled 30
        _process(Q1_2026, b9); // fills 30
        _process(Q1_2026, b6); // fills 10
        // 60 cancelled > the 30 sold at p*: the take-back reaches the asks below p*
        assertTrue(window.priceIndexRequired(sid));
        vm.prank(keeper);
        vm.expectRevert(PriceIndexIncomplete.selector); // b1 (90) is next in reveal order and below p*
        window.processOrder(sid, b1);
        uint64[] memory bad = new uint64[](1);
        bad[0] = 100e6; // not below p*
        vm.expectRevert(PriceIndexInvalid.selector);
        window.indexAskPrices(sid, bad);
        uint64[] memory levels = new uint64[](2);
        levels[0] = 90e6;
        levels[1] = 95e6;
        vm.expectEmit(true, true, false, true);
        emit IMercesWindow.WindowTakebackSettled(sid, Q1_2026, 60, 30);
        window.indexAskPrices(sid, levels);
        assertFalse(window.priceIndexRequired(sid));
        // the asks at p* give back first (b2 all 30), then below p* from the highest price: b3 (95) gives back
        // 20, b1 (90) 10
        _process(Q1_2026, b1);
        _process(Q1_2026, b3);
        _process(Q1_2026, b2);
        assertEq(unitToken(sid).balanceOf(b2), 100);
        assertEq(unitToken(sid).balanceOf(b3), 100); // all 20 back
        assertEq(unitToken(sid).balanceOf(b1), 60); // sold 40 of 50
        assertEq(usdc.balanceOf(b1), 4_000e6);
        assertEq(usdc.balanceOf(b3), 0);
        assertEq(unitToken(sid).balanceOf(b9), 30);
        assertEq(unitToken(sid).balanceOf(b6), 10);
        assertEq(unitToken(sid).balanceOf(address(window)), 0);
        assertEq(usdc.balanceOf(address(window)), 0);
        assertEq(unitToken(sid).totalSupply(), 300);
    }

    function test_extinguishedBeforeClearingReturnsEverything() public {
        _open(Q1_2026);
        _ask(b1, 90e6, 50, 50);
        _bid(b4, 100e6, 30, _escrowBid(100e6, 30));
        (bytes memory a, bytes memory b) = extinguishSigs(sid, 0);
        vault.extinguish(sid, a, b); // allowed in every status
        vm.prank(b2);
        vault.claimFinal(sid); // not blocked by the window
        vm.prank(b1);
        vault.claimFinal(sid); // weight 100: 50 in the wallet, 50 in the (uncleared) ask escrow
        assertEq(unitToken(sid).balanceOf(b1), 0);
        vm.warp(window.getWindow(sid, Q1_2026).commitEnd);
        _reveal(b1, 90e6, 50);
        _reveal(b4, 100e6, 30);
        _settleAt(90e6); // a terminal series no longer trades: NO_MATCH whatever the proposal
        assertEq(uint8(_state()), uint8(IMercesWindow.WindowState.NoMatch));
        _process(Q1_2026, b4);
        _process(Q1_2026, b1);
        assertEq(unitToken(sid).balanceOf(b1), 50); // returned
        assertEq(usdc.balanceOf(b4), _escrowBid(100e6, 30));
        vm.prank(b1);
        vault.claimFinal(sid); // already claimed: burns the returned units, pays nothing more
        assertEq(unitToken(sid).balanceOf(b1), 0);
        vm.prank(b3);
        vault.claimFinal(sid);
        assertEq(unitToken(sid).totalSupply(), 0);
        assertEq(usdc.balanceOf(address(vault)) <= 2, true); // only rounding dust can remain
    }

    function test_payoutDuringProcessingNeverDoubleCounts() public {
        _open(Q1_2026);
        _ask(b1, 100e6, 50, 50);
        _bid(b4, 100e6, 30, _escrowBid(100e6, 30));
        vm.warp(window.getWindow(sid, Q1_2026).commitEnd);
        _reveal(b1, 100e6, 50);
        _reveal(b4, 100e6, 30);
        _settleAt(100e6); // demand-limited: b1 sells 30, keeps 20
        _process(Q1_2026, b4); // b4 holds 30 now; b1's ask is not processed yet
        // a payment lands while the window is half processed: Q2 at 38 USDC per unit on 300 units
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        // after clearing, b1's 50 escrowed units no longer earn for b1 through the escrow weight: the 30 sold
        // units earn for b4 from the clearing point, the 20 coming back are credited to b1 when its ask is processed
        assertEq(vault.pendingOf(sid, b1), 3_800e6 + 50 * 38e6);
        assertEq(vault.pendingOf(sid, b4), 30 * 38e6);
        _process(Q1_2026, b1);
        assertEq(vault.pendingOf(sid, b1), 3_800e6 + 50 * 38e6 + 20 * 38e6);
        uint256 total;
        address[5] memory hs = [b1, b2, b3, b4, b5];
        for (uint256 i = 0; i < 5; i++) {
            total += vault.pendingOf(sid, hs[i]);
        }
        // every unit earned for exactly one wallet: Σ pending == Q1 + Q2 net == the vault balance
        assertEq(total, 2 * 11_400e6);
        assertEq(total, usdc.balanceOf(address(vault)));
    }

    /// @dev C-S20: a window that cleared before extinguishment is processed after it; the buyer, registered at its
    /// fill, is owed the final share of the units it bought (they existed at extinguishment), so nothing strands.
    function test_buyerRegisteredAfterExtinguishmentGetsTheFinalShare() public {
        _open(Q1_2026);
        _ask(b1, 100e6, 30, 30);
        _bid(b4, 100e6, 30, _escrowBid(100e6, 30));
        vm.warp(window.getWindow(sid, Q1_2026).commitEnd);
        _reveal(b1, 100e6, 30);
        _reveal(b4, 100e6, 30);
        _settleAt(100e6);
        (bytes memory a, bytes memory b) = extinguishSigs(sid, 0);
        vault.extinguish(sid, a, b);
        uint256 unreleased = vault.getLedger(sid).unreleasedReceived;
        assertGt(unreleased, 0);
        vm.prank(b1);
        vm.expectRevert(OutOfOrder.selector); // the seller's escrowed units are sold or coming back: settle first
        vault.claimFinal(sid);
        _process(Q1_2026, b4);
        _process(Q1_2026, b1);
        assertEq(vault.claimableFinal(sid, b4), unreleased * 30 / 300);
        assertEq(vault.claimableFinal(sid, b1), unreleased * 70 / 300);
        address[4] memory hs = [b1, b2, b3, b4];
        uint256 before = usdc.balanceOf(address(vault));
        uint256 pendingTotal;
        for (uint256 i = 0; i < 4; i++) {
            pendingTotal += vault.pendingOf(sid, hs[i]);
            vm.prank(hs[i]);
            vault.claimFinal(sid);
        }
        assertLe(before - usdc.balanceOf(address(vault)), pendingTotal + unreleased);
        assertLe(usdc.balanceOf(address(vault)), 8, "only rounding dust is left");
        assertEq(unitToken(sid).totalSupply(), 0);
    }

    /// @dev B-S19: the reveal-time wallet cap counts units the buyer owns but has not received yet.
    function test_walletCapCountsUndeliveredWindowUnits() public {
        _open(Q1_2026);
        _ask(b1, 100e6, 30, 30);
        _bid(b4, 100e6, 30, _escrowBid(100e6, 30));
        vm.warp(window.getWindow(sid, Q1_2026).commitEnd);
        _reveal(b1, 100e6, 30);
        _reveal(b4, 100e6, 30);
        _settleAt(100e6);
        vm.startPrank(keeper);
        window.processOrder(sid, b4); // 30 units pending for b4, not delivered
        window.processOrder(sid, b1);
        vm.stopPrank();
        assertEq(window.pendingUnitsOf(sid, b4), 30);
        assertEq(unitToken(sid).balanceOf(b4), 0);
        assertEq(vault.accrualUnits(sid, b4), 30); // pending units earn
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        _open(Q1_2026 + 1);
        uint32 p2 = Q1_2026 + 1;
        _bid(b4, 100e6, 1, _escrowBid(100e6, 1));
        vm.warp(window.getWindow(sid, p2).commitEnd);
        _reveal(b4, 100e6, 1);
        assertFalse(window.getOrder(sid, p2, b4).valid, "30 owned + 1 > the 30-unit cap");
        // the delivery of the first window is still possible at any time
        vm.prank(keeper);
        window.deliverOrder(sid, Q1_2026, b4);
        assertEq(unitToken(sid).balanceOf(b4), 30);
        assertEq(window.pendingUnitsOf(sid, b4), 0);
    }
}
