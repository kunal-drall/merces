// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Tier-1 split router (D5, SPEC v1.1 §6.5): per-series receiving account, θ / r split, YTD counter,
/// period checkpoints (`ytd_at_end`) that bind pure tier-1 reports through Poseidon(2). Split out of
/// `MercesIncome` on EVM so each deployable stays under the EIP-170 size limit.
interface IMercesRouter {
    struct Router {
        bool receiverDeployed;
        address receiver;
        uint64 heldBeforeFinalization;
        uint16 ytdYear;
        uint64 ytdReceived;
        bool hasReceipt;
        uint32 lastReceiptPeriod;
        bool hasCheckpoint;
        uint32 lastCheckpointPeriod;
        // ghost accounting
        uint64 routedTotal;
        uint64 passedThroughTotal;
    }

    struct Checkpoint {
        bool set;
        uint64 ytdAtEnd;
    }

    event RouterReceiverCreated(uint256 indexed series, address receiver);
    /// @dev Income received before mint finalization waits in the receiving account (SPEC §6.1 gate).
    event IncomeHeld(uint256 indexed series, uint64 amount, uint64 held);
    event IncomeRouted(uint256 indexed series, uint64 amount, uint64 passThrough, uint64 routed, uint64 ytdReceived);
    event RouterPeriodClosed(uint256 indexed series, uint32 period, uint64 ytdAtEnd);
    event IncomeSet(address income);

    function createRouterReceiver(uint256 seriesId) external returns (address receiver);
    /// @notice Pulls `amount` from the caller and splits it (together with anything held in the receiving
    /// account). Before mint finalization the amount is held in the receiving account instead.
    function route(uint256 seriesId, uint64 amount) external;
    function sweep(uint256 seriesId) external;
    function closeRouterPeriod(uint256 seriesId, uint32 period) external;

    function routerReceiver(uint256 seriesId) external view returns (address);
    function getRouter(uint256 seriesId) external view returns (Router memory);
    /// @notice `(exists, ytd_at_end[period])`; periods before the first period read as `(true, 0)`.
    function ytdAtEnd(uint256 seriesId, uint32 period) external view returns (bool exists, uint64 ytd);
    function income() external view returns (address);
}
