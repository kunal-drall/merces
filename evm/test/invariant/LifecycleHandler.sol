// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MercesRegistry} from "../../src/MercesRegistry.sol";
import {MercesTreasury} from "../../src/MercesTreasury.sol";
import {MercesVault} from "../../src/MercesVault.sol";
import {MercesIncome} from "../../src/MercesIncome.sol";
import {MercesWindow} from "../../src/MercesWindow.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {IMercesVault} from "../../src/interfaces/IMercesVault.sol";
import {IMercesWindow} from "../../src/interfaces/IMercesWindow.sol";
import {IMercesTreasury} from "../../src/interfaces/IMercesTreasury.sol";
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
import {MercesConstants as C} from "../../src/libraries/MercesConstants.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {Parameters, SeriesCore, SeriesStatus} from "../../src/types/MercesTypes.sol";

/// @notice Invariant handler for a settled series through its whole life: reports of random size (accept-all
/// verifier), payments by the issuer or third parties, claims and pushes, releases and the issuer's release
/// pause, hardship pauses, redemption and the tail, extinguishment, retirement burns, quarterly transfer
/// windows processed one order at a time (payouts may land mid-processing), allowlist changes, direct-transfer
/// attempts and every admin action. Ghosts record every token flow the handler caused; any forbidden call that
/// succeeds or any honest step that reverts is flagged.
contract LifecycleHandler is Test {
    struct Env {
        MercesRegistry registry;
        MercesTreasury treasury;
        MercesVault vault;
        MercesIncome income;
        MercesWindow window;
        MockUSDC usdc;
        address auction;
        address feeCollector;
        address admin;
        address allowlistManager;
        address issuer;
        uint256 attestorKey;
        uint256 attestor2Key;
        uint256 verifierKey;
        bytes32 domain;
        uint256 sid;
    }

    struct Ord {
        bool exists;
        bool ask;
        bool revealed;
        uint64 price;
        uint64 qty;
        uint64 escrow;
    }

    uint64 internal constant P0 = 100e6;
    Env internal e;
    address internal keeper = makeAddr("lifeKeeper");
    address internal stranger = makeAddr("lifeStranger");
    address[] public wallets;
    IERC3643Token public token;

    // ghosts
    mapping(address => uint256) public unitsGhost;
    uint256 public paidIn; // every payment pulled by income (issuer or third party)
    uint256 public redemptionPaid;
    uint256 public releasedToIssuer;
    uint32[] public windowPeriods;
    mapping(uint32 => uint256) public bidEscrowIn;
    mapping(uint32 => mapping(address => Ord)) public orders;
    mapping(uint32 => address[]) internal orderOwners;
    bool public forbiddenSucceeded;
    bool public livenessBroken;
    string public lastFailure;
    uint256 internal windowPhaseCalls;
    uint256 public calls;
    mapping(string => uint256) public hits;

    constructor(Env memory env, address[] memory wallets_) {
        e = env;
        wallets = wallets_;
        token = IERC3643Token(e.registry.getSeriesCore(e.sid).unitToken);
        _syncUnits();
    }

    function walletCount() external view returns (uint256) {
        return wallets.length;
    }

    function windowCount() external view returns (uint256) {
        return windowPeriods.length;
    }

    // ---------------------------------------------------------------- helpers

    function _flagLiveness(string memory what, bytes memory err) internal {
        livenessBroken = true;
        lastFailure = string.concat(what, " ", vm.toString(err));
    }

    function _flagForbidden(string memory what) internal {
        forbiddenSucceeded = true;
        lastFailure = what;
    }

    function _syncUnits() internal {
        for (uint256 i = 0; i < wallets.length; i++) {
            unitsGhost[wallets[i]] = token.balanceOf(wallets[i]);
        }
    }

    function _core() internal view returns (SeriesCore memory) {
        return e.registry.getSeriesCore(e.sid);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _wallet(uint256 seed) internal view returns (address) {
        return wallets[seed % wallets.length];
    }

    function _window() internal view returns (bool active, uint32 period, IMercesWindow.Window memory w) {
        bool exists;
        (exists, period) = e.window.currentWindow(e.sid);
        if (!exists) return (false, 0, w);
        w = e.window.getWindow(e.sid, period);
        active = w.state != IMercesWindow.WindowState.Done;
    }

    // ---------------------------------------------------------------- time

    /// @dev Short steps while a window is collecting orders, otherwise up to 45 days.
    function warp(uint256 dt) external {
        calls++;
        (bool active,, IMercesWindow.Window memory w) = _window();
        if (active && _now() < w.revealEnd) {
            if (calls - windowPhaseCalls >= 10 + dt % 6) {
                windowPhaseCalls = calls;
                vm.warp(_now() < w.commitEnd ? w.commitEnd : w.revealEnd);
            } else {
                vm.warp(_now() + bound(dt, 0, 12 hours));
            }
            return;
        }
        vm.warp(_now() + bound(dt, 1 hours, 45 days));
    }

    // ---------------------------------------------------------------- repayment path

    function report(uint256 pay, uint256 flags) external {
        calls++;
        SeriesCore memory c = _core();
        uint8 ts = c.terminalStatus;
        if (ts == uint8(SeriesStatus.Retired) || ts == uint8(SeriesStatus.Extinguished)) return;
        uint32 next = e.income.nextExpectedPeriod(e.sid);
        if (_now() < Periods.periodEnd(next)) return;
        (uint64 due,) = e.income.openDue(e.sid);
        if (due > 0) return;
        bool liquidity;
        if (ts == uint8(SeriesStatus.Redeemed)) {
            IMercesVault.Ledger memory vl = e.vault.getLedger(e.sid);
            if (Periods.periodStart(next) > uint256(vl.redemptionTs) + C.TAIL_SECONDS) return;
            liquidity = flags % 2 == 0 && vl.tailCapPerUnit > 0 && !vl.tailExhausted;
        }
        uint64 payment = flags % 5 == 0 ? 0 : uint64(bound(pay, 0, 12_000e6));
        IMercesIncome.ReportInput memory r = _reportInput(next, payment, liquidity);
        vm.prank(e.issuer);
        try e.income.submitReport(r) {
            hits["report"]++;
        } catch (bytes memory err) {
            _flagLiveness("a valid report reverted", err);
        }
    }

    function _reportInput(uint32 period, uint64 payment, bool liquidity)
        internal
        view
        returns (IMercesIncome.ReportInput memory r)
    {
        IMercesIncome.Ledger memory l = e.income.getLedger(e.sid);
        bytes32 prior;
        if (Periods.quarterIndex(period) == 0) prior = bytes32(e.income.ZERO_INCOME_COMMITMENT());
        else if (l.hasIncomeCommitment) prior = l.lastIncomeCommitment;
        else prior = bytes32(uint256(1));
        r.seriesId = e.sid;
        r.period = period;
        r.paymentUsd = payment;
        r.fxAvgWad = 1e18;
        r.priorIncomeCommitment = prior;
        r.incomeCommitment = bytes32(uint256(keccak256(abi.encode("life", period))) >> 4);
        r.tier = 2;
        r.liquidityEvent = liquidity;
        r.attestationSignature = _sign(
            e.verifierKey, MercesMessages.reportDigest(e.domain, e.sid, period, prior, r.incomeCommitment, 2, liquidity)
        );
    }

    /// @dev Composite progression step: to the end of the next expected period (plus up to 40 days), report,
    /// and usually pay — a series' life spans years, the granular actions interleave around these steps.
    function advanceQuarter(uint256 pay_, uint256 flags, uint256 offset) external {
        uint32 next = e.income.nextExpectedPeriod(e.sid);
        uint256 target = uint256(Periods.periodEnd(next)) + bound(offset, 0, 40 days);
        if (target > _now()) vm.warp(target);
        this.report(pay_, flags);
        if (flags % 5 != 4) this.pay(offset);
    }

    /// @dev Composite window step: open (if possible), several orders, reveals, settlement. Processing is left
    /// to `windowProcess`, one order per call, so payouts and claims can land mid-processing.
    function windowCycle(uint256 seed) external {
        (bool active,,) = _window();
        if (!active) this.openWindow();
        (active,,) = _window();
        if (!active) return;
        for (uint256 k = 0; k < 3 + seed % 4; k++) {
            uint256 h = uint256(keccak256(abi.encode(seed, k)));
            this.windowOrder(h, h >> 32, h >> 64, h >> 128);
        }
        (,, IMercesWindow.Window memory w) = _window();
        if (_now() < w.commitEnd) vm.warp(w.commitEnd);
        for (uint256 k = 0; k < 7; k++) {
            this.windowReveal(uint256(keccak256(abi.encode(seed, "r", k))));
        }
        (,, w) = _window();
        if (_now() < w.revealEnd) vm.warp(w.revealEnd);
        this.windowSettle();
    }

    function pay(uint256 payerSeed) external {
        calls++;
        (uint64 due, uint32 period) = e.income.openDue(e.sid);
        if (due == 0) return;
        uint64 accrual = _core().terminalStatus == uint8(SeriesStatus.Redeemed)
            ? 0
            : e.income.lateAccrual(e.sid, period, due, _now());
        uint256 total = uint256(due) + accrual;
        address payer = payerSeed % 3 == 0 ? stranger : e.issuer;
        e.usdc.mint(payer, total);
        vm.prank(payer);
        e.usdc.approve(address(e.income), total);
        vm.prank(payer);
        try e.income.pay(e.sid) {
            paidIn += total;
            hits["pay"]++;
        } catch (bytes memory err) {
            _flagLiveness("pay reverted", err);
        }
        _syncUnits(); // a capping payment never moves units, but retirement burns only happen at claims
    }

    function claim(uint256 seed, bool push) external {
        calls++;
        address w = _wallet(seed);
        if (!e.vault.getHolder(e.sid, w).registered) return;
        if (push) {
            vm.prank(keeper);
            try e.vault.claimFor(e.sid, w) {
                hits["claim"]++;
            } catch (bytes memory err) {
                _flagLiveness("claimFor blocked", err);
            }
        } else {
            vm.prank(w);
            try e.vault.claim(e.sid) {
                hits["claim"]++;
            } catch (bytes memory err) {
                _flagLiveness("claim blocked", err);
            }
        }
        _syncUnits();
    }

    function claimRelease() external {
        calls++;
        uint64 claimable = e.treasury.claimable(e.sid);
        IMercesTreasury.Ledger memory tl = e.treasury.getTreasury(e.sid);
        bool late = e.income.deriveStatus(e.sid) == SeriesStatus.Late || e.income.isLateUnderlying(e.sid);
        bool shouldWork = claimable > 0 && !tl.issuerPausedReleases && !late;
        uint256 before = e.usdc.balanceOf(e.issuer);
        vm.prank(e.issuer);
        try e.treasury.claimRelease(e.sid) {
            releasedToIssuer += e.usdc.balanceOf(e.issuer) - before;
            hits["release"]++;
        } catch (bytes memory err) {
            if (shouldWork) _flagLiveness("release blocked", err);
        }
    }

    function setReleasePause(bool paused) external {
        calls++;
        vm.prank(e.issuer);
        e.treasury.setReleasePause(e.sid, paused);
    }

    function hardship(uint256 kind, uint256 dur) external {
        calls++;
        kind = kind % 4;
        if (kind == 0) {
            vm.prank(e.issuer);
            try e.income.requestPause(e.sid) {} catch {}
        } else if (kind == 1) {
            vm.prank(e.issuer);
            try e.income.withdrawPauseRequest(e.sid) {} catch {}
        } else if (kind == 2) {
            uint64 end = uint64(_now() + bound(dur, 1 days, 150 days));
            uint64 nonce = e.income.getLedger(e.sid).pauseNonce;
            bytes memory sig = _sign(e.attestorKey, MercesMessages.pauseDigest(e.domain, e.sid, nonce, end));
            try e.income.approvePause(e.sid, end, sig) {
                hits["pause"]++;
            } catch {}
        } else {
            vm.prank(e.issuer);
            try e.income.endPause(e.sid) {} catch {}
        }
    }

    // ---------------------------------------------------------------- exit path

    function redeem(uint256 seed) external {
        calls++;
        if (seed % 12 != 0 || _core().terminalStatus != 0) return; // rare: it ends the main life
        try e.vault.previewRedemption(e.sid, _now()) returns (uint64, uint64, uint64, uint64, uint64 deposit) {
            e.usdc.mint(e.issuer, deposit);
            vm.prank(e.issuer);
            e.usdc.approve(address(e.vault), deposit);
            vm.prank(e.issuer);
            try e.vault.redeem(e.sid) {
                redemptionPaid += e.vault.getLedger(e.sid).redemptionDeposit;
                hits["redeem"]++;
            } catch {}
        } catch {}
    }

    function claimExit(uint256 seed, uint256 kind) external {
        calls++;
        address w = _wallet(seed);
        kind = kind % 3;
        vm.prank(w);
        if (kind == 0) {
            try e.vault.claimRedemption(e.sid) {
                hits["claimRedemption"]++;
            } catch {}
        } else if (kind == 1) {
            try e.vault.claimTail(e.sid) {
                hits["claimTail"]++;
            } catch {}
        } else {
            try e.vault.claimFinal(e.sid) {
                hits["claimFinal"]++;
            } catch {}
        }
        _syncUnits();
    }

    function extinguish(uint256 seed) external {
        calls++;
        if (seed % 24 != 0) return; // rare: it ends every claim
        uint64 nonce = e.vault.getLedger(e.sid).extinguishNonce;
        bytes32 dg = MercesMessages.extinguishDigest(e.domain, e.sid, nonce);
        vm.prank(keeper);
        try e.vault.extinguish(e.sid, _sign(e.attestorKey, dg), _sign(e.attestor2Key, dg)) {
            hits["extinguish"]++;
        } catch {}
    }

    function retire(uint256 seed) external {
        calls++;
        vm.startPrank(keeper);
        try e.vault.retireIfCapped(e.sid) {} catch {}
        if (_core().terminalStatus == uint8(SeriesStatus.Retired)) {
            try e.vault.burnRetired(e.sid, _wallet(seed)) {
                hits["burnRetired"]++;
            } catch {}
        }
        vm.stopPrank();
        _syncUnits();
    }

    // ---------------------------------------------------------------- transfer window

    function openWindow() external {
        calls++;
        uint32 period = Periods.periodOf(_now()) - 1;
        vm.prank(keeper);
        try e.window.openWindow(e.sid, period) {
            windowPeriods.push(period);
            windowPhaseCalls = calls;
            hits["window"]++;
        } catch {}
    }

    function windowOrder(uint256 seed, uint256 priceK, uint256 qty, uint256 mode) external {
        calls++;
        (bool active, uint32 period, IMercesWindow.Window memory w) = _window();
        if (!active || w.state != IMercesWindow.WindowState.Commit || _now() >= w.commitEnd) return;
        address who = _wallet(seed);
        if (orders[period][who].exists) return;
        uint64 price = uint64(uint256(P0) * (2 + priceK % 7) / 4);
        bool ok = token.balanceOf(who) > 0 && seed % 3 != 0
            ? _commitAsk(period, who, price, qty, mode, bytes32(seed))
            : _commitBid(period, who, price, qty, mode, bytes32(seed));
        if (!ok) return;
        orderOwners[period].push(who);
        _saltOf[period][who] = bytes32(seed);
        _syncUnits();
    }

    function _commitAsk(uint32 period, address who, uint64 price, uint256 qty, uint256 mode, bytes32 salt)
        internal
        returns (bool)
    {
        uint256 bal = token.balanceOf(who);
        Ord memory o = Ord({exists: true, ask: true, revealed: false, price: price, qty: 0, escrow: 0});
        o.escrow = uint64(1 + qty % bal);
        o.qty = mode % 8 == 0 ? o.escrow + 1 : uint64(1 + (qty >> 8) % o.escrow);
        bytes32 c = MercesMessages.orderCommitment(o.price, o.qty, salt, who);
        vm.prank(who);
        token.approve(address(e.window), o.escrow);
        vm.prank(who);
        try e.window.commitAsk(e.sid, c, o.escrow) {
            orders[period][who] = o;
            return true;
        } catch {
            return false;
        }
    }

    function _commitBid(uint32 period, address who, uint64 price, uint256 qty, uint256 mode, bytes32 salt)
        internal
        returns (bool)
    {
        if (!e.registry.isAllowed(who)) return false;
        Ord memory o = Ord({exists: true, ask: false, revealed: false, price: price, qty: 0, escrow: 0});
        o.qty = uint64(1 + qty % (e.window.walletCapUnits(e.sid) + 2));
        uint256 req = e.window.requiredBidEscrow(e.sid, o.price, o.qty);
        uint256 m = mode % 8;
        o.escrow = uint64(m == 0 ? (req > 1 ? req - 1 : 1) : m == 1 ? 2 * req : req);
        bytes32 c = MercesMessages.orderCommitment(o.price, o.qty, salt, who);
        e.usdc.mint(who, o.escrow);
        vm.prank(who);
        e.usdc.approve(address(e.window), o.escrow);
        vm.prank(who);
        try e.window.commitBid(e.sid, c, o.escrow) {
            bidEscrowIn[period] += o.escrow;
            orders[period][who] = o;
            return true;
        } catch {
            return false;
        }
    }

    mapping(uint32 => mapping(address => bytes32)) internal _saltOf;

    function windowReveal(uint256 seed) external {
        calls++;
        (bool active, uint32 period, IMercesWindow.Window memory w) = _window();
        if (!active || _now() < w.commitEnd || _now() >= w.revealEnd) return;
        address[] storage owners = orderOwners[period];
        if (owners.length == 0) return;
        for (uint256 k = 0; k < owners.length; k++) {
            address who = owners[(seed % owners.length + k) % owners.length];
            Ord storage o = orders[period][who];
            if (o.revealed || seed % 7 == 0) continue; // some orders stay unrevealed
            vm.prank(who);
            e.window.revealOrder(e.sid, o.price, o.qty, _saltOf[period][who]);
            o.revealed = true;
            return;
        }
    }

    /// @dev Keepers try NO_MATCH and every revealed valid price until one is accepted; exactly one must be.
    function windowSettle() external {
        calls++;
        (bool active, uint32 period, IMercesWindow.Window memory w) = _window();
        if (!active || _now() < w.revealEnd) return;
        if (w.state == IMercesWindow.WindowState.Settled || w.state == IMercesWindow.WindowState.NoMatch) return;
        if (w.tallyRound != 0 && !w.roundRejected) return;
        address[] storage owners = orderOwners[period];
        for (uint256 k = 0; k <= owners.length; k++) {
            bool nm = k == 0;
            uint64 p;
            if (!nm) {
                address who = owners[k - 1];
                if (!orders[period][who].revealed || !e.window.getOrder(e.sid, period, who).valid) continue;
                p = orders[period][who].price;
            }
            vm.startPrank(keeper);
            e.window.beginWindowSettlement(e.sid, p, nm);
            uint32 n = e.window.getWindow(e.sid, period).orderCount;
            if (n > 0) e.window.tallyOrders(e.sid, 0, n);
            try e.window.finalizeWindow(e.sid) {}
            catch (bytes memory err) {
                _flagLiveness("finalizeWindow reverted", err);
            }
            vm.stopPrank();
            if (!e.window.getWindow(e.sid, period).roundRejected) {
                hits["windowSettled"]++;
                return;
            }
        }
        _flagLiveness("no window proposal was accepted", "");
    }

    /// @dev One order per call in the mandated sequence (revealed bids, the ask price index if needed, revealed
    /// asks, then unrevealed orders; any order in a NO_MATCH window), so payouts, claims and deliveries interleave
    /// with processing.
    function windowProcess(uint256 seed) external {
        calls++;
        (bool active, uint32 period, IMercesWindow.Window memory w) = _window();
        if (!active) return;
        if (w.state != IMercesWindow.WindowState.Settled && w.state != IMercesWindow.WindowState.NoMatch) return;
        address target;
        if (w.state == IMercesWindow.WindowState.Settled && w.nextBidIndex < w.revealedBids) {
            target = e.window.revealedOrderAt(e.sid, period, IMercesWindow.Side.Bid, w.nextBidIndex);
        } else if (w.state == IMercesWindow.WindowState.Settled && w.nextAskIndex < w.revealedAsks) {
            if (e.window.priceIndexRequired(e.sid)) _indexAsks(period, w);
            target = e.window.revealedOrderAt(e.sid, period, IMercesWindow.Side.Ask, w.nextAskIndex);
        } else {
            address[] storage owners = orderOwners[period];
            for (uint256 k = 0; k < owners.length; k++) {
                address who = owners[(seed % owners.length + k) % owners.length];
                if (!e.window.getOrder(e.sid, period, who).processed) {
                    target = who;
                    break;
                }
            }
        }
        if (target == address(0)) return;
        vm.prank(keeper);
        try e.window.processOrder(e.sid, target) {
            hits["processOrder"]++;
        } catch (bytes memory err) {
            _flagLiveness("processOrder reverted", err);
        }
        _syncUnits();
    }

    /// @dev Delivers one processed, undelivered order of any window (anyone, owner-only push, retryable).
    function windowDeliver(uint256 seed) external {
        calls++;
        uint256 nw = windowPeriods.length;
        if (nw == 0) return;
        for (uint256 j = 0; j < nw; j++) {
            uint32 period = windowPeriods[(seed % nw + j) % nw];
            address[] storage owners = orderOwners[period];
            for (uint256 k = 0; k < owners.length; k++) {
                address who = owners[(seed % owners.length + k) % owners.length];
                IMercesWindow.Order memory o = e.window.getOrder(e.sid, period, who);
                if (!o.processed || o.delivered) continue;
                vm.prank(keeper);
                try e.window.deliverOrder(e.sid, period, who) {
                    hits["deliverOrder"]++;
                } catch (bytes memory err) {
                    _flagLiveness("deliverOrder reverted", err);
                }
                _syncUnits();
                return;
            }
        }
    }

    /// @dev Delivers everything still pending (liveness check at the end of a run).
    function deliverAll() external {
        for (uint256 j = 0; j < windowPeriods.length; j++) {
            uint32 period = windowPeriods[j];
            address[] storage owners = orderOwners[period];
            for (uint256 k = 0; k < owners.length; k++) {
                IMercesWindow.Order memory o = e.window.getOrder(e.sid, period, owners[k]);
                if (!o.processed || o.delivered) continue;
                vm.prank(keeper);
                e.window.deliverOrder(e.sid, period, owners[k]);
            }
        }
        _syncUnits();
    }

    function _indexAsks(uint32 period, IMercesWindow.Window memory w) internal {
        address[] storage owners = orderOwners[period];
        uint64[] memory tmp = new uint64[](owners.length);
        uint256 n;
        for (uint256 k = 0; k < owners.length; k++) {
            IMercesWindow.Order memory o = e.window.getOrder(e.sid, period, owners[k]);
            if (o.side != IMercesWindow.Side.Ask || !o.valid || o.price >= w.clearingPrice) continue;
            bool dup;
            for (uint256 j = 0; j < n; j++) {
                if (tmp[j] == o.price) dup = true;
            }
            if (!dup) tmp[n++] = o.price;
        }
        uint64[] memory prices = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            prices[i] = tmp[i];
        }
        for (uint256 i = 1; i < n; i++) {
            for (uint256 j = i; j > 0 && prices[j - 1] > prices[j]; j--) {
                (prices[j - 1], prices[j]) = (prices[j], prices[j - 1]);
            }
        }
        vm.prank(keeper);
        try e.window.indexAskPrices(e.sid, prices) {
            hits["indexAsks"]++;
        } catch (bytes memory err) {
            _flagLiveness("indexAskPrices reverted", err);
        }
    }

    // ---------------------------------------------------------------- hostile and recipient-side actions

    function setAllowed(uint256 seed, uint256 flip) external {
        calls++;
        address w = flip % 5 == 0 ? e.issuer : _wallet(seed);
        vm.prank(e.allowlistManager);
        e.registry.setAllowed(w, flip % 3 != 0);
    }

    function directTransfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        calls++;
        address from = _wallet(fromSeed);
        address to = _wallet(toSeed);
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) _flagForbidden("direct unit transfer succeeded");
        vm.prank(from);
        token.approve(to, amount);
        vm.prank(to);
        (ok, ret) =
            address(token).call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) _flagForbidden("transferFrom succeeded");
        // into the window escrow without an armed commit
        vm.prank(from);
        (ok, ret) = address(token).call(abi.encodeWithSignature("transfer(address,uint256)", address(e.window), amount));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) _flagForbidden("unarmed escrow deposit succeeded");
        address[4] memory privileged = [e.admin, e.allowlistManager, e.issuer, stranger];
        for (uint256 i = 0; i < privileged.length; i++) {
            vm.prank(privileged[i]);
            (ok,) = address(token)
                .call(abi.encodeWithSignature("forcedTransfer(address,address,uint256)", from, to, amount));
            if (ok) _flagForbidden("forcedTransfer succeeded");
            vm.prank(privileged[i]);
            (ok,) = address(token).call(abi.encodeWithSignature("burn(address,uint256)", from, amount));
            if (ok) _flagForbidden("burn by a privileged role succeeded");
            vm.prank(privileged[i]);
            (ok,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", to, amount));
            if (ok) _flagForbidden("mint by a privileged role succeeded");
            vm.prank(privileged[i]);
            (ok,) = address(token).call(abi.encodeWithSignature("pause()"));
            if (ok) _flagForbidden("token pause succeeded");
        }
    }

    function _moneyState() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                e.usdc.balanceOf(address(e.treasury)),
                e.usdc.balanceOf(address(e.vault)),
                e.usdc.balanceOf(address(e.window)),
                e.usdc.balanceOf(e.auction),
                e.usdc.balanceOf(e.feeCollector),
                e.treasury.getTreasury(e.sid),
                e.vault.getLedger(e.sid),
                token.totalSupply()
            )
        );
    }

    /// @dev Every admin action, then every money path attempted by the admin: nothing may move.
    function adminAction(uint256 kind, uint256 seed) external {
        calls++;
        bytes32 before = _moneyState();
        vm.startPrank(e.admin);
        kind = kind % 9;
        if (kind == 0) {
            e.registry.setFlags(seed % 2 == 0, seed % 4 != 0, seed % 3 == 0);
        } else if (kind == 1) {
            try e.registry.registerAttestor(address(uint160(uint256(keccak256(abi.encode("a", seed)))))) {} catch {}
        } else if (kind == 2) {
            e.registry.setStablecoin(address(e.usdc), seed % 2 == 0);
        } else if (kind == 3) {
            Parameters memory p = e.registry.getDefaults();
            p.payoutFeeBps = uint16(seed % 2000);
            p.windowFeeBps = uint16(seed % 1000);
            p.capMultipleWad = uint64(2e18 + seed % 1e18);
            p.lockupSeconds = uint64(seed % 1e8);
            try e.registry.setDefaults(p) {} catch {}
        } else if (kind == 4) {
            try e.registry.deactivateIssuer(e.issuer) {} catch {}
        } else if (kind == 5) {
            try e.registry.registerIssuer(e.issuer) {} catch {}
        } else if (kind == 6) {
            address v2 = address(uint160(uint256(keccak256(abi.encode("v", seed)))));
            try e.registry.registerVerifierKey(v2) {} catch {}
        } else if (kind == 7) {
            try e.registry.setFxPair(keccak256(abi.encode(seed)), seed % 2 == 0, address(0)) {} catch {}
        }
        // the money paths and the narrow protocol interface are closed to the admin
        bytes[9] memory attempts = [
            abi.encodeWithSignature("moveUnreleasedToVault(uint256)", e.sid),
            abi.encodeWithSignature("receiveGross(uint256,uint64,uint8,uint32)", e.sid, 1, 0, 0),
            abi.encodeWithSignature("initializeSupply(uint256,uint64)", e.sid, 1),
            abi.encodeWithSignature("markTerminal(uint256,uint8)", e.sid, 5),
            abi.encodeWithSignature("clearDues(uint256)", e.sid),
            abi.encodeWithSignature("receiveRouterShare(uint256,uint64)", e.sid, 1),
            abi.encodeWithSignature("creditWindowAccrual(uint256,address,uint64,uint256)", e.sid, e.admin, 1, 0),
            abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(this), ""),
            abi.encodeWithSignature("withdraw(address,address,uint256)", address(e.usdc), e.admin, 1)
        ];
        address[6] memory targets = [
            address(e.treasury),
            address(e.vault),
            address(e.income),
            address(e.registry),
            address(e.window),
            e.feeCollector
        ];
        for (uint256 i = 0; i < attempts.length; i++) {
            for (uint256 t = 0; t < targets.length; t++) {
                (bool ok,) = targets[t].call(attempts[i]);
                if (ok) _flagForbidden(string.concat("admin call succeeded: #", vm.toString(i)));
            }
        }
        vm.stopPrank();
        if (_moneyState() != before) _flagForbidden("an admin action moved protocol funds or units");
    }
}
