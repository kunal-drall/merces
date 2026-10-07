// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MercesUpgradeable} from "./base/MercesUpgradeable.sol";
import {IMercesIncome} from "./interfaces/IMercesIncome.sol";
import {IMercesVault} from "./interfaces/IMercesVault.sol";
import {IMercesAuction} from "./interfaces/IMercesAuction.sol";
import {IGroth16Verifier} from "./interfaces/IGroth16Verifier.sol";
import {IMercesFxAccumulator} from "./interfaces/IMercesFxAccumulator.sol";
import {IERC3643Token} from "./interfaces/external/IERC3643Token.sol";
import {MercesRouterReceiver} from "./MercesRouterReceiver.sol";
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
    SeriesTerms,
    TierFlags
} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesIncome
/// @notice ProofOfIncome verifier (D6), status machine with the effective clock (C8), tier-1 split router
/// (D5) and tier-3 true-up; SPEC §6.1–§6.5. The FX rate accumulator (C9, SPEC §6.6) is the separate
/// `MercesFxAccumulator` module, consulted for the quarter average. Reports are the issuer's act;
/// payments may be made by anyone on the issuer's behalf and flow straight into the vault. No function
/// can force a payment and nothing penalises a zero report (brief C11 §3).
contract MercesIncome is MercesUpgradeable, IMercesIncome {
    using SafeERC20 for IERC20;
    using MercesMath for uint256;

    /// @dev `Poseidon(2)(0, 0)` — the prior commitment at the start of every reporting year (SPEC §1.5).
    uint256 public constant ZERO_INCOME_COMMITMENT =
        14744269619966411208579211824598458697587494354926760081771325075741142829156;

    /// @custom:storage-location erc7201:merces.storage.MercesIncome
    struct IncomeStorage {
        address groth16Verifier;
        address fxAccumulator;
        mapping(uint256 => Ledger) ledgers;
        mapping(uint256 => mapping(uint32 => Report)) reports;
        mapping(uint256 => Router) routers;
        mapping(bytes32 => bool) usedTrueUpDigests;
    }

    // keccak256(abi.encode(uint256(keccak256("merces.storage.MercesIncome")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant INCOME_STORAGE = 0x66ead0de223ba92d245f4c0ddf858a641e8e084176e74c7daa2b3858db16d400;

    function _s() private pure returns (IncomeStorage storage $) {
        assembly ("memory-safe") {
            $.slot := INCOME_STORAGE
        }
    }

    function initialize(address owner_, address registry_, address groth16Verifier_, address fxAccumulator_)
        external
        initializer
    {
        __MercesUpgradeable_init(owner_, registry_);
        if (groth16Verifier_ == address(0) || fxAccumulator_ == address(0)) revert ZeroAddress();
        _s().groth16Verifier = groth16Verifier_;
        _s().fxAccumulator = fxAccumulator_;
        emit Groth16VerifierSet(groth16Verifier_);
        emit FxAccumulatorSet(fxAccumulator_);
    }

    /// @notice Money-code configuration, owner (timelock) only: the verifier is tied to the circuit's key.
    function setGroth16Verifier(address verifier) external onlyOwner {
        if (verifier == address(0)) revert ZeroAddress();
        _s().groth16Verifier = verifier;
        emit Groth16VerifierSet(verifier);
    }

    /// @notice The FX rate accumulator module, owner (timelock) only.
    function setFxAccumulator(address fxAccumulator_) external onlyOwner {
        if (fxAccumulator_ == address(0)) revert ZeroAddress();
        _s().fxAccumulator = fxAccumulator_;
        emit FxAccumulatorSet(fxAccumulator_);
    }

    // ================================================================ reports (SPEC §6.2)

    /// @inheritdoc IMercesIncome
    function submitReport(ReportInput calldata input) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(input.seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        Ledger storage l = _s().ledgers[input.seriesId];
        (bool tail, uint64 unitsOutstanding) = _gateReport(input, core, l);
        bool fxFallback = _checkFx(input.seriesId, core, input);
        _verifyProof(input, core, l, unitsOutstanding);
        _checkAttestation(input.seriesId, input);
        _applyReport(input, core, l, tail, fxFallback);
    }

    /// @dev SPEC §6.2 steps 1–3: finalized raise, terminal gating (tail reports), sequence, timing, tier.
    function _gateReport(ReportInput calldata input, SeriesCore memory core, Ledger storage l)
        internal
        view
        returns (bool tail, uint64 unitsOutstanding)
    {
        ProtocolContracts memory pc = _contracts();
        if (!IMercesAuction(pc.auction).mintFinalized(input.seriesId)) revert MintNotFinalized();
        if (core.terminalStatus == uint8(SeriesStatus.Redeemed)) {
            IMercesVault.Ledger memory vl = IMercesVault(pc.vault).getLedger(input.seriesId);
            if (!input.liquidityEvent) revert LiquidityEventRequired();
            if (block.timestamp > uint256(vl.redemptionTs) + C.TAIL_SECONDS) revert TailWindowClosed();
            if (vl.tailCapPerUnit == 0) revert NoTailDue();
            tail = true;
            unitsOutstanding = vl.unitsAtRedemption;
        } else {
            if (core.terminalStatus != 0) revert ReportsClosed();
            unitsOutstanding = uint64(IERC3643Token(core.unitToken).totalSupply());
        }
        uint32 expected = _nextExpected(l, core);
        if (input.period != expected) revert WrongPeriod(expected, input.period);
        if (block.timestamp < Periods.periodEnd(input.period)) revert PeriodNotEnded();
        if (l.openDueAmount > 0) revert PreviousPeriodUnpaid();
        if (!TierFlags.has(core.tierFlags, input.tier)) revert TierNotEnabled(input.tier);
        if (input.tier == 4 && !registry().getFlags().tier4Enabled) revert Tier4Disabled();
    }

    /// @dev SPEC §6.2 steps 5–6: prior commitment and Groth16 verification with the public inputs in order
    /// `[terms_commitment, units_outstanding, fx_avg_wad, prior, income_commitment, payment_usd]`.
    function _verifyProof(ReportInput calldata input, SeriesCore memory core, Ledger storage l, uint64 unitsOutstanding)
        internal
        view
    {
        uint256 prior = ZERO_INCOME_COMMITMENT;
        if (
            l.hasIncomeCommitment && l.lastIncomePeriod + 1 == input.period
                && Periods.yearOf(l.lastIncomePeriod) == Periods.yearOf(input.period)
        ) {
            prior = uint256(l.lastIncomeCommitment);
        }
        uint256[6] memory pub = [
            uint256(core.termsCommitment),
            uint256(unitsOutstanding),
            uint256(input.fxAvgWad),
            prior,
            uint256(input.incomeCommitment),
            uint256(input.paymentUsd)
        ];
        if (!IGroth16Verifier(_s().groth16Verifier).verifyProof(input.proof.a, input.proof.b, input.proof.c, pub)) {
            revert InvalidProof();
        }
    }

    /// @dev SPEC §6.2 step 8: store the report, consume router credit, open the due (or settle a zero due).
    function _applyReport(ReportInput calldata input, SeriesCore memory core, Ledger storage l, bool tail, bool fxFallback)
        internal
    {
        uint64 creditUsed = uint64(MercesMath.min(l.routerCredit, input.paymentUsd));
        l.routerCredit -= creditUsed;
        uint64 due = input.paymentUsd - creditUsed;
        Report storage r = _s().reports[input.seriesId][input.period];
        r.exists = true;
        r.acceptedAt = uint64(block.timestamp);
        r.paymentUsd = input.paymentUsd;
        r.fxAvgWad = input.fxAvgWad;
        r.fxFallback = fxFallback;
        r.tier = input.tier;
        r.liquidityEvent = input.liquidityEvent;
        r.incomeCommitment = input.incomeCommitment;
        r.due = due;
        l.hasAccepted = true;
        l.lastAcceptedPeriod = input.period;
        l.hasIncomeCommitment = true;
        l.lastIncomeCommitment = input.incomeCommitment;
        l.lastIncomePeriod = input.period;
        if (due == 0) {
            l.hasPaid = true;
            l.lastPaidPeriod = input.period;
            r.paidAt = uint64(block.timestamp);
            emit PaymentSettled(input.seriesId, input.period, 0, 0, 0, 0, 0);
        } else {
            l.openDuePeriod = input.period;
            l.openDueAmount = due;
            l.openDueTier = input.tier;
            l.openDueIsTail = tail;
        }
        _emitAccepted(input, fxFallback, due);
        _sync(input.seriesId, core, l);
    }

    function _emitAccepted(ReportInput calldata input, bool fxFallback, uint64 due) internal {
        emit ReportAccepted(
            input.seriesId,
            input.period,
            input.paymentUsd,
            input.fxAvgWad,
            fxFallback,
            input.tier,
            input.liquidityEvent,
            input.incomeCommitment,
            due
        );
    }

    /// @dev SPEC §6.2 step 4. Returns whether the fallback (attestor-signed) rate was used.
    function _checkFx(uint256 seriesId, SeriesCore memory core, ReportInput calldata input)
        internal
        view
        returns (bool fxFallback)
    {
        if (core.fxPairId == bytes32(0)) {
            if (input.fxAvgWad != C.WAD) revert FxMustBeWad();
            if (input.fxFallbackSignature.length != 0) revert FxFallbackNotNeeded();
            return false;
        }
        (bool ok, uint64 avg) = IMercesFxAccumulator(_s().fxAccumulator).quarterAverage(core.fxPairId, input.period);
        if (ok) {
            if (input.fxAvgWad != avg) revert FxMismatch(avg, input.fxAvgWad);
            if (input.fxFallbackSignature.length != 0) revert FxFallbackNotNeeded();
            return false;
        }
        if (input.fxFallbackSignature.length == 0) revert FxFallbackSignatureRequired();
        bytes32 digest = MercesMessages.fxDigest(registry().domain(), seriesId, input.period, input.fxAvgWad);
        address signer = ECDSA.recover(digest, input.fxFallbackSignature);
        if (!registry().isAttestor(signer)) revert AttestorNotRegistered(signer);
        return true;
    }

    /// @dev SPEC §6.2 step 7: tier 2 → verifier key, tier 3 → attestor, tiers 1 and 4 → none.
    function _checkAttestation(uint256 seriesId, ReportInput calldata input) internal view {
        if (input.tier == 1 || input.tier == 4) return;
        if (input.attestationSignature.length == 0) revert AttestationRequired();
        bytes32 digest =
            MercesMessages.reportDigest(registry().domain(), seriesId, input.period, input.incomeCommitment, input.tier);
        address signer = ECDSA.recover(digest, input.attestationSignature);
        if (input.tier == 2) {
            if (!registry().isVerifierKey(signer)) revert VerifierKeyNotRegistered(signer);
        } else if (!registry().isAttestor(signer)) {
            revert AttestorNotRegistered(signer);
        }
    }

    /// @inheritdoc IMercesIncome
    /// @dev Anyone may pay on the issuer's behalf (funds come from the caller). Pulls `due + accrual` into the
    /// vault and hands it to `receiveGross`. Partial payments are not supported (A13).
    function pay(uint256 seriesId) external override nonReentrant {
        Ledger storage l = _s().ledgers[seriesId];
        uint64 due = l.openDueAmount;
        if (due == 0) revert NothingDue();
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        uint32 period = l.openDuePeriod;
        uint64 accrual = _lateAccrual(l, terms, period, due, block.timestamp);
        uint64 total = (uint256(due) + accrual).toU64();
        bool tail = l.openDueIsTail;

        Report storage r = _s().reports[seriesId][period];
        r.accrualPaid = accrual;
        r.paidAt = uint64(block.timestamp);
        l.hasPaid = true;
        l.lastPaidPeriod = period;
        l.openDueAmount = 0;
        l.openDuePeriod = 0;
        l.openDueTier = 0;
        l.openDueIsTail = false;

        ProtocolContracts memory pc = _contracts();
        IERC20(core.stablecoin).safeTransferFrom(msg.sender, pc.vault, total);
        (uint64 accepted, uint64 fee, uint64 refunded) = IMercesVault(pc.vault).receiveGross(
            seriesId, total, tail ? PayoutSource.Tail : PayoutSource.Payment, period
        );
        emit PaymentSettled(seriesId, period, total, accrual, fee, accepted, refunded);
        _sync(seriesId, core, l);
    }

    // ================================================================ tier-3 true-up (SPEC §6.2)

    /// @inheritdoc IMercesIncome
    function submitTrueUp(uint256 seriesId, uint16 year, int64 adjustment, uint64 attestationTs, bytes calldata sig)
        external
        override
    {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        if (!TierFlags.has(core.tierFlags, 3)) revert TierNotEnabled(3);
        if (core.terminalStatus != 0) revert SeriesTerminal();
        if (adjustment == 0) revert ZeroAdjustment();
        bytes32 digest = MercesMessages.trueupDigest(registry().domain(), seriesId, year, adjustment, attestationTs);
        if (_s().usedTrueUpDigests[digest]) revert TrueUpSignatureUsed();
        address signer = ECDSA.recover(digest, sig);
        if (!registry().isAttestor(signer)) revert AttestorNotRegistered(signer);
        _s().usedTrueUpDigests[digest] = true;
        Ledger storage l = _s().ledgers[seriesId];
        if (adjustment > 0) {
            l.trueupDue = (uint256(l.trueupDue) + uint64(adjustment)).toU64();
            l.trueupDeadline = attestationTs + C.TRUEUP_DAYS * uint64(C.DAY);
        } else {
            l.routerCredit = (uint256(l.routerCredit) + uint64(-adjustment)).toU64();
        }
        emit TrueUpRecorded(seriesId, year, adjustment, l.trueupDeadline);
    }

    /// @inheritdoc IMercesIncome
    function payTrueUp(uint256 seriesId) external override nonReentrant {
        Ledger storage l = _s().ledgers[seriesId];
        uint64 due = l.trueupDue;
        if (due == 0) revert NoTrueUpDue();
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        uint64 accrual = _accrualFromGraceEnd(l, terms, due, l.trueupDeadline, block.timestamp);
        uint64 total = (uint256(due) + accrual).toU64();
        l.trueupDue = 0;
        l.trueupDeadline = 0;
        ProtocolContracts memory pc = _contracts();
        IERC20(core.stablecoin).safeTransferFrom(msg.sender, pc.vault, total);
        IMercesVault(pc.vault).receiveGross(seriesId, total, PayoutSource.Payment, 0);
        emit TrueUpPaid(seriesId, total, accrual);
        _sync(seriesId, core, l);
    }

    // ================================================================ status machine (SPEC §6.4)

    /// @inheritdoc IMercesIncome
    function crankStatus(uint256 seriesId) external override {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        _sync(seriesId, core, _s().ledgers[seriesId]);
    }

    /// @inheritdoc IMercesIncome
    function requestPause(uint256 seriesId) external override {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        if (core.terminalStatus != 0) revert SeriesTerminal();
        Ledger storage l = _s().ledgers[seriesId];
        if (l.pauseRequested) revert PauseAlreadyRequested();
        l.pauseRequested = true;
        emit PauseRequested(seriesId);
    }

    /// @inheritdoc IMercesIncome
    /// @dev Anyone may submit the attestor's approval (SPEC §1.4 pause message over `pause_nonce`).
    function approvePause(uint256 seriesId, uint64 pauseEnd, bytes calldata attestorSignature) external override {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        Ledger storage l = _s().ledgers[seriesId];
        if (!l.pauseRequested) revert PauseNotRequested();
        if (pauseEnd <= block.timestamp) revert PauseEndInPast();
        _closeExpiredPause(seriesId, l);
        if (_isPaused(l, block.timestamp)) revert AlreadyPaused();
        bytes32 digest = MercesMessages.pauseDigest(registry().domain(), seriesId, l.pauseNonce, pauseEnd);
        address signer = ECDSA.recover(digest, attestorSignature);
        if (!registry().isAttestor(signer)) revert AttestorNotRegistered(signer);
        l.pauseStart = uint64(block.timestamp);
        l.pauseEnd = pauseEnd;
        l.pauseNonce += 1;
        l.pauseRequested = false;
        emit PauseApproved(seriesId, l.pauseStart, pauseEnd, signer);
        _sync(seriesId, core, l);
    }

    /// @inheritdoc IMercesIncome
    function endPause(uint256 seriesId) external override {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        Ledger storage l = _s().ledgers[seriesId];
        _closeExpiredPause(seriesId, l);
        if (!_isPaused(l, block.timestamp)) revert NotPaused();
        l.pausedTotal += uint64(block.timestamp) - l.pauseStart;
        l.pauseStart = 0;
        l.pauseEnd = 0;
        emit PauseEnded(seriesId, l.pausedTotal);
        _sync(seriesId, core, l);
    }

    /// @dev `sync_status(now)`: close an expired pause, store the derived status, emit on change, emit the
    /// formal notice once per period (SPEC §6.4).
    function _sync(uint256 seriesId, SeriesCore memory core, Ledger storage l) internal {
        _closeExpiredPause(seriesId, l);
        SeriesStatus next = _derive(core, l, block.timestamp);
        SeriesStatus old = l.storedStatus;
        if (next != old) {
            l.storedStatus = next;
            emit StatusChanged(seriesId, old, next);
        }
        if (core.terminalStatus == 0 && core.raiseState == RaiseState.Settled) {
            uint32 p = _earliestUnpaid(l, core);
            if (
                _effectiveNow(l, block.timestamp) >= _deadline(p) + C.FORMAL_NOTICE_DAYS * C.DAY
                    && !(l.formalNoticeEmitted && l.formalNoticeEmittedFor == p)
            ) {
                l.formalNoticeEmitted = true;
                l.formalNoticeEmittedFor = p;
                emit FormalNoticeDue(seriesId, p);
            }
        }
    }

    function _closeExpiredPause(uint256 seriesId, Ledger storage l) internal {
        if (l.pauseStart != 0 && block.timestamp >= l.pauseEnd) {
            l.pausedTotal += l.pauseEnd - l.pauseStart;
            l.pauseStart = 0;
            l.pauseEnd = 0;
            emit PauseEnded(seriesId, l.pausedTotal);
        }
    }

    function _derive(SeriesCore memory core, Ledger storage l, uint256 timestamp) internal view returns (SeriesStatus) {
        if (core.terminalStatus != 0) return SeriesStatus(core.terminalStatus);
        if (core.raiseState != RaiseState.Settled) return SeriesStatus.OnTime; // nothing is due before settlement
        if (_isPaused(l, timestamp)) return SeriesStatus.Paused;
        uint32 p = _earliestUnpaid(l, core);
        uint256 e = _effectiveNow(l, timestamp);
        if (e <= _deadline(p)) return SeriesStatus.OnTime;
        if (e <= _graceEnd(p)) return SeriesStatus.InGrace;
        return SeriesStatus.Late;
    }

    function _isPaused(Ledger storage l, uint256 timestamp) internal view returns (bool) {
        return l.pauseStart != 0 && timestamp < l.pauseEnd;
    }

    function _pauseElapsed(Ledger storage l, uint256 timestamp) internal view returns (uint256) {
        if (l.pauseStart == 0) return 0;
        uint256 until = timestamp < l.pauseEnd ? timestamp : l.pauseEnd;
        return until > l.pauseStart ? until - l.pauseStart : 0;
    }

    function _effectiveNow(Ledger storage l, uint256 timestamp) internal view returns (uint256) {
        return timestamp - l.pausedTotal - _pauseElapsed(l, timestamp);
    }

    function _firstPeriod(SeriesCore memory core) internal pure returns (uint32) {
        return Periods.periodOf(core.settlementTs);
    }

    function _nextExpected(Ledger storage l, SeriesCore memory core) internal view returns (uint32) {
        return l.hasAccepted ? l.lastAcceptedPeriod + 1 : _firstPeriod(core);
    }

    function _earliestUnpaid(Ledger storage l, SeriesCore memory core) internal view returns (uint32) {
        return l.openDueAmount > 0 ? l.openDuePeriod : _nextExpected(l, core);
    }

    function _deadline(uint32 period) internal pure returns (uint256) {
        return uint256(Periods.periodEnd(period)) + C.REPORT_DUE_DAYS * C.DAY;
    }

    function _graceEnd(uint32 period) internal pure returns (uint256) {
        return _deadline(period) + C.GRACE_DAYS * C.DAY;
    }

    /// @dev `late_accrual(p, amount, now) = floor(amount × hurdle_rate_wad × late_days / (365 × WAD))`.
    function _lateAccrual(Ledger storage l, SeriesTerms memory terms, uint32 period, uint64 amount, uint256 timestamp)
        internal
        view
        returns (uint64)
    {
        return _accrualFromGraceEnd(l, terms, amount, _graceEnd(period), timestamp);
    }

    function _accrualFromGraceEnd(
        Ledger storage l,
        SeriesTerms memory terms,
        uint64 amount,
        uint256 graceEndTs,
        uint256 timestamp
    ) internal view returns (uint64) {
        uint256 e = _effectiveNow(l, timestamp);
        if (e <= graceEndTs) return 0;
        uint256 lateDays = (e - graceEndTs) / C.DAY;
        return MercesMath.mulDiv(uint256(amount) * terms.hurdleRateWad, lateDays, 365 * C.WAD).toU64();
    }

    // ================================================================ tier-1 split router (SPEC §6.5)

    /// @inheritdoc IMercesIncome
    /// @dev Plaintext θ and r are public by the tier-1 issuer's choice. The quarterly proof remains the source
    /// of truth: routed amounts are only *credited* against the proven payment, so the issuer gains nothing by
    /// misconfiguring the router (shortfalls are collected at report time, excess is credited forward).
    function setRouterTerms(uint256 seriesId, uint64 theta, uint64 rWad) external override {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        if (!TierFlags.has(core.tierFlags, 1)) revert NotTierOne();
        Router storage r = _s().routers[seriesId];
        if (r.receiver == address(0)) r.receiver = address(new MercesRouterReceiver(seriesId));
        r.configured = true;
        r.theta = theta;
        r.rWad = rWad;
        emit RouterTermsSet(seriesId, theta, rWad, r.receiver);
    }

    /// @inheritdoc IMercesIncome
    function route(uint256 seriesId, uint64 amount) external override nonReentrant {
        Router storage r = _s().routers[seriesId];
        if (!r.configured) revert RouterNotConfigured();
        if (amount == 0) revert ZeroUnits();
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        IERC20(core.stablecoin).safeTransferFrom(msg.sender, address(this), amount);
        _route(seriesId, core, r, amount);
    }

    /// @inheritdoc IMercesIncome
    function sweep(uint256 seriesId) external override nonReentrant {
        Router storage r = _s().routers[seriesId];
        if (!r.configured) revert RouterNotConfigured();
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        IERC20 stable = IERC20(core.stablecoin);
        uint256 bal = stable.balanceOf(r.receiver);
        if (bal == 0) revert ZeroUnits();
        uint64 amount = bal.toU64();
        MercesRouterReceiver(r.receiver).forward(stable, amount);
        _route(seriesId, core, r, amount);
    }

    function _route(uint256 seriesId, SeriesCore memory core, Router storage r, uint64 amount) internal {
        uint256 n = core.terminalStatus != 0 ? 0 : IERC3643Token(core.unitToken).totalSupply();
        uint64 share = _split(r, amount, n);
        uint64 passThrough = amount - share;
        IERC20 stable = IERC20(core.stablecoin);
        if (passThrough > 0) stable.safeTransfer(core.issuer, passThrough);
        if (share > 0) _sendShare(seriesId, stable, share);
        emit IncomeRouted(seriesId, amount, passThrough, share, r.ytdReceived);
    }

    /// @dev SPEC §6.5 split: resets the YTD counter on a new civil year, passes income below θ through and
    /// routes `min(above, floor(r_wad × units_outstanding × above / WAD))` to the vault.
    function _split(Router storage r, uint64 amount, uint256 unitsOutstanding) internal returns (uint64 share) {
        uint16 year = Periods.civilYear(block.timestamp);
        if (year != r.ytdYear) {
            r.ytdYear = year;
            r.ytdReceived = 0;
        }
        uint256 below = r.theta > r.ytdReceived ? r.theta - r.ytdReceived : 0;
        uint256 above = amount - MercesMath.min(amount, below);
        uint256 s_ = MercesMath.mulDiv(uint256(r.rWad) * unitsOutstanding, above, C.WAD);
        if (s_ > above) s_ = above;
        r.ytdReceived = (uint256(r.ytdReceived) + amount).toU64();
        share = uint64(s_);
    }

    function _sendShare(uint256 seriesId, IERC20 stable, uint64 share) internal {
        ProtocolContracts memory pc = _contracts();
        stable.safeTransfer(pc.vault, share);
        (uint64 accepted,,) = IMercesVault(pc.vault).receiveGross(seriesId, share, PayoutSource.Router, 0);
        Ledger storage l = _s().ledgers[seriesId];
        l.routerCredit = (uint256(l.routerCredit) + accepted).toU64();
    }

    // ================================================================ protocol

    /// @inheritdoc IMercesIncome
    /// @dev Extinguishment clears every open due (SPEC §6.9): nothing else is owed.
    function clearDues(uint256 seriesId) external override {
        _requireCaller(_contracts().vault);
        Ledger storage l = _s().ledgers[seriesId];
        l.openDueAmount = 0;
        l.openDuePeriod = 0;
        l.openDueTier = 0;
        l.openDueIsTail = false;
        l.trueupDue = 0;
        l.trueupDeadline = 0;
    }

    // ================================================================ views

    function deriveStatus(uint256 seriesId) external view override returns (SeriesStatus) {
        return _derive(registry().getSeriesCore(seriesId), _s().ledgers[seriesId], block.timestamp);
    }

    function deriveStatusAt(uint256 seriesId, uint256 timestamp) external view override returns (SeriesStatus) {
        return _derive(registry().getSeriesCore(seriesId), _s().ledgers[seriesId], timestamp);
    }

    function effectiveNow(uint256 seriesId, uint256 timestamp) external view override returns (uint256) {
        return _effectiveNow(_s().ledgers[seriesId], timestamp);
    }

    function nextExpectedPeriod(uint256 seriesId) external view override returns (uint32) {
        return _nextExpected(_s().ledgers[seriesId], registry().getSeriesCore(seriesId));
    }

    function lateAccrual(uint256 seriesId, uint32 period, uint64 amount, uint256 timestamp)
        external
        view
        override
        returns (uint64)
    {
        return _lateAccrual(_s().ledgers[seriesId], registry().getSeriesTerms(seriesId), period, amount, timestamp);
    }

    function getLedger(uint256 seriesId) external view override returns (Ledger memory) {
        return _s().ledgers[seriesId];
    }

    function getReport(uint256 seriesId, uint32 period) external view override returns (Report memory) {
        return _s().reports[seriesId][period];
    }

    function getRouter(uint256 seriesId) external view override returns (Router memory) {
        return _s().routers[seriesId];
    }

    function openDue(uint256 seriesId) external view override returns (uint64 amount, uint32 period) {
        Ledger storage l = _s().ledgers[seriesId];
        return (l.openDueAmount, l.openDuePeriod);
    }

    function trueupDue(uint256 seriesId) external view override returns (uint64) {
        return _s().ledgers[seriesId].trueupDue;
    }

    function lastPaidPeriod(uint256 seriesId) external view override returns (bool hasPaid, uint32 period) {
        Ledger storage l = _s().ledgers[seriesId];
        return (l.hasPaid, l.lastPaidPeriod);
    }

    function groth16Verifier() external view override returns (address) {
        return _s().groth16Verifier;
    }

    function fxAccumulator() external view override returns (address) {
        return _s().fxAccumulator;
    }
}
