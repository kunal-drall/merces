// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {PayoutSource} from "../types/MercesTypes.sol";
import {IPayoutClaims} from "./IPayoutClaims.sol";

/// @notice Payout vault accounting plus the exit path (D7, D8; SPEC v1.1 §6.3, §6.7–6.9).
interface IMercesVault is IPayoutClaims {
    struct Ledger {
        // supply (stored at mint finalization, reduced only by burns)
        bool supplySet;
        uint64 unitsOutstanding;
        // main accumulators
        uint256 paidPerUnitWad;
        uint256 netAccWad;
        /// @dev Exact WAD remainder of the last distribution (`net × WAD + carry − delta × N`), see
        /// docs/assumptions/track-c.md (reference defect S1: a base-unit carry double-counts).
        uint256 carryWad;
        uint64 feeCollected;
        uint64 grossReceived;
        uint64 refundedToIssuer;
        // redemption and tail
        uint64 redemptionTs;
        uint64 redemptionPrice;
        uint64 unitsAtRedemption;
        uint64 tailCapPerUnit;
        uint256 tailPaidPerUnitWad;
        uint256 tailAccWad;
        uint256 tailCarryWad;
        bool tailExhausted;
        uint64 tailGrossReceived;
        uint64 tailFeeCollected;
        uint64 tailRefunded;
        // extinguishment
        uint64 extinguishedAt;
        uint256 finalAccWad;
        uint256 finalCarryWad;
        uint64 finalUnits;
        uint64 extinguishNonce;
        uint64 unreleasedReceived;
        // ghost accounting for invariants
        uint64 claimedTotal;
        uint64 redemptionDeposit;
        uint64 burnedTotal;
    }

    /// @dev Tagged slot of the 4-entry `year_gross` ring (SPEC §6.3).
    struct YearGross {
        bool set;
        uint16 year;
        uint256 grossWad;
    }

    struct Holder {
        bool registered;
        bool finalClaimed;
        uint64 pending;
        uint64 redeemedUnits;
        uint256 lastNetAccWad;
        uint256 lastTailAccWad;
        uint256 lastFinalAccWad;
    }

    event SupplyInitialized(uint256 indexed series, uint64 unitsOutstanding);
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
    event TailDistributed(
        uint256 indexed series, uint32 period, uint64 gross, uint64 accepted, uint64 fee, uint64 refunded
    );
    event SeriesExtinguished(uint256 indexed series, uint64 unreleased, address attestorA, address attestorB);

    /// @dev Auction only, at mint finalization: `units_outstanding = units_sold`.
    function initializeSupply(uint256 seriesId, uint64 unitsSold) external;
    /// @dev Income only, after it has transferred `amount` stablecoin here. `period` is the report period for
    /// `Payment` (its due date anchors the `year_gross` slot) and the tail period for `Tail`; ignored for `Router`.
    function receiveGross(uint256 seriesId, uint64 amount, PayoutSource source, uint32 period)
        external
        returns (uint64 accepted, uint64 fee, uint64 refunded);
    /// @dev Window only (docs/assumptions/track-c.md C-S4): credits `wallet` with the payout accrued since the
    /// window cleared (`net_acc_wad − fromAccWad`) on `units` that sat in the window escrow — the units a buyer
    /// receives at its fill and the unsold units a seller gets back. Escrowed ask units stop earning for the seller
    /// at clearing (`askAccrual`), so every unit earns for exactly one wallet at every moment.
    function creditWindowAccrual(uint256 seriesId, address wallet, uint64 units, uint256 fromAccWad) external;
    /// @notice Anyone: retires a series whose (possibly lowered) cap is already met (SPEC §6.3).
    function retireIfCapped(uint256 seriesId) external;
    function redeem(uint256 seriesId) external;
    function extinguish(uint256 seriesId, bytes calldata signatureA, bytes calldata signatureB) external;

    function getLedger(uint256 seriesId) external view returns (Ledger memory);
    function getHolder(uint256 seriesId, address holder) external view returns (Holder memory);
    function unitsOutstanding(uint256 seriesId) external view returns (uint64);
    function netAccWad(uint256 seriesId) external view returns (uint256);
    /// @notice `unit_balance + pending auction units + ask-escrow units` (SPEC §6.1 accrual weight).
    function accrualUnits(uint256 seriesId, address wallet) external view returns (uint256);
    function capPerUnit(uint256 seriesId) external view returns (uint64);
    function capEffWad(uint256 seriesId) external view returns (uint256);
    function yearGrossWad(uint256 seriesId, uint256 year) external view returns (uint256);
    function previewRedemption(uint256 seriesId, uint256 timestamp)
        external
        view
        returns (uint64 price, uint64 hurdle, uint64 dAvg, uint64 capRemaining, uint64 deposit);
}
