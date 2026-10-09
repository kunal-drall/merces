// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FreeReportFixture} from "../utils/FreeReportFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {LifecycleHandler} from "./LifecycleHandler.sol";
import {IMercesTreasury} from "../../src/interfaces/IMercesTreasury.sol";
import {IMercesVault} from "../../src/interfaces/IMercesVault.sol";
import {IMercesWindow} from "../../src/interfaces/IMercesWindow.sol";
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {ReleaseTranche, SeriesCore, SeriesTerms, TierFlags} from "../../src/types/MercesTypes.sol";

/// @notice Repayment, exit and transfer-window invariants (brief F2, SPEC v1.1 §2 hard limits, §6, §7), checked
/// after every handler call over random lives of one series:
/// - no unit ever receives more than its cap, counting payments, redemption and the tail;
/// - the vault holds exactly what its ledger says and always covers every claim (Σ claims ≤ vault balance);
/// - fees come only from the holders' side: every payment is either accepted for holders or refunded to the
///   issuer, and the fee collector holds exactly the auction, payout, tail and window fees;
/// - the treasury holds exactly proceeds − releases − funds moved at extinguishment; releases never run ahead of
///   the schedule and all reach the issuer;
/// - units move only through the window, burns and redemption; none is created or lost;
/// - each window conserves money exactly; charter fields never change; no admin path moves funds; no
///   recipient-side condition (allowlist removal) ever blocks a claim, a release, a window step or a payment.
contract LifecycleInvariantTest is FreeReportFixture {
    uint8 internal constant FLAGS = TierFlags.TIER2_ZKTLS | TierFlags.TIER3_ATTESTOR;
    LifecycleHandler internal handler;
    uint256 internal sid;
    uint256 internal auctionFees;
    bytes32 internal charterAtStart;
    IERC3643Token internal token;

    function setUp() public override {
        super.setUp();
        vm.prank(admin);
        registry.setFlags(false, true, false); // windows enabled
        sid = runStandardRaise(FLAGS, bytes32(0), Proofs.q1().termsCommitment, P0, 0); // no lockup
        installMockVerifier();
        vm.warp(Periods.periodEnd(Q1_2026)); // the first report is due from here
        token = unitToken(sid);
        address[] memory wallets = new address[](7);
        (wallets[0], wallets[1], wallets[2]) = (b1, b2, b3);
        for (uint256 i = 3; i < 7; i++) {
            wallets[i] = makeAddr(string.concat("lifeBuyer", vm.toString(i)));
            allow(wallets[i]);
        }
        LifecycleHandler.Env memory env;
        env.registry = registry;
        env.treasury = treasury;
        env.vault = vault;
        env.income = income;
        env.window = window;
        env.usdc = usdc;
        env.auction = address(auction);
        env.feeCollector = address(feeCollector);
        env.admin = admin;
        env.allowlistManager = allowlistManager;
        env.issuer = issuer;
        env.attestorKey = attestorKey;
        env.attestor2Key = attestor2Key;
        env.verifierKey = verifierKey;
        env.domain = domain;
        env.sid = sid;
        handler = new LifecycleHandler(env, wallets);
        auctionFees = usdc.balanceOf(address(feeCollector));
        charterAtStart = _charter();

        bytes4[] memory selectors = new bytes4[](25);
        selectors[0] = LifecycleHandler.warp.selector;
        selectors[1] = LifecycleHandler.report.selector;
        selectors[2] = LifecycleHandler.pay.selector;
        selectors[3] = LifecycleHandler.claim.selector;
        selectors[4] = LifecycleHandler.claimRelease.selector;
        selectors[5] = LifecycleHandler.setReleasePause.selector;
        selectors[6] = LifecycleHandler.hardship.selector;
        selectors[7] = LifecycleHandler.redeem.selector;
        selectors[8] = LifecycleHandler.claimExit.selector;
        selectors[9] = LifecycleHandler.extinguish.selector;
        selectors[10] = LifecycleHandler.retire.selector;
        selectors[11] = LifecycleHandler.openWindow.selector;
        selectors[12] = LifecycleHandler.windowOrder.selector;
        selectors[13] = LifecycleHandler.windowReveal.selector;
        selectors[14] = LifecycleHandler.windowSettle.selector;
        selectors[15] = LifecycleHandler.windowProcess.selector;
        selectors[16] = LifecycleHandler.setAllowed.selector;
        selectors[17] = LifecycleHandler.directTransfer.selector;
        selectors[18] = LifecycleHandler.adminAction.selector;
        // composite progression steps, weighted by listing them twice
        selectors[19] = LifecycleHandler.advanceQuarter.selector;
        selectors[20] = LifecycleHandler.advanceQuarter.selector;
        selectors[21] = LifecycleHandler.windowCycle.selector;
        selectors[22] = LifecycleHandler.windowProcess.selector;
        selectors[23] = LifecycleHandler.windowDeliver.selector;
        selectors[24] = LifecycleHandler.windowDeliver.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _charter() internal view returns (bytes32) {
        SeriesCore memory c = registry.getSeriesCore(sid);
        SeriesTerms memory t = registry.getSeriesTerms(sid);
        ReleaseTranche[] memory s = registry.getReleaseSchedule(sid);
        return keccak256(
            abi.encode(
                t,
                s,
                abi.encode(c.issuer, c.stablecoin, c.tierFlags, c.fxPairId, c.contractHash, c.termsCommitment),
                abi.encode(c.unitToken, c.settlementTs, c.unitsSold, c.clearingPrice, c.amendmentNonce)
            )
        );
    }

    function _wallet(uint256 i) internal view returns (address) {
        return handler.wallets(i);
    }

    // ---------------------------------------------------------------- invariants

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 200
    /// forge-config: ci.invariant.runs = 128
    /// forge-config: ci.invariant.depth = 300
    function invariant_capNeverExceeded() public view {
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        uint256 capWad = uint256(vault.capPerUnit(sid)) * 1e18;
        assertLe(l.paidPerUnitWad, capWad, "payments above the cap");
        assertLe(
            l.paidPerUnitWad + uint256(l.redemptionPrice) * 1e18 + l.tailPaidPerUnitWad,
            capWad,
            "payments + redemption + tail above the cap"
        );
        if (l.redemptionTs != 0) assertLe(l.tailPaidPerUnitWad, uint256(l.tailCapPerUnit) * 1e18);
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 200
    /// forge-config: ci.invariant.runs = 128
    /// forge-config: ci.invariant.depth = 300
    function invariant_vaultSolventAndExact() public view {
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        uint256 bal = usdc.balanceOf(address(vault));
        assertEq(
            bal,
            uint256(l.grossReceived) - l.feeCollected + l.tailGrossReceived - l.tailFeeCollected + l.redemptionDeposit
                + l.unreleasedReceived - l.claimedTotal,
            "vault balance != ledger"
        );
        uint256 owed;
        for (uint256 i = 0; i < handler.walletCount(); i++) {
            owed += _owedTo(_wallet(i), l);
        }
        if (l.redemptionTs != 0) {
            owed += uint256(l.redemptionPrice) * l.unitsOutstanding + l.tailAccWad * l.unitsOutstanding / 1e18;
        }
        assertGe(bal, owed, "claims exceed the vault balance");
        // and nothing is stranded: outside a half-processed window (whose post-clearing accrual is credited at
        // processing, C-S4) the excess is rounding dust, < 1 base unit per settle
        (bool exists, uint32 period) = window.currentWindow(sid);
        if (!exists || window.getWindow(sid, period).state == IMercesWindow.WindowState.Done) {
            assertLe(bal - owed, handler.calls() * 8 + 16, "value stranded in the vault");
        }
        assertEq(l.netAccWad * 300 + l.carryWad, (uint256(l.grossReceived) - l.feeCollected) * 1e18, "carry");
    }

    /// @dev What the vault owes `w` per holder record: pending payouts, the final share, and the tail of its
    /// redeemed units since its last tail claim. Units not yet redeemed (wallet, window escrow, in transit) are
    /// owed `redemption price + full tail` each and are counted in aggregate via `units_outstanding` (C-S21).
    function _owedTo(address w, IMercesVault.Ledger memory l) internal view returns (uint256 owed) {
        owed = vault.pendingOf(sid, w) + vault.claimableFinal(sid, w);
        if (l.redemptionTs == 0) return owed;
        IMercesVault.Holder memory h = vault.getHolder(sid, w);
        owed += (l.tailAccWad - h.lastTailAccWad) * h.redeemedUnits / 1e18;
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 200
    /// forge-config: ci.invariant.runs = 128
    /// forge-config: ci.invariant.depth = 300
    function invariant_feesOnlyFromHolderSide() public view {
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        uint256 windowFees;
        for (uint256 i = 0; i < handler.windowCount(); i++) {
            windowFees += window.getWindow(sid, handler.windowPeriods(i)).feesTotal;
        }
        assertEq(
            usdc.balanceOf(address(feeCollector)),
            auctionFees + l.feeCollected + l.tailFeeCollected + windowFees,
            "fee collector holds something other than fees"
        );
        assertEq(
            handler.paidIn(),
            uint256(l.grossReceived) + l.refundedToIssuer + l.tailGrossReceived + l.tailRefunded,
            "a payment was not fully accepted or refunded"
        );
        assertEq(handler.redemptionPaid(), l.redemptionDeposit, "redemption deposit");
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 200
    /// forge-config: ci.invariant.runs = 128
    /// forge-config: ci.invariant.depth = 300
    function invariant_treasuryFollowsSchedule() public view {
        IMercesTreasury.Ledger memory t = treasury.getTreasury(sid);
        assertEq(usdc.balanceOf(address(treasury)), uint256(t.deposited) - t.releasedTotal - t.movedToVault);
        uint256 asOf = t.extinguishedAt != 0 ? t.extinguishedAt : vm.getBlockTimestamp();
        assertLe(t.releasedTotal, treasury.vested(sid, asOf), "release ahead of the schedule");
        assertEq(handler.releasedToIssuer(), t.releasedTotal, "a release went somewhere other than the issuer");
        assertEq(t.deposited, 30_000e6);
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 200
    /// forge-config: ci.invariant.runs = 128
    /// forge-config: ci.invariant.depth = 300
    function invariant_unitsOnlyMoveThroughProtocol() public view {
        uint256 held;
        for (uint256 i = 0; i < handler.walletCount(); i++) {
            address w = _wallet(i);
            uint256 bal = token.balanceOf(w);
            assertEq(bal, handler.unitsGhost(w), "units moved outside the window, burns and redemption");
            held += bal;
        }
        uint256 escrow;
        for (uint256 i = 0; i < handler.windowCount(); i++) {
            escrow += window.getWindow(sid, handler.windowPeriods(i)).escrowUnits;
        }
        assertEq(token.balanceOf(address(window)), escrow);
        assertEq(held + escrow, token.totalSupply(), "units created or lost");
        assertEq(token.totalSupply(), vault.unitsOutstanding(sid));
        assertEq(token.balanceOf(address(auction)), 0);
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 200
    /// forge-config: ci.invariant.runs = 128
    /// forge-config: ci.invariant.depth = 300
    function invariant_windowConservation() public view {
        uint256 live;
        for (uint256 i = 0; i < handler.windowCount(); i++) {
            uint32 p = handler.windowPeriods(i);
            IMercesWindow.Window memory w = window.getWindow(sid, p);
            uint256 delivered;
            for (uint256 k = 0; k < w.orderCount; k++) {
                IMercesWindow.Order memory o = window.getOrderAt(sid, p, k);
                if (o.delivered) delivered += o.pendingStable;
            }
            assertEq(
                uint256(w.escrowStable), handler.bidEscrowIn(p) - w.feesTotal - delivered, "window money not conserved"
            );
            live += w.escrowStable;
        }
        assertEq(usdc.balanceOf(address(window)), live, "window holds more than its live escrow");
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 200
    /// forge-config: ci.invariant.runs = 128
    /// forge-config: ci.invariant.depth = 300
    function invariant_charterFrozen() public view {
        assertEq(_charter(), charterAtStart, "charter fields changed");
    }

    /// forge-config: default.invariant.runs = 48
    /// forge-config: default.invariant.depth = 200
    /// forge-config: ci.invariant.runs = 128
    /// forge-config: ci.invariant.depth = 300
    function invariant_noForbiddenPathAndLiveness() public view {
        assertFalse(handler.forbiddenSucceeded(), handler.lastFailure());
        assertFalse(handler.livenessBroken(), handler.lastFailure());
    }

    /// @dev Liveness: any open window can always be finished and every holder can always claim.
    function afterInvariant() external {
        (bool exists, uint32 period) = window.currentWindow(sid);
        if (exists && window.getWindow(sid, period).state != IMercesWindow.WindowState.Done) {
            IMercesWindow.Window memory w = window.getWindow(sid, period);
            if (vm.getBlockTimestamp() < w.revealEnd) vm.warp(w.revealEnd);
            handler.windowSettle();
            for (uint256 i = 0; i < 64; i++) {
                if (window.getWindow(sid, period).state == IMercesWindow.WindowState.Done) break;
                handler.windowProcess(i);
            }
            assertEq(uint8(window.getWindow(sid, period).state), uint8(IMercesWindow.WindowState.Done));
        }
        handler.deliverAll(); // every delivery can always be made
        for (uint256 i = 0; i < handler.walletCount(); i++) {
            assertEq(window.pendingUnitsOf(sid, _wallet(i)), 0);
        }
        for (uint256 i = 0; i < handler.walletCount(); i++) {
            handler.claim(i, i % 2 == 0);
        }
        for (uint256 i = 0; i < handler.walletCount(); i++) {
            assertEq(vault.pendingOf(sid, _wallet(i)), 0, "a claim left value behind");
        }
        invariant_noForbiddenPathAndLiveness();
        invariant_vaultSolventAndExact();
        invariant_windowConservation();
    }
}
