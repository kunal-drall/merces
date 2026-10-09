// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MercesUpgradeable} from "./base/MercesUpgradeable.sol";
import {IMercesTreasury} from "./interfaces/IMercesTreasury.sol";
import {IMercesIncome} from "./interfaces/IMercesIncome.sol";
import {IEarlyDrawApprover} from "./interfaces/IEarlyDrawApprover.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {RaiseState, ReleaseTranche, SeriesCore, SeriesStatus} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesTreasury
/// @notice Holds each series' auction proceeds and releases them to the issuer on the series' immutable
/// schedule (D4, SPEC v1.1 §5.3). Releases wait for mint finalization and pause only while the series is
/// `Late` — derived status, or the underlying clock while a hardship pause is in force — or at the issuer's own
/// request (brief C11 §1). Retired and Redeemed series keep releasing; after extinguishment only what had vested
/// by `extinguished_at` remains claimable by the issuer's wallet (the estate). The early-draw hook is off until
/// the registry names an approver. No admin path moves funds: the only outflows are `claimRelease` /
/// `requestEarlyDraw` (to the issuer) and `moveUnreleasedToVault` (to the vault on extinguishment, for holders).
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
    function setProceeds(uint256 seriesId, uint64 proceeds) external override {
        _requireCaller(_contracts().auction);
        Ledger storage l = _s().ledgers[seriesId];
        if (l.proceedsSet) revert ProceedsAlreadySet();
        l.proceedsSet = true;
        l.proceeds = proceeds;
        emit ProceedsSet(seriesId, proceeds);
    }

    /// @inheritdoc IMercesTreasury
    function depositProceeds(uint256 seriesId, uint64 amount) external override {
        _requireCaller(_contracts().auction);
        Ledger storage l = _s().ledgers[seriesId];
        if (!l.proceedsSet) revert ProceedsMismatch();
        uint256 deposited = uint256(l.deposited) + amount;
        if (deposited > l.proceeds) revert ProceedsMismatch();
        l.deposited = uint64(deposited);
        emit ProceedsDeposited(seriesId, amount, l.deposited);
    }

    /// @inheritdoc IMercesTreasury
    function confirmDeposits(uint256 seriesId) external view override {
        _requireCaller(_contracts().auction);
        Ledger storage l = _s().ledgers[seriesId];
        if (!l.proceedsSet || l.deposited != l.proceeds) revert ProceedsMismatch();
    }

    // ---------------------------------------------------------------- issuer

    /// @inheritdoc IMercesTreasury
    /// @dev Checks in the SPEC §5.3 order: issuer, settled raise, mint finalized, the issuer's own release pause,
    /// then Late (derived status or the underlying clock), then something vested.
    function claimRelease(uint256 seriesId) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        Ledger storage l = _s().ledgers[seriesId];
        _checkMintFinal(core);
        if (l.issuerPausedReleases) revert ReleasesPaused();
        _checkNotLate(seriesId);
        uint64 amount = _claimable(seriesId, core, l);
        if (amount == 0) revert NothingVested();
        l.releasedTotal += amount;
        emit ReleaseClaimed(seriesId, amount, l.releasedTotal);
        IERC20(core.stablecoin).safeTransfer(core.issuer, amount);
        IMercesIncome(_contracts().income).crankStatus(seriesId); // sync_status (SPEC §1.7: every write path)
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
    /// draws count against vesting: `releasedTotal` includes them, so later scheduled releases shrink. They are
    /// subject to the same Late block as scheduled releases and end with extinguishment.
    function requestEarlyDraw(uint256 seriesId, uint256 amountRequested) external override nonReentrant {
        uint64 amount = amountRequested.toU64();
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        _checkMintFinal(core);
        address approver = registry().earlyDrawApprover();
        if (approver == address(0)) revert EarlyDrawDisabled();
        Ledger storage l = _s().ledgers[seriesId];
        if (l.extinguishedAt != 0) revert TerminalStatus();
        if (l.issuerPausedReleases) revert ReleasesPaused();
        _checkNotLate(seriesId);
        if (amount == 0) revert ZeroAmount();
        if (uint256(l.releasedTotal) + amount > l.proceeds) revert ExceedsProceeds();
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
    /// @dev SPEC §6.9: `unreleased = proceeds − vested(now)` goes to the vault as a no-fee final distribution.
    /// Early draws may have released more than has vested, so the amount is capped by the remaining balance
    /// (docs/assumptions/track-c.md). Vested-but-unclaimed tranches stay claimable by the issuer's wallet.
    function moveUnreleasedToVault(uint256 seriesId) external override nonReentrant returns (uint64 unreleased) {
        address vault = _contracts().vault;
        _requireCaller(vault);
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        Ledger storage l = _s().ledgers[seriesId];
        if (l.extinguishedAt != 0) revert TerminalStatus();
        l.extinguishedAt = uint64(block.timestamp);
        if (core.raiseState != RaiseState.Settled || !l.proceedsSet) return 0;
        uint64 v = _vested(seriesId, core, l, block.timestamp);
        uint64 remaining = l.proceeds - l.releasedTotal;
        unreleased = l.proceeds - v;
        if (unreleased > remaining) unreleased = remaining;
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
        if (!l.proceedsSet) return 0;
        return _tranche(l.proceeds, registry().getReleaseSchedule(seriesId), index);
    }

    /// @inheritdoc IMercesTreasury
    function vested(uint256 seriesId, uint256 timestamp) public view override returns (uint64) {
        Ledger storage l = _s().ledgers[seriesId];
        if (!l.proceedsSet) return 0;
        return _vested(seriesId, registry().getSeriesCore(seriesId), l, timestamp);
    }

    /// @inheritdoc IMercesTreasury
    function claimable(uint256 seriesId) external view override returns (uint64) {
        Ledger storage l = _s().ledgers[seriesId];
        if (!l.proceedsSet) return 0;
        return _claimable(seriesId, registry().getSeriesCore(seriesId), l);
    }

    // ---------------------------------------------------------------- internals

    /// @dev A settled raise whose mint is final (SPEC §6.1 gate).
    function _checkMintFinal(SeriesCore memory core) internal pure {
        if (core.raiseState != RaiseState.Settled) revert RaiseNotSettled();
        if (!core.mintFinalized) revert MintNotFinalized();
    }

    /// @dev Not `Late` by derived status and not late on the underlying clock (a hardship pause does not lift a
    /// release block already in force, SPEC §5.3 / §6.4).
    function _checkNotLate(uint256 seriesId) internal view {
        IMercesIncome income = IMercesIncome(_contracts().income);
        if (income.deriveStatus(seriesId) == SeriesStatus.Late || income.isLateUnderlying(seriesId)) {
            revert SeriesLate();
        }
    }

    /// @dev `cap = extinguished_at == 0 ? vested(now) : vested(extinguished_at)`; `amount = max(0, cap − released)`.
    function _claimable(uint256 seriesId, SeriesCore memory core, Ledger storage l) internal view returns (uint64) {
        uint256 at = l.extinguishedAt == 0 ? block.timestamp : l.extinguishedAt;
        uint64 cap = _vested(seriesId, core, l, at);
        return cap > l.releasedTotal ? cap - l.releasedTotal : 0;
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

    function _tranche(uint64 proceeds, ReleaseTranche[] memory schedule, uint256 index) internal pure returns (uint64) {
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
