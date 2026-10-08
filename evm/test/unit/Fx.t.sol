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
    bytes32 internal constant PAIR = keccak256("EUR/USD");
    bytes32 internal constant FEED = keccak256("pyth:EUR/USD");
    uint64 internal constant DAY = 86_400;
    MockChainlinkAggregator internal chainlink;

    function setUp() public override {
        super.setUp();
        chainlink = new MockChainlinkAggregator(8, "EUR / USD");
        vm.prank(admin);
        registry.setFxPair(PAIR, FEED, false, address(0), true);
    }

    function _pythAt(int64 price, uint64 conf, uint256 publishTime) internal {
        pyth.setPrice(FEED, price, conf, -8, publishTime);
    }

    function _snap() internal {
        vm.prank(keeper);
        fx.snapshot(PAIR, new bytes[](0));
    }

    /// @dev Snapshots every day of `period` at `rate` (1e8 fixed point), returning the number taken.
    function _coverPeriod(uint32 period, int64 rate) internal returns (uint64 n) {
        uint64 start = Periods.periodStart(period);
        uint64 days_ = Periods.daysInPeriod(period);
        for (uint64 d = 0; d < days_; d++) {
            vm.warp(start + d * DAY + 12 hours);
            _pythAt(rate, uint64(uint256(uint64(rate)) / 1000), block.timestamp - 60);
            _snap();
            n++;
        }
    }

    function test_snapshotNormalizesAndCheckpoints() public {
        _pythAt(108_000_000, 50_000, block.timestamp - 10); // 1.08 with 0.05% conf
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesFxAccumulator.FxSnapshot(PAIR, uint32(block.timestamp / DAY), 1.08e18, 1.08e18, 1);
        fx.snapshot(PAIR, new bytes[](0));
        IMercesFxAccumulator.FxPairState memory st = fx.getFxPair(PAIR);
        assertEq(st.sumWad, 1.08e18);
        assertEq(st.count, 1);
        assertEq(st.lastDay, uint32(block.timestamp / DAY));
        IMercesFxAccumulator.FxCheckpoint memory cp = fx.getFxCheckpoint(PAIR, Periods.periodOf(block.timestamp));
        assertTrue(cp.exists);
        assertEq(cp.sumWad, 0);
        assertEq(cp.count, 0);
        assertFalse(cp.flagged);
        // once per UTC day
        vm.expectRevert(SnapshotAlreadyTaken.selector);
        fx.snapshot(PAIR, new bytes[](0));
        vm.warp(block.timestamp + DAY);
        _pythAt(110_000_000, 50_000, block.timestamp - 10);
        _snap();
        assertEq(fx.getFxPair(PAIR).sumWad, 2.18e18);
    }

    function test_snapshotValidation() public {
        vm.expectRevert(abi.encodeWithSelector(FxPairDisabled.selector, bytes32("nope")));
        fx.snapshot(bytes32("nope"), new bytes[](0));
        // stale (older than 3600 s)
        _pythAt(108_000_000, 50_000, block.timestamp - 3601);
        vm.expectRevert(MockPyth.StalePrice.selector);
        fx.snapshot(PAIR, new bytes[](0));
        // non-positive price
        _pythAt(-1, 0, block.timestamp);
        vm.expectRevert(InvalidPythPrice.selector);
        fx.snapshot(PAIR, new bytes[](0));
        // confidence wider than 1%
        _pythAt(108_000_000, 1_080_001, block.timestamp);
        vm.expectRevert(PythConfidenceTooWide.selector);
        fx.snapshot(PAIR, new bytes[](0));
        _pythAt(108_000_000, 1_080_000, block.timestamp); // exactly 1% is allowed
        _snap();
        // value sent without update data is refused
        vm.deal(keeper, 1 ether);
        vm.warp(block.timestamp + DAY);
        vm.prank(keeper);
        vm.expectRevert(PythUpdateFeeInsufficient.selector);
        fx.snapshot{value: 1}(PAIR, new bytes[](0));
    }

    function test_snapshotWithPythUpdateAndFeeRefund() public {
        MockPyth paidPyth = new MockPyth(1 gwei);
        vm.prank(address(timelock));
        fx.setPyth(address(paidPyth));
        bytes[] memory data = new bytes[](1);
        data[0] = abi.encode(FEED, int64(108_000_000), uint64(50_000), int32(-8), block.timestamp);
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
        bytes32 inv = keccak256("USD/JPY->JPY/USD");
        vm.prank(admin);
        registry.setFxPair(inv, FEED, true, address(0), true);
        _pythAt(150_000_000_00, 1_000_000, block.timestamp); // 150.00 with expo -8
        vm.prank(keeper);
        fx.snapshot(inv, new bytes[](0));
        // floor(1e36 / 150e18) = 6_666_666_666_666_666
        assertEq(fx.getFxPair(inv).sumWad, 6_666_666_666_666_666);
    }

    function test_quarterAverageCoverageAndFallback() public {
        uint32 p = Periods.periodOf(block.timestamp); // Q1 2026, 90 days
        (bool ok,) = fx.quarterAverage(PAIR, p);
        assertFalse(ok); // no checkpoints yet
        // 71 snapshots < 80% of 90 (= 72)
        uint64 start = Periods.periodStart(p);
        for (uint64 d = 0; d < 71; d++) {
            vm.warp(start + d * DAY + 1);
            _pythAt(108_000_000, 50_000, block.timestamp);
            _snap();
        }
        // opening the next period closes this one
        vm.warp(Periods.periodEnd(p) + 1);
        _pythAt(108_000_000, 50_000, block.timestamp);
        _snap();
        (ok, ) = fx.quarterAverage(PAIR, p);
        assertFalse(ok); // NeedsFallback: low coverage
        // 72 snapshots is enough (80% of 90)
        uint32 p2 = p + 1; // 91 days → need 73
        start = Periods.periodStart(p2);
        for (uint64 d = 1; d < 73; d++) {
            vm.warp(start + d * DAY + 1);
            _pythAt(d % 2 == 0 ? int64(108_000_000) : int64(110_000_000), 50_000, block.timestamp);
            _snap();
        }
        vm.warp(Periods.periodEnd(p2) + 1);
        _pythAt(108_000_000, 50_000, block.timestamp);
        _snap();
        (ok, ) = fx.quarterAverage(PAIR, p2);
        // count in p2 = 1 (day 0, from the closing snapshot above) + 72 = 73 ≥ 72.8 → ok
        assertTrue(ok);
    }

    function test_deviationFlagsPeriod() public {
        vm.prank(admin);
        registry.setFxPair(PAIR, FEED, false, address(chainlink), true);
        chainlink.setAnswer(108_000_000, block.timestamp); // 1.08 at 8 decimals
        _pythAt(108_500_000, 50_000, block.timestamp); // 0.46% off: within the 2% band
        _snap();
        uint32 p = Periods.periodOf(block.timestamp);
        assertFalse(fx.getFxCheckpoint(PAIR, p).flagged);
        vm.warp(block.timestamp + DAY);
        chainlink.setAnswer(108_000_000, block.timestamp);
        _pythAt(111_000_000, 50_000, block.timestamp); // 2.78% off
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesFxAccumulator.FxDeviationFlagged(PAIR, p, 1.11e18, 1.08e18);
        fx.snapshot(PAIR, new bytes[](0));
        assertTrue(fx.getFxCheckpoint(PAIR, p).flagged);
        // a stale cross-check also flags (conservative)
        vm.warp(block.timestamp + DAY);
        _pythAt(108_000_000, 50_000, block.timestamp);
        vm.prank(keeper);
        vm.expectEmit(true, false, false, true);
        emit IMercesFxAccumulator.FxDeviationFlagged(PAIR, p, 1.08e18, 0);
        fx.snapshot(PAIR, new bytes[](0));
    }

    function test_reportWithFxAverageAndFallback() public {
        // series with EUR income: fx pair required
        uint256 sid = runStandardRaise(TierFlags.TIER2_ZKTLS, PAIR, Proofs.fxQ1().termsCommitment);
        // cover Q1 2026 at a constant 1.10 so the quarter average is exactly 1.1e18 (fxQ1 proof)
        _coverPeriod(Q1_2026, 110_000_000);
        vm.warp(Periods.periodEnd(Q1_2026) + 1);
        _pythAt(110_000_000, 110_000, block.timestamp - 60);
        _snap();
        (bool ok, uint64 avg) = fx.quarterAverage(PAIR, Q1_2026);
        assertTrue(ok);
        assertEq(avg, 1.1e18);
        // report must carry the on-chain average
        IMercesIncome.ReportInput memory r = reportInput(sid, Q1_2026, Proofs.fxQ1(), 2, false);
        r.fxAvgWad = 1e18;
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(FxMismatch.selector, 1.1e18, 1e18));
        income.submitReport(r);
        r = reportInput(sid, Q1_2026, Proofs.fxQ1(), 2, false);
        r.fxFallbackSignature = sign(attestorKey, MercesMessages.fxDigest(domain, sid, Q1_2026, 1.1e18));
        vm.prank(issuer);
        vm.expectRevert(FxFallbackNotNeeded.selector);
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
        // q2 proves fx = 1.0; its payment is 12,000 → attestor must sign rate 1e18
        vm.prank(issuer);
        vm.expectRevert(FxFallbackSignatureRequired.selector);
        income.submitReport(r2);
        r2.fxFallbackSignature = sign(0xDEAD, MercesMessages.fxDigest(domain, sid, Q1_2026 + 1, 1e18));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AttestorNotRegistered.selector, vm.addr(0xDEAD)));
        income.submitReport(r2);
        r2.fxFallbackSignature = sign(attestorKey, MercesMessages.fxDigest(domain, sid, Q1_2026 + 1, 1e18));
        // but q2 was proven against the USD terms and q1's prior commitment → proof fails
        vm.prank(issuer);
        vm.expectRevert(InvalidProof.selector);
        income.submitReport(r2);
    }
}
