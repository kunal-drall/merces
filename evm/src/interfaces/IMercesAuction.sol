// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {RaiseState} from "../types/MercesTypes.sol";

/// @notice Sealed-bid, uniform-price auction (D3, SPEC §5.1–5.2). One bid per wallet per series.
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
        // settlement proposal and tally
        uint64 clearingPrice;
        uint64 qAbove;
        uint64 qAt;
        uint64 minValidPrice;
        uint32 talliedCount;
        uint32 tallyRound;
        // results
        uint64 settlementTs;
        uint64 unitsSoldUpper;
        uint64 remainderAtMargin;
        uint64 unitsMinted;
        uint64 unitsSold;
        uint64 proceeds;
        uint32 bidsProcessed;
        bool mintAuthorityRevoked;
        // ghost accounting for invariants
        uint64 refundedTotal;
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
    }

    event RaiseOpened(uint256 indexed series, address unitMint, uint64 openedAt, uint64 commitEnd, uint64 revealEnd);
    event RaiseCancelled(uint256 indexed series);
    event BidCommitted(uint256 indexed series, address indexed bidder, uint64 escrow);
    event BidRevealed(uint256 indexed series, address indexed bidder, uint64 price, uint64 quantity, bool valid);
    event SettlementProposed(uint256 indexed series, uint64 clearingPrice, uint32 round);
    event RaiseSettled(
        uint256 indexed series, uint64 clearingPrice, uint64 unitsSoldUpper, uint64 proceedsUpper, uint64 settlementTs
    );
    event RaiseFailed(uint256 indexed series, uint64 clearingPrice, uint64 proceedsUpper, uint64 minRaise);
    event UnitsAllocated(
        uint256 indexed series, address indexed bidder, uint64 units, uint64 cost, uint64 fee, uint64 refund
    );
    event BidRefunded(uint256 indexed series, address indexed bidder, uint64 refund, uint64 charge);
    event NonRevealCharged(uint256 indexed series, address indexed bidder, uint64 charge);
    event RaiseMintFinalized(uint256 indexed series, uint64 unitsSold, uint64 proceeds);
    event MintAuthorityRevoked(uint256 indexed series);

    function openRaise(uint256 seriesId) external;
    function cancelRaise(uint256 seriesId) external;
    function commitBid(uint256 seriesId, bytes32 commitment, uint64 escrow) external;
    function revealBid(uint256 seriesId, uint64 price, uint64 quantity, bytes32 salt) external;
    function beginSettlement(uint256 seriesId, uint64 proposedClearingPrice) external;
    function tallyBids(uint256 seriesId, uint256 fromIndex, uint256 toIndex) external;
    function finalizeSettlement(uint256 seriesId) external;
    function processBid(uint256 seriesId, uint256 bidIndex) external;

    function getAuction(uint256 seriesId) external view returns (Auction memory);
    function getBid(uint256 seriesId, uint256 bidIndex) external view returns (Bid memory);
    function bidIndexOf(uint256 seriesId, address bidder) external view returns (bool exists, uint256 index);
    function mintFinalized(uint256 seriesId) external view returns (bool);
    function requiredEscrow(uint256 seriesId, uint64 price, uint64 quantity) external view returns (uint256);
    function walletCapUnitsAtAuction(uint256 seriesId) external view returns (uint64);
}
