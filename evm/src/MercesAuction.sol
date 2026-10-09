// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {MercesUpgradeable} from "./base/MercesUpgradeable.sol";
import {IMercesAuction, REJECT_CLAIM_MISMATCH, REJECT_INVALID_CLEARING_PRICE} from "./interfaces/IMercesAuction.sol";
import {IMercesTreasury} from "./interfaces/IMercesTreasury.sol";
import {IMercesTokenFactory} from "./interfaces/IMercesTokenFactory.sol";
import {IMercesVault} from "./interfaces/IMercesVault.sol";
import {IERC3643Token} from "./interfaces/external/IERC3643Token.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesMessages} from "./libraries/MercesMessages.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {ProtocolContracts, RaiseState, SeriesCore, SeriesMode, SeriesTerms} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesAuction
/// @notice Sealed-bid, uniform-price raise (D3; SPEC v1.1 §5.1–5.2). Commit → Reveal → Settle with a paged
/// tally over the bid array (≤ 4096 bids, ≤ 200 per page). The proposer claims `(p*, q_above, q_at)`; the tally
/// checks the claims and accumulates the marginal allocations against the claimed `R`, so `units_sold` and
/// `proceeds` are exact in one pass and the registry is written once. A wrong proposal never reverts
/// `finalizeSettlement`: it records `roundRejected` and emits `SettlementRejected` so a new proposal can be made,
/// while an incomplete round cannot be reset by anyone (`TallyInProgress`). `processBid` only moves money to
/// protocol accounts (treasury, fee collector) and mints to this contract's escrow; `deliverBid` pushes units and
/// refunds to the bidder and can be retried forever, so no recipient-side failure blocks mint finalization.
/// Escrow is held here; no admin path touches it.
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
        if (core.contractHash == bytes32(0)) revert ContractHashMissing();
        if (!registry().isAllowed(core.issuer)) revert NotAllowlisted(core.issuer);
        if (registry().getFlags().newRaisesPaused) revert NewRaisesPaused();
        if (core.mode != SeriesMode.SealedBid) revert NotSealedBid();
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);

        Auction storage a = _s().auctions[seriesId];
        a.state = RaiseState.Open;
        a.openedAt = uint64(block.timestamp);
        a.commitEnd = a.openedAt + terms.commitDuration;
        a.revealEnd = a.commitEnd + terms.revealDuration;

        (address token,) = IMercesTokenFactory(_contracts().tokenFactory)
            .createToken(seriesId, string.concat("Merces HEU ", Strings.toString(seriesId)), "HEU");
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
    function commitBid(uint256 seriesId, bytes32 commitment, uint256 escrow) external override nonReentrant {
        AuctionStorage storage $ = _s();
        Auction storage a = $.auctions[seriesId];
        if (a.state != RaiseState.Open) revert RaiseNotOpen();
        if (!registry().isAllowed(msg.sender)) revert NotAllowlisted(msg.sender);
        if (block.timestamp >= a.commitEnd) revert CommitPhaseClosed();
        if ($.bidIndexPlusOne[seriesId][msg.sender] != 0) revert BidExists();
        uint64 amount = escrow.toU64();
        if (amount == 0) revert ZeroEscrow();
        Bid[] storage bids = $.bids[seriesId];
        if (bids.length >= C.MAX_BIDS_PER_AUCTION) revert TooManyBids();

        bids.push();
        Bid storage bid = bids[bids.length - 1];
        bid.bidder = msg.sender;
        bid.commitment = commitment;
        bid.escrow = amount;
        $.bidIndexPlusOne[seriesId][msg.sender] = bids.length;
        a.bidCount += 1;
        a.escrowTotal = (uint256(a.escrowTotal) + amount).toU64();
        emit BidCommitted(seriesId, msg.sender, amount);

        IERC20(registry().getSeriesCore(seriesId).stablecoin).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @inheritdoc IMercesAuction
    /// @dev Validity (SPEC §5.2): `price ≥ reserve && quantity ≥ 1 && quantity ≤ wallet_cap_units_at_auction &&
    /// escrow ≥ required_escrow(price, quantity)`. A validity failure never reverts; it records `valid = false`
    /// and the escrow is refunded in full at processing.
    function revealBid(uint256 seriesId, uint256 price, uint256 quantity, bytes32 salt) external override {
        uint64 p = price.toU64();
        uint64 q = quantity.toU64();
        AuctionStorage storage $ = _s();
        Auction storage a = $.auctions[seriesId];
        if (a.state != RaiseState.Open) revert RaiseNotOpen();
        if (block.timestamp < a.commitEnd) revert RevealNotStarted();
        if (block.timestamp >= a.revealEnd) revert RevealPhaseClosed();
        uint256 idx = $.bidIndexPlusOne[seriesId][msg.sender];
        if (idx == 0) revert BidNotFound();
        Bid storage bid = $.bids[seriesId][idx - 1];
        if (bid.revealed) revert AlreadyRevealed();
        if (MercesMessages.orderCommitment(p, q, salt, msg.sender) != bid.commitment) revert CommitmentMismatch();
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        bool valid = p >= terms.reservePrice && q >= 1 && q <= _walletCapUnits(terms)
            && uint256(bid.escrow) >= _requiredEscrow(terms, p, q);

        bid.revealed = true;
        bid.revealIndex = a.revealedCount;
        bid.valid = valid;
        bid.price = p;
        bid.quantity = q;
        a.revealedCount += 1;
        if (valid) a.validCount += 1;
        emit BidRevealed(seriesId, msg.sender, p, q, valid);
    }

    // ---------------------------------------------------------------- settlement (anyone)

    /// @inheritdoc IMercesAuction
    /// @dev A new round may start only when none is in progress (`tally_round == 0 || round_rejected`); an
    /// honest keeper's partial tally can therefore never be reset by another caller.
    function beginSettlement(uint256 seriesId, uint256 clearingPrice, uint256 qAboveClaim, uint256 qAtClaim)
        external
        override
    {
        Auction storage a = _s().auctions[seriesId];
        if (a.state != RaiseState.Open && a.state != RaiseState.Settling) revert RaiseNotOpen();
        if (block.timestamp < a.revealEnd) revert SettlementNotReady();
        if (a.tallyRound != 0 && !a.roundRejected) revert TallyInProgress();
        uint64 p = clearingPrice.toU64();
        uint64 qAbove = qAboveClaim.toU64();
        uint64 qAt = qAtClaim.toU64();
        uint64 n = registry().getSeriesTerms(seriesId).unitsOffered;
        a.state = RaiseState.Settling;
        a.proposedPrice = p;
        a.qAboveClaim = qAbove;
        a.qAtClaim = qAt;
        a.rClaim = qAbove >= n ? 0 : uint64(MercesMath.min(n - qAbove, qAt));
        a.qAbove = 0;
        a.qAt = 0;
        a.allocSum = 0;
        a.talliedCount = 0;
        a.minValidPrice = type(uint64).max;
        a.roundRejected = false;
        a.rejectionReason = 0;
        a.tallyRound += 1;
        emit SettlementProposed(seriesId, p, a.tallyRound);
    }

    /// @inheritdoc IMercesAuction
    /// @dev Pages over `bids[fromIndex, toIndex)`, at most 200 per call. Bids already tallied in this round are
    /// skipped, so overlapping pages are harmless. Only valid bids contribute; their quantities are bounded by
    /// their escrow (`price ≥ reserve ≥ 1`), so the sums fit in uint64 whenever `escrow_total` does.
    function tallyBids(uint256 seriesId, uint256 fromIndex, uint256 toIndex) external override {
        Auction storage a = _s().auctions[seriesId];
        if (a.state != RaiseState.Settling || a.roundRejected) revert NotSettling();
        Bid[] storage bids = _s().bids[seriesId];
        if (fromIndex >= toIndex || toIndex > bids.length) revert TallyRangeInvalid();
        if (toIndex - fromIndex > C.MAX_TALLY_PAGE) revert TallyPageTooLarge();
        uint32 round = a.tallyRound;
        uint64 p = a.proposedPrice;
        uint64 rClaim = a.rClaim;
        uint64 qAtClaim = a.qAtClaim;
        uint64 qAbove = a.qAbove;
        uint64 qAt = a.qAt;
        uint64 allocSum = a.allocSum;
        uint64 minValid = a.minValidPrice;
        uint32 tallied = a.talliedCount;
        for (uint256 i = fromIndex; i < toIndex; i++) {
            Bid storage bid = bids[i];
            if (!bid.revealed || bid.talliedRound == round) continue;
            bid.talliedRound = round;
            tallied += 1;
            if (!bid.valid) continue;
            if (bid.price < minValid) minValid = bid.price;
            if (bid.price > p) {
                qAbove += bid.quantity;
            } else if (bid.price == p) {
                qAt += bid.quantity;
                if (qAtClaim != 0) allocSum += uint64(MercesMath.mulDiv(rClaim, bid.quantity, qAtClaim));
            }
        }
        a.qAbove = qAbove;
        a.qAt = qAt;
        a.allocSum = allocSum;
        a.minValidPrice = minValid;
        a.talliedCount = tallied;
    }

    /// @inheritdoc IMercesAuction
    /// @dev SPEC §5.2 `finalize_settlement`: (1) no valid bids → `Failed` with clearing price 0; (2) claims must
    /// match the tally; (3) `p*` must be oversubscribed-valid or undersubscribed-valid; (4) `units_sold = q_above +
    /// alloc_sum`, `proceeds = p* × units_sold`; (5) min raise. Steps 2 and 3 reject the round instead of
    /// reverting. A raise with no bid at all is final once it fails (nothing to process).
    function finalizeSettlement(uint256 seriesId) external override nonReentrant {
        Auction storage a = _s().auctions[seriesId];
        if (a.state != RaiseState.Settling || a.roundRejected) revert NotSettling();
        if (a.talliedCount != a.revealedCount) revert TallyIncomplete();
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        uint64 p = a.proposedPrice;

        if (a.validCount == 0) {
            _fail(seriesId, a, 0, 0, 0, terms.minRaise);
            return;
        }
        if (a.qAbove != a.qAboveClaim || a.qAt != a.qAtClaim) {
            _reject(seriesId, a, REJECT_CLAIM_MISMATCH);
            return;
        }
        uint64 n = terms.unitsOffered;
        uint256 demand = uint256(a.qAbove) + a.qAt;
        bool oversubscribed = a.qAt > 0 && a.qAbove < n && demand >= n;
        bool undersubscribed = demand < n && a.minValidPrice == p;
        if (!oversubscribed && !undersubscribed) {
            _reject(seriesId, a, REJECT_INVALID_CLEARING_PRICE);
            return;
        }
        uint64 unitsSold = a.qAbove + a.allocSum;
        uint64 proceeds = (uint256(p) * unitsSold).toU64();
        // a settled raise must sell at least one unit (marginal shares can all floor to zero when min_raise == 0)
        if (proceeds < terms.minRaise || unitsSold == 0) {
            _fail(seriesId, a, p, unitsSold, proceeds, terms.minRaise);
            return;
        }
        a.state = RaiseState.Settled;
        a.clearingPrice = p;
        a.R = a.rClaim;
        a.settlementTs = uint64(block.timestamp);
        a.unitsSold = unitsSold;
        a.proceeds = proceeds;
        registry().markRaiseResult(seriesId, RaiseState.Settled, a.settlementTs, unitsSold, p);
        IMercesTreasury(_contracts().treasury).setProceeds(seriesId, proceeds);
        emit RaiseSettled(seriesId, p, unitsSold, proceeds, a.settlementTs);
    }

    /// @dev Records the rejection and clears the round's tally so the next round starts from a clean slate; the
    /// per-bid tally marks are keyed by round and need no reset.
    function _reject(uint256 seriesId, Auction storage a, uint8 reason) internal {
        a.roundRejected = true;
        a.rejectionReason = reason;
        emit SettlementRejected(seriesId, a.tallyRound, a.proposedPrice, reason);
        a.qAbove = 0;
        a.qAt = 0;
        a.allocSum = 0;
    }

    /// @dev `Failed`: nothing is sold; the exact would-be results are kept for the record (`RaiseFailed` carries
    /// them). Every bid is refunded in full at processing; no fee, no non-reveal charge.
    function _fail(uint256 seriesId, Auction storage a, uint64 p, uint64 unitsSold, uint64 proceeds, uint64 minRaise)
        internal
    {
        a.state = RaiseState.Failed;
        a.clearingPrice = p;
        a.R = 0;
        a.unitsSold = unitsSold;
        a.proceeds = proceeds;
        a.settlementTs = uint64(block.timestamp);
        registry().markRaiseResult(seriesId, RaiseState.Failed, a.settlementTs, 0, p);
        emit RaiseFailed(seriesId, p, proceeds, minRaise);
        if (a.bidCount == 0) _finalizeMint(seriesId, a, _contracts());
    }

    // ---------------------------------------------------------------- processing (anyone)

    /// @inheritdoc IMercesAuction
    /// @dev SPEC §5.2 `process_bid`: once per bid, after `Settled` or `Failed`. Never depends on the bidder being
    /// able to receive anything: cost goes to the treasury, fee and non-reveal charge to the fee collector, units
    /// are minted to this contract, and the bidder's refund and units are recorded for `deliverBid`. The bid that
    /// completes processing finalizes the mint.
    function processBid(uint256 seriesId, address bidder) external override nonReentrant {
        AuctionStorage storage $ = _s();
        Auction storage a = $.auctions[seriesId];
        if (a.state != RaiseState.Settled && a.state != RaiseState.Failed) revert RaiseNotSettled();
        Bid storage bid = _bid($, seriesId, bidder);
        if (bid.processed) revert AlreadyProcessed();
        bid.processed = true;
        a.bidsProcessed += 1;

        SeriesCore memory core = registry().getSeriesCore(seriesId);
        ProtocolContracts memory pc = _contracts();

        if (a.state == RaiseState.Failed) {
            _recordRefund(seriesId, bid, bid.escrow);
        } else if (!bid.revealed) {
            uint64 charge = uint64(uint256(bid.escrow).bpsOf(registry().getSeriesTerms(seriesId).nonRevealChargeBps));
            a.chargesTotal += charge;
            a.escrowTotal -= charge;
            emit NonRevealCharged(seriesId, bid.bidder, charge);
            _recordRefund(seriesId, bid, bid.escrow - charge);
            if (charge > 0) IERC20(core.stablecoin).safeTransfer(registry().feeCollector(), charge);
        } else {
            uint64 alloc = _allocation(a, bid);
            if (alloc == 0) _recordRefund(seriesId, bid, bid.escrow);
            else _allocate(seriesId, a, core, pc, bid, alloc);
        }

        if (a.bidsProcessed == a.bidCount) _finalizeMint(seriesId, a, pc);
    }

    /// @dev `price > p*` → `quantity`; `price == p*` → `floor(R × quantity / q_at)`; otherwise (or invalid) 0.
    function _allocation(Auction storage a, Bid storage bid) internal view returns (uint64) {
        if (!bid.valid || bid.price < a.clearingPrice) return 0;
        if (bid.price > a.clearingPrice) return bid.quantity;
        return uint64(MercesMath.mulDiv(a.R, bid.quantity, a.qAt));
    }

    function _recordRefund(uint256 seriesId, Bid storage bid, uint64 refund) internal {
        bid.pendingRefund = refund;
        emit BidProcessed(seriesId, bid.bidder, 0, refund);
    }

    function _allocate(
        uint256 seriesId,
        Auction storage a,
        SeriesCore memory core,
        ProtocolContracts memory pc,
        Bid storage bid,
        uint64 alloc
    ) internal {
        uint64 cost = uint64(uint256(a.clearingPrice) * alloc); // ≤ price × quantity ≤ escrow
        uint64 fee = uint64(uint256(cost).bpsOf(registry().getSeriesTerms(seriesId).auctionFeeBps));
        uint64 refund = bid.escrow - cost - fee; // non-negative by the validity rule
        bid.allocation = alloc;
        bid.pendingUnits = alloc;
        bid.pendingRefund = refund;
        a.unitsMinted += alloc;
        a.escrowUnits += alloc;
        a.escrowTotal -= cost + fee;
        a.proceedsTransferred += cost;
        a.feesTotal += fee;
        emit UnitsAllocated(seriesId, bid.bidder, alloc, cost, fee, refund);

        IERC20 stable = IERC20(core.stablecoin);
        stable.safeTransfer(pc.treasury, cost);
        IMercesTreasury(pc.treasury).depositProceeds(seriesId, cost);
        if (fee > 0) stable.safeTransfer(registry().feeCollector(), fee);
        IMercesVault(pc.vault).registerHolder(seriesId, bid.bidder);
        IERC3643Token(core.unitToken).mint(address(this), alloc);
    }

    /// @dev Mint finalization (SPEC §5.2): for a settled raise the exact `units_sold` must have been minted and
    /// the registry, the treasury (deposits == proceeds) and the vault (`units_outstanding`) are informed. A failed
    /// raise is final too (nothing was minted, every refund is recorded). No further mint path exists: every bid
    /// is processed and only `processBid` mints.
    function _finalizeMint(uint256 seriesId, Auction storage a, ProtocolContracts memory pc) internal {
        a.mintFinalized = true;
        if (a.state == RaiseState.Settled) {
            if (a.unitsMinted != a.unitsSold) revert UnitsMintedMismatch();
            registry().markMintFinalized(seriesId);
            IMercesTreasury(pc.treasury).confirmDeposits(seriesId);
            IMercesVault(pc.vault).initializeSupply(seriesId, a.unitsSold);
            emit RaiseMintFinalized(seriesId, a.unitsSold, a.proceeds);
        } else {
            emit RaiseMintFinalized(seriesId, 0, 0);
        }
        emit MintAuthorityRevoked(seriesId);
    }

    /// @inheritdoc IMercesAuction
    /// @dev Pushes the recorded refund and units to the bidder's own address, regardless of the bidder's current
    /// allowlist flag (validity was fixed at reveal, brief C10). A failed delivery reverts and may be retried; it
    /// never affects counters, finalization or treasury releases.
    function deliverBid(uint256 seriesId, address bidder) external override nonReentrant {
        AuctionStorage storage $ = _s();
        Auction storage a = $.auctions[seriesId];
        Bid storage bid = _bid($, seriesId, bidder);
        if (!bid.processed) revert NotProcessed();
        if (bid.delivered) revert AlreadyDelivered();
        bid.delivered = true;
        uint64 units = bid.pendingUnits;
        uint64 refund = bid.pendingRefund;
        a.escrowUnits -= units;
        a.escrowTotal -= refund;
        a.refundsDelivered += refund;
        emit BidDelivered(seriesId, bidder, units, refund);
        if (refund > 0) IERC20(registry().getSeriesCore(seriesId).stablecoin).safeTransfer(bidder, refund);
        if (units > 0 && !IERC3643Token(a.unitToken).transfer(bidder, units)) revert TransferFailed();
    }

    function _bid(AuctionStorage storage $, uint256 seriesId, address bidder) internal view returns (Bid storage) {
        uint256 idx = $.bidIndexPlusOne[seriesId][bidder];
        if (idx == 0) revert BidNotFound();
        return $.bids[seriesId][idx - 1];
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc IMercesAuction
    function bidCommitment(uint256 price, uint256 quantity, bytes32 salt, address bidder)
        external
        pure
        override
        returns (bytes32)
    {
        return MercesMessages.orderCommitment(price.toU64(), quantity.toU64(), salt, bidder);
    }

    function getAuction(uint256 seriesId) external view override returns (Auction memory) {
        return _s().auctions[seriesId];
    }

    function getBid(uint256 seriesId, address bidder) external view override returns (Bid memory) {
        return _bid(_s(), seriesId, bidder);
    }

    function getBidAt(uint256 seriesId, uint256 index) external view override returns (Bid memory) {
        Bid[] storage bids = _s().bids[seriesId];
        if (index >= bids.length) revert BidNotFound();
        return bids[index];
    }

    function mintFinalized(uint256 seriesId) external view override returns (bool) {
        return _s().auctions[seriesId].mintFinalized;
    }

    /// @inheritdoc IMercesAuction
    function pendingUnitsOf(uint256 seriesId, address wallet) external view override returns (uint64) {
        AuctionStorage storage $ = _s();
        uint256 idx = $.bidIndexPlusOne[seriesId][wallet];
        if (idx == 0) return 0;
        Bid storage bid = $.bids[seriesId][idx - 1];
        return bid.processed && !bid.delivered ? bid.pendingUnits : 0;
    }

    /// @inheritdoc IMercesAuction
    function requiredEscrow(uint256 seriesId, uint256 price, uint256 quantity)
        external
        view
        override
        returns (uint256)
    {
        return _requiredEscrow(registry().getSeriesTerms(seriesId), price.toU64(), quantity.toU64());
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

    /// @dev `wallet_cap_units_at_auction = floor(units_offered × wallet_cap_bps / 10000)` (≥ 1 by creation).
    function _walletCapUnits(SeriesTerms memory terms) internal pure returns (uint64) {
        return uint64(uint256(terms.unitsOffered).bpsOf(terms.walletCapBps));
    }
}
