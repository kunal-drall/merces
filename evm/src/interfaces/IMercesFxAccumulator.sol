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

    event FxSnapshot(bytes32 indexed pair, uint32 day, uint64 rateWad, uint256 sumWad, uint32 count);
    event FxDeviationFlagged(bytes32 indexed pair, uint32 period, uint64 rateWad, uint64 crosscheckWad);
    event PythSet(address pyth);

    function snapshot(bytes32 pairId, bytes[] calldata priceUpdateData) external payable;
    function quarterAverage(bytes32 pairId, uint32 period) external view returns (bool ok, uint64 avgWad);
    function getFxPair(bytes32 pairId) external view returns (FxPairState memory);
    function getFxCheckpoint(bytes32 pairId, uint32 period) external view returns (FxCheckpoint memory);
    function pyth() external view returns (address);
}
