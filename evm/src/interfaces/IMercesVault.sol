// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {PayoutSource, SeriesStatus} from "../types/MercesTypes.sol";
import {IPayoutClaims} from "./IPayoutClaims.sol";

/// @notice Payout vault accounting plus the exit path (D7, D8; SPEC §6.3, §6.7–6.9).
interface IMercesVault is IPayoutClaims {
    struct Ledger {
        uint256 paidPerUnitWad;
        uint256 netAccWad;
        uint64 carry;
        uint64 feeCollected;
        uint64 grossReceived;
        uint64 refundedToIssuer;
        // redemption and tail
        uint64 redemptionTs;
        uint64 redemptionPrice;
        uint64 unitsAtRedemption;
        uint64 tailCapPerUnit;
        uint256 tailAccWad;
        uint256 tailPaidPerUnitWad;
        uint64 tailCarry;
        // extinguishment
        uint256 finalAccWad;
        uint64 finalCarry;
        uint64 extinguishNonce;
        uint64 unreleasedReceived;
        // ghost accounting for invariants
        uint64 claimedTotal;
        uint64 redemptionDeposit;
        uint64 burnedTotal;
    }

    struct Holder {
        bool registered;
        uint256 lastNetAccWad;
        uint64 pending;
        uint64 redeemedUnits;
        bool redemptionSettled;
        uint256 lastTailAccWad;
        uint256 lastFinalAccWad;
    }

    event PayoutDistributed(
        uint256 indexed series,
        PayoutSource source,
        uint64 gross,
        uint64 accepted,
        uint64 fee,
        uint64 netAdded,
        uint256 deltaAccWad,
        uint256 paidPerUnitWad,
        bool retired
    );
    event SeriesRetired(uint256 indexed series, uint256 paidPerUnitWad, uint64 refund);
    event SeriesRedeemed(
        uint256 indexed series,
        uint64 price,
        uint64 hurdle,
        uint64 dAvg,
        uint64 capRemaining,
        uint64 units,
        uint64 deposit
    );
    event TailDistributed(uint256 indexed series, uint32 period, uint64 gross, uint64 accepted, uint64 fee, uint64 refunded);
    event SeriesExtinguished(uint256 indexed series, uint64 unreleased, address attestorA, address attestorB);

    /// @dev Called by `MercesIncome` after it has transferred `amount` stablecoin to the vault.
    function receiveGross(uint256 seriesId, uint64 amount, PayoutSource source, uint32 period)
        external
        returns (uint64 accepted, uint64 fee, uint64 refunded);
    function redeem(uint256 seriesId) external;
    function extinguish(uint256 seriesId, bytes calldata signatureA, bytes calldata signatureB) external;

    function getLedger(uint256 seriesId) external view returns (Ledger memory);
    function getHolder(uint256 seriesId, address holder) external view returns (Holder memory);
    function unitsOutstanding(uint256 seriesId) external view returns (uint64);
    function capPerUnit(uint256 seriesId) external view returns (uint64);
    function yearGrossWad(uint256 seriesId, uint256 year) external view returns (uint256);
    function terminalStatus(uint256 seriesId) external view returns (SeriesStatus status, bool isTerminal);
    function previewRedemption(uint256 seriesId, uint256 timestamp)
        external
        view
        returns (uint64 price, uint64 hurdle, uint64 dAvg, uint64 capRemaining, uint64 deposit);
}
