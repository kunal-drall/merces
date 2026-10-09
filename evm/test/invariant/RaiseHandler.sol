// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MercesRegistry} from "../../src/MercesRegistry.sol";
import {MercesAuction} from "../../src/MercesAuction.sol";
import {MercesTreasury} from "../../src/MercesTreasury.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {IMercesAuction} from "../../src/interfaces/IMercesAuction.sol";
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Parameters, RaiseState} from "../../src/types/MercesTypes.sol";

/// @notice Invariant handler for one sealed-bid raise: random commits, reveals, honest and dishonest settlement
/// proposals (including a round left half-tallied), processing and delivery in any order, allowlist changes
/// mid-settlement (recipient-side), direct-transfer attempts and every admin action. Ghost variables record the
/// money that entered and any forbidden call that succeeded.
contract RaiseHandler is Test {
    MercesRegistry internal registry;
    MercesAuction internal auction;
    MercesTreasury internal treasury;
    MockUSDC internal usdc;
    address internal admin;
    address internal allowlistManager;
    address internal keeper = makeAddr("raiseKeeper");
    uint256 public sid;
    uint64 public n;
    uint64 public capUnits;
    uint64 public reserve;

    struct B {
        bool committed;
        bool revealed;
        bool valid;
        uint64 price;
        uint64 qty;
        uint64 escrow;
    }

    address[] public actors;
    mapping(address => B) public book;

    // ghosts
    uint256 public escrowIn;
    bool public forbiddenSucceeded;
    bool public livenessBroken;
    string public lastFailure;
    uint256 public calls;

    constructor(
        MercesRegistry registry_,
        MercesAuction auction_,
        MercesTreasury treasury_,
        MockUSDC usdc_,
        address admin_,
        address allowlistManager_,
        uint256 sid_,
        uint64 n_,
        uint64 capUnits_,
        uint64 reserve_
    ) {
        (registry, auction, treasury, usdc) = (registry_, auction_, treasury_, usdc_);
        (admin, allowlistManager, sid, n, capUnits, reserve) =
        (admin_, allowlistManager_, sid_, n_, capUnits_, reserve_);
        for (uint256 i = 0; i < 14; i++) {
            actors.push(makeAddr(string.concat("raiseBidder", vm.toString(i))));
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @dev Picks among the actors satisfying `kind` (0: may commit, 1: may reveal, 2: may be processed,
    /// 3: may be delivered) so the fuzzer spends its calls on reachable actions; address(0) when none.
    function _eligible(uint256 seed, uint8 kind) internal view returns (address) {
        address[] memory list = new address[](actors.length);
        uint256 count;
        for (uint256 i = 0; i < actors.length; i++) {
            address w = actors[i];
            B memory b = book[w];
            bool ok;
            if (kind == 0) ok = !b.committed && registry.isAllowed(w);
            else if (kind == 1) ok = b.committed && !b.revealed;
            else if (kind == 2) ok = b.committed && !auction.getBid(sid, w).processed;
            else ok = b.committed && auction.getBid(sid, w).processed && !auction.getBid(sid, w).delivered;
            if (ok) list[count++] = w;
        }
        return count == 0 ? address(0) : list[seed % count];
    }

    function _a() internal view returns (IMercesAuction.Auction memory) {
        return auction.getAuction(sid);
    }

    function _flagLiveness(string memory what) internal {
        livenessBroken = true;
        lastFailure = what;
    }

    function _flagForbidden(string memory what) internal {
        forbiddenSucceeded = true;
        lastFailure = what;
    }

    // ---------------------------------------------------------------- bidders

    /// @dev One to three commits per call (bid books need several bidders to reach the margin).
    function commit(uint256 actorSeed, uint256 priceK, uint256 qty, uint256 escrowMode) external {
        calls++;
        for (uint256 k = 0; k < 1 + actorSeed % 3; k++) {
            uint256 h = uint256(keccak256(abi.encode(actorSeed, priceK, qty, escrowMode, k)));
            _commitOne(h, k == 0 ? priceK : h >> 16, k == 0 ? qty : h >> 32, k == 0 ? escrowMode : h >> 48);
        }
    }

    function _commitOne(uint256 actorSeed, uint256 priceK, uint256 qty, uint256 escrowMode) internal {
        address who = _eligible(actorSeed, 0);
        if (who == address(0) || vm.getBlockTimestamp() >= _a().commitEnd) return;
        B storage b = book[who];
        b.price = uint64(uint256(reserve) * (3 + priceK % 10) / 4);
        b.qty = qty % 8 == 0 ? 0 : uint64(capUnits / 2 + (qty >> 3) % (capUnits / 2 + 3)); // up to cap + 2
        uint256 cost = uint256(b.price) * b.qty;
        uint256 req = cost + cost * 100 / 10_000;
        uint256 m = escrowMode % 8; // under-collateralised, random, else exact or over-collateralised
        uint256 escrow =
            m == 0 ? req - (req > 0 ? 1 : 0) : m == 1 ? (escrowMode >> 8) % (2 * req + 1) : m < 5 ? req : 2 * req;
        b.escrow = uint64(escrow == 0 ? 1 : escrow);
        usdc.mint(who, b.escrow);
        vm.prank(who);
        usdc.approve(address(auction), b.escrow);
        vm.prank(who);
        auction.commitBid(
            sid, MercesMessages.orderCommitment(b.price, b.qty, bytes32(uint256(uint160(who))), who), b.escrow
        );
        b.committed = true;
        escrowIn += b.escrow;
    }

    /// @dev One or two reveals per call.
    function reveal(uint256 actorSeed) external {
        calls++;
        _revealOne(actorSeed);
        if (actorSeed % 2 == 0) _revealOne(actorSeed >> 8);
    }

    function _revealOne(uint256 actorSeed) internal {
        address who = _eligible(actorSeed, 1);
        if (who == address(0)) return;
        B storage b = book[who];
        IMercesAuction.Auction memory a = _a();
        uint256 t = vm.getBlockTimestamp();
        if (t < a.commitEnd || t >= a.revealEnd) return;
        vm.prank(who);
        auction.revealBid(sid, b.price, b.qty, bytes32(uint256(uint160(who))));
        b.revealed = true;
        uint256 cost = uint256(b.price) * b.qty;
        b.valid = b.price >= reserve && b.qty >= 1 && b.qty <= capUnits && b.escrow >= cost + cost * 100 / 10_000;
        if (auction.getBid(sid, who).valid != b.valid) _flagLiveness("validity rule mismatch");
    }

    uint256 internal phaseCalls;

    /// @dev Small steps inside a phase; once a phase has had its share of calls, a jump to the next boundary.
    function warp(uint256 dt) external {
        calls++;
        uint256 t = vm.getBlockTimestamp();
        IMercesAuction.Auction memory a = _a();
        if (calls - phaseCalls >= 12 + dt % 8) {
            phaseCalls = calls;
            if (t < a.commitEnd) vm.warp(a.commitEnd);
            else if (t < a.revealEnd) vm.warp(a.revealEnd);
            else vm.warp(t + 1 days);
        } else {
            vm.warp(t + bound(dt >> 3, 0, 4 hours));
        }
    }

    // ---------------------------------------------------------------- settlement (keepers, honest or not)

    function _tally(uint64 p) internal view returns (uint64 qAbove, uint64 qAt) {
        for (uint256 i = 0; i < actors.length; i++) {
            B memory b = book[actors[i]];
            if (!b.valid) continue;
            if (b.price > p) qAbove += b.qty;
            else if (b.price == p) qAt += b.qty;
        }
    }

    /// @dev The model's clearing price (SPEC §5.2 finalize, steps 2–3), or 0 when no bid is valid.
    function correctPrice() public view returns (uint64 pStar) {
        uint64 minValid = type(uint64).max;
        for (uint256 i = 0; i < actors.length; i++) {
            B memory b = book[actors[i]];
            if (b.valid && b.price < minValid) minValid = b.price;
        }
        if (minValid == type(uint64).max) return 0;
        for (uint256 i = 0; i < actors.length; i++) {
            B memory b = book[actors[i]];
            if (!b.valid) continue;
            (uint64 qAbove, uint64 qAt) = _tally(b.price);
            bool over = qAt > 0 && qAbove < n && qAbove + qAt >= n;
            bool under = qAbove + qAt < n && minValid == b.price;
            if (over || under) return b.price;
        }
        revert("model: no clearing price");
    }

    function _canPropose() internal view returns (bool) {
        IMercesAuction.Auction memory a = _a();
        if (vm.getBlockTimestamp() < a.revealEnd) return false;
        if (a.state != RaiseState.Open && a.state != RaiseState.Settling) return false;
        return a.tallyRound == 0 || a.roundRejected;
    }

    /// @dev Proposes a candidate (honest claims, or claims perturbed by `lie`), tallies `pages` of it and
    /// finalizes when fully tallied. A round left half-tallied must block any other proposal.
    function propose(uint256 candidate, uint256 lie, uint256 pages) external {
        calls++;
        IMercesAuction.Auction memory a = _a();
        if (vm.getBlockTimestamp() >= a.revealEnd && a.state == RaiseState.Settling && !a.roundRejected) {
            // a round is in progress: nobody can reset it
            vm.prank(keeper);
            try auction.beginSettlement(sid, reserve, 0, 0) {
                _flagForbidden("a tally in progress was reset");
            } catch {}
            _finishTally(pages);
            return;
        }
        if (!_canPropose()) return;
        uint64 p = candidate % 3 == 0 ? correctPrice() : uint64(uint256(reserve) * (3 + candidate % 10) / 4);
        if (p == 0) p = reserve;
        (uint64 qAbove, uint64 qAt) = _tally(p);
        if (lie % 5 == 0) qAbove += 1;
        else if (lie % 5 == 1 && qAt > 0) qAt -= 1;
        vm.prank(keeper);
        auction.beginSettlement(sid, p, qAbove, qAt);
        _finishTally(pages);
    }

    function _finishTally(uint256 pages) internal {
        IMercesAuction.Auction memory a = _a();
        uint256 from = a.talliedCount;
        uint256 count = a.bidCount;
        uint256 step = 1 + pages % 4;
        // talliedCount counts revealed bids tallied; walk the index space in pages from the start
        for (uint256 i = 0; i < count; i += step) {
            uint256 to = i + step > count ? count : i + step;
            if (pages % 7 == 3 && to < count && from == 0) {
                vm.prank(keeper);
                auction.tallyBids(sid, i, to);
                return; // leave the round half-tallied
            }
            vm.prank(keeper);
            auction.tallyBids(sid, i, to);
        }
        vm.prank(keeper);
        try auction.finalizeSettlement(sid) {}
        catch (bytes memory err) {
            _flagLiveness(string.concat("finalize reverted ", vm.toString(err)));
        }
    }

    function processBid(uint256 actorSeed) external {
        calls++;
        IMercesAuction.Auction memory a = _a();
        if (a.state != RaiseState.Settled && a.state != RaiseState.Failed) return;
        address who = _eligible(actorSeed, 2);
        if (who == address(0)) return;
        vm.prank(keeper);
        try auction.processBid(sid, who) {}
        catch (bytes memory err) {
            _flagLiveness(string.concat("processBid reverted ", vm.toString(err)));
        }
    }

    function deliverBid(uint256 actorSeed) external {
        calls++;
        address who = _eligible(actorSeed, 3);
        if (who == address(0)) return;
        vm.prank(keeper);
        try auction.deliverBid(sid, who) {}
        catch (bytes memory err) {
            _flagLiveness(string.concat("deliverBid reverted ", vm.toString(err)));
        }
    }

    // ---------------------------------------------------------------- hostile and recipient-side actions

    function setAllowed(uint256 actorSeed, uint256 flip) external {
        calls++;
        vm.prank(allowlistManager);
        registry.setAllowed(_actor(actorSeed), flip % 3 != 0); // de-allowlisting one call in three
    }

    /// @dev Units never move wallet to wallet (SPEC §4.2): every direct path must fail.
    function directTransfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        calls++;
        IERC3643Token token = IERC3643Token(_a().unitToken);
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
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
        address[3] memory privileged = [admin, allowlistManager, address(this)];
        for (uint256 i = 0; i < privileged.length; i++) {
            vm.prank(privileged[i]);
            (ok,) = address(token)
                .call(abi.encodeWithSignature("forcedTransfer(address,address,uint256)", from, to, amount));
            if (ok) _flagForbidden("forcedTransfer succeeded");
            vm.prank(privileged[i]);
            (ok,) = address(token).call(abi.encodeWithSignature("burn(address,uint256)", from, amount));
            if (ok) _flagForbidden("burn by a privileged role succeeded");
            vm.prank(privileged[i]);
            (ok,) = address(token).call(abi.encodeWithSignature("setAddressFrozen(address,bool)", from, true));
            if (ok) _flagForbidden("freeze succeeded");
        }
    }

    /// @dev Every admin action; none may touch the escrow, the proceeds or the series' terms.
    function adminAction(uint256 kind, uint256 seed) external {
        calls++;
        kind = kind % 8;
        vm.startPrank(admin);
        if (kind == 0) {
            registry.setFlags(seed % 2 == 0, seed % 3 == 0, false);
        } else if (kind == 1) {
            registry.registerAttestor(address(uint160(uint256(keccak256(abi.encode(seed))))));
        } else if (kind == 2) {
            registry.setStablecoin(address(usdc), true);
        } else if (kind == 3) {
            Parameters memory p = registry.getDefaults();
            p.auctionFeeBps = uint16(seed % 1000);
            p.nonRevealChargeBps = uint16(seed % 1000);
            p.walletCapBps = uint16(100 + seed % 9900);
            try registry.setDefaults(p) {} catch {}
        } else if (kind == 4) {
            try registry.deactivateIssuer(registry.getSeriesCore(sid).issuer) {} catch {}
        }
        vm.stopPrank();
        // the narrow protocol write interface and the money paths are closed to the admin
        vm.startPrank(admin);
        (bool ok,) = address(treasury).call(abi.encodeWithSignature("depositProceeds(uint256,uint64)", sid, 1));
        if (ok) _flagForbidden("admin deposited proceeds");
        (ok,) = address(treasury).call(abi.encodeWithSignature("moveUnreleasedToVault(uint256)", sid));
        if (ok) _flagForbidden("admin moved treasury funds");
        (ok,) = address(registry)
            .call(abi.encodeWithSignature("markRaiseResult(uint256,uint8,uint64,uint64,uint64)", sid, 3, 1, 1, 1));
        if (ok) _flagForbidden("admin wrote a raise result");
        (ok,) = address(auction).call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(this), ""));
        if (ok) _flagForbidden("admin upgraded the auction without the timelock");
        vm.stopPrank();
    }
}
