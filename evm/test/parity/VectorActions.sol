// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {VectorStack} from "./VectorStack.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {IMercesWindow} from "../../src/interfaces/IMercesWindow.sol";
import {IMercesAuction} from "../../src/interfaces/IMercesAuction.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Flags, RaiseState, ReleaseTranche, SeriesMode, SeriesParams, Tier1Terms} from "../../src/types/MercesTypes.sol";

/// @notice Executes one SPEC §11 action (`call`) against the EVM stack. Every protocol call is made with a single
/// `vm.prank` immediately before it (no other external call in between), so a reverting call never leaves a prank
/// behind. Commitments and signed messages are recomputed from the plaintext step fields with the chain's own
/// encodings (wallet bytes, domain): bid/ask commitments through the contracts' `bidCommitment` /
/// `orderCommitment` (which apply the u64 entry rule), §1.4 digests through `MercesMessages`.
abstract contract VectorActions is VectorStack {
    uint256 internal constant MAX = type(uint256).max;

    /// @dev Entry point for `this.exec(base)` (an external self-call so a revert can be caught and compared).
    function exec(string calldata base) external {
        require(msg.sender == address(this), "self only");
        bytes32 op = keccak256(bytes(_s(_f(base, "op"))));
        if (_execRegistry(base, op)) return;
        if (_execRaise(base, op)) return;
        if (_execRepayment(base, op)) return;
        if (_execExit(base, op)) return;
        if (_execWindow(base, op)) return;
        revert(string.concat("unsupported op ", _s(_f(base, "op"))));
    }

    // ================================================================ registry, keys, flags, FX pairs

    function _execRegistry(string memory b, bytes32 op) internal returns (bool) {
        if (op == keccak256("fund")) {
            usdc.mint(_addr(_s(_f(b, "actor"))), _u(_f(b, "amount")));
        } else if (op == keccak256("allowlist")) {
            bool allowed = _has(_f(b, "allowed")) ? _b(_f(b, "allowed")) : true;
            string[] memory wallets = vm.parseJsonStringArray(json, _f(b, "wallets"));
            for (uint256 i = 0; i < wallets.length; i++) {
                address w = _addr(wallets[i]);
                vm.prank(allowlistManager);
                registry.setAllowed(w, allowed);
            }
        } else if (op == keccak256("register_issuer")) {
            address w = _addr(_s(_f(b, "wallet")));
            vm.prank(admin);
            registry.registerIssuer(w);
        } else if (op == keccak256("deactivate_issuer")) {
            address w = _addr(_s(_f(b, "wallet")));
            vm.prank(admin);
            registry.deactivateIssuer(w);
        } else if (op == keccak256("register_attestor")) {
            address k = _addr(_s(_f(b, "key")));
            vm.prank(admin);
            registry.registerAttestor(k);
        } else if (op == keccak256("revoke_attestor")) {
            address k = _addr(_s(_f(b, "key")));
            vm.prank(admin);
            registry.revokeAttestor(k);
        } else if (op == keccak256("register_verifier_key")) {
            address k = _addr(_s(_f(b, "key")));
            vm.prank(admin);
            registry.registerVerifierKey(k);
        } else if (op == keccak256("revoke_verifier_key")) {
            address k = _addr(_s(_f(b, "key")));
            vm.prank(admin);
            registry.revokeVerifierKey(k);
        } else if (op == keccak256("set_flags")) {
            _setFlags(b);
        } else if (op == keccak256("set_fx_pair")) {
            _setFxPair(b);
        } else if (op == keccak256("create_series")) {
            _createSeries(b);
        } else if (op == keccak256("set_contract_hash")) {
            uint256 sid = _series(_s(_f(b, "series")));
            bytes32 h = _h(_f(b, "contractHash"));
            address issuer = _addr(_s(_f(b, "actor")));
            vm.prank(issuer);
            registry.setContractHash(sid, h);
        } else if (op == keccak256("stop_issuance")) {
            address issuer = _addr(_s(_f(b, "actor")));
            vm.prank(issuer);
            registry.stopIssuance();
        } else if (op == keccak256("resume_issuance")) {
            address issuer = _addr(_s(_f(b, "actor")));
            vm.prank(issuer);
            registry.resumeIssuance();
        } else if (op == keccak256("amend_terms")) {
            _amendTerms(b);
        } else {
            return false;
        }
        return true;
    }

    function _setFlags(string memory b) internal {
        Flags memory f = registry.getFlags();
        if (_has(_f(b, "newRaisesPaused"))) f.newRaisesPaused = _b(_f(b, "newRaisesPaused"));
        if (_has(_f(b, "windowsEnabled"))) f.windowsEnabled = _b(_f(b, "windowsEnabled"));
        if (_has(_f(b, "tier4Enabled"))) f.tier4Enabled = _b(_f(b, "tier4Enabled"));
        vm.prank(admin);
        registry.setFlags(f.newRaisesPaused, f.windowsEnabled, f.tier4Enabled);
    }

    /// @dev `crosscheck: true` configures a Chainlink cross-check feed (a mock aggregator the snapshot steps feed).
    function _setFxPair(string memory b) internal {
        bytes32 feedId = _h(_f(b, "feedId"));
        bool inverted = _b(_f(b, "inverted"));
        bytes32 pairId = registry.fxPairId(feedId, inverted);
        address cc = _b(_f(b, "crosscheck")) ? address(_aggregator(pairId)) : address(0);
        vm.prank(admin);
        registry.setFxPair(feedId, inverted, cc);
        pairs[pairId].exists = true;
        pairs[pairId].feedId = feedId;
    }

    function _createSeries(string memory b) internal {
        SeriesParams memory p = _seriesParams(_f(b, "terms"));
        ReleaseTranche[] memory schedule = _schedule(_f(b, "releaseSchedule"));
        bytes32 tc = _h(_f(b, "termsCommitment"));
        uint8 tierFlags = uint8(_u(_f(b, "tierFlags")));
        bytes32 pair = _isNull(_f(b, "fxPairId")) ? bytes32(0) : _h(_f(b, "fxPairId"));
        string memory name = _s(_f(b, "series"));
        Tier1Terms memory t1 = _tier1(b, name);
        address issuer = _addr(_s(_f(b, "actor")));
        vm.prank(issuer);
        uint256 sid = registry.createSeries(p, schedule, tc, tierFlags, pair, SeriesMode.SealedBid, false, t1);
        seriesIds[keccak256(bytes(name))] = sid;
        if (!knownSeries[sid]) {
            knownSeries[sid] = true;
            seriesList.push(sid);
        }
        if (!_isNull(_f(b, "contractHash"))) {
            bytes32 h = _h(_f(b, "contractHash"));
            vm.prank(issuer);
            registry.setContractHash(sid, h);
        }
    }

    /// @dev The issuer chooses every term within bounds; fees and the non-reveal charge are protocol economics
    /// (registry defaults) and must equal the vector's values.
    function _seriesParams(string memory t) internal view returns (SeriesParams memory p) {
        p.stablecoin = address(usdc);
        p.unitsOffered = _u(_f(t, "unitsOffered"));
        p.reservePrice = _u(_f(t, "reservePrice"));
        p.minRaise = _u(_f(t, "minRaise"));
        p.capMultipleWad = _u(_f(t, "capMultipleWad"));
        p.hurdleRateWad = _u(_f(t, "hurdleRateWad"));
        p.payoutMultipleK = _u(_f(t, "payoutMultipleK"));
        p.lockupSeconds = _u(_f(t, "lockupSeconds"));
        p.walletCapBps = _u(_f(t, "walletCapBps"));
        p.commitDuration = _u(_f(t, "commitDuration"));
        p.revealDuration = _u(_f(t, "revealDuration"));
        p.windowCommitDuration = _u(_f(t, "windowCommitDuration"));
        p.windowRevealDuration = _u(_f(t, "windowRevealDuration"));
        require(_u(_f(t, "auctionFeeBps")) == registry.getDefaults().auctionFeeBps, "auction fee != default");
        require(_u(_f(t, "payoutFeeBps")) == registry.getDefaults().payoutFeeBps, "payout fee != default");
        require(_u(_f(t, "windowFeeBps")) == registry.getDefaults().windowFeeBps, "window fee != default");
        require(_u(_f(t, "nonRevealChargeBps")) == registry.getDefaults().nonRevealChargeBps, "charge != default");
    }

    function _schedule(string memory s) internal view returns (ReleaseTranche[] memory out) {
        uint256 n = _len(s);
        out = new ReleaseTranche[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = ReleaseTranche({
                atOffsetSeconds: uint64(_u(_f(_at(s, i), "atOffsetSeconds"))), bps: uint16(_u(_f(_at(s, i), "bps")))
            });
        }
    }

    function _len(string memory arr) internal view returns (uint256 n) {
        while (_has(_at(arr, n))) n++;
    }

    /// @dev Router terms: θ and r from the step, currency / indexing rule / salt from `seriesPrivate` (the plaintext
    /// behind the commitment, checked on-chain through Poseidon(5)).
    function _tier1(string memory b, string memory name) internal view returns (Tier1Terms memory t) {
        if (!_has(_f(b, "router"))) return t;
        t.theta = _u(_f(b, "router.theta"));
        t.rWad = _u(_f(b, "router.rWad"));
        string memory sp = string.concat(".seriesPrivate.", name, ".termsPlain");
        if (_has(sp)) {
            t.currencyCode = uint32(_u(_f(sp, "currencyCode")));
            t.indexingRule = uint32(_u(_f(sp, "indexingRule")));
            t.termsSalt = _u(_f(sp, "termsSalt"));
        }
    }

    function _amendTerms(string memory b) internal {
        uint256 sid = _series(_s(_f(b, "series")));
        bytes32 tc = _h(_f(b, "newTermsCommitment"));
        uint256 cap = _u(_f(b, "newCapMultipleWad"));
        uint64 nonce = registry.getSeriesCore(sid).amendmentNonce;
        bytes memory sig =
            _sign(_s(_f(b, "attestor")), MercesMessages.amendDigest(registry.domain(), sid, nonce, tc, uint64(cap)));
        Tier1Terms memory none;
        address actor = _addr(_s(_f(b, "actor")));
        vm.prank(actor);
        registry.amendTerms(sid, tc, cap, sig, none);
    }

    // ================================================================ raise path (SPEC §5)

    function _execRaise(string memory b, bytes32 op) internal returns (bool) {
        if (op == keccak256("open_raise")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address issuer = _addr(_s(_f(b, "actor")));
            vm.prank(issuer);
            auction.openRaise(sid);
        } else if (op == keccak256("cancel_raise")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address issuer = _addr(_s(_f(b, "actor")));
            vm.prank(issuer);
            auction.cancelRaise(sid);
        } else if (op == keccak256("commit_bid")) {
            _commitBid(b);
        } else if (op == keccak256("reveal_bid")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address bidder = _addr(_s(_f(b, "actor")));
            uint256 price = _u(_f(b, "price"));
            uint256 qty = _u(_f(b, "quantity"));
            bytes32 salt = _h(_f(b, "salt"));
            vm.prank(bidder);
            auction.revealBid(sid, price, qty, salt);
        } else if (op == keccak256("begin_settlement")) {
            uint256 sid = _series(_s(_f(b, "series")));
            uint256 p = _u(_f(b, "clearingPrice"));
            uint256 qa = _u(_f(b, "qAboveClaim"));
            uint256 qt = _u(_f(b, "qAtClaim"));
            vm.prank(keeper);
            auction.beginSettlement(sid, p, qa, qt);
        } else if (op == keccak256("finalize_settlement")) {
            _finalizeSettlement(_series(_s(_f(b, "series"))));
        } else if (op == keccak256("process_bid")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address bidder = _addr(_s(_f(b, "bidder")));
            vm.prank(keeper);
            auction.processBid(sid, bidder);
        } else if (op == keccak256("deliver_bid")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address bidder = _addr(_s(_f(b, "bidder")));
            vm.prank(keeper);
            auction.deliverBid(sid, bidder);
        } else if (op == keccak256("claim_release")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address issuer = _addr(_s(_f(b, "actor")));
            vm.prank(issuer);
            treasury.claimRelease(sid);
        } else if (op == keccak256("set_release_pause")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address issuer = _addr(_s(_f(b, "actor")));
            bool paused = _b(_f(b, "paused"));
            vm.prank(issuer);
            treasury.setReleasePause(sid, paused);
        } else {
            return false;
        }
        return true;
    }

    function _commitBid(string memory b) internal {
        uint256 sid = _series(_s(_f(b, "series")));
        address bidder = _addr(_s(_f(b, "actor")));
        bytes32 c = auction.bidCommitment(_u(_f(b, "price")), _u(_f(b, "quantity")), _h(_f(b, "salt")), bidder);
        uint256 escrow = _u(_f(b, "escrow"));
        vm.prank(bidder);
        usdc.approve(address(auction), escrow);
        vm.prank(bidder);
        auction.commitBid(sid, c, escrow);
    }

    /// @dev A vector `finalize_settlement` tallies every revealed bid (all pages) and finalizes (SPEC §5.2).
    function _finalizeSettlement(uint256 sid) internal {
        IMercesAuction.Auction memory a = auction.getAuction(sid);
        if (a.state == RaiseState.Settling && !a.roundRejected) {
            for (uint256 from = 0; from < a.bidCount; from += 200) {
                uint256 to = from + 200 > a.bidCount ? a.bidCount : from + 200;
                vm.prank(keeper);
                auction.tallyBids(sid, from, to);
            }
        }
        vm.prank(keeper);
        auction.finalizeSettlement(sid);
    }

    // ================================================================ repayment path (SPEC §6.1–§6.6)

    function _execRepayment(string memory b, bytes32 op) internal returns (bool) {
        if (op == keccak256("submit_report")) {
            _submitReport(b);
        } else if (op == keccak256("pay")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address payer = _addr(_s(_f(b, "actor")));
            vm.prank(payer);
            usdc.approve(address(income), MAX);
            vm.prank(payer);
            income.pay(sid);
        } else if (op == keccak256("submit_trueup")) {
            _submitTrueup(b);
        } else if (op == keccak256("pay_trueup")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address payer = _addr(_s(_f(b, "actor")));
            vm.prank(payer);
            usdc.approve(address(income), MAX);
            vm.prank(payer);
            income.payTrueUp(sid);
        } else if (op == keccak256("crank_status")) {
            uint256 sid = _series(_s(_f(b, "series")));
            vm.prank(keeper);
            income.crankStatus(sid);
        } else if (op == keccak256("request_pause")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address issuer = _addr(_s(_f(b, "actor")));
            vm.prank(issuer);
            income.requestPause(sid);
        } else if (op == keccak256("withdraw_pause_request")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address issuer = _addr(_s(_f(b, "actor")));
            vm.prank(issuer);
            income.withdrawPauseRequest(sid);
        } else if (op == keccak256("approve_pause")) {
            _approvePause(b);
        } else if (op == keccak256("end_pause")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address issuer = _addr(_s(_f(b, "actor")));
            vm.prank(issuer);
            income.endPause(sid);
        } else if (op == keccak256("route_income")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address payer = _addr(_s(_f(b, "payer")));
            uint256 amount = _u(_f(b, "amount"));
            vm.prank(payer);
            usdc.approve(address(router), MAX);
            vm.prank(payer);
            router.route(sid, amount);
        } else if (op == keccak256("close_router_period")) {
            uint256 sid = _series(_s(_f(b, "series")));
            uint32 period = uint32(_u(_f(b, "period")));
            vm.prank(keeper);
            router.closeRouterPeriod(sid, period);
        } else if (op == keccak256("fx_snapshot")) {
            _fxSnapshot(b);
        } else {
            return false;
        }
        return true;
    }

    function _submitReport(string memory b) internal {
        uint256 sid = _series(_s(_f(b, "series")));
        IMercesIncome.ReportInput memory r;
        r.seriesId = sid;
        r.period = uint32(_u(_f(b, "period")));
        r.paymentUsd = _u(_f(b, "paymentUsd"));
        r.fxAvgWad = _u(_f(b, "fxAvgWad"));
        r.priorIncomeCommitment = _h(_f(b, "priorIncomeCommitment"));
        r.incomeCommitment = _h(_f(b, "incomeCommitment"));
        r.tier = uint8(_u(_f(b, "tier")));
        r.liquidityEvent = _b(_f(b, "liquidityEvent"));
        string memory pe = _f(b, "proofEvm");
        r.proof.a = [_u(_f(pe, "pA[0]")), _u(_f(pe, "pA[1]"))];
        r.proof.b = [[_u(_f(pe, "pB[0][0]")), _u(_f(pe, "pB[0][1]"))], [_u(_f(pe, "pB[1][0]")), _u(_f(pe, "pB[1][1]"))]];
        r.proof.c = [_u(_f(pe, "pC[0]")), _u(_f(pe, "pC[1]"))];
        bytes32 dom = registry.domain();
        if (!_isNull(_f(b, "fxFallback"))) {
            r.fxFallbackSignature = _sign(
                _s(_f(b, "fxFallback.attestor")), MercesMessages.fxDigest(dom, sid, r.period, uint64(r.fxAvgWad))
            );
        }
        if (!_isNull(_f(b, "attestation"))) {
            r.attestationSignature = _sign(
                _s(_f(b, "attestation")),
                MercesMessages.reportDigest(
                    dom, sid, r.period, r.priorIncomeCommitment, r.incomeCommitment, r.tier, r.liquidityEvent
                )
            );
        }
        address issuer = _addr(_s(_f(b, "actor")));
        vm.prank(issuer);
        income.submitReport(r);
    }

    /// @dev The attestor signs over the step's `nonce` (the chain verifies against its stored `trueup_nonce`).
    function _submitTrueup(string memory b) internal {
        uint256 sid = _series(_s(_f(b, "series")));
        uint16 year = uint16(_u(_f(b, "year")));
        int256 adj = _i(_f(b, "adjustment"));
        uint256 ts = _u(_f(b, "attestationTs"));
        uint64 nonce = uint64(_u(_f(b, "nonce")));
        bytes memory sig = _sign(
            _s(_f(b, "attestor")),
            MercesMessages.trueupDigest(registry.domain(), sid, nonce, year, int64(adj), uint64(ts))
        );
        address issuer = _addr(_s(_f(b, "actor")));
        vm.prank(issuer);
        income.submitTrueUp(sid, year, adj, ts, sig);
    }

    /// @dev The attestor signs the §1.4 pause message over the current `pause_nonce`; a keeper submits it.
    function _approvePause(string memory b) internal {
        uint256 sid = _series(_s(_f(b, "series")));
        uint256 pauseEnd = _u(_f(b, "pauseEnd"));
        uint64 nonce = income.getLedger(sid).pauseNonce;
        bytes memory sig =
            _sign(_s(_f(b, "attestor")), MercesMessages.pauseDigest(registry.domain(), sid, nonce, uint64(pauseEnd)));
        vm.prank(keeper);
        income.approvePause(sid, pauseEnd, sig);
    }

    /// @dev Pyth-shaped price (and the Chainlink cross-check answer when the step carries one) at the step's time.
    function _fxSnapshot(string memory b) internal {
        bytes32 pairId = _h(_f(b, "pairId"));
        FxInfo storage info = pairs[pairId];
        bytes32 feed = info.exists ? info.feedId : pairId;
        int256 price = _i(_f(b, "price"));
        int256 expo = _i(_f(b, "expo"));
        pyth.setPrice(feed, int64(price), uint64(_u(_f(b, "conf"))), int32(expo), _u(_f(b, "publishTime")));
        if (_has(_f(b, "crosscheckPrice")) && info.crosscheck != address(0)) {
            int256 ce = _has(_f(b, "crosscheckExpo")) ? _i(_f(b, "crosscheckExpo")) : expo;
            _aggregator(pairId).setDecimals(uint8(uint256(-ce)));
            _aggregator(pairId).setAnswer(_i(_f(b, "crosscheckPrice")), vm.getBlockTimestamp());
        }
        vm.prank(keeper);
        fx.snapshot(pairId, new bytes[](0));
    }

    // ================================================================ exit path (SPEC §6.3, §6.7–§6.9)

    function _execExit(string memory b, bytes32 op) internal returns (bool) {
        if (op == keccak256("claim")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address holder = _addr(_s(_f(b, "actor")));
            vm.prank(holder);
            vault.claim(sid);
        } else if (op == keccak256("register_holder")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address holder = _addr(_s(_f(b, "holder")));
            vm.prank(keeper);
            vault.registerHolder(sid, holder);
        } else if (op == keccak256("burn_retired")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address holder = _addr(_s(_f(b, "holder")));
            vm.prank(keeper);
            vault.burnRetired(sid, holder);
        } else if (op == keccak256("retire_if_capped")) {
            uint256 sid = _series(_s(_f(b, "series")));
            vm.prank(keeper);
            vault.retireIfCapped(sid);
        } else if (op == keccak256("redeem")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address issuer = _addr(_s(_f(b, "actor")));
            vm.prank(issuer);
            usdc.approve(address(vault), MAX);
            vm.prank(issuer);
            vault.redeem(sid);
        } else if (op == keccak256("claim_redemption")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address holder = _addr(_s(_f(b, "actor")));
            vm.prank(holder);
            vault.claimRedemption(sid);
        } else if (op == keccak256("claim_tail")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address holder = _addr(_s(_f(b, "actor")));
            vm.prank(holder);
            vault.claimTail(sid);
        } else if (op == keccak256("extinguish")) {
            _extinguish(b);
        } else if (op == keccak256("claim_final")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address holder = _addr(_s(_f(b, "actor")));
            vm.prank(holder);
            vault.claimFinal(sid);
        } else if (op == keccak256("transfer_units")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address from = _addr(_s(_f(b, "actor")));
            address to = _addr(_s(_f(b, "to")));
            uint256 units = _u(_f(b, "units"));
            address token = address(_token(sid));
            vm.prank(from);
            (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, units));
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        } else {
            return false;
        }
        return true;
    }

    function _extinguish(string memory b) internal {
        uint256 sid = _series(_s(_f(b, "series")));
        bytes32 dg = MercesMessages.extinguishDigest(registry.domain(), sid, vault.getLedger(sid).extinguishNonce);
        bytes memory sa = _sign(_s(_f(b, "attestors[0]")), dg);
        bytes memory sb = _sign(_s(_f(b, "attestors[1]")), dg);
        vm.prank(keeper);
        vault.extinguish(sid, sa, sb);
    }

    // ================================================================ transfer window (SPEC §7)

    function _execWindow(string memory b, bytes32 op) internal returns (bool) {
        if (op == keccak256("open_window")) {
            uint256 sid = _series(_s(_f(b, "series")));
            uint32 period = uint32(_u(_f(b, "period")));
            vm.prank(keeper);
            window.openWindow(sid, period);
        } else if (op == keccak256("commit_ask")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address owner = _addr(_s(_f(b, "actor")));
            bytes32 c = window.orderCommitment(_u(_f(b, "price")), _u(_f(b, "quantity")), _h(_f(b, "salt")), owner);
            uint256 units = _u(_f(b, "units"));
            address token = address(_token(sid));
            vm.prank(owner);
            (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", address(window), units));
            require(ok, "unit approve");
            vm.prank(owner);
            window.commitAsk(sid, c, units);
        } else if (op == keccak256("window_commit_bid")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address owner = _addr(_s(_f(b, "actor")));
            bytes32 c = window.orderCommitment(_u(_f(b, "price")), _u(_f(b, "quantity")), _h(_f(b, "salt")), owner);
            uint256 escrow = _u(_f(b, "escrow"));
            vm.prank(owner);
            usdc.approve(address(window), escrow);
            vm.prank(owner);
            window.commitBid(sid, c, escrow);
        } else if (op == keccak256("reveal_order")) {
            uint256 sid = _series(_s(_f(b, "series")));
            address owner = _addr(_s(_f(b, "actor")));
            uint256 price = _u(_f(b, "price"));
            uint256 qty = _u(_f(b, "quantity"));
            bytes32 salt = _h(_f(b, "salt"));
            vm.prank(owner);
            window.revealOrder(sid, price, qty, salt);
        } else if (op == keccak256("begin_window_settlement")) {
            uint256 sid = _series(_s(_f(b, "series")));
            bool noMatch = keccak256(bytes(_s(_f(b, "clearingPrice")))) == keccak256("NO_MATCH");
            uint256 p = noMatch ? 0 : _u(_f(b, "clearingPrice"));
            vm.prank(keeper);
            window.beginWindowSettlement(sid, p, noMatch);
        } else if (op == keccak256("finalize_window")) {
            _finalizeWindow(_series(_s(_f(b, "series"))));
        } else if (op == keccak256("process_orders")) {
            _processOrders(_series(_s(_f(b, "series"))));
        } else {
            return false;
        }
        return true;
    }

    /// @dev Tallies every revealed order (all pages), then finalizes.
    function _finalizeWindow(uint256 sid) internal {
        (bool exists, uint32 period) = window.currentWindow(sid);
        if (exists) {
            IMercesWindow.Window memory w = window.getWindow(sid, period);
            if (w.state == IMercesWindow.WindowState.Settling && !w.roundRejected) {
                for (uint256 from = 0; from < w.orderCount; from += 200) {
                    uint256 to = from + 200 > w.orderCount ? w.orderCount : from + 200;
                    vm.prank(keeper);
                    window.tallyOrders(sid, from, to);
                }
            }
        }
        vm.prank(keeper);
        window.finalizeWindow(sid);
    }

    /// @dev Processes every order of the current window: bids, then (when the take-back of cancelled buyers'
    /// units reaches below `p*`) the ask price index, then asks — the reference's single `process_orders` step.
    function _processOrders(uint256 sid) internal {
        (bool exists, uint32 period) = window.currentWindow(sid);
        IMercesWindow.Window memory w;
        if (exists) w = window.getWindow(sid, period);
        if (
            !exists || (w.state != IMercesWindow.WindowState.Settled && w.state != IMercesWindow.WindowState.NoMatch)
                || w.orderCount == 0
        ) {
            address first = exists && w.orderCount > 0 ? window.getOrderAt(sid, period, 0).owner : address(0);
            vm.prank(keeper);
            window.processOrder(sid, first); // reverts with the window's own error
            return;
        }
        _processSide(sid, period, w.orderCount, IMercesWindow.Side.Bid);
        if (window.priceIndexRequired(sid)) _indexAskPrices(sid, period, w.orderCount);
        _processSide(sid, period, w.orderCount, IMercesWindow.Side.Ask);
    }

    function _processSide(uint256 sid, uint32 period, uint256 n, IMercesWindow.Side side) internal {
        for (uint256 i = 0; i < n; i++) {
            IMercesWindow.Order memory o = window.getOrderAt(sid, period, i);
            if (o.side != side || o.processed) continue;
            vm.prank(keeper);
            window.processOrder(sid, o.owner);
        }
    }

    /// @dev Distinct valid ask prices below `p*`, ascending.
    function _indexAskPrices(uint256 sid, uint32 period, uint256 n) internal {
        uint64 p = window.getWindow(sid, period).clearingPrice;
        uint64[] memory levels = new uint64[](n);
        uint256 k;
        for (uint256 i = 0; i < n; i++) {
            IMercesWindow.Order memory o = window.getOrderAt(sid, period, i);
            if (o.side != IMercesWindow.Side.Ask || !o.revealed || !o.valid || o.price >= p) continue;
            bool seen;
            for (uint256 j = 0; j < k; j++) {
                if (levels[j] == o.price) seen = true;
            }
            if (!seen) levels[k++] = o.price;
        }
        for (uint256 i = 1; i < k; i++) {
            for (uint256 j = i; j > 0 && levels[j - 1] > levels[j]; j--) {
                (levels[j - 1], levels[j]) = (levels[j], levels[j - 1]);
            }
        }
        uint64[] memory out = new uint64[](k);
        for (uint256 i = 0; i < k; i++) {
            out[i] = levels[i];
        }
        vm.prank(keeper);
        window.indexAskPrices(sid, out);
    }
}
