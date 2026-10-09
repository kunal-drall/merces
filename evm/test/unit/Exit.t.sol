// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {IMercesVault} from "../../src/interfaces/IMercesVault.sol";
import {IPayoutClaims} from "../../src/interfaces/IPayoutClaims.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {SeriesStatus, TierFlags} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

/// @notice Redemption (C7), tail clause and extinguishment (C11 §6), SPEC v1.1 §6.7–§6.9.
contract ExitTest is FullFixture {
    uint8 internal constant FLAGS = TierFlags.TIER2_ZKTLS | TierFlags.TIER3_ATTESTOR;
    uint64 internal constant LOCKUP = 47_336_400;
    uint64 internal constant YEAR = 31_536_000;

    function _redeem(uint256 s) internal returns (uint64 deposit) {
        (,,,, deposit) = vault.previewRedemption(s, vm.getBlockTimestamp());
        fund(issuer, deposit);
        vm.startPrank(issuer);
        usdc.approve(address(vault), deposit);
        vault.redeem(s);
        vm.stopPrank();
    }

    /// @dev Standard raise with no lockup at P0 = `reserve`.
    function _openSeries(uint64 reserve) internal returns (uint256) {
        return runStandardRaise(FLAGS, bytes32(0), Proofs.q1().termsCommitment, reserve, 0);
    }

    function _payYear2026(uint256 s) internal {
        reportAndPay(s, Q1_2026, Proofs.q1());
        reportAndPay(s, Q1_2026 + 1, Proofs.q2());
        reportAndPay(s, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(s, Q1_2026 + 3, Proofs.q4()); // 66,000 gross → 220 USDC/unit
    }

    // ------------------------------------------------------------ redemption gate

    function test_redeemGuards() public {
        uint256 sid = runStandardRaise();
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        vault.redeem(sid);
        vm.prank(issuer);
        vm.expectRevert(LockupActive.selector);
        vault.redeem(sid);
        // Late (nothing reported) is checked before the lockup, as in the reference
        vm.warp(settlementTs(sid) + LOCKUP - 1);
        vm.prank(issuer);
        vm.expectRevert(SeriesLate.selector);
        vault.redeem(sid);
        uint256 draft = createSeries(keccak256("d"));
        vm.prank(issuer);
        vm.expectRevert(RaiseNotSettled.selector);
        vault.redeem(draft);
        // after the lockup with nothing reported the series is Late: redemption waits for the issuer's own
        // obligations (A15)
        vm.warp(settlementTs(sid) + LOCKUP);
        vm.prank(issuer);
        vm.expectRevert(SeriesLate.selector);
        vault.redeem(sid);
    }

    function test_redeemRequiresDuesPaidAndPeriodsReported() public {
        uint256 s = _openSeries(P0);
        submitReport(s, Q1_2026, Proofs.q1()); // open due
        vm.prank(issuer);
        vm.expectRevert(PaymentOutstanding.selector);
        vault.redeem(s);
        payDue(s, issuer);
        // Q2 ends: it must be reported before redeeming, even while still OnTime
        vm.warp(Periods.periodEnd(Q1_2026 + 1));
        assertEq(uint8(income.deriveStatus(s)), uint8(SeriesStatus.OnTime));
        vm.prank(issuer);
        vm.expectRevert(UnreportedPeriods.selector);
        vault.redeem(s);
        reportAndPay(s, Q1_2026 + 1, Proofs.q2());
        _redeem(s);
        assertEq(registry.getSeriesCore(s).terminalStatus, uint8(SeriesStatus.Redeemed));
    }

    // ------------------------------------------------------------ the three price terms

    function test_redeemHurdleDecides() public {
        uint256 s = _openSeries(P0);
        // no payments, t = 73 days = 0.2 year: P_hurdle = floor(100 × (1 + 0.08 × 0.2)) = 101.6 USDC
        vm.warp(settlementTs(s) + 73 days);
        (uint64 price, uint64 hurdle, uint64 dAvg, uint64 capRemaining, uint64 deposit) =
            vault.previewRedemption(s, vm.getBlockTimestamp());
        assertEq(hurdle, 101_600_000);
        assertEq(dAvg, 0);
        assertEq(capRemaining, 250e6);
        assertEq(price, 101_600_000);
        assertEq(deposit, 101_600_000 * 300);
        fund(issuer, deposit);
        vm.startPrank(issuer);
        usdc.approve(address(vault), deposit);
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.SeriesRedeemed(s, 101_600_000, 101_600_000, 0, 250e6, 300, uint64(101_600_000 * 300));
        vault.redeem(s);
        vm.stopPrank();
        assertEq(registry.getSeriesCore(s).terminalStatus, uint8(SeriesStatus.Redeemed));
        assertEq(uint8(income.deriveStatus(s)), uint8(SeriesStatus.Redeemed));
        IMercesVault.Ledger memory l = vault.getLedger(s);
        assertEq(l.redemptionPrice, 101_600_000);
        assertEq(l.unitsAtRedemption, 300);
        assertEq(l.tailCapPerUnit, 250e6 - 101_600_000);
        assertEq(usdc.balanceOf(address(vault)), 101_600_000 * 300);
        // holders claim the redemption; units burn; no fee
        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.RedemptionClaimed(s, b1, 100, 101_600_000 * 100);
        vault.claimRedemption(s);
        assertEq(usdc.balanceOf(b1), 101_600_000 * 100);
        assertEq(unitToken(s).balanceOf(b1), 0);
        assertEq(vault.getHolder(s, b1).redeemedUnits, 100);
        assertEq(vault.unitsOutstanding(s), 200);
        vm.prank(keeper);
        vault.claimRedemptionFor(s, b2);
        assertEq(usdc.balanceOf(b2), 101_600_000 * 100);
        // a second claim is a no-op (zero-amount rule)
        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.RedemptionClaimed(s, b1, 0, 0);
        vault.claimRedemption(s);
        vm.prank(issuer);
        vm.expectRevert(TerminalStatus.selector);
        vault.redeem(s);
        assertEq(usdc.balanceOf(address(feeCollector)), 300e6); // only the auction fees
    }

    function test_redeemPayoutMultipleDecides() public {
        // P0 = 300: cap 750; year-0 gross 80/unit (Q4's due date falls in year 1) → k × D_avg = 400 > hurdle 324
        uint256 s = _openSeries(300e6);
        _payYear2026(s);
        vm.warp(settlementTs(s) + YEAR);
        (uint64 price, uint64 hurdle, uint64 dAvg, uint64 capRemaining,) =
            vault.previewRedemption(s, vm.getBlockTimestamp());
        assertEq(hurdle, 324e6);
        assertEq(dAvg, 80e6);
        assertEq(capRemaining, 530e6);
        assertEq(price, 400e6);
        uint64 deposit = _redeem(s);
        assertEq(deposit, 400e6 * 300);
        assertEq(vault.getLedger(s).tailCapPerUnit, 130e6);
        // claim = pending payouts + redemption
        assertEq(vault.pendingOf(s, b1), 20_900e6);
        vm.prank(b1);
        vault.claimRedemption(s);
        assertEq(usdc.balanceOf(b1), 20_900e6 + 400e6 * 100);
    }

    function test_redeemCapRemainingDecides() public {
        uint256 s = _openSeries(P0);
        _payYear2026(s); // 220 USDC/unit paid of a 250 cap
        vm.warp(settlementTs(s) + YEAR);
        (uint64 price, uint64 hurdle,, uint64 capRemaining,) = vault.previewRedemption(s, vm.getBlockTimestamp());
        assertEq(hurdle, 108e6);
        assertEq(capRemaining, 30e6);
        assertEq(price, 30e6);
        _redeem(s);
        assertEq(vault.getLedger(s).tailCapPerUnit, 0);
        // nothing is owed under the tail when P_redeem == C_remaining
        vm.warp(Periods.periodEnd(Q1_2026 + 4));
        vm.prank(issuer);
        vm.expectRevert(NoTailDue.selector);
        income.submitReport(reportInput(s, Q1_2026 + 4, Proofs.y2q1(), 2, true));
    }

    function test_paidUnitsRoundUpAgainstHolders() public {
        // 1 base unit of gross over 300 units → paid_per_unit_wad = 3.33e15 → ceil → 1 unit of cap consumed
        uint256 s = runStandardRaise(TierFlags.TIER1_SPLIT, bytes32(0));
        fund(keeper, 80_000e6 + 4);
        vm.startPrank(keeper);
        usdc.approve(address(router), 80_000e6 + 4);
        router.route(s, 80_000e6); // θ
        router.route(s, 4); // share = floor(0.3 × 4) = 1
        vm.stopPrank();
        assertEq(vault.getLedger(s).paidPerUnitWad, uint256(1e18) / 300);
        (,,, uint64 capRemaining,) = vault.previewRedemption(s, vm.getBlockTimestamp());
        assertEq(capRemaining, 250e6 - 1);
    }

    // ------------------------------------------------------------ tail clause

    function test_tailPayoutAfterRedemption() public {
        uint256 s = _openSeries(300e6);
        _payYear2026(s);
        vm.warp(settlementTs(s) + YEAR); // 2027-01-10, Q1 2027
        _redeem(s); // price 400, tail cap 130/unit → 39,000 in total
        vm.prank(b1);
        vault.claimRedemption(s); // b1 records 100 redeemed units; b2 and b3 wait
        // Q1 2027 report: a non-liquidity tail report only advances the chain (due 0)
        vm.warp(Periods.periodEnd(Q1_2026 + 4));
        vm.prank(issuer);
        vm.expectEmit(true, true, false, true);
        emit IMercesIncome.PaymentSettled(s, Q1_2026 + 4, 0, 0, 0, 0, 0);
        income.submitReport(reportInput(s, Q1_2026 + 4, Proofs.y2q1(), 2, false));
        assertEq(income.getReport(s, Q1_2026 + 4).due, 0);
        // Q2 2027 liquidity event: 30,000 proven, 33,000 of tail room → accepted in full
        vm.warp(Periods.periodEnd(Q1_2026 + 5));
        vm.prank(issuer);
        income.submitReport(reportInput(s, Q1_2026 + 5, Proofs.y2q2cap(), 2, true));
        (uint64 due,) = income.openDue(s);
        assertEq(due, 30_000e6);
        // paid long after the deadline: no accrual while Redeemed
        vm.warp(vm.getBlockTimestamp() + 200 days);
        assertEq(uint8(income.deriveStatus(s)), uint8(SeriesStatus.Redeemed));
        fund(issuer, 30_000e6);
        vm.startPrank(issuer);
        usdc.approve(address(income), 30_000e6);
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.TailDistributed(s, Q1_2026 + 5, 30_000e6, 30_000e6, 1_500e6, 0);
        vm.expectEmit(true, true, false, true);
        emit IMercesIncome.PaymentSettled(s, Q1_2026 + 5, 30_000e6, 0, 1_500e6, 30_000e6, 0);
        income.pay(s);
        vm.stopPrank();
        IMercesVault.Ledger memory l = vault.getLedger(s);
        assertEq(l.tailPaidPerUnitWad, 100e6 * 1e18);
        assertEq(l.tailAccWad, 95e6 * 1e18); // 28,500 net / 300
        assertEq(l.tailCarryWad, 0);
        assertFalse(l.tailExhausted);
        // b1 (redeemed first) and b2 (redeems now) both get 9,500 of tail
        assertEq(vault.claimableTail(s, b1), 9_500e6);
        assertEq(vault.claimableTail(s, b2), 9_500e6);
        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.TailClaimed(s, b1, 9_500e6);
        vault.claimTail(s);
        vm.prank(b2);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.RedemptionClaimed(s, b2, 100, 20_900e6 + 40_000e6);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.TailClaimed(s, b2, 9_500e6);
        vault.claimTail(s);
        assertEq(usdc.balanceOf(b2), 20_900e6 + 40_000e6 + 9_500e6);
        assertEq(unitToken(s).balanceOf(b2), 0);
    }

    /// @dev S7: a non-liquidity tail report (due forced to 0) must not consume router credit, or a later tail
    /// liquidity event would double-charge the issuer. The credit survives the non-liquidity report and is
    /// applied exactly once at the liquidity event.
    function test_nonLiquidityTailReportDoesNotBurnRouterCredit() public {
        uint256 s = _openSeries(300e6);
        _payYear2026(s); // now at 2027-01-01, year 2026 fully reported
        // a negative true-up for 2026 credits 3,000 forward (trueup_due stays 0, so it never blocks redemption)
        uint64 ts = uint64(vm.getBlockTimestamp());
        vm.prank(issuer);
        income.submitTrueUp(s, 2026, -3_000e6, ts, trueupSig(s, 0, 2026, -3_000e6, ts));
        assertEq(income.getLedger(s).routerCredit, 3_000e6);

        vm.warp(settlementTs(s) + YEAR);
        _redeem(s);
        // Q1 2027: a non-liquidity tail report with payment_usd = 6,000 — due is forced to 0 and the credit is left
        vm.warp(Periods.periodEnd(Q1_2026 + 4));
        vm.prank(issuer);
        income.submitReport(reportInput(s, Q1_2026 + 4, Proofs.y2q1(), 2, false));
        assertEq(income.getReport(s, Q1_2026 + 4).due, 0);
        assertEq(income.getLedger(s).routerCredit, 3_000e6, "router credit burned on a non-liquidity tail report");
        // Q2 2027 liquidity event proving 30,000: the credit is applied once → due 27,000
        vm.warp(Periods.periodEnd(Q1_2026 + 5));
        vm.prank(issuer);
        income.submitReport(reportInput(s, Q1_2026 + 5, Proofs.y2q2cap(), 2, true));
        (uint64 due,) = income.openDue(s);
        assertEq(due, 27_000e6);
        assertEq(income.getLedger(s).routerCredit, 0);
    }

    function test_tailExhaustionTruncatesAndCloses() public {
        uint256 s = _openSeries(300e6);
        _payYear2026(s);
        vm.warp(settlementTs(s) + YEAR);
        _redeem(s); // tail cap 130/unit → 39,000
        // Q1 2027 liquidity event proving 126,000: only 39,000 fit, the rest returns to the issuer
        vm.warp(Periods.periodEnd(Q1_2026 + 4));
        vm.prank(issuer);
        income.submitReport(reportInput(s, Q1_2026 + 4, Proofs.tail(), 2, true));
        uint256 issuerBefore = usdc.balanceOf(issuer);
        fund(issuer, 126_000e6);
        vm.startPrank(issuer);
        usdc.approve(address(income), 126_000e6);
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.TailDistributed(s, Q1_2026 + 4, 126_000e6, 39_000e6, 1_950e6, 87_000e6);
        income.pay(s);
        vm.stopPrank();
        assertEq(usdc.balanceOf(issuer), issuerBefore + 87_000e6);
        IMercesVault.Ledger memory l = vault.getLedger(s);
        assertTrue(l.tailExhausted);
        assertEq(l.tailPaidPerUnitWad, 130e6 * 1e18);
        assertEq(l.tailAccWad, 123.5e6 * 1e18); // 37,050 net / 300
        // further liquidity-event reports are refused; the chain may still advance with due 0
        vm.warp(Periods.periodEnd(Q1_2026 + 5));
        vm.prank(issuer);
        vm.expectRevert(NoTailDue.selector);
        income.submitReport(reportInput(s, Q1_2026 + 5, Proofs.y2q2cap(), 2, true));
        vm.prank(b3);
        vault.claimTail(s); // redeems and takes the tail in one go
        assertEq(usdc.balanceOf(b3), 20_900e6 + 40_000e6 + 12_350e6);
    }

    // ------------------------------------------------------------ extinguishment

    function test_extinguishDistributesUnreleasedTreasury() public {
        uint256 sid = runStandardRaise();
        reportAndPay(sid, Q1_2026, Proofs.q1());
        submitReport(sid, Q1_2026 + 1, Proofs.q2()); // leaves a 12,000 due open
        // treasury: 30,000 proceeds; two tranches (15,000) have vested by Q2's end and are released
        vm.prank(issuer);
        treasury.claimRelease(sid);
        assertEq(treasury.getTreasury(sid).releasedTotal, 15_000e6);
        (bytes memory a, bytes memory b) = extinguishSigs(sid, 0);
        vm.expectRevert(SameAttestor.selector);
        vault.extinguish(sid, a, a);
        bytes32 dg = MercesMessages.extinguishDigest(domain, sid, 0);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestorSignature.selector, vm.addr(0xDEAD)));
        vault.extinguish(sid, a, sign(0xDEAD, dg));
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.SeriesExtinguished(sid, 15_000e6, attestor, attestor2);
        vault.extinguish(sid, a, b);
        assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Extinguished));
        (uint64 due,) = income.openDue(sid);
        assertEq(due, 0); // dues cleared; nothing else is owed
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        assertEq(l.unreleasedReceived, 15_000e6);
        assertEq(l.finalUnits, 300);
        assertEq(l.finalAccWad, 50e6 * 1e18); // 15,000 / 300, no fee
        assertEq(l.extinguishedAt, vm.getBlockTimestamp());
        assertEq(usdc.balanceOf(address(treasury)), 0);
        vm.expectRevert(); // no replay: the nonce moved on, the old signatures recover strangers
        vault.extinguish(sid, a, b);
        (bytes memory a2, bytes memory b2sig) = extinguishSigs(sid, 1);
        vm.expectRevert(TerminalStatus.selector); // and no second extinguishment
        vault.extinguish(sid, a2, b2sig);
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
        assertEq(vault.unitsOutstanding(sid), 0);
        // releases, reports and redemption are over; the estate keeps what had vested
        vm.warp(vm.getBlockTimestamp() + 365 days);
        vm.prank(issuer);
        vm.expectRevert(NothingVested.selector);
        treasury.claimRelease(sid);
        vm.prank(issuer);
        vm.expectRevert(TerminalStatus.selector);
        income.submitReport(reportInput(sid, Q1_2026 + 2, Proofs.q3zero(), 2, false));
        vm.prank(issuer);
        vm.expectRevert(TerminalStatus.selector);
        vault.redeem(sid);
    }

    function test_extinguishAfterRedemptionAtAnyTime() public {
        uint256 s = _openSeries(P0);
        vm.warp(settlementTs(s) + 73 days);
        _redeem(s); // price 101.6
        vm.prank(b1);
        vault.claimRedemption(s); // b1 already out; b2, b3 still hold
        // first tranche vested (7,500) but unclaimed: it stays with the issuer's estate
        (bytes memory a, bytes memory b) = extinguishSigs(s, 0);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.SeriesExtinguished(s, 22_500e6, attestor, attestor2);
        vault.extinguish(s, a, b);
        assertEq(registry.getSeriesCore(s).terminalStatus, uint8(SeriesStatus.Extinguished));
        assertEq(vault.getLedger(s).finalUnits, 300); // units at redemption
        assertEq(vault.getLedger(s).finalAccWad, 75e6 * 1e18);
        // b2 has not claimed redemption: claimFinal pays the redemption, the final share and burns
        vm.prank(b2);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.RedemptionClaimed(s, b2, 100, 101_600_000 * 100);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.FinalClaimed(s, b2, 100, 7_500e6); // the redemption was paid by its own claim
        vault.claimFinal(s);
        assertEq(unitToken(s).balanceOf(b2), 0);
        // b1 already redeemed: only the final share, weighted by its redeemed units
        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.FinalClaimed(s, b1, 100, 7_500e6);
        vault.claimFinal(s);
        vm.prank(b3);
        vault.claimFinal(s);
        assertEq(usdc.balanceOf(address(vault)), 0);
        // the issuer's estate: the vested tranche, then nothing more ever
        vm.prank(issuer);
        treasury.claimRelease(s);
        assertEq(usdc.balanceOf(issuer), 7_500e6);
        vm.warp(vm.getBlockTimestamp() + 2 * YEAR);
        vm.prank(issuer);
        vm.expectRevert(NothingVested.selector);
        treasury.claimRelease(s);
        // tail reports are over
        vm.prank(issuer);
        vm.expectRevert(TerminalStatus.selector);
        income.submitReport(reportInput(s, Q1_2026, Proofs.q1(), 2, true));
    }

    function test_extinguishRetiredSeries() public {
        uint256 sid = runStandardRaise();
        _payYear2026(sid);
        reportAndPay(sid, Q1_2026 + 4, Proofs.y2q1());
        reportAndPay(sid, Q1_2026 + 5, Proofs.y2q2cap()); // retired
        assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Retired));
        vm.prank(keeper);
        vault.burnRetired(sid, b1); // b1 has burnt already: weight 0 in the final distribution
        (bytes memory a, bytes memory b) = extinguishSigs(sid, 0);
        // everything has vested by now and the issuer never claimed: the estate keeps it all
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.SeriesExtinguished(sid, 0, attestor, attestor2);
        vault.extinguish(sid, a, b);
        assertEq(vault.getLedger(sid).finalUnits, 200);
        assertEq(vault.getLedger(sid).finalAccWad, 0);
        vm.prank(issuer);
        treasury.claimRelease(sid);
        assertEq(usdc.balanceOf(issuer) >= 30_000e6, true);
        // holders still collect their pending payouts through claimFinal (or claim)
        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.FinalClaimed(sid, b1, 0, 23_750e6);
        vault.claimFinal(sid);
        vm.prank(b2);
        vault.claim(sid);
        assertEq(usdc.balanceOf(b2), 23_750e6);
        assertEq(unitToken(sid).balanceOf(b2), 100); // `claim` burns only while Retired
        vm.prank(b2);
        vault.claimFinal(sid);
        assertEq(unitToken(sid).balanceOf(b2), 0);
    }

    function test_extinguishRequiresFinalizedMint() public {
        uint256 draft = createSeries(keccak256("d"));
        (bytes memory a, bytes memory b) = extinguishSigs(draft, 0);
        vm.expectRevert(RaiseNotSettled.selector);
        vault.extinguish(draft, a, b);
        // settled but not yet mint-finalized
        uint256 s = standardSeries(TierFlags.TIER2_ZKTLS, bytes32(0));
        allow(b1);
        allow(b2);
        openRaise(s);
        commit(s, plan(b1, P0, 100, escrowFor(P0, 100)));
        commit(s, plan(b2, P0, 100, escrowFor(P0, 100)));
        warpToReveal(s);
        reveal(s, plan(b1, P0, 100, escrowFor(P0, 100)));
        reveal(s, plan(b2, P0, 100, escrowFor(P0, 100)));
        warpToSettle(s);
        settle(s, P0, 0, 200); // 20,000 USDC = min raise → Settled
        (a, b) = extinguishSigs(s, 0);
        vm.expectRevert(MintNotFinalized.selector);
        vault.extinguish(s, a, b);
    }
}
