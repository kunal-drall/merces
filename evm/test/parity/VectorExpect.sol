// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {VectorActions} from "./VectorActions.sol";
import {IMercesAuction} from "../../src/interfaces/IMercesAuction.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {IMercesTreasury} from "../../src/interfaces/IMercesTreasury.sol";
import {IMercesVault} from "../../src/interfaces/IMercesVault.sol";
import {IMercesWindow} from "../../src/interfaces/IMercesWindow.sol";
import {IMercesFxAccumulator} from "../../src/interfaces/IMercesFxAccumulator.sol";
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
import {RaiseState, SeriesCore, SeriesStatus} from "../../src/types/MercesTypes.sol";

/// @notice `expect` steps (SPEC §11): every field present must match to the base unit. The per-series money views
/// are read from the contracts' own accounting (the protocol contracts hold every series' funds) and the sums are
/// cross-checked against the real token balances.
abstract contract VectorExpect is VectorActions {
    uint256 internal constant WAD = 1e18;

    function _expect(string memory b) internal {
        bool hasSeries = _has(_f(b, "series"));
        uint256 sid = hasSeries ? _series(_s(_f(b, "series"))) : 0;
        if (_has(_f(b, "balances"))) _checkBalances(_f(b, "balances"), sid);
        if (_has(_f(b, "feeCollector"))) {
            assertEq(usdc.balanceOf(feeCollector), _u(_f(b, "feeCollector")), _where("feeCollector"));
        }
        _checkPools();
        if (hasSeries) {
            _checkSeriesMoney(b, sid);
            if (_has(_f(b, "ledger"))) {
                _checkLedgerRaise(_f(b, "ledger"), sid);
                _checkLedgerVault(_f(b, "ledger"), sid);
                _checkLedgerIncome(_f(b, "ledger"), sid);
                _checkLedgerExit(_f(b, "ledger"), sid);
            }
            if (_has(_f(b, "auction"))) _checkAuction(_f(b, "auction"), sid);
            if (_has(_f(b, "window"))) _checkWindow(_f(b, "window"), sid);
            if (_has(_f(b, "holders"))) _checkHolders(_f(b, "holders"), sid);
        }
        if (_has(_f(b, "fx"))) _checkFx(_f(b, "fx"));
    }

    // ---------------------------------------------------------------- balances and pools

    function _checkBalances(string memory b, uint256 sid) internal view {
        string[] memory names = vm.parseJsonKeys(json, b);
        IERC3643Token token = sid == 0 ? IERC3643Token(address(0)) : _token(sid);
        for (uint256 i = 0; i < names.length; i++) {
            string memory e = string.concat(b, ".", names[i]);
            address who = _addr(names[i]);
            assertEq(usdc.balanceOf(who), _u(_f(e, "stable")), _where(string.concat("balance ", names[i])));
            if (_has(_f(e, "units"))) {
                uint256 units = address(token) == address(0) ? 0 : token.balanceOf(who);
                assertEq(units, _u(_f(e, "units")), _where(string.concat("units ", names[i])));
            }
        }
    }

    function _treasuryBalance(uint256 sid) internal view returns (uint256) {
        IMercesTreasury.Ledger memory t = treasury.getTreasury(sid);
        return uint256(t.deposited) - t.releasedTotal - t.movedToVault;
    }

    /// @dev Stablecoin the vault holds for one series: distributions net of fees, redemption deposit, unreleased
    /// treasury funds, minus everything claimed.
    function _vaultBalance(uint256 sid) internal view returns (uint256) {
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        return uint256(l.grossReceived) - l.feeCollected + l.tailGrossReceived - l.tailFeeCollected
            + l.redemptionDeposit + l.unreleasedReceived - l.claimedTotal;
    }

    function _windowEscrow(uint256 sid) internal view returns (bool exists, IMercesWindow.Window memory w) {
        uint32 period;
        (exists, period) = window.currentWindow(sid);
        if (exists) w = window.getWindow(sid, period);
    }

    /// @dev The per-series views sum to the contracts' real balances (nothing is held that no series accounts for).
    function _checkPools() internal view {
        uint256 t;
        uint256 v;
        uint256 a;
        uint256 wStable;
        for (uint256 i = 0; i < seriesList.length; i++) {
            uint256 sid = seriesList[i];
            t += _treasuryBalance(sid);
            v += _vaultBalance(sid);
            a += auction.getAuction(sid).escrowTotal;
            (bool exists, IMercesWindow.Window memory w) = _windowEscrow(sid);
            if (exists) wStable += w.escrowStable;
        }
        assertEq(usdc.balanceOf(address(treasury)), t, _where("treasury pool"));
        assertEq(usdc.balanceOf(address(vault)), v, _where("vault pool"));
        assertEq(usdc.balanceOf(address(auction)), a, _where("auction pool"));
        assertEq(usdc.balanceOf(address(window)), wStable, _where("window pool"));
    }

    function _checkSeriesMoney(string memory b, uint256 sid) internal view {
        if (_has(_f(b, "treasury"))) assertEq(_treasuryBalance(sid), _u(_f(b, "treasury")), _where("treasury"));
        if (_has(_f(b, "vault"))) assertEq(_vaultBalance(sid), _u(_f(b, "vault")), _where("vault"));
        if (_has(_f(b, "auctionEscrow"))) {
            assertEq(auction.getAuction(sid).escrowTotal, _u(_f(b, "auctionEscrow")), _where("auctionEscrow"));
        }
        if (_has(_f(b, "routerBalance"))) {
            assertEq(usdc.balanceOf(router.routerReceiver(sid)), _u(_f(b, "routerBalance")), _where("routerBalance"));
        }
        (, IMercesWindow.Window memory w) = _windowEscrow(sid);
        if (_has(_f(b, "windowEscrowStable"))) {
            assertEq(w.escrowStable, _u(_f(b, "windowEscrowStable")), _where("windowEscrowStable"));
        }
        if (_has(_f(b, "windowEscrowUnits"))) {
            assertEq(w.escrowUnits, _u(_f(b, "windowEscrowUnits")), _where("windowEscrowUnits"));
            if (address(_token(sid)) != address(0) && w.escrowUnits > 0) {
                assertEq(_token(sid).balanceOf(address(window)), w.escrowUnits, _where("window units pool"));
            }
        }
    }

    // ---------------------------------------------------------------- ledger view

    function _eqU(string memory b, string memory field, uint256 actual) internal view {
        assertEq(actual, _u(_f(b, field)), _where(_f(b, field)));
    }

    function _eqNullable(string memory b, string memory field, bool present, uint256 actual) internal view {
        string memory key = _f(b, field);
        if (_isNull(key)) {
            assertFalse(present, _where(string.concat(field, " should be null")));
        } else {
            assertTrue(present, _where(string.concat(field, " should not be null")));
            assertEq(actual, _u(key), _where(field));
        }
    }

    function _checkLedgerRaise(string memory b, uint256 sid) internal view {
        SeriesCore memory c = registry.getSeriesCore(sid);
        IMercesAuction.Auction memory a = auction.getAuction(sid);
        IMercesTreasury.Ledger memory t = treasury.getTreasury(sid);
        assertEq(_statusName(income.deriveStatus(sid)), _s(_f(b, "status")), _where("ledger.status"));
        string memory rs = c.raiseState == RaiseState.Draft ? "Draft" : _raiseName(a.state);
        assertEq(rs, _s(_f(b, "raiseState")), _where("ledger.raiseState"));
        assertEq(a.mintFinalized, _b(_f(b, "mintFinalized")), _where("ledger.mintFinalized"));
        _eqU(b, "unitsSold", a.unitsSold);
        _eqU(b, "clearingPrice", a.clearingPrice);
        _eqU(b, "proceeds", t.deposited);
        _eqU(b, "releasedTotal", t.releasedTotal);
        _eqU(b, "capMultipleWad", registry.getSeriesTerms(sid).capMultipleWad);
        assertEq(c.termsCommitment, _h(_f(b, "termsCommitment")), _where("ledger.termsCommitment"));
        _eqU(b, "amendmentNonce", c.amendmentNonce);
        _eqU(b, "capPerUnit", a.state == RaiseState.Settled ? vault.capPerUnit(sid) : 0);
    }

    function _checkLedgerVault(string memory b, uint256 sid) internal view {
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        _eqU(b, "unitsOutstanding", l.unitsOutstanding);
        _eqU(b, "paidPerUnitWad", l.paidPerUnitWad);
        _eqU(b, "netAccWad", l.netAccWad);
        _eqU(b, "carryWad", l.carryWad);
        _eqU(b, "carry", l.carryWad / WAD);
        _eqU(b, "grossReceived", l.grossReceived);
        _eqU(b, "feeCollected", l.feeCollected);
        _eqU(b, "refundedToIssuer", l.refundedToIssuer);
    }

    function _checkLedgerIncome(string memory b, uint256 sid) internal view {
        IMercesIncome.Ledger memory l = income.getLedger(sid);
        _eqNullable(b, "lastAcceptedPeriod", l.hasAccepted, l.lastAcceptedPeriod);
        _eqNullable(b, "lastPaidPeriod", l.hasPaid, l.lastPaidPeriod);
        _eqNullable(b, "openDuePeriod", l.openDueAmount > 0, l.openDuePeriod);
        _eqU(b, "openDueAmount", l.openDueAmount);
        _eqU(b, "routerCredit", l.routerCredit);
        _eqU(b, "trueupNonce", l.trueupNonce);
        _eqU(b, "trueupDue", l.trueupDue);
        _eqU(b, "trueupAttestedAt", l.trueupAttestedAt);
        _eqNullable(b, "lastTrueupYear", l.hasLastTrueupYear, l.lastTrueupYear);
        _eqU(b, "pauseNonce", l.pauseNonce);
        _eqU(b, "pauseCount", income.getPauses(sid).length);
        _eqU(b, "pausedTotal", l.pausedTotal);
        _eqNullable(b, "formalNoticeEmittedFor", l.hasFormalNotice, l.formalNoticeEmittedFor);
    }

    function _checkLedgerExit(string memory b, uint256 sid) internal view {
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        _eqU(b, "redemptionPrice", l.redemptionPrice);
        _eqU(b, "unitsAtRedemption", l.unitsAtRedemption);
        _eqU(b, "tailCapPerUnit", l.tailCapPerUnit);
        _eqU(b, "tailAccWad", l.tailAccWad);
        assertEq(l.tailExhausted, _b(_f(b, "tailExhausted")), _where("ledger.tailExhausted"));
        _eqU(b, "extinguishedAt", l.extinguishedAt);
        _eqU(b, "finalAccWad", l.finalAccWad);
        _eqU(b, "finalUnits", l.finalUnits);
        _eqU(b, "extinguishNonce", l.extinguishNonce);
    }

    // ---------------------------------------------------------------- auction, window, holders

    function _checkAuction(string memory b, uint256 sid) internal view {
        IMercesAuction.Auction memory a = auction.getAuction(sid);
        _eqU(b, "bidCount", a.bidCount);
        _eqU(b, "revealedCount", a.revealedCount);
        _eqU(b, "validCount", a.validCount);
        _eqU(b, "escrowTotal", a.escrowTotal);
        _eqU(b, "auctionEscrowUnits", a.escrowUnits);
        _eqU(b, "tallyRound", a.tallyRound);
        assertEq(a.roundRejected, _b(_f(b, "roundRejected")), _where("auction.roundRejected"));
        if (_isNull(_f(b, "rejectionReason"))) {
            assertEq(a.rejectionReason, 0, _where("auction.rejectionReason null"));
        } else {
            string memory reason = a.rejectionReason == 1 ? "ClaimMismatch" : "InvalidClearingPrice";
            assertTrue(a.rejectionReason != 0, _where("auction.rejectionReason set"));
            assertEq(reason, _s(_f(b, "rejectionReason")), _where("auction.rejectionReason"));
        }
        _eqU(b, "clearingPrice", a.clearingPrice);
        _eqU(b, "qAbove", a.qAbove);
        _eqU(b, "qAt", a.qAt);
        _eqU(b, "R", a.R);
        _eqU(b, "unitsSold", a.unitsSold);
        _eqU(b, "proceeds", a.proceeds);
        _eqU(b, "unitsMinted", a.unitsMinted);
        _eqU(b, "bidsProcessed", a.bidsProcessed);
        assertEq(a.mintFinalized, _b(_f(b, "mintFinalized")), _where("auction.mintFinalized"));
        if (a.escrowUnits > 0) {
            assertEq(_token(sid).balanceOf(address(auction)), a.escrowUnits, _where("auction units pool"));
        }
    }

    function _checkWindow(string memory b, uint256 sid) internal view {
        (bool exists, IMercesWindow.Window memory w) = _windowEscrow(sid);
        assertTrue(exists, _where("window exists"));
        _eqU(b, "period", w.period);
        assertEq(_windowStateName(w.state), _s(_f(b, "state")), _where("window.state"));
        _eqU(b, "tallyRound", w.tallyRound);
        assertEq(w.roundRejected, _b(_f(b, "roundRejected")), _where("window.roundRejected"));
        bool cleared = w.branch != IMercesWindow.Branch.None;
        _eqNullable(b, "clearingPrice", cleared, w.clearingPrice);
        if (_isNull(_f(b, "branch"))) {
            assertFalse(cleared, _where("window.branch null"));
        } else {
            string memory br = w.branch == IMercesWindow.Branch.SupplyLimited ? "SupplyLimited" : "DemandLimited";
            assertEq(br, _s(_f(b, "branch")), _where("window.branch"));
        }
        _eqU(b, "matchedUnits", cleared ? w.matchedUnits : 0);
        _eqU(b, "escrowStable", w.escrowStable);
        _eqU(b, "escrowUnits", w.escrowUnits);
    }

    function _checkHolders(string memory b, uint256 sid) internal view {
        string[] memory names = vm.parseJsonKeys(json, b);
        for (uint256 i = 0; i < names.length; i++) {
            string memory e = string.concat(b, ".", names[i]);
            address who = _addr(names[i]);
            IMercesVault.Holder memory h = vault.getHolder(sid, who);
            assertTrue(h.registered, _where(string.concat("holder registered ", names[i])));
            assertEq(h.pending, _u(_f(e, "pending")), _where(string.concat("holder.pending ", names[i])));
            assertEq(h.redeemedUnits, _u(_f(e, "redeemedUnits")), _where(string.concat("redeemedUnits ", names[i])));
            (bool hasBid, IMercesAuction.Bid memory bid) = _bidOf(sid, who);
            bool open = hasBid && bid.processed && !bid.delivered;
            assertEq(
                open ? bid.pendingUnits : 0, _u(_f(e, "pendingUnits")), _where(string.concat("pendingUnits ", names[i]))
            );
            assertEq(
                open ? bid.pendingRefund : 0,
                _u(_f(e, "pendingRefund")),
                _where(string.concat("pendingRefund ", names[i]))
            );
            assertEq(
                hasBid ? bid.delivered : true, _b(_f(e, "delivered")), _where(string.concat("delivered ", names[i]))
            );
        }
        // the vector lists every registered holder: count the registered wallets among the actors
        _checkNoExtraHolders(b, sid, names.length);
    }

    function _checkNoExtraHolders(string memory, uint256 sid, uint256 listed) internal view {
        string[] memory actors = vm.parseJsonStringArray(json, ".actors");
        uint256 registered;
        for (uint256 i = 0; i < actors.length; i++) {
            if (vault.getHolder(sid, _addr(actors[i])).registered) registered++;
        }
        assertEq(registered, listed, _where("registered holders"));
    }

    function _bidOf(uint256 sid, address who) internal view returns (bool, IMercesAuction.Bid memory bid) {
        try auction.getBid(sid, who) returns (IMercesAuction.Bid memory b) {
            return (true, b);
        } catch {
            return (false, bid);
        }
    }

    // ---------------------------------------------------------------- FX accumulator

    function _checkFx(string memory b) internal view {
        string[] memory pairIds = vm.parseJsonKeys(json, b);
        for (uint256 i = 0; i < pairIds.length; i++) {
            string memory e = string.concat(b, ".", pairIds[i]);
            bytes32 pairId = vm.parseBytes32(pairIds[i]);
            IMercesFxAccumulator.FxPairState memory st = fx.getFxPair(pairId);
            assertEq(st.sumWad, _u(_f(e, "sumWad")), _where("fx.sumWad"));
            assertEq(st.count, _u(_f(e, "count")), _where("fx.count"));
            string[] memory periods = vm.parseJsonKeys(json, _f(e, "quarters"));
            for (uint256 j = 0; j < periods.length; j++) {
                _checkQuarter(string.concat(e, ".quarters.", periods[j]), pairId, uint32(vm.parseUint(periods[j])));
            }
        }
    }

    function _checkQuarter(string memory q, bytes32 pairId, uint32 period) internal view {
        (bool available, bool ok, uint256 avg, uint32 n, bool flagged) = fx.quarterStats(pairId, period);
        assertEq(ok, _b(_f(q, "ok")), _where("fx.quarter.ok"));
        _eqNullable(q, "avgWad", available, avg);
        assertEq(n, _u(_f(q, "n")), _where("fx.quarter.n"));
        assertEq(flagged, _b(_f(q, "flagged")), _where("fx.quarter.flagged"));
    }

    // ---------------------------------------------------------------- enum names

    function _statusName(SeriesStatus s) internal pure returns (string memory) {
        string[7] memory n = ["OnTime", "InGrace", "Late", "Paused", "Retired", "Redeemed", "Extinguished"];
        return n[uint8(s)];
    }

    function _raiseName(RaiseState s) internal pure returns (string memory) {
        string[7] memory n = ["Draft", "Open", "Reveal", "Settling", "Settled", "Failed", "Cancelled"];
        return n[uint8(s)];
    }

    function _windowStateName(IMercesWindow.WindowState s) internal pure returns (string memory) {
        string[7] memory n = ["None", "Commit", "Reveal", "Settling", "Settled", "NoMatch", "Done"];
        return n[uint8(s)];
    }
}
