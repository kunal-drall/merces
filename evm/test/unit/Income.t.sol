// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {IMercesVault} from "../../src/interfaces/IMercesVault.sol";
import {IPayoutClaims} from "../../src/interfaces/IPayoutClaims.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {PayoutSource, SeriesStatus, TierFlags} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

contract IncomeTest is FullFixture {
    uint256 internal sid;
    uint64 internal constant Q1_END = 1_775_001_600; // 2026-04-01
    uint64 internal constant DAY = 86_400;

    function setUp() public override {
        super.setUp();
        sid = runStandardRaise();
        assertEq(unitToken(sid).totalSupply(), 300);
        assertEq(registry.getSeriesCore(sid).clearingPrice, P0);
    }

    // ------------------------------------------------------------ happy path

    function test_reportPayClaimHappyPath() public {
        vm.warp(Q1_END);
        Proofs.Proof memory p = Proofs.q1();
        IMercesIncome.ReportInput memory r = reportInput(sid, Q1_2026, p, 2, false);
        vm.prank(issuer);
        vm.expectEmit(true, true, false, true);
        emit IMercesIncome.ReportAccepted(sid, Q1_2026, 12_000e6, 1e18, false, 2, false, p.incomeCommitment, 12_000e6);
        income.submitReport(r);
        (uint64 due, uint32 duePeriod) = income.openDue(sid);
        assertEq(due, 12_000e6);
        assertEq(duePeriod, Q1_2026);
        IMercesIncome.Report memory rep = income.getReport(sid, Q1_2026);
        assertTrue(rep.exists);
        assertEq(rep.paymentUsd, 12_000e6);
        assertEq(rep.due, 12_000e6);
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.OnTime));

        // anyone may pay on the issuer's behalf; funds come from the payer
        fund(keeper, 12_000e6);
        vm.startPrank(keeper);
        usdc.approve(address(income), 12_000e6);
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.PayoutDistributed(
            sid, PayoutSource.Payment, 12_000e6, 12_000e6, 600e6, 11_400e6, 38e6 * 1e18, 40e6 * 1e18, false
        );
        vm.expectEmit(true, true, false, true);
        emit IMercesIncome.PaymentSettled(sid, Q1_2026, 12_000e6, 0, 600e6, 12_000e6, 0);
        income.pay(sid);
        vm.stopPrank();
        (due,) = income.openDue(sid);
        assertEq(due, 0);
        (bool hasPaid, uint32 lastPaid) = income.lastPaidPeriod(sid);
        assertTrue(hasPaid);
        assertEq(lastPaid, Q1_2026);
        assertEq(usdc.balanceOf(address(vault)), 11_400e6);
        assertEq(usdc.balanceOf(address(feeCollector)), 300e6 + 600e6); // auction fees + payout fee
        IMercesVault.Ledger memory vl = vault.getLedger(sid);
        assertEq(vl.paidPerUnitWad, 40e6 * 1e18);
        assertEq(vl.netAccWad, 38e6 * 1e18);
        assertEq(vl.carry, 0);
        assertEq(vl.feeCollected, 600e6);
        assertEq(vl.grossReceived, 12_000e6);
        assertEq(vault.yearGrossWad(sid, 0), 40e6 * 1e18);

        // holders claim pro rata; each holds 100 of 300 units
        assertEq(vault.pendingOf(sid, b1), 3_800e6);
        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.PayoutClaimed(sid, b1, 3_800e6, 0);
        vault.claim(sid);
        assertEq(usdc.balanceOf(b1), 3_800e6);
        vm.prank(keeper);
        vault.claimFor(sid, b2); // keeper pushes to the holder's own address
        assertEq(usdc.balanceOf(b2), 3_800e6);
        assertEq(usdc.balanceOf(keeper), 0);
        vm.prank(b1);
        vm.expectRevert(NothingToClaim.selector);
        vault.claim(sid);
        // a de-allowlisted holder can still claim (no stranding)
        disallow(b3);
        vm.prank(b3);
        vault.claim(sid);
        assertEq(usdc.balanceOf(b3), 3_800e6);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_zeroPaymentQuarterIsComplete() public {
        reportAndPay(sid, Q1_2026, Proofs.q1());
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        vm.warp(Periods.periodEnd(Q1_2026 + 2));
        IMercesIncome.ReportInput memory r = reportInput(sid, Q1_2026 + 2, Proofs.q3zero(), 2, false);
        vm.prank(issuer);
        vm.expectEmit(true, true, false, true);
        emit IMercesIncome.PaymentSettled(sid, Q1_2026 + 2, 0, 0, 0, 0, 0);
        income.submitReport(r);
        (uint64 due,) = income.openDue(sid);
        assertEq(due, 0);
        (bool hasPaid, uint32 lastPaid) = income.lastPaidPeriod(sid);
        assertTrue(hasPaid);
        assertEq(lastPaid, Q1_2026 + 2);
        assertEq(income.nextExpectedPeriod(sid), Q1_2026 + 3);
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.OnTime));
    }

    function test_ytdChainAndYearRollover() public {
        reportAndPay(sid, Q1_2026, Proofs.q1());
        // q2 proves against q1's commitment (prior = last income commitment)
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        reportAndPay(sid, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(sid, Q1_2026 + 3, Proofs.q4());
        assertEq(vault.getLedger(sid).grossReceived, 66_000e6);
        // Q1 2027 proves against the ZERO commitment again
        reportAndPay(sid, Q1_2026 + 4, Proofs.y2q1());
        assertEq(vault.getLedger(sid).grossReceived, 72_000e6);
        // a year-2 proof chained to the wrong prior fails: q2 again (prior = q1) at period Q2 2027
        vm.warp(Periods.periodEnd(Q1_2026 + 5));
        vm.prank(issuer);
        vm.expectRevert(InvalidProof.selector);
        income.submitReport(reportInput(sid, Q1_2026 + 5, Proofs.q2(), 2, false));
    }

    // ------------------------------------------------------------ guards

    function test_submitGuards() public {
        Proofs.Proof memory p = Proofs.q1();
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        income.submitReport(reportInput(sid, Q1_2026, p, 2, false));

        // too early
        vm.prank(issuer);
        vm.expectRevert(PeriodNotEnded.selector);
        income.submitReport(reportInput(sid, Q1_2026, p, 2, false));
        vm.warp(Q1_END);

        // wrong period
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(WrongPeriod.selector, Q1_2026, Q1_2026 + 1));
        income.submitReport(reportInput(sid, Q1_2026 + 1, p, 2, false));

        // tier not enabled (series has tiers 2 and 3)
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(TierNotEnabled.selector, 1));
        income.submitReport(reportInput(sid, Q1_2026, p, 1, false));

        // fx must be WAD for stablecoin income
        IMercesIncome.ReportInput memory r = reportInput(sid, Q1_2026, p, 2, false);
        r.fxAvgWad = 1.1e18;
        vm.prank(issuer);
        vm.expectRevert(FxMustBeWad.selector);
        income.submitReport(r);
        r = reportInput(sid, Q1_2026, p, 2, false);
        r.fxFallbackSignature = hex"01";
        vm.prank(issuer);
        vm.expectRevert(FxFallbackNotNeeded.selector);
        income.submitReport(r);

        // tampered payment → proof fails
        r = reportInput(sid, Q1_2026, p, 2, false);
        r.paymentUsd = 11_999e6;
        vm.prank(issuer);
        vm.expectRevert(InvalidProof.selector);
        income.submitReport(r);

        // proof for 299 units while 300 are outstanding
        vm.prank(issuer);
        vm.expectRevert(InvalidProof.selector);
        income.submitReport(reportInput(sid, Q1_2026, Proofs.units299(), 2, false));

        // attestation: tier 2 signed by an attestor key is not a verifier key
        r = reportInput(sid, Q1_2026, p, 2, false);
        r.attestationSignature = sign(attestorKey, MercesMessages.reportDigest(registry.domain(), sid, Q1_2026, p.incomeCommitment, 2));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(VerifierKeyNotRegistered.selector, attestor));
        income.submitReport(r);
        // tier 3 signed by the verifier key
        r = reportInput(sid, Q1_2026, p, 3, false);
        r.attestationSignature = sign(verifierKey, MercesMessages.reportDigest(registry.domain(), sid, Q1_2026, p.incomeCommitment, 3));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AttestorNotRegistered.selector, verifier));
        income.submitReport(r);
        // missing attestation
        r = reportInput(sid, Q1_2026, p, 2, false);
        r.attestationSignature = "";
        vm.prank(issuer);
        vm.expectRevert(AttestationRequired.selector);
        income.submitReport(r);
        // signature over the wrong tier is rejected as a wrong signer
        r = reportInput(sid, Q1_2026, p, 2, false);
        r.attestationSignature = sign(verifierKey, MercesMessages.reportDigest(registry.domain(), sid, Q1_2026, p.incomeCommitment, 3));
        vm.prank(issuer);
        vm.expectRevert();
        income.submitReport(r);

        // tier 3 happy path works
        vm.prank(issuer);
        income.submitReport(reportInput(sid, Q1_2026, p, 3, false));
        // previous period must be paid before the next report
        vm.warp(Periods.periodEnd(Q1_2026 + 1));
        vm.prank(issuer);
        vm.expectRevert(PreviousPeriodUnpaid.selector);
        income.submitReport(reportInput(sid, Q1_2026 + 1, Proofs.q2(), 2, false));
        // pay nothing due → NothingDue after paying
        payDue(sid, issuer);
        vm.expectRevert(NothingDue.selector);
        income.pay(sid);
    }

    function test_tier4FlagAndTier1NoAttestation() public {
        uint256 s = runStandardRaise(TierFlags.TIER1_SPLIT | TierFlags.TIER4_SELF, bytes32(0));
        vm.warp(Q1_END);
        Proofs.Proof memory p = Proofs.q1();
        IMercesIncome.ReportInput memory r = reportInput(s, Q1_2026, p, 4, false);
        vm.prank(issuer);
        vm.expectRevert(Tier4Disabled.selector);
        income.submitReport(r);
        vm.prank(admin);
        registry.setFlags(false, false, true);
        vm.prank(issuer);
        income.submitReport(r); // issuer's own tx is the attestation
        assertEq(income.getReport(s, Q1_2026).tier, 4);
        // tier-1 report needs no signature either
        payDue(s, issuer);
        vm.warp(Periods.periodEnd(Q1_2026 + 1));
        vm.prank(issuer);
        income.submitReport(reportInput(s, Q1_2026 + 1, Proofs.q2(), 1, false));
    }

    function test_reportRequiresFinalizedMint() public {
        // a fresh series whose bids are not all processed
        uint256 s = standardSeries(TierFlags.TIER2_ZKTLS, bytes32(0));
        vm.prank(issuer);
        auction.openRaise(s);
        vm.warp(auction.getAuction(s).revealEnd);
        vm.prank(keeper);
        auction.beginSettlement(s, 1);
        vm.prank(keeper);
        auction.finalizeSettlement(s); // no bids → failed
        vm.warp(Q1_END + 20 days);
        vm.prank(issuer);
        vm.expectRevert(MintNotFinalized.selector);
        income.submitReport(reportInput(s, Q1_2026, Proofs.q1(), 2, false));
    }

    // ------------------------------------------------------------ status machine and lateness

    function test_statusDerivationTimeline() public {
        // first period Q1 2026; deadline = Apr 1 + 30 d; grace = + 15 d
        uint64 deadline = Q1_END + 30 * DAY;
        uint64 graceEnd = deadline + 15 * DAY;
        assertEq(uint8(income.deriveStatusAt(sid, deadline)), uint8(SeriesStatus.OnTime));
        assertEq(uint8(income.deriveStatusAt(sid, deadline + 1)), uint8(SeriesStatus.InGrace));
        assertEq(uint8(income.deriveStatusAt(sid, graceEnd)), uint8(SeriesStatus.InGrace));
        assertEq(uint8(income.deriveStatusAt(sid, graceEnd + 1)), uint8(SeriesStatus.Late));

        vm.warp(deadline + 1);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.StatusChanged(sid, SeriesStatus.OnTime, SeriesStatus.InGrace);
        income.crankStatus(sid);
        assertEq(uint8(income.getLedger(sid).storedStatus), uint8(SeriesStatus.InGrace));

        // treasury releases are blocked while Late and resume once current (brief C8 §3)
        vm.warp(graceEnd + 1);
        vm.prank(issuer);
        vm.expectRevert(SeriesIsLate.selector);
        treasury.claimRelease(sid);
        // report + pay while late: accrual applies to the due amount
        submitReport(sid, Q1_2026, Proofs.q1());
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Late)); // still unpaid
        vm.warp(graceEnd + 5 * DAY + 100);
        uint64 accrual = income.lateAccrual(sid, Q1_2026, 12_000e6, block.timestamp);
        // floor(12_000e6 × 0.08e18 × 5 / (365 × 1e18)) = 13_150_684
        assertEq(accrual, 13_150_684);
        uint64 total = payDue(sid, issuer);
        assertEq(total, 12_000e6 + 13_150_684);
        assertEq(income.getReport(sid, Q1_2026).accrualPaid, 13_150_684);
        // accrual counts toward the cap (it is paid into the vault)
        assertEq(vault.getLedger(sid).grossReceived, 12_000e6 + 13_150_684);
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.OnTime));
        vm.prank(issuer);
        treasury.claimRelease(sid); // releases resume
    }

    function test_formalNoticeDueOncePerPeriod() public {
        uint64 deadline = Q1_END + 30 * DAY;
        vm.warp(deadline + 90 * DAY);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.FormalNoticeDue(sid, Q1_2026);
        income.crankStatus(sid);
        assertTrue(income.getLedger(sid).formalNoticeEmitted);
        assertEq(income.getLedger(sid).formalNoticeEmittedFor, Q1_2026);
        // nothing is slashed: balances untouched, releases blocked only
        assertEq(usdc.balanceOf(address(treasury)), 30_000e6);
        // second crank does not re-emit (no StatusChanged either since Late stays Late)
        vm.recordLogs();
        vm.prank(keeper);
        income.crankStatus(sid);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_hardshipPauseStopsTheClock() public {
        uint64 deadline = Q1_END + 30 * DAY;
        vm.warp(deadline - 10 * DAY); // 10 days before the deadline, still OnTime
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        income.requestPause(sid);
        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.PauseRequested(sid);
        income.requestPause(sid);
        vm.prank(issuer);
        vm.expectRevert(PauseAlreadyRequested.selector);
        income.requestPause(sid);

        uint64 pauseEnd = uint64(block.timestamp) + 60 * DAY;
        vm.expectRevert(PauseEndInPast.selector);
        income.approvePause(sid, uint64(block.timestamp), pauseSig(sid, 0, uint64(block.timestamp)));
        vm.expectRevert(abi.encodeWithSelector(AttestorNotRegistered.selector, vm.addr(0xDEAD)));
        income.approvePause(sid, pauseEnd, sign(0xDEAD, MercesMessages.pauseDigest(registry.domain(), sid, 0, pauseEnd)));
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IMercesIncome.PauseApproved(sid, uint64(block.timestamp), pauseEnd, attestor);
        income.approvePause(sid, pauseEnd, pauseSig(sid, 0, pauseEnd));
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Paused));
        assertEq(income.getLedger(sid).pauseNonce, 1);
        // the same signature cannot be replayed (nonce moved on) and a second request is needed
        vm.expectRevert(PauseNotRequested.selector);
        income.approvePause(sid, pauseEnd, pauseSig(sid, 0, pauseEnd));

        // 40 days into the pause the deadline would have passed; the effective clock has not moved
        vm.warp(deadline + 30 * DAY);
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Paused));
        assertEq(income.effectiveNow(sid, block.timestamp), deadline - 10 * DAY);
        // treasury releases are NOT blocked by a hardship pause (brief C11 §1)
        vm.prank(issuer);
        treasury.claimRelease(sid);

        // pause auto-closes at pause_end: 60 days of pause folded into paused_total
        vm.warp(pauseEnd + 5 * DAY);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.PauseEnded(sid, 60 * DAY);
        income.crankStatus(sid);
        assertEq(income.getLedger(sid).pausedTotal, 60 * DAY);
        // effective now = deadline − 5 d → still OnTime although 65 days have passed
        assertEq(income.effectiveNow(sid, block.timestamp), deadline - 5 * DAY);
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.OnTime));

        // issuer may end a pause early
        vm.prank(issuer);
        income.requestPause(sid);
        vm.prank(keeper);
        income.approvePause(sid, uint64(block.timestamp) + 30 * DAY, pauseSig(sid, 1, uint64(block.timestamp) + 30 * DAY));
        vm.warp(block.timestamp + 3 * DAY);
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        income.endPause(sid);
        vm.prank(issuer);
        income.endPause(sid);
        assertEq(income.getLedger(sid).pausedTotal, 63 * DAY);
        vm.prank(issuer);
        vm.expectRevert(NotPaused.selector);
        income.endPause(sid);
        // late accrual is measured in effective time
        vm.warp(block.timestamp + 200 * DAY);
        uint256 e = income.effectiveNow(sid, block.timestamp);
        uint64 graceEnd = deadline + 15 * DAY;
        uint64 lateDays = uint64((e - graceEnd) / DAY);
        assertEq(income.lateAccrual(sid, Q1_2026, 12_000e6, block.timestamp), uint64(uint256(12_000e6) * 0.08e18 * lateDays / (365e18)));
    }

    // ------------------------------------------------------------ true-up (tier 3)

    function test_trueUpPositiveAndNegative() public {
        reportAndPay(sid, Q1_2026, Proofs.q1());
        uint64 attestationTs = uint64(block.timestamp);
        bytes memory sigPos = sign(attestorKey, MercesMessages.trueupDigest(registry.domain(), sid, 2026, 2_000e6, attestationTs));
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        income.submitTrueUp(sid, 2026, 2_000e6, attestationTs, sigPos);
        vm.prank(issuer);
        vm.expectRevert(ZeroAdjustment.selector);
        income.submitTrueUp(sid, 2026, 0, attestationTs, sigPos);
        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.TrueUpRecorded(sid, 2026, 2_000e6, attestationTs + 60 * DAY);
        income.submitTrueUp(sid, 2026, 2_000e6, attestationTs, sigPos);
        assertEq(income.trueupDue(sid), 2_000e6);
        // replay rejected
        vm.prank(issuer);
        vm.expectRevert(TrueUpSignatureUsed.selector);
        income.submitTrueUp(sid, 2026, 2_000e6, attestationTs, sigPos);
        // no accrual inside the 60-day window
        vm.warp(attestationTs + 59 * DAY);
        fund(issuer, 2_000e6);
        vm.startPrank(issuer);
        usdc.approve(address(income), 2_000e6);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.TrueUpPaid(sid, 2_000e6, 0);
        income.payTrueUp(sid);
        vm.stopPrank();
        assertEq(income.trueupDue(sid), 0);
        assertEq(vault.getLedger(sid).grossReceived, 14_000e6);
        vm.expectRevert(NoTrueUpDue.selector);
        income.payTrueUp(sid);

        // positive true-up paid late accrues from the deadline
        bytes memory sigPos2 = sign(attestorKey, MercesMessages.trueupDigest(registry.domain(), sid, 2026, 1_000e6, attestationTs + 1));
        vm.prank(issuer);
        income.submitTrueUp(sid, 2026, 1_000e6, attestationTs + 1, sigPos2);
        vm.warp(attestationTs + 1 + 60 * DAY + 10 * DAY);
        uint64 accrual = uint64(uint256(1_000e6) * 0.08e18 * 10 / 365e18);
        fund(keeper, 1_000e6 + accrual);
        vm.startPrank(keeper);
        usdc.approve(address(income), 1_000e6 + accrual);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.TrueUpPaid(sid, 1_000e6 + accrual, accrual);
        income.payTrueUp(sid);
        vm.stopPrank();

        // negative true-up credits forward and reduces the next due
        bytes memory sigNeg = sign(attestorKey, MercesMessages.trueupDigest(registry.domain(), sid, 2026, -5_000e6, attestationTs + 2));
        vm.prank(issuer);
        income.submitTrueUp(sid, 2026, -5_000e6, attestationTs + 2, sigNeg);
        assertEq(income.getLedger(sid).routerCredit, 5_000e6);
        submitReport(sid, Q1_2026 + 1, Proofs.q2()); // 12,000 due − 5,000 credit
        (uint64 due,) = income.openDue(sid);
        assertEq(due, 7_000e6);
        assertEq(income.getLedger(sid).routerCredit, 0);
        assertEq(income.getReport(sid, Q1_2026 + 1).due, 7_000e6);
    }

    function test_trueUpRequiresTier3() public {
        uint256 s = runStandardRaise(TierFlags.TIER2_ZKTLS, bytes32(0));
        bytes memory sig = sign(attestorKey, MercesMessages.trueupDigest(registry.domain(), s, 2026, 1, 1));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(TierNotEnabled.selector, 3));
        income.submitTrueUp(s, 2026, 1, 1, sig);
    }

    // ------------------------------------------------------------ protocol surface

    function test_clearDuesOnlyVault() public {
        vm.expectRevert(NotProtocolContract.selector);
        income.clearDues(sid);
    }

    function test_ownerOnlyConfiguration() public {
        vm.prank(stranger);
        vm.expectRevert();
        income.setGroth16Verifier(stranger);
        vm.prank(address(timelock));
        income.setGroth16Verifier(address(groth16));
        assertEq(income.groth16Verifier(), address(groth16));
        assertEq(income.fxAccumulator(), address(fx));
    }

    function test_statusBeforeSettlementIsOnTime() public {
        uint256 draft = createSeries(keccak256("x"));
        assertEq(uint8(income.deriveStatus(draft)), uint8(SeriesStatus.OnTime));
    }
}
