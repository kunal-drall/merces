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

contract VaultTest is FullFixture {
    uint256 internal sid;

    function setUp() public override {
        super.setUp();
        sid = runStandardRaise();
    }

    function _route(uint256 s, uint64 amount) internal {
        fund(keeper, amount);
        vm.startPrank(keeper);
        usdc.approve(address(router), amount);
        router.route(s, amount);
        vm.stopPrank();
    }

    function test_supplyCapAndRegistration() public {
        assertEq(vault.capPerUnit(sid), 250e6);
        assertEq(vault.capEffWad(sid), 250e6 * 1e18);
        assertEq(vault.unitsOutstanding(sid), 300);
        assertTrue(vault.getLedger(sid).supplySet);
        IMercesVault.Holder memory h = vault.getHolder(sid, b1);
        assertTrue(h.registered);
        assertEq(h.lastNetAccWad, 0);
        // registration by outsiders needs the allowlist; the auction and the window register unconditionally
        vm.expectRevert(abi.encodeWithSelector(WalletNotAllowlisted.selector, stranger));
        vault.registerHolder(sid, stranger);
        vault.registerHolder(sid, b1); // idempotent
        vm.prank(address(auction));
        vault.registerHolder(sid, stranger);
        assertTrue(vault.getHolder(sid, stranger).registered);
        vm.expectRevert(abi.encodeWithSelector(HolderNotRegistered.selector, keeper));
        vault.settleHolder(sid, keeper);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(HolderNotRegistered.selector, keeper));
        vault.claim(sid);
        // supply is written once by the auction
        vm.prank(address(auction));
        vm.expectRevert(SupplyAlreadySet.selector);
        vault.initializeSupply(sid, 1);
        vm.expectRevert(NotProtocolContract.selector);
        vault.initializeSupply(sid, 1);
    }

    function test_receiveGrossGuards() public {
        vm.expectRevert(NotProtocolContract.selector);
        vault.receiveGross(sid, 1, PayoutSource.Payment, 0);
        vm.prank(address(income));
        vm.expectRevert(InvalidSource.selector);
        vault.receiveGross(sid, 1, PayoutSource.Final, 0);
        uint256 draft = createSeries(keccak256("d"));
        vm.prank(address(income));
        vm.expectRevert(MintNotFinalized.selector);
        vault.receiveGross(draft, 1, PayoutSource.Payment, 0);
        vm.prank(address(income));
        vm.expectRevert(SeriesNotRedeemed.selector);
        vault.receiveGross(sid, 1, PayoutSource.Tail, 0);
        // a zero gross is a no-op distribution
        vm.prank(address(income));
        (uint64 accepted,,) = vault.receiveGross(sid, 0, PayoutSource.Payment, Q1_2026);
        assertEq(accepted, 0);
    }

    /// @dev Exact WAD carry (reference defect S1): the remainder of every distribution is carried as a WAD
    /// quantity, so the sum of holder claims never exceeds the vault balance.
    function test_exactCarry() public {
        uint256 s = runStandardRaise(TierFlags.TIER1_SPLIT, bytes32(0)); // θ = 80,000, r × 300 units = 30 %
        _route(s, 80_000e6); // consumes θ: everything to the issuer
        _route(s, 1_000_001); // share = floor(0.3 × 1_000_001) = 300_000; fee 15_000; net 285_000 → 950 / unit
        IMercesVault.Ledger memory l = vault.getLedger(s);
        assertEq(l.grossReceived, 300_000);
        assertEq(l.feeCollected, 15_000);
        assertEq(l.netAccWad, 950e18);
        assertEq(l.carryWad, 0);
        _route(s, 7); // share 2, fee 0: num = 2e18 → delta = 6_666_666_666_666_666, carry 200 wei-WAD
        l = vault.getLedger(s);
        assertEq(l.netAccWad, 950e18 + 6_666_666_666_666_666);
        assertEq(l.carryWad, 200);
        _route(s, 1_000_000); // net 285_000: num = 285_000e18 + 200 → delta 950e18, carry still 200
        l = vault.getLedger(s);
        assertEq(l.netAccWad, 1900e18 + 6_666_666_666_666_666);
        assertEq(l.carryWad, 200);
        _route(s, 7); // num = 2e18 + 200 → delta 6_666_666_666_666_667, carry 100
        l = vault.getLedger(s);
        assertEq(l.netAccWad, 1900e18 + 13_333_333_333_333_333);
        assertEq(l.carryWad, 100);
        // Σ claimable ≤ vault balance (570_004): each holder floor(netAcc × 100 / WAD) = 190_001
        uint256 claimable = vault.pendingOf(s, b1) + vault.pendingOf(s, b2) + vault.pendingOf(s, b3);
        assertEq(vault.pendingOf(s, b1), 190_001);
        assertEq(usdc.balanceOf(address(vault)), 570_004);
        assertLe(claimable, usdc.balanceOf(address(vault)));
        vm.prank(b1);
        vault.claim(s);
        vm.prank(b2);
        vault.claim(s);
        vm.prank(b3);
        vault.claim(s);
        assertEq(usdc.balanceOf(address(vault)), 1);
    }

    function test_capHitTruncatesRefundsRetiresAndBurns() public {
        reportAndPay(sid, Q1_2026, Proofs.q1());
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        reportAndPay(sid, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(sid, Q1_2026 + 3, Proofs.q4());
        reportAndPay(sid, Q1_2026 + 4, Proofs.y2q1());
        assertEq(vault.getLedger(sid).paidPerUnitWad, 240e6 * 1e18); // 72,000 / 300
        vm.expectRevert(NotCapped.selector);
        vault.retireIfCapped(sid);
        // y2q2: 30,000 due, only 3,000 of cap room (10 USDC × 300)
        submitReport(sid, Q1_2026 + 5, Proofs.y2q2cap());
        uint256 issuerBefore = usdc.balanceOf(issuer);
        fund(issuer, 30_000e6);
        vm.startPrank(issuer);
        usdc.approve(address(income), 30_000e6);
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.PayoutDistributed(
            sid, PayoutSource.Payment, 30_000e6, 3_000e6, 150e6, 2_850e6, 9.5e6 * 1e18, 250e6 * 1e18, true
        );
        vm.expectEmit(true, false, false, true);
        emit IMercesVault.SeriesRetired(sid, 250e6 * 1e18, 27_000e6);
        vm.expectEmit(true, true, false, true);
        emit IMercesIncome.PaymentSettled(sid, Q1_2026 + 5, 30_000e6, 0, 150e6, 3_000e6, 27_000e6);
        income.pay(sid);
        vm.stopPrank();
        assertEq(usdc.balanceOf(issuer), issuerBefore + 27_000e6); // 30,000 pulled, 27,000 refunded in the same tx
        assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Retired));
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Retired));
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        assertEq(l.grossReceived, 75_000e6);
        assertEq(l.refundedToIssuer, 27_000e6);
        assertEq(l.paidPerUnitWad, 250e6 * 1e18);
        vm.expectRevert(SeriesTerminal.selector);
        vault.retireIfCapped(sid);

        // reports and true-ups are closed
        vm.warp(Periods.periodEnd(Q1_2026 + 6));
        vm.prank(issuer);
        vm.expectRevert(TerminalStatus.selector);
        income.submitReport(reportInput(sid, Q1_2026 + 6, Proofs.q1(), 2, false));
        vm.prank(issuer);
        vm.expectRevert(TerminalStatus.selector);
        income.submitTrueUp(sid, 2026, 1, 1, "");

        // holders claim their final payout; units burn on claim or by the permissionless crank
        uint256 vaultBal = usdc.balanceOf(address(vault));
        assertEq(vaultBal, 71_250e6);
        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.PayoutClaimed(sid, b1, 23_750e6, 100);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.UnitsBurned(sid, b1, 100, uint8(SeriesStatus.Retired));
        vault.claim(sid);
        assertEq(unitToken(sid).balanceOf(b1), 0);
        assertEq(vault.unitsOutstanding(sid), 200);
        vm.prank(keeper);
        vault.burnRetired(sid, b2);
        assertEq(unitToken(sid).balanceOf(b2), 0);
        assertEq(vault.unitsOutstanding(sid), 100);
        assertEq(vault.pendingOf(sid, b2), 23_750e6); // pending survives the burn
        vm.prank(keeper);
        vm.expectRevert(ZeroUnits.selector);
        vault.burnRetired(sid, b2);
        vm.prank(b2);
        vault.claim(sid);
        vm.prank(b3);
        vault.claim(sid);
        assertEq(unitToken(sid).totalSupply(), 0);
        assertEq(vault.unitsOutstanding(sid), 0);
        assertEq(usdc.balanceOf(address(vault)), 0); // 71,250 fully distributed, no dust
        // treasury releases continue on schedule for a retired series
        vm.prank(issuer);
        treasury.claimRelease(sid);
        assertEq(treasury.getTreasury(sid).releasedTotal, 30_000e6);
    }

    function test_burnRetiredOnlyWhenRetired() public {
        vm.expectRevert(SeriesNotRetired.selector);
        vault.burnRetired(sid, b1);
    }

    function test_loweredCapAppliesLiveAndRetireIfCapped() public {
        reportAndPay(sid, Q1_2026, Proofs.q1()); // paid 40/unit
        bytes32 newTc = keccak256("new");
        vm.prank(issuer);
        registry.amendTerms(
            sid, newTc, 2.0e18, sign(attestorKey, MercesMessages.amendDigest(domain, sid, 0, newTc, 2.0e18)), noTier1()
        );
        assertEq(vault.capPerUnit(sid), 200e6);
        (,,, uint64 capRemaining,) = vault.previewRedemption(sid, block.timestamp);
        assertEq(capRemaining, 160e6);
        vm.expectRevert(NotCapped.selector);
        vault.retireIfCapped(sid);
        // pay up to 240/unit, then lower the cap below what was paid: the effective cap is what was paid
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        reportAndPay(sid, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(sid, Q1_2026 + 3, Proofs.q4()); // 220/unit, above the 200 cap → the series retires here
        assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Retired));
        assertEq(vault.getLedger(sid).paidPerUnitWad, 200e6 * 1e18);
        assertEq(vault.getLedger(sid).refundedToIssuer, 6_000e6); // 42,000 due, 36,000 of room
    }

    function test_retireIfCappedAfterAmendment() public {
        reportAndPay(sid, Q1_2026, Proofs.q1());
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2()); // 80/unit paid
        bytes32 newTc = keccak256("new");
        // cap multiple 2.0 → 200/unit: not met yet
        vm.prank(issuer);
        registry.amendTerms(
            sid, newTc, 2.0e18, sign(attestorKey, MercesMessages.amendDigest(domain, sid, 0, newTc, 2.0e18)), noTier1()
        );
        vm.expectRevert(NotCapped.selector);
        vault.retireIfCapped(sid);
        reportAndPay(sid, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(sid, Q1_2026 + 3, Proofs.q4()); // 220 > 200 → retires with a 6,000 refund
        assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Retired));
        // cap_eff = max(cap, paid): a cap lowered below what was paid never underflows
        assertEq(vault.capEffWad(sid), 200e6 * 1e18);
        uint256 s2 = runStandardRaise();
        reportAndPay(s2, Q1_2026 + 4, Proofs.y2q1()); // first period of s2 is Q1 2027
        bytes32 tc2 = keccak256("new2");
        vm.prank(issuer);
        registry.amendTerms(
            s2, tc2, 2.0e18, sign(attestorKey, MercesMessages.amendDigest(domain, s2, 0, tc2, 2.0e18)), noTier1()
        );
        assertEq(vault.capEffWad(s2), 200e6 * 1e18);
    }

    function test_noUnitsOutstandingRejected() public {
        // after a retirement burns everything, N == 0: a direct payment can no longer be distributed
        reportAndPay(sid, Q1_2026, Proofs.q1());
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        reportAndPay(sid, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(sid, Q1_2026 + 3, Proofs.q4());
        reportAndPay(sid, Q1_2026 + 4, Proofs.y2q1());
        reportAndPay(sid, Q1_2026 + 5, Proofs.y2q2cap());
        vm.prank(keeper);
        vault.burnRetired(sid, b1);
        vm.prank(keeper);
        vault.burnRetired(sid, b2);
        vm.prank(keeper);
        vault.burnRetired(sid, b3);
        assertEq(vault.unitsOutstanding(sid), 0);
        vm.prank(address(income));
        vm.expectRevert(NoUnitsOutstanding.selector);
        vault.receiveGross(sid, 1, PayoutSource.Payment, Q1_2026);
    }

    function test_accrualWeightIncludesEscrowedUnits() public {
        // units minted to the auction escrow but not yet delivered still earn (SPEC §6.1 accrual weight)
        uint256 s = standardSeries(TierFlags.TIER2_ZKTLS | TierFlags.TIER3_ATTESTOR, bytes32(0));
        allow(b1);
        openRaise(s);
        uint64 escrow = escrowFor(P0, 100);
        commit(s, plan(b1, P0, 100, escrow));
        commit(s, plan(b2, P0, 100, escrow));
        commit(s, plan(b3, P0, 100, escrow));
        warpToReveal(s);
        reveal(s, plan(b1, P0, 100, escrow));
        reveal(s, plan(b2, P0, 100, escrow));
        reveal(s, plan(b3, P0, 100, escrow));
        warpToSettle(s);
        settle(s, P0, 0, 300);
        processAll(s); // minted to the auction, nothing delivered
        assertEq(unitToken(s).balanceOf(b1), 0);
        assertEq(vault.accrualUnits(s, b1), 100);
        reportAndPay(s, Periods.periodOf(settlementTs(s)), Proofs.q1());
        assertEq(vault.pendingOf(s, b1), 3_800e6);
        vm.prank(keeper);
        auction.deliverBid(s, 0);
        assertEq(vault.pendingOf(s, b1), 3_800e6); // delivery is not a change of weight
        vm.prank(b1);
        vault.claim(s);
        assertEq(usdc.balanceOf(b1), 3_800e6);
    }

    function test_yearGrossRingIsTaggedByDueDate() public {
        // Q4 2026's due date (Jan 31 2027) falls in settlement year 1 although the period is in 2026
        reportAndPay(sid, Q1_2026, Proofs.q1());
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        reportAndPay(sid, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(sid, Q1_2026 + 3, Proofs.q4());
        assertEq(vault.yearGrossWad(sid, 0), 80e6 * 1e18); // 24,000 / 300
        assertEq(vault.yearGrossWad(sid, 1), 140e6 * 1e18); // 42,000 / 300
        assertEq(vault.yearGrossWad(sid, 2), 0);
        assertEq(vault.yearGrossWad(sid, 4), 0); // slot 0 again, but tagged for year 0
    }
}
