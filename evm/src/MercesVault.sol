// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MercesUpgradeable} from "./base/MercesUpgradeable.sol";
import {IMercesVault} from "./interfaces/IMercesVault.sol";
import {IPayoutClaims} from "./interfaces/IPayoutClaims.sol";
import {IMercesIncome} from "./interfaces/IMercesIncome.sol";
import {IMercesTreasury} from "./interfaces/IMercesTreasury.sol";
import {IMercesAuction} from "./interfaces/IMercesAuction.sol";
import {IMercesWindow} from "./interfaces/IMercesWindow.sol";
import {IERC3643Token} from "./interfaces/external/IERC3643Token.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesMessages} from "./libraries/MercesMessages.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {Periods} from "./libraries/Periods.sol";
import {
    PayoutSource,
    ProtocolContracts,
    RaiseState,
    SeriesCore,
    SeriesStatus,
    SeriesTerms
} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesVault
/// @notice Payout vault (D7) and exit path (D8), SPEC v1.1 §6.3 and §6.7–§6.9. Receives gross payments from
/// `MercesIncome`, takes the payout fee, runs the cap accounting of brief C6 against the *effective* cap
/// (`max(cap, paid)`, so a lowered cap never underflows), keeps the reward-per-share accumulators with exact
/// WAD carries, stores `units_outstanding` from mint finalization and weighs every holder by
/// `balance + pending auction units + ask-escrow units`, and implements redemption, the tail clause and
/// extinguishment. The holder-facing claim path is `IPayoutClaims`; the accounting lives in the internal
/// `_receive*` functions so a private-payout implementation can swap the claim surface only. Funds leave the
/// vault only to holders (claims), the issuer (cap refunds) and the fee collector (fees).
contract MercesVault is MercesUpgradeable, IMercesVault {
    using SafeERC20 for IERC20;
    using MercesMath for uint256;

    uint8 internal constant BURN_REASON_RETIRED = uint8(SeriesStatus.Retired);
    uint8 internal constant BURN_REASON_REDEEMED = uint8(SeriesStatus.Redeemed);
    uint8 internal constant BURN_REASON_EXTINGUISHED = uint8(SeriesStatus.Extinguished);

    /// @custom:storage-location erc7201:merces.storage.MercesVault
    struct VaultStorage {
        mapping(uint256 => Ledger) ledgers;
        mapping(uint256 => mapping(address => Holder)) holders;
        mapping(uint256 => YearGross[4]) yearGross;
    }

    // keccak256(abi.encode(uint256(keccak256("merces.storage.MercesVault")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant VAULT_STORAGE = 0x206f20025e245cf38b5d1e9bc8dff6023b1f1abbd130f12632263e1330b41e00;

    function _s() private pure returns (VaultStorage storage $) {
        assembly ("memory-safe") {
            $.slot := VAULT_STORAGE
        }
    }

    function initialize(address owner_, address registry_) external initializer {
        __MercesUpgradeable_init(owner_, registry_);
    }

    // ================================================================ supply (auction → vault)

    /// @inheritdoc IMercesVault
    function initializeSupply(uint256 seriesId, uint64 unitsSold) external override {
        _requireCaller(_contracts().auction);
        Ledger storage l = _s().ledgers[seriesId];
        if (l.supplySet) revert SupplyAlreadySet();
        l.supplySet = true;
        l.unitsOutstanding = unitsSold;
        emit SupplyInitialized(seriesId, unitsSold);
    }

    // ================================================================ accounting (income → vault)

    /// @inheritdoc IMercesVault
    function receiveGross(uint256 seriesId, uint64 amount, PayoutSource source, uint32 period)
        external
        override
        nonReentrant
        returns (uint64 accepted, uint64 fee, uint64 refunded)
    {
        _requireCaller(_contracts().income);
        Ledger storage l = _s().ledgers[seriesId];
        if (!l.supplySet) revert MintNotFinalized();
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        if (source == PayoutSource.Tail) return _receiveTail(seriesId, core, terms, l, amount, period);
        if (source != PayoutSource.Payment && source != PayoutSource.Router) revert InvalidSource();
        return _receiveMain(seriesId, core, terms, l, amount, source, period);
    }

    struct Dist {
        uint64 accepted;
        uint64 fee;
        uint64 refund;
        uint256 deltaAcc;
        bool retired;
    }

    /// @dev SPEC §6.3 `vault_receive_gross`. `period` is the report period for `Payment` (its due date anchors
    /// the `year_gross` slot, outside issuer control) and unused for `Router` (anchored at `now`).
    function _receiveMain(
        uint256 seriesId,
        SeriesCore memory core,
        SeriesTerms memory terms,
        Ledger storage l,
        uint64 gross,
        PayoutSource source,
        uint32 period
    ) internal returns (uint64, uint64, uint64) {
        uint256 n = l.unitsOutstanding;
        if (n == 0) revert NoUnitsOutstanding();
        Dist memory d;
        uint256 incWad = _applyCap(core, terms, l, d, gross, n);
        uint256 anchor =
            source == PayoutSource.Payment ? uint256(Periods.periodEnd(period)) + C.DEADLINE_SECONDS : block.timestamp;
        _addYearGross(seriesId, core, anchor, incWad);
        _accumulate(l, d, n, terms.payoutFeeBps);
        l.refundedToIssuer += d.refund;
        _emitDistributed(seriesId, source, gross, d, l.paidPerUnitWad);
        if (d.retired && core.terminalStatus == 0) _retire(seriesId, l, d.refund);
        IERC20 stable = IERC20(core.stablecoin);
        if (d.fee > 0) stable.safeTransfer(registry().feeCollector(), d.fee);
        if (d.refund > 0) stable.safeTransfer(core.issuer, d.refund);
        return (d.accepted, d.fee, d.refund);
    }

    function _emitDistributed(uint256 seriesId, PayoutSource source, uint64 gross, Dist memory d, uint256 paidWad)
        internal
    {
        emit PayoutDistributed(
            seriesId, source, gross, d.accepted, d.fee, d.accepted - d.fee, d.deltaAcc, paidWad, d.retired
        );
    }

    /// @dev Cap truncation (brief C6) against the effective cap: accepts all of `gross` while
    /// `paid + inc < cap_eff`, otherwise only what fills the cap, refunds the rest and retires the series.
    function _applyCap(
        SeriesCore memory core,
        SeriesTerms memory terms,
        Ledger storage l,
        Dist memory d,
        uint64 gross,
        uint256 n
    ) internal returns (uint256 incWad) {
        uint256 capEff = _capEffWad(core, terms, l);
        incWad = MercesMath.mulDiv(gross, C.WAD, n);
        if (l.paidPerUnitWad + incWad < capEff) {
            d.accepted = gross;
        } else {
            uint256 remainingWad = capEff - l.paidPerUnitWad;
            d.accepted = uint64(MercesMath.mulDiv(remainingWad, n, C.WAD));
            incWad = MercesMath.mulDiv(d.accepted, C.WAD, n);
            d.refund = gross - d.accepted;
            d.retired = true;
        }
        l.paidPerUnitWad += incWad;
    }

    /// @dev Tagged 4-slot `year_gross` ring keyed by `settlement_year(anchor)` (SPEC §6.3).
    function _addYearGross(uint256 seriesId, SeriesCore memory core, uint256 anchor, uint256 incWad) internal {
        uint256 y = anchor > core.settlementTs ? (anchor - core.settlementTs) / C.YEAR : 0;
        YearGross storage g = _s().yearGross[seriesId][y % 4];
        if (!g.set || g.year != y) {
            g.set = true;
            g.year = uint16(y);
            g.grossWad = 0;
        }
        g.grossWad += incWad;
    }

    /// @dev Fee and reward-per-share step with an exact WAD carry: `num = (accepted − fee) × WAD + carry_wad`,
    /// `delta = num / N`, `carry_wad = num − delta × N` (docs/assumptions/track-c.md, reference defect S1).
    function _accumulate(Ledger storage l, Dist memory d, uint256 n, uint16 feeBps) internal {
        d.fee = uint64(uint256(d.accepted).bpsOf(feeBps));
        uint256 num = uint256(d.accepted - d.fee) * C.WAD + l.carryWad;
        d.deltaAcc = num / n;
        l.carryWad = num - d.deltaAcc * n;
        l.netAccWad += d.deltaAcc;
        l.grossReceived += d.accepted;
        l.feeCollected += d.fee;
    }

    /// @dev `retire()` (SPEC §6.3): terminal status, registry mirror, open dues cleared.
    function _retire(uint256 seriesId, Ledger storage l, uint64 refund) internal {
        registry().markTerminal(seriesId, SeriesStatus.Retired);
        IMercesIncome(_contracts().income).clearDues(seriesId);
        emit SeriesRetired(seriesId, l.paidPerUnitWad, refund);
    }

    /// @inheritdoc IMercesVault
    function retireIfCapped(uint256 seriesId) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        Ledger storage l = _s().ledgers[seriesId];
        if (core.raiseState != RaiseState.Settled) revert RaiseNotSettled();
        if (!l.supplySet) revert MintNotFinalized();
        if (core.terminalStatus != 0) revert TerminalStatus();
        if (_capEffWad(core, registry().getSeriesTerms(seriesId), l) != l.paidPerUnitWad) revert NothingDue();
        _retire(seriesId, l, 0);
    }

    /// @dev SPEC §6.8 `vault_receive_tail`: `N = units_at_redemption`, own cap, carry and accumulator, fee applies.
    function _receiveTail(
        uint256 seriesId,
        SeriesCore memory core,
        SeriesTerms memory terms,
        Ledger storage l,
        uint64 gross,
        uint32 period
    ) internal returns (uint64 accepted, uint64 fee, uint64 refund) {
        if (l.redemptionTs == 0) revert NotRedeemed();
        uint256 n = l.unitsAtRedemption;
        if (n == 0) revert NoUnitsOutstanding();
        uint256 capWad = uint256(l.tailCapPerUnit) * C.WAD;
        uint256 incWad = MercesMath.mulDiv(gross, C.WAD, n);
        if (l.tailPaidPerUnitWad + incWad < capWad) {
            accepted = gross;
        } else {
            uint256 remainingWad = capWad > l.tailPaidPerUnitWad ? capWad - l.tailPaidPerUnitWad : 0;
            accepted = uint64(MercesMath.mulDiv(remainingWad, n, C.WAD));
            incWad = MercesMath.mulDiv(accepted, C.WAD, n);
            refund = gross - accepted;
            l.tailExhausted = true;
        }
        l.tailPaidPerUnitWad += incWad;
        fee = uint64(uint256(accepted).bpsOf(terms.payoutFeeBps));
        uint256 num = uint256(accepted - fee) * C.WAD + l.tailCarryWad;
        uint256 delta = num / n;
        l.tailCarryWad = num - delta * n;
        l.tailAccWad += delta;
        l.grossReceived += accepted;
        l.feeCollected += fee;
        l.refundedToIssuer += refund;
        emit TailDistributed(seriesId, period, gross, accepted, fee, refund);
        IERC20 stable = IERC20(core.stablecoin);
        if (fee > 0) stable.safeTransfer(registry().feeCollector(), fee);
        if (refund > 0) stable.safeTransfer(core.issuer, refund);
    }

    // ================================================================ holders (IPayoutClaims)

    /// @inheritdoc IPayoutClaims
    /// @dev Anyone may register a wallet that is allowlisted now; the auction (winners at `processBid`) and the
    /// window (buyers at fill) register without the live check because validity was fixed at reveal / fill and
    /// their calls must never depend on the recipient. Idempotent.
    function registerHolder(uint256 seriesId, address wallet) external override {
        ProtocolContracts memory pc = _contracts();
        if (msg.sender != pc.auction && msg.sender != pc.window && !registry().isAllowed(wallet)) {
            revert NotAllowlisted(wallet);
        }
        Holder storage h = _s().holders[seriesId][wallet];
        if (h.registered) return;
        Ledger storage l = _s().ledgers[seriesId];
        h.registered = true;
        h.lastNetAccWad = l.netAccWad;
        h.lastTailAccWad = l.tailAccWad;
        h.lastFinalAccWad = l.finalAccWad;
        emit HolderRegistered(seriesId, wallet);
    }

    /// @inheritdoc IPayoutClaims
    /// @dev Must run before any change of `wallet`'s accrual units (fills, returns, burns); keepers may call it.
    function settleHolder(uint256 seriesId, address wallet) external override {
        _settle(seriesId, registry().getSeriesCore(seriesId), wallet);
    }

    function _settle(uint256 seriesId, SeriesCore memory core, address wallet) internal returns (Holder storage h) {
        h = _s().holders[seriesId][wallet];
        if (!h.registered) revert HolderNotRegistered(wallet);
        Ledger storage l = _s().ledgers[seriesId];
        uint256 acc = l.netAccWad;
        if (acc != h.lastNetAccWad) {
            uint256 units = _accrualUnits(seriesId, core, wallet);
            h.pending = (uint256(h.pending) + MercesMath.mulDiv(acc - h.lastNetAccWad, units, C.WAD)).toU64();
            h.lastNetAccWad = acc;
        }
    }

    /// @dev `accrual_units(w) = unit_balance(w) + pending auction units + ask-escrow units` (SPEC §6.1).
    function _accrualUnits(uint256 seriesId, SeriesCore memory core, address wallet) internal view returns (uint256) {
        if (core.unitToken == address(0)) return 0;
        ProtocolContracts memory pc = _contracts();
        return IERC3643Token(core.unitToken).balanceOf(wallet)
            + IMercesAuction(pc.auction).pendingUnitsOf(seriesId, wallet)
            + IMercesWindow(pc.window).askEscrowUnits(seriesId, wallet);
    }

    /// @inheritdoc IPayoutClaims
    function claim(uint256 seriesId) external override nonReentrant {
        _claim(seriesId, msg.sender);
    }

    /// @inheritdoc IPayoutClaims
    function claimFor(uint256 seriesId, address holder) external override nonReentrant {
        _claim(seriesId, holder);
    }

    /// @dev SPEC §6.3 `claim`: pays `pending`; on a Retired series also burns the holder's whole balance. A claim
    /// with nothing due succeeds as a no-op and emits zeros (SPEC §1.1).
    function _claim(uint256 seriesId, address holder) internal {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        Holder storage h = _settle(seriesId, core, holder);
        Ledger storage l = _s().ledgers[seriesId];
        uint64 amount = h.pending;
        h.pending = 0;
        uint64 burned;
        if (core.terminalStatus == uint8(SeriesStatus.Retired)) {
            burned = uint64(IERC3643Token(core.unitToken).balanceOf(holder));
        }
        l.claimedTotal += amount;
        emit PayoutClaimed(seriesId, holder, amount, burned);
        if (burned > 0) _burnUnits(seriesId, l, core, holder, burned, BURN_REASON_RETIRED);
        if (amount > 0) IERC20(core.stablecoin).safeTransfer(holder, amount);
    }

    /// @inheritdoc IPayoutClaims
    /// @dev Permissionless crank for retired series: settles then burns; `pending` stays claimable. A zero
    /// balance is a no-op (zero-amount rule).
    function burnRetired(uint256 seriesId, address holder) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (core.terminalStatus != uint8(SeriesStatus.Retired)) revert SeriesNotRetired();
        _settle(seriesId, core, holder);
        uint64 units = uint64(IERC3643Token(core.unitToken).balanceOf(holder));
        if (units == 0) return;
        _burnUnits(seriesId, _s().ledgers[seriesId], core, holder, units, BURN_REASON_RETIRED);
    }

    /// @dev Agent burn of `units` from `holder`; `units_outstanding` shrinks accordingly.
    function _burnUnits(
        uint256 seriesId,
        Ledger storage l,
        SeriesCore memory core,
        address holder,
        uint64 units,
        uint8 reason
    ) internal {
        l.unitsOutstanding -= units;
        l.burnedTotal += units;
        emit UnitsBurned(seriesId, holder, units, reason);
        IERC3643Token(core.unitToken).burn(holder, units);
    }

    /// @dev Units still in the auction escrow are pushed to the holder first (SPEC §6.7 `claim_redemption`).
    function _deliverPendingAuctionUnits(uint256 seriesId, address holder) internal {
        IMercesAuction auction = IMercesAuction(_contracts().auction);
        (bool exists, uint256 idx) = auction.bidIndexOf(seriesId, holder);
        if (!exists) return;
        IMercesAuction.Bid memory b = auction.getBid(seriesId, idx);
        if (b.processed && !b.delivered) auction.deliverBid(seriesId, idx);
    }

    // ================================================================ redemption (SPEC §6.7)

    /// @inheritdoc IMercesVault
    /// @dev Issuer only, after the lockup, while current: not Late, nothing due and every ended period reported
    /// (the issuer's own obligations, A15). Never blockable by an admin, holder or attestor.
    function redeem(uint256 seriesId) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        _checkRedeemable(seriesId, core, terms);
        Ledger storage l = _s().ledgers[seriesId];
        uint256 n = l.unitsOutstanding;
        if (n == 0) revert NoUnitsOutstanding();

        Quote memory q = _quote(seriesId, core, terms, l, block.timestamp);
        if (q.capRemaining == 0) {
            _retire(seriesId, l, 0);
            return;
        }
        uint64 deposit = (q.price * n).toU64();
        l.redemptionTs = uint64(block.timestamp);
        l.redemptionPrice = uint64(q.price);
        l.unitsAtRedemption = uint64(n);
        l.tailCapPerUnit = uint64(q.capRemaining - q.price);
        l.redemptionDeposit = deposit;
        registry().markTerminal(seriesId, SeriesStatus.Redeemed);
        emit SeriesRedeemed(
            seriesId, uint64(q.price), _clamp64(q.hurdle), _clamp64(q.dAvg), uint64(q.capRemaining), uint64(n), deposit
        );
        if (deposit > 0) IERC20(core.stablecoin).safeTransferFrom(msg.sender, address(this), deposit);
    }

    function _checkRedeemable(uint256 seriesId, SeriesCore memory core, SeriesTerms memory terms) internal view {
        if (core.raiseState != RaiseState.Settled) revert RaiseNotSettled();
        if (!core.mintFinalized) revert MintNotFinalized();
        if (core.terminalStatus != 0) revert TerminalStatus();
        if (block.timestamp < uint256(core.settlementTs) + terms.lockupSeconds) revert LockupActive();
        ProtocolContracts memory pc = _contracts();
        IMercesIncome income = IMercesIncome(pc.income);
        if (income.deriveStatus(seriesId) == SeriesStatus.Late) revert SeriesLate();
        (uint64 due,) = income.openDue(seriesId);
        if (due != 0) revert PaymentOutstanding();
        if (income.trueupDue(seriesId) != 0) revert TrueUpOutstanding();
        if (income.nextExpectedPeriod(seriesId) < Periods.periodOf(block.timestamp)) revert UnreportedPeriods();
        if (IMercesWindow(pc.window).hasPendingOrders(seriesId)) revert WindowPending();
    }

    struct Quote {
        uint256 price;
        uint256 hurdle;
        uint256 dAvg;
        uint256 capRemaining;
    }

    function _clamp64(uint256 x) internal pure returns (uint64) {
        return uint64(MercesMath.min(x, type(uint64).max));
    }

    /// @dev SPEC §6.7 price formula in 256-bit; `hurdle` and `dAvg` may exceed uint64 (they are only compared
    /// against the cap remainder, which fits). `C_rem` saturates at zero.
    function _quote(uint256 seriesId, SeriesCore memory core, SeriesTerms memory terms, Ledger storage l, uint256 ts)
        internal
        view
        returns (Quote memory q)
    {
        uint256 t = ts - core.settlementTs;
        uint256 fullYears = t / C.YEAR;
        q.hurdle = _hurdle(core.clearingPrice, terms.hurdleRateWad, t, fullYears);

        uint256 paidUnits = MercesMath.ceilWad(l.paidPerUnitWad);
        uint256 cap = _capPerUnit(core, terms);
        q.capRemaining = cap > paidUnits ? cap - paidUnits : 0;

        uint256 floorTerm = q.hurdle;
        if (fullYears >= 1) {
            uint256 n = fullYears < 3 ? fullYears : 3;
            uint256 sum;
            for (uint256 y = fullYears - n; y < fullYears; y++) {
                sum += _yearGross(seriesId, y);
            }
            q.dAvg = sum / (n * C.WAD);
            uint256 kd = uint256(terms.payoutMultipleK) * q.dAvg;
            if (kd > floorTerm) floorTerm = kd;
        }
        q.price = q.capRemaining < floorTerm ? q.capRemaining : floorTerm;
    }

    /// @dev Reads the tagged ring slot of settlement year `y` (a missing or re-tagged slot reads as 0).
    function _yearGross(uint256 seriesId, uint256 y) internal view returns (uint256) {
        YearGross storage g = _s().yearGross[seriesId][y % 4];
        return (g.set && g.year == y) ? g.grossWad : 0;
    }

    /// @dev `P_hurdle = P0 × (1 + h)^floor(t) × (1 + h × frac(t))`, floor at every WAD multiplication.
    function _hurdle(uint256 p0, uint256 h, uint256 t, uint256 fullYears) internal pure returns (uint256 hurdle) {
        uint256 fracWad = MercesMath.mulDiv(t - fullYears * C.YEAR, C.WAD, C.YEAR);
        hurdle = p0;
        for (uint256 i = 0; i < fullYears; i++) {
            hurdle = MercesMath.mulDiv(hurdle, C.WAD + h, C.WAD);
        }
        hurdle = MercesMath.mulDiv(hurdle, C.WAD + MercesMath.mulDiv(h, fracWad, C.WAD), C.WAD);
    }

    /// @inheritdoc IPayoutClaims
    function claimRedemption(uint256 seriesId) external override nonReentrant {
        _claimRedemption(seriesId, msg.sender);
    }

    /// @inheritdoc IPayoutClaims
    function claimRedemptionFor(uint256 seriesId, address holder) external override nonReentrant {
        _claimRedemption(seriesId, holder);
    }

    /// @dev SPEC §6.7 `claim_redemption`: pending payouts + `P_redeem × units`; pending auction units are
    /// delivered first; units burn; `redeemed_units` is recorded once for the tail clause. Available in
    /// `Redeemed` and `Extinguished`.
    function _claimRedemption(uint256 seriesId, address holder) internal {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        Ledger storage l = _s().ledgers[seriesId];
        if (l.redemptionTs == 0) revert NotRedeemed();
        Holder storage h = _settle(seriesId, core, holder);
        _deliverPendingAuctionUnits(seriesId, holder);
        (uint64 units, uint64 redemption) = _settleRedemption(l, core, h, holder);
        uint64 amount = (uint256(h.pending) + redemption).toU64();
        h.pending = 0;
        l.claimedTotal += amount;
        emit RedemptionClaimed(seriesId, holder, units, amount);
        if (units > 0) _burnUnits(seriesId, l, core, holder, units, BURN_REASON_REDEEMED);
        if (amount > 0) IERC20(core.stablecoin).safeTransfer(holder, amount);
    }

    /// @dev Records `redeemed_units = balance` once and returns the redemption proceeds for the units burnt now.
    function _settleRedemption(Ledger storage l, SeriesCore memory core, Holder storage h, address holder)
        internal
        returns (uint64 units, uint64 redemption)
    {
        units = uint64(IERC3643Token(core.unitToken).balanceOf(holder));
        if (!h.redemptionSettled) {
            h.redemptionSettled = true;
            h.redeemedUnits = units;
            redemption = (uint256(l.redemptionPrice) * units).toU64();
        }
    }

    // ================================================================ tail (SPEC §6.8)

    /// @inheritdoc IPayoutClaims
    function claimTail(uint256 seriesId) external override nonReentrant {
        _claimTail(seriesId, msg.sender);
    }

    /// @inheritdoc IPayoutClaims
    function claimTailFor(uint256 seriesId, address holder) external override nonReentrant {
        _claimTail(seriesId, holder);
    }

    /// @dev A holder with units not yet redeemed goes through `claim_redemption` first (SPEC §6.8).
    function _claimTail(uint256 seriesId, address holder) internal {
        Ledger storage l = _s().ledgers[seriesId];
        if (l.redemptionTs == 0) revert NotRedeemed();
        Holder storage h = _s().holders[seriesId][holder];
        if (!h.registered) revert HolderNotRegistered(holder);
        if (!h.redemptionSettled) _claimRedemption(seriesId, holder);
        uint64 amount = MercesMath.mulDiv(l.tailAccWad - h.lastTailAccWad, h.redeemedUnits, C.WAD).toU64();
        h.lastTailAccWad = l.tailAccWad;
        l.claimedTotal += amount;
        emit TailClaimed(seriesId, holder, amount);
        if (amount > 0) IERC20(registry().getSeriesCore(seriesId).stablecoin).safeTransfer(holder, amount);
    }

    // ================================================================ extinguishment (SPEC §6.9)

    /// @inheritdoc IMercesVault
    /// @dev Two distinct active attestors sign the §1.4 message over `extinguish_nonce`. Allowed in every status
    /// except `Extinguished` once the mint is final. Unreleased treasury funds come to the vault as a no-fee
    /// final distribution over `final_units`; every open due is cleared; the tail ends.
    function extinguish(uint256 seriesId, bytes calldata signatureA, bytes calldata signatureB)
        external
        override
        nonReentrant
    {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (core.terminalStatus == uint8(SeriesStatus.Extinguished)) revert TerminalStatus();
        if (core.raiseState != RaiseState.Settled) revert RaiseNotSettled();
        if (!core.mintFinalized) revert MintNotFinalized();
        Ledger storage l = _s().ledgers[seriesId];
        bytes32 digest = MercesMessages.extinguishDigest(registry().domain(), seriesId, l.extinguishNonce);
        address a = ECDSA.recover(digest, signatureA);
        address b = ECDSA.recover(digest, signatureB);
        if (!registry().isAttestor(a)) revert InvalidAttestorSignature(a);
        if (!registry().isAttestor(b)) revert InvalidAttestorSignature(b);
        if (a == b) revert SameAttestor();
        l.extinguishNonce += 1;
        l.extinguishedAt = uint64(block.timestamp);
        l.tailExhausted = true;
        l.finalUnits = l.redemptionTs != 0 ? l.unitsAtRedemption : l.unitsOutstanding;

        ProtocolContracts memory pc = _contracts();
        registry().markTerminal(seriesId, SeriesStatus.Extinguished);
        IMercesIncome(pc.income).clearDues(seriesId);
        uint64 unreleased = IMercesTreasury(pc.treasury).moveUnreleasedToVault(seriesId);
        _distributeFinal(seriesId, l, unreleased);
        emit SeriesExtinguished(seriesId, unreleased, a, b);
    }

    /// @dev `final_acc_wad += floor(unreleased × WAD / final_units)` with an exact carry, no fee (SPEC §6.9).
    function _distributeFinal(uint256 seriesId, Ledger storage l, uint64 unreleased) internal {
        l.unreleasedReceived = unreleased;
        uint256 n = l.finalUnits;
        if (unreleased == 0 || n == 0) return;
        uint256 num = uint256(unreleased) * C.WAD + l.finalCarryWad;
        uint256 delta = num / n;
        l.finalCarryWad = num - delta * n;
        l.finalAccWad += delta;
        emit PayoutDistributed(
            seriesId, PayoutSource.Final, unreleased, unreleased, 0, unreleased, delta, l.paidPerUnitWad, false
        );
    }

    /// @inheritdoc IPayoutClaims
    function claimFinal(uint256 seriesId) external override nonReentrant {
        _claimFinal(seriesId, msg.sender);
    }

    /// @inheritdoc IPayoutClaims
    function claimFinalFor(uint256 seriesId, address holder) external override nonReentrant {
        _claimFinal(seriesId, holder);
    }

    /// @dev SPEC §6.9 `claim_final`: pending payouts + (for a redeemed series) the unclaimed redemption + the
    /// pro-rata share of the unreleased treasury, weighted by `redeemed_units` (redeemed series) or the holder's
    /// units (which are all in the wallet once pending auction units are delivered and no window is pending).
    function _claimFinal(uint256 seriesId, address holder) internal {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        Ledger storage l = _s().ledgers[seriesId];
        if (l.extinguishedAt == 0) revert SeriesNotExtinguished();
        if (IMercesWindow(_contracts().window).hasPendingOrders(seriesId)) revert WindowPending();
        Holder storage h = _settle(seriesId, core, holder);
        _deliverPendingAuctionUnits(seriesId, holder);
        uint256 amount = h.pending;
        h.pending = 0;
        uint64 units;
        uint64 weight;
        if (l.redemptionTs != 0) {
            bool first = !h.redemptionSettled;
            uint64 redemption;
            (units, redemption) = _settleRedemption(l, core, h, holder);
            if (first) emit RedemptionClaimed(seriesId, holder, units, redemption);
            amount += redemption;
            weight = h.redeemedUnits;
        } else {
            units = uint64(IERC3643Token(core.unitToken).balanceOf(holder));
            weight = units;
        }
        amount += MercesMath.mulDiv(l.finalAccWad - h.lastFinalAccWad, weight, C.WAD);
        h.lastFinalAccWad = l.finalAccWad;
        uint64 amount64 = amount.toU64();
        l.claimedTotal += amount64;
        emit FinalClaimed(seriesId, holder, weight, amount64);
        if (units > 0) _burnUnits(seriesId, l, core, holder, units, BURN_REASON_EXTINGUISHED);
        if (amount64 > 0) IERC20(core.stablecoin).safeTransfer(holder, amount64);
    }

    // ================================================================ views

    function getLedger(uint256 seriesId) external view override returns (Ledger memory) {
        return _s().ledgers[seriesId];
    }

    function getHolder(uint256 seriesId, address holder) external view override returns (Holder memory) {
        return _s().holders[seriesId][holder];
    }

    function unitsOutstanding(uint256 seriesId) external view override returns (uint64) {
        return _s().ledgers[seriesId].unitsOutstanding;
    }

    /// @inheritdoc IMercesVault
    function accrualUnits(uint256 seriesId, address wallet) external view override returns (uint256) {
        return _accrualUnits(seriesId, registry().getSeriesCore(seriesId), wallet);
    }

    /// @inheritdoc IMercesVault
    function capPerUnit(uint256 seriesId) external view override returns (uint64) {
        return uint64(_capPerUnit(registry().getSeriesCore(seriesId), registry().getSeriesTerms(seriesId)));
    }

    /// @inheritdoc IMercesVault
    function capEffWad(uint256 seriesId) external view override returns (uint256) {
        return
            _capEffWad(registry().getSeriesCore(seriesId), registry().getSeriesTerms(seriesId), _s().ledgers[seriesId]);
    }

    function yearGrossWad(uint256 seriesId, uint256 year) external view override returns (uint256) {
        return _yearGross(seriesId, year);
    }

    /// @inheritdoc IMercesVault
    function previewRedemption(uint256 seriesId, uint256 timestamp)
        external
        view
        override
        returns (uint64 price, uint64 hurdle, uint64 dAvg, uint64 capRemaining, uint64 deposit)
    {
        Ledger storage l = _s().ledgers[seriesId];
        Quote memory q =
            _quote(seriesId, registry().getSeriesCore(seriesId), registry().getSeriesTerms(seriesId), l, timestamp);
        return (
            uint64(q.price),
            _clamp64(q.hurdle),
            _clamp64(q.dAvg),
            uint64(q.capRemaining),
            (q.price * l.unitsOutstanding).toU64()
        );
    }

    /// @inheritdoc IPayoutClaims
    function pendingOf(uint256 seriesId, address holder) external view override returns (uint256 pending) {
        Holder storage h = _s().holders[seriesId][holder];
        if (!h.registered) return 0;
        Ledger storage l = _s().ledgers[seriesId];
        uint256 units = _accrualUnits(seriesId, registry().getSeriesCore(seriesId), holder);
        return uint256(h.pending) + MercesMath.mulDiv(l.netAccWad - h.lastNetAccWad, units, C.WAD);
    }

    /// @inheritdoc IPayoutClaims
    function claimableTail(uint256 seriesId, address holder) external view override returns (uint256) {
        Holder storage h = _s().holders[seriesId][holder];
        Ledger storage l = _s().ledgers[seriesId];
        uint256 units = h.redemptionSettled
            ? h.redeemedUnits
            : IERC3643Token(registry().getSeriesCore(seriesId).unitToken).balanceOf(holder);
        return MercesMath.mulDiv(l.tailAccWad - h.lastTailAccWad, units, C.WAD);
    }

    /// @inheritdoc IPayoutClaims
    function claimableFinal(uint256 seriesId, address holder) external view override returns (uint256) {
        Holder storage h = _s().holders[seriesId][holder];
        Ledger storage l = _s().ledgers[seriesId];
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        uint256 weight =
            (l.redemptionTs != 0 && h.redemptionSettled) ? h.redeemedUnits : _accrualUnits(seriesId, core, holder);
        return MercesMath.mulDiv(l.finalAccWad - h.lastFinalAccWad, weight, C.WAD);
    }

    /// @dev `cap_per_unit = floor(cap_multiple_wad × P0 / WAD)`, read live from the registry (SPEC §6.1).
    function _capPerUnit(SeriesCore memory core, SeriesTerms memory terms) internal pure returns (uint256) {
        return MercesMath.mulDiv(terms.capMultipleWad, core.clearingPrice, C.WAD);
    }

    /// @dev `cap_eff_wad = max(cap_per_unit × WAD, paid_per_unit_wad)` (SPEC §6.3 effective cap).
    function _capEffWad(SeriesCore memory core, SeriesTerms memory terms, Ledger storage l)
        internal
        view
        returns (uint256)
    {
        uint256 capWad = _capPerUnit(core, terms) * C.WAD;
        return capWad > l.paidPerUnitWad ? capWad : l.paidPerUnitWad;
    }
}
