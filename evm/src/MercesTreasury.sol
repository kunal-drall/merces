// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MercesUpgradeable} from "./base/MercesUpgradeable.sol";
import {IMercesTreasury} from "./interfaces/IMercesTreasury.sol";
import {IMercesIncome} from "./interfaces/IMercesIncome.sol";
import {IEarlyDrawApprover} from "./interfaces/IEarlyDrawApprover.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {RaiseState, ReleaseTranche, SeriesCore, SeriesStatus} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesTreasury
/// @notice Holds each series' auction proceeds and releases them to the issuer on the series' immutable
/// schedule (D4, SPEC §5.3). Releases pause only while the series is `Late` (derived status) or at the
/// issuer's own request (brief C11 §1). The early-draw hook is off until the registry names an approver.
/// No admin path moves funds: the only outflows are `claimRelease` / `requestEarlyDraw` (to the issuer) and
/// `moveUnreleasedToVault` (to the vault on extinguishment, for holders).
contract MercesTreasury is MercesUpgradeable, IMercesTreasury {
    using SafeERC20 for IERC20;
    using MercesMath for uint256;

    /// @custom:storage-location erc7201:merces.storage.MercesTreasury
    struct TreasuryStorage {
        mapping(uint256 => Ledger) ledgers;
    }

    // keccak256(abi.encode(uint256(keccak256("merces.storage.MercesTreasury")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant TREASURY_STORAGE = 0x55269fb38b903ca603af069bcf9205c581abe5be06e8decdce245725db224000;

    function _s() private pure returns (TreasuryStorage storage $) {
        assembly ("memory-safe") {
            $.slot := TREASURY_STORAGE
        }
    }

    function initialize(address owner_, address registry_) external initializer {
        __MercesUpgradeable_init(owner_, registry_);
    }

    // ---------------------------------------------------------------- auction → treasury

    /// @inheritdoc IMercesTreasury
    /// @dev The auction transfers `amount` stablecoin to this contract before calling.
    function depositProceeds(uint256 seriesId, uint64 amount) external override {
        _requireCaller(_contracts().auction);
        Ledger storage l = _s().ledgers[seriesId];
        if (l.finalized) revert ProceedsAlreadyFinalized();
        l.proceedsReceived = (uint256(l.proceedsReceived) + amount).toU64();
        emit ProceedsDeposited(seriesId, amount, l.proceedsReceived);
    }

    /// @inheritdoc IMercesTreasury
    /// @dev Called once every winning bid has been processed; `proceeds == clearingPrice × unitsSold` and equals
    /// the sum of deposits. Releases are blocked until then (the exact tranche sizes need the final total).
    function finalizeProceeds(uint256 seriesId, uint64 proceeds) external override {
        _requireCaller(_contracts().auction);
        Ledger storage l = _s().ledgers[seriesId];
        if (l.finalized) revert ProceedsAlreadyFinalized();
        if (proceeds != l.proceedsReceived) revert InvalidRaiseTransition();
        l.finalized = true;
        l.proceeds = proceeds;
        emit ProceedsFinalized(seriesId, proceeds);
    }

    // ---------------------------------------------------------------- issuer

    /// @inheritdoc IMercesTreasury
    function claimRelease(uint256 seriesId) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        Ledger storage l = _s().ledgers[seriesId];
        _checkReleasable(seriesId, core, l);
        uint64 amount = _claimable(seriesId, core, l);
        if (amount == 0) revert NothingToRelease();
        l.releasedTotal += amount;
        emit ReleaseClaimed(seriesId, amount, l.releasedTotal);
        IERC20(core.stablecoin).safeTransfer(core.issuer, amount);
    }

    /// @inheritdoc IMercesTreasury
    function setReleasePause(uint256 seriesId, bool paused) external override {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        _s().ledgers[seriesId].issuerPausedReleases = paused;
        emit ReleasePauseSet(seriesId, paused);
    }

    /// @inheritdoc IMercesTreasury
    /// @dev Succeeds only if the registry names an approver and that approver returns true (view call). Early
    /// draws count against vesting: `releasedTotal` includes them, so later scheduled releases shrink.
    function requestEarlyDraw(uint256 seriesId, uint64 amount) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        address approver = registry().earlyDrawApprover();
        if (approver == address(0)) revert EarlyDrawsDisabled();
        Ledger storage l = _s().ledgers[seriesId];
        _checkReleasable(seriesId, core, l);
        if (amount == 0 || uint256(l.releasedTotal) + amount > l.proceeds) revert EarlyDrawExceedsProceeds();
        uint64 nonce = l.earlyDrawNonce;
        if (!IEarlyDrawApprover(approver).approveEarlyDraw(seriesId, amount, nonce)) revert EarlyDrawNotApproved();
        l.earlyDrawNonce = nonce + 1;
        l.releasedTotal += amount;
        l.earlyDrawTotal += amount;
        emit EarlyDrawExecuted(seriesId, amount, approver);
        IERC20(core.stablecoin).safeTransfer(core.issuer, amount);
    }

    // ---------------------------------------------------------------- vault (extinguishment)

    /// @inheritdoc IMercesTreasury
    /// @dev On extinguishment (SPEC §6.9) the unreleased balance goes to the vault as a final no-fee
    /// distribution to holders. Nothing more ever vests.
    function moveUnreleasedToVault(uint256 seriesId) external override nonReentrant returns (uint64 unreleased) {
        address vault = _contracts().vault;
        _requireCaller(vault);
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        Ledger storage l = _s().ledgers[seriesId];
        if (core.raiseState != RaiseState.Settled) return 0; // nothing was ever raised
        if (!l.finalized) revert MintNotFinalized();
        unreleased = l.proceeds - l.releasedTotal;
        l.releasedTotal = l.proceeds;
        l.movedToVault = unreleased;
        emit UnreleasedMovedToVault(seriesId, unreleased);
        if (unreleased > 0) IERC20(core.stablecoin).safeTransfer(vault, unreleased);
    }

    // ---------------------------------------------------------------- views

    function getTreasury(uint256 seriesId) external view override returns (Ledger memory) {
        return _s().ledgers[seriesId];
    }

    /// @inheritdoc IMercesTreasury
    /// @dev `tranche_amount(i) = floor(proceeds × bps_i / 10000)` for `i < last`; the last tranche is the
    /// remainder so the tranches sum exactly to `proceeds`.
    function trancheAmount(uint256 seriesId, uint256 index) public view override returns (uint64) {
        Ledger storage l = _s().ledgers[seriesId];
        if (!l.finalized) return 0;
        ReleaseTranche[] memory schedule = registry().getReleaseSchedule(seriesId);
        return _tranche(l.proceeds, schedule, index);
    }

    /// @inheritdoc IMercesTreasury
    function vested(uint256 seriesId, uint256 timestamp) public view override returns (uint64) {
        Ledger storage l = _s().ledgers[seriesId];
        if (!l.finalized) return 0;
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        return _vested(seriesId, core, l, timestamp);
    }

    /// @inheritdoc IMercesTreasury
    function claimable(uint256 seriesId) external view override returns (uint64) {
        Ledger storage l = _s().ledgers[seriesId];
        if (!l.finalized) return 0;
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        return _claimable(seriesId, core, l);
    }

    // ---------------------------------------------------------------- internals

    function _checkReleasable(uint256 seriesId, SeriesCore memory core, Ledger storage l) internal view {
        if (!l.finalized) revert MintNotFinalized();
        if (l.issuerPausedReleases) revert ReleasesPausedByIssuer();
        if (core.terminalStatus == uint8(SeriesStatus.Extinguished)) revert SeriesIsExtinguished();
        if (IMercesIncome(_contracts().income).deriveStatus(seriesId) == SeriesStatus.Late) revert SeriesIsLate();
    }

    /// @dev `amount = min(vested(now), proceeds) − released_total` (early draws are inside released_total).
    function _claimable(uint256 seriesId, SeriesCore memory core, Ledger storage l) internal view returns (uint64) {
        uint64 v = _vested(seriesId, core, l, block.timestamp);
        if (v > l.proceeds) v = l.proceeds;
        return v > l.releasedTotal ? v - l.releasedTotal : 0;
    }

    function _vested(uint256 seriesId, SeriesCore memory core, Ledger storage l, uint256 timestamp)
        internal
        view
        returns (uint64 total)
    {
        ReleaseTranche[] memory schedule = registry().getReleaseSchedule(seriesId);
        uint256 n = schedule.length;
        uint256 acc;
        for (uint256 i = 0; i < n; i++) {
            if (uint256(core.settlementTs) + schedule[i].atOffsetSeconds <= timestamp) {
                acc += _tranche(l.proceeds, schedule, i);
            }
        }
        total = uint64(acc); // ≤ proceeds by construction
    }

    function _tranche(uint64 proceeds, ReleaseTranche[] memory schedule, uint256 index)
        internal
        pure
        returns (uint64)
    {
        uint256 n = schedule.length;
        if (index >= n) return 0;
        if (index < n - 1) return uint64(uint256(proceeds).bpsOf(schedule[index].bps));
        uint256 others;
        for (uint256 i = 0; i + 1 < n; i++) {
            others += uint256(proceeds).bpsOf(schedule[i].bps);
        }
        return uint64(proceeds - others);
    }
}
