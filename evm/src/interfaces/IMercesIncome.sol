// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {SeriesStatus} from "../types/MercesTypes.sol";

/// @dev `FormalNoticeDue.period` sentinel for the tier-3 true-up notice (SPEC §6.4 `FormalNoticeDue(series, trueup)`).
uint32 constant TRUEUP_NOTICE_PERIOD = type(uint32).max;

/// @notice ProofOfIncome verifier, status machine with per-obligation unpaused countdowns and tier-3 true-up
/// (D6, C8; SPEC v1.1 §6.1–§6.4). The tier-1 split router (D5, §6.5) is `MercesRouter`; the FX rate
/// accumulator (C9, §6.6) is `MercesFxAccumulator`.
interface IMercesIncome {
    struct Ledger {
        bool hasAccepted;
        uint32 lastAcceptedPeriod;
        bool hasPaid;
        uint32 lastPaidPeriod;
        // open due
        uint32 openDuePeriod;
        uint64 openDueAmount;
        bool openDueIsTail;
        // credits and true-up
        uint64 routerCredit;
        uint64 trueupNonce;
        uint64 trueupDue;
        uint64 trueupAttestedAt;
        bool hasTrueupYear;
        uint16 trueupYear;
        bool hasLastTrueupYear;
        uint16 lastTrueupYear;
        // pauses (the bounded history lives in `getPauses`)
        uint64 pauseNonce;
        bool pauseRequested;
        uint64 pauseRequestedAt;
        uint8 pauseCount;
        uint64 pausedTotal;
        // notices
        bool hasFormalNotice;
        uint32 formalNoticeEmittedFor;
        bool trueupNoticeEmitted;
        // commitments
        bool hasIncomeCommitment;
        bytes32 lastIncomeCommitment;
        uint32 lastIncomePeriod;
        SeriesStatus storedStatus;
    }

    struct Pause {
        uint64 start;
        uint64 end;
    }

    struct Report {
        bool exists;
        uint64 acceptedAt;
        uint64 paymentUsd;
        uint64 fxAvgWad;
        bool fxFallback;
        uint8 tier;
        bool liquidityEvent;
        bytes32 incomeCommitment;
        bytes32 priorIncomeCommitment;
        uint64 due;
        uint64 accrualPaid;
        uint64 paidAt;
    }

    struct Groth16Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    /// @dev `paymentUsd` and `fxAvgWad` are full words so a value ≥ 2^64 reverts `AmountOutOfRange` (SPEC §1.1).
    struct ReportInput {
        uint256 seriesId;
        uint32 period;
        uint256 paymentUsd;
        uint256 fxAvgWad;
        bytes fxFallbackSignature;
        bytes32 priorIncomeCommitment;
        bytes32 incomeCommitment;
        uint8 tier;
        bool liquidityEvent;
        Groth16Proof proof;
        bytes attestationSignature;
    }

    event ReportAccepted(
        uint256 indexed series,
        uint32 indexed period,
        uint64 paymentUsd,
        uint64 fxAvgWad,
        bool fxFallback,
        uint8 tier,
        bool liquidityEvent,
        bytes32 incomeCommitment,
        uint64 due
    );
    event PaymentSettled(
        uint256 indexed series,
        uint32 indexed period,
        uint64 gross,
        uint64 accrual,
        uint64 fee,
        uint64 accepted,
        uint64 refunded
    );
    event StatusChanged(uint256 indexed series, SeriesStatus oldStatus, SeriesStatus newStatus);
    event FormalNoticeDue(uint256 indexed series, uint32 period);
    event PauseRequested(uint256 indexed series, uint64 nonce);
    event PauseRequestWithdrawn(uint256 indexed series, uint64 nonce);
    event PauseApproved(uint256 indexed series, uint64 start, uint64 end, address indexed attestor);
    event PauseEnded(uint256 indexed series, uint64 pausedTotal);
    event TrueUpRecorded(uint256 indexed series, uint16 year, int64 adjustment, uint64 deadline);
    event TrueUpPaid(uint256 indexed series, uint64 amount, uint64 accrual);
    event Groth16VerifierSet(address verifier);
    event FxAccumulatorSet(address fxAccumulator);
    event RouterSet(address router);
    event Poseidon2Set(address poseidon2);

    // ---- reports and payments ----
    function submitReport(ReportInput calldata input) external;
    function pay(uint256 seriesId) external;
    function submitTrueUp(uint256 seriesId, uint16 year, int256 adjustment, uint256 attestationTs, bytes calldata sig)
        external;
    function payTrueUp(uint256 seriesId) external;

    // ---- status machine ----
    function crankStatus(uint256 seriesId) external;
    function requestPause(uint256 seriesId) external;
    function withdrawPauseRequest(uint256 seriesId) external;
    function approvePause(uint256 seriesId, uint256 pauseEnd, bytes calldata attestorSignature) external;
    function endPause(uint256 seriesId) external;

    // ---- protocol ----
    /// @dev Router only, after it has transferred `share` stablecoin to the vault: credits the accepted part.
    function receiveRouterShare(uint256 seriesId, uint64 share) external returns (uint64 accepted);
    /// @dev Vault only (retirement, extinguishment): clears every open due, including the true-up.
    function clearDues(uint256 seriesId) external;

    // ---- views ----
    function deriveStatus(uint256 seriesId) external view returns (SeriesStatus);
    function deriveStatusAt(uint256 seriesId, uint256 timestamp) external view returns (SeriesStatus);
    function isLateUnderlying(uint256 seriesId) external view returns (bool);
    function nextExpectedPeriod(uint256 seriesId) external view returns (uint32);
    function earliestUnpaidPeriod(uint256 seriesId) external view returns (uint32);
    function countdown(uint256 seriesId, uint32 period, uint256 timestamp) external view returns (uint256);
    function unpausedBetween(uint256 seriesId, uint256 from, uint256 to) external view returns (uint256);
    function lateAccrual(uint256 seriesId, uint32 period, uint64 amount, uint256 timestamp)
        external
        view
        returns (uint64);
    function getLedger(uint256 seriesId) external view returns (Ledger memory);
    function getReport(uint256 seriesId, uint32 period) external view returns (Report memory);
    function getPauses(uint256 seriesId) external view returns (Pause[] memory);
    function openDue(uint256 seriesId) external view returns (uint64 amount, uint32 period);
    function trueupDue(uint256 seriesId) external view returns (uint64);
    function lastPaidPeriod(uint256 seriesId) external view returns (bool hasPaid, uint32 period);
    function groth16Verifier() external view returns (address);
    function fxAccumulator() external view returns (address);
    function router() external view returns (address);
    function poseidon2() external view returns (address);
}
