// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {IMercesWindow} from "../../src/interfaces/IMercesWindow.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {TierFlags} from "../../src/types/MercesTypes.sol";

/// @notice Property tests of the transfer window (SPEC v1.1 §7, brief F2) over random order books: both sides,
/// ties, invalid and unrevealed orders, buyers de-allowlisted before their fill (take-back path), and a payout
/// distributed between clearing and processing (accrual snapshot, C-S4).
/// - exactly one proposal (a price or NO_MATCH) is accepted (uniqueness, ARCHITECTURE §5.2);
/// - money: Σ bid escrow == buyer refunds + seller proceeds + fees; buyers pay exactly p*·fill + fee, sellers
///   receive exactly p*·fill; nothing stays in the window;
/// - units: none created or lost, buyers within the wallet cap and their bid, sold == bought;
/// - no recipient-side condition (a de-allowlisted buyer) blocks finalization or processing;
/// - accrual: every distributed unit of value is owed to exactly one wallet (Σ pending == net distributed − dust).
contract WindowFuzzTest is FullFixture {
    uint8 internal constant FLAGS = TierFlags.TIER2_ZKTLS | TierFlags.TIER3_ATTESTOR;
    uint256 internal constant BUYERS = 6;
    uint64 internal constant CAP_UNITS = 30; // 10% of 300 units

    struct O {
        address who;
        bool ask;
        uint64 price;
        uint64 qty;
        uint64 escrow;
        bool reveal;
        bool valid;
        bool delisted;
    }

    uint256 internal sid;
    address[3] internal sellers;

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        registry.setFlags(false, true, false);
        sid = runStandardRaise(FLAGS, bytes32(0), Proofs.q1().termsCommitment, P0, 0); // no lockup
        reportAndPay(sid, Q1_2026, Proofs.q1());
        sellers = [b1, b2, b3];
        vm.prank(keeper);
        window.openWindow(sid, Q1_2026);
    }

    function _rand(uint256 seed, uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i)));
    }

    function _book(uint256 seed) internal returns (O[] memory os) {
        os = new O[](3 + BUYERS);
        for (uint256 i = 0; i < os.length; i++) {
            uint256 r = _rand(seed, i);
            O memory o = os[i];
            o.ask = i < 3;
            o.who = o.ask ? sellers[i] : makeAddr(string.concat("windowBuyer", vm.toString(i)));
            if (r % 10 < 2) continue; // no order from this wallet
            o.price = uint64(uint256(P0) * (2 + (r >> 8) % 7) / 4); // 50 .. 200 USDC, many ties
            o.reveal = (r >> 16) % 100 < 85;
            if (o.ask) {
                o.escrow = uint64(1 + (r >> 24) % 100); // units put into escrow
                uint256 m = (r >> 32) % 10;
                o.qty = m == 0 ? 0 : m == 1 ? o.escrow + 1 : uint64(1 + (r >> 40) % o.escrow);
                o.valid = o.reveal && o.qty >= 1 && o.qty <= o.escrow;
            } else {
                uint256 m = (r >> 32) % 10;
                o.qty = m == 0 ? 0 : m == 1 ? CAP_UNITS + 1 : uint64(1 + (r >> 40) % CAP_UNITS);
                uint256 req = window.requiredBidEscrow(sid, o.price, o.qty);
                uint256 e = (r >> 48) % 10;
                uint256 escrow = e == 0 ? req - (req > 0 ? 1 : 0) : e < 7 ? req : req + (r >> 56) % (req + 1);
                o.escrow = uint64(escrow == 0 ? 1 : escrow);
                o.valid = o.reveal && o.qty >= 1 && o.qty <= CAP_UNITS && o.escrow >= req;
                o.delisted = (r >> 64) % 100 < 15;
                allow(o.who);
            }
        }
    }

    function _commit(O[] memory os) internal {
        for (uint256 i = 0; i < os.length; i++) {
            O memory o = os[i];
            if (o.price == 0) continue;
            bytes32 c = MercesMessages.orderCommitment(o.price, o.qty, bytes32(i), o.who);
            if (o.ask) {
                vm.startPrank(o.who);
                unitToken(sid).approve(address(window), o.escrow);
                window.commitAsk(sid, c, o.escrow);
                vm.stopPrank();
            } else {
                fund(o.who, o.escrow);
                vm.startPrank(o.who);
                usdc.approve(address(window), o.escrow);
                window.commitBid(sid, c, o.escrow);
                vm.stopPrank();
            }
        }
    }

    function _w() internal view returns (IMercesWindow.Window memory) {
        return window.getWindow(sid, Q1_2026);
    }

    function _try(uint64 p, bool noMatch) internal returns (IMercesWindow.Window memory w) {
        vm.startPrank(keeper);
        window.beginWindowSettlement(sid, p, noMatch);
        window.tallyOrders(sid, 0, _w().orderCount);
        window.finalizeWindow(sid);
        vm.stopPrank();
        w = _w();
    }

    function testFuzz_windowClearsUniquelyAndConserves(uint256 seed) public {
        O[] memory os = _book(seed);
        _commit(os);
        vm.warp(_w().commitEnd);
        for (uint256 i = 0; i < os.length; i++) {
            if (os[i].price == 0 || !os[i].reveal) continue;
            vm.prank(os[i].who);
            window.revealOrder(sid, os[i].price, os[i].qty, bytes32(i));
            assertEq(window.getOrder(sid, Q1_2026, os[i].who).valid, os[i].valid, "validity rule");
        }
        vm.warp(_w().revealEnd);

        // every candidate (NO_MATCH and each revealed valid price), each on its own copy of the state
        uint256 accepted;
        uint64 pStar;
        bool noMatch;
        for (uint256 i = 0; i <= os.length; i++) {
            bool nm = i == os.length;
            if (!nm && (!os[i].valid || _seenBefore(os, i))) continue;
            uint256 snap = vm.snapshotState();
            IMercesWindow.Window memory w = _try(nm ? 0 : os[i].price, nm);
            if (!w.roundRejected) {
                accepted++;
                (pStar, noMatch) = (nm ? 0 : os[i].price, nm);
            }
            vm.revertToState(snap);
        }
        assertEq(accepted, 1, "exactly one clearing proposal is valid");
        IMercesWindow.Window memory cleared = _try(pStar, noMatch);
        assertFalse(cleared.roundRejected);

        // recipient-side changes after clearing: some buyers lose their allowlisting before their fill
        for (uint256 i = 3; i < os.length; i++) {
            if (os[i].delisted) disallow(os[i].who);
        }
        // sometimes a payout lands between clearing and processing (ask-escrow units earn only until clearing)
        uint256 netDistributed = vault.getLedger(sid).grossReceived - vault.getLedger(sid).feeCollected;
        if (seed % 2 == 0) {
            reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
            netDistributed = vault.getLedger(sid).grossReceived - vault.getLedger(sid).feeCollected;
        }

        uint256 feesBefore = usdc.balanceOf(address(feeCollector));
        uint256[] memory stableBefore = new uint256[](os.length);
        for (uint256 i = 0; i < os.length; i++) {
            stableBefore[i] = usdc.balanceOf(os[i].who);
        }
        _processAll(os, seed);
        _checkMoney(os, stableBefore, feesBefore, cleared);
        _checkUnits(os, cleared);
        _checkAccrual(os, netDistributed);
    }

    function _seenBefore(O[] memory os, uint256 i) internal pure returns (bool) {
        for (uint256 j = 0; j < i; j++) {
            if (os[j].valid && os[j].price == os[i].price) return true;
        }
        return false;
    }

    /// @dev Bids (in a random order), then the keeper's ask price index when the take-back needs it, then asks.
    function _processAll(O[] memory os, uint256 seed) internal {
        uint256 start = seed % BUYERS;
        for (uint256 k = 0; k < BUYERS; k++) {
            O memory o = os[3 + (start + k) % BUYERS];
            if (o.price == 0) continue;
            vm.prank(keeper);
            window.processOrder(sid, o.who);
        }
        if (window.priceIndexRequired(sid)) {
            uint64[] memory prices = _askPricesBelow(os, _w().clearingPrice);
            vm.prank(keeper);
            window.indexAskPrices(sid, prices);
        }
        for (uint256 k = 0; k < 3; k++) {
            O memory o = os[(seed / 7 + k) % 3];
            if (o.price == 0) continue;
            vm.prank(keeper);
            window.processOrder(sid, o.who);
        }
        assertEq(uint8(_w().state), uint8(IMercesWindow.WindowState.Done));
    }

    function _askPricesBelow(O[] memory os, uint64 p) internal pure returns (uint64[] memory out) {
        uint64[] memory tmp = new uint64[](3);
        uint256 n;
        for (uint256 i = 0; i < 3; i++) {
            if (!os[i].valid || os[i].price >= p) continue;
            bool dup;
            for (uint256 j = 0; j < n; j++) {
                if (tmp[j] == os[i].price) dup = true;
            }
            if (!dup) tmp[n++] = os[i].price;
        }
        out = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = tmp[i];
        }
        // ascending insertion sort
        for (uint256 i = 1; i < n; i++) {
            for (uint256 j = i; j > 0 && out[j - 1] > out[j]; j--) {
                (out[j - 1], out[j]) = (out[j], out[j - 1]);
            }
        }
    }

    function _checkMoney(
        O[] memory os,
        uint256[] memory stableBefore,
        uint256 feesBefore,
        IMercesWindow.Window memory cleared
    ) internal view {
        uint64 p = cleared.clearingPrice;
        uint256 escrowIn;
        uint256 out;
        uint256 bought;
        uint256 sold;
        for (uint256 i = 0; i < os.length; i++) {
            O memory o = os[i];
            if (o.price == 0) continue;
            IMercesWindow.Order memory oc = window.getOrder(sid, Q1_2026, o.who);
            assertTrue(oc.processed);
            uint256 gained = usdc.balanceOf(o.who) - stableBefore[i];
            if (o.ask) {
                sold += oc.fill;
                assertEq(gained, uint256(p) * oc.fill, "seller receives exactly p* x fill");
                if (oc.fill > 0) assertTrue(o.valid && o.price <= p);
            } else {
                bought += oc.fill;
                escrowIn += o.escrow;
                uint256 cost = uint256(p) * oc.fill;
                uint256 fee = cost * 100 / 10_000;
                assertEq(gained, o.escrow - cost - fee, "buyer pays exactly p* x fill + fee");
                out += gained;
                if (oc.fill > 0) assertTrue(o.valid && o.price >= p && !o.delisted);
            }
        }
        assertEq(bought, sold, "units bought == units sold");
        uint256 fees = usdc.balanceOf(address(feeCollector)) - feesBefore;
        assertEq(escrowIn, out + uint256(p) * sold + fees, "escrow == refunds + seller proceeds + fees");
        assertEq(usdc.balanceOf(address(window)), 0, "nothing left in the window");
        IMercesWindow.Window memory w = _w();
        assertEq(w.escrowStable, 0);
        assertEq(w.escrowUnits, 0);
        if (cleared.branch != IMercesWindow.Branch.None) assertEq(sold + w.cancelledUnits, cleared.matchedUnits);
        else assertEq(sold, 0);
    }

    function _checkUnits(O[] memory os, IMercesWindow.Window memory) internal view {
        uint256 total;
        for (uint256 i = 0; i < os.length; i++) {
            uint256 bal = unitToken(sid).balanceOf(os[i].who);
            total += bal;
            if (!os[i].ask) {
                assertLe(bal, CAP_UNITS, "wallet cap");
                assertLe(bal, os[i].qty);
            }
        }
        assertEq(total, 300, "units are neither created nor lost");
        assertEq(unitToken(sid).balanceOf(address(window)), 0);
        assertEq(unitToken(sid).totalSupply(), 300);
    }

    /// @dev Σ pending over every wallet == net distributed − rounding dust (< 1 base unit per settle).
    function _checkAccrual(O[] memory os, uint256 netDistributed) internal view {
        uint256 owed;
        for (uint256 i = 0; i < os.length; i++) {
            owed += vault.pendingOf(sid, os[i].who);
        }
        assertLe(owed, netDistributed, "more owed than distributed");
        assertLe(netDistributed - owed, 2 * os.length + 2, "distributed value lost");
    }
}
