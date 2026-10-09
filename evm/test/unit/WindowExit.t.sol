// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FreeReportFixture} from "../utils/FreeReportFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {IMercesVault} from "../../src/interfaces/IMercesVault.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {SeriesStatus, TierFlags} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

/// @notice A window that cleared before redemption is processed after it (docs/assumptions/track-c.md C-S20,
/// C-S21): units sold in it and units coming back from it carry their full redemption and tail entitlement,
/// so nothing strands in the vault.
contract WindowExitTest is FreeReportFixture {
    uint8 internal constant FLAGS = TierFlags.TIER2_ZKTLS | TierFlags.TIER3_ATTESTOR;
    uint256 internal sid;
    address internal b4 = makeAddr("b4");

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        registry.setFlags(false, true, false);
        sid = runStandardRaise(FLAGS, bytes32(0), Proofs.q1().termsCommitment, P0, 0); // no lockup
        installMockVerifier();
        freeReport(sid, Q1_2026, 3_000e6);
        payDue(sid, issuer);
        allow(b4);
    }

    function _order(address who, bool ask, uint64 price, uint64 qty, uint64 escrow) internal {
        bytes32 c = MercesMessages.orderCommitment(price, qty, keccak256(abi.encode(who)), who);
        vm.startPrank(who);
        if (ask) {
            unitToken(sid).approve(address(window), escrow);
            window.commitAsk(sid, c, escrow);
        } else {
            usdc.approve(address(window), escrow);
            window.commitBid(sid, c, escrow);
        }
        vm.stopPrank();
    }

    function test_unitsProcessedAfterRedemptionKeepRedemptionAndTail() public {
        vm.prank(keeper);
        window.openWindow(sid, Q1_2026);
        _order(b1, true, 200e6, 30, 30);
        uint64 bidEscrow = uint64(window.requiredBidEscrow(sid, 200e6, 10));
        fund(b4, bidEscrow);
        _order(b4, false, 200e6, 10, bidEscrow);
        vm.warp(window.getWindow(sid, Q1_2026).commitEnd);
        vm.prank(b1);
        window.revealOrder(sid, 200e6, 30, keccak256(abi.encode(b1)));
        vm.prank(b4);
        window.revealOrder(sid, 200e6, 10, keccak256(abi.encode(b4)));
        vm.warp(window.getWindow(sid, Q1_2026).revealEnd);
        vm.startPrank(keeper);
        window.beginWindowSettlement(sid, 200e6, false);
        window.tallyOrders(sid, 0, 2);
        window.finalizeWindow(sid);
        vm.stopPrank();
        assertEq(window.getWindow(sid, Q1_2026).matchedUnits, 10); // b1 sells 10, gets 20 back

        // the issuer redeems while the window is still unprocessed
        (,,,, uint64 deposit) = vault.previewRedemption(sid, vm.getBlockTimestamp());
        fund(issuer, deposit);
        vm.startPrank(issuer);
        usdc.approve(address(vault), deposit);
        vault.redeem(sid);
        vm.stopPrank();
        assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Redeemed));
        uint256 price = vault.getLedger(sid).redemptionPrice;

        // a liquidity event in the tail
        uint32 q2 = Q1_2026 + 1;
        vm.warp(Periods.periodEnd(q2));
        IMercesIncome.ReportInput memory r = freeReportInput(sid, q2, 6_000e6, true);
        vm.prank(issuer);
        income.submitReport(r);
        payDue(sid, issuer);
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        assertGt(l.tailAccWad, 0);

        // b1 redeems its 70 wallet units and claims its tail before its ask is processed
        vm.startPrank(b1);
        vault.claimRedemption(sid);
        vault.claimTail(sid);
        vm.stopPrank();
        vm.prank(keeper);
        window.processOrder(sid, b4);
        vm.prank(keeper);
        window.processOrder(sid, b1);
        assertEq(unitToken(sid).balanceOf(b1), 20);
        assertEq(unitToken(sid).balanceOf(b4), 10);

        // the 20 returned units: redemption price plus the tail they accrued before b1's tail claim
        uint256 before = usdc.balanceOf(b1);
        vm.prank(b1);
        vault.claimRedemption(sid);
        assertEq(usdc.balanceOf(b1) - before, 20 * price + l.tailAccWad * 20 / 1e18);
        assertEq(vault.claimableTail(sid, b1), 0);
        // the buyer (registered at its fill, after redemption) gets redemption and the whole tail of its units
        before = usdc.balanceOf(b4);
        vm.startPrank(b4);
        vault.claimRedemption(sid);
        vault.claimTail(sid);
        vm.stopPrank();
        assertEq(usdc.balanceOf(b4) - before, 10 * price + l.tailAccWad * 10 / 1e18);
        address[2] memory rest = [b2, b3];
        for (uint256 i = 0; i < 2; i++) {
            vm.startPrank(rest[i]);
            vault.claimRedemption(sid);
            vault.claimTail(sid);
            vm.stopPrank();
        }
        // everything owed was paid: only rounding dust remains
        assertLe(usdc.balanceOf(address(vault)), 10, "value stranded in the vault");
        assertEq(unitToken(sid).totalSupply(), 0);
    }
}
