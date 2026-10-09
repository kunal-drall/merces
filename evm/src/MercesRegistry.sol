// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IMercesRegistry} from "./interfaces/IMercesRegistry.sol";
import {IIdentityRegistryLite} from "./interfaces/external/IIdentityRegistryLite.sol";
import {IIdFactoryLite} from "./interfaces/external/IIdFactoryLite.sol";
import {IPoseidon5} from "./interfaces/IPoseidon.sol";
import {MercesConstants as C} from "./libraries/MercesConstants.sol";
import {MercesMath} from "./libraries/MercesMath.sol";
import {MercesMessages} from "./libraries/MercesMessages.sol";
import {Periods} from "./libraries/Periods.sol";
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
    Tier1Terms,
    TierFlags
} from "./types/MercesTypes.sol";
import "./types/MercesErrors.sol";

/// @title MercesRegistry
/// @notice D1 charter & terms registry, D11 registries (allowlist, attestors, report-verifier keys, FX pairs) and
/// protocol configuration (SPEC v1.1 §3). Deployed once per chain, **not upgradeable**: charter data has no
/// upgrade path. The protocol contracts allowed to call the narrow write interface are fixed at construction.
///
/// Allowlist vs identity (SPEC §4.2): `isAllowed(w)` is a Merces flag. `setAllowed(w, true)` additionally
/// registers `w` once in the shared T-REX `IdentityRegistry` with an ONCHAINID `Identity` from the `IdFactory`
/// (country 0); identities are never deleted, so T-REX `isVerified` stays true for every wallet that was ever
/// allowlisted and protocol-initiated unit movements never fail on verification.
contract MercesRegistry is IMercesRegistry {
    using MercesMath for uint256;

    // ---------------------------------------------------------------- storage

    address public override admin;
    address public override pendingAdmin;
    address public override allowlistManager;
    address public override feeCollector;
    address public override earlyDrawApprover;
    uint64 public override seriesCount;

    bytes32 public immutable override domain;
    uint64 public immutable override chainId;
    IIdentityRegistryLite internal immutable _identityRegistry;
    IIdFactoryLite internal immutable _idFactory;
    IPoseidon5 internal immutable _poseidon5;

    Flags internal _flags;
    Parameters internal _defaults;
    ProtocolContracts internal _contracts;

    uint32 internal _activeAttestors;
    uint32 internal _activeVerifiers;
    mapping(address => KeyInfo) internal _attestors;
    mapping(address => KeyInfo) internal _verifierKeys;
    mapping(address => Issuer) internal _issuers;
    mapping(address => bool) internal _allowed;
    mapping(address => bool) internal _stablecoins;
    mapping(bytes32 => FxPairConfig) internal _fxPairs;

    mapping(uint256 => SeriesCore) internal _cores;
    mapping(uint256 => SeriesTerms) internal _terms;
    mapping(uint256 => ReleaseTranche[]) internal _schedules;
    mapping(uint256 => RouterTerms) internal _router;

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
        if (msg.sender != _contracts.auction) revert NotProtocolContract();
        _;
    }

    modifier onlyVault() {
        if (msg.sender != _contracts.vault) revert NotProtocolContract();
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
        address idFactory_,
        address poseidon5_,
        ProtocolContracts memory contracts_
    ) {
        if (
            admin_ == address(0) || allowlistManager_ == address(0) || feeCollector_ == address(0)
                || identityRegistry_ == address(0) || idFactory_ == address(0) || poseidon5_ == address(0)
        ) revert ZeroAddress();
        if (
            contracts_.auction == address(0) || contracts_.treasury == address(0) || contracts_.income == address(0)
                || contracts_.vault == address(0) || contracts_.window == address(0)
                || contracts_.tokenFactory == address(0)
        ) revert ZeroAddress();
        if (chainId_ != block.chainid) revert ChainIdMismatch(chainId_, block.chainid);
        _checkDefaults(defaults_);
        admin = admin_;
        allowlistManager = allowlistManager_;
        feeCollector = feeCollector_;
        chainId = chainId_;
        domain = MercesMessages.domain(chainId_, address(this));
        _defaults = defaults_;
        _contracts = contracts_;
        _identityRegistry = IIdentityRegistryLite(identityRegistry_);
        _idFactory = IIdFactoryLite(idFactory_);
        _poseidon5 = IPoseidon5(poseidon5_);
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

    function poseidon5() external view override returns (address) {
        return address(_poseidon5);
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
        return _allowed[wallet];
    }

    function isAttestor(address key) external view override returns (bool) {
        return _attestors[key].active;
    }

    function isVerifierKey(address key) external view override returns (bool) {
        return _verifierKeys[key].active;
    }

    function attestorKey(address key) external view override returns (KeyInfo memory) {
        return _attestors[key];
    }

    function verifierKey(address key) external view override returns (KeyInfo memory) {
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

    /// @inheritdoc IMercesRegistry
    function fxPairId(bytes32 feedId, bool inverted) public pure override returns (bytes32) {
        return keccak256(abi.encodePacked(feedId, inverted ? uint8(1) : uint8(0)));
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

    function getRouterTerms(uint256 seriesId)
        external
        view
        override
        seriesExists(seriesId)
        returns (RouterTerms memory)
    {
        return _router[seriesId];
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
        _register(_attestors, key, true);
    }

    /// @inheritdoc IMercesRegistry
    /// @dev Forward-only (SPEC §1.4): records `revokedAt`; refuses to revoke the last active key.
    function revokeAttestor(address key) external override onlyAdmin {
        _revoke(_attestors, key, true);
    }

    function rotateAttestor(address oldKey, address newKey) external override onlyAdmin {
        _register(_attestors, newKey, true);
        _revoke(_attestors, oldKey, true);
    }

    function registerVerifierKey(address key) external override onlyAdmin {
        _register(_verifierKeys, key, false);
    }

    function revokeVerifierKey(address key) external override onlyAdmin {
        _revoke(_verifierKeys, key, false);
    }

    function rotateVerifierKey(address oldKey, address newKey) external override onlyAdmin {
        _register(_verifierKeys, newKey, false);
        _revoke(_verifierKeys, oldKey, false);
    }

    function _register(mapping(address => KeyInfo) storage keys, address key, bool attestor) internal {
        if (key == address(0)) revert ZeroAddress();
        KeyInfo storage k = keys[key];
        if (k.active) revert KeyAlreadyActive(key);
        k.registered = true;
        k.active = true;
        k.revokedAt = 0;
        if (attestor) {
            _activeAttestors += 1;
            emit AttestorRegistered(key);
        } else {
            _activeVerifiers += 1;
            emit VerifierKeyRegistered(key);
        }
    }

    function _revoke(mapping(address => KeyInfo) storage keys, address key, bool attestor) internal {
        KeyInfo storage k = keys[key];
        if (!k.active) revert KeyNotRegistered(key);
        uint32 active = attestor ? _activeAttestors : _activeVerifiers;
        if (active == 1) revert LastActiveKey();
        k.active = false;
        k.revokedAt = uint64(block.timestamp);
        if (attestor) {
            _activeAttestors = active - 1;
            emit AttestorRevoked(key, k.revokedAt);
        } else {
            _activeVerifiers = active - 1;
            emit VerifierKeyRevoked(key, k.revokedAt);
        }
    }

    /// @inheritdoc IMercesRegistry
    /// @dev `pair_id = keccak256(feed_id ‖ inverted_u8)`: feed id and inversion are write-once (SPEC §3.1). The
    /// pair starts enabled; a cross-check set at registration applies from the current period.
    function setFxPair(bytes32 feedId, bool inverted, address crosscheck)
        external
        override
        onlyAdmin
        returns (bytes32 pairId)
    {
        if (feedId == bytes32(0)) revert UnknownFxPair(bytes32(0));
        pairId = fxPairId(feedId, inverted);
        FxPairConfig storage cfg = _fxPairs[pairId];
        if (cfg.exists) revert FxPairExists(pairId);
        cfg.exists = true;
        cfg.feedId = feedId;
        cfg.inverted = inverted;
        cfg.crosscheck = crosscheck;
        cfg.crosscheckEffectivePeriod = crosscheck != address(0) ? Periods.periodOf(block.timestamp) : 0;
        cfg.enabled = true;
        _emitFxPair(pairId, cfg);
    }

    /// @inheritdoc IMercesRegistry
    function setFxPairEnabled(bytes32 pairId, bool enabled) external override onlyAdmin {
        FxPairConfig storage cfg = _fxPairs[pairId];
        if (!cfg.exists) revert UnknownFxPair(pairId);
        cfg.enabled = enabled;
        _emitFxPair(pairId, cfg);
    }

    /// @inheritdoc IMercesRegistry
    /// @dev SPEC §3.1, B-S10: from zero with no feed in force for the running period → effective now; otherwise
    /// effective from `period_of(now) + 1` while the feed in force (`prevCrosscheck`) keeps applying to the
    /// running period, so a live quarter's rule never changes under an issuer.
    function setFxPairCrosscheck(bytes32 pairId, address crosscheck) external override onlyAdmin {
        FxPairConfig storage cfg = _fxPairs[pairId];
        if (!cfg.exists) revert UnknownFxPair(pairId);
        if (crosscheck == cfg.crosscheck) revert CrosscheckUnchanged(pairId);
        uint32 nowPeriod = Periods.periodOf(block.timestamp);
        address inForce = nowPeriod >= cfg.crosscheckEffectivePeriod ? cfg.crosscheck : cfg.prevCrosscheck;
        if (inForce == address(0)) {
            cfg.prevCrosscheck = address(0);
            cfg.crosscheckEffectivePeriod = nowPeriod;
        } else {
            cfg.prevCrosscheck = inForce;
            cfg.crosscheckEffectivePeriod = nowPeriod + 1;
        }
        cfg.crosscheck = crosscheck;
        _emitFxPair(pairId, cfg);
    }

    function _emitFxPair(bytes32 pairId, FxPairConfig storage cfg) internal {
        emit FxPairSet(pairId, cfg.feedId, cfg.inverted, cfg.crosscheck, cfg.crosscheckEffectivePeriod, cfg.enabled);
    }

    /// @notice Allow or disallow a settlement stablecoin. Decimals are read from the token, never assumed.
    function setStablecoin(address token, bool allowed) external override onlyAdmin {
        if (token == address(0)) revert ZeroAddress();
        uint8 decimals = IERC20Metadata(token).decimals();
        _stablecoins[token] = allowed;
        emit StablecoinSet(token, allowed, decimals);
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

    /// @inheritdoc IMercesRegistry
    /// @dev The auction and the window hold units in escrow, so they need T-REX identities (SPEC §4.2). Anyone may
    /// call; idempotent.
    function registerProtocolIdentities() external override {
        _ensureIdentity(_contracts.auction);
        _ensureIdentity(_contracts.window);
    }

    // ---------------------------------------------------------------- allowlist manager

    /// @inheritdoc IMercesRegistry
    function setAllowed(address wallet, bool allowed) external override onlyAllowlistManager {
        if (wallet == address(0)) revert ZeroAddress();
        _allowed[wallet] = allowed;
        if (allowed) _ensureIdentity(wallet);
        emit AllowlistUpdated(wallet, allowed);
    }

    function _ensureIdentity(address wallet) internal {
        if (_identityRegistry.contains(wallet)) return;
        address identity = _idFactory.getIdentity(wallet);
        if (identity == address(0)) identity = _idFactory.createIdentity(wallet, Strings.toHexString(wallet));
        _identityRegistry.registerIdentity(wallet, identity, 0);
        emit IdentityRegistered(wallet, identity);
    }

    // ---------------------------------------------------------------- issuer

    /// @inheritdoc IMercesRegistry
    /// @dev Checks in the SPEC §3.2 order (issuer gate, allowlist, money ranges, bounds, terms, schedule, tiers,
    /// FX pair). Fee rates, the non-reveal charge and the pause limits are protocol economics copied from the
    /// defaults in force; every other term is the issuer's choice within the §1.6 bounds.
    function createSeries(
        SeriesParams calldata p,
        ReleaseTranche[] calldata releaseSchedule,
        bytes32 termsCommitment,
        uint8 tierFlags,
        bytes32 fxPairId_,
        SeriesMode mode,
        bool issuerAcceptsPublicPrice,
        Tier1Terms calldata tier1Terms
    ) external override returns (uint256 seriesId) {
        _checkIssuer();
        if (mode != SeriesMode.SealedBid) revert CurveModeUnsupported();
        if (!_stablecoins[p.stablecoin]) revert StablecoinNotAllowed(p.stablecoin);
        _checkTerms(p);
        _checkSchedule(releaseSchedule);
        if (tierFlags == 0 || tierFlags & ~TierFlags.ALL != 0) revert InvalidTierFlags();
        bool tier1 = tierFlags & TierFlags.TIER1_SPLIT != 0;
        if (tier1 != _routerGiven(tier1Terms)) revert RouterNotEnabled();
        if (tier1) _checkTier1(p.unitsOffered, fxPairId_, tier1Terms);
        if (fxPairId_ != bytes32(0) && !_fxPairs[fxPairId_].enabled) revert UnknownFxPair(fxPairId_);
        if (termsCommitment == bytes32(0)) revert ParameterOutOfBounds("termsCommitment");
        if (tier1) _checkTier1Commitment(termsCommitment, tier1Terms);

        seriesId = ++seriesCount;
        _issuers[msg.sender].seriesCount += 1;
        _storeTerms(seriesId, p);
        if (tier1) _router[seriesId] = RouterTerms({theta: uint64(tier1Terms.theta), rWad: uint64(tier1Terms.rWad)});
        _storeCore(seriesId, p.stablecoin, mode, tierFlags, fxPairId_, issuerAcceptsPublicPrice, termsCommitment);
        ReleaseTranche[] storage schedule = _schedules[seriesId];
        for (uint256 i = 0; i < releaseSchedule.length; i++) {
            schedule.push(releaseSchedule[i]);
        }
        emit SeriesCreated(
            seriesId, msg.sender, mode, p.stablecoin, _terms[seriesId], termsCommitment, tierFlags, fxPairId_
        );
    }

    function _storeCore(
        uint256 seriesId,
        address stablecoin,
        SeriesMode mode,
        uint8 tierFlags,
        bytes32 fxPairId_,
        bool issuerAcceptsPublicPrice,
        bytes32 termsCommitment
    ) internal {
        SeriesCore storage core = _cores[seriesId];
        core.issuer = msg.sender;
        core.mode = mode;
        core.stablecoin = stablecoin;
        core.stablecoinDecimals = IERC20Metadata(stablecoin).decimals();
        core.raiseState = RaiseState.Draft;
        core.tierFlags = tierFlags;
        core.fxPairId = fxPairId_;
        core.issuerAcceptsPublicPrice = issuerAcceptsPublicPrice;
        core.termsCommitment = termsCommitment;
    }

    /// @dev `issuer.active && !issuer.issuance_stopped` and the issuer wallet allowlisted.
    function _checkIssuer() internal view {
        Issuer storage issuer = _issuers[msg.sender];
        if (!issuer.registered || !issuer.active) revert IssuerInactive();
        if (issuer.issuanceStopped) revert RegistryErrors.IssuanceStopped();
        if (!_allowed[msg.sender]) revert NotAllowlisted(msg.sender);
    }

    /// @dev Money ranges (§1.1), parameter bounds (§1.6), then `units_offered ≥ 1`, `reserve_price ≥ 1`,
    /// `min_raise ≤ reserve_price × units_offered` and at least one unit of wallet cap (§3.2, §1.6).
    function _checkTerms(SeriesParams calldata p) internal pure {
        uint256 units = p.unitsOffered.toU64();
        uint256 reserve = p.reservePrice.toU64();
        uint256 minRaise = p.minRaise.toU64();
        _bound(p.capMultipleWad, C.CAP_MULTIPLE_MIN, C.CAP_MULTIPLE_MAX, "capMultipleWad");
        _bound(p.hurdleRateWad, 0, C.HURDLE_MAX, "hurdleRateWad");
        _bound(p.payoutMultipleK, C.K_MIN, C.K_MAX, "payoutMultipleK");
        _bound(p.lockupSeconds, 0, C.LOCKUP_MAX, "lockupSeconds");
        _bound(p.walletCapBps, C.WALLET_CAP_MIN, C.WALLET_CAP_MAX, "walletCapBps");
        _bound(p.commitDuration, C.COMMIT_MIN, C.COMMIT_MAX, "commitDuration");
        _bound(p.revealDuration, C.REVEAL_MIN, C.REVEAL_MAX, "revealDuration");
        _bound(p.windowCommitDuration, C.WINDOW_COMMIT_MIN, C.WINDOW_COMMIT_MAX, "windowCommitDuration");
        _bound(p.windowRevealDuration, C.WINDOW_REVEAL_MIN, C.WINDOW_REVEAL_MAX, "windowRevealDuration");
        if (units < 1) revert InvalidTerms("unitsOffered");
        if (reserve < 1) revert InvalidTerms("reservePrice");
        // reserve × units must stay in the shared uint64 money domain; it also bounds the minimum raise
        uint256 maxProceeds = reserve * units;
        if (maxProceeds > type(uint64).max) revert AmountOutOfRange(maxProceeds);
        if (minRaise > maxProceeds) revert InvalidTerms("minRaise");
        if (units.bpsOf(p.walletCapBps) < 1) revert InvalidTerms("walletCap");
    }

    /// @dev A router is "given" when any tier-1 term is set; the tier-1 flag and router terms go together.
    function _routerGiven(Tier1Terms calldata t) internal pure returns (bool) {
        return t.theta != 0 || t.rWad != 0 || t.termsSalt != 0 || t.currencyCode != 0 || t.indexingRule != 0;
    }

    /// @dev SPEC §6.5: the income currency of a tier-1 series is the stablecoin, `r_wad × units_offered ≤ WAD`,
    /// θ and r fit uint64.
    function _checkTier1(uint256 unitsOffered, bytes32 fxPairId_, Tier1Terms calldata t) internal pure {
        if (fxPairId_ != bytes32(0)) revert InvalidTerms("tier1Fx");
        t.theta.toU64();
        uint256 rWad = t.rWad.toU64();
        if (rWad * unitsOffered > C.WAD) revert InvalidTerms("tier1Rate");
    }

    /// @dev The plaintext tier-1 terms must open the Poseidon(5) terms commitment (SPEC §6.5).
    function _checkTier1Commitment(bytes32 termsCommitment, Tier1Terms calldata t) internal view {
        uint256 h =
            _poseidon5.poseidon([t.theta, t.rWad, uint256(t.currencyCode), uint256(t.indexingRule), t.termsSalt]);
        if (h != uint256(termsCommitment)) revert TermsCommitmentMismatch();
    }

    /// @dev Issuer-chosen terms are copied from `p` (bounded by `_checkTerms`); fee and pause parameters are
    /// copied from the protocol defaults in force at creation.
    function _storeTerms(uint256 seriesId, SeriesParams calldata p) internal {
        Parameters storage d = _defaults;
        SeriesTerms storage t = _terms[seriesId];
        t.unitsOffered = uint64(p.unitsOffered);
        t.reservePrice = uint64(p.reservePrice);
        t.minRaise = uint64(p.minRaise);
        t.capMultipleWad = uint64(p.capMultipleWad);
        t.hurdleRateWad = uint64(p.hurdleRateWad);
        t.payoutMultipleK = uint16(p.payoutMultipleK);
        t.lockupSeconds = uint64(p.lockupSeconds);
        t.walletCapBps = uint16(p.walletCapBps);
        t.auctionFeeBps = d.auctionFeeBps;
        t.payoutFeeBps = d.payoutFeeBps;
        t.windowFeeBps = d.windowFeeBps;
        t.nonRevealChargeBps = d.nonRevealChargeBps;
        t.commitDuration = uint64(p.commitDuration);
        t.revealDuration = uint64(p.revealDuration);
        t.windowCommitDuration = uint64(p.windowCommitDuration);
        t.windowRevealDuration = uint64(p.windowRevealDuration);
        t.maxPauseSeconds = d.maxPauseSeconds;
        t.maxCumulativePauseSeconds = d.maxCumulativePauseSeconds;
    }

    /// @inheritdoc IMercesRegistry
    function setContractHash(uint256 seriesId, bytes32 hash) external override seriesExists(seriesId) {
        SeriesCore storage core = _cores[seriesId];
        if (msg.sender != core.issuer) revert NotIssuer();
        if (core.raiseState != RaiseState.Draft) revert SeriesNotDraft();
        if (hash == bytes32(0)) revert ContractHashMissing();
        core.contractHash = hash;
        emit ContractHashSet(seriesId, hash);
    }

    function stopIssuance() external override {
        Issuer storage issuer = _issuers[msg.sender];
        if (!issuer.registered) revert IssuerInactive();
        issuer.issuanceStopped = true;
        emit IssuanceStopped(msg.sender);
    }

    function resumeIssuance() external override {
        Issuer storage issuer = _issuers[msg.sender];
        if (!issuer.registered) revert IssuerInactive();
        issuer.issuanceStopped = false;
        emit IssuanceResumed(msg.sender);
    }

    /// @inheritdoc IMercesRegistry
    /// @dev Issuer signs the transaction; a registered attestor signs the SPEC §1.4 amendment message over the
    /// current nonce. The cap multiple may only decrease and stays within bounds (brief C4). Not allowed once a
    /// terminal status is set. Tier-1 series supply the new plaintext terms, checked against the new commitment.
    function amendTerms(
        uint256 seriesId,
        bytes32 newTermsCommitment,
        uint256 newCapMultipleWad,
        bytes calldata attestorSignature,
        Tier1Terms calldata tier1Terms
    ) external override seriesExists(seriesId) {
        SeriesCore storage core = _cores[seriesId];
        SeriesTerms storage terms = _terms[seriesId];
        if (msg.sender != core.issuer) revert NotIssuer();
        if (core.terminalStatus != 0) revert AmendmentAfterTerminal();
        uint64 newCap = newCapMultipleWad.toU64();
        uint64 nonce = core.amendmentNonce;
        bytes32 digest = MercesMessages.amendDigest(domain, seriesId, nonce, newTermsCommitment, newCap);
        address signer = ECDSA.recover(digest, attestorSignature);
        if (!_attestors[signer].active) revert InvalidAttestorSignature(signer);
        if (newCap > terms.capMultipleWad || newCap < C.CAP_MULTIPLE_MIN) revert UnfavourableAmendment();
        if (newTermsCommitment == bytes32(0)) revert ParameterOutOfBounds("termsCommitment");
        if (core.tierFlags & TierFlags.TIER1_SPLIT != 0) {
            _checkTier1(terms.unitsOffered, bytes32(0), tier1Terms);
            _checkTier1Commitment(newTermsCommitment, tier1Terms);
            _router[seriesId] = RouterTerms({theta: uint64(tier1Terms.theta), rWad: uint64(tier1Terms.rWad)});
        }
        core.amendmentNonce = nonce + 1;
        core.termsCommitment = newTermsCommitment;
        terms.capMultipleWad = newCap;
        emit TermsAmended(seriesId, nonce, newTermsCommitment, newCap, signer);
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
    /// @dev Open → Settled / Failed / Cancelled, exact values written once (SPEC §3.2).
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
        if (core.raiseState != RaiseState.Open) revert InvalidRaiseTransition();
        core.raiseState = state;
        core.settlementTs = settlementTs;
        core.unitsSold = unitsSold;
        core.clearingPrice = clearingPrice;
        emit RaiseStateChanged(seriesId, state);
    }

    /// @inheritdoc IMercesRegistry
    function markMintFinalized(uint256 seriesId) external override onlyAuction seriesExists(seriesId) {
        SeriesCore storage core = _cores[seriesId];
        // Settled, or Failed (the empty mint of a failed raise is final too, B-S17); the repayment path still
        // requires Settled
        if ((core.raiseState != RaiseState.Settled && core.raiseState != RaiseState.Failed) || core.mintFinalized) {
            revert InvalidRaiseTransition();
        }
        core.mintFinalized = true;
        emit MintFinalized(seriesId);
    }

    /// @inheritdoc IMercesRegistry
    /// @dev none → Retired / Redeemed / Extinguished; Retired or Redeemed → Extinguished (SPEC §6.9).
    function markTerminal(uint256 seriesId, SeriesStatus status) external override onlyVault seriesExists(seriesId) {
        SeriesCore storage core = _cores[seriesId];
        if (status != SeriesStatus.Retired && status != SeriesStatus.Redeemed && status != SeriesStatus.Extinguished) {
            revert InvalidTerminalStatus();
        }
        if (core.terminalStatus != 0) {
            if (core.terminalStatus == uint8(SeriesStatus.Extinguished) || status != SeriesStatus.Extinguished) {
                revert AlreadyTerminal();
            }
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
        _bound(d.maxPauseSeconds, C.MAX_PAUSE_MIN, C.MAX_PAUSE_MAX, "maxPauseSeconds");
        _bound(d.maxCumulativePauseSeconds, d.maxPauseSeconds, C.MAX_CUMULATIVE_PAUSE_MAX, "maxCumulativePauseSeconds");
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
