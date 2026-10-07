// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {MercesUpgradeable} from "./base/MercesUpgradeable.sol";
import {IMercesAuction} from "./interfaces/IMercesAuction.sol";
import {IMercesTreasury} from "./interfaces/IMercesTreasury.sol";
import {IMercesTokenFactory} from "./interfaces/IMercesTokenFactory.sol";
import {IPayoutClaims} from "./interfaces/IPayoutClaims.sol";
import {IERC3643Token} from "./interfaces/external/IERC3643Token.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesMessages} from "./libraries/MercesMessages.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {ProtocolContracts, RaiseState, SeriesCore, SeriesMode, SeriesTerms} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesAuction
/// @notice Sealed-bid, uniform-price raise (D3; SPEC §5.1–5.2). Commit → Reveal → Settle with a paged tally over
/// the bid array (≤ 4096 bids, ≤ 200 per page), a proposed clearing price validated on-chain, pro-rata fills at
/// the margin, per-bid push settlement (`processBid`, callable by anyone, pays only the bid's own owner), the
/// non-reveal charge, and the minimum-raise rule on the upper bound of proceeds. Escrow is held here; proceeds
/// go to the treasury per winner, fees and non-reveal charges to the fee collector, everything else back to the
/// bidder. No admin path touches escrow.
contract MercesAuction is MercesUpgradeable, IMercesAuction {
    using SafeERC20 for IERC20;
    using MercesMath for uint256;

    /// @custom:storage-location erc7201:merces.storage.MercesAuction
    struct AuctionStorage {
        mapping(uint256 => Auction) auctions;
        mapping(uint256 => Bid[]) bids;
        mapping(uint256 => mapping(address => uint256)) bidIndexPlusOne;
    }

    // keccak256(abi.encode(uint256(keccak256("merces.storage.MercesAuction")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant AUCTION_STORAGE = 0x676dfc64a57d339f0dd97a84498cfca82a41fa36318d85459f609770f94c4100;

    function _s() private pure returns (AuctionStorage storage $) {
        assembly ("memory-safe") {
            $.slot := AUCTION_STORAGE
        }
    }

    function initialize(address owner_, address registry_) external initializer {
        __MercesUpgradeable_init(owner_, registry_);
    }

    // ---------------------------------------------------------------- issuer

    /// @inheritdoc IMercesAuction
    function openRaise(uint256 seriesId) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        if (core.raiseState != RaiseState.Draft) revert RaiseNotDraft();
        if (core.contractHash == bytes32(0)) revert ContractHashNotSet();
        if (!registry().isAllowed(core.issuer)) revert IssuerNotAllowlisted();
        if (registry().getFlags().newRaisesPaused) revert NewRaisesPaused();
        if (core.mode != SeriesMode.SealedBid) revert NotSealedBid();
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);

        Auction storage a = _s().auctions[seriesId];
        a.state = RaiseState.Open;
        a.openedAt = uint64(block.timestamp);
        a.commitEnd = a.openedAt + terms.commitDuration;
        a.revealEnd = a.commitEnd + terms.revealDuration;
        a.minValidPrice = type(uint64).max;

        (address token,) = IMercesTokenFactory(_contracts().tokenFactory).createToken(
            seriesId, string.concat("Merces HEU ", Strings.toString(seriesId)), "HEU"
        );
        a.unitToken = token;
        registry().markRaiseOpened(seriesId, token, a.openedAt);
        emit RaiseOpened(seriesId, token, a.openedAt, a.commitEnd, a.revealEnd);
    }

    /// @inheritdoc IMercesAuction
    function cancelRaise(uint256 seriesId) external override {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        Auction storage a = _s().auctions[seriesId];
        if (a.state != RaiseState.Open) revert RaiseNotOpen();
        if (a.bidCount != 0) revert BidsExist();
        a.state = RaiseState.Cancelled;
        registry().markRaiseResult(seriesId, RaiseState.Cancelled, 0, 0, 0);
        emit RaiseCancelled(seriesId);
    }

    // ---------------------------------------------------------------- bidders

    /// @inheritdoc IMercesAuction
    function commitBid(uint256 seriesId, bytes32 commitment, uint64 escrow) external override nonReentrant {
        Auction storage a = _s().auctions[seriesId];
        if (a.state != RaiseState.Open) revert RaiseNotOpen();
        if (block.timestamp >= a.commitEnd) revert CommitPhaseOver();
        if (!registry().isAllowed(msg.sender)) revert WalletNotAllowlisted(msg.sender);
        if (escrow == 0) revert ZeroEscrow();
        AuctionStorage storage $ = _s();
        if ($.bidIndexPlusOne[seriesId][msg.sender] != 0) revert BidAlreadyExists();
        Bid[] storage bids = $.bids[seriesId];
        if (bids.length >= C.MAX_BIDS_PER_AUCTION) revert TooManyBids();

        bids.push(
            Bid({
                bidder: msg.sender,
                commitment: commitment,
                escrow: escrow,
                revealIndex: 0,
                revealed: false,
                valid: false,
                price: 0,
                quantity: 0,
                talliedRound: 0,
                processed: false,
                allocation: 0
            })
        );
        $.bidIndexPlusOne[seriesId][msg.sender] = bids.length;
        a.bidCount += 1;
        a.escrowTotal = (uint256(a.escrowTotal) + escrow).toU64();
        emit BidCommitted(seriesId, msg.sender, escrow);

        IERC20(registry().getSeriesCore(seriesId).stablecoin).safeTransferFrom(msg.sender, address(this), escrow);
    }

    /// @inheritdoc IMercesAuction
    /// @dev Validity (SPEC §5.2): `price ≥ reserve && quantity ≥ 1 && quantity ≤ wallet_cap_units_at_auction &&
    /// escrow ≥ required_escrow(price, quantity)`; `wallet_cap_units_at_auction = floor(units_offered ×
    /// wallet_cap_bps / 10000)` (assumption A10). Invalid reveals are refunded in full at claim time.
    function revealBid(uint256 seriesId, uint64 price, uint64 quantity, bytes32 salt) external override {
        Auction storage a = _s().auctions[seriesId];
        if (a.state != RaiseState.Open) revert RaiseNotOpen();
        if (block.timestamp < a.commitEnd || block.timestamp >= a.revealEnd) revert NotRevealPhase();
        AuctionStorage storage $ = _s();
        uint256 idx = $.bidIndexPlusOne[seriesId][msg.sender];
        if (idx == 0) revert BidNotFound();
        Bid storage bid = $.bids[seriesId][idx - 1];
        if (bid.revealed) revert BidAlreadyRevealed();
        if (MercesMessages.orderCommitment(price, quantity, salt, msg.sender) != bid.commitment) {
            revert CommitmentMismatch();
        }
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        bool valid = price >= terms.reservePrice && quantity >= 1 && quantity <= _walletCapUnits(terms)
            && uint256(bid.escrow) >= _requiredEscrow(terms, price, quantity);

        bid.revealed = true;
        bid.revealIndex = a.revealedCount;
        bid.valid = valid;
        bid.price = price;
        bid.quantity = quantity;
        a.revealedCount += 1;
        if (valid) a.validCount += 1;
        emit BidRevealed(seriesId, msg.sender, price, quantity, valid);
    }

    // ---------------------------------------------------------------- settlement (anyone)

    /// @inheritdoc IMercesAuction
    /// @dev Re-proposal is allowed until finalized; each proposal starts a new tally round.
    function beginSettlement(uint256 seriesId, uint64 proposedClearingPrice) external override {
        Auction storage a = _s().auctions[seriesId];
        if (a.state != RaiseState.Open && a.state != RaiseState.Settling) revert InvalidSettlementState();
        if (block.timestamp < a.revealEnd) revert RevealNotOver();
        a.state = RaiseState.Settling;
        a.clearingPrice = proposedClearingPrice;
        a.qAbove = 0;
        a.qAt = 0;
        a.talliedCount = 0;
        a.minValidPrice = type(uint64).max;
        a.tallyRound += 1;
        emit SettlementProposed(seriesId, proposedClearingPrice, a.tallyRound);
    }

    /// @inheritdoc IMercesAuction
    /// @dev Pages over `bids[fromIndex, toIndex)`, at most 200 per call. Already-tallied bids in this round are
    /// skipped, so overlapping pages are harmless.
    function tallyBids(uint256 seriesId, uint256 fromIndex, uint256 toIndex) external override {
        Auction storage a = _s().auctions[seriesId];
        if (a.state != RaiseState.Settling) revert InvalidSettlementState();
        Bid[] storage bids = _s().bids[seriesId];
        if (fromIndex >= toIndex || toIndex > bids.length) revert TallyRangeInvalid();
        if (toIndex - fromIndex > C.MAX_TALLY_PAGE) revert TallyPageTooLarge();
        uint32 round = a.tallyRound;
        uint64 p = a.clearingPrice;
        uint64 qAbove = a.qAbove;
        uint64 qAt = a.qAt;
        uint64 minValid = a.minValidPrice;
        uint32 tallied = a.talliedCount;
        for (uint256 i = fromIndex; i < toIndex; i++) {
            Bid storage bid = bids[i];
            if (!bid.revealed || bid.talliedRound == round) continue;
            bid.talliedRound = round;
            tallied += 1;
            if (!bid.valid) continue;
            if (bid.price > p) qAbove += bid.quantity;
            else if (bid.price == p) qAt += bid.quantity;
            if (bid.price < minValid) minValid = bid.price;
        }
        a.qAbove = qAbove;
        a.qAt = qAt;
        a.minValidPrice = minValid;
        a.talliedCount = tallied;
    }

    /// @inheritdoc IMercesAuction
    /// @dev Validity of the proposal (SPEC §5.2): `q_at > 0`, `q_above < N`, and either `D ≥ N` or
    /// `min_valid_price == p*`. With no valid bid at all the raise fails regardless of the proposal (SPEC gap,
    /// recorded in docs/assumptions/track-c.md). Min raise uses the upper bound `p* × (q_above + R)` (A12).
    function finalizeSettlement(uint256 seriesId) external override nonReentrant {
        Auction storage a = _s().auctions[seriesId];
        if (a.state != RaiseState.Settling) revert InvalidSettlementState();
        if (a.talliedCount != a.revealedCount) revert TallyIncomplete();
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        uint64 p = a.clearingPrice;

        if (a.validCount == 0) {
            _fail(seriesId, a, p, 0, terms.minRaise);
            return;
        }
        uint64 n = terms.unitsOffered;
        uint256 demand = uint256(a.qAbove) + a.qAt;
        bool ok = a.qAt > 0 && a.qAbove < n && (demand >= n || a.minValidPrice == p);
        if (!ok) revert InvalidClearingPrice();

        uint64 r = uint64(MercesMath.min(n - a.qAbove, a.qAt));
        uint64 unitsSoldUpper = a.qAbove + r;
        uint64 proceedsUpper = (uint256(p) * unitsSoldUpper).toU64();
        if (proceedsUpper < terms.minRaise) {
            _fail(seriesId, a, p, proceedsUpper, terms.minRaise);
            return;
        }
        a.state = RaiseState.Settled;
        a.settlementTs = uint64(block.timestamp);
        a.remainderAtMargin = r;
        a.unitsSoldUpper = unitsSoldUpper;
        registry().markRaiseResult(seriesId, RaiseState.Settled, a.settlementTs, unitsSoldUpper, p);
        emit RaiseSettled(seriesId, p, unitsSoldUpper, proceedsUpper, a.settlementTs);
    }

    function _fail(uint256 seriesId, Auction storage a, uint64 p, uint64 proceedsUpper, uint64 minRaise) internal {
        a.state = RaiseState.Failed;
        a.settlementTs = uint64(block.timestamp);
        registry().markRaiseResult(seriesId, RaiseState.Failed, a.settlementTs, 0, 0);
        emit RaiseFailed(seriesId, p, proceedsUpper, minRaise);
    }

    /// @inheritdoc IMercesAuction
    /// @dev Push semantics: anyone may process any bid; funds and units only ever go to the bid's own owner.
    /// Each bid is processed once. When the last bid is processed the exact `units_sold` is known and the
    /// treasury's proceeds are finalized (`RaiseMintFinalized`).
    function processBid(uint256 seriesId, uint256 bidIndex) external override nonReentrant {
        AuctionStorage storage $ = _s();
        Auction storage a = $.auctions[seriesId];
        if (a.state != RaiseState.Settled && a.state != RaiseState.Failed) revert NotSettledOrFailed();
        Bid[] storage bids = $.bids[seriesId];
        if (bidIndex >= bids.length) revert BidNotFound();
        Bid storage bid = bids[bidIndex];
        if (bid.processed) revert BidAlreadyProcessed();
        bid.processed = true;
        a.bidsProcessed += 1;

        SeriesCore memory core = registry().getSeriesCore(seriesId);
        IERC20 stable = IERC20(core.stablecoin);
        ProtocolContracts memory pc = _contracts();

        if (a.state == RaiseState.Failed) {
            // failed auctions charge no fee: full refund, revealed or not
            _refund(seriesId, a, stable, bid, bid.escrow, 0);
        } else if (!bid.revealed) {
            SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
            uint64 charge = uint64(uint256(bid.escrow).bpsOf(terms.nonRevealChargeBps));
            a.chargesTotal += charge;
            emit NonRevealCharged(seriesId, bid.bidder, charge);
            if (charge > 0) stable.safeTransfer(registry().feeCollector(), charge);
            _refund(seriesId, a, stable, bid, bid.escrow - charge, charge);
        } else {
            uint64 alloc = _allocation(a, bid);
            // A bidder removed from the allowlist before processing cannot be minted to (ERC-3643 requires a
            // verified recipient); the bid is refunded in full and the units stay unsold (A-C7).
            if (alloc > 0 && !registry().isAllowed(bid.bidder)) alloc = 0;
            if (alloc == 0) {
                _refund(seriesId, a, stable, bid, bid.escrow, 0);
            } else {
                _allocate(seriesId, a, core, pc, stable, bid, alloc);
            }
        }

        if (a.bidsProcessed == a.bidCount && a.state == RaiseState.Settled) {
            _finalizeMint(seriesId, a, pc);
        }
    }

    function _allocation(Auction storage a, Bid storage bid) internal view returns (uint64) {
        if (!bid.valid || bid.price < a.clearingPrice) return 0;
        if (bid.price > a.clearingPrice) return bid.quantity;
        // marginal: floor(R × q_i / q_at)
        return uint64(MercesMath.mulDiv(a.remainderAtMargin, bid.quantity, a.qAt));
    }

    function _allocate(
        uint256 seriesId,
        Auction storage a,
        SeriesCore memory core,
        ProtocolContracts memory pc,
        IERC20 stable,
        Bid storage bid,
        uint64 alloc
    ) internal {
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        uint64 cost = uint64(uint256(a.clearingPrice) * alloc); // ≤ p × q ≤ escrow, fits
        uint64 fee = uint64(uint256(cost).bpsOf(terms.auctionFeeBps));
        uint64 refund = bid.escrow - cost - fee; // non-negative by the validity rule (price ≥ p*)
        bid.allocation = alloc;
        a.unitsMinted += alloc;
        a.proceedsTransferred += cost;
        a.feesTotal += fee;
        a.refundedTotal += refund;
        emit UnitsAllocated(seriesId, bid.bidder, alloc, cost, fee, refund);

        stable.safeTransfer(pc.treasury, cost);
        IMercesTreasury(pc.treasury).depositProceeds(seriesId, cost);
        if (fee > 0) stable.safeTransfer(registry().feeCollector(), fee);
        if (refund > 0) stable.safeTransfer(bid.bidder, refund);
        IPayoutClaims(pc.vault).registerHolder(seriesId, bid.bidder);
        IERC3643Token(core.unitToken).mint(bid.bidder, alloc);
    }

    function _refund(uint256 seriesId, Auction storage a, IERC20 stable, Bid storage bid, uint64 refund, uint64 charge)
        internal
    {
        a.refundedTotal += refund;
        emit BidRefunded(seriesId, bid.bidder, refund, charge);
        if (refund > 0) stable.safeTransfer(bid.bidder, refund);
    }

    function _finalizeMint(uint256 seriesId, Auction storage a, ProtocolContracts memory pc) internal {
        a.unitsSold = a.unitsMinted;
        a.proceeds = uint64(uint256(a.clearingPrice) * a.unitsMinted);
        a.mintAuthorityRevoked = true;
        registry().markRaiseResult(seriesId, RaiseState.Settled, a.settlementTs, a.unitsSold, a.clearingPrice);
        IMercesTreasury(pc.treasury).finalizeProceeds(seriesId, a.proceeds);
        emit RaiseMintFinalized(seriesId, a.unitsSold, a.proceeds);
        emit MintAuthorityRevoked(seriesId);
    }

    // ---------------------------------------------------------------- views

    function getAuction(uint256 seriesId) external view override returns (Auction memory) {
        return _s().auctions[seriesId];
    }

    function getBid(uint256 seriesId, uint256 bidIndex) external view override returns (Bid memory) {
        Bid[] storage bids = _s().bids[seriesId];
        if (bidIndex >= bids.length) revert BidNotFound();
        return bids[bidIndex];
    }

    function bidIndexOf(uint256 seriesId, address bidder) external view override returns (bool exists, uint256 index) {
        uint256 idx = _s().bidIndexPlusOne[seriesId][bidder];
        return (idx != 0, idx == 0 ? 0 : idx - 1);
    }

    function mintFinalized(uint256 seriesId) external view override returns (bool) {
        return _s().auctions[seriesId].mintAuthorityRevoked;
    }

    /// @inheritdoc IMercesAuction
    function requiredEscrow(uint256 seriesId, uint64 price, uint64 quantity) external view override returns (uint256) {
        return _requiredEscrow(registry().getSeriesTerms(seriesId), price, quantity);
    }

    /// @inheritdoc IMercesAuction
    function walletCapUnitsAtAuction(uint256 seriesId) external view override returns (uint64) {
        return _walletCapUnits(registry().getSeriesTerms(seriesId));
    }

    /// @dev `required_escrow(p, q) = p×q + floor(p×q × auction_fee_bps / 10000)`.
    function _requiredEscrow(SeriesTerms memory terms, uint64 price, uint64 quantity) internal pure returns (uint256) {
        uint256 cost = uint256(price) * quantity;
        return cost + cost.bpsOf(terms.auctionFeeBps);
    }

    function _walletCapUnits(SeriesTerms memory terms) internal pure returns (uint64) {
        return uint64(uint256(terms.unitsOffered).bpsOf(terms.walletCapBps));
    }
}
