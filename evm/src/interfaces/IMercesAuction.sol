// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {RaiseState} from "../types/MercesTypes.sol";

/// @dev `SettlementRejected.reason` codes (SPEC §5.2 finalize steps 2 and 3).
uint8 constant REJECT_CLAIM_MISMATCH = 1;
uint8 constant REJECT_INVALID_CLEARING_PRICE = 2;

/// @notice Sealed-bid, uniform-price auction (D3, SPEC v1.1 §5.1–5.2). One bid per wallet per series.
interface IMercesAuction {
    struct Auction {
        RaiseState state;
        address unitToken;
        uint64 openedAt;
        uint64 commitEnd;
        uint64 revealEnd;
        uint64 escrowTotal;
        uint32 bidCount;
        uint32 revealedCount;
        uint32 validCount;
        // settlement proposal and tally (one round at a time)
        uint32 tallyRound;
        bool roundRejected;
        uint64 clearingPrice;
        uint64 qAboveClaim;
        uint64 qAtClaim;
        uint64 rClaim;
        uint64 qAbove;
        uint64 qAt;
        uint64 allocSum;
        uint64 minValidPrice;
        uint32 talliedCount;
        // results (exact, written once at finalize)
        uint64 unitsSold;
        uint64 proceeds;
        uint64 settlementTs;
        // processing
        uint32 bidsProcessed;
        uint64 unitsMinted;
        bool mintFinalized;
        // ghost accounting for invariants (sums of the per-bid records)
        uint64 pendingRefundTotal;
        uint64 pendingUnitsTotal;
        uint64 refundsDelivered;
        uint64 unitsDelivered;
        uint64 feesTotal;
        uint64 chargesTotal;
        uint64 proceedsTransferred;
    }

    struct Bid {
        address bidder;
        bytes32 commitment;
        uint64 escrow;
        uint32 revealIndex;
        bool revealed;
        bool valid;
        uint64 price;
        uint64 quantity;
        uint32 talliedRound;
        bool processed;
        uint64 allocation;
        uint64 pendingUnits;
        uint64 pendingRefund;
        bool delivered;
    }

    event RaiseOpened(uint256 indexed series, address unitMint, uint64 openedAt, uint64 commitEnd, uint64 revealEnd);
    event RaiseCancelled(uint256 indexed series);
    event BidCommitted(uint256 indexed series, address indexed bidder, uint64 escrow);
    event BidRevealed(uint256 indexed series, address indexed bidder, uint64 price, uint64 quantity, bool valid);
    event SettlementProposed(uint256 indexed series, uint64 clearingPrice, uint32 round);
    event SettlementRejected(uint256 indexed series, uint32 round, uint64 clearingPrice, uint8 reason);
    event RaiseSettled(
        uint256 indexed series, uint64 clearingPrice, uint64 unitsSold, uint64 proceeds, uint64 settlementTs
    );
    event RaiseFailed(uint256 indexed series, uint64 clearingPrice, uint64 proceeds, uint64 minRaise);
    event UnitsAllocated(
        uint256 indexed series, address indexed bidder, uint64 units, uint64 cost, uint64 fee, uint64 refund
    );
    /// @dev EVM-only indexer convenience: emitted for every processed bid (SPEC emits `UnitsAllocated` only
    /// for winning bids).
    event BidProcessed(uint256 indexed series, address indexed bidder, uint64 units, uint64 refund);
    event BidDelivered(uint256 indexed series, address indexed bidder, uint64 units, uint64 refund);
    event NonRevealCharged(uint256 indexed series, address indexed bidder, uint64 charge);
    event RaiseMintFinalized(uint256 indexed series, uint64 unitsSold, uint64 proceeds);
    event MintAuthorityRevoked(uint256 indexed series);

    function openRaise(uint256 seriesId) external;
    function cancelRaise(uint256 seriesId) external;
    function commitBid(uint256 seriesId, bytes32 commitment, uint64 escrow) external;
    function revealBid(uint256 seriesId, uint64 price, uint64 quantity, bytes32 salt) external;
    function beginSettlement(uint256 seriesId, uint64 clearingPrice, uint64 qAboveClaim, uint64 qAtClaim) external;
    function tallyBids(uint256 seriesId, uint256 fromIndex, uint256 toIndex) external;
    function finalizeSettlement(uint256 seriesId) external;
    function processBid(uint256 seriesId, uint256 bidIndex) external;
    function deliverBid(uint256 seriesId, uint256 bidIndex) external;

    function getAuction(uint256 seriesId) external view returns (Auction memory);
    function getBid(uint256 seriesId, uint256 bidIndex) external view returns (Bid memory);
    function bidIndexOf(uint256 seriesId, address bidder) external view returns (bool exists, uint256 index);
    function mintFinalized(uint256 seriesId) external view returns (bool);
    /// @notice Units minted for `wallet` and still held in the auction escrow (SPEC §6.1 accrual weight).
    function pendingUnitsOf(uint256 seriesId, address wallet) external view returns (uint64);
    function requiredEscrow(uint256 seriesId, uint64 price, uint64 quantity) external view returns (uint256);
    function walletCapUnitsAtAuction(uint256 seriesId) external view returns (uint64);
}
