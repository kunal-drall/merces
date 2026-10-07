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
import {IERC3643Token} from "./interfaces/external/IERC3643Token.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesMessages} from "./libraries/MercesMessages.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {PayoutSource, ProtocolContracts, RaiseState, SeriesCore, SeriesStatus, SeriesTerms} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesVault
/// @notice Payout vault (D7) and exit path (D8): receives gross payments from `MercesIncome`, takes the payout
/// fee, runs the cap accounting of brief C6 (truncation, refund to the issuer, retirement), keeps the
/// reward-per-share accumulators, and implements redemption, the tail clause and extinguishment
/// (SPEC §6.3, §6.7–§6.9). The holder-facing claim path is `IPayoutClaims`; the accounting lives in the
/// internal `_receive*` functions so a private-payout implementation can swap the claim surface only.
/// Funds leave the vault only to holders (claims), the issuer (cap refunds) and the fee collector (fees).
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
        mapping(uint256 => mapping(uint256 => uint256)) yearGrossWad;
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

    // ================================================================ accounting (income → vault)

    /// @inheritdoc IMercesVault
    function receiveGross(uint256 seriesId, uint64 amount, PayoutSource source, uint32 period)
        external
        override
        nonReentrant
        returns (uint64 accepted, uint64 fee, uint64 refunded)
    {
        _requireCaller(_contracts().income);
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        if (source == PayoutSource.Payment || source == PayoutSource.Router) {
            (accepted, fee, refunded) = _receiveMain(seriesId, core, terms, amount, source);
        } else if (source == PayoutSource.Tail) {
            (accepted, fee, refunded) = _receiveTail(seriesId, core, terms, amount, period);
        } else {
            revert InvalidSource();
        }
    }

    /// @dev SPEC §6.3 `vault_receive_gross`. Cap check uses the series' *current* cap multiple (it may have
    /// been lowered by an amendment), so `cap_per_unit` is recomputed from the registry each time.
    function _receiveMain(
        uint256 seriesId,
        SeriesCore memory core,
        SeriesTerms memory terms,
        uint64 gross,
        PayoutSource source
    ) internal returns (uint64 accepted, uint64 fee, uint64 refund) {
        Ledger storage l = _s().ledgers[seriesId];
        uint256 n = IERC3643Token(core.unitToken).totalSupply();
        if (n == 0) revert NoUnitsOutstanding();
        DistributionCtx memory ctx = DistributionCtx({seriesId: seriesId, source: source, gross: gross, retired: false});
        (accepted, refund, ctx.retired) = _applyCap(seriesId, core, terms, l, gross, n);
        fee = _accumulate(ctx, l, n, accepted, terms.payoutFeeBps);
        l.refundedToIssuer += refund;
        if (ctx.retired) {
            registry().markTerminal(seriesId, SeriesStatus.Retired);
            emit SeriesRetired(seriesId, l.paidPerUnitWad, refund);
        }
        IERC20 stable = IERC20(core.stablecoin);
        if (fee > 0) stable.safeTransfer(registry().feeCollector(), fee);
        if (refund > 0) stable.safeTransfer(core.issuer, refund);
    }

    /// @dev Cap truncation (brief C6): accepts all of `gross` while `paid + inc < cap`, otherwise only what
    /// fills the cap and retires the series. Updates `paid_per_unit_wad` and the settlement-year gross.
    function _applyCap(
        uint256 seriesId,
        SeriesCore memory core,
        SeriesTerms memory terms,
        Ledger storage l,
        uint64 gross,
        uint256 n
    ) internal returns (uint64 accepted, uint64 refund, bool retired) {
        uint256 capWad = _capPerUnit(core, terms) * C.WAD;
        uint256 incWad = MercesMath.mulDiv(gross, C.WAD, n);
        if (l.paidPerUnitWad + incWad < capWad) {
            accepted = gross;
        } else {
            uint256 remainingWad = capWad > l.paidPerUnitWad ? capWad - l.paidPerUnitWad : 0;
            accepted = uint64(MercesMath.mulDiv(remainingWad, n, C.WAD));
            incWad = MercesMath.mulDiv(accepted, C.WAD, n);
            refund = gross - accepted;
            retired = true;
        }
        l.paidPerUnitWad += incWad;
        _s().yearGrossWad[seriesId][(block.timestamp - core.settlementTs) / C.YEAR] += incWad;
    }

    /// @dev Fee, carry and reward-per-share step (SPEC §6.3): `net = accepted − fee + carry`,
    /// `delta = floor(net × WAD / N)`, `carry = net − floor(delta × N / WAD)`.
    struct DistributionCtx {
        uint256 seriesId;
        PayoutSource source;
        uint64 gross;
        bool retired;
    }

    function _accumulate(DistributionCtx memory ctx, Ledger storage l, uint256 n, uint64 accepted, uint16 feeBps)
        internal
        returns (uint64 fee)
    {
        fee = uint64(uint256(accepted).bpsOf(feeBps));
        uint256 net = uint256(accepted) - fee + l.carry;
        uint64 netAdded = uint64(net - l.carry);
        uint256 deltaAcc = MercesMath.mulDiv(net, C.WAD, n);
        l.carry = uint64(net - MercesMath.mulDiv(deltaAcc, n, C.WAD));
        l.netAccWad += deltaAcc;
        l.grossReceived += accepted;
        l.feeCollected += fee;
        _emitDistributed(ctx, accepted, fee, netAdded, deltaAcc, l.paidPerUnitWad);
    }

    function _emitDistributed(
        DistributionCtx memory ctx,
        uint64 accepted,
        uint64 fee,
        uint64 netAdded,
        uint256 deltaAcc,
        uint256 paidPerUnitWad
    ) internal {
        emit PayoutDistributed(
            ctx.seriesId, ctx.source, ctx.gross, accepted, fee, netAdded, deltaAcc, paidPerUnitWad, ctx.retired
        );
    }

    /// @dev SPEC §6.8 `vault_receive_tail`: `N = units_at_redemption`, own cap and accumulator, fee applies.
    function _receiveTail(
        uint256 seriesId,
        SeriesCore memory core,
        SeriesTerms memory terms,
        uint64 gross,
        uint32 period
    ) internal returns (uint64 accepted, uint64 fee, uint64 refund) {
        Ledger storage l = _s().ledgers[seriesId];
        uint256 n = l.unitsAtRedemption;
        if (n == 0) revert NoUnitsOutstanding();
        uint256 capWad = uint256(l.tailCapPerUnit) * C.WAD;
        uint256 incWad = MercesMath.mulDiv(gross, C.WAD, n);
        if (l.tailPaidPerUnitWad + incWad > capWad) {
            uint256 remainingWad = capWad > l.tailPaidPerUnitWad ? capWad - l.tailPaidPerUnitWad : 0;
            accepted = uint64(MercesMath.mulDiv(remainingWad, n, C.WAD));
            incWad = MercesMath.mulDiv(accepted, C.WAD, n);
            refund = gross - accepted;
        } else {
            accepted = gross;
        }
        l.tailPaidPerUnitWad += incWad;
        fee = uint64(uint256(accepted).bpsOf(terms.payoutFeeBps));
        uint256 net = uint256(accepted) - fee + l.tailCarry;
        uint256 deltaAcc = MercesMath.mulDiv(net, C.WAD, n);
        uint256 distributed = MercesMath.mulDiv(deltaAcc, n, C.WAD);
        l.tailCarry = uint64(net - distributed);
        l.tailAccWad += deltaAcc;
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
    /// @dev Anyone may register a wallet that is allowlisted now. The snapshot excludes distributions made
    /// before the wallet held units. Idempotent.
    function registerHolder(uint256 seriesId, address wallet) external override {
        if (!registry().isAllowed(wallet)) revert WalletNotAllowlisted(wallet);
        _register(seriesId, wallet);
    }

    function _register(uint256 seriesId, address wallet) internal {
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
    /// @dev Must run before any balance change of `wallet` (window fills, burns); keepers may call it freely.
    function settleHolder(uint256 seriesId, address wallet) external override {
        _settle(seriesId, registry().getSeriesCore(seriesId), wallet);
    }

    function _settle(uint256 seriesId, SeriesCore memory core, address wallet) internal returns (Holder storage h) {
        h = _s().holders[seriesId][wallet];
        if (!h.registered) revert HolderNotRegistered(wallet);
        Ledger storage l = _s().ledgers[seriesId];
        uint256 acc = l.netAccWad;
        if (acc != h.lastNetAccWad) {
            uint256 bal = IERC3643Token(core.unitToken).balanceOf(wallet);
            h.pending += uint64(MercesMath.mulDiv(acc - h.lastNetAccWad, bal, C.WAD));
            h.lastNetAccWad = acc;
        }
    }

    /// @inheritdoc IPayoutClaims
    function claim(uint256 seriesId) external override nonReentrant {
        _claim(seriesId, msg.sender);
    }

    /// @inheritdoc IPayoutClaims
    function claimFor(uint256 seriesId, address holder) external override nonReentrant {
        _claim(seriesId, holder);
    }

    /// @dev SPEC §6.3 `claim`: pays `pending`; on a Retired series also burns the holder's whole balance.
    /// Claims never require the holder to be *currently* allowlisted (brief C10: no stranding).
    function _claim(uint256 seriesId, address holder) internal {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        Holder storage h = _settle(seriesId, core, holder);
        uint64 amount = h.pending;
        h.pending = 0;
        uint64 burned;
        if (core.terminalStatus == uint8(SeriesStatus.Retired)) {
            burned = _burnAll(seriesId, core, holder, BURN_REASON_RETIRED);
        }
        if (amount == 0 && burned == 0) revert NothingToClaim();
        _s().ledgers[seriesId].claimedTotal += amount;
        emit PayoutClaimed(seriesId, holder, amount, burned);
        if (amount > 0) IERC20(core.stablecoin).safeTransfer(holder, amount);
    }

    /// @inheritdoc IPayoutClaims
    /// @dev Permissionless crank for retired series: settles then burns; `pending` stays claimable.
    function burnRetired(uint256 seriesId, address holder) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (core.terminalStatus != uint8(SeriesStatus.Retired)) revert SeriesNotRetired();
        _settle(seriesId, core, holder);
        uint64 burned = _burnAll(seriesId, core, holder, BURN_REASON_RETIRED);
        if (burned == 0) revert ZeroUnits();
    }

    function _burnAll(uint256 seriesId, SeriesCore memory core, address holder, uint8 reason)
        internal
        returns (uint64 units)
    {
        IERC3643Token token = IERC3643Token(core.unitToken);
        uint256 bal = token.balanceOf(holder);
        if (bal == 0) return 0;
        units = uint64(bal);
        _s().ledgers[seriesId].burnedTotal += units;
        emit UnitsBurned(seriesId, holder, units, reason);
        token.burn(holder, bal);
    }

    // ================================================================ redemption (SPEC §6.7)

    /// @inheritdoc IMercesVault
    /// @dev Issuer only, after the lockup, while current (no open due or true-up due: the issuer's own
    /// obligations, A15). Never blockable by an admin, holder or attestor.
    function redeem(uint256 seriesId) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        if (core.terminalStatus != 0) revert SeriesTerminal();
        if (core.raiseState != RaiseState.Settled) revert NotSettled();
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        if (block.timestamp < uint256(core.settlementTs) + terms.lockupSeconds) revert LockupActive();
        IMercesIncome income = IMercesIncome(_contracts().income);
        (uint64 due,) = income.openDue(seriesId);
        if (due != 0 || income.trueupDue(seriesId) != 0) revert OutstandingDue();
        uint256 n = IERC3643Token(core.unitToken).totalSupply();
        if (n == 0) revert NoUnitsOutstanding();

        Quote memory q = _quote(seriesId, block.timestamp);
        uint64 deposit = (q.price * n).toU64();
        Ledger storage l = _s().ledgers[seriesId];
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
    /// against the cap remainder, which fits).
    function _quote(uint256 seriesId, uint256 timestamp) internal view returns (Quote memory q) {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        Ledger storage l = _s().ledgers[seriesId];
        uint256 t = timestamp - core.settlementTs;
        uint256 fullYears = t / C.YEAR;
        q.hurdle = _hurdle(core.clearingPrice, terms.hurdleRateWad, t, fullYears);

        uint256 paidUnits = MercesMath.ceilWad(l.paidPerUnitWad);
        uint256 cap = _capPerUnit(core, terms);
        q.capRemaining = cap > paidUnits ? cap - paidUnits : 0;

        uint256 floorTerm = q.hurdle;
        if (fullYears >= 1) {
            uint256 n = fullYears < 3 ? fullYears : 3;
            uint256 sum;
            mapping(uint256 => uint256) storage yg = _s().yearGrossWad[seriesId];
            for (uint256 y = fullYears - n; y < fullYears; y++) {
                sum += yg[y];
            }
            q.dAvg = sum / (n * C.WAD);
            uint256 kd = uint256(terms.payoutMultipleK) * q.dAvg;
            if (kd > floorTerm) floorTerm = kd;
        }
        q.price = q.capRemaining < floorTerm ? q.capRemaining : floorTerm;
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

    /// @dev SPEC §6.7 `claim_redemption`: pending payouts + `P_redeem × units`; units burn; `redeemed_units`
    /// is recorded once for the tail clause.
    function _claimRedemption(uint256 seriesId, address holder) internal {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (core.terminalStatus != uint8(SeriesStatus.Redeemed)) revert SeriesNotRedeemed();
        Holder storage h = _settle(seriesId, core, holder);
        (uint64 units, uint64 redemption) = _settleRedemption(seriesId, core, h, holder);
        uint64 amount = h.pending + redemption;
        h.pending = 0;
        if (units == 0 && amount == 0) revert NothingToClaim();
        _s().ledgers[seriesId].claimedTotal += amount;
        emit RedemptionClaimed(seriesId, holder, units, amount);
        if (units > 0) _burnAll(seriesId, core, holder, BURN_REASON_REDEEMED);
        if (amount > 0) IERC20(core.stablecoin).safeTransfer(holder, amount);
    }

    /// @dev Records `redeemed_units = balance` once and returns the redemption proceeds for the units burnt now.
    function _settleRedemption(uint256 seriesId, SeriesCore memory core, Holder storage h, address holder)
        internal
        returns (uint64 units, uint64 redemption)
    {
        units = uint64(IERC3643Token(core.unitToken).balanceOf(holder));
        if (!h.redemptionSettled) {
            h.redemptionSettled = true;
            h.redeemedUnits = units;
            redemption = uint64(uint256(_s().ledgers[seriesId].redemptionPrice) * units);
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

    function _claimTail(uint256 seriesId, address holder) internal {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        Holder storage h = _s().holders[seriesId][holder];
        if (!h.registered) revert HolderNotRegistered(holder);
        Ledger storage l = _s().ledgers[seriesId];
        uint64 amount = uint64(MercesMath.mulDiv(l.tailAccWad - h.lastTailAccWad, h.redeemedUnits, C.WAD));
        h.lastTailAccWad = l.tailAccWad;
        if (amount == 0) revert NothingToClaim();
        l.claimedTotal += amount;
        emit TailClaimed(seriesId, holder, amount);
        IERC20(core.stablecoin).safeTransfer(holder, amount);
    }

    // ================================================================ extinguishment (SPEC §6.9)

    /// @inheritdoc IMercesVault
    /// @dev Two distinct active attestors sign the §1.4 message over `extinguish_nonce`. Allowed while the series
    /// is non-terminal or Redeemed within its tail. Unreleased treasury funds come to the vault as a no-fee
    /// final distribution; every open due is cleared.
    function extinguish(uint256 seriesId, bytes calldata signatureA, bytes calldata signatureB)
        external
        override
        nonReentrant
    {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        Ledger storage l = _s().ledgers[seriesId];
        if (core.terminalStatus == uint8(SeriesStatus.Redeemed)) {
            if (block.timestamp > uint256(l.redemptionTs) + C.TAIL_SECONDS) revert TailWindowClosed();
        } else if (core.terminalStatus != 0) {
            revert SeriesTerminal();
        }
        bytes32 digest = MercesMessages.extinguishDigest(registry().domain(), seriesId, l.extinguishNonce);
        address a = ECDSA.recover(digest, signatureA);
        address b = ECDSA.recover(digest, signatureB);
        if (!registry().isAttestor(a)) revert AttestorNotRegistered(a);
        if (!registry().isAttestor(b)) revert AttestorNotRegistered(b);
        if (a == b) revert DuplicateAttestor();
        l.extinguishNonce += 1;

        ProtocolContracts memory pc = _contracts();
        registry().markTerminal(seriesId, SeriesStatus.Extinguished);
        IMercesIncome(pc.income).clearDues(seriesId);
        uint64 unreleased = IMercesTreasury(pc.treasury).moveUnreleasedToVault(seriesId);
        _distributeFinal(seriesId, core, l, unreleased);
        emit SeriesExtinguished(seriesId, unreleased, a, b);
    }

    /// @dev `final_acc_wad += floor(unreleased × WAD / N)` with carry, no fee (SPEC §6.9). `N` is the redeemed
    /// unit count when the series was redeemed, else the outstanding supply.
    function _distributeFinal(uint256 seriesId, SeriesCore memory core, Ledger storage l, uint64 unreleased) internal {
        l.unreleasedReceived = unreleased;
        uint256 n = l.redemptionTs != 0 ? l.unitsAtRedemption : IERC3643Token(core.unitToken).totalSupply();
        if (unreleased == 0 || n == 0) return;
        uint256 net = uint256(unreleased) + l.finalCarry;
        uint256 deltaAcc = MercesMath.mulDiv(net, C.WAD, n);
        uint256 distributed = MercesMath.mulDiv(deltaAcc, n, C.WAD);
        l.finalCarry = uint64(net - distributed);
        l.finalAccWad += deltaAcc;
        emit PayoutDistributed(
            seriesId, PayoutSource.Final, unreleased, unreleased, 0, unreleased, deltaAcc, l.paidPerUnitWad, false
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

    /// @dev SPEC §6.9 `claim_final`: pending payouts + (for a redeemed series) the unclaimed redemption +
    /// the pro-rata share of the unreleased treasury; units burn.
    function _claimFinal(uint256 seriesId, address holder) internal {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (core.terminalStatus != uint8(SeriesStatus.Extinguished)) revert SeriesNotExtinguished();
        Holder storage h = _settle(seriesId, core, holder);
        Ledger storage l = _s().ledgers[seriesId];
        uint64 amount = h.pending;
        h.pending = 0;
        uint64 weight;
        uint64 balance = uint64(IERC3643Token(core.unitToken).balanceOf(holder));
        if (l.redemptionTs != 0) {
            (, uint64 redemption) = _settleRedemption(seriesId, core, h, holder);
            amount += redemption;
            weight = h.redeemedUnits;
        } else {
            weight = balance;
        }
        uint64 finalShare = uint64(MercesMath.mulDiv(l.finalAccWad - h.lastFinalAccWad, weight, C.WAD));
        h.lastFinalAccWad = l.finalAccWad;
        amount += finalShare;
        if (amount == 0 && balance == 0) revert NothingToClaim();
        l.claimedTotal += amount;
        emit FinalClaimed(seriesId, holder, weight, amount);
        if (balance > 0) _burnAll(seriesId, core, holder, BURN_REASON_EXTINGUISHED);
        if (amount > 0) IERC20(core.stablecoin).safeTransfer(holder, amount);
    }

    // ================================================================ views

    function getLedger(uint256 seriesId) external view override returns (Ledger memory) {
        return _s().ledgers[seriesId];
    }

    function getHolder(uint256 seriesId, address holder) external view override returns (Holder memory) {
        return _s().holders[seriesId][holder];
    }

    function unitsOutstanding(uint256 seriesId) external view override returns (uint64) {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (core.unitToken == address(0)) return 0;
        return uint64(IERC3643Token(core.unitToken).totalSupply());
    }

    /// @inheritdoc IMercesVault
    function capPerUnit(uint256 seriesId) external view override returns (uint64) {
        return uint64(_capPerUnit(registry().getSeriesCore(seriesId), registry().getSeriesTerms(seriesId)));
    }

    function yearGrossWad(uint256 seriesId, uint256 year) external view override returns (uint256) {
        return _s().yearGrossWad[seriesId][year];
    }

    function terminalStatus(uint256 seriesId) external view override returns (SeriesStatus status, bool isTerminal) {
        uint8 t = registry().getSeriesCore(seriesId).terminalStatus;
        return (SeriesStatus(t), t != 0);
    }

    /// @inheritdoc IMercesVault
    function previewRedemption(uint256 seriesId, uint256 timestamp)
        external
        view
        override
        returns (uint64 price, uint64 hurdle, uint64 dAvg, uint64 capRemaining, uint64 deposit)
    {
        Quote memory q = _quote(seriesId, timestamp);
        uint256 n = IERC3643Token(registry().getSeriesCore(seriesId).unitToken).totalSupply();
        return (uint64(q.price), _clamp64(q.hurdle), _clamp64(q.dAvg), uint64(q.capRemaining), (q.price * n).toU64());
    }

    /// @inheritdoc IPayoutClaims
    function pendingOf(uint256 seriesId, address holder) external view override returns (uint256 pending) {
        Holder storage h = _s().holders[seriesId][holder];
        if (!h.registered) return 0;
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        Ledger storage l = _s().ledgers[seriesId];
        uint256 bal = IERC3643Token(core.unitToken).balanceOf(holder);
        return uint256(h.pending) + MercesMath.mulDiv(l.netAccWad - h.lastNetAccWad, bal, C.WAD);
    }

    /// @inheritdoc IPayoutClaims
    function claimableTail(uint256 seriesId, address holder) external view override returns (uint256) {
        Holder storage h = _s().holders[seriesId][holder];
        Ledger storage l = _s().ledgers[seriesId];
        return MercesMath.mulDiv(l.tailAccWad - h.lastTailAccWad, h.redeemedUnits, C.WAD);
    }

    /// @inheritdoc IPayoutClaims
    function claimableFinal(uint256 seriesId, address holder) external view override returns (uint256) {
        Holder storage h = _s().holders[seriesId][holder];
        Ledger storage l = _s().ledgers[seriesId];
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        uint256 weight = l.redemptionTs != 0
            ? (h.redemptionSettled ? h.redeemedUnits : IERC3643Token(core.unitToken).balanceOf(holder))
            : IERC3643Token(core.unitToken).balanceOf(holder);
        return MercesMath.mulDiv(l.finalAccWad - h.lastFinalAccWad, weight, C.WAD);
    }

    /// @dev `cap_per_unit = floor(cap_multiple_wad × P0 / WAD)`.
    function _capPerUnit(SeriesCore memory core, SeriesTerms memory terms) internal pure returns (uint256) {
        return MercesMath.mulDiv(terms.capMultipleWad, core.clearingPrice, C.WAD);
    }
}
