// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MercesUpgradeable} from "./base/MercesUpgradeable.sol";
import {IMercesIncome} from "./interfaces/IMercesIncome.sol";
import {IMercesVault} from "./interfaces/IMercesVault.sol";
import {IMercesRouter} from "./interfaces/IMercesRouter.sol";
import {IGroth16Verifier} from "./interfaces/IGroth16Verifier.sol";
import {IMercesFxAccumulator} from "./interfaces/IMercesFxAccumulator.sol";
import {IPoseidon2} from "./interfaces/IPoseidon.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesMessages} from "./libraries/MercesMessages.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {Periods} from "./libraries/Periods.sol";
import {
    KeyInfo,
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
/// @notice ProofOfIncome verifier (D6), status machine with per-obligation unpaused countdowns (C8) and the
/// tier-3 true-up; SPEC v1.1 §6.1–§6.4. The tier-1 split router (D5, §6.5) is `MercesRouter` and the FX rate
/// accumulator (C9, §6.6) is `MercesFxAccumulator`; both are consulted here. Reports are the issuer's act;
/// payments may be made by anyone on the issuer's behalf and flow straight into the vault. No function can
/// force a payment and nothing penalises a zero report (brief C11 §3).
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
        address router;
        address poseidon2;
        mapping(uint256 => Ledger) ledgers;
        mapping(uint256 => mapping(uint32 => Report)) reports;
        mapping(uint256 => Pause[]) pauses;
    }

    // keccak256(abi.encode(uint256(keccak256("merces.storage.MercesIncome")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant INCOME_STORAGE = 0x66ead0de223ba92d245f4c0ddf858a641e8e084176e74c7daa2b3858db16d400;

    function _s() private pure returns (IncomeStorage storage $) {
        assembly ("memory-safe") {
            $.slot := INCOME_STORAGE
        }
    }

    function initialize(
        address owner_,
        address registry_,
        address groth16Verifier_,
        address fxAccumulator_,
        address router_,
        address poseidon2_
    ) external initializer {
        __MercesUpgradeable_init(owner_, registry_);
        if (
            groth16Verifier_ == address(0) || fxAccumulator_ == address(0) || router_ == address(0)
                || poseidon2_ == address(0)
        ) revert ZeroAddress();
        IncomeStorage storage $ = _s();
        $.groth16Verifier = groth16Verifier_;
        $.fxAccumulator = fxAccumulator_;
        $.router = router_;
        $.poseidon2 = poseidon2_;
        emit Groth16VerifierSet(groth16Verifier_);
        emit FxAccumulatorSet(fxAccumulator_);
        emit RouterSet(router_);
        emit Poseidon2Set(poseidon2_);
    }

    /// @notice Money-code configuration, owner (timelock) only: the verifier is tied to the circuit's key.
    function setGroth16Verifier(address verifier) external onlyOwner {
        if (verifier == address(0)) revert ZeroAddress();
        _s().groth16Verifier = verifier;
        emit Groth16VerifierSet(verifier);
    }

    // ================================================================ reports (SPEC §6.2)

    /// @inheritdoc IMercesIncome
    /// @dev SPEC §6.2 steps 1–8 in order. Every failure reverts with the canonical error; nothing is stored before
    /// the effects phase.
    function submitReport(ReportInput calldata input) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(input.seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        if (core.raiseState != RaiseState.Settled) revert RaiseNotSettled();
        uint64 paymentUsd = input.paymentUsd.toU64();
        uint64 fxAvgWad = input.fxAvgWad.toU64();
        Ledger storage l = _s().ledgers[input.seriesId];
        (bool tail, uint64 units) = _gateReport(input, core, l);
        bool fxFallback = _checkFx(input, core, fxAvgWad);
        _checkPrior(input, l);
        _verifyProof(input, core, units);
        _checkSource(input, core);
        _applyReport(input, l, tail, fxFallback, paymentUsd, fxAvgWad);
    }

    /// @dev SPEC §6.2 steps 2–3: mint gate, terminal gating (tail reports), sequence, timing, tier rules.
    function _gateReport(ReportInput calldata input, SeriesCore memory core, Ledger storage l)
        internal
        view
        returns (bool tail, uint64 units)
    {
        if (!core.mintFinalized) revert MintNotFinalized();
        uint8 ts = core.terminalStatus;
        if (ts == uint8(SeriesStatus.Retired) || ts == uint8(SeriesStatus.Extinguished)) revert TerminalStatus();
        uint32 expected = _nextExpected(l, core);
        if (input.period != expected) revert WrongPeriod(expected, input.period);
        if (block.timestamp < Periods.periodEnd(input.period)) revert ReportTooEarly();
        if (l.openDueAmount > 0) revert PaymentOutstanding();
        if (_s().reports[input.seriesId][input.period].exists) revert WrongPeriod(expected, input.period);
        IMercesVault vault = IMercesVault(_contracts().vault);
        if (ts == uint8(SeriesStatus.Redeemed)) {
            IMercesVault.Ledger memory vl = vault.getLedger(input.seriesId);
            if (Periods.periodStart(input.period) > uint256(vl.redemptionTs) + C.TAIL_SECONDS) revert TailEnded();
            if (input.liquidityEvent && (vl.tailCapPerUnit == 0 || vl.tailExhausted)) revert NoTailDue();
            tail = true;
            units = vl.unitsAtRedemption;
        } else {
            units = vault.unitsOutstanding(input.seriesId);
        }
        if (!TierFlags.has(core.tierFlags, input.tier)) revert TierNotEnabled(input.tier);
        if (input.tier == 1 && !TierFlags.isPureTier1(core.tierFlags)) revert TierNotEnabled(1);
        if (input.tier == 4 && !registry().getFlags().tier4Enabled) revert TierNotEnabled(4);
    }

    /// @dev SPEC §6.2 step 4. Returns whether the fallback (attestor-signed) rate was used.
    function _checkFx(ReportInput calldata input, SeriesCore memory core, uint64 fxAvgWad)
        internal
        view
        returns (bool fxFallback)
    {
        bool fallbackGiven = input.fxFallbackSignature.length != 0;
        if (core.fxPairId == bytes32(0)) {
            if (fxAvgWad != C.WAD) revert FxMismatch(C.WAD, fxAvgWad);
            if (fallbackGiven) revert FxFallbackNotAllowed();
            return false;
        }
        (bool ok, uint256 avg) = IMercesFxAccumulator(_s().fxAccumulator).quarterAverage(core.fxPairId, input.period);
        if (ok) {
            if (fallbackGiven) revert FxFallbackNotAllowed();
            if (uint256(fxAvgWad) != avg) revert FxMismatch(avg, fxAvgWad);
            return false;
        }
        if (!fallbackGiven) revert FxFallbackRequired();
        bytes32 digest = MercesMessages.fxDigest(registry().domain(), input.seriesId, input.period, fxAvgWad);
        address signer = _recover(digest, input.fxFallbackSignature);
        // Honour the §1.4 forward-only revocation grace (S8), as the report-attestation path does: a key revoked
        // after the period ended still signs its in-flight quarter, so an admin revocation cannot manufacture
        // lateness.
        if (!_keyValid(registry().attestorKey(signer), input.period)) revert InvalidAttestorSignature(signer);
        return true;
    }

    /// @dev SPEC §6.2 step 5: chained within a year; accepted as given at a mid-year first report (A25);
    /// `ZERO_INCOME_COMMITMENT` at a year start. A mismatch means the proof cannot open the chain: `InvalidProof`.
    function _checkPrior(ReportInput calldata input, Ledger storage l) internal view {
        bytes32 prior = input.priorIncomeCommitment;
        if (
            l.hasIncomeCommitment && l.lastIncomePeriod + 1 == input.period
                && Periods.yearOf(l.lastIncomePeriod) == Periods.yearOf(input.period)
        ) {
            if (prior != l.lastIncomeCommitment) revert InvalidProof();
        } else if (!l.hasAccepted && Periods.quarterIndex(input.period) != 0) {
            return;
        } else if (uint256(prior) != ZERO_INCOME_COMMITMENT) {
            revert InvalidProof();
        }
    }

    /// @dev SPEC §6.2 step 6: Groth16 verification with the public inputs in order
    /// `[terms_commitment, units_outstanding, fx_avg_wad, prior, income_commitment, payment_usd]`.
    function _verifyProof(ReportInput calldata input, SeriesCore memory core, uint64 units) internal view {
        uint256[6] memory pub = [
            uint256(core.termsCommitment),
            uint256(units),
            uint256(input.fxAvgWad),
            uint256(input.priorIncomeCommitment),
            uint256(input.incomeCommitment),
            uint256(input.paymentUsd)
        ];
        if (!IGroth16Verifier(_s().groth16Verifier).verifyProof(input.proof.a, input.proof.b, input.proof.c, pub)) {
            revert InvalidProof();
        }
    }

    /// @dev SPEC §6.2 step 7: tier 2 → verifier key, tier 3 → attestor (active or within the revocation grace),
    /// tier 4 → the issuer's own transaction, tier 1 → Poseidon(2) binding to the router checkpoints (any supplied
    /// attestation is ignored for tiers 1 and 4).
    function _checkSource(ReportInput calldata input, SeriesCore memory core) internal view {
        if (input.tier == 4) return;
        if (input.tier == 1) {
            _checkRouterBinding(input, core);
            return;
        }
        bytes32 digest = MercesMessages.reportDigest(
            registry().domain(),
            input.seriesId,
            input.period,
            input.priorIncomeCommitment,
            input.incomeCommitment,
            input.tier,
            input.liquidityEvent
        );
        address signer = _recover(digest, input.attestationSignature);
        if (input.tier == 2) {
            if (!_keyValid(registry().verifierKey(signer), input.period)) revert InvalidVerifierSignature(signer);
        } else if (!_keyValid(registry().attestorKey(signer), input.period)) {
            revert InvalidAttestorSignature(signer);
        }
    }

    /// @dev Raw-digest secp256k1 recovery (SPEC §1.4, low-`s` enforced by OpenZeppelin); a malformed signature
    /// recovers to the zero address, which is never a registered key.
    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        (signer,,) = ECDSA.tryRecover(digest, signature);
    }

    /// @dev SPEC §1.4 forward-only revocation: a revoked key still validates a report for a period that ended
    /// before the revocation, until `revoked_at + (report_due_days + grace_days) × DAY`.
    function _keyValid(KeyInfo memory k, uint32 period) internal view returns (bool) {
        if (!k.registered) return false;
        if (k.active) return true;
        return k.revokedAt >= Periods.periodEnd(period) && block.timestamp <= uint256(k.revokedAt) + C.GRACE_SECONDS;
    }

    /// @dev Pure tier-1 series: `income == Poseidon(2)(ytd_at_end[period], 0)`; `prior == ZERO` at a year start,
    /// else `Poseidon(2)(ytd_at_end[period − 1], 0)` (SPEC §6.2 step 7, A39). A mismatch is `InvalidProof`.
    function _checkRouterBinding(ReportInput calldata input, SeriesCore memory) internal view {
        IMercesRouter r = IMercesRouter(_s().router);
        (bool ok, uint64 ytd) = r.ytdAtEnd(input.seriesId, input.period);
        if (!ok) revert RouterPeriodNotClosed(input.period);
        if (uint256(input.incomeCommitment) != _poseidon2(ytd)) revert InvalidProof();
        uint256 expectedPrior = ZERO_INCOME_COMMITMENT;
        if (Periods.quarterIndex(input.period) != 0) {
            (bool okPrev, uint64 ytdPrev) = r.ytdAtEnd(input.seriesId, input.period - 1);
            if (!okPrev) revert RouterPeriodNotClosed(input.period - 1);
            expectedPrior = _poseidon2(ytdPrev);
        }
        if (uint256(input.priorIncomeCommitment) != expectedPrior) revert InvalidProof();
    }

    function _poseidon2(uint64 ytd) internal view returns (uint256) {
        return IPoseidon2(_s().poseidon2).poseidon([uint256(ytd), uint256(0)]);
    }

    /// @dev SPEC §6.2 step 8: store the report, consume router credit, open the due (or settle a zero due).
    /// Non-liquidity tail reports carry `due = 0` and only advance the commitment chain.
    function _applyReport(
        ReportInput calldata input,
        Ledger storage l,
        bool tail,
        bool fxFallback,
        uint64 paymentUsd,
        uint64 fxAvgWad
    ) internal {
        // A non-liquidity tail report pays nothing and must not consume router credit (S7, income.rs:459-470):
        // touching the credit here would double-charge the issuer at a later tail liquidity event.
        uint64 due;
        if (tail && !input.liquidityEvent) {
            due = 0;
        } else {
            uint64 creditUsed = uint64(MercesMath.min(l.routerCredit, paymentUsd));
            l.routerCredit -= creditUsed;
            due = paymentUsd - creditUsed;
        }
        Report storage r = _s().reports[input.seriesId][input.period];
        r.exists = true;
        r.acceptedAt = uint64(block.timestamp);
        r.paymentUsd = paymentUsd;
        r.fxAvgWad = fxAvgWad;
        r.fxFallback = fxFallback;
        r.tier = input.tier;
        r.liquidityEvent = input.liquidityEvent;
        r.incomeCommitment = input.incomeCommitment;
        r.priorIncomeCommitment = input.priorIncomeCommitment;
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
            l.openDueIsTail = tail;
        }
        _emitAccepted(input.seriesId, input.period, r);
        _sync(input.seriesId);
    }

    function _emitAccepted(uint256 seriesId, uint32 period, Report storage r) internal {
        emit ReportAccepted(
            seriesId,
            period,
            r.paymentUsd,
            r.fxAvgWad,
            r.fxFallback,
            r.tier,
            r.liquidityEvent,
            r.incomeCommitment,
            r.due
        );
    }

    /// @inheritdoc IMercesIncome
    /// @dev Anyone may pay on the issuer's behalf (funds come from the caller). Pulls `due + accrual` into the
    /// vault and hands it to `receiveGross` (`Tail` while Redeemed, with no accrual). Partial payments are not
    /// supported (A13).
    function pay(uint256 seriesId) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (core.raiseState != RaiseState.Settled) revert RaiseNotSettled();
        if (!core.mintFinalized) revert MintNotFinalized();
        Ledger storage l = _s().ledgers[seriesId];
        uint64 due = l.openDueAmount;
        if (due == 0) revert NothingDue();
        uint32 period = l.openDuePeriod;
        bool tail = l.openDueIsTail;
        uint64 accrual = core.terminalStatus == uint8(SeriesStatus.Redeemed)
            ? 0
            : _lateAccrual(registry().getSeriesTerms(seriesId), _s().pauses[seriesId], period, due, block.timestamp);
        uint64 total = (uint256(due) + accrual).toU64();

        Report storage r = _s().reports[seriesId][period];
        r.accrualPaid = accrual;
        r.paidAt = uint64(block.timestamp);
        l.hasPaid = true;
        l.lastPaidPeriod = period;
        l.openDueAmount = 0;
        l.openDuePeriod = 0;
        l.openDueIsTail = false;

        ProtocolContracts memory pc = _contracts();
        IERC20(core.stablecoin).safeTransferFrom(msg.sender, pc.vault, total);
        (uint64 accepted, uint64 fee, uint64 refunded) = IMercesVault(pc.vault)
            .receiveGross(seriesId, total, tail ? PayoutSource.Tail : PayoutSource.Payment, period);
        emit PaymentSettled(seriesId, period, total, accrual, fee, accepted, refunded);
        _sync(seriesId);
    }

    // ================================================================ tier-3 true-up (SPEC §6.2)

    /// @inheritdoc IMercesIncome
    /// @dev SPEC §6.2 tier-3 true-up. The attestor signs the §1.4 message over the stored `trueup_nonce`, so a
    /// replayed signature or one over another nonce recovers to a non-attestor (`InvalidAttestorSignature`, checked
    /// before the state rules as the reference does). One true-up per year, after the year ended and was fully
    /// reported since the first period; positive adjustments become a due with `trueup_days` of unpaused time
    /// before accrual; negative ones (bounded by the year's accepted payments) are credited forward.
    function submitTrueUp(uint256 seriesId, uint16 year, int256 adjustment, uint256 attestationTs, bytes calldata sig)
        external
        override
    {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        if (core.raiseState != RaiseState.Settled) revert RaiseNotSettled();
        if (!core.mintFinalized) revert MintNotFinalized();
        if (!TierFlags.has(core.tierFlags, 3)) revert TierNotEnabled(3);
        if (adjustment > type(int64).max || adjustment < type(int64).min) {
            revert AmountOutOfRange(uint256(adjustment < 0 ? -adjustment : adjustment));
        }
        uint64 attestedAt = attestationTs.toU64();
        Ledger storage l = _s().ledgers[seriesId];
        bytes32 digest = MercesMessages.trueupDigest(
            registry().domain(), seriesId, l.trueupNonce, year, int64(adjustment), attestedAt
        );
        address signer = _recover(digest, sig);
        if (!registry().isAttestor(signer)) revert InvalidAttestorSignature(signer);
        if (core.terminalStatus != 0) revert TerminalStatus();
        if (attestedAt > block.timestamp) revert AttestationInFuture();
        if (l.trueupDue != 0) revert TrueUpOutstanding();
        _checkTrueupYear(core, l, year);
        l.trueupNonce += 1;

        uint64 deadline;
        if (adjustment > 0) {
            l.trueupDue = uint64(uint256(adjustment));
            l.trueupAttestedAt = attestedAt;
            l.hasTrueupYear = true;
            l.trueupYear = year;
            l.trueupNoticeEmitted = false;
            deadline = attestedAt + uint64(C.TRUEUP_SECONDS);
        } else if (adjustment < 0) {
            uint256 abs_ = uint256(-adjustment);
            if (abs_ > _yearPayments(seriesId, year)) revert TrueUpAdjustmentTooLarge();
            l.routerCredit = (uint256(l.routerCredit) + abs_).toU64();
        }
        l.hasLastTrueupYear = true;
        l.lastTrueupYear = year;
        emit TrueUpRecorded(seriesId, year, int64(adjustment), deadline);
        _sync(seriesId);
    }

    /// @dev Not trued up yet, ended, not before the settlement year, and every period of the year since
    /// `first_period` reported (reports are sequential, so the last accepted period must reach Q4).
    function _checkTrueupYear(SeriesCore memory core, Ledger storage l, uint16 year) internal view {
        if (l.hasLastTrueupYear && l.lastTrueupYear >= year) revert TrueUpYearInvalid();
        if (year >= Periods.yearOf(Periods.periodOf(block.timestamp))) revert TrueUpYearInvalid();
        // every period of the year reported — vacuous when the year ended before the first period (B-S20)
        uint32 lastOfYear = uint32(year) * 4 + 3;
        if (lastOfYear >= _firstPeriod(core) && (!l.hasAccepted || l.lastAcceptedPeriod < lastOfYear)) {
            revert TrueUpYearInvalid();
        }
    }

    /// @dev `Σ payment_usd` accepted for the four periods of `year`.
    function _yearPayments(uint256 seriesId, uint16 year) internal view returns (uint256 sum) {
        mapping(uint32 => Report) storage reports = _s().reports[seriesId];
        for (uint32 q = 0; q < 4; q++) {
            Report storage r = reports[uint32(year) * 4 + q];
            if (r.exists) sum += r.paymentUsd;
        }
    }

    /// @inheritdoc IMercesIncome
    /// @dev Pulls `trueup_due + late_accrual_trueup(now)` into the vault; the payment's `year_gross` slot is anchored
    /// at the due date of `period_of(trueup_attested_at)` (SPEC §6.2).
    function payTrueUp(uint256 seriesId) external override nonReentrant {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (core.raiseState != RaiseState.Settled) revert RaiseNotSettled();
        if (!core.mintFinalized) revert MintNotFinalized();
        Ledger storage l = _s().ledgers[seriesId];
        uint64 due = l.trueupDue;
        if (due == 0) revert NothingDue();
        uint64 accrual =
            _lateAccrualTrueup(registry().getSeriesTerms(seriesId), l, _s().pauses[seriesId], block.timestamp);
        uint64 total = (uint256(due) + accrual).toU64();
        uint32 period = Periods.periodOf(l.trueupAttestedAt);
        l.trueupDue = 0;
        l.trueupAttestedAt = 0;
        l.hasTrueupYear = false;
        l.trueupYear = 0;
        ProtocolContracts memory pc = _contracts();
        IERC20(core.stablecoin).safeTransferFrom(msg.sender, pc.vault, total);
        IMercesVault(pc.vault).receiveGross(seriesId, total, PayoutSource.Payment, period);
        emit TrueUpPaid(seriesId, total, accrual);
        _sync(seriesId);
    }

    // ================================================================ status machine (SPEC §6.4)

    /// @inheritdoc IMercesIncome
    function crankStatus(uint256 seriesId) external override {
        _sync(seriesId);
    }

    /// @inheritdoc IMercesIncome
    /// @dev A new request (or a repeated one) advances `pause_nonce`, invalidating any signature over an older
    /// request (SPEC §1.4, §6.4).
    function requestPause(uint256 seriesId) external override {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        if (core.raiseState != RaiseState.Settled) revert RaiseNotSettled();
        if (core.terminalStatus != 0) revert TerminalStatus();
        Ledger storage l = _s().ledgers[seriesId];
        l.pauseRequested = true;
        l.pauseRequestedAt = uint64(block.timestamp);
        l.pauseNonce += 1;
        emit PauseRequested(seriesId, l.pauseNonce);
    }

    /// @inheritdoc IMercesIncome
    function withdrawPauseRequest(uint256 seriesId) external override {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        Ledger storage l = _s().ledgers[seriesId];
        if (!l.pauseRequested) revert PauseNotRequested();
        l.pauseRequested = false;
        l.pauseRequestedAt = 0;
        l.pauseNonce += 1;
        emit PauseRequestWithdrawn(seriesId, l.pauseNonce);
    }

    /// @inheritdoc IMercesIncome
    /// @dev Anyone may submit the attestor's approval (SPEC §1.4 pause message over the current `pause_nonce`).
    /// Bounds: `pause_end > now`, not already paused, one approval ≤ `max_pause_seconds`, lifetime ≤
    /// `max_cumulative_pause_seconds`, at most `max_pauses` recorded pauses.
    function approvePause(uint256 seriesId, uint256 pauseEnd, bytes calldata attestorSignature) external override {
        uint64 end = pauseEnd.toU64();
        Ledger storage l = _s().ledgers[seriesId];
        bytes32 digest = MercesMessages.pauseDigest(registry().domain(), seriesId, l.pauseNonce, end);
        address signer = _recover(digest, attestorSignature);
        if (!registry().isAttestor(signer)) revert InvalidAttestorSignature(signer);
        if (!l.pauseRequested) revert PauseNotRequested();
        Pause[] storage ps = _s().pauses[seriesId];
        if (end <= block.timestamp) revert InvalidPauseEnd();
        if (_isPaused(ps, block.timestamp)) revert AlreadyPaused();
        SeriesTerms memory terms = registry().getSeriesTerms(seriesId);
        uint64 length = end - uint64(block.timestamp);
        if (length > terms.maxPauseSeconds) revert PauseTooLong();
        if (uint256(l.pausedTotal) + length > terms.maxCumulativePauseSeconds) revert PauseTooLong();
        if (ps.length >= C.MAX_PAUSES) revert TooManyPauses();
        ps.push(Pause({start: uint64(block.timestamp), end: end}));
        l.pauseCount = uint8(ps.length);
        l.pausedTotal += length;
        l.pauseRequested = false;
        l.pauseRequestedAt = 0;
        emit PauseApproved(seriesId, uint64(block.timestamp), end, signer);
        _sync(seriesId);
    }

    /// @inheritdoc IMercesIncome
    function endPause(uint256 seriesId) external override {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        if (msg.sender != core.issuer) revert NotIssuer();
        Ledger storage l = _s().ledgers[seriesId];
        Pause[] storage ps = _s().pauses[seriesId];
        if (!_isPaused(ps, block.timestamp)) revert NotPaused();
        Pause storage p = ps[ps.length - 1];
        l.pausedTotal -= p.end - uint64(block.timestamp);
        p.end = uint64(block.timestamp);
        emit PauseEnded(seriesId, l.pausedTotal);
        _sync(seriesId);
    }

    /// @dev `sync_status(now)`: store the derived status, emit on change, emit the formal notices once (SPEC §6.4).
    /// Re-reads the series core so a retirement triggered inside the vault during this call is reflected.
    function _sync(uint256 seriesId) internal {
        SeriesCore memory core = registry().getSeriesCore(seriesId);
        Ledger storage l = _s().ledgers[seriesId];
        Pause[] storage ps = _s().pauses[seriesId];
        SeriesStatus next = _derive(core, l, ps, block.timestamp);
        SeriesStatus old = l.storedStatus;
        if (next != old) {
            l.storedStatus = next;
            emit StatusChanged(seriesId, old, next);
        }
        if (core.terminalStatus != 0 || core.raiseState != RaiseState.Settled) return;
        uint32 p = _earliestUnpaid(l, core);
        if (
            _countdown(ps, p, block.timestamp) >= C.NOTICE_SECONDS
                && !(l.hasFormalNotice && l.formalNoticeEmittedFor == p)
        ) {
            l.hasFormalNotice = true;
            l.formalNoticeEmittedFor = p;
            emit FormalNoticeDue(seriesId, p, false);
        }
        if (
            l.trueupDue > 0 && !l.trueupNoticeEmitted
                && _unpaused(ps, l.trueupAttestedAt, block.timestamp, block.timestamp)
                    >= C.TRUEUP_SECONDS + (C.NOTICE_SECONDS - C.GRACE_SECONDS)
        ) {
            l.trueupNoticeEmitted = true;
            emit FormalNoticeDue(seriesId, l.trueupYear, true);
        }
    }

    // ---- clock helpers (SPEC §6.4) ----

    /// @dev `paused_within(a, b)` with every pause clipped at `nowTs` (only the last pause can be open).
    function _pausedWithin(Pause[] storage ps, uint256 a, uint256 b, uint256 nowTs)
        internal
        view
        returns (uint256 total)
    {
        uint256 n = ps.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 s = ps[i].start;
            uint256 e = ps[i].end;
            if (e > nowTs) e = nowTs;
            uint256 lo = s > a ? s : a;
            uint256 hi = e < b ? e : b;
            if (hi > lo) total += hi - lo;
        }
    }

    function _unpaused(Pause[] storage ps, uint256 a, uint256 b, uint256 nowTs) internal view returns (uint256) {
        if (b <= a) return 0;
        return (b - a) - _pausedWithin(ps, a, b, nowTs);
    }

    function _isPaused(Pause[] storage ps, uint256 ts) internal view returns (bool) {
        uint256 n = ps.length;
        if (n == 0) return false;
        Pause storage p = ps[n - 1];
        return p.start <= ts && ts < p.end;
    }

    function _countdown(Pause[] storage ps, uint32 period, uint256 ts) internal view returns (uint256) {
        return _unpaused(ps, Periods.periodEnd(period), ts, ts);
    }

    function _trueupOverdue(Ledger storage l, Pause[] storage ps, uint256 ts) internal view returns (bool) {
        return l.trueupDue > 0 && _unpaused(ps, l.trueupAttestedAt, ts, ts) > C.TRUEUP_SECONDS;
    }

    function _derive(SeriesCore memory core, Ledger storage l, Pause[] storage ps, uint256 ts)
        internal
        view
        returns (SeriesStatus)
    {
        if (core.terminalStatus != 0) return SeriesStatus(core.terminalStatus);
        if (core.raiseState != RaiseState.Settled) return SeriesStatus.OnTime; // nothing is due before settlement
        if (_isPaused(ps, ts)) return SeriesStatus.Paused;
        if (_trueupOverdue(l, ps, ts)) return SeriesStatus.Late;
        uint256 c = _countdown(ps, _earliestUnpaid(l, core), ts);
        if (c <= C.DEADLINE_SECONDS) return SeriesStatus.OnTime;
        if (c <= C.GRACE_SECONDS) return SeriesStatus.InGrace;
        return SeriesStatus.Late;
    }

    /// @dev `is_late_underlying(now)`: ignores `Paused`; false once the series is terminal (no obligations run).
    function _isLateUnderlying(SeriesCore memory core, Ledger storage l, Pause[] storage ps, uint256 ts)
        internal
        view
        returns (bool)
    {
        if (core.terminalStatus != 0 || core.raiseState != RaiseState.Settled) return false;
        return _trueupOverdue(l, ps, ts) || _countdown(ps, _earliestUnpaid(l, core), ts) > C.GRACE_SECONDS;
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

    /// @dev `late_accrual(p, amount, now) = mulDiv(mulDiv(amount, h, WAD), late_days, 365)` with
    /// `late_days = max(0, floor((countdown − grace_s) / DAY))`.
    function _lateAccrual(SeriesTerms memory terms, Pause[] storage ps, uint32 period, uint64 amount, uint256 ts)
        internal
        view
        returns (uint64)
    {
        uint256 c = _countdown(ps, period, ts);
        if (c <= C.GRACE_SECONDS) return 0;
        uint256 lateDays = (c - C.GRACE_SECONDS) / C.DAY;
        return MercesMath.mulDiv(MercesMath.mulDiv(amount, terms.hurdleRateWad, C.WAD), lateDays, 365).toU64();
    }

    /// @dev `late_accrual_trueup(now)`: accrual starts `trueup_days` of unpaused time after the attestation.
    function _lateAccrualTrueup(SeriesTerms memory terms, Ledger storage l, Pause[] storage ps, uint256 ts)
        internal
        view
        returns (uint64)
    {
        uint256 u = _unpaused(ps, l.trueupAttestedAt, ts, ts);
        if (u <= C.TRUEUP_SECONDS) return 0;
        uint256 lateDays = (u - C.TRUEUP_SECONDS) / C.DAY;
        return MercesMath.mulDiv(MercesMath.mulDiv(l.trueupDue, terms.hurdleRateWad, C.WAD), lateDays, 365).toU64();
    }

    // ================================================================ protocol

    /// @inheritdoc IMercesIncome
    /// @dev The router has transferred `share` to the vault; the vault's cap rule decides what is accepted and
    /// that amount becomes router credit against the quarter's report (SPEC §6.5).
    function receiveRouterShare(uint256 seriesId, uint64 share) external override returns (uint64 accepted) {
        if (msg.sender != _s().router) revert NotRouter();
        (accepted,,) = IMercesVault(_contracts().vault)
            .receiveGross(seriesId, share, PayoutSource.Router, Periods.periodOf(block.timestamp));
        Ledger storage l = _s().ledgers[seriesId];
        l.routerCredit = (uint256(l.routerCredit) + accepted).toU64();
    }

    /// @inheritdoc IMercesIncome
    function clearDues(uint256 seriesId) external override {
        _requireCaller(_contracts().vault);
        Ledger storage l = _s().ledgers[seriesId];
        l.openDueAmount = 0;
        l.openDuePeriod = 0;
        l.openDueIsTail = false;
        l.trueupDue = 0;
        l.trueupAttestedAt = 0;
        l.hasTrueupYear = false;
        l.trueupYear = 0;
    }

    // ================================================================ views

    function deriveStatus(uint256 seriesId) external view override returns (SeriesStatus) {
        return
            _derive(registry().getSeriesCore(seriesId), _s().ledgers[seriesId], _s().pauses[seriesId], block.timestamp);
    }

    function deriveStatusAt(uint256 seriesId, uint256 timestamp) external view override returns (SeriesStatus) {
        return _derive(registry().getSeriesCore(seriesId), _s().ledgers[seriesId], _s().pauses[seriesId], timestamp);
    }

    function isLateUnderlying(uint256 seriesId) external view override returns (bool) {
        return _isLateUnderlying(
            registry().getSeriesCore(seriesId), _s().ledgers[seriesId], _s().pauses[seriesId], block.timestamp
        );
    }

    function nextExpectedPeriod(uint256 seriesId) external view override returns (uint32) {
        return _nextExpected(_s().ledgers[seriesId], registry().getSeriesCore(seriesId));
    }

    function earliestUnpaidPeriod(uint256 seriesId) external view override returns (uint32) {
        return _earliestUnpaid(_s().ledgers[seriesId], registry().getSeriesCore(seriesId));
    }

    function countdown(uint256 seriesId, uint32 period, uint256 timestamp) external view override returns (uint256) {
        return _countdown(_s().pauses[seriesId], period, timestamp);
    }

    function unpausedBetween(uint256 seriesId, uint256 from, uint256 to) external view override returns (uint256) {
        return _unpaused(_s().pauses[seriesId], from, to, block.timestamp);
    }

    function lateAccrual(uint256 seriesId, uint32 period, uint64 amount, uint256 timestamp)
        external
        view
        override
        returns (uint64)
    {
        return _lateAccrual(registry().getSeriesTerms(seriesId), _s().pauses[seriesId], period, amount, timestamp);
    }

    function getLedger(uint256 seriesId) external view override returns (Ledger memory) {
        return _s().ledgers[seriesId];
    }

    function getReport(uint256 seriesId, uint32 period) external view override returns (Report memory) {
        return _s().reports[seriesId][period];
    }

    function getPauses(uint256 seriesId) external view override returns (Pause[] memory) {
        return _s().pauses[seriesId];
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

    function router() external view override returns (address) {
        return _s().router;
    }

    function poseidon2() external view override returns (address) {
        return _s().poseidon2;
    }
}
