// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {SeriesStatus} from "../types/MercesTypes.sol";

/// @notice ProofOfIncome verifier, status machine, tier-1 split router and FX rate accumulator
/// (D5, D6, C8, C9; SPEC §6.1–6.6).
interface IMercesIncome {
    struct Ledger {
        uint32 firstPeriod;
        bool hasAccepted;
        uint32 lastAcceptedPeriod;
        bool hasPaid;
        uint32 lastPaidPeriod;
        // open due
        uint32 openDuePeriod;
        uint64 openDueAmount;
        uint8 openDueTier;
        bool openDueIsTail;
        // credits and true-up
        uint64 routerCredit;
        uint64 trueupDue;
        uint64 trueupDeadline;
        // pauses
        uint64 pauseNonce;
        bool pauseRequested;
        uint64 pauseStart;
        uint64 pauseEnd;
        uint64 pausedTotal;
        bool formalNoticeEmitted;
        uint32 formalNoticeEmittedFor;
        // commitments
        bytes32 lastIncomeCommitment;
        uint32 lastIncomePeriod;
        bool hasIncomeCommitment;
        SeriesStatus storedStatus;
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
        uint64 accrualPaid;
        uint64 paidAt;
        uint64 due;
    }

    struct Router {
        bool configured;
        uint64 theta;
        uint64 rWad;
        uint16 ytdYear;
        uint64 ytdReceived;
        address receiver;
    }

    struct Groth16Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    struct ReportInput {
        uint256 seriesId;
        uint32 period;
        uint64 paymentUsd;
        uint64 fxAvgWad;
        bytes fxFallbackSignature;
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
    event PauseRequested(uint256 indexed series);
    event PauseApproved(uint256 indexed series, uint64 start, uint64 end, address indexed attestor);
    event PauseEnded(uint256 indexed series, uint64 pausedTotal);
    event IncomeRouted(uint256 indexed series, uint64 amount, uint64 passThrough, uint64 routed, uint64 ytdReceived);
    event RouterTermsSet(uint256 indexed series, uint64 theta, uint64 rWad, address receiver);
    event TrueUpRecorded(uint256 indexed series, uint16 year, int64 adjustment, uint64 deadline);
    event TrueUpPaid(uint256 indexed series, uint64 amount, uint64 accrual);
    event Groth16VerifierSet(address verifier);
    event FxAccumulatorSet(address fxAccumulator);

    // ---- reports and payments ----
    function submitReport(ReportInput calldata input) external;
    function pay(uint256 seriesId) external;
    function submitTrueUp(uint256 seriesId, uint16 year, int64 adjustment, uint64 attestationTs, bytes calldata sig)
        external;
    function payTrueUp(uint256 seriesId) external;

    // ---- status machine ----
    function crankStatus(uint256 seriesId) external;
    function requestPause(uint256 seriesId) external;
    function approvePause(uint256 seriesId, uint64 pauseEnd, bytes calldata attestorSignature) external;
    function endPause(uint256 seriesId) external;
    function deriveStatus(uint256 seriesId) external view returns (SeriesStatus);
    function deriveStatusAt(uint256 seriesId, uint256 timestamp) external view returns (SeriesStatus);
    function effectiveNow(uint256 seriesId, uint256 timestamp) external view returns (uint256);
    function nextExpectedPeriod(uint256 seriesId) external view returns (uint32);
    function lateAccrual(uint256 seriesId, uint32 period, uint64 amount, uint256 timestamp)
        external
        view
        returns (uint64);

    // ---- tier-1 router ----
    function setRouterTerms(uint256 seriesId, uint64 theta, uint64 rWad) external;
    function route(uint256 seriesId, uint64 amount) external;
    function sweep(uint256 seriesId) external;

    // ---- protocol ----
    function clearDues(uint256 seriesId) external;

    // ---- views ----
    function getLedger(uint256 seriesId) external view returns (Ledger memory);
    function getReport(uint256 seriesId, uint32 period) external view returns (Report memory);
    function getRouter(uint256 seriesId) external view returns (Router memory);
    function openDue(uint256 seriesId) external view returns (uint64 amount, uint32 period);
    function trueupDue(uint256 seriesId) external view returns (uint64);
    function lastPaidPeriod(uint256 seriesId) external view returns (bool hasPaid, uint32 period);
    function groth16Verifier() external view returns (address);
    function fxAccumulator() external view returns (address);
}
