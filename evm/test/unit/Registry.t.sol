// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {MercesFixture} from "../utils/MercesFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {MercesRegistry} from "../../src/MercesRegistry.sol";
import {IMercesRegistry} from "../../src/interfaces/IMercesRegistry.sol";
import {IPoseidon5} from "../../src/interfaces/IPoseidon.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {IIdentityRegistryLite} from "../../src/interfaces/external/IIdentityRegistryLite.sol";
import {IIdFactoryLite} from "../../src/interfaces/external/IIdFactoryLite.sol";
import {
    Flags,
    FxPairConfig,
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
} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

contract RegistryTest is MercesFixture {
    bytes32 internal constant FEED = keccak256("pyth:EUR/USD");

    function _create(SeriesParams memory p, ReleaseTranche[] memory s, bytes32 tc, uint8 flags, bytes32 pair)
        internal
        returns (uint256)
    {
        return registry.createSeries(p, s, tc, flags, pair, SeriesMode.SealedBid, false, noTier1());
    }

    // ------------------------------------------------------------ init

    function test_init() public view {
        assertEq(registry.admin(), admin);
        assertEq(registry.allowlistManager(), allowlistManager);
        assertEq(registry.feeCollector(), address(feeCollector));
        assertEq(registry.chainId(), uint64(block.chainid));
        assertEq(registry.domain(), MercesMessages.domain(uint64(block.chainid), address(registry)));
        Flags memory f = registry.getFlags();
        assertFalse(f.newRaisesPaused);
        assertFalse(f.windowsEnabled);
        assertFalse(f.tier4Enabled);
        assertEq(registry.earlyDrawApprover(), address(0));
        assertEq(registry.seriesCount(), 0);
        Parameters memory d = registry.getDefaults();
        assertEq(d.capMultipleWad, 2.5e18);
        assertEq(d.lockupSeconds, 47_336_400);
        assertEq(d.maxPauseSeconds, 31_536_000);
        assertEq(registry.getProtocolContracts().auction, address(auction));
    }

    function test_initRejectsChainIdMismatchAndBadDefaults() public {
        ProtocolContracts memory c = registry.getProtocolContracts();
        vm.expectRevert(abi.encodeWithSelector(ChainIdMismatch.selector, 10143, block.chainid));
        new MercesRegistry(
            admin,
            allowlistManager,
            address(feeCollector),
            10143,
            defaultParameters(),
            trex.identityRegistry,
            trex.idFactory,
            poseidon5,
            c
        );
        Parameters memory p = defaultParameters();
        p.capMultipleWad = 1.9e18;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("capMultipleWad")));
        new MercesRegistry(
            admin,
            allowlistManager,
            address(feeCollector),
            uint64(block.chainid),
            p,
            trex.identityRegistry,
            trex.idFactory,
            poseidon5,
            c
        );
        p = defaultParameters();
        p.maxCumulativePauseSeconds = p.maxPauseSeconds - 1;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("maxCumulativePauseSeconds")));
        new MercesRegistry(
            admin,
            allowlistManager,
            address(feeCollector),
            uint64(block.chainid),
            p,
            trex.identityRegistry,
            trex.idFactory,
            poseidon5,
            c
        );
        c.window = address(0);
        vm.expectRevert(ZeroAddress.selector);
        new MercesRegistry(
            admin,
            allowlistManager,
            address(feeCollector),
            uint64(block.chainid),
            defaultParameters(),
            trex.identityRegistry,
            trex.idFactory,
            poseidon5,
            c
        );
    }

    // ------------------------------------------------------------ admin

    function test_adminTwoStep() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        registry.transferAdmin(newAdmin);
        assertEq(registry.admin(), admin);
        vm.expectRevert(NotPendingAdmin.selector);
        registry.acceptAdmin();
        vm.prank(newAdmin);
        registry.acceptAdmin();
        assertEq(registry.admin(), newAdmin);
        assertEq(registry.pendingAdmin(), address(0));
    }

    function test_onlyAdminGuards() public {
        vm.startPrank(stranger);
        vm.expectRevert(NotAdmin.selector);
        registry.setAllowlistManager(stranger);
        vm.expectRevert(NotAdmin.selector);
        registry.setFeeCollector(stranger);
        vm.expectRevert(NotAdmin.selector);
        registry.setFlags(true, true, true);
        vm.expectRevert(NotAdmin.selector);
        registry.setEarlyDrawApprover(stranger);
        vm.expectRevert(NotAdmin.selector);
        registry.setDefaults(defaultParameters());
        vm.expectRevert(NotAdmin.selector);
        registry.registerAttestor(stranger);
        vm.expectRevert(NotAdmin.selector);
        registry.revokeAttestor(attestor);
        vm.expectRevert(NotAdmin.selector);
        registry.rotateAttestor(attestor, stranger);
        vm.expectRevert(NotAdmin.selector);
        registry.registerVerifierKey(stranger);
        vm.expectRevert(NotAdmin.selector);
        registry.revokeVerifierKey(verifier);
        vm.expectRevert(NotAdmin.selector);
        registry.rotateVerifierKey(verifier, stranger);
        vm.expectRevert(NotAdmin.selector);
        registry.setFxPair(FEED, false, address(0));
        vm.expectRevert(NotAdmin.selector);
        registry.setFxPairEnabled(bytes32(0), true);
        vm.expectRevert(NotAdmin.selector);
        registry.setFxPairCrosscheck(bytes32(0), address(0));
        vm.expectRevert(NotAdmin.selector);
        registry.setStablecoin(address(usdc), false);
        vm.expectRevert(NotAdmin.selector);
        registry.registerIssuer(stranger);
        vm.expectRevert(NotAdmin.selector);
        registry.deactivateIssuer(issuer);
        vm.expectRevert(NotAdmin.selector);
        registry.transferAdmin(stranger);
        vm.expectRevert(NotAllowlistManager.selector);
        registry.setAllowed(stranger, true);
        vm.stopPrank();
        // no setter exists for the protocol contracts
        (bool ok,) = address(registry)
            .call(
                abi.encodeWithSignature(
                    "setProtocolContracts((address,address,address,address,address,address))",
                    registry.getProtocolContracts()
                )
            );
        assertFalse(ok);
    }

    function test_flagsAndDefaults() public {
        vm.startPrank(admin);
        vm.expectEmit(true, true, true, true);
        emit IMercesRegistry.FlagsSet(true, true, true);
        registry.setFlags(true, true, true);
        Flags memory f = registry.getFlags();
        assertTrue(f.newRaisesPaused && f.windowsEnabled && f.tier4Enabled);
        registry.setEarlyDrawApprover(stranger);
        assertEq(registry.earlyDrawApprover(), stranger);
        Parameters memory p = defaultParameters();
        p.walletCapBps = 50;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("walletCapBps")));
        registry.setDefaults(p);
        p.walletCapBps = 2000;
        registry.setDefaults(p);
        assertEq(registry.getDefaults().walletCapBps, 2000);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ keys (forward-only revocation)

    function test_keyRevocationIsForwardOnlyAndKeepsOneActive() public {
        vm.startPrank(admin);
        assertTrue(registry.isAttestor(attestor));
        vm.warp(T0 + 5 days);
        vm.expectEmit(true, false, false, true);
        emit IMercesRegistry.AttestorRevoked(attestor, uint64(vm.getBlockTimestamp()));
        registry.revokeAttestor(attestor);
        assertFalse(registry.isAttestor(attestor));
        KeyInfo memory k = registry.attestorKey(attestor);
        assertTrue(k.registered);
        assertFalse(k.active);
        assertEq(k.revokedAt, T0 + 5 days);
        vm.expectRevert(abi.encodeWithSelector(KeyNotRegistered.selector, attestor));
        registry.revokeAttestor(attestor);
        // the last active attestor cannot be revoked without a replacement
        vm.expectRevert(LastActiveKey.selector);
        registry.revokeAttestor(attestor2);
        address a3 = makeAddr("a3");
        registry.rotateAttestor(attestor2, a3);
        assertFalse(registry.isAttestor(attestor2));
        assertTrue(registry.isAttestor(a3));
        vm.expectRevert(abi.encodeWithSelector(KeyAlreadyActive.selector, a3));
        registry.registerAttestor(a3);
        // re-registering a revoked key reactivates it
        registry.registerAttestor(attestor);
        assertTrue(registry.isAttestor(attestor));
        assertEq(registry.attestorKey(attestor).revokedAt, 0);
        // verifier keys: same rules
        vm.expectRevert(LastActiveKey.selector);
        registry.revokeVerifierKey(verifier);
        address v2 = makeAddr("v2");
        registry.rotateVerifierKey(verifier, v2);
        assertFalse(registry.isVerifierKey(verifier));
        assertTrue(registry.isVerifierKey(v2));
        assertEq(registry.verifierKey(verifier).revokedAt, vm.getBlockTimestamp());
        vm.expectRevert(ZeroAddress.selector);
        registry.registerVerifierKey(address(0));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ FX pairs (write-once)

    function test_fxPairsWriteOnceWithForwardCrosscheck() public {
        bytes32 pair = registry.fxPairId(FEED, false);
        assertEq(pair, keccak256(abi.encodePacked(FEED, uint8(0))));
        assertTrue(registry.fxPairId(FEED, true) != pair);
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(UnknownFxPair.selector, bytes32(0)));
        registry.setFxPair(bytes32(0), false, address(0));
        vm.expectEmit(true, false, false, true);
        emit IMercesRegistry.FxPairSet(pair, FEED, false, address(0), 0, true);
        assertEq(registry.setFxPair(FEED, false, address(0)), pair);
        FxPairConfig memory c = registry.getFxPair(pair);
        assertTrue(c.exists && c.enabled && !c.inverted);
        assertEq(c.feedId, FEED);
        assertEq(c.crosscheck, address(0));
        // feed id and direction are write-once
        vm.expectRevert(abi.encodeWithSelector(FxPairExists.selector, pair));
        registry.setFxPair(FEED, false, stranger);
        // a cross-check set from zero applies now
        uint32 nowPeriod = Periods.periodOf(vm.getBlockTimestamp());
        registry.setFxPairCrosscheck(pair, stranger);
        c = registry.getFxPair(pair);
        assertEq(c.crosscheck, stranger);
        assertEq(c.crosscheckEffectivePeriod, nowPeriod);
        // changing it later applies from the next period
        registry.setFxPairCrosscheck(pair, admin);
        c = registry.getFxPair(pair);
        assertEq(c.crosscheck, admin);
        assertEq(c.crosscheckEffectivePeriod, nowPeriod + 1);
        // removing it is a change too (next period)
        registry.setFxPairCrosscheck(pair, address(0));
        assertEq(registry.getFxPair(pair).crosscheckEffectivePeriod, nowPeriod + 1);
        // disabling only blocks new series
        registry.setFxPairEnabled(pair, false);
        assertFalse(registry.getFxPair(pair).enabled);
        vm.stopPrank();
        SeriesParams memory p = defaultSeriesParams();
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(UnknownFxPair.selector, pair));
        _create(p, defaultSchedule(), keccak256("t"), 2, pair);
        vm.prank(admin);
        registry.setFxPairEnabled(pair, true);
        vm.prank(issuer);
        uint256 id = _create(p, defaultSchedule(), keccak256("t"), 2, pair);
        assertEq(registry.getSeriesCore(id).fxPairId, pair);
    }

    // ------------------------------------------------------------ allowlist flag vs identity

    function test_allowlistFlagAndPersistentIdentity() public {
        assertFalse(registry.isAllowed(b1));
        vm.prank(allowlistManager);
        vm.expectEmit(true, false, false, true);
        emit IMercesRegistry.AllowlistUpdated(b1, true);
        registry.setAllowed(b1, true);
        assertTrue(registry.isAllowed(b1));
        IIdentityRegistryLite ir = IIdentityRegistryLite(trex.identityRegistry);
        assertTrue(ir.contains(b1));
        address identity = ir.identity(b1);
        assertTrue(identity != address(0) && identity.code.length > 0);
        assertEq(IIdFactoryLite(trex.idFactory).getIdentity(b1), identity);
        assertEq(ir.investorCountry(b1), 0);
        assertTrue(ir.isVerified(b1));

        // removal clears the flag only; the identity stays registered (SPEC §4.2)
        disallow(b1);
        assertFalse(registry.isAllowed(b1));
        assertTrue(ir.contains(b1));
        assertTrue(ir.isVerified(b1));
        allow(b1);
        assertEq(ir.identity(b1), identity);
        // idempotent, zero address refused
        allow(b1);
        disallow(b2);
        assertFalse(registry.isAllowed(b2));
        assertFalse(ir.contains(b2));
        vm.prank(allowlistManager);
        vm.expectRevert(ZeroAddress.selector);
        registry.setAllowed(address(0), true);
        // protocol identities are registered and the call is idempotent
        registry.registerProtocolIdentities();
        assertTrue(ir.isVerified(address(auction)));
        assertTrue(ir.isVerified(address(window)));
    }

    // ------------------------------------------------------------ issuers and series

    function test_createSeriesHappyPath() public {
        uint256 id = createSeries(keccak256("terms"));
        assertEq(id, 1);
        assertEq(registry.seriesCount(), 1);
        SeriesCore memory c = registry.getSeriesCore(id);
        assertEq(c.issuer, issuer);
        assertEq(uint8(c.mode), uint8(SeriesMode.SealedBid));
        assertEq(c.stablecoin, address(usdc));
        assertEq(c.stablecoinDecimals, 6);
        assertEq(uint8(c.raiseState), uint8(RaiseState.Draft));
        assertEq(c.terminalStatus, 0);
        assertFalse(c.mintFinalized);
        assertEq(c.tierFlags, TierFlags.TIER2_ZKTLS | TierFlags.TIER3_ATTESTOR);
        assertEq(c.termsCommitment, keccak256("terms"));
        assertEq(c.contractHash, keccak256("signed HEU contract + charter"));
        SeriesTerms memory t = registry.getSeriesTerms(id);
        assertEq(t.unitsOffered, 1000);
        assertEq(t.reservePrice, 1_000_000);
        assertEq(t.minRaise, 500_000_000);
        assertEq(t.walletCapBps, 1000);
        assertEq(t.auctionFeeBps, 100);
        assertEq(t.payoutFeeBps, 500);
        assertEq(t.windowFeeBps, 100);
        assertEq(t.nonRevealChargeBps, 100);
        assertEq(t.maxPauseSeconds, 31_536_000);
        assertEq(t.maxCumulativePauseSeconds, 63_072_000);
        ReleaseTranche[] memory s = registry.getReleaseSchedule(id);
        assertEq(s.length, 4);
        assertEq(s[3].atOffsetSeconds, 270 days);
        assertEq(registry.getIssuer(issuer).seriesCount, 1);
        assertTrue(registry.isTransferLocked(id, vm.getBlockTimestamp()));
    }

    function test_createSeriesGuards() public {
        SeriesParams memory p = defaultSeriesParams();
        ReleaseTranche[] memory s = defaultSchedule();
        bytes32 tc = keccak256("terms");

        vm.prank(stranger);
        vm.expectRevert(IssuerInactive.selector);
        _create(p, s, tc, 2, bytes32(0));

        vm.prank(admin);
        registry.deactivateIssuer(issuer);
        vm.prank(issuer);
        vm.expectRevert(IssuerInactive.selector);
        _create(p, s, tc, 2, bytes32(0));
        vm.prank(admin);
        registry.registerIssuer(issuer);

        vm.prank(issuer);
        registry.stopIssuance();
        vm.prank(issuer);
        vm.expectRevert(RegistryErrors.IssuanceStopped.selector);
        _create(p, s, tc, 2, bytes32(0));
        vm.prank(issuer);
        registry.resumeIssuance();

        disallow(issuer);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(NotAllowlisted.selector, issuer));
        _create(p, s, tc, 2, bytes32(0));
        allow(issuer);

        vm.startPrank(issuer);
        vm.expectRevert(CurveModeUnsupported.selector);
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.Curve, true, noTier1());

        p.stablecoin = address(0x1234);
        vm.expectRevert(abi.encodeWithSelector(StablecoinNotAllowed.selector, address(0x1234)));
        _create(p, s, tc, 2, bytes32(0));
        p.stablecoin = address(usdc);

        p.unitsOffered = 0;
        vm.expectRevert(abi.encodeWithSelector(InvalidTerms.selector, bytes32("unitsOffered")));
        _create(p, s, tc, 2, bytes32(0));
        p.unitsOffered = 9; // 10% of 9 units is no unit at all
        p.minRaise = 0;
        vm.expectRevert(abi.encodeWithSelector(InvalidTerms.selector, bytes32("walletCap")));
        _create(p, s, tc, 2, bytes32(0));
        p.unitsOffered = 10;
        _create(p, s, tc, 2, bytes32(0)); // exactly one unit of cap is enough
        p.unitsOffered = 1000;
        p.minRaise = 500_000_000;

        p.reservePrice = 0;
        vm.expectRevert(abi.encodeWithSelector(InvalidTerms.selector, bytes32("reservePrice")));
        _create(p, s, tc, 2, bytes32(0));
        p.reservePrice = 1_000_000;

        p.minRaise = 1_000_000_001;
        vm.expectRevert(abi.encodeWithSelector(InvalidTerms.selector, bytes32("minRaise")));
        _create(p, s, tc, 2, bytes32(0));
        p.minRaise = 500_000_000;

        p.reservePrice = type(uint64).max;
        vm.expectRevert(abi.encodeWithSelector(AmountOutOfRange.selector, uint256(type(uint64).max) * 1000));
        _create(p, s, tc, 2, bytes32(0));
        p.reservePrice = 1_000_000;

        vm.expectRevert(InvalidTierFlags.selector);
        _create(p, s, tc, 0, bytes32(0));
        vm.expectRevert(InvalidTierFlags.selector);
        _create(p, s, tc, 0x10, bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(UnknownFxPair.selector, bytes32("EUR")));
        _create(p, s, tc, 2, bytes32("EUR"));

        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("termsCommitment")));
        _create(p, s, bytes32(0), 2, bytes32(0));

        p.capMultipleWad = 3.1e18;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("capMultipleWad")));
        _create(p, s, tc, 2, bytes32(0));
        p.capMultipleWad = 2.5e18;

        p.hurdleRateWad = 0.26e18;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("hurdleRateWad")));
        _create(p, s, tc, 2, bytes32(0));
        p.hurdleRateWad = 0.08e18;

        p.payoutMultipleK = 0;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("payoutMultipleK")));
        _create(p, s, tc, 2, bytes32(0));
        p.payoutMultipleK = 21;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("payoutMultipleK")));
        _create(p, s, tc, 2, bytes32(0));
        p.payoutMultipleK = 5;

        p.lockupSeconds = 157_680_001;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("lockupSeconds")));
        _create(p, s, tc, 2, bytes32(0));
        p.lockupSeconds = 0;

        p.commitDuration = 59 minutes;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("commitDuration")));
        _create(p, s, tc, 2, bytes32(0));
        p.commitDuration = 31 days;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("commitDuration")));
        _create(p, s, tc, 2, bytes32(0));
        p.commitDuration = 7 days;

        p.revealDuration = 8 days;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("revealDuration")));
        _create(p, s, tc, 2, bytes32(0));
        p.revealDuration = 2 days;

        p.windowCommitDuration = 15 days;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("windowCommitDuration")));
        _create(p, s, tc, 2, bytes32(0));
        p.windowCommitDuration = 3 days;

        p.windowRevealDuration = 8 days;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("windowRevealDuration")));
        _create(p, s, tc, 2, bytes32(0));
        p.windowRevealDuration = 1 days;

        ReleaseTranche[] memory bad = new ReleaseTranche[](0);
        vm.expectRevert(InvalidReleaseSchedule.selector);
        _create(p, bad, tc, 2, bytes32(0));
        bad = new ReleaseTranche[](2);
        bad[0] = ReleaseTranche(0, 5000);
        bad[1] = ReleaseTranche(1, 4999);
        vm.expectRevert(InvalidReleaseSchedule.selector);
        _create(p, bad, tc, 2, bytes32(0));
        bad[0] = ReleaseTranche(10, 5000);
        bad[1] = ReleaseTranche(1, 5000);
        vm.expectRevert(InvalidReleaseSchedule.selector);
        _create(p, bad, tc, 2, bytes32(0));
        bad = new ReleaseTranche[](25);
        for (uint256 i = 0; i < 25; i++) {
            bad[i] = ReleaseTranche(uint64(i), 400);
        }
        vm.expectRevert(InvalidReleaseSchedule.selector);
        _create(p, bad, tc, 2, bytes32(0));

        uint256 id = _create(p, s, tc, 2, bytes32(0));
        assertEq(id, 2);
        vm.stopPrank();
    }

    function test_tier1SeriesChecks() public {
        SeriesParams memory p = defaultSeriesParams();
        bytes32 tc = Proofs.q1().termsCommitment;
        Tier1Terms memory t = proofTier1Terms();
        vm.prank(admin);
        bytes32 pair = registry.setFxPair(FEED, false, address(0));
        vm.startPrank(issuer);
        vm.expectRevert(abi.encodeWithSelector(InvalidTerms.selector, bytes32("tier1Fx")));
        registry.createSeries(p, defaultSchedule(), tc, 1, pair, SeriesMode.SealedBid, false, t);
        p.unitsOffered = 1001; // r × units = 1.001 WAD
        vm.expectRevert(abi.encodeWithSelector(InvalidTerms.selector, bytes32("tier1Rate")));
        registry.createSeries(p, defaultSchedule(), tc, 1, bytes32(0), SeriesMode.SealedBid, false, t);
        p.unitsOffered = 1000;
        // a tier-1 flag without router terms is a series without a router
        vm.expectRevert(RouterNotEnabled.selector);
        registry.createSeries(p, defaultSchedule(), tc, 1, bytes32(0), SeriesMode.SealedBid, false, noTier1());
        t.theta += 1;
        vm.expectRevert(TermsCommitmentMismatch.selector);
        registry.createSeries(p, defaultSchedule(), tc, 1, bytes32(0), SeriesMode.SealedBid, false, t);
        t = proofTier1Terms();
        // tier 1 combined with another tier still stores the plaintext terms
        uint256 id = registry.createSeries(p, defaultSchedule(), tc, 1 | 2, bytes32(0), SeriesMode.SealedBid, false, t);
        // router terms without the tier-1 flag are refused too
        vm.expectRevert(RouterNotEnabled.selector);
        registry.createSeries(p, defaultSchedule(), tc, 2, bytes32(0), SeriesMode.SealedBid, false, t);
        // θ and r must fit uint64
        t.rWad = uint256(1) << 64;
        vm.expectRevert(abi.encodeWithSelector(AmountOutOfRange.selector, uint256(1) << 64));
        registry.createSeries(p, defaultSchedule(), tc, 1, bytes32(0), SeriesMode.SealedBid, false, t);
        vm.stopPrank();
        RouterTerms memory stored = registry.getRouterTerms(id);
        assertEq(stored.theta, 80_000e6);
        assertEq(stored.rWad, 1e15);
        uint256 id2 = createSeries(keccak256("x"));
        assertEq(registry.getRouterTerms(id2).rWad, 0);
    }

    function test_feesFromDefaultsWalletCapFromTerms() public {
        Parameters memory d = defaultParameters();
        d.auctionFeeBps = 250;
        d.payoutFeeBps = 750;
        d.walletCapBps = 500;
        d.maxPauseSeconds = 2_592_000;
        vm.prank(admin);
        registry.setDefaults(d);
        SeriesParams memory p = defaultSeriesParams();
        p.walletCapBps = 3334; // the issuer's choice within [100, 10000] (vector 03)
        vm.prank(issuer);
        uint256 id = _create(p, defaultSchedule(), keccak256("terms"), 2, bytes32(0));
        SeriesTerms memory t = registry.getSeriesTerms(id);
        assertEq(t.auctionFeeBps, 250);
        assertEq(t.payoutFeeBps, 750);
        assertEq(t.walletCapBps, 3334);
        p.walletCapBps = 99;
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("walletCapBps")));
        _create(p, defaultSchedule(), keccak256("terms"), 2, bytes32(0));
        assertEq(t.maxPauseSeconds, 2_592_000);
        d.payoutFeeBps = 100;
        vm.prank(admin);
        registry.setDefaults(d);
        assertEq(registry.getSeriesTerms(id).payoutFeeBps, 750);
    }

    function test_contractHash() public {
        vm.prank(issuer);
        uint256 id = _create(defaultSeriesParams(), defaultSchedule(), keccak256("t"), 2, bytes32(0));
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        registry.setContractHash(id, keccak256("x"));
        vm.prank(issuer);
        vm.expectRevert(ContractHashMissing.selector);
        registry.setContractHash(id, bytes32(0));
        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesRegistry.ContractHashSet(id, keccak256("x"));
        registry.setContractHash(id, keccak256("x"));
        assertEq(registry.getSeriesCore(id).contractHash, keccak256("x"));
        vm.prank(address(auction));
        registry.markRaiseOpened(id, makeAddr("token"), uint64(vm.getBlockTimestamp()));
        vm.prank(issuer);
        vm.expectRevert(SeriesNotDraft.selector);
        registry.setContractHash(id, keccak256("y"));
    }

    function test_seriesNotFound() public {
        vm.expectRevert(abi.encodeWithSelector(SeriesNotFound.selector, 0));
        registry.getSeriesCore(0);
        vm.expectRevert(abi.encodeWithSelector(SeriesNotFound.selector, 1));
        registry.getSeriesTerms(1);
    }

    // ------------------------------------------------------------ amendments

    function _amendSig(uint256 pk, uint256 id, uint64 nonce, bytes32 newTc, uint64 newCap)
        internal
        view
        returns (bytes memory)
    {
        return sign(pk, MercesMessages.amendDigest(domain, id, nonce, newTc, newCap));
    }

    function test_amendTermsHappyPath() public {
        uint256 id = createSeries(keccak256("terms"));
        bytes32 newTc = keccak256("terms-indexed");
        bytes memory sig = _amendSig(attestorKey, id, 0, newTc, 2.4e18);
        vm.prank(issuer);
        vm.expectEmit(true, true, false, true);
        emit IMercesRegistry.TermsAmended(id, 0, newTc, 2.4e18, attestor);
        registry.amendTerms(id, newTc, 2.4e18, sig, noTier1());
        assertEq(registry.getSeriesCore(id).termsCommitment, newTc);
        assertEq(registry.getSeriesCore(id).amendmentNonce, 1);
        assertEq(registry.getSeriesTerms(id).capMultipleWad, 2.4e18);
        vm.prank(issuer);
        vm.expectRevert(); // replay: nonce moved on
        registry.amendTerms(id, newTc, 2.4e18, sig, noTier1());
        sig = _amendSig(attestorKey, id, 1, keccak256("t3"), 2.4e18);
        vm.prank(issuer);
        registry.amendTerms(id, keccak256("t3"), 2.4e18, sig, noTier1());
        assertEq(registry.getSeriesCore(id).amendmentNonce, 2);
    }

    function test_amendTier1RequiresMatchingPlaintext() public {
        uint256 id = createSeriesWith(
            defaultSeriesParams(), defaultSchedule(), Proofs.q1().termsCommitment, 1 | 2, bytes32(0), proofTier1Terms()
        );
        Tier1Terms memory t = proofTier1Terms();
        t.theta = 90_000e6;
        bytes32 newTc = bytes32(
            IPoseidon5(poseidon5)
                .poseidon(
                    [uint256(t.theta), uint256(t.rWad), uint256(t.currencyCode), uint256(t.indexingRule), t.termsSalt]
                )
        );
        bytes memory sig = _amendSig(attestorKey, id, 0, newTc, 2.5e18);
        vm.prank(issuer);
        vm.expectRevert(TermsCommitmentMismatch.selector);
        registry.amendTerms(id, newTc, 2.5e18, sig, proofTier1Terms());
        vm.prank(issuer);
        registry.amendTerms(id, newTc, 2.5e18, sig, t);
        assertEq(registry.getRouterTerms(id).theta, 90_000e6);
        assertEq(registry.getSeriesCore(id).termsCommitment, newTc);
    }

    function test_amendTermsRejections() public {
        uint256 id = createSeries(keccak256("terms"));
        bytes32 newTc = keccak256("x");
        bytes memory sig = _amendSig(attestorKey, id, 0, newTc, 2.6e18);
        vm.prank(issuer);
        vm.expectRevert(UnfavourableAmendment.selector);
        registry.amendTerms(id, newTc, 2.6e18, sig, noTier1());
        sig = _amendSig(attestorKey, id, 0, newTc, 1.9e18);
        vm.prank(issuer);
        vm.expectRevert(UnfavourableAmendment.selector);
        registry.amendTerms(id, newTc, 1.9e18, sig, noTier1());
        sig = _amendSig(attestorKey, id, 0, newTc, 2.5e18);
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        registry.amendTerms(id, newTc, 2.5e18, sig, noTier1());
        uint256 rogueKey = 0xDEAD;
        sig = _amendSig(rogueKey, id, 0, newTc, 2.5e18);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestorSignature.selector, vm.addr(rogueKey)));
        registry.amendTerms(id, newTc, 2.5e18, sig, noTier1());
        // a revoked attestor cannot sign amendments (no grace for amendments)
        vm.prank(admin);
        registry.revokeAttestor(attestor);
        sig = _amendSig(attestorKey, id, 0, newTc, 2.5e18);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestorSignature.selector, attestor));
        registry.amendTerms(id, newTc, 2.5e18, sig, noTier1());
        sig = _amendSig(attestor2Key, id, 0, bytes32(0), 2.5e18);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("termsCommitment")));
        registry.amendTerms(id, bytes32(0), 2.5e18, sig, noTier1());
        // never after a terminal status (the tail cap is fixed at redemption)
        vm.prank(address(vault));
        registry.markTerminal(id, SeriesStatus.Redeemed);
        sig = _amendSig(attestor2Key, id, 0, newTc, 2.5e18);
        vm.prank(issuer);
        vm.expectRevert(AmendmentAfterTerminal.selector);
        registry.amendTerms(id, newTc, 2.5e18, sig, noTier1());
    }

    // ------------------------------------------------------------ protocol write interface

    function test_protocolWriteAccess() public {
        uint256 id = createSeries(keccak256("terms"));
        vm.expectRevert(NotProtocolContract.selector);
        registry.markRaiseOpened(id, makeAddr("token"), 1);
        vm.expectRevert(NotProtocolContract.selector);
        registry.markRaiseResult(id, RaiseState.Settled, 1, 1, 1);
        vm.expectRevert(NotProtocolContract.selector);
        registry.markMintFinalized(id);
        vm.expectRevert(NotProtocolContract.selector);
        registry.markTerminal(id, SeriesStatus.Retired);
        vm.prank(address(vault));
        vm.expectRevert(NotProtocolContract.selector);
        registry.markRaiseOpened(id, makeAddr("token"), 1);
        vm.prank(address(auction));
        vm.expectRevert(NotProtocolContract.selector);
        registry.markTerminal(id, SeriesStatus.Retired);
        vm.prank(address(income));
        vm.expectRevert(NotProtocolContract.selector);
        registry.markMintFinalized(id);
    }

    function test_raiseTransitionsWrittenOnce() public {
        uint256 id = createSeries(keccak256("terms"));
        address token = makeAddr("token");
        vm.startPrank(address(auction));
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markRaiseResult(id, RaiseState.Settled, 10, 100, 1e6); // not open yet
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markMintFinalized(id);
        vm.expectRevert(ZeroAddress.selector);
        registry.markRaiseOpened(id, address(0), 5);
        vm.expectEmit(true, false, false, true);
        emit IMercesRegistry.RaiseStateChanged(id, RaiseState.Open);
        registry.markRaiseOpened(id, token, 5);
        SeriesCore memory c = registry.getSeriesCore(id);
        assertEq(c.unitToken, token);
        assertEq(c.openedAt, 5);
        assertEq(uint8(c.raiseState), uint8(RaiseState.Open));
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markRaiseOpened(id, token, 5);
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markRaiseResult(id, RaiseState.Open, 10, 100, 1e6);
        registry.markRaiseResult(id, RaiseState.Settled, 10, 100, 1e6);
        c = registry.getSeriesCore(id);
        assertEq(c.settlementTs, 10);
        assertEq(c.unitsSold, 100);
        assertEq(c.clearingPrice, 1e6);
        // exact results are written once
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markRaiseResult(id, RaiseState.Settled, 10, 99, 1e6);
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markRaiseResult(id, RaiseState.Failed, 10, 0, 0);
        vm.expectEmit(true, false, false, true);
        emit IMercesRegistry.MintFinalized(id);
        registry.markMintFinalized(id);
        assertTrue(registry.getSeriesCore(id).mintFinalized);
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markMintFinalized(id);
        vm.stopPrank();
        assertTrue(registry.isTransferLocked(id, 10 + 47_336_400 - 1));
        assertFalse(registry.isTransferLocked(id, 10 + 47_336_400));

        uint256 id2 = createSeries(keccak256("terms2"));
        vm.startPrank(address(auction));
        registry.markRaiseOpened(id2, token, 5);
        registry.markRaiseResult(id2, RaiseState.Cancelled, 0, 0, 0);
        assertEq(uint8(registry.getSeriesCore(id2).raiseState), uint8(RaiseState.Cancelled));
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markRaiseResult(id2, RaiseState.Settled, 1, 1, 1);
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markMintFinalized(id2); // only a settled raise finalizes its mint
        vm.stopPrank();
        assertTrue(registry.isTransferLocked(id2, type(uint64).max));
    }

    function test_terminalTransitions() public {
        uint256 id = createSeries(keccak256("terms"));
        vm.startPrank(address(vault));
        vm.expectRevert(InvalidTerminalStatus.selector);
        registry.markTerminal(id, SeriesStatus.Late);
        vm.expectEmit(true, false, false, true);
        emit IMercesRegistry.TerminalStatusSet(id, SeriesStatus.Redeemed);
        registry.markTerminal(id, SeriesStatus.Redeemed);
        assertEq(registry.getSeriesCore(id).terminalStatus, uint8(SeriesStatus.Redeemed));
        vm.expectRevert(AlreadyTerminal.selector);
        registry.markTerminal(id, SeriesStatus.Retired);
        registry.markTerminal(id, SeriesStatus.Extinguished); // redeemed → extinguished is allowed
        assertEq(registry.getSeriesCore(id).terminalStatus, uint8(SeriesStatus.Extinguished));
        vm.expectRevert(AlreadyTerminal.selector);
        registry.markTerminal(id, SeriesStatus.Redeemed);
        vm.expectRevert(AlreadyTerminal.selector);
        registry.markTerminal(id, SeriesStatus.Extinguished);
        vm.stopPrank();

        uint256 id2 = createSeries(keccak256("terms2"));
        vm.startPrank(address(vault));
        registry.markTerminal(id2, SeriesStatus.Retired);
        registry.markTerminal(id2, SeriesStatus.Extinguished); // retired → extinguished is allowed (SPEC §6.9)
        vm.expectRevert(AlreadyTerminal.selector);
        registry.markTerminal(id2, SeriesStatus.Retired);
        vm.stopPrank();
    }

    /// @dev Charter fields are frozen after the raise opens: no function other than `amendTerms` writes them (F2).
    function test_charterTermsFrozenAfterOpen() public {
        uint256 id = createSeries(keccak256("terms"));
        vm.prank(address(auction));
        registry.markRaiseOpened(id, makeAddr("token"), uint64(vm.getBlockTimestamp()));
        bytes32 before = keccak256(abi.encode(registry.getSeriesTerms(id), registry.getReleaseSchedule(id)));
        vm.startPrank(address(auction));
        registry.markRaiseResult(id, RaiseState.Settled, uint64(vm.getBlockTimestamp()), 900, 1e6);
        registry.markMintFinalized(id);
        vm.stopPrank();
        vm.prank(address(vault));
        registry.markTerminal(id, SeriesStatus.Retired);
        vm.startPrank(admin);
        registry.setDefaults(defaultParameters());
        registry.setFlags(true, true, true);
        registry.deactivateIssuer(issuer);
        registry.setFxPair(FEED, true, stranger);
        vm.stopPrank();
        vm.prank(issuer);
        registry.stopIssuance();
        assertEq(keccak256(abi.encode(registry.getSeriesTerms(id), registry.getReleaseSchedule(id))), before);
    }

    function test_issuanceStopResume() public {
        vm.prank(stranger);
        vm.expectRevert(IssuerInactive.selector);
        registry.stopIssuance();
        vm.prank(issuer);
        vm.expectEmit(true, false, false, true);
        emit IMercesRegistry.IssuanceStopped(issuer);
        registry.stopIssuance();
        assertTrue(registry.getIssuer(issuer).issuanceStopped);
        vm.prank(issuer);
        registry.resumeIssuance();
        assertFalse(registry.getIssuer(issuer).issuanceStopped);
    }

    function test_setStablecoinReadsDecimals() public {
        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit IMercesRegistry.StablecoinSet(address(usdc), false, 6);
        registry.setStablecoin(address(usdc), false);
        assertFalse(registry.isStablecoinAllowed(address(usdc)));
    }
}
