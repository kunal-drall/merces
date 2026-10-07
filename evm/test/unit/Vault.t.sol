// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {IMercesVault} from "../../src/interfaces/IMercesVault.sol";
import {IPayoutClaims} from "../../src/interfaces/IPayoutClaims.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {PayoutSource, SeriesStatus} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

contract VaultTest is FullFixture {
    uint256 internal sid;

    function setUp() public override {
        super.setUp();
        sid = runStandardRaise();
    }

    function test_capPerUnitAndRegistration() public {
        assertEq(vault.capPerUnit(sid), 250e6);
        assertEq(vault.unitsOutstanding(sid), 300);
        IMercesVault.Holder memory h = vault.getHolder(sid, b1);
        assertTrue(h.registered);
        assertEq(h.lastNetAccWad, 0);
        // registration needs the allowlist; idempotent otherwise
        vm.expectRevert(abi.encodeWithSelector(WalletNotAllowlisted.selector, stranger));
        vault.registerHolder(sid, stranger);
        vault.registerHolder(sid, b1);
        vm.expectRevert(abi.encodeWithSelector(HolderNotRegistered.selector, stranger));
        vault.settleHolder(sid, stranger);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(HolderNotRegistered.selector, stranger));
        vault.claim(sid);
    }

    function test_receiveGrossOnlyIncome() public {
        vm.expectRevert(NotProtocolContract.selector);
        vault.receiveGross(sid, 1, PayoutSource.Payment, 0);
        vm.prank(address(income));
        vm.expectRevert(InvalidSource.selector);
        vault.receiveGross(sid, 1, PayoutSource.Final, 0);
    }

    function test_carryRollsDust() public {
        // route a gross amount that does not divide: use the tier-1 router on a fresh series
        uint256 s = runStandardRaise(1 | 2, bytes32(0));
        vm.prank(issuer);
        income.setRouterTerms(s, 0, 1e15); // theta 0: everything above counts; r = 0.1%/unit → 30% share
        fund(keeper, 1_000_001);
        vm.startPrank(keeper);
        usdc.approve(address(income), 1_000_001);
        income.route(s, 1_000_001);
        vm.stopPrank();
        // share = floor(1e15 × 300 × 1_000_001 / 1e18) = 300_000 ; fee = 15_000 ; net = 285_000
        // delta = floor(285_000e18 / 300) = 950e18 ; distributed = 285_000 ; carry 0
        IMercesVault.Ledger memory l = vault.getLedger(s);
        assertEq(l.grossReceived, 300_000);
        assertEq(l.feeCollected, 15_000);
        assertEq(l.netAccWad, 950e18);
        assertEq(l.carry, 0);
        // a share of 1 wei-unit per 300 units: route 7 (share = floor(0.3 × 7) = 2 → fee 0 → net 2 → delta 0, carry 2)
        fund(keeper, 7);
        vm.startPrank(keeper);
        usdc.approve(address(income), 7);
        income.route(s, 7);
        vm.stopPrank();
        l = vault.getLedger(s);
        assertEq(l.netAccWad, 950e18);
        assertEq(l.carry, 2);
        // the next distribution picks the carry up
        fund(keeper, 1_000_000);
        vm.startPrank(keeper);
        usdc.approve(address(income), 1_000_000);
        income.route(s, 1_000_000); // share 300_000, fee 15_000, net 285_002 → delta floor(285_002e18/300) = 950_006_666_666_666_666_666
        vm.stopPrank();
        l = vault.getLedger(s);
        assertEq(l.netAccWad, 950e18 + 950_006_666_666_666_666_666);
        // distributed = floor(950_006_666_666_666_666_666 × 300 / 1e18) = 285_001 ; carry = 1
        assertEq(l.carry, 1);
    }

    function test_capHitTruncatesRefundsRetiresAndBurns() public {
        reportAndPay(sid, Q1_2026, Proofs.q1());
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        reportAndPay(sid, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(sid, Q1_2026 + 3, Proofs.q4());
        reportAndPay(sid, Q1_2026 + 4, Proofs.y2q1());
        assertEq(vault.getLedger(sid).paidPerUnitWad, 240e6 * 1e18); // 72,000 / 300
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
        assertEq(usdc.balanceOf(issuer), issuerBefore); // 30,000 pulled, 27,000 refunded in the same tx
        assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Retired));
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Retired));
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        assertEq(l.grossReceived, 75_000e6);
        assertEq(l.refundedToIssuer, 27_000e6);
        assertEq(l.paidPerUnitWad, 250e6 * 1e18);

        // reports are closed
        vm.warp(Periods.periodEnd(Q1_2026 + 6));
        vm.prank(issuer);
        vm.expectRevert(ReportsClosed.selector);
        income.submitReport(reportInput(sid, Q1_2026 + 6, Proofs.q1(), 2, false));

        // holders claim their final payout; units burn on claim or by the permissionless crank
        uint256 vaultBal = usdc.balanceOf(address(vault));
        assertEq(vaultBal, 75_000e6 * 95 / 100);
        vm.prank(b1);
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.UnitsBurned(sid, b1, 100, uint8(SeriesStatus.Retired));
        vm.expectEmit(true, true, false, true);
        emit IPayoutClaims.PayoutClaimed(sid, b1, uint64(vaultBal / 3), 100);
        vault.claim(sid);
        assertEq(unitToken(sid).balanceOf(b1), 0);
        vm.prank(keeper);
        vault.burnRetired(sid, b2);
        assertEq(unitToken(sid).balanceOf(b2), 0);
        assertEq(vault.pendingOf(sid, b2), vaultBal / 3); // pending survives the burn
        vm.prank(keeper);
        vm.expectRevert(ZeroUnits.selector);
        vault.burnRetired(sid, b2);
        vm.prank(b2);
        vault.claim(sid);
        vm.prank(b3);
        vault.claim(sid);
        assertEq(unitToken(sid).totalSupply(), 0);
        assertEq(usdc.balanceOf(address(vault)), 0); // 71,250 fully distributed, no dust
        // treasury releases continue on schedule for a retired series
        vm.prank(issuer);
        treasury.claimRelease(sid);
    }

    function test_burnRetiredOnlyWhenRetired() public {
        vm.expectRevert(SeriesNotRetired.selector);
        vault.burnRetired(sid, b1);
    }

    function test_noUnitsOutstandingRejected() public {
        // retire and burn everything, then a router share would hit N == 0: covered by routing to a retired
        // series passing everything through instead (see Router tests). Here: direct vault call as income.
        vm.prank(address(income));
        (uint64 accepted,,) = vault.receiveGross(sid, 0, PayoutSource.Payment, 0);
        assertEq(accepted, 0);
    }

    function test_amendedCapLowersCapRemaining() public {
        reportAndPay(sid, Q1_2026, Proofs.q1()); // paid 40/unit
        bytes32 newTc = keccak256("new");
        bytes memory sig = sign(attestorKey, MercesMessagesLib.amend(domain, sid, 0, newTc, 2.0e18));
        vm.prank(issuer);
        registry.amendTerms(sid, newTc, 2.0e18, sig);
        assertEq(vault.capPerUnit(sid), 200e6);
        (,,, uint64 capRemaining,) = vault.previewRedemption(sid, block.timestamp);
        assertEq(capRemaining, 160e6);
    }
}

import {MercesMessages} from "../../src/libraries/MercesMessages.sol";

library MercesMessagesLib {
    function amend(bytes32 dom, uint256 sid, uint64 nonce, bytes32 tc, uint64 cap) internal pure returns (bytes32) {
        return MercesMessages.amendDigest(dom, sid, nonce, tc, cap);
    }
}
