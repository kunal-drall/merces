// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {IMercesIncome, TRUEUP_NOTICE_PERIOD} from "../../src/interfaces/IMercesIncome.sol";
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
        assertEq(rep.priorIncomeCommitment, p.priorCommitment);
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
        assertEq(vl.carryWad, 0);
        assertEq(vl.feeCollected, 600e6);
        assertEq(vl.grossReceived, 12_000e6);
        assertEq(vault.yearGrossWad(sid, 0), 40e6 * 1e18); // anchored at the period's due date, year 0

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
        // a claim with nothing due is a no-op that emits zeros (SPEC §1.1)
        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.PayoutClaimed(sid, b1, 0, 0);
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
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2()); // prior = q1's commitment
        reportAndPay(sid, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(sid, Q1_2026 + 3, Proofs.q4());
        assertEq(vault.getLedger(sid).grossReceived, 66_000e6);
        // Q1 2027 proves against the ZERO commitment again
        reportAndPay(sid, Q1_2026 + 4, Proofs.y2q1());
        assertEq(vault.getLedger(sid).grossReceived, 72_000e6);
        // a year-2 report chained to the wrong prior is refused before the proof is even checked
        vm.warp(Periods.periodEnd(Q1_2026 + 5));
        vm.prank(issuer);
        vm.expectRevert(PriorCommitmentMismatch.selector);
        income.submitReport(reportInput(sid, Q1_2026 + 5, Proofs.q2(), 2, false));
        // and a year-start first report must carry the ZERO prior
        vm.warp(Periods.periodStart(Q1_2026 + 8)); // 2028-01-01
        uint256 s2 = runStandardRaise();
        assertEq(Periods.periodOf(settlementTs(s2)), Q1_2026 + 8);
        vm.warp(Periods.periodEnd(Q1_2026 + 8));
        vm.prank(issuer);
        vm.expectRevert(PriorCommitmentMismatch.selector);
        income.submitReport(reportInput(s2, Q1_2026 + 8, Proofs.q2(), 2, false));
    }

    function test_firstReportMidYearAcceptsAttestedPrior() public {
        // a series settled in Q2 reports Q2 first; its prior commitment is attested as given (A25)
        vm.warp(Q1_END + 10 days);
        uint256 s = runStandardRaise();
        uint32 first = Periods.periodOf(settlementTs(s));
        assertEq(first, Q1_2026 + 1);
        vm.warp(Periods.periodEnd(first));
        vm.prank(issuer);
        income.submitReport(reportInput(s, first, Proofs.q2(), 2, false)); // prior = q1's commitment, non-zero
        (uint64 due,) = income.openDue(s);
        assertEq(due, 12_000e6);
        payDue(s, issuer);
        // the next report chains to it as usual
        reportAndPay(s, first + 1, Proofs.q3zero());
        assertEq(income.getLedger(s).lastIncomePeriod, first + 1);
    }

    // ------------------------------------------------------------ guards

    function test_submitGuards() public {
        Proofs.Proof memory p = Proofs.q1();
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        income.submitReport(reportInput(sid, Q1_2026, p, 2, false));

        vm.prank(issuer);
        vm.expectRevert(ReportTooEarly.selector);
        income.submitReport(reportInput(sid, Q1_2026, p, 2, false));
        vm.warp(Q1_END);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(WrongPeriod.selector, Q1_2026, Q1_2026 + 1));
        income.submitReport(reportInput(sid, Q1_2026 + 1, p, 2, false));

        // tier not enabled (series has tiers 2 and 3)
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(TierNotEnabled.selector, 1));
        income.submitReport(reportInput(sid, Q1_2026, p, 1, false));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(TierNotEnabled.selector, 4));
        income.submitReport(reportInput(sid, Q1_2026, p, 4, false));

        // fx must be WAD for stablecoin income
        IMercesIncome.ReportInput memory r = reportInput(sid, Q1_2026, p, 2, false);
        r.fxAvgWad = 1.1e18;
        vm.prank(issuer);
        vm.expectRevert(FxMustBeWad.selector);
        income.submitReport(r);
        r = reportInput(sid, Q1_2026, p, 2, false);
        r.fxFallbackSignature = hex"01";
        vm.prank(issuer);
        vm.expectRevert(FxFallbackNotAllowed.selector);
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
        bytes32 dg2 = MercesMessages.reportDigest(domain, sid, Q1_2026, p.priorCommitment, p.incomeCommitment, 2, false);
        bytes32 dg3 = MercesMessages.reportDigest(domain, sid, Q1_2026, p.priorCommitment, p.incomeCommitment, 3, false);
        r = reportInput(sid, Q1_2026, p, 2, false);
        r.attestationSignature = sign(attestorKey, dg2);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(InvalidVerifierSignature.selector, attestor));
        income.submitReport(r);
        r = reportInput(sid, Q1_2026, p, 3, false);
        r.attestationSignature = sign(verifierKey, dg3);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestorSignature.selector, verifier));
        income.submitReport(r);
        r = reportInput(sid, Q1_2026, p, 2, false);
        r.attestationSignature = "";
        vm.prank(issuer);
        vm.expectRevert(AttestationRequired.selector);
        income.submitReport(r);
        // a signature over another tier or liquidity flag recovers a stranger
        r = reportInput(sid, Q1_2026, p, 2, false);
        r.attestationSignature = sign(verifierKey, dg3);
        vm.prank(issuer);
        vm.expectRevert();
        income.submitReport(r);
        r = reportInput(sid, Q1_2026, p, 2, true);
        r.attestationSignature = sign(verifierKey, dg2);
        vm.prank(issuer);
        vm.expectRevert();
        income.submitReport(r);

        // tier 3 happy path works
        vm.prank(issuer);
        income.submitReport(reportInput(sid, Q1_2026, p, 3, false));
        vm.warp(Periods.periodEnd(Q1_2026 + 1));
        vm.prank(issuer);
        vm.expectRevert(PaymentOutstanding.selector);
        income.submitReport(reportInput(sid, Q1_2026 + 1, Proofs.q2(), 2, false));
        payDue(sid, issuer);
        vm.expectRevert(NothingDue.selector);
        income.pay(sid);
    }

    function test_tier4FlagAndTier1Purity() public {
        uint256 s = runStandardRaise(TierFlags.TIER1_SPLIT | TierFlags.TIER4_SELF, bytes32(0));
        vm.warp(Q1_END);
        Proofs.Proof memory p = Proofs.q1();
        IMercesIncome.ReportInput memory r = reportInput(s, Q1_2026, p, 4, false);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(TierNotEnabled.selector, 4));
        income.submitReport(r);
        // tier 1 is not a report tier unless the series is pure tier 1
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(TierNotEnabled.selector, 1));
        income.submitReport(reportInput(s, Q1_2026, p, 1, false));
        vm.prank(admin);
        registry.setFlags(false, false, true);
        vm.prank(issuer);
        income.submitReport(r); // the issuer's own transaction is the attestation
        assertEq(income.getReport(s, Q1_2026).tier, 4);
        payDue(s, issuer);
    }

    function test_reportRequiresFinalizedMint() public {
        uint256 s = standardSeries(TierFlags.TIER2_ZKTLS, bytes32(0));
        vm.prank(issuer);
        auction.openRaise(s);
        vm.warp(auction.getAuction(s).revealEnd);
        vm.prank(keeper);
        auction.beginSettlement(s, 1, 0, 0);
        vm.prank(keeper);
        auction.finalizeSettlement(s); // no bids → failed
        vm.warp(Q1_END + 20 days);
        vm.prank(issuer);
        vm.expectRevert(RaiseNotSettled.selector); // a failed raise never settled
        income.submitReport(reportInput(s, Q1_2026, Proofs.q1(), 2, false));
        vm.prank(issuer);
        vm.expectRevert(RaiseNotSettled.selector);
        income.submitTrueUp(s, 2026, 1, 1, "");
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
        assertEq(income.earliestUnpaidPeriod(sid), Q1_2026);

        vm.warp(deadline + 1);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.StatusChanged(sid, SeriesStatus.OnTime, SeriesStatus.InGrace);
        income.crankStatus(sid);
        assertEq(uint8(income.getLedger(sid).storedStatus), uint8(SeriesStatus.InGrace));

        // treasury releases are blocked while Late and resume once current (brief C8 §3)
        vm.warp(graceEnd + 1);
        assertTrue(income.isLateUnderlying(sid));
        vm.prank(issuer);
        vm.expectRevert(SeriesLate.selector);
        treasury.claimRelease(sid);
        submitReport(sid, Q1_2026, Proofs.q1());
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Late)); // still unpaid
        vm.warp(graceEnd + 5 * DAY + 100);
        uint64 accrual = income.lateAccrual(sid, Q1_2026, 12_000e6, block.timestamp);
        // mulDiv(mulDiv(12_000e6, 0.08e18, WAD), 5, 365) = 13_150_684
        assertEq(accrual, 13_150_684);
        uint64 total = payDue(sid, issuer);
        assertEq(total, 12_000e6 + 13_150_684);
        assertEq(income.getReport(sid, Q1_2026).accrualPaid, 13_150_684);
        assertEq(vault.getLedger(sid).grossReceived, 12_000e6 + 13_150_684); // accrual counts toward the cap
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.OnTime));
        assertFalse(income.isLateUnderlying(sid));
        vm.prank(issuer);
        treasury.claimRelease(sid); // releases resume
    }

    function test_formalNoticeDueOncePerPeriod() public {
        vm.warp(Q1_END + 90 * DAY);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.FormalNoticeDue(sid, Q1_2026);
        income.crankStatus(sid);
        assertTrue(income.getLedger(sid).hasFormalNotice);
        assertEq(income.getLedger(sid).formalNoticeEmittedFor, Q1_2026);
        assertEq(usdc.balanceOf(address(treasury)), 30_000e6); // nothing is slashed
        vm.recordLogs();
        vm.prank(keeper);
        income.crankStatus(sid);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_hardshipPauseStopsTheClock() public {
        uint64 deadline = Q1_END + 30 * DAY;
        vm.warp(deadline - 10 * DAY);
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        income.requestPause(sid);
        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.PauseRequested(sid, 1);
        income.requestPause(sid);
        vm.prank(issuer);
        vm.expectRevert(PauseAlreadyRequested.selector);
        income.requestPause(sid);

        uint64 start = uint64(block.timestamp);
        uint64 pauseEnd = start + 60 * DAY;
        vm.expectRevert(InvalidPauseEnd.selector);
        income.approvePause(sid, start, pauseSig(sid, 1, start));
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestorSignature.selector, vm.addr(0xDEAD)));
        income.approvePause(sid, pauseEnd, sign(0xDEAD, MercesMessages.pauseDigest(domain, sid, 1, pauseEnd)));
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true);
        emit IMercesIncome.PauseApproved(sid, start, pauseEnd, attestor);
        income.approvePause(sid, pauseEnd, pauseSig(sid, 1, pauseEnd));
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Paused));
        assertEq(income.getLedger(sid).pauseNonce, 1);
        assertEq(income.getLedger(sid).pauseCount, 1);
        assertEq(income.getPauses(sid).length, 1);
        vm.expectRevert(PauseNotRequested.selector);
        income.approvePause(sid, pauseEnd, pauseSig(sid, 1, pauseEnd));

        // 40 days into the pause the deadline would have passed; the countdown has only run 20 days
        vm.warp(deadline + 30 * DAY);
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Paused));
        assertEq(income.countdown(sid, Q1_2026, block.timestamp), 20 * DAY);
        assertFalse(income.isLateUnderlying(sid));
        vm.prank(issuer);
        treasury.claimRelease(sid); // releases are not blocked by a hardship pause (brief C11 §1)

        // the pause ends on its own at pause_end: 60 days are excluded from every countdown
        vm.warp(pauseEnd + 5 * DAY);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.StatusChanged(sid, SeriesStatus.Paused, SeriesStatus.OnTime);
        income.crankStatus(sid);
        assertEq(income.getLedger(sid).pausedTotal, 60 * DAY);
        assertEq(income.countdown(sid, Q1_2026, block.timestamp), 25 * DAY);

        // the issuer may end a pause early
        vm.prank(issuer);
        income.requestPause(sid);
        uint64 end2 = uint64(block.timestamp) + 30 * DAY;
        income.approvePause(sid, end2, pauseSig(sid, 2, end2));
        vm.warp(block.timestamp + 3 * DAY);
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        income.endPause(sid);
        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.PauseEnded(sid, 63 * DAY);
        income.endPause(sid);
        assertEq(income.getLedger(sid).pausedTotal, 63 * DAY);
        assertEq(income.getPauses(sid)[1].end, block.timestamp);
        vm.prank(issuer);
        vm.expectRevert(NotPaused.selector);
        income.endPause(sid);
        // late accrual is measured in unpaused time: 288 d elapsed − 63 d paused − 45 d grace = 180 late days
        vm.warp(block.timestamp + 200 * DAY);
        assertEq(income.countdown(sid, Q1_2026, block.timestamp), 225 * DAY);
        assertEq(income.lateAccrual(sid, Q1_2026, 12_000e6, block.timestamp), 473_424_657);
    }

    function test_pauseBoundsAndWithdrawal() public {
        vm.prank(issuer);
        income.requestPause(sid); // nonce 1
        // a withdrawn request invalidates its signature
        uint64 end1 = uint64(block.timestamp) + 30 days;
        bytes memory sig1 = pauseSig(sid, 1, end1);
        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.PauseRequestWithdrawn(sid, 2);
        income.withdrawPauseRequest(sid);
        vm.expectRevert(PauseNotRequested.selector);
        income.approvePause(sid, end1, sig1);
        vm.prank(issuer);
        vm.expectRevert(PauseNotRequested.selector);
        income.withdrawPauseRequest(sid);
        vm.prank(issuer);
        income.requestPause(sid); // nonce 3
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestorSignature.selector, vm.addr(0xBEEF)));
        income.approvePause(sid, end1, sign(0xBEEF, MercesMessages.pauseDigest(domain, sid, 3, end1)));
        vm.expectRevert(); // the old nonce recovers a stranger
        income.approvePause(sid, end1, sig1);
        // one approval may not exceed max_pause_seconds (365 d)
        uint64 tooLong = uint64(block.timestamp) + 365 days + 1;
        vm.expectRevert(PauseTooLong.selector);
        income.approvePause(sid, tooLong, pauseSig(sid, 3, tooLong));
        uint64 end3 = uint64(block.timestamp) + 365 days;
        income.approvePause(sid, end3, pauseSig(sid, 3, end3));
        vm.prank(issuer);
        income.requestPause(sid); // nonce 4, pending while paused
        vm.expectRevert(AlreadyPaused.selector);
        income.approvePause(sid, end3, pauseSig(sid, 4, end3));
        // lifetime bound (730 d): 365 + 365 is fine, 365 + 366 is not
        vm.warp(end3);
        uint64 end4 = uint64(block.timestamp) + 365 days + 1;
        vm.expectRevert(PauseTooLong.selector);
        income.approvePause(sid, end4, pauseSig(sid, 4, end4));
        end4 = uint64(block.timestamp) + 365 days;
        income.approvePause(sid, end4, pauseSig(sid, 4, end4));
        vm.warp(end4);
        vm.prank(issuer);
        income.requestPause(sid); // nonce 5
        uint64 end5 = uint64(block.timestamp) + 1 days;
        vm.expectRevert(PauseTooLong.selector);
        income.approvePause(sid, end5, pauseSig(sid, 5, end5));
        assertEq(income.getLedger(sid).pausedTotal, 730 days);
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.OnTime)); // two years paused, nothing ran
    }

    // ------------------------------------------------------------ true-up (tier 3)

    function test_trueUpRules() public {
        uint256 s2 = runStandardRaise();
        uint256 s3 = runStandardRaise();
        uint256[3] memory ids = [sid, s2, s3];
        Proofs.Proof[4] memory year = [Proofs.q1(), Proofs.q2(), Proofs.q3zero(), Proofs.q4()];
        for (uint256 q = 0; q < 4; q++) {
            for (uint256 i = 0; i < 3; i++) {
                reportAndPay(ids[i], Q1_2026 + uint32(q), year[q]);
            }
        }
        assertEq(block.timestamp, Periods.periodEnd(Q1_2026 + 3)); // 2027-01-01: the 2026 year has ended
        uint64 ts = uint64(block.timestamp);

        // guards
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        income.submitTrueUp(sid, 2026, 1, ts, "");
        vm.startPrank(issuer);
        vm.expectRevert(ZeroAdjustment.selector);
        income.submitTrueUp(sid, 2026, 0, ts, "");
        vm.expectRevert(AttestationInFuture.selector);
        income.submitTrueUp(sid, 2026, 1, ts + 1, "");
        vm.expectRevert(TrueUpYearInvalid.selector);
        income.submitTrueUp(sid, 2027, 1, ts, "");
        vm.expectRevert(TrueUpYearInvalid.selector);
        income.submitTrueUp(sid, 2025, 1, ts, "");
        vm.expectRevert(TrueUpAdjustmentTooLarge.selector); // the year's payments total 66,000
        income.submitTrueUp(sid, 2026, -66_001e6, ts, trueupSig(sid, 0, 2026, -66_001e6, ts));
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestorSignature.selector, vm.addr(0xDEAD)));
        income.submitTrueUp(
            sid, 2026, -5_000e6, ts, sign(0xDEAD, MercesMessages.trueupDigest(domain, sid, 0, 2026, -5_000e6, ts))
        );

        // negative adjustment: credited forward against the next due
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.TrueUpRecorded(sid, 2026, -5_000e6, 0);
        income.submitTrueUp(sid, 2026, -5_000e6, ts, trueupSig(sid, 0, 2026, -5_000e6, ts));
        assertEq(income.getLedger(sid).routerCredit, 5_000e6);
        assertEq(income.getLedger(sid).trueupNonce, 1);
        vm.expectRevert(TrueUpYearInvalid.selector); // once per year
        income.submitTrueUp(sid, 2026, -1e6, ts, trueupSig(sid, 1, 2026, -1e6, ts));
        vm.stopPrank();
        submitReport(sid, Q1_2026 + 4, Proofs.y2q1()); // 6,000 due − 5,000 credit
        (uint64 due,) = income.openDue(sid);
        assertEq(due, 1_000e6);
        assertEq(income.getLedger(sid).routerCredit, 0);

        // positive adjustment paid inside the 60-day window: no accrual
        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.TrueUpRecorded(s2, 2026, 2_000e6, ts + 60 * DAY);
        income.submitTrueUp(s2, 2026, 2_000e6, ts, trueupSig(s2, 0, 2026, 2_000e6, ts));
        assertEq(income.trueupDue(s2), 2_000e6);
        vm.prank(issuer);
        vm.expectRevert(TrueUpOutstanding.selector);
        income.submitTrueUp(s2, 2026, 1e6, ts, trueupSig(s2, 1, 2026, 1e6, ts));
        vm.warp(ts + 59 * DAY);
        assertEq(uint8(income.deriveStatus(s2)), uint8(SeriesStatus.OnTime));
        fund(issuer, 2_000e6);
        vm.startPrank(issuer);
        usdc.approve(address(income), 2_000e6);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.TrueUpPaid(s2, 2_000e6, 0);
        income.payTrueUp(s2);
        vm.stopPrank();
        assertEq(income.trueupDue(s2), 0);
        assertEq(vault.getLedger(s2).grossReceived, 68_000e6);
        vm.expectRevert(NothingDue.selector);
        income.payTrueUp(s2);

        // positive adjustment paid late: Late status, release block, accrual from the 60-day mark
        vm.prank(issuer);
        income.submitTrueUp(s3, 2026, 1_000e6, ts, trueupSig(s3, 0, 2026, 1_000e6, ts));
        vm.warp(ts + 70 * DAY);
        assertEq(uint8(income.deriveStatus(s3)), uint8(SeriesStatus.Late));
        assertTrue(income.isLateUnderlying(s3));
        vm.prank(issuer);
        vm.expectRevert(SeriesLate.selector);
        treasury.claimRelease(s3);
        uint64 accrual = 2_191_780; // mulDiv(mulDiv(1_000e6, 0.08e18, WAD), 10, 365)
        fund(keeper, 1_000e6 + accrual);
        vm.startPrank(keeper);
        usdc.approve(address(income), 1_000e6 + accrual);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.TrueUpPaid(s3, 1_000e6 + accrual, accrual);
        income.payTrueUp(s3);
        vm.stopPrank();
        assertEq(uint8(income.deriveStatus(s3)), uint8(SeriesStatus.OnTime));
        assertEq(income.getLedger(s3).lastTrueupYear, 2026);
        assertEq(income.getLedger(s3).trueupAttestedAt, ts);
    }

    function test_trueUpNoticeAndTierRequirement() public {
        uint256 s = runStandardRaise(TierFlags.TIER2_ZKTLS, bytes32(0));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(TierNotEnabled.selector, 3));
        income.submitTrueUp(s, 2026, 1, 1, "");
        reportAndPay(sid, Q1_2026, Proofs.q1());
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        reportAndPay(sid, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(sid, Q1_2026 + 3, Proofs.q4());
        uint64 ts = uint64(block.timestamp);
        vm.prank(issuer);
        income.submitTrueUp(sid, 2026, 1_000e6, ts, trueupSig(sid, 0, 2026, 1_000e6, ts));
        vm.warp(ts + 105 * DAY);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesIncome.FormalNoticeDue(sid, TRUEUP_NOTICE_PERIOD);
        income.crankStatus(sid);
        assertTrue(income.getLedger(sid).trueupNoticeEmitted);
    }

    // ------------------------------------------------------------ key revocation grace (SPEC §1.4)

    function test_revokedVerifierKeyKeepsGraceForEndedPeriods() public {
        uint256 s2 = runStandardRaise();
        uint256 newPk = 0xD00D;
        vm.warp(Q1_END + 1 days);
        vm.prank(admin);
        registry.rotateVerifierKey(verifier, vm.addr(newPk));
        // Q1 ended before the revocation: the old key still attests it during the grace window
        vm.warp(Q1_END + 10 days);
        vm.prank(issuer);
        income.submitReport(reportInput(sid, Q1_2026, Proofs.q1(), 2, false));
        payDue(sid, issuer);
        // Q2 ends after the revocation: the old key is refused, the new key works
        vm.warp(Periods.periodEnd(Q1_2026 + 1));
        IMercesIncome.ReportInput memory r = reportInput(sid, Q1_2026 + 1, Proofs.q2(), 2, false);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(InvalidVerifierSignature.selector, verifier));
        income.submitReport(r);
        Proofs.Proof memory p = Proofs.q2();
        r.attestationSignature = sign(
            newPk,
            MercesMessages.reportDigest(domain, sid, Q1_2026 + 1, p.priorCommitment, p.incomeCommitment, 2, false)
        );
        vm.prank(issuer);
        income.submitReport(r);
        // the grace window is 45 days: a Q1 report attested by the old key is refused afterwards
        assertGt(block.timestamp, Q1_END + 1 days + 45 days);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(InvalidVerifierSignature.selector, verifier));
        income.submitReport(reportInput(s2, Q1_2026, Proofs.q1(), 2, false));
    }

    // ------------------------------------------------------------ protocol surface

    function test_protocolOnlyEntryPoints() public {
        vm.expectRevert(NotProtocolContract.selector);
        income.clearDues(sid);
        vm.expectRevert(NotRouter.selector);
        income.receiveRouterShare(sid, 1);
    }

    function test_ownerOnlyConfiguration() public {
        vm.prank(stranger);
        vm.expectRevert();
        income.setGroth16Verifier(stranger);
        vm.prank(address(timelock));
        income.setGroth16Verifier(groth16);
        assertEq(income.groth16Verifier(), groth16);
        assertEq(income.fxAccumulator(), address(fx));
        assertEq(income.router(), address(router));
    }

    function test_statusBeforeSettlementIsOnTime() public {
        uint256 draft = createSeries(keccak256("x"));
        assertEq(uint8(income.deriveStatus(draft)), uint8(SeriesStatus.OnTime));
        assertFalse(income.isLateUnderlying(draft));
    }
}
