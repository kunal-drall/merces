// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {MercesUpgradeable} from "./base/MercesUpgradeable.sol";
import {IMercesFxAccumulator} from "./interfaces/IMercesFxAccumulator.sol";
import {IPyth, PythStructs} from "./interfaces/external/IPyth.sol";
import {AggregatorV3Interface} from "./interfaces/external/AggregatorV3Interface.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {Periods} from "./libraries/Periods.sol";
import {FxPairConfig, Parameters} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesFxAccumulator
/// @notice Daily Pyth FX snapshots per currency pair with period checkpoints, Chainlink cross-check and quarter
/// averages (brief C9, SPEC v1.1 §6.6). Permissionless keepers call `snapshot` once per UTC day; `MercesIncome`
/// reads `quarterAverage` when a report is submitted. Pair configuration (feed id, inversion, cross-check feed)
/// lives in the registry; staleness, confidence, coverage and deviation parameters are the protocol defaults.
contract MercesFxAccumulator is MercesUpgradeable, IMercesFxAccumulator {
    using MercesMath for uint256;

    /// @custom:storage-location erc7201:merces.storage.MercesFxAccumulator
    struct FxStorage {
        address pyth;
        mapping(bytes32 => FxPairState) pairs;
        mapping(bytes32 => mapping(uint32 => FxCheckpoint)) checkpoints;
    }

    // keccak256(abi.encode(uint256(keccak256("merces.storage.MercesFxAccumulator")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant FX_STORAGE = 0x40758aa9bfe29a58c22eca4f2c9a74b07e8c8c700c7c5855014f3fb1dbf3c400;

    function _s() private pure returns (FxStorage storage $) {
        assembly ("memory-safe") {
            $.slot := FX_STORAGE
        }
    }

    function initialize(address owner_, address registry_, address pyth_) external initializer {
        __MercesUpgradeable_init(owner_, registry_);
        _s().pyth = pyth_;
        emit PythSet(pyth_);
    }

    /// @notice Pyth price-feed contract for this chain, owner (timelock) only.
    function setPyth(address pyth_) external onlyOwner {
        _s().pyth = pyth_;
        emit PythSet(pyth_);
    }

    /// @inheritdoc IMercesFxAccumulator
    /// @dev Optionally posts the Pyth update first (fee from `msg.value`, excess refunded). Validates staleness
    /// and confidence, normalizes to WAD, checkpoints the period before adding (closing the previous period),
    /// cross-checks Chainlink when configured (a stale or deviating cross-check flags the period), then
    /// accumulates.
    function snapshot(bytes32 pairId, bytes[] calldata priceUpdateData) external payable override nonReentrant {
        FxPairConfig memory cfg = registry().getFxPair(pairId);
        if (!cfg.enabled) revert FxPairDisabled(pairId);
        FxPairState storage st = _s().pairs[pairId];
        uint32 day = uint32(block.timestamp / C.DAY);
        if (day <= st.lastDay) revert SnapshotAlreadyTaken();
        Parameters memory p = registry().getDefaults();
        IPyth pyth_ = IPyth(_s().pyth);

        if (priceUpdateData.length > 0) {
            uint256 fee = pyth_.getUpdateFee(priceUpdateData);
            if (msg.value < fee) revert PythUpdateFeeInsufficient();
            pyth_.updatePriceFeeds{value: fee}(priceUpdateData);
            if (msg.value > fee) {
                (bool ok,) = msg.sender.call{value: msg.value - fee}("");
                if (!ok) revert PythUpdateFeeInsufficient();
            }
        } else if (msg.value != 0) {
            revert PythUpdateFeeInsufficient();
        }

        uint256 rateWad = _readRate(pyth_, cfg, p);
        uint32 pid = Periods.periodOf(block.timestamp);
        FxCheckpoint storage cp = _s().checkpoints[pairId][pid];
        if (!cp.exists) {
            cp.exists = true;
            cp.sumWad = st.sumWad;
            cp.count = st.count;
        }
        if (cfg.crosscheck != address(0) && pid >= cfg.crosscheckEffectivePeriod) {
            (bool fresh, uint256 clWad) = _chainlink(cfg.crosscheck, p.fxMaxStalenessSeconds);
            if (!fresh || _deviates(rateWad, clWad, p.fxDeviationBandBps)) {
                cp.flagged = true;
                emit FxDeviationFlagged(pairId, pid, rateWad, clWad);
            }
        }
        st.sumWad += rateWad;
        st.count += 1;
        st.lastDay = day;
        emit FxSnapshot(pairId, day, rateWad, st.sumWad, st.count);
    }

    /// @dev SPEC §6.6 steps 1–2: validate the Pyth price and normalize it to a WAD rate (inverting if configured).
    function _readRate(IPyth pyth_, FxPairConfig memory cfg, Parameters memory p) internal view returns (uint256) {
        PythStructs.Price memory price = pyth_.getPriceNoOlderThan(cfg.feedId, p.fxMaxStalenessSeconds);
        if (price.price <= 0) revert InvalidPythPrice();
        if (price.publishTime + p.fxMaxStalenessSeconds < block.timestamp) revert InvalidPythPrice();
        uint256 raw = uint256(uint64(price.price));
        if (uint256(price.conf) * C.BPS > raw * p.fxMaxConfBps) revert ConfidenceTooWide();
        uint256 rate = _normalize(raw, price.expo);
        if (cfg.inverted) {
            if (rate == 0) revert InvalidPythPrice();
            rate = C.WAD * C.WAD / rate;
        }
        return rate;
    }

    /// @dev SPEC §6.6 step 2: `expo ≤ 0` → `price × 10^(18 + expo)` (requires `expo ≥ −18`), `expo > 0` →
    /// `price × 10^18 × 10^expo`.
    function _normalize(uint256 price, int32 expo) internal pure returns (uint256) {
        if (expo < -18 || expo > 40) revert InvalidPythPrice();
        return price * 10 ** uint256(int256(18) + int256(expo));
    }

    function _chainlink(address agg, uint64 staleness) internal view returns (bool fresh, uint256 clWad) {
        (, int256 answer,, uint256 updatedAt,) = AggregatorV3Interface(agg).latestRoundData();
        if (answer <= 0 || updatedAt + staleness < block.timestamp) return (false, 0);
        uint8 dec = AggregatorV3Interface(agg).decimals();
        uint256 a = uint256(answer);
        clWad = dec <= 18 ? a * 10 ** (18 - dec) : a / 10 ** (dec - 18);
        return (true, clWad);
    }

    /// @dev `|rate − cl| × 10000 > cl × band_bps`.
    function _deviates(uint256 rateWad, uint256 clWad, uint16 bandBps) internal pure returns (bool) {
        uint256 diff = rateWad > clWad ? rateWad - clWad : clWad - rateWad;
        return diff * C.BPS > clWad * bandBps;
    }

    /// @inheritdoc IMercesFxAccumulator
    function quarterAverage(bytes32 pairId, uint32 period) external view override returns (bool ok, uint256 avgWad) {
        (, ok, avgWad,,) = _quarter(pairId, period);
    }

    /// @inheritdoc IMercesFxAccumulator
    function quarterStats(bytes32 pairId, uint32 period)
        external
        view
        override
        returns (bool available, bool ok, uint256 avgWad, uint32 n, bool flagged)
    {
        return _quarter(pairId, period);
    }

    /// @dev SPEC §6.6 `quarter_average`: the start is `checkpoints[p]`; the end is `checkpoints[p+1]` when present,
    /// else the live totals once `p` has ended and no snapshot has been taken in `p+1` yet (they are then exactly
    /// the end-of-`p` totals); otherwise `NeedsFallback`. `ok` needs trading-day coverage
    /// `n × 10000 ≥ trading_days_in_period(p) × min_coverage_bps` and no deviation flag on `p`.
    function _quarter(bytes32 pairId, uint32 period)
        internal
        view
        returns (bool available, bool ok, uint256 avgWad, uint32 n, bool flagged)
    {
        FxCheckpoint storage a = _s().checkpoints[pairId][period];
        if (!a.exists) return (false, false, 0, 0, false);
        flagged = a.flagged;
        FxCheckpoint storage b = _s().checkpoints[pairId][period + 1];
        uint256 sumEnd;
        uint256 countEnd;
        if (b.exists) {
            sumEnd = b.sumWad;
            countEnd = b.count;
        } else {
            FxPairState storage st = _s().pairs[pairId];
            if (
                block.timestamp < Periods.periodEnd(period)
                    || uint256(st.lastDay) * C.DAY >= Periods.periodStart(period + 1)
            ) return (false, false, 0, 0, flagged);
            sumEnd = st.sumWad;
            countEnd = st.count;
        }
        n = uint32(countEnd - a.count);
        if (n == 0) return (false, false, 0, 0, flagged);
        available = true;
        avgWad = (sumEnd - a.sumWad) / n;
        uint16 minCoverage = registry().getDefaults().fxMinCoverageBps;
        ok = uint256(n) * C.BPS >= uint256(Periods.tradingDaysInPeriod(period)) * minCoverage && !flagged;
    }

    function getFxPair(bytes32 pairId) external view override returns (FxPairState memory) {
        return _s().pairs[pairId];
    }

    function getFxCheckpoint(bytes32 pairId, uint32 period) external view override returns (FxCheckpoint memory) {
        return _s().checkpoints[pairId][period];
    }

    function pyth() external view override returns (address) {
        return _s().pyth;
    }
}
