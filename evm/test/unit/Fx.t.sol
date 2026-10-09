// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {IMercesFxAccumulator} from "../../src/interfaces/IMercesFxAccumulator.sol";
import {MockChainlinkAggregator} from "../../src/mocks/MockChainlinkAggregator.sol";
import {MockPyth} from "../../src/mocks/MockPyth.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {TierFlags} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

contract FxTest is FullFixture {
    bytes32 internal constant FEED = keccak256("pyth:EUR/USD");
    bytes32 internal PAIR;
    uint64 internal constant DAY = 86_400;
    MockChainlinkAggregator internal chainlink;

    function setUp() public override {
        super.setUp();
        chainlink = new MockChainlinkAggregator(8, "EUR / USD");
        vm.prank(admin);
        registry.setFxPair(FEED, false, address(0));
        PAIR = registry.fxPairId(FEED, false);
    }

    function _pythAt(int64 price, uint64 conf, uint256 publishTime) internal {
        pyth.setPrice(FEED, price, conf, -8, publishTime);
    }

    function _snap() internal {
        vm.prank(keeper);
        fx.snapshot(PAIR, new bytes[](0));
    }

    /// @dev Snapshots the first `n` days of `period` at `rate` (1e8 fixed point).
    function _cover(uint32 period, uint64 n, int64 rate) internal {
        uint64 start = Periods.periodStart(period);
        for (uint64 d = 0; d < n; d++) {
            vm.warp(start + d * DAY + 12 hours);
            _pythAt(rate, uint64(uint256(uint64(rate)) / 1000), vm.getBlockTimestamp() - 60);
            _snap();
        }
    }

    function test_snapshotNormalizesAndCheckpoints() public {
        _pythAt(108_000_000, 50_000, vm.getBlockTimestamp() - 10); // 1.08 with 0.05% conf
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesFxAccumulator.FxSnapshot(PAIR, uint32(vm.getBlockTimestamp() / DAY), 1.08e18, 1.08e18, 1);
        fx.snapshot(PAIR, new bytes[](0));
        IMercesFxAccumulator.FxPairState memory st = fx.getFxPair(PAIR);
        assertEq(st.sumWad, 1.08e18);
        assertEq(st.count, 1);
        assertEq(st.lastDay, uint32(vm.getBlockTimestamp() / DAY));
        IMercesFxAccumulator.FxCheckpoint memory cp = fx.getFxCheckpoint(PAIR, Periods.periodOf(vm.getBlockTimestamp()));
        assertTrue(cp.exists);
        assertEq(cp.sumWad, 0);
        assertEq(cp.count, 0);
        assertFalse(cp.flagged);
        vm.expectRevert(SnapshotAlreadyTaken.selector);
        fx.snapshot(PAIR, new bytes[](0));
        vm.warp(vm.getBlockTimestamp() + DAY);
        _pythAt(110_000_000, 50_000, vm.getBlockTimestamp() - 10);
        _snap();
        assertEq(fx.getFxPair(PAIR).sumWad, 2.18e18);
    }

    function test_snapshotValidation() public {
        vm.expectRevert(abi.encodeWithSelector(UnknownFxPair.selector, bytes32("nope")));
        fx.snapshot(bytes32("nope"), new bytes[](0));
        _pythAt(108_000_000, 50_000, vm.getBlockTimestamp() - 3601);
        vm.expectRevert(StalePrice.selector); // Pyth's own StalePrice() has the same selector
        fx.snapshot(PAIR, new bytes[](0));
        assertEq(MockPyth.StalePrice.selector, StalePrice.selector);
        _pythAt(-1, 0, vm.getBlockTimestamp());
        vm.expectRevert(StalePrice.selector); // a non-positive price is treated as stale (reference)
        fx.snapshot(PAIR, new bytes[](0));
        _pythAt(108_000_000, 1_080_001, vm.getBlockTimestamp());
        vm.expectRevert(ConfidenceTooWide.selector);
        fx.snapshot(PAIR, new bytes[](0));
        // an exponent below −18 cannot be represented
        pyth.setPrice(FEED, 1, 0, -19, vm.getBlockTimestamp());
        vm.expectRevert(abi.encodeWithSelector(UnsupportedExponent.selector, int32(-19)));
        fx.snapshot(PAIR, new bytes[](0));
        _pythAt(108_000_000, 1_080_000, vm.getBlockTimestamp()); // exactly 1% is allowed
        _snap();
        vm.deal(keeper, 1 ether);
        vm.warp(vm.getBlockTimestamp() + DAY);
        vm.prank(keeper);
        vm.expectRevert(PythUpdateFeeInsufficient.selector);
        fx.snapshot{value: 1}(PAIR, new bytes[](0));
        // disabling a pair stops new series, not snapshots (SPEC §3.1)
        vm.prank(admin);
        registry.setFxPairEnabled(PAIR, false);
        _pythAt(108_000_000, 50_000, vm.getBlockTimestamp());
        _snap();
        assertEq(fx.getFxPair(PAIR).count, 2);
    }

    function test_positiveExponentNormalizes() public {
        pyth.setPrice(FEED, 1, 0, 1, vm.getBlockTimestamp()); // 10 with expo +1
        _snap();
        assertEq(fx.getFxPair(PAIR).sumWad, 10e18);
        // rates are uint256 WAD internally: a large positive exponent still accumulates exactly
        vm.warp(vm.getBlockTimestamp() + DAY);
        pyth.setPrice(FEED, 108, 0, 2, vm.getBlockTimestamp());
        fx.snapshot(PAIR, new bytes[](0));
        assertEq(fx.getFxPair(PAIR).sumWad, 10e18 + 10_800e18);
    }

    function test_snapshotWithPythUpdateAndFeeRefund() public {
        MockPyth paidPyth = new MockPyth(1 gwei);
        vm.prank(address(timelock));
        fx.setPyth(address(paidPyth));
        bytes[] memory data = new bytes[](1);
        data[0] = abi.encode(FEED, int64(108_000_000), uint64(50_000), int32(-8), vm.getBlockTimestamp());
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        vm.expectRevert(PythUpdateFeeInsufficient.selector);
        fx.snapshot{value: 0.5 gwei}(PAIR, data);
        vm.prank(keeper);
        fx.snapshot{value: 3 gwei}(PAIR, data); // excess refunded
        assertEq(keeper.balance, 1 ether - 1 gwei);
        assertEq(address(paidPyth).balance, 1 gwei);
        assertEq(fx.getFxPair(PAIR).sumWad, 1.08e18);
    }

    function test_invertedPair() public {
        vm.prank(admin);
        registry.setFxPair(FEED, true, address(0));
        bytes32 inv = registry.fxPairId(FEED, true);
        _pythAt(150_000_000_00, 1_000_000, vm.getBlockTimestamp()); // 150.00 with expo -8
        vm.prank(keeper);
        fx.snapshot(inv, new bytes[](0));
        // floor(1e36 / 150e18) = 6_666_666_666_666_666
        assertEq(fx.getFxPair(inv).sumWad, 6_666_666_666_666_666);
        assertEq(fx.getFxPair(PAIR).count, 0); // the two orientations are separate pairs
    }

    function test_quarterAverageTradingDayCoverageAndLiveEnd() public {
        uint32 p = Periods.periodOf(vm.getBlockTimestamp()); // Q1 2026
        assertEq(Periods.tradingDaysInPeriod(p), 64); // 90 days, Jan 1 2026 is a Thursday
        assertEq(Periods.tradingDaysInPeriod(p + 1), 65);
        (bool ok,) = fx.quarterAverage(PAIR, p);
        assertFalse(ok); // no checkpoints yet
        (bool avail,,,,) = fx.quarterStats(PAIR, p);
        assertFalse(avail);
        // 51 snapshots < 80% of 64 trading days (51.2)
        _cover(p, 51, 108_000_000);
        vm.warp(Periods.periodEnd(p) + 1);
        (ok,) = fx.quarterAverage(PAIR, p); // the period ended and no snapshot was taken in p+1: live end
        assertFalse(ok); // NeedsFallback: low coverage
        (bool avail1, bool ok1, uint256 avg1, uint32 n1, bool flagged1) = fx.quarterStats(PAIR, p);
        assertTrue(avail1);
        assertFalse(ok1);
        assertFalse(flagged1);
        assertEq(n1, 51);
        assertEq(avg1, 1.08e18);
        // in a later period the live rule no longer applies until the next checkpoint exists... but a snapshot
        // in p+1 closes p for good, with the same (insufficient) count
        _pythAt(108_000_000, 50_000, vm.getBlockTimestamp());
        _snap();
        (ok,) = fx.quarterAverage(PAIR, p);
        assertFalse(ok);
        // Q2 2026: 52 snapshots ≥ 52 (80% of 65), average of alternating 1.08 / 1.10 → exact
        uint32 p2 = p + 1;
        uint64 start = Periods.periodStart(p2);
        for (uint64 d = 1; d <= 51; d++) {
            vm.warp(start + d * DAY + 1);
            _pythAt(d % 2 == 0 ? int64(108_000_000) : int64(110_000_000), 50_000, vm.getBlockTimestamp());
            _snap();
        }
        // not yet ended: no live end
        (ok,) = fx.quarterAverage(PAIR, p2);
        assertFalse(ok);
        vm.warp(Periods.periodEnd(p2) + 1);
        uint256 avg;
        (ok, avg) = fx.quarterAverage(PAIR, p2); // 52 snapshots in p2 (the closing one on day 0 + 51)
        assertTrue(ok);
        // sum = 1.08 (day 0) + 26 × 1.10 + 25 × 1.08 → /52
        assertEq(avg, (1.08e18 + 26 * 1.1e18 + 25 * 1.08e18) / 52);
        // the next snapshot writes the checkpoint and yields the same result
        _pythAt(108_000_000, 50_000, vm.getBlockTimestamp());
        _snap();
        (bool ok2, uint256 avg2) = fx.quarterAverage(PAIR, p2);
        assertTrue(ok2);
        assertEq(avg2, avg);
    }

    function test_deviationFlagsPeriodFromEffectivePeriod() public {
        uint32 p = Periods.periodOf(vm.getBlockTimestamp());
        vm.prank(admin);
        registry.setFxPairCrosscheck(PAIR, address(chainlink)); // set from zero: effective now
        assertEq(registry.getFxPair(PAIR).crosscheckEffectivePeriod, p);
        chainlink.setAnswer(108_000_000, vm.getBlockTimestamp());
        _pythAt(108_500_000, 50_000, vm.getBlockTimestamp()); // 0.46% off: within the 2% band
        _snap();
        assertFalse(fx.getFxCheckpoint(PAIR, p).flagged);
        vm.warp(vm.getBlockTimestamp() + DAY);
        chainlink.setAnswer(108_000_000, vm.getBlockTimestamp());
        _pythAt(111_000_000, 50_000, vm.getBlockTimestamp()); // 2.78% off
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesFxAccumulator.FxDeviationFlagged(PAIR, p, 1.11e18, 1.08e18);
        fx.snapshot(PAIR, new bytes[](0));
        assertTrue(fx.getFxCheckpoint(PAIR, p).flagged);
        // a stale cross-check is no comparison: nothing is flagged (the period stays flagged from above)
        uint32 q = p + 1;
        vm.warp(Periods.periodStart(q) + 1);
        _pythAt(130_000_000, 50_000, vm.getBlockTimestamp());
        vm.recordLogs();
        _snap();
        assertEq(vm.getRecordedLogs().length, 1); // FxSnapshot only
        assertFalse(fx.getFxCheckpoint(PAIR, q).flagged);
        // a changed cross-check applies from the next period: the rest of this quarter keeps the old feed
        MockChainlinkAggregator other = new MockChainlinkAggregator(8, "other");
        vm.prank(admin);
        registry.setFxPairCrosscheck(PAIR, address(other));
        assertEq(registry.getFxPair(PAIR).crosscheckEffectivePeriod, q + 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(CrosscheckUnchanged.selector, PAIR));
        registry.setFxPairCrosscheck(PAIR, address(other));
        vm.warp(vm.getBlockTimestamp() + DAY);
        other.setAnswer(200_000_000, vm.getBlockTimestamp()); // would deviate if consulted
        _pythAt(108_000_000, 50_000, vm.getBlockTimestamp());
        _snap();
        assertFalse(fx.getFxCheckpoint(PAIR, q).flagged);
        vm.warp(Periods.periodStart(q + 1) + 1);
        other.setAnswer(200_000_000, vm.getBlockTimestamp());
        _pythAt(108_000_000, 50_000, vm.getBlockTimestamp());
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesFxAccumulator.FxDeviationFlagged(PAIR, q + 1, 1.08e18, 2e18);
        fx.snapshot(PAIR, new bytes[](0));
    }

    function test_invertedPairInvertsTheCrosscheck() public {
        vm.prank(admin);
        bytes32 inv = registry.setFxPair(FEED, true, address(chainlink));
        chainlink.setAnswer(150_000_000_00, vm.getBlockTimestamp()); // same quote as the Pyth feed: 150.00
        _pythAt(152_000_000_00, 1_000_000, vm.getBlockTimestamp()); // 1.33% off after inversion as well
        vm.prank(keeper);
        fx.snapshot(inv, new bytes[](0));
        assertFalse(fx.getFxCheckpoint(inv, Periods.periodOf(vm.getBlockTimestamp())).flagged);
        vm.warp(vm.getBlockTimestamp() + DAY);
        chainlink.setAnswer(150_000_000_00, vm.getBlockTimestamp());
        _pythAt(160_000_000_00, 1_000_000, vm.getBlockTimestamp()); // 6.25% off
        vm.prank(keeper);
        fx.snapshot(inv, new bytes[](0));
        assertTrue(fx.getFxCheckpoint(inv, Periods.periodOf(vm.getBlockTimestamp())).flagged);
    }

    function test_fxPairsAreWriteOnce() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FxPairExists.selector, PAIR));
        registry.setFxPair(FEED, false, address(chainlink));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(UnknownFxPair.selector, bytes32("x")));
        registry.setFxPairEnabled(bytes32("x"), false);
        vm.prank(stranger);
        vm.expectRevert(NotAdmin.selector);
        registry.setFxPairCrosscheck(PAIR, address(chainlink));
    }

    function test_reportWithFxAverageAndFallback() public {
        uint256 sid = runStandardRaise(TierFlags.TIER2_ZKTLS, PAIR, Proofs.fxQ1().termsCommitment);
        // cover Q1 2026 at a constant 1.10 so the quarter average is exactly 1.1e18 (fxQ1 proof)
        _cover(Q1_2026, Periods.daysInPeriod(Q1_2026), 110_000_000);
        vm.warp(Periods.periodEnd(Q1_2026) + 1);
        (bool ok, uint256 avg) = fx.quarterAverage(PAIR, Q1_2026);
        assertTrue(ok);
        assertEq(avg, 1.1e18);
        IMercesIncome.ReportInput memory r = reportInput(sid, Q1_2026, Proofs.fxQ1(), 2, false);
        r.fxAvgWad = 1e18;
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(FxMismatch.selector, 1.1e18, 1e18));
        income.submitReport(r);
        r = reportInput(sid, Q1_2026, Proofs.fxQ1(), 2, false);
        r.fxFallbackSignature = sign(attestorKey, MercesMessages.fxDigest(domain, sid, Q1_2026, 1.1e18));
        vm.prank(issuer);
        vm.expectRevert(FxFallbackNotAllowed.selector);
        income.submitReport(r);
        r = reportInput(sid, Q1_2026, Proofs.fxQ1(), 2, false);
        vm.prank(issuer);
        income.submitReport(r);
        assertEq(income.getReport(sid, Q1_2026).fxAvgWad, 1.1e18);
        assertFalse(income.getReport(sid, Q1_2026).fxFallback);
        (uint64 due,) = income.openDue(sid);
        assertEq(due, 13_200e6); // 12,000 EUR × 1.1
        payDue(sid, issuer);

        // Q2 2026 has no snapshots → NeedsFallback → attestor-signed rate required
        vm.warp(Periods.periodEnd(Q1_2026 + 1) + 1);
        IMercesIncome.ReportInput memory r2 = reportInput(sid, Q1_2026 + 1, Proofs.q2(), 2, false);
        vm.prank(issuer);
        vm.expectRevert(FxFallbackRequired.selector);
        income.submitReport(r2);
        r2.fxFallbackSignature = sign(0xDEAD, MercesMessages.fxDigest(domain, sid, Q1_2026 + 1, 1e18));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestorSignature.selector, vm.addr(0xDEAD)));
        income.submitReport(r2);
        r2.fxFallbackSignature = sign(attestorKey, MercesMessages.fxDigest(domain, sid, Q1_2026 + 1, 1e18));
        // the fallback is accepted, but q2 does not chain to fxQ1's commitment
        vm.prank(issuer);
        vm.expectRevert(InvalidProof.selector);
        income.submitReport(r2);
    }
}
