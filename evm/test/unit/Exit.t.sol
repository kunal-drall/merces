// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {IMercesVault} from "../../src/interfaces/IMercesVault.sol";
import {IPayoutClaims} from "../../src/interfaces/IPayoutClaims.sol";
import {IMercesTreasury} from "../../src/interfaces/IMercesTreasury.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {SeriesStatus} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

/// @notice Redemption (C7), tail clause and extinguishment (C11 §6).
contract ExitTest is FullFixture {
    uint256 internal sid;
    uint64 internal constant LOCKUP = 47_336_400;
    uint64 internal constant YEAR = 31_536_000;

    function setUp() public override {
        super.setUp();
        sid = runStandardRaise();
    }

    function _redeem() internal returns (uint64 deposit) {
        (,,,, deposit) = vault.previewRedemption(sid, block.timestamp);
        fund(issuer, deposit);
        vm.startPrank(issuer);
        usdc.approve(address(vault), deposit);
        vault.redeem(sid);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ redemption guards

    function test_redeemGuards() public {
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        vault.redeem(sid);
        vm.prank(issuer);
        vm.expectRevert(LockupActive.selector);
        vault.redeem(sid);
        vm.warp(settlementTs(sid) + LOCKUP - 1);
        vm.prank(issuer);
        vm.expectRevert(LockupActive.selector);
        vault.redeem(sid);
        // the issuer must be current: an unpaid due blocks redemption (A15)
        submitReport(sid, Q1_2026, Proofs.q1());
        vm.warp(settlementTs(sid) + LOCKUP);
        vm.prank(issuer);
        vm.expectRevert(OutstandingDue.selector);
        vault.redeem(sid);
        payDue(sid, issuer);
        // a Draft series cannot be redeemed
        uint256 draft = createSeries(keccak256("d"));
        vm.prank(issuer);
        vm.expectRevert(NotSettled.selector);
        vault.redeem(draft);
    }

    // ------------------------------------------------------------ the three price terms

    function test_redeemHurdleDecides() public {
        // no payments, t = 2 years exactly: P_hurdle = floor(floor(100 × 1.08) × 1.08) = 116.64 USDC
        vm.warp(settlementTs(sid) + 2 * YEAR);
        (uint64 price, uint64 hurdle, uint64 dAvg, uint64 capRemaining, uint64 deposit) =
            vault.previewRedemption(sid, block.timestamp);
        assertEq(hurdle, 116_640_000);
        assertEq(dAvg, 0);
        assertEq(capRemaining, 250e6);
        assertEq(price, 116_640_000);
        assertEq(deposit, 116_640_000 * 300);
        fund(issuer, deposit);
        vm.startPrank(issuer);
        usdc.approve(address(vault), deposit);
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.SeriesRedeemed(sid, 116_640_000, 116_640_000, 0, 250e6, 300, uint64(116_640_000 * 300));
        vault.redeem(sid);
        vm.stopPrank();
        assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Redeemed));
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Redeemed));
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        assertEq(l.redemptionPrice, 116_640_000);
        assertEq(l.unitsAtRedemption, 300);
        assertEq(l.tailCapPerUnit, 250e6 - 116_640_000);
        assertEq(usdc.balanceOf(address(vault)), 116_640_000 * 300);
        // holders claim the redemption; units burn; no fee
        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.RedemptionClaimed(sid, b1, 100, 116_640_000 * 100);
        vault.claimRedemption(sid);
        assertEq(usdc.balanceOf(b1), 116_640_000 * 100);
        assertEq(unitToken(sid).balanceOf(b1), 0);
        assertEq(vault.getHolder(sid, b1).redeemedUnits, 100);
        vm.prank(keeper);
        vault.claimRedemptionFor(sid, b2);
        assertEq(usdc.balanceOf(b2), 116_640_000 * 100);
        vm.prank(b1);
        vm.expectRevert(NothingToClaim.selector);
        vault.claimRedemption(sid);
        // the series cannot be redeemed twice, reports without a liquidity event are refused
        vm.prank(issuer);
        vm.expectRevert(SeriesTerminal.selector);
        vault.redeem(sid);
        assertEq(usdc.balanceOf(address(feeCollector)), 300e6); // only the auction fees
    }

    function test_redeemPayoutMultipleDecides() public {
        // one 12,000 payment in year 0 (40 USDC/unit); at t = lockup: Y = 1, D_avg = 40, k × D = 200,
        // hurdle = 112.328876, C_rem = 210 → price 200
        reportAndPay(sid, Q1_2026, Proofs.q1());
        vm.warp(settlementTs(sid) + LOCKUP);
        (uint64 price, uint64 hurdle, uint64 dAvg, uint64 capRemaining,) = vault.previewRedemption(sid, block.timestamp);
        assertEq(hurdle, 112_328_876);
        assertEq(dAvg, 40e6);
        assertEq(capRemaining, 210e6);
        assertEq(price, 200e6);
        uint64 deposit = _redeem();
        assertEq(deposit, 200e6 * 300);
        assertEq(vault.getLedger(sid).tailCapPerUnit, 10e6);
        // claim = pending payouts + redemption
        assertEq(vault.pendingOf(sid, b1), 3_800e6);
        vm.prank(b1);
        vault.claimRedemption(sid);
        assertEq(usdc.balanceOf(b1), 3_800e6 + 200e6 * 100);
    }

    function test_redeemCapRemainingDecides() public {
        reportAndPay(sid, Q1_2026, Proofs.q1());
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        reportAndPay(sid, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(sid, Q1_2026 + 3, Proofs.q4()); // 220 USDC/unit paid
        vm.warp(settlementTs(sid) + LOCKUP);
        (uint64 price,,, uint64 capRemaining,) = vault.previewRedemption(sid, block.timestamp);
        assertEq(capRemaining, 30e6);
        assertEq(price, 30e6);
        _redeem();
        assertEq(vault.getLedger(sid).tailCapPerUnit, 0);
        // no tail is due when P_redeem == C_remaining
        vm.warp(Periods.periodEnd(Q1_2026 + 4));
        vm.prank(issuer);
        vm.expectRevert(NoTailDue.selector);
        income.submitReport(reportInput(sid, Q1_2026 + 4, Proofs.y2q1(), 2, true));
    }

    function test_paidUnitsRoundUpAgainstHolders() public {
        // 1 wei of gross over 300 units → paid_per_unit_wad = 3.33e15 → ceil → 1 unit of cap consumed
        uint256 s = runStandardRaise(1 | 2, bytes32(0));
        vm.prank(issuer);
        income.setRouterTerms(s, 0, 1e15);
        fund(keeper, 4);
        vm.startPrank(keeper);
        usdc.approve(address(income), 4);
        income.route(s, 4); // share = floor(0.3 × 4) = 1
        vm.stopPrank();
        assertEq(vault.getLedger(s).paidPerUnitWad, uint256(1e18) / 300);
        vm.warp(settlementTs(s) + LOCKUP);
        (,,, uint64 capRemaining,) = vault.previewRedemption(s, block.timestamp);
        assertEq(capRemaining, 250e6 - 1);
    }

    // ------------------------------------------------------------ tail clause

    function test_tailPayoutAfterRedemption() public {
        reportAndPay(sid, Q1_2026, Proofs.q1());
        vm.warp(settlementTs(sid) + LOCKUP); // ~Jul 2027, Q3 2027 = period 8110
        _redeem(); // price 200, tail cap 10 USDC/unit → 3,000 total
        // b1 claims redemption now (records 100 redeemed units); b2 and b3 wait
        vm.prank(b1);
        vault.claimRedemption(sid);
        // next expected period is Q2 2026 (8105): reports stay sequential; only liquidity-event reports count
        vm.warp(Periods.periodEnd(Q1_2026 + 1));
        vm.prank(issuer);
        vm.expectRevert(LiquidityEventRequired.selector);
        income.submitReport(reportInput(sid, Q1_2026 + 1, Proofs.q2(), 2, false));
        // liquidity event: q2 proves a 12,000 payment; the tail cap only has room for 3,000
        vm.prank(issuer);
        income.submitReport(reportInput(sid, Q1_2026 + 1, Proofs.q2(), 2, true));
        (uint64 due,) = income.openDue(sid);
        assertEq(due, 12_000e6);
        uint256 issuerBefore = usdc.balanceOf(issuer);
        fund(issuer, 12_000e6);
        vm.startPrank(issuer);
        usdc.approve(address(income), 12_000e6);
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.TailDistributed(sid, Q1_2026 + 1, 12_000e6, 3_000e6, 150e6, 9_000e6);
        income.pay(sid);
        vm.stopPrank();
        assertEq(usdc.balanceOf(issuer), issuerBefore + 9_000e6);
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        assertEq(l.tailPaidPerUnitWad, 10e6 * 1e18);
        assertEq(l.tailAccWad, 9.5e6 * 1e18); // 2,850 net / 300
        // b1 (claimed redemption first) and b2 (claims redemption now) both get 950 USDC of tail
        assertEq(vault.claimableTail(sid, b1), 950e6);
        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.TailClaimed(sid, b1, 950e6);
        vault.claimTail(sid);
        vm.prank(b2);
        vm.expectRevert(NothingToClaim.selector); // no redeemed units recorded yet
        vault.claimTail(sid);
        vm.prank(b2);
        vault.claimRedemption(sid);
        vm.prank(b2);
        vault.claimTail(sid);
        assertEq(usdc.balanceOf(b2), 3_800e6 + 200e6 * 100 + 950e6);
        // the tail cap is exhausted: further tail reports are accepted but fully refunded
        vm.warp(Periods.periodEnd(Q1_2026 + 2));
        vm.prank(issuer);
        income.submitReport(reportInput(sid, Q1_2026 + 2, Proofs.q3zero(), 2, true)); // zero payment, complete
        // tail window closes 12 months after redemption
        vm.warp(vault.getLedger(sid).redemptionTs + 31_536_000 + 1);
        vm.prank(issuer);
        vm.expectRevert(TailWindowClosed.selector);
        income.submitReport(reportInput(sid, Q1_2026 + 3, Proofs.q4(), 2, true));
    }

    // ------------------------------------------------------------ extinguishment

    function test_extinguishDistributesUnreleasedTreasury() public {
        reportAndPay(sid, Q1_2026, Proofs.q1());
        submitReport(sid, Q1_2026 + 1, Proofs.q2()); // leaves a 12,000 due open
        // treasury: 30,000 proceeds; two tranches (15,000) have vested by Q2's end and are released
        vm.prank(issuer);
        treasury.claimRelease(sid);
        assertEq(treasury.getTreasury(sid).releasedTotal, 15_000e6);
        (bytes memory a, bytes memory b) = extinguishSigs(sid, 0);
        // guards
        vm.expectRevert(DuplicateAttestor.selector);
        vault.extinguish(sid, a, a);
        bytes32 d = MercesMessages.extinguishDigest(domain, sid, 0);
        vm.expectRevert(abi.encodeWithSelector(AttestorNotRegistered.selector, vm.addr(0xDEAD)));
        vault.extinguish(sid, a, sign(0xDEAD, d));
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.SeriesExtinguished(sid, 15_000e6, attestor, attestor2);
        vault.extinguish(sid, a, b);
        assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Extinguished));
        // dues cleared; nothing else is owed
        (uint64 due,) = income.openDue(sid);
        assertEq(due, 0);
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        assertEq(l.unreleasedReceived, 15_000e6);
        assertEq(l.finalAccWad, 50e6 * 1e18); // 15,000 / 300, no fee
        assertEq(usdc.balanceOf(address(treasury)), 0);
        assertEq(treasury.getTreasury(sid).releasedTotal, 30_000e6);
        // signatures cannot be replayed (nonce moved on, series terminal)
        vm.expectRevert(SeriesTerminal.selector);
        vault.extinguish(sid, a, b);
        // holders claim pending payouts + their share of the unreleased funds; units burn
        assertEq(vault.claimableFinal(sid, b1), 5_000e6);
        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.FinalClaimed(sid, b1, 100, 3_800e6 + 5_000e6);
        vault.claimFinal(sid);
        assertEq(unitToken(sid).balanceOf(b1), 0);
        vm.prank(keeper);
        vault.claimFinalFor(sid, b2);
        vm.prank(b3);
        vault.claimFinal(sid);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(unitToken(sid).totalSupply(), 0);
        // releases, reports and redemption are over
        vm.prank(issuer);
        vm.expectRevert(SeriesIsExtinguished.selector);
        treasury.claimRelease(sid);
        vm.warp(Periods.periodEnd(Q1_2026 + 2));
        vm.prank(issuer);
        vm.expectRevert(ReportsClosed.selector);
        income.submitReport(reportInput(sid, Q1_2026 + 2, Proofs.q3zero(), 2, false));
    }

    function test_extinguishAfterRedemptionWithinTail() public {
        reportAndPay(sid, Q1_2026, Proofs.q1());
        vm.warp(settlementTs(sid) + LOCKUP);
        _redeem(); // price 200
        vm.prank(b1);
        vault.claimRedemption(sid); // b1 already out; b2, b3 still hold
        // treasury fully vested by now? schedule ends at 270 days → everything released already if claimed
        vm.prank(issuer);
        treasury.claimRelease(sid);
        assertEq(treasury.getTreasury(sid).releasedTotal, 30_000e6);
        (bytes memory a, bytes memory b) = extinguishSigs(sid, 0);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.SeriesExtinguished(sid, 0, attestor, attestor2);
        vault.extinguish(sid, a, b);
        assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Extinguished));
        // b2 has not claimed redemption: claimFinal pays pending + redemption and burns
        vm.prank(b2);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.FinalClaimed(sid, b2, 100, 3_800e6 + 200e6 * 100);
        vault.claimFinal(sid);
        assertEq(unitToken(sid).balanceOf(b2), 0);
        // b1 already claimed everything: nothing left
        vm.prank(b1);
        vm.expectRevert(NothingToClaim.selector);
        vault.claimFinal(sid);
        // past the tail window a redeemed series can no longer be extinguished
        uint256 s2 = runStandardRaise();
        vm.warp(settlementTs(s2) + LOCKUP);
        fund(issuer, 1e12);
        vm.startPrank(issuer);
        usdc.approve(address(vault), 1e12);
        vault.redeem(s2);
        vm.stopPrank();
        vm.warp(block.timestamp + 31_536_000 + 1);
        (a, b) = extinguishSigs(s2, 0);
        vm.expectRevert(TailWindowClosed.selector);
        vault.extinguish(s2, a, b);
    }

    function test_retiredSeriesCannotBeExtinguished() public {
        reportAndPay(sid, Q1_2026, Proofs.q1());
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        reportAndPay(sid, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(sid, Q1_2026 + 3, Proofs.q4());
        reportAndPay(sid, Q1_2026 + 4, Proofs.y2q1());
        reportAndPay(sid, Q1_2026 + 5, Proofs.y2q2cap());
        (bytes memory a, bytes memory b) = extinguishSigs(sid, 0);
        vm.expectRevert(SeriesTerminal.selector);
        vault.extinguish(sid, a, b);
    }
}
