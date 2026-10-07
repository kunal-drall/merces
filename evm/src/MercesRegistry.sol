// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IMercesRegistry} from "./interfaces/IMercesRegistry.sol";
import {IIdentityRegistryLite} from "./interfaces/external/IIdentityRegistryLite.sol";
import {IIdFactoryLite} from "./interfaces/external/IIdFactoryLite.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesMessages} from "./libraries/MercesMessages.sol";
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
    SeriesTerms,
    TierFlags
} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesRegistry
/// @notice D1 charter & terms registry, D11 registries (allowlist, attestors, report-verifier keys) and
/// protocol configuration (SPEC §3). Deployed once per chain, **not upgradeable**: charter data has no
/// upgrade path. The EVM allowlist *is* T-REX identity-registry membership (SPEC §4.2): the registry is an
/// agent of the shared `IdentityRegistry` and owns the ONCHAINID `IdFactory`, so `setAllowed` registers a
/// wallet with a freshly deployed `Identity` (country 0) and removal is `deleteIdentity`.
contract MercesRegistry is IMercesRegistry {
    using MercesMath for uint256;

    // ---------------------------------------------------------------- storage

    address public override admin;
    address public override pendingAdmin;
    address public override allowlistManager;
    address public override feeCollector;
    address public override earlyDrawApprover;
    uint64 public override seriesCount;
    bool public override protocolContractsSet;

    bytes32 public immutable override domain;
    uint64 public immutable override chainId;
    IIdentityRegistryLite internal immutable _identityRegistry;
    IIdFactoryLite internal immutable _idFactory;

    Flags internal _flags;
    Parameters internal _defaults;
    ProtocolContracts internal _contracts;

    mapping(address => Issuer) internal _issuers;
    mapping(address => bool) internal _attestors;
    mapping(address => bool) internal _verifierKeys;
    mapping(address => bool) internal _stablecoins;
    mapping(bytes32 => FxPairConfig) internal _fxPairs;

    mapping(uint256 => SeriesCore) internal _cores;
    mapping(uint256 => SeriesTerms) internal _terms;
    mapping(uint256 => ReleaseTranche[]) internal _schedules;

    // ---------------------------------------------------------------- modifiers

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyAllowlistManager() {
        if (msg.sender != allowlistManager) revert NotAllowlistManager();
        _;
    }

    modifier onlyAuction() {
        if (msg.sender != _contracts.auction || msg.sender == address(0)) revert NotProtocolContract();
        _;
    }

    modifier onlyVault() {
        if (msg.sender != _contracts.vault || msg.sender == address(0)) revert NotProtocolContract();
        _;
    }

    modifier seriesExists(uint256 seriesId) {
        if (seriesId == 0 || seriesId > seriesCount) revert SeriesNotFound(seriesId);
        _;
    }

    // ---------------------------------------------------------------- constructor (init_protocol)

    constructor(
        address admin_,
        address allowlistManager_,
        address feeCollector_,
        uint64 chainId_,
        Parameters memory defaults_,
        address identityRegistry_,
        address idFactory_
    ) {
        if (
            admin_ == address(0) || allowlistManager_ == address(0) || feeCollector_ == address(0)
                || identityRegistry_ == address(0) || idFactory_ == address(0)
        ) revert ZeroAddress();
        if (chainId_ != block.chainid) revert ChainIdMismatch(chainId_, block.chainid);
        _checkDefaults(defaults_);
        admin = admin_;
        allowlistManager = allowlistManager_;
        feeCollector = feeCollector_;
        chainId = chainId_;
        domain = MercesMessages.domain(chainId_, address(this));
        _defaults = defaults_;
        _identityRegistry = IIdentityRegistryLite(identityRegistry_);
        _idFactory = IIdFactoryLite(idFactory_);
        emit ProtocolInitialized(admin_, allowlistManager_, feeCollector_, chainId_, domain);
        emit DefaultsSet(defaults_);
    }

    // ---------------------------------------------------------------- views

    function identityRegistry() external view override returns (address) {
        return address(_identityRegistry);
    }

    function idFactory() external view override returns (address) {
        return address(_idFactory);
    }

    function getFlags() external view override returns (Flags memory) {
        return _flags;
    }

    function getDefaults() external view override returns (Parameters memory) {
        return _defaults;
    }

    function getProtocolContracts() external view override returns (ProtocolContracts memory) {
        return _contracts;
    }

    /// @inheritdoc IMercesRegistry
    function isAllowed(address wallet) public view override returns (bool) {
        return _identityRegistry.isVerified(wallet);
    }

    function isAttestor(address key) external view override returns (bool) {
        return _attestors[key];
    }

    function isVerifierKey(address key) external view override returns (bool) {
        return _verifierKeys[key];
    }

    function isStablecoinAllowed(address token) external view override returns (bool) {
        return _stablecoins[token];
    }

    function getIssuer(address wallet) external view override returns (Issuer memory) {
        return _issuers[wallet];
    }

    function getFxPair(bytes32 pairId) external view override returns (FxPairConfig memory) {
        return _fxPairs[pairId];
    }

    function getSeriesCore(uint256 seriesId) external view override seriesExists(seriesId) returns (SeriesCore memory) {
        return _cores[seriesId];
    }

    function getSeriesTerms(uint256 seriesId)
        external
        view
        override
        seriesExists(seriesId)
        returns (SeriesTerms memory)
    {
        return _terms[seriesId];
    }

    function getReleaseSchedule(uint256 seriesId)
        external
        view
        override
        seriesExists(seriesId)
        returns (ReleaseTranche[] memory)
    {
        return _schedules[seriesId];
    }

    /// @inheritdoc IMercesRegistry
    function isTransferLocked(uint256 seriesId, uint256 timestamp)
        external
        view
        override
        seriesExists(seriesId)
        returns (bool)
    {
        SeriesCore storage core = _cores[seriesId];
        return core.raiseState != RaiseState.Settled
            || timestamp < uint256(core.settlementTs) + _terms[seriesId].lockupSeconds;
    }

    // ---------------------------------------------------------------- admin

    function setAllowlistManager(address manager) external override onlyAdmin {
        if (manager == address(0)) revert ZeroAddress();
        allowlistManager = manager;
        emit AllowlistManagerSet(manager);
    }

    function setFeeCollector(address collector) external override onlyAdmin {
        if (collector == address(0)) revert ZeroAddress();
        feeCollector = collector;
        emit FeeCollectorSet(collector);
    }

    function setFlags(bool newRaisesPaused, bool windowsEnabled, bool tier4Enabled) external override onlyAdmin {
        _flags = Flags({newRaisesPaused: newRaisesPaused, windowsEnabled: windowsEnabled, tier4Enabled: tier4Enabled});
        emit FlagsSet(newRaisesPaused, windowsEnabled, tier4Enabled);
    }

    function setEarlyDrawApprover(address approver) external override onlyAdmin {
        earlyDrawApprover = approver;
        emit EarlyDrawApproverSet(approver);
    }

    /// @notice Edits the defaults for *future* series only (existing series keep their copied terms).
    function setDefaults(Parameters calldata defaults) external override onlyAdmin {
        _checkDefaults(defaults);
        _defaults = defaults;
        emit DefaultsSet(defaults);
    }

    function registerAttestor(address key) external override onlyAdmin {
        if (key == address(0)) revert ZeroAddress();
        _attestors[key] = true;
        emit AttestorRegistered(key);
    }

    function revokeAttestor(address key) external override onlyAdmin {
        _attestors[key] = false;
        emit AttestorRevoked(key);
    }

    function registerVerifierKey(address key) external override onlyAdmin {
        if (key == address(0)) revert ZeroAddress();
        _verifierKeys[key] = true;
        emit VerifierKeyRegistered(key);
    }

    function revokeVerifierKey(address key) external override onlyAdmin {
        _verifierKeys[key] = false;
        emit VerifierKeyRevoked(key);
    }

    function setFxPair(bytes32 pairId, bytes32 feedId, bool inverted, address crosscheck, bool enabled)
        external
        override
        onlyAdmin
    {
        if (pairId == bytes32(0)) revert UnknownFxPair(pairId);
        _fxPairs[pairId] = FxPairConfig({feedId: feedId, inverted: inverted, crosscheck: crosscheck, enabled: enabled});
        emit FxPairSet(pairId, feedId, inverted, crosscheck, enabled);
    }

    /// @notice Allow or disallow a settlement stablecoin. Decimals are read from the token, never assumed.
    function setStablecoin(address token, bool allowed) external override onlyAdmin {
        if (token == address(0)) revert ZeroAddress();
        uint8 decimals = IERC20Metadata(token).decimals();
        _stablecoins[token] = allowed;
        emit StablecoinSet(token, allowed, decimals);
    }

    /// @notice Registers the protocol contracts allowed to call the narrow write interface. One-shot: the
    /// money contracts are UUPS proxies whose addresses never change, so there is no reason to re-point.
    function setProtocolContracts(ProtocolContracts calldata contracts) external override onlyAdmin {
        if (protocolContractsSet) revert ProtocolContractsAlreadySet();
        if (
            contracts.auction == address(0) || contracts.treasury == address(0) || contracts.income == address(0)
                || contracts.vault == address(0) || contracts.window == address(0)
                || contracts.tokenFactory == address(0)
        ) revert ZeroAddress();
        _contracts = contracts;
        protocolContractsSet = true;
        emit ProtocolContractsSet(contracts);
    }

    function registerIssuer(address wallet) external override onlyAdmin {
        if (wallet == address(0)) revert ZeroAddress();
        Issuer storage issuer = _issuers[wallet];
        issuer.registered = true;
        issuer.active = true;
        emit IssuerRegistered(wallet);
    }

    /// @notice Blocks *new* series only; live series are untouched.
    function deactivateIssuer(address wallet) external override onlyAdmin {
        _issuers[wallet].active = false;
        emit IssuerDeactivated(wallet);
    }

    function transferAdmin(address newAdmin) external override onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(newAdmin);
    }

    function acceptAdmin() external override {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        address old = admin;
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminTransferred(old, msg.sender);
    }

    // ---------------------------------------------------------------- allowlist manager

    /// @inheritdoc IMercesRegistry
    function setAllowed(address wallet, bool allowed) external override onlyAllowlistManager {
        if (wallet == address(0)) revert ZeroAddress();
        if (allowed) {
            if (!_identityRegistry.contains(wallet)) {
                address identity = _idFactory.getIdentity(wallet);
                if (identity == address(0)) {
                    identity = _idFactory.createIdentity(wallet, Strings.toHexString(wallet));
                }
                _identityRegistry.registerIdentity(wallet, identity, 0);
            }
        } else if (_identityRegistry.contains(wallet)) {
            _identityRegistry.deleteIdentity(wallet);
        }
        emit AllowlistUpdated(wallet, allowed);
    }

    // ---------------------------------------------------------------- issuer

    /// @inheritdoc IMercesRegistry
    function createSeries(
        SeriesParams calldata p,
        ReleaseTranche[] calldata releaseSchedule,
        bytes32 termsCommitment,
        uint8 tierFlags,
        bytes32 fxPairId,
        SeriesMode mode,
        bool issuerAcceptsPublicPrice
    ) external override returns (uint256 seriesId) {
        _checkCreate(p, termsCommitment, tierFlags, fxPairId, mode);
        _checkSchedule(releaseSchedule);

        seriesId = ++seriesCount;
        _issuers[msg.sender].seriesCount += 1;
        _storeTerms(seriesId, p);

        SeriesCore storage core = _cores[seriesId];
        core.issuer = msg.sender;
        core.mode = mode;
        core.stablecoin = p.stablecoin;
        core.stablecoinDecimals = IERC20Metadata(p.stablecoin).decimals();
        core.raiseState = RaiseState.Draft;
        core.tierFlags = tierFlags;
        core.fxPairId = fxPairId;
        core.issuerAcceptsPublicPrice = issuerAcceptsPublicPrice;
        core.termsCommitment = termsCommitment;

        ReleaseTranche[] storage schedule = _schedules[seriesId];
        for (uint256 i = 0; i < releaseSchedule.length; i++) {
            schedule.push(releaseSchedule[i]);
        }

        emit SeriesCreated(
            seriesId, msg.sender, mode, p.stablecoin, _terms[seriesId], termsCommitment, tierFlags, fxPairId
        );
    }

    function _checkCreate(
        SeriesParams calldata p,
        bytes32 termsCommitment,
        uint8 tierFlags,
        bytes32 fxPairId,
        SeriesMode mode
    ) internal view {
        Issuer storage issuer = _issuers[msg.sender];
        if (!issuer.registered || !issuer.active) revert IssuerNotActive();
        if (issuer.issuanceStopped) revert IssuanceStoppedByIssuer();
        if (!isAllowed(msg.sender)) revert IssuerNotAllowlisted();
        if (mode != SeriesMode.SealedBid) revert CurveModeUnsupported();
        if (!_stablecoins[p.stablecoin]) revert StablecoinNotAllowed(p.stablecoin);
        if (p.unitsOffered < 1) revert InvalidUnitsOffered();
        if (p.reservePrice < 1) revert InvalidReservePrice();
        // reserve × units must stay in the shared uint64 money domain, and bounds the minimum raise
        uint256 maxProceeds = uint256(p.reservePrice) * p.unitsOffered;
        maxProceeds.toU64();
        if (p.minRaise > maxProceeds) revert MinRaiseTooHigh();
        if (tierFlags == 0 || tierFlags & ~TierFlags.ALL != 0) revert InvalidTierFlags();
        if (fxPairId != bytes32(0) && !_fxPairs[fxPairId].enabled) revert UnknownFxPair(fxPairId);
        if (termsCommitment == bytes32(0)) revert ParameterOutOfBounds("termsCommitment");
        _checkSeriesParams(p);
    }

    /// @dev Issuer-chosen terms are copied from `p`; market and fee parameters are copied from the protocol
    /// defaults in force at creation (they are protocol economics, not issuer choices).
    function _storeTerms(uint256 seriesId, SeriesParams calldata p) internal {
        Parameters storage d = _defaults;
        SeriesTerms storage t = _terms[seriesId];
        t.unitsOffered = p.unitsOffered;
        t.reservePrice = p.reservePrice;
        t.minRaise = p.minRaise;
        t.capMultipleWad = p.capMultipleWad;
        t.hurdleRateWad = p.hurdleRateWad;
        t.payoutMultipleK = p.payoutMultipleK;
        t.lockupSeconds = p.lockupSeconds;
        t.walletCapBps = d.walletCapBps;
        t.auctionFeeBps = d.auctionFeeBps;
        t.payoutFeeBps = d.payoutFeeBps;
        t.windowFeeBps = d.windowFeeBps;
        t.nonRevealChargeBps = d.nonRevealChargeBps;
        t.commitDuration = p.commitDuration;
        t.revealDuration = p.revealDuration;
        t.windowCommitDuration = p.windowCommitDuration;
        t.windowRevealDuration = p.windowRevealDuration;
    }

    /// @inheritdoc IMercesRegistry
    function setContractHash(uint256 seriesId, bytes32 hash) external override seriesExists(seriesId) {
        SeriesCore storage core = _cores[seriesId];
        if (msg.sender != core.issuer) revert NotIssuer();
        if (core.raiseState != RaiseState.Draft) revert SeriesNotDraft();
        if (hash == bytes32(0)) revert ContractHashZero();
        core.contractHash = hash;
        emit ContractHashSet(seriesId, hash);
    }

    function stopIssuance() external override {
        Issuer storage issuer = _issuers[msg.sender];
        if (!issuer.registered) revert NotIssuer();
        issuer.issuanceStopped = true;
        emit IssuanceStopped(msg.sender);
    }

    function resumeIssuance() external override {
        Issuer storage issuer = _issuers[msg.sender];
        if (!issuer.registered) revert NotIssuer();
        issuer.issuanceStopped = false;
        emit IssuanceResumed(msg.sender);
    }

    /// @inheritdoc IMercesRegistry
    /// @dev Issuer signs the transaction; a registered attestor signs the SPEC §1.4 amendment message over the
    /// current nonce. The cap multiple may only decrease (brief C4).
    function amendTerms(
        uint256 seriesId,
        bytes32 newTermsCommitment,
        uint64 newCapMultipleWad,
        bytes calldata attestorSignature
    ) external override seriesExists(seriesId) {
        SeriesCore storage core = _cores[seriesId];
        SeriesTerms storage terms = _terms[seriesId];
        if (msg.sender != core.issuer) revert NotIssuer();
        if (core.terminalStatus != 0) revert SeriesTerminal();
        if (newTermsCommitment == bytes32(0)) revert ParameterOutOfBounds("termsCommitment");
        if (newCapMultipleWad > terms.capMultipleWad) revert CapMultipleIncrease();
        if (newCapMultipleWad < C.CAP_MULTIPLE_MIN) revert ParameterOutOfBounds("capMultipleWad");
        uint64 nonce = core.amendmentNonce;
        bytes32 digest = MercesMessages.amendDigest(domain, seriesId, nonce, newTermsCommitment, newCapMultipleWad);
        address signer = ECDSA.recover(digest, attestorSignature);
        if (!_attestors[signer]) revert AttestorNotRegistered(signer);
        core.amendmentNonce = nonce + 1;
        core.termsCommitment = newTermsCommitment;
        terms.capMultipleWad = newCapMultipleWad;
        emit TermsAmended(seriesId, nonce, newTermsCommitment, newCapMultipleWad, signer);
    }

    // ---------------------------------------------------------------- protocol write interface

    /// @inheritdoc IMercesRegistry
    function markRaiseOpened(uint256 seriesId, address unitToken, uint64 openedAt)
        external
        override
        onlyAuction
        seriesExists(seriesId)
    {
        SeriesCore storage core = _cores[seriesId];
        if (core.raiseState != RaiseState.Draft) revert InvalidRaiseTransition();
        if (unitToken == address(0)) revert ZeroAddress();
        core.unitToken = unitToken;
        core.openedAt = openedAt;
        core.raiseState = RaiseState.Open;
        emit RaiseStateChanged(seriesId, RaiseState.Open);
    }

    /// @inheritdoc IMercesRegistry
    /// @dev Open → Settled / Failed / Cancelled. One correction is allowed: Settled → Settled with a lower
    /// (exact) `unitsSold` once every winning bid has been processed (SPEC §5.2).
    function markRaiseResult(
        uint256 seriesId,
        RaiseState state,
        uint64 settlementTs,
        uint64 unitsSold,
        uint64 clearingPrice
    ) external override onlyAuction seriesExists(seriesId) {
        SeriesCore storage core = _cores[seriesId];
        if (state != RaiseState.Settled && state != RaiseState.Failed && state != RaiseState.Cancelled) {
            revert InvalidRaiseTransition();
        }
        if (core.raiseState == RaiseState.Open) {
            // first result
        } else if (core.raiseState == RaiseState.Settled && state == RaiseState.Settled) {
            if (unitsSold > core.unitsSold) revert UnitsSoldIncrease();
            if (settlementTs != core.settlementTs || clearingPrice != core.clearingPrice) {
                revert InvalidRaiseTransition();
            }
        } else {
            revert InvalidRaiseTransition();
        }
        core.raiseState = state;
        core.settlementTs = settlementTs;
        core.unitsSold = unitsSold;
        core.clearingPrice = clearingPrice;
        emit RaiseStateChanged(seriesId, state);
    }

    /// @inheritdoc IMercesRegistry
    function markTerminal(uint256 seriesId, SeriesStatus status) external override onlyVault seriesExists(seriesId) {
        SeriesCore storage core = _cores[seriesId];
        if (status != SeriesStatus.Retired && status != SeriesStatus.Redeemed && status != SeriesStatus.Extinguished)
        {
            revert InvalidTerminalStatus();
        }
        if (core.terminalStatus != 0) {
            // a redeemed series may still be extinguished during its tail (SPEC §6.9)
            if (
                !(core.terminalStatus == uint8(SeriesStatus.Redeemed) && status == SeriesStatus.Extinguished)
            ) revert AlreadyTerminal();
        }
        core.terminalStatus = uint8(status);
        emit TerminalStatusSet(seriesId, status);
    }

    // ---------------------------------------------------------------- bounds (SPEC §1.6)

    function _checkDefaults(Parameters memory d) internal pure {
        _bound(d.capMultipleWad, C.CAP_MULTIPLE_MIN, C.CAP_MULTIPLE_MAX, "capMultipleWad");
        _bound(d.hurdleRateWad, 0, C.HURDLE_MAX, "hurdleRateWad");
        _bound(d.payoutMultipleK, C.K_MIN, C.K_MAX, "payoutMultipleK");
        _bound(d.lockupSeconds, 0, C.LOCKUP_MAX, "lockupSeconds");
        _bound(d.walletCapBps, C.WALLET_CAP_MIN, C.WALLET_CAP_MAX, "walletCapBps");
        _bound(d.auctionFeeBps, 0, C.AUCTION_FEE_MAX, "auctionFeeBps");
        _bound(d.payoutFeeBps, 0, C.PAYOUT_FEE_MAX, "payoutFeeBps");
        _bound(d.windowFeeBps, 0, C.WINDOW_FEE_MAX, "windowFeeBps");
        _bound(d.nonRevealChargeBps, 0, C.NON_REVEAL_MAX, "nonRevealChargeBps");
        _bound(d.commitDuration, C.COMMIT_MIN, C.COMMIT_MAX, "commitDuration");
        _bound(d.revealDuration, C.REVEAL_MIN, C.REVEAL_MAX, "revealDuration");
        _bound(d.windowCommitDuration, C.WINDOW_COMMIT_MIN, C.WINDOW_COMMIT_MAX, "windowCommitDuration");
        _bound(d.windowRevealDuration, C.WINDOW_REVEAL_MIN, C.WINDOW_REVEAL_MAX, "windowRevealDuration");
        _bound(d.fxMinCoverageBps, C.FX_COVERAGE_MIN, C.FX_COVERAGE_MAX, "fxMinCoverageBps");
        _bound(d.fxMaxStalenessSeconds, C.FX_STALENESS_MIN, C.FX_STALENESS_MAX, "fxMaxStalenessSeconds");
        _bound(d.fxMaxConfBps, C.FX_CONF_MIN, C.FX_CONF_MAX, "fxMaxConfBps");
        _bound(d.fxDeviationBandBps, C.FX_BAND_MIN, C.FX_BAND_MAX, "fxDeviationBandBps");
    }

    function _checkSeriesParams(SeriesParams calldata p) internal pure {
        _bound(p.capMultipleWad, C.CAP_MULTIPLE_MIN, C.CAP_MULTIPLE_MAX, "capMultipleWad");
        _bound(p.hurdleRateWad, 0, C.HURDLE_MAX, "hurdleRateWad");
        _bound(p.payoutMultipleK, C.K_MIN, C.K_MAX, "payoutMultipleK");
        _bound(p.lockupSeconds, 0, C.LOCKUP_MAX, "lockupSeconds");
        _bound(p.commitDuration, C.COMMIT_MIN, C.COMMIT_MAX, "commitDuration");
        _bound(p.revealDuration, C.REVEAL_MIN, C.REVEAL_MAX, "revealDuration");
        _bound(p.windowCommitDuration, C.WINDOW_COMMIT_MIN, C.WINDOW_COMMIT_MAX, "windowCommitDuration");
        _bound(p.windowRevealDuration, C.WINDOW_REVEAL_MIN, C.WINDOW_REVEAL_MAX, "windowRevealDuration");
    }

    function _checkSchedule(ReleaseTranche[] calldata schedule) internal pure {
        uint256 n = schedule.length;
        if (n == 0 || n > C.MAX_RELEASE_TRANCHES) revert InvalidReleaseSchedule();
        uint256 sum;
        uint64 lastOffset;
        for (uint256 i = 0; i < n; i++) {
            if (schedule[i].atOffsetSeconds < lastOffset) revert InvalidReleaseSchedule();
            lastOffset = schedule[i].atOffsetSeconds;
            sum += schedule[i].bps;
        }
        if (sum != C.BPS) revert InvalidReleaseSchedule();
    }

    function _bound(uint256 value, uint256 lo, uint256 hi, bytes32 name) internal pure {
        if (value < lo || value > hi) revert ParameterOutOfBounds(name);
    }
}
