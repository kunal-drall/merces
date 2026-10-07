// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {
    Flags,
    FxPairConfig,
    Issuer,
    Parameters,
    ProtocolContracts,
    RaiseState,
    ReleaseTranche,
    SeriesCore,
    SeriesMode,
    SeriesParams,
    SeriesStatus,
    SeriesTerms
} from "../types/MercesTypes.sol";

/// @notice Charter and terms registry (D1) plus the registries of D11 (SPEC §3). Non-upgradeable.
interface IMercesRegistry {
    // ---- events (SPEC §10, registry) ----
    event ProtocolInitialized(
        address indexed admin, address allowlistManager, address feeCollector, uint64 chainId, bytes32 domain
    );
    event AdminTransferStarted(address indexed pendingAdmin);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event AllowlistManagerSet(address indexed allowlistManager);
    event FeeCollectorSet(address indexed feeCollector);
    event FlagsSet(bool newRaisesPaused, bool windowsEnabled, bool tier4Enabled);
    event EarlyDrawApproverSet(address indexed earlyDrawApprover);
    event DefaultsSet(Parameters defaults);
    event AttestorRegistered(address indexed attestor);
    event AttestorRevoked(address indexed attestor);
    event VerifierKeyRegistered(address indexed verifierKey);
    event VerifierKeyRevoked(address indexed verifierKey);
    event FxPairSet(bytes32 indexed pairId, bytes32 feedId, bool inverted, address crosscheck, bool enabled);
    event StablecoinSet(address indexed stablecoin, bool allowed, uint8 decimals);
    event ProtocolContractsSet(ProtocolContracts contracts);
    event IssuerRegistered(address indexed issuer);
    event IssuerDeactivated(address indexed issuer);
    event IssuanceStopped(address indexed issuer);
    event IssuanceResumed(address indexed issuer);
    event AllowlistUpdated(address indexed wallet, bool allowed);
    event SeriesCreated(
        uint256 indexed series,
        address indexed issuer,
        SeriesMode mode,
        address stablecoin,
        SeriesTerms terms,
        bytes32 termsCommitment,
        uint8 tierFlags,
        bytes32 fxPairId
    );
    event ContractHashSet(uint256 indexed series, bytes32 hash);
    event TermsAmended(
        uint256 indexed series,
        uint64 nonce,
        bytes32 newTermsCommitment,
        uint64 newCapMultipleWad,
        address indexed attestor
    );
    event RaiseStateChanged(uint256 indexed series, RaiseState state);
    event TerminalStatusSet(uint256 indexed series, SeriesStatus status);

    // ---- config views ----
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function allowlistManager() external view returns (address);
    function feeCollector() external view returns (address);
    function domain() external view returns (bytes32);
    function chainId() external view returns (uint64);
    function earlyDrawApprover() external view returns (address);
    function seriesCount() external view returns (uint64);
    function identityRegistry() external view returns (address);
    function idFactory() external view returns (address);
    function getFlags() external view returns (Flags memory);
    function getDefaults() external view returns (Parameters memory);
    function getProtocolContracts() external view returns (ProtocolContracts memory);
    function protocolContractsSet() external view returns (bool);
    function isAllowed(address wallet) external view returns (bool);
    function isAttestor(address key) external view returns (bool);
    function isVerifierKey(address key) external view returns (bool);
    function isStablecoinAllowed(address token) external view returns (bool);
    function getIssuer(address wallet) external view returns (Issuer memory);
    function getFxPair(bytes32 pairId) external view returns (FxPairConfig memory);

    // ---- series views ----
    function getSeriesCore(uint256 seriesId) external view returns (SeriesCore memory);
    function getSeriesTerms(uint256 seriesId) external view returns (SeriesTerms memory);
    function getReleaseSchedule(uint256 seriesId) external view returns (ReleaseTranche[] memory);
    function isTransferLocked(uint256 seriesId, uint256 timestamp) external view returns (bool);

    // ---- admin ----
    function setAllowlistManager(address manager) external;
    function setFeeCollector(address collector) external;
    function setFlags(bool newRaisesPaused, bool windowsEnabled, bool tier4Enabled) external;
    function setEarlyDrawApprover(address approver) external;
    function setDefaults(Parameters calldata defaults) external;
    function registerAttestor(address key) external;
    function revokeAttestor(address key) external;
    function registerVerifierKey(address key) external;
    function revokeVerifierKey(address key) external;
    function setFxPair(bytes32 pairId, bytes32 feedId, bool inverted, address crosscheck, bool enabled) external;
    function setStablecoin(address token, bool allowed) external;
    function setProtocolContracts(ProtocolContracts calldata contracts) external;
    function registerIssuer(address wallet) external;
    function deactivateIssuer(address wallet) external;
    function transferAdmin(address newAdmin) external;
    function acceptAdmin() external;

    // ---- allowlist manager ----
    function setAllowed(address wallet, bool allowed) external;

    // ---- issuer ----
    function createSeries(
        SeriesParams calldata params,
        ReleaseTranche[] calldata releaseSchedule,
        bytes32 termsCommitment,
        uint8 tierFlags,
        bytes32 fxPairId,
        SeriesMode mode,
        bool issuerAcceptsPublicPrice
    ) external returns (uint256 seriesId);
    function setContractHash(uint256 seriesId, bytes32 hash) external;
    function stopIssuance() external;
    function resumeIssuance() external;
    function amendTerms(
        uint256 seriesId,
        bytes32 newTermsCommitment,
        uint64 newCapMultipleWad,
        bytes calldata attestorSignature
    ) external;

    // ---- protocol write interface (SPEC §3.3) ----
    function markRaiseOpened(uint256 seriesId, address unitToken, uint64 openedAt) external;
    function markRaiseResult(
        uint256 seriesId,
        RaiseState state,
        uint64 settlementTs,
        uint64 unitsSold,
        uint64 clearingPrice
    ) external;
    function markTerminal(uint256 seriesId, SeriesStatus status) external;
}
