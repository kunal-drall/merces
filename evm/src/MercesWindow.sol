// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MercesUpgradeable} from "./base/MercesUpgradeable.sol";
import {
    IMercesWindow,
    REJECT_WINDOW_CROSSING_EXISTS,
    REJECT_WINDOW_NO_BRANCH,
    REJECT_WINDOW_PRICE_NOT_REVEALED
} from "./interfaces/IMercesWindow.sol";
import {IMercesIncome} from "./interfaces/IMercesIncome.sol";
import {IMercesVault} from "./interfaces/IMercesVault.sol";
import {IERC3643Token} from "./interfaces/external/IERC3643Token.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesMessages} from "./libraries/MercesMessages.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {Periods} from "./libraries/Periods.sol";
import {ProtocolContracts, SeriesCore, SeriesStatus, SeriesTerms} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesWindow
/// @notice Quarterly sealed call auction per series (D9, SPEC v1.1 §7). Sellers escrow units with sealed asks,
/// buyers escrow stablecoin with sealed bids (one order per wallet per window), a keeper proposes a clearing
/// price or `NO_MATCH` and the contract validates it against a paged tally with the two-branch rule (supply- or
/// demand-limited), so a crossing price always exists. Fills at the margin are first-come in reveal order, so
/// the matched volume is exact and the window is always solvent. Bids are processed first (marginal bids behind
/// a cursor), then asks in reveal order against the pool of units buyers actually took, so a buyer that lost
/// its allowlist flag at fill time simply gets its escrow back and the unmatched units return to the latest
/// sellers. This contract is the only path through which units move between wallets: the compliance module
/// admits transfers into the escrow only when this contract has armed them (`armedDeposit`) and transfers out
/// only from this contract.
contract MercesWindow is MercesUpgradeable, IMercesWindow {
    using SafeERC20 for IERC20;
    using MercesMath for uint256;

    /// @custom:storage-location erc7201:merces.storage.MercesWindow
    struct WindowStorage {
        mapping(uint256 => mapping(uint32 => Window)) windows;
        mapping(uint256 => mapping(uint32 => Order[])) orders;
        mapping(uint256 => mapping(uint32 => mapping(address => uint256))) orderIndexPlusOne;
        // valid revealed orders per side and price, in reveal order (marginal processing)
        mapping(uint256 => mapping(uint32 => mapping(Side => mapping(uint64 => uint32[])))) byPrice;
        // valid revealed asks in reveal order (ask processing)
        mapping(uint256 => mapping(uint32 => uint32[])) asksByReveal;
        mapping(uint256 => bool) hasActive;
        mapping(uint256 => uint32) activePeriod;
        mapping(uint256 => uint32) unprocessedOrders;
        mapping(uint256 => mapping(address => uint64)) askEscrow;
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
    /// while the series is OnTime or InGrace, the mint is final, windows are enabled and the previous window is
    /// fully processed (so the reveal-time wallet-cap bound is exact).
    function openWindow(uint256 seriesId, uint32 period) external override {
        if (!registry().getFlags().windowsEnabled) revert WindowsDisabled();
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        if (!core.mintFinalized) revert MintNotFinalized();
        if (block.timestamp < uint256(core.settlementTs) + terms.lockupSeconds) revert LockupActive();
        IMercesIncome income = IMercesIncome(_contracts().income);
        SeriesStatus st = income.deriveStatus(seriesId);
        if (st != SeriesStatus.OnTime && st != SeriesStatus.InGrace) revert WindowNotEligibleStatus();
        (bool hasPaid, uint32 lastPaid) = income.lastPaidPeriod(seriesId);
        if (!hasPaid || lastPaid < period) revert ReportNotPaid();
        uint32 expected = Periods.periodOf(block.timestamp) - 1;
        if (period != expected) revert WrongWindowPeriod(expected, period);
        WindowStorage storage $ = _s();
        if ($.hasActive[seriesId] || $.unprocessedOrders[seriesId] != 0) revert WindowAlreadyOpen();
        Window storage w = $.windows[seriesId][period];
        if (w.state != WindowState.None) revert WindowAlreadyOpen();
        w.state = WindowState.Open;
        w.period = period;
        w.opensAt = uint64(block.timestamp);
        w.commitEnd = w.opensAt + terms.windowCommitDuration;
        w.revealEnd = w.commitEnd + terms.windowRevealDuration;
        $.hasActive[seriesId] = true;
        $.activePeriod[seriesId] = period;
        emit WindowOpened(seriesId, period, w.commitEnd, w.revealEnd);
    }

    // ================================================================ commit

    /// @inheritdoc IMercesWindow
    /// @dev Settles the seller's payout accrual first, arms the deposit so the compliance module admits exactly
    /// this transfer into the escrow, and pulls the units. The seller's accrual weight is unchanged (ask-escrow
    /// units count, SPEC §6.1).
    function commitAsk(uint256 seriesId, bytes32 commitment, uint64 units) external override nonReentrant {
        (Window storage w, uint32 period) = _openWindow(seriesId);
        if (block.timestamp >= w.commitEnd) revert CommitPhaseOver();
        if (units == 0) revert ZeroUnits();
        WindowStorage storage $ = _s();
        _newOrder($, w, seriesId, period, Side.Ask, commitment, units);
        w.escrowUnits += units;
        $.askEscrow[seriesId][msg.sender] += units;
        emit OrderCommitted(seriesId, period, msg.sender, Side.Ask, units);

        IMercesVault(_contracts().vault).settleHolder(seriesId, msg.sender);
        IERC3643Token token = IERC3643Token(registry().getSeriesCore(seriesId).unitToken);
        $.armedDeposit[msg.sender] = units;
        if (!token.transferFrom(msg.sender, address(this), units)) revert TransferFailed();
        delete $.armedDeposit[msg.sender];
    }

    /// @inheritdoc IMercesWindow
    function commitBid(uint256 seriesId, bytes32 commitment, uint64 escrow) external override nonReentrant {
        (Window storage w, uint32 period) = _openWindow(seriesId);
        if (block.timestamp >= w.commitEnd) revert CommitPhaseOver();
        if (!registry().isAllowed(msg.sender)) revert WalletNotAllowlisted(msg.sender);
        if (escrow == 0) revert ZeroEscrow();
        _newOrder(_s(), w, seriesId, period, Side.Bid, commitment, escrow);
        w.bidCount += 1;
        w.escrowStable = (uint256(w.escrowStable) + escrow).toU64();
        emit OrderCommitted(seriesId, period, msg.sender, Side.Bid, escrow);
        IERC20(registry().getSeriesCore(seriesId).stablecoin).safeTransferFrom(msg.sender, address(this), escrow);
    }

    function _newOrder(
        WindowStorage storage $,
        Window storage w,
        uint256 seriesId,
        uint32 period,
        Side side,
        bytes32 commitment,
        uint64 escrow
    ) internal {
        if ($.orderIndexPlusOne[seriesId][period][msg.sender] != 0) revert OrderAlreadyExists();
        Order[] storage list = $.orders[seriesId][period];
        if (list.length >= C.MAX_ORDERS_PER_WINDOW) revert TooManyOrders();
        list.push();
        Order storage o = list[list.length - 1];
        o.owner = msg.sender;
        o.side = side;
        o.commitment = commitment;
        o.escrow = escrow;
        $.orderIndexPlusOne[seriesId][period][msg.sender] = list.length;
        w.orderCount += 1;
        $.unprocessedOrders[seriesId] += 1;
    }

    // ================================================================ reveal

    /// @inheritdoc IMercesWindow
    /// @dev Validity (SPEC §7): `price ≥ 1`, `quantity ≥ 1`; asks `quantity ≤ escrow_units`; bids
    /// `escrow ≥ p×q + fee` and `balance(owner) + quantity ≤ wallet_cap_units`. A failure records `valid = false`.
    function revealOrder(uint256 seriesId, uint64 price, uint64 quantity, bytes32 salt) external override {
        (Window storage w, uint32 period) = _openWindow(seriesId);
        if (block.timestamp < w.commitEnd || block.timestamp >= w.revealEnd) revert NotRevealPhase();
        WindowStorage storage $ = _s();
        uint256 idx = $.orderIndexPlusOne[seriesId][period][msg.sender];
        if (idx == 0) revert OrderNotFound();
        Order storage o = $.orders[seriesId][period][idx - 1];
        if (o.revealed) revert OrderAlreadyRevealed();
        if (MercesMessages.orderCommitment(price, quantity, salt, msg.sender) != o.commitment) {
            revert CommitmentMismatch();
        }
        bool valid = price >= 1 && quantity >= 1;
        if (valid) {
            if (o.side == Side.Ask) {
                valid = quantity <= o.escrow;
            } else {
                SeriesCore memory core = registry().getSeriesCore(seriesId);
                SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
                uint256 bal = IERC3643Token(core.unitToken).balanceOf(msg.sender);
                valid = uint256(o.escrow) >= _requiredBidEscrow(terms, price, quantity)
                    && bal + quantity <= _capUnits(seriesId, terms);
            }
        }
        o.revealed = true;
        o.revealIndex = w.revealedCount;
        o.valid = valid;
        o.price = price;
        o.quantity = quantity;
        w.revealedCount += 1;
        if (valid) {
            $.byPrice[seriesId][period][o.side][price].push(uint32(idx - 1));
            if (o.side == Side.Ask) $.asksByReveal[seriesId][period].push(uint32(idx - 1));
        }
        emit OrderRevealed(seriesId, period, msg.sender, o.side, price, quantity, valid);
    }

    // ================================================================ settlement

    /// @inheritdoc IMercesWindow
    /// @dev A new proposal is accepted only when no round is in progress or the completed round was rejected.
    function beginWindowSettlement(uint256 seriesId, uint64 clearingPrice, bool noMatch) external override {
        (Window storage w, uint32 period) = _activeWindow(seriesId);
        if (w.state != WindowState.Open && w.state != WindowState.Settling) revert InvalidSettlementState();
        if (block.timestamp < w.revealEnd) revert RevealNotOver();
        if (w.tallyRound != 0 && !w.roundRejected) revert TallyInProgress();
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
        w.validCount = 0;
        w.talliedCount = 0;
        w.roundRejected = false;
        w.tallyRound += 1;
        emit WindowSettlementProposed(seriesId, period, w.clearingPrice, noMatch, w.tallyRound);
    }

    /// @inheritdoc IMercesWindow
    function tallyOrders(uint256 seriesId, uint256 fromIndex, uint256 toIndex) external override {
        (Window storage w, uint32 period) = _activeWindow(seriesId);
        if (w.state != WindowState.Settling || w.roundRejected) revert InvalidSettlementState();
        Order[] storage list = _s().orders[seriesId][period];
        if (fromIndex >= toIndex || toIndex > list.length) revert TallyRangeInvalid();
        if (toIndex - fromIndex > C.MAX_TALLY_PAGE) revert TallyPageTooLarge();
        uint32 round = w.tallyRound;
        uint64 p = w.clearingPrice;
        for (uint256 i = fromIndex; i < toIndex; i++) {
            Order storage o = list[i];
            if (!o.revealed || o.talliedRound == round) continue;
            o.talliedRound = round;
            w.talliedCount += 1;
            if (!o.valid) continue;
            w.validCount += 1;
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
    /// @dev SPEC §7 `finalize_window`: `NO_MATCH` is valid iff no valid orders or `max_bid < min_ask`; otherwise
    /// `p*` must be a revealed valid price and exactly one of (A) supply-limited `S > 0 && d_above < S && S ≤ D`
    /// or (B) demand-limited `D > 0 && s_below ≤ D && D < S` must hold. A wrong proposal is rejected, not reverted.
    function finalizeWindow(uint256 seriesId) external override {
        (Window storage w, uint32 period) = _activeWindow(seriesId);
        if (w.state != WindowState.Settling || w.roundRejected) revert InvalidSettlementState();
        if (w.talliedCount != w.revealedCount) revert TallyIncomplete();
        if (w.noMatchProposed) {
            bool crossing = w.hasValidBid && w.hasValidAsk && w.maxBid >= w.minAsk;
            if (crossing) {
                _reject(seriesId, period, w, REJECT_WINDOW_CROSSING_EXISTS);
                return;
            }
            w.state = WindowState.NoMatch;
            _s().hasActive[seriesId] = false;
            emit WindowNoMatch(seriesId, period);
            return;
        }
        if (w.dAt == 0 && w.sAt == 0) {
            _reject(seriesId, period, w, REJECT_WINDOW_PRICE_NOT_REVEALED);
            return;
        }
        uint256 supply = uint256(w.sBelow) + w.sAt;
        uint256 demand = uint256(w.dAbove) + w.dAt;
        bool supplyLimited = supply > 0 && w.dAbove < supply && supply <= demand;
        bool demandLimited = demand > 0 && w.sBelow <= demand && demand < supply;
        if (!supplyLimited && !demandLimited) {
            _reject(seriesId, period, w, REJECT_WINDOW_NO_BRANCH);
            return;
        }
        w.branch = supplyLimited ? Branch.SupplyLimited : Branch.DemandLimited;
        w.matchedUnits = uint64(supplyLimited ? supply : demand);
        w.marginalRemaining = uint64(supplyLimited ? supply - w.dAbove : demand - w.sBelow);
        w.state = WindowState.Settled;
        _s().hasActive[seriesId] = false;
        emit WindowCleared(seriesId, period, w.clearingPrice, w.matchedUnits, w.branch);
    }

    function _reject(uint256 seriesId, uint32 period, Window storage w, uint8 reason) internal {
        w.roundRejected = true;
        emit WindowSettlementRejected(seriesId, period, w.clearingPrice, reason);
    }

    // ================================================================ processing (anyone)

    /// @inheritdoc IMercesWindow
    /// @dev Exhaustive cases (SPEC §7 `process_order`): `NoMatch`, unrevealed or invalid orders get their full
    /// escrow back (any order). In a settled window every bid is processed before any ask (`BidsPending`):
    /// non-marginal bids in any order, marginal bids (branch A, at `p*`) in ascending reveal order (`OutOfOrder`);
    /// then every valid ask in ascending reveal order, filled from the pool of units the buyers actually took.
    function processOrder(uint256 seriesId, uint32 period, uint256 orderIndex) external override nonReentrant {
        WindowStorage storage $ = _s();
        Window storage w = $.windows[seriesId][period];
        if (w.state != WindowState.Settled && w.state != WindowState.NoMatch) revert WindowNotSettled();
        Order[] storage list = $.orders[seriesId][period];
        if (orderIndex >= list.length) revert OrderNotFound();
        Order storage o = list[orderIndex];
        if (o.processed) revert OrderAlreadyProcessed();
        uint64 fill;
        if (w.state == WindowState.Settled && o.revealed && o.valid) {
            fill = o.side == Side.Bid
                ? _bidFill($, w, seriesId, period, o, uint32(orderIndex))
                : _askFill($, w, seriesId, period, o, uint32(orderIndex));
        }
        if (o.side == Side.Bid) w.bidsProcessed += 1;
        _settleOrder(seriesId, period, w, o, fill);
    }

    /// @dev Branch A: `> p*` full, `== p*` marginal behind the cursor, `< p*` nothing. Branch B: `≥ p*` full.
    /// A buyer that is no longer allowlisted has its fill cancelled (full refund); the nominal marginal fill is
    /// still consumed so the units return to the sellers rather than moving to the next buyer.
    function _bidFill(
        WindowStorage storage $,
        Window storage w,
        uint256 seriesId,
        uint32 period,
        Order storage o,
        uint32 orderIndex
    ) internal returns (uint64 fill) {
        uint64 p = w.clearingPrice;
        if (o.price > p || (o.price == p && w.branch == Branch.DemandLimited)) {
            fill = o.quantity;
        } else if (o.price == p) {
            uint32[] storage marginal = $.byPrice[seriesId][period][Side.Bid][p];
            if (w.marginalCursor >= marginal.length || marginal[w.marginalCursor] != orderIndex) revert OutOfOrder();
            w.marginalCursor += 1;
            fill = uint64(MercesMath.min(o.quantity, w.marginalRemaining));
            w.marginalRemaining -= fill;
        }
        if (fill > 0 && !registry().isAllowed(o.owner)) fill = 0;
        w.unitsPool += fill;
    }

    /// @dev Asks are processed after every bid, in reveal order, and never receive more than the pool holds.
    /// Branch A: `≤ p*` full; branch B: `< p*` full, `== p*` marginal; `> p*` nothing.
    function _askFill(
        WindowStorage storage $,
        Window storage w,
        uint256 seriesId,
        uint32 period,
        Order storage o,
        uint32 orderIndex
    ) internal returns (uint64 fill) {
        if (w.bidsProcessed != w.bidCount) revert BidsPending();
        uint32[] storage asks = $.asksByReveal[seriesId][period];
        if (w.askCursor >= asks.length || asks[w.askCursor] != orderIndex) revert OutOfOrder();
        w.askCursor += 1;
        uint64 p = w.clearingPrice;
        if (o.price < p || (o.price == p && w.branch == Branch.SupplyLimited)) {
            fill = o.quantity;
        } else if (o.price == p) {
            fill = uint64(MercesMath.min(o.quantity, w.marginalRemaining));
            w.marginalRemaining -= fill;
        }
        if (fill > w.unitsPool) fill = w.unitsPool;
        w.unitsPool -= fill;
    }

    /// @dev Moves stablecoin and units according to `fill` and returns the rest of the escrow to its owner.
    function _settleOrder(uint256 seriesId, uint32 period, Window storage w, Order storage o, uint64 fill) internal {
        o.processed = true;
        o.fill = fill;
        w.processedCount += 1;
        _s().unprocessedOrders[seriesId] -= 1;
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        uint64 p = w.clearingPrice;
        IERC20 stable = IERC20(core.stablecoin);
        IMercesVault vault = IMercesVault(_contracts().vault);
        if (o.side == Side.Ask) {
            uint64 proceeds = uint64(uint256(p) * fill);
            uint64 back = o.escrow - fill;
            w.stableToSellers += proceeds;
            w.unitsReturned += back;
            emit OrderFilled(seriesId, period, o.owner, Side.Ask, fill, p, 0, back);
            // settle before the escrowed units leave the seller's accrual weight
            vault.settleHolder(seriesId, o.owner);
            _s().askEscrow[seriesId][o.owner] -= o.escrow;
            if (proceeds > 0) stable.safeTransfer(o.owner, proceeds);
            if (back > 0 && !IERC3643Token(core.unitToken).transfer(o.owner, back)) revert TransferFailed();
        } else {
            uint64 cost = uint64(uint256(p) * fill);
            uint64 fee = uint64(uint256(cost).bpsOf(registry().getSeriesTerms(seriesId).windowFeeBps));
            uint64 refund = o.escrow - cost - fee;
            w.feesTotal += fee;
            w.stableRefunded += refund;
            w.unitsDelivered += fill;
            emit OrderFilled(seriesId, period, o.owner, Side.Bid, fill, p, fee, refund);
            if (fee > 0) stable.safeTransfer(registry().feeCollector(), fee);
            if (refund > 0) stable.safeTransfer(o.owner, refund);
            if (fill > 0) {
                vault.registerHolder(seriesId, o.owner);
                vault.settleHolder(seriesId, o.owner);
                if (!IERC3643Token(core.unitToken).transfer(o.owner, fill)) revert TransferFailed();
            }
        }
    }

    // ================================================================ views

    function armedDeposit(address from) external view override returns (uint256) {
        return _s().armedDeposit[from];
    }

    function activeWindow(uint256 seriesId) external view override returns (bool active, uint32 period) {
        return (_s().hasActive[seriesId], _s().activePeriod[seriesId]);
    }

    /// @inheritdoc IMercesWindow
    function hasPendingOrders(uint256 seriesId) external view override returns (bool) {
        return _s().hasActive[seriesId] || _s().unprocessedOrders[seriesId] != 0;
    }

    /// @inheritdoc IMercesWindow
    function askEscrowUnits(uint256 seriesId, address wallet) external view override returns (uint64) {
        return _s().askEscrow[seriesId][wallet];
    }

    function getWindow(uint256 seriesId, uint32 period) external view override returns (Window memory) {
        return _s().windows[seriesId][period];
    }

    function getOrder(uint256 seriesId, uint32 period, uint256 index) external view override returns (Order memory) {
        Order[] storage list = _s().orders[seriesId][period];
        if (index >= list.length) revert OrderNotFound();
        return list[index];
    }

    function orderIndexOf(uint256 seriesId, uint32 period, address owner)
        external
        view
        override
        returns (bool exists, uint256 index)
    {
        uint256 idx = _s().orderIndexPlusOne[seriesId][period][owner];
        return (idx != 0, idx == 0 ? 0 : idx - 1);
    }

    /// @inheritdoc IMercesWindow
    function nextMarginalOrder(uint256 seriesId, uint32 period)
        external
        view
        override
        returns (bool exists, uint256 index)
    {
        Window storage w = _s().windows[seriesId][period];
        if (w.state != WindowState.Settled || w.branch != Branch.SupplyLimited) return (false, 0);
        uint32[] storage marginal = _s().byPrice[seriesId][period][Side.Bid][w.clearingPrice];
        if (w.marginalCursor >= marginal.length) return (false, 0);
        return (true, marginal[w.marginalCursor]);
    }

    /// @inheritdoc IMercesWindow
    function nextAskOrder(uint256 seriesId, uint32 period) external view override returns (bool exists, uint256 index) {
        Window storage w = _s().windows[seriesId][period];
        if (w.state != WindowState.Settled) return (false, 0);
        uint32[] storage asks = _s().asksByReveal[seriesId][period];
        if (w.askCursor >= asks.length) return (false, 0);
        return (true, asks[w.askCursor]);
    }

    /// @inheritdoc IMercesWindow
    function walletCapUnits(uint256 seriesId) external view override returns (uint64) {
        return uint64(_capUnits(seriesId, registry().getSeriesTerms(seriesId)));
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

    /// @dev `wallet_cap_units = floor(units_outstanding × wallet_cap_bps / 10000)` with the stored supply.
    function _capUnits(uint256 seriesId, SeriesTerms memory terms) internal view returns (uint256) {
        return uint256(IMercesVault(_contracts().vault).unitsOutstanding(seriesId)).bpsOf(terms.walletCapBps);
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
