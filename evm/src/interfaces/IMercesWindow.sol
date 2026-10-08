// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Quarterly transfer window: a sealed call auction per series and period, the only path through which
/// sealed-bid units change hands (D9, SPEC §7). Ships closed (`windows_enabled = false`).
interface IMercesWindow {
    enum WindowState {
        None,
        Open,
        Settling,
        Settled,
        NoMatch
    }

    enum Side {
        Bid,
        Ask
    }

    struct Window {
        WindowState state;
        uint32 period;
        uint64 opensAt;
        uint64 commitEnd;
        uint64 revealEnd;
        uint32 bidCount;
        uint32 askCount;
        uint32 revealedCount;
        uint64 escrowUnits;
        uint64 escrowStable;
        // proposal and tally
        bool noMatchProposed;
        uint64 clearingPrice;
        uint64 dAbove;
        uint64 dAt;
        uint64 sBelow;
        uint64 sAt;
        uint64 maxBid;
        uint64 minAsk;
        bool hasValidBid;
        bool hasValidAsk;
        uint32 tallied;
        uint32 tallyRound;
        // result
        uint64 matchedUnits;
        bool supplyBinding;
        uint64 remainder;
        // ordered processing
        uint8 phase;
        uint32 cursor;
        uint64 firstSideFilled;
        uint64 dustRemaining;
        uint32 processed;
        // ghost accounting
        uint64 unitsDelivered;
        uint64 unitsReturned;
        uint64 stableToSellers;
        uint64 stableRefunded;
        uint64 feesTotal;
    }

    struct Order {
        address owner;
        Side side;
        bytes32 commitment;
        uint64 escrow;
        uint32 revealIndex;
        bool revealed;
        bool valid;
        uint64 price;
        uint64 quantity;
        uint32 talliedRound;
        bool processed;
        uint64 fill;
    }

    event WindowOpened(uint256 indexed series, uint32 indexed period, uint64 commitEnd, uint64 revealEnd);
    event OrderCommitted(uint256 indexed series, uint32 indexed period, address indexed owner, Side side, uint64 escrow);
    event OrderRevealed(
        uint256 indexed series,
        uint32 indexed period,
        address indexed owner,
        Side side,
        uint64 price,
        uint64 quantity,
        bool valid
    );
    event WindowSettlementProposed(
        uint256 indexed series, uint32 indexed period, uint64 clearingPrice, bool noMatch, uint32 round
    );
    event WindowCleared(uint256 indexed series, uint32 indexed period, uint64 clearingPrice, uint64 matchedUnits);
    event WindowNoMatch(uint256 indexed series, uint32 indexed period);
    event OrderFilled(
        uint256 indexed series,
        uint32 indexed period,
        address indexed owner,
        Side side,
        uint64 fill,
        uint64 price,
        uint64 fee,
        uint64 refund
    );
    event UnitsHeld(uint256 indexed series, address indexed wallet, uint64 units);
    event HeldUnitsWithdrawn(uint256 indexed series, address indexed wallet, uint64 units);

    function openWindow(uint256 seriesId, uint32 period) external;
    function commitAsk(uint256 seriesId, bytes32 commitment, uint64 units) external;
    function commitBid(uint256 seriesId, bytes32 commitment, uint64 escrow) external;
    function revealOrder(uint256 seriesId, Side side, uint64 price, uint64 quantity, bytes32 salt) external;
    function beginWindowSettlement(uint256 seriesId, uint64 clearingPrice, bool noMatch) external;
    function tallyOrders(uint256 seriesId, uint256 fromIndex, uint256 toIndex) external;
    function finalizeWindow(uint256 seriesId) external;
    function processOrders(uint256 seriesId, uint32 period, uint256 maxSteps) external;
    function withdrawHeldUnits(uint256 seriesId, address wallet) external;

    function armedDeposit(address from) external view returns (uint256);
    function activeWindow(uint256 seriesId) external view returns (bool active, uint32 period);
    function getWindow(uint256 seriesId, uint32 period) external view returns (Window memory);
    function getOrder(uint256 seriesId, uint32 period, uint256 index) external view returns (Order memory);
    function orderIndexOf(uint256 seriesId, uint32 period, address owner, Side side)
        external
        view
        returns (bool exists, uint256 index);
    function heldUnits(uint256 seriesId, address wallet) external view returns (uint64);
    function walletCapUnits(uint256 seriesId) external view returns (uint64);
    function requiredBidEscrow(uint256 seriesId, uint64 price, uint64 quantity) external view returns (uint256);
}
