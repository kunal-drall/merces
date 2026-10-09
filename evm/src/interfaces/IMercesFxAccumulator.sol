// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Rate accumulator (brief C9, SPEC §6.6): one running sum per FX pair, one Pyth snapshot per UTC day,
/// period checkpoints, Chainlink cross-check, quarter averages. Split out of `MercesIncome` on EVM so each
/// deployable stays under the EIP-170 size limit; the behaviour and events are exactly SPEC §6.6.
interface IMercesFxAccumulator {
    struct FxCheckpoint {
        bool exists;
        uint256 sumWad;
        uint32 count;
        bool flagged;
    }

    struct FxPairState {
        uint256 sumWad;
        uint32 count;
        uint32 lastDay;
    }

    event FxSnapshot(bytes32 indexed pair, uint32 day, uint256 rateWad, uint256 sumWad, uint32 count);
    event FxDeviationFlagged(bytes32 indexed pair, uint32 period, uint256 rateWad, uint256 crosscheckWad);
    event PythSet(address pyth);

    function snapshot(bytes32 pairId, bytes[] calldata priceUpdateData) external payable;
    /// @notice SPEC §6.6 `quarter_average`: `ok` is the Ok branch; `avgWad` is the mean of the snapshots in the
    /// period whenever at least one exists (also reported alongside `ok == false`, for diagnostics).
    function quarterAverage(bytes32 pairId, uint32 period) external view returns (bool ok, uint256 avgWad);
    /// @notice Diagnostic view of a period: `available` (at least one snapshot between the start checkpoint
    /// and the end), `ok` (coverage met and not flagged), `avgWad`, snapshot count `n`, `flagged`.
    function quarterStats(bytes32 pairId, uint32 period)
        external
        view
        returns (bool available, bool ok, uint256 avgWad, uint32 n, bool flagged);
    function getFxPair(bytes32 pairId) external view returns (FxPairState memory);
    function getFxCheckpoint(bytes32 pairId, uint32 period) external view returns (FxCheckpoint memory);
    function pyth() external view returns (address);
}
