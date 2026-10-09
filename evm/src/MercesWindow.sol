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
import {IMercesAuction} from "./interfaces/IMercesAuction.sol";
import {IERC3643Token} from "./interfaces/external/IERC3643Token.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesMessages} from "./libraries/MercesMessages.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {Periods} from "./libraries/Periods.sol";
import {RaiseState, SeriesCore, SeriesStatus, SeriesTerms} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesWindow
/// @notice Quarterly sealed call auction per series (D9, SPEC v1.1 §7). Sellers escrow units with sealed asks,
/// buyers escrow stablecoin with sealed bids (one order per wallet per window), a keeper proposes a clearing
/// price or `NO_MATCH` and the contract validates it against a paged tally with the two-branch rule (supply- or
/// demand-limited), so a crossing price always exists. A wrong proposal is recorded, never reverted, and an
/// incomplete round cannot be reset.
///
/// Fills follow SPEC §7: the full side fills in full, the losing side not at all, and the marginal side first-come
/// in ascending reveal index — computed in O(1) from the quantity of valid same-price orders revealed earlier
/// (recorded at reveal). Processing follows the reveal order (B-S9): revealed bids in ascending reveal index, then
/// revealed asks in ascending reveal index; unrevealed orders and `NO_MATCH` windows in any order. A filled bid
/// whose buyer is no longer allowlisted at fill is cancelled (full refund) and its units are taken back from the
/// sell side: from the asks at `p*` in descending reveal index, then from the asks below `p*` in descending
/// (price, reveal index) order (B-S12), so sellers' proceeds always equal buyers' payments. When the take-back
/// reaches below `p*` a keeper first indexes the ask price levels below `p*` (`indexAskPrices`, verified complete
/// by their quantity sum; `WindowTakebackSettled`).
///
/// Liveness (SPEC §12, B-S13): settlement is two steps. `processOrder` does the accounting and pays the fee to the
/// collector (protocol accounts only); `deliverOrder` pushes the recorded units and stablecoin to the owner, once,
/// retryable forever, so no recipient can block another order. Units awaiting delivery count in their owner's
/// accrual weight (`pendingUnitsOf`). This contract is the only path through which units move between wallets:
/// the compliance module admits transfers into the escrow only when this contract has armed them
/// (`armedDeposit`) and transfers out only from this contract.
contract MercesWindow is MercesUpgradeable, IMercesWindow {
    using SafeERC20 for IERC20;
    using MercesMath for uint256;

    /// @custom:storage-location erc7201:merces.storage.MercesWindow
    struct WindowStorage {
        mapping(uint256 => mapping(uint32 => Window)) windows;
        mapping(uint256 => mapping(uint32 => Order[])) orders;
        mapping(uint256 => mapping(uint32 => mapping(address => uint256))) orderIndexPlusOne;
        // Σ quantity of valid revealed orders per side and price (reveal order), for first-come margins
        mapping(uint256 => mapping(uint32 => mapping(Side => mapping(uint64 => uint64)))) qtyAtPrice;
        // Σ valid ask quantity of the indexed price levels strictly below a level (take-back below p*)
        mapping(uint256 => mapping(uint32 => mapping(uint64 => uint64))) cumBelow;
        mapping(uint256 => bool) hasWindow;
        mapping(uint256 => uint32) currentPeriod;
        mapping(uint256 => mapping(address => uint64)) askEscrow;
        // window units processed for a wallet but not yet delivered (all windows of the series)
        mapping(uint256 => mapping(address => uint64)) pendingUnits;
        // order indices per side in reveal order (the processing sequence)
        mapping(uint256 => mapping(uint32 => mapping(Side => uint32[]))) revealed;
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
    /// fully processed (so the reveal-time wallet-cap bound is exact). One window per quarter.
    function openWindow(uint256 seriesId, uint32 period) external override {
        if (!registry().getFlags().windowsEnabled) revert WindowsDisabled();
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (core.raiseState != RaiseState.Settled) revert RaiseNotSettled();
        if (!core.mintFinalized) revert MintNotFinalized();
        IMercesIncome income = IMercesIncome(_contracts().income);
        SeriesStatus st = income.deriveStatus(seriesId);
        if (st != SeriesStatus.OnTime && st != SeriesStatus.InGrace) revert WindowNotEligible();
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        if (block.timestamp < uint256(core.settlementTs) + terms.lockupSeconds) revert LockupActive();
        (bool hasPaid, uint32 lastPaid) = income.lastPaidPeriod(seriesId);
        if (!hasPaid || lastPaid < period) revert WindowNotEligible();
        if (period != Periods.periodOf(block.timestamp) - 1) revert WindowNotEligible();
        WindowStorage storage $ = _s();
        if ($.hasWindow[seriesId] && $.windows[seriesId][$.currentPeriod[seriesId]].state != WindowState.Done) {
            revert WindowOpen();
        }
        Window storage w = $.windows[seriesId][period];
        if (w.state != WindowState.None) revert WindowOpen();
        w.state = WindowState.Commit;
        w.period = period;
        w.opensAt = uint64(block.timestamp);
        w.commitEnd = w.opensAt + terms.windowCommitDuration;
        w.revealEnd = w.commitEnd + terms.windowRevealDuration;
        $.hasWindow[seriesId] = true;
        $.currentPeriod[seriesId] = period;
        emit WindowOpened(seriesId, period, w.commitEnd, w.revealEnd);
        income.crankStatus(seriesId); // sync_status (SPEC §1.7)
    }

    // ================================================================ commit

    /// @inheritdoc IMercesWindow
    /// @dev Settles the seller's payout accrual first, arms the deposit so the compliance module admits exactly
    /// this transfer into the escrow, and pulls the units. The seller's accrual weight is unchanged (ask-escrow
    /// units count, SPEC §6.1).
    function commitAsk(uint256 seriesId, bytes32 commitment, uint256 units) external override nonReentrant {
        (Window storage w, uint32 period) = _commitWindow(seriesId);
        WindowStorage storage $ = _s();
        if ($.orderIndexPlusOne[seriesId][period][msg.sender] != 0) revert OrderExists();
        uint64 amount = units.toU64();
        IERC3643Token token = IERC3643Token(registry().getSeriesCore(seriesId).unitToken);
        if (amount == 0 || amount > token.balanceOf(msg.sender)) revert InsufficientUnits();
        IMercesVault(_contracts().vault).settleHolder(seriesId, msg.sender);
        _newOrder($, w, seriesId, period, Side.Ask, commitment, amount);
        w.escrowUnits += amount;
        $.askEscrow[seriesId][msg.sender] += amount;
        emit OrderCommitted(seriesId, period, msg.sender, Side.Ask, amount);

        $.armedDeposit[msg.sender] = amount;
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        delete $.armedDeposit[msg.sender];
    }

    /// @inheritdoc IMercesWindow
    function commitBid(uint256 seriesId, bytes32 commitment, uint256 escrow) external override nonReentrant {
        (Window storage w, uint32 period) = _commitWindow(seriesId);
        WindowStorage storage $ = _s();
        if ($.orderIndexPlusOne[seriesId][period][msg.sender] != 0) revert OrderExists();
        if (!registry().isAllowed(msg.sender)) revert NotAllowlisted(msg.sender);
        uint64 amount = escrow.toU64();
        if (amount == 0) revert ZeroEscrow();
        _newOrder($, w, seriesId, period, Side.Bid, commitment, amount);
        w.bidCount += 1;
        w.escrowStable = (uint256(w.escrowStable) + amount).toU64();
        emit OrderCommitted(seriesId, period, msg.sender, Side.Bid, amount);
        IERC20(registry().getSeriesCore(seriesId).stablecoin).safeTransferFrom(msg.sender, address(this), amount);
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
    }

    // ================================================================ reveal

    /// @inheritdoc IMercesWindow
    /// @dev Validity (SPEC §7, B-S19): `price ≥ 1`, `quantity ≥ 1`; asks `quantity ≤ escrow_units`; bids
    /// `escrow ≥ p×q + fee` and `owned(owner) + quantity ≤ wallet_cap_units`, where owned = balance + undelivered
    /// auction units + ask escrow + window units awaiting delivery. A failure records `valid = false`.
    function revealOrder(uint256 seriesId, uint256 price, uint256 quantity, bytes32 salt) external override {
        uint64 p = price.toU64();
        uint64 q = quantity.toU64();
        (Window storage w, uint32 period) = _current(seriesId);
        if (w.state != WindowState.Commit && w.state != WindowState.Reveal) revert WindowNotOpen();
        if (block.timestamp < w.commitEnd || block.timestamp >= w.revealEnd) revert RevealPhaseClosed();
        w.state = WindowState.Reveal;
        WindowStorage storage $ = _s();
        uint256 idx = $.orderIndexPlusOne[seriesId][period][msg.sender];
        if (idx == 0) revert BidNotFound();
        Order storage o = $.orders[seriesId][period][idx - 1];
        if (o.revealed) revert AlreadyRevealed();
        if (MercesMessages.orderCommitment(p, q, salt, msg.sender) != o.commitment) revert CommitmentMismatch();
        bool valid = _revealValid($, seriesId, o, p, q);
        _recordReveal($, w, seriesId, period, uint32(idx - 1), p, q, valid);
    }

    function _revealValid(WindowStorage storage $, uint256 seriesId, Order storage o, uint64 p, uint64 q)
        internal
        view
        returns (bool)
    {
        if (p < 1 || q < 1) return false;
        if (o.side == Side.Ask) return q <= o.escrow;
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        return uint256(o.escrow) >= _requiredBidEscrow(terms, p, q)
            && _ownedUnits($, seriesId, o.owner) + q <= _capUnits(seriesId, terms);
    }

    /// @dev Per-side reveal index (the processing sequence), first-come prefix at the price.
    function _recordReveal(
        WindowStorage storage $,
        Window storage w,
        uint256 seriesId,
        uint32 period,
        uint32 index,
        uint64 p,
        uint64 q,
        bool valid
    ) internal {
        Order storage o = $.orders[seriesId][period][index];
        o.revealed = true;
        if (o.side == Side.Bid) o.revealIndex = w.revealedBids++;
        else o.revealIndex = w.revealedAsks++;
        $.revealed[seriesId][period][o.side].push(index);
        o.valid = valid;
        o.price = p;
        o.quantity = q;
        w.revealedCount += 1;
        if (valid) {
            mapping(uint64 => uint64) storage atPrice = $.qtyAtPrice[seriesId][period][o.side];
            o.samePricePrefix = atPrice[p];
            atPrice[p] = (uint256(atPrice[p]) + q).toU64();
        }
        emit OrderRevealed(seriesId, period, o.owner, o.side, p, q, valid);
    }

    // ================================================================ settlement

    /// @inheritdoc IMercesWindow
    /// @dev A new proposal is accepted only when no round is in progress or the completed round was rejected.
    function beginWindowSettlement(uint256 seriesId, uint256 clearingPrice, bool noMatch) external override {
        (Window storage w, uint32 period) = _current(seriesId);
        if (w.state != WindowState.Commit && w.state != WindowState.Reveal && w.state != WindowState.Settling) {
            revert WindowNotOpen();
        }
        if (block.timestamp < w.revealEnd) revert SettlementNotReady();
        if (w.tallyRound != 0 && !w.roundRejected) revert TallyInProgress();
        uint64 p = noMatch ? 0 : clearingPrice.toU64();
        w.state = WindowState.Settling;
        w.noMatchProposed = noMatch;
        w.proposedPrice = p;
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
        emit WindowSettlementProposed(seriesId, period, noMatch ? type(uint64).max : p, noMatch, w.tallyRound);
    }

    /// @inheritdoc IMercesWindow
    function tallyOrders(uint256 seriesId, uint256 fromIndex, uint256 toIndex) external override {
        (Window storage w, uint32 period) = _current(seriesId);
        if (w.state != WindowState.Settling || w.roundRejected) revert WindowNotOpen();
        Order[] storage list = _s().orders[seriesId][period];
        if (fromIndex >= toIndex || toIndex > list.length) revert TallyRangeInvalid();
        if (toIndex - fromIndex > C.MAX_TALLY_PAGE) revert TallyPageTooLarge();
        uint32 round = w.tallyRound;
        uint64 p = w.proposedPrice;
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
        (Window storage w, uint32 period) = _current(seriesId);
        if (w.state != WindowState.Settling || w.roundRejected) revert WindowNotOpen();
        if (w.talliedCount != w.revealedCount) revert TallyIncomplete();
        // a series that reached a terminal status (Retired, Redeemed, Extinguished) no longer trades: any proposal
        // ends in NO_MATCH and every order goes back to its owner (docs/assumptions/track-c.md C-S5)
        bool terminal = registry().getSeriesCore(seriesId).terminalStatus != 0;
        if (w.noMatchProposed || terminal) {
            if (!terminal && w.hasValidBid && w.hasValidAsk && w.maxBid >= w.minAsk) {
                _reject(seriesId, period, w, REJECT_WINDOW_CROSSING_EXISTS);
                return;
            }
            w.state = w.orderCount == 0 ? WindowState.Done : WindowState.NoMatch;
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
        w.clearingPrice = w.proposedPrice;
        w.branch = supplyLimited ? Branch.SupplyLimited : Branch.DemandLimited;
        w.matchedUnits = uint64(supplyLimited ? supply : demand);
        w.marginalRemaining = uint64(supplyLimited ? supply - w.dAbove : demand - w.sBelow);
        w.accAtClear = IMercesVault(_contracts().vault).netAccWad(seriesId);
        w.state = WindowState.Settled;
        emit WindowCleared(seriesId, period, w.clearingPrice, w.matchedUnits, w.branch);
    }

    function _reject(uint256 seriesId, uint32 period, Window storage w, uint8 reason) internal {
        w.roundRejected = true;
        emit WindowSettlementRejected(seriesId, period, w.noMatchProposed ? type(uint64).max : w.proposedPrice, reason);
    }

    // ================================================================ processing (anyone)

    /// @inheritdoc IMercesWindow
    /// @dev Verified ascending ask price levels below `p*`: each level must be below `p*`, above the previous one
    /// and carry valid asks; the index is complete when the levels' quantities sum to `s_below` (distinct positive
    /// levels below `p*` summing to the total below `p*` leave no level out).
    function indexAskPrices(uint256 seriesId, uint64[] calldata prices) external override {
        (Window storage w, uint32 period) = _current(seriesId);
        if (w.state != WindowState.Settled) revert WindowNotOpen();
        if (w.nextBidIndex != w.revealedBids) revert BidsNotProcessed();
        if (w.cancelledUnits <= (w.branch == Branch.SupplyLimited ? w.sAt : w.marginalRemaining)) {
            revert PriceIndexInvalid(); // no take-back below p*
        }
        if (prices.length > C.MAX_TALLY_PAGE) revert TallyPageTooLarge();
        WindowStorage storage $ = _s();
        mapping(uint64 => uint64) storage atPrice = $.qtyAtPrice[seriesId][period][Side.Ask];
        mapping(uint64 => uint64) storage cum = $.cumBelow[seriesId][period];
        uint64 sum = w.priceIndexSum;
        uint64 last = w.priceIndexLast;
        for (uint256 i = 0; i < prices.length; i++) {
            uint64 p = prices[i];
            uint64 qty = atPrice[p];
            if (p >= w.clearingPrice || p <= last || qty == 0) revert PriceIndexInvalid();
            cum[p] = sum;
            sum += qty;
            last = p;
        }
        w.priceIndexSum = sum;
        w.priceIndexLast = last;
        if (sum == w.sBelow && !w.takebackSettled) {
            w.takebackSettled = true;
            uint64 atStar = w.branch == Branch.SupplyLimited ? w.sAt : w.marginalRemaining;
            emit WindowTakebackSettled(seriesId, period, w.cancelledUnits, w.cancelledUnits - atStar);
        }
    }

    /// @inheritdoc IMercesWindow
    /// @dev Exhaustive cases (SPEC §7 `process_order`): `NoMatch`, unrevealed or invalid orders get their full
    /// escrow back. Moves money only to the fee collector; the owner's units and stablecoin wait for
    /// `deliverOrder` (B-S13).
    function processOrder(uint256 seriesId, address owner) external override nonReentrant {
        (Window storage w, uint32 period) = _current(seriesId);
        if (w.state != WindowState.Settled && w.state != WindowState.NoMatch) revert WindowNotOpen();
        WindowStorage storage $ = _s();
        Order storage o = _order($, seriesId, period, owner);
        if (o.processed) revert AlreadyProcessed();
        bool settled = w.state == WindowState.Settled;
        if (settled && o.revealed) _checkSequence(w, o);
        uint64 fill;
        bool live = settled && o.revealed && o.valid;
        if (o.side == Side.Bid) {
            if (live) {
                fill = _bidNominal(w, o);
                if (fill > 0 && !registry().isAllowed(owner)) {
                    w.cancelledUnits += fill;
                    fill = 0;
                }
            }
            w.bidsProcessed += 1;
        } else if (live) {
            fill = _askFill($, w, seriesId, period, o);
        }
        o.processed = true;
        o.fill = fill;
        w.processedCount += 1;
        if (w.processedCount == w.orderCount) w.state = WindowState.Done;
        if (o.side == Side.Bid) _accountBid(seriesId, period, w, o, fill);
        else _accountAsk(seriesId, period, w, o, fill);
    }

    /// @dev B-S9: revealed bids in ascending reveal index, then revealed asks in ascending reveal index.
    function _checkSequence(Window storage w, Order storage o) internal {
        if (o.side == Side.Bid) {
            if (o.revealIndex != w.nextBidIndex) revert OutOfOrder();
            w.nextBidIndex += 1;
        } else {
            if (w.nextBidIndex != w.revealedBids) revert BidsNotProcessed();
            if (o.revealIndex != w.nextAskIndex) revert OutOfOrder();
            w.nextAskIndex += 1;
        }
    }

    /// @dev Branch A: `> p*` full, `== p*` first-come from `S − d_above`, `< p*` nothing. Branch B: `≥ p*` full.
    function _bidNominal(Window storage w, Order storage o) internal view returns (uint64) {
        uint64 p = w.clearingPrice;
        if (o.price > p) return o.quantity;
        if (o.price < p) return 0;
        if (w.branch == Branch.DemandLimited) return o.quantity;
        return _firstCome(o.quantity, w.marginalRemaining, o.samePricePrefix);
    }

    /// @dev Branch A: `≤ p*` full; branch B: `< p*` full, `== p*` first-come from `D − s_below`; `> p*` nothing.
    function _askNominal(Window storage w, Order storage o) internal view returns (uint64) {
        uint64 p = w.clearingPrice;
        if (o.price < p) return o.quantity;
        if (o.price > p) return 0;
        if (w.branch == Branch.SupplyLimited) return o.quantity;
        return _firstCome(o.quantity, w.marginalRemaining, o.samePricePrefix);
    }

    /// @dev `min(quantity, max(0, remaining − prefix))`: first-come in ascending reveal index at one price.
    function _firstCome(uint64 quantity, uint64 remaining, uint64 prefix) internal pure returns (uint64) {
        if (prefix >= remaining) return 0;
        uint64 left = remaining - prefix;
        return quantity < left ? quantity : left;
    }

    /// @dev Ask fill after the take-back of `cancelled_units` (SPEC §7, reference order): first from the asks at
    /// `p*` in descending reveal index, then from the asks below `p*` in descending (price, reveal index).
    function _askFill(WindowStorage storage $, Window storage w, uint256 seriesId, uint32 period, Order storage o)
        internal
        view
        returns (uint64)
    {
        uint64 nominal = _askNominal(w, o);
        if (nominal == 0) return 0;
        uint64 cancelled = w.cancelledUnits; // final: every revealed bid is processed (`_checkSequence`)
        if (cancelled == 0) return nominal;
        uint64 p = w.clearingPrice;
        bool supplyLimited = w.branch == Branch.SupplyLimited;
        // nominal units sold by all asks at p*: s_at (A) or D − s_below (B)
        uint64 atStar = supplyLimited ? w.sAt : w.marginalRemaining;
        if (o.price == p) {
            uint64 before = supplyLimited ? o.samePricePrefix : uint64(MercesMath.min(o.samePricePrefix, atStar));
            uint64 later = atStar - before - nominal;
            uint64 takeBack = cancelled > later ? cancelled - later : 0;
            return takeBack >= nominal ? 0 : nominal - takeBack;
        }
        if (cancelled <= atStar) return nominal;
        // the take-back reaches below p*: greedy fill in ascending (price, reveal) order with what is left
        if (w.priceIndexSum != w.sBelow) revert PriceIndexIncomplete();
        uint64 budget = w.sBelow - (cancelled - atStar);
        uint64 prefix = $.cumBelow[seriesId][period][o.price] + o.samePricePrefix;
        return _firstCome(o.quantity, budget, prefix);
    }

    /// @dev Bid accounting: fee to the collector now; the refund and the units wait for delivery. The buyer is
    /// registered and settled before its units count (pending), then credited the payouts since clearing on them
    /// (C-S4).
    function _accountBid(uint256 seriesId, uint32 period, Window storage w, Order storage o, uint64 fill) internal {
        uint64 p = w.clearingPrice;
        uint64 cost = uint64(uint256(p) * fill);
        uint64 fee = uint64(uint256(cost).bpsOf(registry().getSeriesTerms(seriesId).windowFeeBps));
        uint64 refund = o.escrow - cost - fee;
        w.escrowStable -= fee;
        w.feesTotal += fee;
        o.pendingUnits = fill;
        o.pendingStable = refund;
        emit OrderFilled(seriesId, period, o.owner, Side.Bid, fill, p, fee, refund);
        if (fill > 0) {
            IMercesVault vault = IMercesVault(_contracts().vault);
            vault.registerHolder(seriesId, o.owner);
            vault.settleHolder(seriesId, o.owner);
            // the buyer owns the units from the clearing point (C-S4): payouts since then accrue to it
            vault.creditWindowAccrual(seriesId, o.owner, fill, w.accAtClear);
            _s().pendingUnits[seriesId][o.owner] += fill;
        }
        if (fee > 0) {
            IERC20(registry().getSeriesCore(seriesId).stablecoin).safeTransfer(registry().feeCollector(), fee);
        }
    }

    /// @dev Ask accounting: the seller's accrual is settled while its escrow still counts; the units coming back
    /// (credited the payouts since a priced clearing, C-S4) and the proceeds wait for delivery.
    function _accountAsk(uint256 seriesId, uint32 period, Window storage w, Order storage o, uint64 fill) internal {
        uint64 p = w.clearingPrice;
        uint64 back = o.escrow - fill;
        o.pendingUnits = back;
        o.pendingStable = uint64(uint256(p) * fill);
        emit OrderFilled(seriesId, period, o.owner, Side.Ask, fill, p, 0, back);
        IMercesVault vault = IMercesVault(_contracts().vault);
        vault.settleHolder(seriesId, o.owner);
        if (w.branch != Branch.None) vault.creditWindowAccrual(seriesId, o.owner, back, w.accAtClear);
        WindowStorage storage $ = _s();
        $.askEscrow[seriesId][o.owner] -= o.escrow;
        $.pendingUnits[seriesId][o.owner] += back;
    }

    /// @inheritdoc IMercesWindow
    /// @dev Anyone; pays the order's owner only. A recipient-side failure reverts this call alone and can be
    /// retried at any time. Moving units from pending to the balance leaves the owner's accrual weight unchanged.
    function deliverOrder(uint256 seriesId, uint32 period, address owner) external override nonReentrant {
        WindowStorage storage $ = _s();
        Window storage w = $.windows[seriesId][period];
        Order storage o = _order($, seriesId, period, owner);
        if (!o.processed) revert NotProcessed();
        if (o.delivered) revert AlreadyDelivered();
        o.delivered = true;
        uint64 units = o.pendingUnits;
        uint64 amount = o.pendingStable;
        w.escrowUnits -= units;
        w.escrowStable -= amount;
        $.pendingUnits[seriesId][owner] -= units;
        emit OrderDelivered(seriesId, period, owner, o.side, units, amount);
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (amount > 0) IERC20(core.stablecoin).safeTransfer(owner, amount);
        if (units > 0 && !IERC3643Token(core.unitToken).transfer(owner, units)) revert TransferFailed();
    }

    function _order(WindowStorage storage $, uint256 seriesId, uint32 period, address owner)
        internal
        view
        returns (Order storage)
    {
        uint256 idx = $.orderIndexPlusOne[seriesId][period][owner];
        if (idx == 0) revert BidNotFound();
        return $.orders[seriesId][period][idx - 1];
    }

    /// @dev Units `wallet` owns in the series: balance + undelivered auction units + ask escrow + window units
    /// awaiting delivery (B-S19).
    function _ownedUnits(WindowStorage storage $, uint256 seriesId, address wallet) internal view returns (uint256) {
        IERC3643Token token = IERC3643Token(registry().getSeriesCore(seriesId).unitToken);
        return token.balanceOf(wallet) + IMercesAuction(_contracts().auction).pendingUnitsOf(seriesId, wallet)
            + $.askEscrow[seriesId][wallet] + $.pendingUnits[seriesId][wallet];
    }

    // ================================================================ views

    /// @inheritdoc IMercesWindow
    function orderCommitment(uint256 price, uint256 quantity, bytes32 salt, address owner)
        external
        pure
        override
        returns (bytes32)
    {
        return MercesMessages.orderCommitment(price.toU64(), quantity.toU64(), salt, owner);
    }

    function armedDeposit(address from) external view override returns (uint256) {
        return _s().armedDeposit[from];
    }

    /// @inheritdoc IMercesWindow
    function currentWindow(uint256 seriesId) external view override returns (bool exists, uint32 period) {
        return (_s().hasWindow[seriesId], _s().currentPeriod[seriesId]);
    }

    /// @inheritdoc IMercesWindow
    function askEscrowUnits(uint256 seriesId, address wallet) external view override returns (uint64) {
        return _s().askEscrow[seriesId][wallet];
    }

    /// @inheritdoc IMercesWindow
    function askAccrual(uint256 seriesId, address wallet)
        external
        view
        override
        returns (uint64 escrowUnits, bool cleared, uint256 accAtClear)
    {
        WindowStorage storage $ = _s();
        escrowUnits = $.askEscrow[seriesId][wallet];
        if (escrowUnits == 0) return (0, false, 0);
        Window storage w = $.windows[seriesId][$.currentPeriod[seriesId]];
        // cleared with a price (Settled, or Done after Settled): escrowed units earn up to the clearing point only
        if (w.branch != Branch.None) return (escrowUnits, true, w.accAtClear);
    }

    /// @inheritdoc IMercesWindow
    function pendingUnitsOf(uint256 seriesId, address wallet) external view override returns (uint64) {
        return _s().pendingUnits[seriesId][wallet];
    }

    /// @inheritdoc IMercesWindow
    function revealedOrderAt(uint256 seriesId, uint32 period, Side side, uint256 index)
        external
        view
        override
        returns (address)
    {
        uint32[] storage list = _s().revealed[seriesId][period][side];
        if (index >= list.length) revert BidNotFound();
        return _s().orders[seriesId][period][list[index]].owner;
    }

    function getWindow(uint256 seriesId, uint32 period) external view override returns (Window memory) {
        return _s().windows[seriesId][period];
    }

    function getOrder(uint256 seriesId, uint32 period, address owner) external view override returns (Order memory) {
        uint256 idx = _s().orderIndexPlusOne[seriesId][period][owner];
        if (idx == 0) revert BidNotFound();
        return _s().orders[seriesId][period][idx - 1];
    }

    function getOrderAt(uint256 seriesId, uint32 period, uint256 index) external view override returns (Order memory) {
        Order[] storage list = _s().orders[seriesId][period];
        if (index >= list.length) revert BidNotFound();
        return list[index];
    }

    /// @inheritdoc IMercesWindow
    function priceIndexRequired(uint256 seriesId) external view override returns (bool) {
        WindowStorage storage $ = _s();
        if (!$.hasWindow[seriesId]) return false;
        Window storage w = $.windows[seriesId][$.currentPeriod[seriesId]];
        if (w.state != WindowState.Settled || w.nextBidIndex != w.revealedBids) return false;
        uint64 atStar = w.branch == Branch.SupplyLimited ? w.sAt : w.marginalRemaining;
        return w.cancelledUnits > atStar && !w.takebackSettled;
    }

    /// @inheritdoc IMercesWindow
    function walletCapUnits(uint256 seriesId) external view override returns (uint64) {
        return uint64(_capUnits(seriesId, registry().getSeriesTerms(seriesId)));
    }

    /// @inheritdoc IMercesWindow
    function requiredBidEscrow(uint256 seriesId, uint256 price, uint256 quantity)
        external
        view
        override
        returns (uint256)
    {
        return _requiredBidEscrow(registry().getSeriesTerms(seriesId), price.toU64(), quantity.toU64());
    }

    // ================================================================ internals

    /// @dev The current window in its commit phase (`WindowNotOpen` otherwise, as SPEC §7 / the reference).
    function _commitWindow(uint256 seriesId) internal view returns (Window storage w, uint32 period) {
        (w, period) = _current(seriesId);
        if (w.state != WindowState.Commit || block.timestamp >= w.commitEnd) revert WindowNotOpen();
    }

    function _current(uint256 seriesId) internal view returns (Window storage w, uint32 period) {
        WindowStorage storage $ = _s();
        if (!$.hasWindow[seriesId]) revert WindowNotOpen();
        period = $.currentPeriod[seriesId];
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
