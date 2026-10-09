// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @dev `WindowSettlementRejected.reason` codes (SPEC §7 `finalize_window`, canonical reason `InvalidWindowPrice`).
uint8 constant REJECT_WINDOW_CROSSING_EXISTS = 1; // NO_MATCH proposed but `max_bid ≥ min_ask`
uint8 constant REJECT_WINDOW_PRICE_NOT_REVEALED = 2; // `d_at == 0 && s_at == 0`
uint8 constant REJECT_WINDOW_NO_BRANCH = 3; // neither (A) nor (B) holds

/// @notice Quarterly transfer window: a sealed call auction per series and period, the only path through which
/// sealed-bid units change hands (D9, SPEC v1.1 §7). Ships closed (`windows_enabled = false`).
interface IMercesWindow {
    /// @dev `Reveal` starts with the first reveal; `Done` once every order is processed (vector `window.state`).
    enum WindowState {
        None,
        Commit,
        Reveal,
        Settling,
        Settled,
        NoMatch,
        Done
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
        uint64 proposedPrice;
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
        uint64 clearingPrice;
        Branch branch;
        uint64 matchedUnits;
        /// @dev Units left for the marginal side at clearing (`S − d_above` in A, `D − s_below` in B); constant.
        uint64 marginalRemaining;
        /// @dev The vault's `net_acc_wad` when the window cleared: the seller's escrow weight stops here; later
        /// payouts on escrowed units are credited from this point to the buyer at its fill (sold units) or to the
        /// seller at its ask's processing (unsold units), so per-order processing never counts a unit twice and
        /// never strands one (docs/assumptions/track-c.md C-S4).
        uint256 accAtClear;
        // processing
        uint32 processedCount;
        uint32 bidsProcessed;
        /// @dev Units of filled bids cancelled at fill (buyer no longer allowlisted), taken back from the asks.
        uint64 cancelledUnits;
        /// @dev Σ valid ask quantity of the price levels below `p*` indexed so far (take-back order, SPEC §7).
        uint64 priceIndexSum;
        uint64 priceIndexLast;
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
        /// @dev Σ quantity of valid orders on the same side and price revealed before this one.
        uint64 samePricePrefix;
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
    /// @dev EVM-only: a stablecoin push to `owner` failed for a recipient-side reason; the amount waits in
    /// `owed(series, owner)` and `withdrawOwed` retries it (SPEC §12 liveness).
    event PaymentDeferred(uint256 indexed series, address indexed owner, uint64 amount);
    event OwedWithdrawn(uint256 indexed series, address indexed owner, uint64 amount);

    function openWindow(uint256 seriesId, uint32 period) external;
    function commitAsk(uint256 seriesId, bytes32 commitment, uint256 units) external;
    function commitBid(uint256 seriesId, bytes32 commitment, uint256 escrow) external;
    function revealOrder(uint256 seriesId, uint256 price, uint256 quantity, bytes32 salt) external;
    function beginWindowSettlement(uint256 seriesId, uint256 clearingPrice, bool noMatch) external;
    function tallyOrders(uint256 seriesId, uint256 fromIndex, uint256 toIndex) external;
    function finalizeWindow(uint256 seriesId) external;
    /// @notice Keeper-supplied price levels of the valid asks below `p*`, strictly ascending; complete when their
    /// quantities sum to `s_below`. Needed only when cancelled buyers' units reach below the clearing price.
    function indexAskPrices(uint256 seriesId, uint64[] calldata prices) external;
    function processOrder(uint256 seriesId, address owner) external;
    function withdrawOwed(uint256 seriesId, address owner) external;

    /// @notice SPEC §1.3 order commitment; reverts `AmountOutOfRange` when price or quantity does not fit uint64.
    function orderCommitment(uint256 price, uint256 quantity, bytes32 salt, address owner)
        external
        pure
        returns (bytes32);
    function armedDeposit(address from) external view returns (uint256);
    /// @notice The series' current (or last) window: `exists` once one was opened.
    function currentWindow(uint256 seriesId) external view returns (bool exists, uint32 period);
    /// @notice Units of `wallet` held in the window escrow by open or unprocessed asks (SPEC §6.1 accrual weight).
    function askEscrowUnits(uint256 seriesId, address wallet) external view returns (uint64);
    /// @notice Accrual view of `wallet`'s escrowed ask units: `cleared` once the window settled with a price, after
    /// which they earn through the holder weight only up to `accAtClear` (the rest is credited at processing).
    function askAccrual(uint256 seriesId, address wallet)
        external
        view
        returns (uint64 escrowUnits, bool cleared, uint256 accAtClear);
    function owed(uint256 seriesId, address owner) external view returns (uint64);
    function getWindow(uint256 seriesId, uint32 period) external view returns (Window memory);
    function getOrder(uint256 seriesId, uint32 period, address owner) external view returns (Order memory);
    function getOrderAt(uint256 seriesId, uint32 period, uint256 index) external view returns (Order memory);
    /// @notice Whether `processOrder` must wait for the price index (cancelled units reach below `p*`).
    function priceIndexRequired(uint256 seriesId) external view returns (bool);
    function walletCapUnits(uint256 seriesId) external view returns (uint64);
    function requiredBidEscrow(uint256 seriesId, uint256 price, uint256 quantity) external view returns (uint256);
}
