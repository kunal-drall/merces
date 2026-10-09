// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @dev `WindowSettlementRejected.reason` codes (SPEC §7 `finalize_window`).
uint8 constant REJECT_WINDOW_CROSSING_EXISTS = 1; // NO_MATCH proposed but `max_bid ≥ min_ask`
uint8 constant REJECT_WINDOW_PRICE_NOT_REVEALED = 2; // `d_at == 0 && s_at == 0`
uint8 constant REJECT_WINDOW_NO_BRANCH = 3; // neither (A) nor (B) holds

/// @notice Quarterly transfer window: a sealed call auction per series and period, the only path through which
/// sealed-bid units change hands (D9, SPEC v1.1 §7). Ships closed (`windows_enabled = false`).
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

    enum Branch {
        None,
        SupplyLimited,
        DemandLimited
    }

    struct Window {
        WindowState state;
        uint32 period;
        uint64 opensAt;
        uint64 commitEnd;
        uint64 revealEnd;
        uint32 orderCount;
        uint32 bidCount;
        uint32 revealedCount;
        uint32 validCount;
        uint64 escrowUnits;
        uint64 escrowStable;
        // proposal and tally (one round at a time)
        uint32 tallyRound;
        bool roundRejected;
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
        uint32 talliedCount;
        // result
        Branch branch;
        uint64 matchedUnits;
        uint64 marginalRemaining;
        // processing: bids (any order; marginal bids behind `marginalCursor`), then asks in reveal order
        uint32 marginalCursor;
        uint32 askCursor;
        uint32 bidsProcessed;
        uint32 processedCount;
        uint64 unitsPool;
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
    event OrderCommitted(
        uint256 indexed series, uint32 indexed period, address indexed owner, Side side, uint64 escrow
    );
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
    event WindowSettlementRejected(uint256 indexed series, uint32 indexed period, uint64 clearingPrice, uint8 reason);
    event WindowCleared(
        uint256 indexed series, uint32 indexed period, uint64 clearingPrice, uint64 matchedUnits, Branch branch
    );
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

    function openWindow(uint256 seriesId, uint32 period) external;
    function commitAsk(uint256 seriesId, bytes32 commitment, uint64 units) external;
    function commitBid(uint256 seriesId, bytes32 commitment, uint64 escrow) external;
    function revealOrder(uint256 seriesId, uint64 price, uint64 quantity, bytes32 salt) external;
    function beginWindowSettlement(uint256 seriesId, uint64 clearingPrice, bool noMatch) external;
    function tallyOrders(uint256 seriesId, uint256 fromIndex, uint256 toIndex) external;
    function finalizeWindow(uint256 seriesId) external;
    function processOrder(uint256 seriesId, uint32 period, uint256 orderIndex) external;

    function armedDeposit(address from) external view returns (uint256);
    function activeWindow(uint256 seriesId) external view returns (bool active, uint32 period);
    /// @notice True while a window of the series is open, settling, or settled with unprocessed orders.
    function hasPendingOrders(uint256 seriesId) external view returns (bool);
    /// @notice Units of `wallet` held in the window escrow by open or unprocessed asks (SPEC §6.1 accrual weight).
    function askEscrowUnits(uint256 seriesId, address wallet) external view returns (uint64);
    function getWindow(uint256 seriesId, uint32 period) external view returns (Window memory);
    function getOrder(uint256 seriesId, uint32 period, uint256 index) external view returns (Order memory);
    function orderIndexOf(uint256 seriesId, uint32 period, address owner)
        external
        view
        returns (bool exists, uint256 index);
    /// @notice Next marginal-side order (branch A: bids at p*) that must be processed, if any.
    function nextMarginalOrder(uint256 seriesId, uint32 period) external view returns (bool exists, uint256 index);
    /// @notice Next ask in reveal order that must be processed, if any.
    function nextAskOrder(uint256 seriesId, uint32 period) external view returns (bool exists, uint256 index);
    function walletCapUnits(uint256 seriesId) external view returns (uint64);
    function requiredBidEscrow(uint256 seriesId, uint64 price, uint64 quantity) external view returns (uint256);
}
