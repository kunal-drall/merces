// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MercesUpgradeable} from "./base/MercesUpgradeable.sol";
import {IMercesWindow} from "./interfaces/IMercesWindow.sol";
import {IMercesIncome} from "./interfaces/IMercesIncome.sol";
import {IPayoutClaims} from "./interfaces/IPayoutClaims.sol";
import {IMercesVault} from "./interfaces/IMercesVault.sol";
import {IERC3643Token} from "./interfaces/external/IERC3643Token.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesMessages} from "./libraries/MercesMessages.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {Periods} from "./libraries/Periods.sol";
import {ProtocolContracts, RaiseState, SeriesCore, SeriesStatus, SeriesTerms} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesWindow
/// @notice Quarterly sealed call auction per series (D9, SPEC §7). Sellers escrow units with sealed asks, buyers
/// escrow stablecoin with sealed bids, a keeper proposes the clearing price and the contract validates it against
/// a paged tally. Fills are processed in a fixed order (anyone may advance it) so every unit and every base unit
/// is accounted for; unmatched remainders go back to the marginal side in descending reveal order. This contract
/// is the only path through which units move between wallets: the compliance module admits transfers into the
/// escrow only when this contract has armed them (`armedDeposit`) and transfers out only from this contract.
///
/// Clearing rule: with `S = s_below + s_at` (supply at or below `p*`) and `D = d_above + d_at` (demand at or above
/// `p*`), a proposal is valid when either
///   (A) supply binds: `d_above < S ≤ D` and `d_at > 0` — asks at or below `p*` sell fully, bids at `p*` share
///       `R = S − d_above` pro rata (SPEC §7), or
///   (B) demand binds: `s_below ≤ D < S` and `s_at > 0` — bids at or above `p*` buy fully, asks at `p*` share
///       `R = D − s_below` pro rata.
/// Exactly one revealed price satisfies (A) or (B) whenever `max_bid ≥ min_ask`; otherwise `NO_MATCH` is the only
/// valid proposal. (B) extends SPEC §7, which only covers (A) and otherwise leaves a crossing window unsettleable;
/// see docs/assumptions/track-c.md.
contract MercesWindow is MercesUpgradeable, IMercesWindow {
    using SafeERC20 for IERC20;
    using MercesMath for uint256;

    uint8 internal constant PHASE_FIRST_SIDE = 0;
    uint8 internal constant PHASE_SECOND_AT = 1;
    uint8 internal constant PHASE_SECOND_REST = 2;
    uint8 internal constant PHASE_RETURNS = 3;
    uint8 internal constant PHASE_DONE = 4;

    /// @custom:storage-location erc7201:merces.storage.MercesWindow
    struct WindowStorage {
        mapping(uint256 => mapping(uint32 => Window)) windows;
        mapping(uint256 => mapping(uint32 => Order[])) orders;
        mapping(uint256 => mapping(uint32 => uint32[])) validBids; // order indices, reveal order
        mapping(uint256 => mapping(uint32 => uint32[])) validAsks;
        mapping(uint256 => mapping(uint32 => mapping(address => uint256))) bidIndexPlusOne;
        mapping(uint256 => mapping(uint32 => mapping(address => uint256))) askIndexPlusOne;
        mapping(uint256 => bool) hasActive;
        mapping(uint256 => uint32) activePeriod;
        mapping(uint256 => mapping(address => uint64)) heldUnits;
        mapping(address => uint256) armedDeposit;
    }

    // keccak256(abi.encode(uint256(keccak256("merces.storage.MercesWindow")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant WINDOW_STORAGE = 0x5c81edad0d4b003787f588c8a7c491d716cf3463f7444d0515e1f2fd13138d00;

    function _s() private pure returns (WindowStorage storage $) {
        assembly ("memory-safe") {
            $.slot := WINDOW_STORAGE
        }
    }

    function initialize(address owner_, address registry_) external initializer {
        __MercesUpgradeable_init(owner_, registry_);
    }

    // ================================================================ open

    /// @inheritdoc IMercesWindow
    /// @dev Anyone may open the window of the quarter just reported, once the report is paid, after the lockup,
    /// while the series is OnTime or InGrace and the protocol has windows enabled.
    function openWindow(uint256 seriesId, uint32 period) external override {
        if (!registry().getFlags().windowsEnabled) revert WindowsDisabled();
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        if (core.raiseState != RaiseState.Settled) revert NotSettled();
        if (block.timestamp < uint256(core.settlementTs) + terms.lockupSeconds) revert LockupActive();
        IMercesIncome income = IMercesIncome(_contracts().income);
        SeriesStatus st = income.deriveStatus(seriesId);
        if (st != SeriesStatus.OnTime && st != SeriesStatus.InGrace) revert WindowNotEligibleStatus();
        (bool hasPaid, uint32 lastPaid) = income.lastPaidPeriod(seriesId);
        if (!hasPaid || lastPaid < period) revert ReportNotPaid();
        uint32 expected = Periods.periodOf(block.timestamp) - 1;
        if (period != expected) revert WrongWindowPeriod(expected, period);
        WindowStorage storage $ = _s();
        if ($.hasActive[seriesId]) revert WindowAlreadyOpen();
        Window storage w = $.windows[seriesId][period];
        if (w.state != WindowState.None) revert WindowAlreadyOpen();
        w.state = WindowState.Open;
        w.period = period;
        w.opensAt = uint64(block.timestamp);
        w.commitEnd = w.opensAt + terms.windowCommitDuration;
        w.revealEnd = w.commitEnd + terms.windowRevealDuration;
        w.minAsk = type(uint64).max;
        $.hasActive[seriesId] = true;
        $.activePeriod[seriesId] = period;
        emit WindowOpened(seriesId, period, w.commitEnd, w.revealEnd);
    }

    // ================================================================ commit

    /// @inheritdoc IMercesWindow
    /// @dev Settles the seller's payout accrual first (balance changes), arms the deposit so the compliance
    /// module admits exactly this transfer into the escrow, and pulls the units.
    function commitAsk(uint256 seriesId, bytes32 commitment, uint64 units) external override nonReentrant {
        (Window storage w, uint32 period) = _openWindow(seriesId);
        if (block.timestamp >= w.commitEnd) revert CommitPhaseOver();
        if (units == 0) revert ZeroUnits();
        WindowStorage storage $ = _s();
        if ($.askIndexPlusOne[seriesId][period][msg.sender] != 0) revert OrderAlreadyExists();
        Order[] storage list = $.orders[seriesId][period];
        if (list.length >= C.MAX_ORDERS_PER_WINDOW) revert TooManyBids();
        list.push(_newOrder(msg.sender, Side.Ask, commitment, units));
        $.askIndexPlusOne[seriesId][period][msg.sender] = list.length;
        w.askCount += 1;
        w.escrowUnits += units;
        emit OrderCommitted(seriesId, period, msg.sender, Side.Ask, units);

        ProtocolContracts memory pc = _contracts();
        IPayoutClaims(pc.vault).settleHolder(seriesId, msg.sender);
        IERC3643Token token = IERC3643Token(registry().getSeriesCore(seriesId).unitToken);
        $.armedDeposit[msg.sender] = units;
        token.transferFrom(msg.sender, address(this), units);
        delete $.armedDeposit[msg.sender];
    }

    /// @inheritdoc IMercesWindow
    function commitBid(uint256 seriesId, bytes32 commitment, uint64 escrow) external override nonReentrant {
        (Window storage w, uint32 period) = _openWindow(seriesId);
        if (block.timestamp >= w.commitEnd) revert CommitPhaseOver();
        if (!registry().isAllowed(msg.sender)) revert WalletNotAllowlisted(msg.sender);
        if (escrow == 0) revert ZeroEscrow();
        WindowStorage storage $ = _s();
        if ($.bidIndexPlusOne[seriesId][period][msg.sender] != 0) revert OrderAlreadyExists();
        Order[] storage list = $.orders[seriesId][period];
        if (list.length >= C.MAX_ORDERS_PER_WINDOW) revert TooManyBids();
        list.push(_newOrder(msg.sender, Side.Bid, commitment, escrow));
        $.bidIndexPlusOne[seriesId][period][msg.sender] = list.length;
        w.bidCount += 1;
        w.escrowStable = (uint256(w.escrowStable) + escrow).toU64();
        emit OrderCommitted(seriesId, period, msg.sender, Side.Bid, escrow);
        IERC20(registry().getSeriesCore(seriesId).stablecoin).safeTransferFrom(msg.sender, address(this), escrow);
    }

    function _newOrder(address owner, Side side, bytes32 commitment, uint64 escrow)
        internal
        pure
        returns (Order memory o)
    {
        o.owner = owner;
        o.side = side;
        o.commitment = commitment;
        o.escrow = escrow;
    }

    // ================================================================ reveal

    /// @inheritdoc IMercesWindow
    /// @dev Validity (SPEC §7): `price ≥ 1`, `quantity ≥ 1`; asks `quantity ≤ escrow_units`; bids
    /// `escrow ≥ p×q + fee` and `quantity ≤ wallet_cap_units − balance(owner)`.
    function revealOrder(uint256 seriesId, Side side, uint64 price, uint64 quantity, bytes32 salt) external override {
        (Window storage w, uint32 period) = _openWindow(seriesId);
        if (block.timestamp < w.commitEnd || block.timestamp >= w.revealEnd) revert NotRevealPhase();
        WindowStorage storage $ = _s();
        uint256 idx = side == Side.Bid
            ? $.bidIndexPlusOne[seriesId][period][msg.sender]
            : $.askIndexPlusOne[seriesId][period][msg.sender];
        if (idx == 0) revert OrderNotFound();
        Order storage o = $.orders[seriesId][period][idx - 1];
        if (o.revealed) revert OrderAlreadyRevealed();
        if (MercesMessages.orderCommitment(price, quantity, salt, msg.sender) != o.commitment) {
            revert CommitmentMismatch();
        }
        bool valid = price >= 1 && quantity >= 1;
        if (valid) {
            if (side == Side.Ask) {
                valid = quantity <= o.escrow;
            } else {
                SeriesCore memory core = registry().getSeriesCore(seriesId);
                SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
                uint256 cap = _capUnits(core, terms);
                uint256 bal = IERC3643Token(core.unitToken).balanceOf(msg.sender);
                uint256 room = cap > bal ? cap - bal : 0;
                valid = uint256(o.escrow) >= _requiredBidEscrow(terms, price, quantity) && quantity <= room;
            }
        }
        o.revealed = true;
        o.revealIndex = w.revealedCount;
        o.valid = valid;
        o.price = price;
        o.quantity = quantity;
        w.revealedCount += 1;
        if (valid) {
            if (side == Side.Bid) $.validBids[seriesId][period].push(uint32(idx - 1));
            else $.validAsks[seriesId][period].push(uint32(idx - 1));
        }
        emit OrderRevealed(seriesId, period, msg.sender, side, price, quantity, valid);
    }

    // ================================================================ settlement

    /// @inheritdoc IMercesWindow
    function beginWindowSettlement(uint256 seriesId, uint64 clearingPrice, bool noMatch) external override {
        (Window storage w, uint32 period) = _activeWindow(seriesId);
        if (w.state != WindowState.Open && w.state != WindowState.Settling) revert InvalidSettlementState();
        if (block.timestamp < w.revealEnd) revert RevealNotOver();
        if (!noMatch && clearingPrice == 0) revert InvalidProposal();
        w.state = WindowState.Settling;
        w.noMatchProposed = noMatch;
        w.clearingPrice = noMatch ? 0 : clearingPrice;
        w.dAbove = 0;
        w.dAt = 0;
        w.sBelow = 0;
        w.sAt = 0;
        w.maxBid = 0;
        w.minAsk = type(uint64).max;
        w.hasValidBid = false;
        w.hasValidAsk = false;
        w.tallied = 0;
        w.tallyRound += 1;
        emit WindowSettlementProposed(seriesId, period, w.clearingPrice, noMatch, w.tallyRound);
    }

    /// @inheritdoc IMercesWindow
    function tallyOrders(uint256 seriesId, uint256 fromIndex, uint256 toIndex) external override {
        (Window storage w, uint32 period) = _activeWindow(seriesId);
        if (w.state != WindowState.Settling) revert InvalidSettlementState();
        Order[] storage list = _s().orders[seriesId][period];
        if (fromIndex >= toIndex || toIndex > list.length) revert TallyRangeInvalid();
        if (toIndex - fromIndex > C.MAX_TALLY_PAGE) revert TallyPageTooLarge();
        uint32 round = w.tallyRound;
        uint64 p = w.clearingPrice;
        for (uint256 i = fromIndex; i < toIndex; i++) {
            Order storage o = list[i];
            if (!o.revealed || o.talliedRound == round) continue;
            o.talliedRound = round;
            w.tallied += 1;
            if (!o.valid) continue;
            if (o.side == Side.Bid) {
                if (!w.hasValidBid || o.price > w.maxBid) w.maxBid = o.price;
                w.hasValidBid = true;
                if (o.price > p) w.dAbove += o.quantity;
                else if (o.price == p) w.dAt += o.quantity;
            } else {
                if (!w.hasValidAsk || o.price < w.minAsk) w.minAsk = o.price;
                w.hasValidAsk = true;
                if (o.price < p) w.sBelow += o.quantity;
                else if (o.price == p) w.sAt += o.quantity;
            }
        }
    }

    /// @inheritdoc IMercesWindow
    function finalizeWindow(uint256 seriesId) external override {
        (Window storage w, uint32 period) = _activeWindow(seriesId);
        if (w.state != WindowState.Settling) revert InvalidSettlementState();
        if (w.tallied != w.revealedCount) revert TallyIncomplete();
        if (w.noMatchProposed) {
            if (w.hasValidBid && w.hasValidAsk && w.maxBid >= w.minAsk) revert InvalidProposal();
            w.state = WindowState.NoMatch;
            w.phase = PHASE_RETURNS;
            emit WindowNoMatch(seriesId, period);
        } else {
            uint256 supply = uint256(w.sBelow) + w.sAt;
            uint256 demand = uint256(w.dAbove) + w.dAt;
            bool caseA = supply > 0 && w.dAbove < supply && supply <= demand && w.dAt > 0;
            bool caseB = demand > 0 && demand < supply && w.sBelow <= demand && w.sAt > 0;
            if (!caseA && !caseB) revert InvalidProposal();
            w.supplyBinding = caseA;
            w.matchedUnits = uint64(caseA ? supply : demand);
            w.remainder = uint64(caseA ? supply - w.dAbove : demand - w.sBelow);
            w.state = WindowState.Settled;
            w.phase = PHASE_FIRST_SIDE;
            emit WindowCleared(seriesId, period, w.clearingPrice, w.matchedUnits);
        }
        _s().hasActive[seriesId] = false;
    }

    // ================================================================ ordered processing (anyone)

    /// @inheritdoc IMercesWindow
    /// @dev Advances the fixed processing order by up to `maxSteps` orders. Phase 0: the binding side (bids when
    /// supply binds, asks when demand binds) in descending reveal order with formula fills. Phase 1: the other
    /// side's orders at `p*`, descending reveal order, absorbing the unmatched remainder. Phase 2: the other side's
    /// remaining winners, same order. Phase 3: every order not yet processed gets its escrow back.
    function processOrders(uint256 seriesId, uint32 period, uint256 maxSteps) external override nonReentrant {
        WindowStorage storage $ = _s();
        Window storage w = $.windows[seriesId][period];
        if (w.state != WindowState.Settled && w.state != WindowState.NoMatch) revert WindowNotSettled();
        if (w.phase == PHASE_DONE) revert OrdersAlreadyProcessed();
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        Order[] storage list = $.orders[seriesId][period];
        for (uint256 step = 0; step < maxSteps && w.phase != PHASE_DONE; step++) {
            if (w.phase == PHASE_RETURNS) {
                if (w.cursor >= list.length) {
                    w.phase = PHASE_DONE;
                    break;
                }
                Order storage o = list[w.cursor];
                w.cursor += 1;
                if (!o.processed) _fill(seriesId, period, w, core, terms, o, 0);
                continue;
            }
            uint32[] storage side = _phaseList($, seriesId, period, w);
            if (w.cursor >= side.length) {
                _advancePhase(w);
                continue;
            }
            Order storage o = list[side[side.length - 1 - w.cursor]];
            w.cursor += 1;
            uint64 fill = _phaseFill(w, o);
            if (fill == 0 && w.phase != PHASE_FIRST_SIDE) continue; // not this phase's order; phase 3 returns it
            _fill(seriesId, period, w, core, terms, o, fill);
        }
    }

    function _phaseList(WindowStorage storage $, uint256 seriesId, uint32 period, Window storage w)
        internal
        view
        returns (uint32[] storage)
    {
        bool bids = w.phase == PHASE_FIRST_SIDE ? w.supplyBinding : !w.supplyBinding;
        return bids ? $.validBids[seriesId][period] : $.validAsks[seriesId][period];
    }

    function _advancePhase(Window storage w) internal {
        if (w.phase == PHASE_FIRST_SIDE) {
            w.dustRemaining = w.matchedUnits - w.firstSideFilled;
        } else if (w.phase == PHASE_SECOND_REST) {
            // the second side's nominal fills total `matched`, so the remainder is always absorbed
            if (w.dustRemaining != 0) revert InvalidProposal();
        }
        w.phase += 1;
        w.cursor = 0;
    }

    /// @dev Fill for the order under the current phase (0 when the order is not handled in this phase).
    function _phaseFill(Window storage w, Order storage o) internal returns (uint64 fill) {
        uint64 p = w.clearingPrice;
        if (w.phase == PHASE_FIRST_SIDE) {
            if (w.supplyBinding) {
                // bids: above p* fully, at p* floor(R × q / d_at)
                if (o.price > p) fill = o.quantity;
                else if (o.price == p) fill = uint64(MercesMath.mulDiv(w.remainder, o.quantity, w.dAt));
            } else {
                // asks: below p* fully, at p* floor(R × q / s_at)
                if (o.price < p) fill = o.quantity;
                else if (o.price == p) fill = uint64(MercesMath.mulDiv(w.remainder, o.quantity, w.sAt));
            }
            w.firstSideFilled += fill;
            return fill;
        }
        bool atPrice = o.price == p;
        bool winner = w.supplyBinding ? o.price < p : o.price > p;
        if (w.phase == PHASE_SECOND_AT ? !atPrice : !winner) return 0;
        fill = o.quantity;
        uint64 back = fill < w.dustRemaining ? fill : w.dustRemaining;
        w.dustRemaining -= back;
        fill -= back;
    }

    /// @dev Settles one order: moves stablecoin and units according to `fill`, returns the rest of the escrow.
    function _fill(
        uint256 seriesId,
        uint32 period,
        Window storage w,
        SeriesCore memory core,
        SeriesTerms memory terms,
        Order storage o,
        uint64 fill
    ) internal {
        o.processed = true;
        o.fill = fill;
        w.processed += 1;
        uint64 p = w.clearingPrice;
        IERC20 stable = IERC20(core.stablecoin);
        if (o.side == Side.Ask) {
            uint64 proceeds = uint64(uint256(p) * fill);
            uint64 back = o.escrow - fill;
            w.stableToSellers += proceeds;
            w.unitsReturned += back;
            emit OrderFilled(seriesId, period, o.owner, Side.Ask, fill, p, 0, back);
            if (proceeds > 0) stable.safeTransfer(o.owner, proceeds);
            if (back > 0) _deliverUnits(seriesId, core, terms, o.owner, back, false);
        } else {
            uint64 cost = uint64(uint256(p) * fill);
            uint64 fee = uint64(uint256(cost).bpsOf(terms.windowFeeBps));
            uint64 refund = o.escrow - cost - fee;
            w.feesTotal += fee;
            w.stableRefunded += refund;
            w.unitsDelivered += fill;
            emit OrderFilled(seriesId, period, o.owner, Side.Bid, fill, p, fee, refund);
            if (fee > 0) stable.safeTransfer(registry().feeCollector(), fee);
            if (refund > 0) stable.safeTransfer(o.owner, refund);
            if (fill > 0) _deliverUnits(seriesId, core, terms, o.owner, fill, true);
        }
    }

    /// @dev Moves `units` from the escrow to `to`, settling the holder's accrual first. A wallet that can no longer
    /// receive (removed from the allowlist, or a buyer over the wallet cap after a supply change) gets the units
    /// held here for `withdrawHeldUnits` instead, so settlement can never stall and no value is stranded.
    function _deliverUnits(
        uint256 seriesId,
        SeriesCore memory core,
        SeriesTerms memory terms,
        address to,
        uint64 units,
        bool checkCap
    ) internal {
        IERC3643Token token = IERC3643Token(core.unitToken);
        bool ok = registry().isAllowed(to);
        if (ok && checkCap) ok = token.balanceOf(to) + units <= _capUnits(core, terms);
        if (ok) {
            IPayoutClaims vault = IPayoutClaims(_contracts().vault);
            vault.registerHolder(seriesId, to);
            vault.settleHolder(seriesId, to);
            try token.transfer(to, units) returns (bool) {
                return;
            } catch {}
        }
        _s().heldUnits[seriesId][to] += units;
        emit UnitsHeld(seriesId, to, units);
    }

    /// @inheritdoc IMercesWindow
    function withdrawHeldUnits(uint256 seriesId, address wallet) external override nonReentrant {
        WindowStorage storage $ = _s();
        uint64 units = $.heldUnits[seriesId][wallet];
        if (units == 0) revert NothingHeld();
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        IERC3643Token token = IERC3643Token(core.unitToken);
        if (!registry().isAllowed(wallet) || token.balanceOf(wallet) + units > _capUnits(core, terms)) {
            revert CannotReceiveUnits();
        }
        $.heldUnits[seriesId][wallet] = 0;
        IPayoutClaims vault = IPayoutClaims(_contracts().vault);
        vault.registerHolder(seriesId, wallet);
        vault.settleHolder(seriesId, wallet);
        emit HeldUnitsWithdrawn(seriesId, wallet, units);
        token.transfer(wallet, units);
    }

    // ================================================================ views

    function armedDeposit(address from) external view override returns (uint256) {
        return _s().armedDeposit[from];
    }

    function activeWindow(uint256 seriesId) external view override returns (bool active, uint32 period) {
        return (_s().hasActive[seriesId], _s().activePeriod[seriesId]);
    }

    function getWindow(uint256 seriesId, uint32 period) external view override returns (Window memory) {
        return _s().windows[seriesId][period];
    }

    function getOrder(uint256 seriesId, uint32 period, uint256 index) external view override returns (Order memory) {
        Order[] storage list = _s().orders[seriesId][period];
        if (index >= list.length) revert OrderNotFound();
        return list[index];
    }

    function orderIndexOf(uint256 seriesId, uint32 period, address owner, Side side)
        external
        view
        override
        returns (bool exists, uint256 index)
    {
        uint256 idx = side == Side.Bid
            ? _s().bidIndexPlusOne[seriesId][period][owner]
            : _s().askIndexPlusOne[seriesId][period][owner];
        return (idx != 0, idx == 0 ? 0 : idx - 1);
    }

    function heldUnits(uint256 seriesId, address wallet) external view override returns (uint64) {
        return _s().heldUnits[seriesId][wallet];
    }

    /// @inheritdoc IMercesWindow
    function walletCapUnits(uint256 seriesId) external view override returns (uint64) {
        return uint64(_capUnits(registry().getSeriesCore(seriesId), registry().getSeriesTerms(seriesId)));
    }

    /// @inheritdoc IMercesWindow
    function requiredBidEscrow(uint256 seriesId, uint64 price, uint64 quantity)
        external
        view
        override
        returns (uint256)
    {
        return _requiredBidEscrow(registry().getSeriesTerms(seriesId), price, quantity);
    }

    // ================================================================ internals

    function _openWindow(uint256 seriesId) internal view returns (Window storage w, uint32 period) {
        (w, period) = _activeWindow(seriesId);
        if (w.state != WindowState.Open) revert InvalidSettlementState();
    }

    function _activeWindow(uint256 seriesId) internal view returns (Window storage w, uint32 period) {
        WindowStorage storage $ = _s();
        if (!$.hasActive[seriesId]) revert NoActiveWindow();
        period = $.activePeriod[seriesId];
        w = $.windows[seriesId][period];
    }

    /// @dev `wallet_cap_units = floor(units_outstanding × wallet_cap_bps / 10000)`.
    function _capUnits(SeriesCore memory core, SeriesTerms memory terms) internal view returns (uint256) {
        return IERC3643Token(core.unitToken).totalSupply().bpsOf(terms.walletCapBps);
    }

    function _requiredBidEscrow(SeriesTerms memory terms, uint64 price, uint64 quantity)
        internal
        pure
        returns (uint256)
    {
        uint256 cost = uint256(price) * quantity;
        return cost + cost.bpsOf(terms.windowFeeBps);
    }
}
