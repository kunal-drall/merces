// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {
    Flags,
    FxPairConfig,
    Issuer,
    KeyInfo,
    Parameters,
    ProtocolContracts,
    RaiseState,
    ReleaseTranche,
    RouterTerms,
    SeriesCore,
    SeriesMode,
    SeriesParams,
    SeriesStatus,
    SeriesTerms,
    Tier1Terms
} from "../types/MercesTypes.sol";

/// @notice Charter and terms registry (D1) plus the registries of D11 (SPEC v1.1 §3). Non-upgradeable.
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
    event AttestorRevoked(address indexed attestor, uint64 revokedAt);
    event VerifierKeyRegistered(address indexed verifierKey);
    event VerifierKeyRevoked(address indexed verifierKey, uint64 revokedAt);
    event FxPairSet(
        bytes32 indexed pairId,
        bytes32 feedId,
        bool inverted,
        address crosscheck,
        uint32 crosscheckEffectivePeriod,
        bool enabled
    );
    event StablecoinSet(address indexed stablecoin, bool allowed, uint8 decimals);
    event IssuerRegistered(address indexed issuer);
    event IssuerDeactivated(address indexed issuer);
    event IssuanceStopped(address indexed issuer);
    event IssuanceResumed(address indexed issuer);
    event AllowlistUpdated(address indexed wallet, bool allowed);
    /// @dev EVM-only: the wallet's ONCHAINID identity was registered in the shared T-REX `IdentityRegistry`.
    event IdentityRegistered(address indexed wallet, address identity);
    /// @dev SPEC §10 `SeriesCreated(series, issuer, mode, stablecoin, units_offered, reserve_price, min_raise,
    /// cap_multiple_wad, hurdle_rate_wad, k, lockup_seconds, wallet_cap_bps, fees…, terms_commitment, tier_flags,
    /// fx_pair_id)`: the charter terms travel as the `terms` tuple (named components, k = `payoutMultipleK`).
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
    /// @dev EVM-only mirror of the protocol's `RaiseMintFinalized`, written through the narrow interface.
    event MintFinalized(uint256 indexed series);
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
    function poseidon5() external view returns (address);
    function getFlags() external view returns (Flags memory);
    function getDefaults() external view returns (Parameters memory);
    function getProtocolContracts() external view returns (ProtocolContracts memory);
    function isAllowed(address wallet) external view returns (bool);
    function isAttestor(address key) external view returns (bool);
    function isVerifierKey(address key) external view returns (bool);
    function attestorKey(address key) external view returns (KeyInfo memory);
    function verifierKey(address key) external view returns (KeyInfo memory);
    function isStablecoinAllowed(address token) external view returns (bool);
    function getIssuer(address wallet) external view returns (Issuer memory);
    function getFxPair(bytes32 pairId) external view returns (FxPairConfig memory);
    function fxPairId(bytes32 feedId, bool inverted) external pure returns (bytes32);

    // ---- series views ----
    function getSeriesCore(uint256 seriesId) external view returns (SeriesCore memory);
    function getSeriesTerms(uint256 seriesId) external view returns (SeriesTerms memory);
    function getReleaseSchedule(uint256 seriesId) external view returns (ReleaseTranche[] memory);
    /// @notice Plaintext θ / r of a tier-1 series (zero for other series).
    function getRouterTerms(uint256 seriesId) external view returns (RouterTerms memory);
    function isTransferLocked(uint256 seriesId, uint256 timestamp) external view returns (bool);

    // ---- admin ----
    function setAllowlistManager(address manager) external;
    function setFeeCollector(address collector) external;
    function setFlags(bool newRaisesPaused, bool windowsEnabled, bool tier4Enabled) external;
    function setEarlyDrawApprover(address approver) external;
    function setDefaults(Parameters calldata defaults) external;
    function registerAttestor(address key) external;
    function revokeAttestor(address key) external;
    function rotateAttestor(address oldKey, address newKey) external;
    function registerVerifierKey(address key) external;
    function revokeVerifierKey(address key) external;
    function rotateVerifierKey(address oldKey, address newKey) external;
    /// @notice Registers a new FX pair (write-once: `FxPairExists` for a known `(feed_id, inverted)`).
    function setFxPair(bytes32 feedId, bool inverted, address crosscheck) external returns (bytes32 pairId);
    /// @notice `enabled = false` only stops new series from referencing the pair; snapshots stay permissionless.
    function setFxPairEnabled(bytes32 pairId, bool enabled) external;
    /// @notice Sets or changes the Chainlink cross-check feed: from zero it applies now, later changes apply from
    /// the next period (a live quarter's rule never changes under an issuer).
    function setFxPairCrosscheck(bytes32 pairId, address crosscheck) external;
    function setStablecoin(address token, bool allowed) external;
    function registerIssuer(address wallet) external;
    function deactivateIssuer(address wallet) external;
    function transferAdmin(address newAdmin) external;
    function acceptAdmin() external;
    function registerProtocolIdentities() external;

    // ---- allowlist manager ----
    function setAllowed(address wallet, bool allowed) external;

    // ---- issuer ----
    function createSeries(
        SeriesParams calldata params,
        ReleaseTranche[] calldata releaseSchedule,
        bytes32 termsCommitment,
        uint8 tierFlags,
        bytes32 fxPairId_,
        SeriesMode mode,
        bool issuerAcceptsPublicPrice,
        Tier1Terms calldata tier1Terms
    ) external returns (uint256 seriesId);
    function setContractHash(uint256 seriesId, bytes32 hash) external;
    function stopIssuance() external;
    function resumeIssuance() external;
    function amendTerms(
        uint256 seriesId,
        bytes32 newTermsCommitment,
        uint256 newCapMultipleWad,
        bytes calldata attestorSignature,
        Tier1Terms calldata tier1Terms
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
    function markMintFinalized(uint256 seriesId) external;
    function markTerminal(uint256 seriesId, SeriesStatus status) external;
}
