// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {MercesUpgradeable} from "./base/MercesUpgradeable.sol";
import {IMercesRouter} from "./interfaces/IMercesRouter.sol";
import {IMercesIncome} from "./interfaces/IMercesIncome.sol";
import {IMercesVault} from "./interfaces/IMercesVault.sol";
import {MercesRouterReceiver} from "./MercesRouterReceiver.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {Periods} from "./libraries/Periods.sol";
import {ProtocolContracts, RaiseState, RouterTerms, SeriesCore, TierFlags} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesRouter
/// @notice Tier-1 split router (D5, SPEC v1.1 §6.5). θ and r are the plaintext tier-1 terms stored in the
/// registry at series creation (public by the issuer's choice, bound to the Poseidon(5) terms commitment).
/// Income routed here before mint finalization waits in the receiving account; afterwards `route` / `sweep`
/// pass income below θ to the issuer and send `r × units_outstanding` of the rest to the payout vault, which
/// credits it against the quarter's proven payment. Period checkpoints (`ytd_at_end`) bind pure tier-1
/// reports. Non-custodial: it holds funds only within a transaction.
contract MercesRouter is MercesUpgradeable, IMercesRouter {
    using SafeERC20 for IERC20;
    using MercesMath for uint256;

    /// @custom:storage-location erc7201:merces.storage.MercesRouter
    struct RouterStorage {
        address income;
        mapping(uint256 => Router) routers;
        mapping(uint256 => mapping(uint32 => Checkpoint)) checkpoints;
    }

    // keccak256(abi.encode(uint256(keccak256("merces.storage.MercesRouter")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ROUTER_STORAGE = 0x8b2a4dd4a9fd50fdc6aebb8a35d4f4ec97cf4b2b7d0e2d3fcd2a2ad05d2ca700;

    function _s() private pure returns (RouterStorage storage $) {
        assembly ("memory-safe") {
            $.slot := ROUTER_STORAGE
        }
    }

    function initialize(address owner_, address registry_, address income_) external initializer {
        __MercesUpgradeable_init(owner_, registry_);
        if (income_ == address(0)) revert ZeroAddress();
        _s().income = income_;
        emit IncomeSet(income_);
    }

    // ---------------------------------------------------------------- receiver

    /// @inheritdoc IMercesRouter
    /// @dev Anyone may deploy the receiving account of a tier-1 series at its deterministic address.
    function createRouterReceiver(uint256 seriesId) external override returns (address receiver) {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (!TierFlags.has(core.tierFlags, 1)) revert RouterNotEnabled();
        return _ensureReceiver(seriesId, _s().routers[seriesId]);
    }

    function _ensureReceiver(uint256 seriesId, Router storage r) internal returns (address receiver) {
        if (r.receiverDeployed) return r.receiver;
        receiver = address(new MercesRouterReceiver{salt: bytes32(seriesId)}(seriesId));
        r.receiverDeployed = true;
        r.receiver = receiver;
        emit RouterReceiverCreated(seriesId, receiver);
    }

    /// @inheritdoc IMercesRouter
    function routerReceiver(uint256 seriesId) public view override returns (address) {
        Router storage r = _s().routers[seriesId];
        if (r.receiverDeployed) return r.receiver;
        bytes32 initHash = keccak256(abi.encodePacked(type(MercesRouterReceiver).creationCode, abi.encode(seriesId)));
        return Create2.computeAddress(bytes32(seriesId), initHash, address(this));
    }

    // ---------------------------------------------------------------- routing (anyone)

    /// @inheritdoc IMercesRouter
    /// @dev Pulls `amount` from the caller. Until the mint of a live raise is final the income waits in the
    /// receiving account (SPEC §6.1 gate, §6.5); afterwards it is split together with anything still held there.
    /// A raise that failed or was cancelled has no holders, so its income passes straight to the issuer.
    function route(uint256 seriesId, uint256 amount) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (!TierFlags.has(core.tierFlags, 1)) revert RouterNotEnabled();
        uint64 value = amount.toU64();
        Router storage r = _s().routers[seriesId];
        IERC20 stable = IERC20(core.stablecoin);
        if (!core.mintFinalized && _raiseLive(core.raiseState)) {
            address receiver = _ensureReceiver(seriesId, r);
            r.heldBeforeFinalization = (uint256(r.heldBeforeFinalization) + value).toU64();
            emit IncomeHeld(seriesId, value, (stable.balanceOf(receiver) + value).toU64());
            if (value > 0) stable.safeTransferFrom(msg.sender, receiver, value);
            return;
        }
        if (value > 0) stable.safeTransferFrom(msg.sender, address(this), value);
        uint64 held = _collectHeld(r, stable);
        _route(seriesId, core, (uint256(value) + held).toU64());
    }

    /// @inheritdoc IMercesRouter
    /// @dev Moves the receiving account's whole balance here and splits it (or passes it to the issuer when the
    /// raise failed or was cancelled).
    function sweep(uint256 seriesId) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (!TierFlags.has(core.tierFlags, 1)) revert RouterNotEnabled();
        if (!core.mintFinalized && _raiseLive(core.raiseState)) revert MintNotFinalized();
        Router storage r = _s().routers[seriesId];
        uint64 held = _collectHeld(r, IERC20(core.stablecoin));
        if (held == 0) revert ZeroAmount();
        _route(seriesId, core, held);
    }

    /// @dev Draft, Open, Settling or Settled: the raise can still (or did) produce holders.
    function _raiseLive(RaiseState state) internal pure returns (bool) {
        return state != RaiseState.Failed && state != RaiseState.Cancelled;
    }

    /// @dev Pulls whatever the receiving account holds into the router (zero when none is deployed).
    function _collectHeld(Router storage r, IERC20 stable) internal returns (uint64 held) {
        if (!r.receiverDeployed) return 0;
        uint256 bal = stable.balanceOf(r.receiver);
        if (bal == 0) return 0;
        held = bal.toU64();
        r.heldBeforeFinalization = 0;
        MercesRouterReceiver(r.receiver).forward(stable, held);
    }

    /// @dev SPEC §6.5: close the periods since the last receipt, reset YTD at a year boundary, pass income below
    /// θ through, route `min(above, mulDiv(above, r × units_outstanding, WAD))` to the vault.
    /// @dev After a terminal status (Retired, Redeemed, Extinguished) or for a failed raise nothing is owed to
    /// holders any more: the whole amount passes through to the issuer.
    function _route(uint256 seriesId, SeriesCore memory core, uint64 amount) internal {
        Router storage r = _s().routers[seriesId];
        ProtocolContracts memory pc = _contracts();
        uint256 units;
        if (core.raiseState == RaiseState.Settled) {
            _advance(seriesId, r, core.settlementTs);
            if (core.terminalStatus == 0) units = IMercesVault(pc.vault).unitsOutstanding(seriesId);
        }
        uint64 share = _split(seriesId, r, amount, units);
        uint64 passThrough = amount - share;
        r.routedTotal += share;
        r.passedThroughTotal += passThrough;

        IERC20 stable = IERC20(core.stablecoin);
        if (passThrough > 0) stable.safeTransfer(core.issuer, passThrough);
        if (share > 0) {
            stable.safeTransfer(pc.vault, share);
            IMercesIncome(_s().income).receiveRouterShare(seriesId, share);
        }
        emit IncomeRouted(seriesId, amount, passThrough, share, r.ytdReceived);
        if (core.raiseState == RaiseState.Settled) IMercesIncome(_s().income).crankStatus(seriesId);
    }

    /// @dev `close_period_if_needed()` plus the YTD year reset, then records the receipt's period.
    function _advance(uint256 seriesId, Router storage r, uint64 settlementTs) internal {
        uint32 pNow = Periods.periodOf(block.timestamp);
        if (!r.hasReceipt || r.lastReceiptPeriod < pNow) {
            _closeThrough(seriesId, r, Periods.periodOf(settlementTs), pNow - 1);
        }
        uint16 year = Periods.yearOf(pNow);
        if (!r.hasReceipt || year != r.ytdYear) {
            r.ytdYear = year;
            r.ytdReceived = 0;
        }
        r.hasReceipt = true;
        r.lastReceiptPeriod = pNow;
    }

    /// @dev θ / r split against the running YTD; `r_wad × units ≤ WAD` is enforced at creation so the product fits.
    function _split(uint256 seriesId, Router storage r, uint64 amount, uint256 units) internal returns (uint64) {
        RouterTerms memory t = registry().getRouterTerms(seriesId);
        uint256 below = t.theta > r.ytdReceived ? t.theta - r.ytdReceived : 0;
        uint256 above = amount - MercesMath.min(amount, below);
        uint256 share = MercesMath.mulDiv(above, uint256(t.rWad) * units, C.WAD);
        if (share > above) share = above;
        r.ytdReceived = (uint256(r.ytdReceived) + amount).toU64();
        return uint64(share);
    }

    /// @inheritdoc IMercesRouter
    /// @dev Records the checkpoint for `period` (and any earlier missing ones) once the period has ended, so a
    /// tier-1 report can be verified even when no receipt arrives in the following period.
    function closeRouterPeriod(uint256 seriesId, uint32 period) external override {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (!TierFlags.has(core.tierFlags, 1)) revert RouterNotEnabled();
        if (core.raiseState != RaiseState.Settled) revert RaiseNotSettled();
        if (period >= Periods.periodOf(block.timestamp)) revert ReportTooEarly();
        _closeThrough(seriesId, _s().routers[seriesId], Periods.periodOf(core.settlementTs), period);
    }

    /// @dev Checkpoints every period in `(last_checkpoint, upTo]` (from the first period when none exists) with
    /// the YTD total as of its end: the running total for periods in the last receipt's year, 0 otherwise.
    /// Invariant: every period before the last receipt's period is checkpointed, so the value is always known.
    function _closeThrough(uint256 seriesId, Router storage r, uint32 firstPeriod, uint32 upTo) internal {
        uint32 q = r.hasCheckpoint ? r.lastCheckpointPeriod + 1 : firstPeriod;
        if (upTo < q) return;
        mapping(uint32 => Checkpoint) storage cps = _s().checkpoints[seriesId];
        for (; q <= upTo; q++) {
            uint64 v = (r.hasReceipt && Periods.yearOf(q) == r.ytdYear) ? r.ytdReceived : 0;
            cps[q] = Checkpoint({set: true, ytdAtEnd: v});
            emit RouterPeriodClosed(seriesId, q, v);
        }
        r.hasCheckpoint = true;
        r.lastCheckpointPeriod = upTo;
    }

    // ---------------------------------------------------------------- views

    function getRouter(uint256 seriesId) external view override returns (Router memory) {
        return _s().routers[seriesId];
    }

    /// @inheritdoc IMercesRouter
    function ytdAtEnd(uint256 seriesId, uint32 period) external view override returns (bool exists, uint64 ytd) {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (core.settlementTs == 0) return (false, 0);
        if (period < Periods.periodOf(core.settlementTs)) return (true, 0);
        Checkpoint storage cp = _s().checkpoints[seriesId][period];
        return (cp.set, cp.ytdAtEnd);
    }

    function income() external view override returns (address) {
        return _s().income;
    }
}
