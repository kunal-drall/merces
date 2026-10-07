// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {MercesFixture} from "../utils/MercesFixture.sol";
import {MercesRegistry} from "../../src/MercesRegistry.sol";
import {IMercesRegistry} from "../../src/interfaces/IMercesRegistry.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {IIdentityRegistryLite} from "../../src/interfaces/external/IIdentityRegistryLite.sol";
import {IIdFactoryLite} from "../../src/interfaces/external/IIdFactoryLite.sol";
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
} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

contract RegistryTest is MercesFixture {
    address internal auctionStub = makeAddr("auctionStubForRegistry");
    address internal vaultStub = makeAddr("vaultStubForRegistry");

    function _setContracts() internal {
        vm.prank(admin);
        registry.setProtocolContracts(
            ProtocolContracts({
                auction: auctionStub,
                treasury: makeAddr("t"),
                income: makeAddr("i"),
                vault: vaultStub,
                window: makeAddr("w"),
                tokenFactory: address(tokenFactory)
            })
        );
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
    }

    function test_initRejectsChainIdMismatch() public {
        vm.expectRevert(abi.encodeWithSelector(ChainIdMismatch.selector, 10143, block.chainid));
        new MercesRegistry(
            admin, allowlistManager, address(feeCollector), 10143, defaultParameters(), trex.identityRegistry, trex.idFactory
        );
    }

    function test_initRejectsOutOfBoundDefaults() public {
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
            trex.idFactory
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
        registry.registerVerifierKey(stranger);
        vm.expectRevert(NotAdmin.selector);
        registry.revokeVerifierKey(verifier);
        vm.expectRevert(NotAdmin.selector);
        registry.setFxPair(bytes32("x"), bytes32("f"), false, address(0), true);
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
    }

    function test_flagsAndKeys() public {
        vm.startPrank(admin);
        vm.expectEmit(true, true, true, true);
        emit IMercesRegistry.FlagsSet(true, true, true);
        registry.setFlags(true, true, true);
        Flags memory f = registry.getFlags();
        assertTrue(f.newRaisesPaused && f.windowsEnabled && f.tier4Enabled);

        registry.setEarlyDrawApprover(stranger);
        assertEq(registry.earlyDrawApprover(), stranger);

        assertTrue(registry.isAttestor(attestor));
        registry.revokeAttestor(attestor);
        assertFalse(registry.isAttestor(attestor));
        assertTrue(registry.isVerifierKey(verifier));
        registry.revokeVerifierKey(verifier);
        assertFalse(registry.isVerifierKey(verifier));

        registry.setFxPair(bytes32("EURUSD"), bytes32("feed"), true, stranger, true);
        FxPairConfig memory fx = registry.getFxPair(bytes32("EURUSD"));
        assertEq(fx.feedId, bytes32("feed"));
        assertTrue(fx.inverted);
        assertEq(fx.crosscheck, stranger);
        assertTrue(fx.enabled);
        vm.expectRevert(abi.encodeWithSelector(UnknownFxPair.selector, bytes32(0)));
        registry.setFxPair(bytes32(0), bytes32("feed"), false, address(0), true);

        Parameters memory p = defaultParameters();
        p.walletCapBps = 50;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("walletCapBps")));
        registry.setDefaults(p);
        p.walletCapBps = 2000;
        registry.setDefaults(p);
        assertEq(registry.getDefaults().walletCapBps, 2000);
        vm.stopPrank();
    }

    function test_protocolContractsOneShot() public {
        _setContracts();
        assertTrue(registry.protocolContractsSet());
        assertEq(registry.getProtocolContracts().auction, auctionStub);
        ProtocolContracts memory again = registry.getProtocolContracts();
        vm.prank(admin);
        vm.expectRevert(ProtocolContractsAlreadySet.selector);
        registry.setProtocolContracts(again);
    }

    // ------------------------------------------------------------ allowlist == identity registry membership

    function test_allowlistCreatesIdentityAndRegisters() public {
        assertFalse(registry.isAllowed(b1));
        vm.prank(allowlistManager);
        vm.expectEmit(true, false, false, true);
        emit IMercesRegistry.AllowlistUpdated(b1, true);
        registry.setAllowed(b1, true);
        assertTrue(registry.isAllowed(b1));
        IIdentityRegistryLite ir = IIdentityRegistryLite(trex.identityRegistry);
        assertTrue(ir.contains(b1));
        address identity = ir.identity(b1);
        assertTrue(identity != address(0));
        assertEq(IIdFactoryLite(trex.idFactory).getIdentity(b1), identity);
        assertEq(ir.investorCountry(b1), 0);
        assertTrue(identity.code.length > 0);

        // removal = deleteIdentity; identity contract persists and is reused on re-allow
        disallow(b1);
        assertFalse(registry.isAllowed(b1));
        assertFalse(ir.contains(b1));
        allow(b1);
        assertTrue(registry.isAllowed(b1));
        assertEq(ir.identity(b1), identity);

        // idempotent
        allow(b1);
        disallow(b2);
        assertFalse(registry.isAllowed(b2));
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
        ReleaseTranche[] memory s = registry.getReleaseSchedule(id);
        assertEq(s.length, 4);
        assertEq(s[3].atOffsetSeconds, 270 days);
        assertEq(registry.getIssuer(issuer).seriesCount, 1);
        assertTrue(registry.isTransferLocked(id, block.timestamp));
    }

    function test_createSeriesGuards() public {
        SeriesParams memory p = defaultSeriesParams();
        ReleaseTranche[] memory s = defaultSchedule();
        bytes32 tc = keccak256("terms");

        // not an issuer
        vm.prank(stranger);
        vm.expectRevert(IssuerNotActive.selector);
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);

        // deactivated issuer
        vm.prank(admin);
        registry.deactivateIssuer(issuer);
        vm.prank(issuer);
        vm.expectRevert(IssuerNotActive.selector);
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        vm.prank(admin);
        registry.registerIssuer(issuer);

        // issuer stopped issuance
        vm.prank(issuer);
        registry.stopIssuance();
        vm.prank(issuer);
        vm.expectRevert(IssuanceStoppedByIssuer.selector);
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        vm.prank(issuer);
        registry.resumeIssuance();

        // issuer not allowlisted
        disallow(issuer);
        vm.prank(issuer);
        vm.expectRevert(IssuerNotAllowlisted.selector);
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        allow(issuer);

        vm.startPrank(issuer);
        vm.expectRevert(CurveModeUnsupported.selector);
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.Curve, true);

        p.stablecoin = address(0x1234);
        vm.expectRevert(abi.encodeWithSelector(StablecoinNotAllowed.selector, address(0x1234)));
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.stablecoin = address(usdc);

        p.unitsOffered = 0;
        vm.expectRevert(InvalidUnitsOffered.selector);
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.unitsOffered = 1000;

        p.reservePrice = 0;
        vm.expectRevert(InvalidReservePrice.selector);
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.reservePrice = 1_000_000;

        p.minRaise = 1_000_000_001;
        vm.expectRevert(MinRaiseTooHigh.selector);
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.minRaise = 500_000_000;

        p.reservePrice = type(uint64).max;
        vm.expectRevert(abi.encodeWithSelector(AmountExceedsU64.selector, uint256(type(uint64).max) * 1000));
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.reservePrice = 1_000_000;

        vm.expectRevert(InvalidTierFlags.selector);
        registry.createSeries(p, s, tc, 0, bytes32(0), SeriesMode.SealedBid, false);
        vm.expectRevert(InvalidTierFlags.selector);
        registry.createSeries(p, s, tc, 0x10, bytes32(0), SeriesMode.SealedBid, false);

        vm.expectRevert(abi.encodeWithSelector(UnknownFxPair.selector, bytes32("EUR")));
        registry.createSeries(p, s, tc, 2, bytes32("EUR"), SeriesMode.SealedBid, false);

        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("termsCommitment")));
        registry.createSeries(p, s, bytes32(0), 2, bytes32(0), SeriesMode.SealedBid, false);

        p.capMultipleWad = 3.1e18;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("capMultipleWad")));
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.capMultipleWad = 2.5e18;

        p.hurdleRateWad = 0.26e18;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("hurdleRateWad")));
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.hurdleRateWad = 0.08e18;

        p.payoutMultipleK = 0;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("payoutMultipleK")));
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.payoutMultipleK = 21;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("payoutMultipleK")));
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.payoutMultipleK = 5;

        p.lockupSeconds = 157_680_001;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("lockupSeconds")));
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.lockupSeconds = 0; // zero lockup is within bounds

        p.commitDuration = 59 minutes;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("commitDuration")));
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.commitDuration = 31 days;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("commitDuration")));
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.commitDuration = 7 days;

        p.revealDuration = 8 days;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("revealDuration")));
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.revealDuration = 2 days;

        p.windowCommitDuration = 15 days;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("windowCommitDuration")));
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.windowCommitDuration = 3 days;

        p.windowRevealDuration = 8 days;
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("windowRevealDuration")));
        registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        p.windowRevealDuration = 1 days;

        // schedules
        ReleaseTranche[] memory bad = new ReleaseTranche[](0);
        vm.expectRevert(InvalidReleaseSchedule.selector);
        registry.createSeries(p, bad, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        bad = new ReleaseTranche[](2);
        bad[0] = ReleaseTranche(0, 5000);
        bad[1] = ReleaseTranche(1, 4999);
        vm.expectRevert(InvalidReleaseSchedule.selector);
        registry.createSeries(p, bad, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        bad[0] = ReleaseTranche(10, 5000);
        bad[1] = ReleaseTranche(1, 5000);
        vm.expectRevert(InvalidReleaseSchedule.selector);
        registry.createSeries(p, bad, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        bad = new ReleaseTranche[](25);
        for (uint256 i = 0; i < 25; i++) {
            bad[i] = ReleaseTranche(uint64(i), 400);
        }
        vm.expectRevert(InvalidReleaseSchedule.selector);
        registry.createSeries(p, bad, tc, 2, bytes32(0), SeriesMode.SealedBid, false);

        // a valid one still works after all that
        uint256 id = registry.createSeries(p, s, tc, 2, bytes32(0), SeriesMode.SealedBid, false);
        assertEq(id, 1);
        vm.stopPrank();
    }

    function test_feesAndWalletCapCopiedFromDefaults() public {
        Parameters memory d = defaultParameters();
        d.auctionFeeBps = 250;
        d.payoutFeeBps = 750;
        d.walletCapBps = 500;
        vm.prank(admin);
        registry.setDefaults(d);
        uint256 id = createSeries(keccak256("terms"));
        SeriesTerms memory t = registry.getSeriesTerms(id);
        assertEq(t.auctionFeeBps, 250);
        assertEq(t.payoutFeeBps, 750);
        assertEq(t.walletCapBps, 500);
        // later default changes do not touch existing series
        d.payoutFeeBps = 100;
        vm.prank(admin);
        registry.setDefaults(d);
        assertEq(registry.getSeriesTerms(id).payoutFeeBps, 750);
    }

    function test_contractHash() public {
        vm.prank(issuer);
        uint256 id = registry.createSeries(
            defaultSeriesParams(), defaultSchedule(), keccak256("t"), 2, bytes32(0), SeriesMode.SealedBid, false
        );
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        registry.setContractHash(id, keccak256("x"));
        vm.prank(issuer);
        vm.expectRevert(ContractHashZero.selector);
        registry.setContractHash(id, bytes32(0));
        vm.prank(issuer);
        registry.setContractHash(id, keccak256("x"));
        assertEq(registry.getSeriesCore(id).contractHash, keccak256("x"));
        // once opened, it is frozen
        _setContracts();
        vm.prank(auctionStub);
        registry.markRaiseOpened(id, makeAddr("token"), uint64(block.timestamp));
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
        return sign(pk, MercesMessages.amendDigest(registry.domain(), id, nonce, newTc, newCap));
    }

    function test_amendTermsHappyPath() public {
        uint256 id = createSeries(keccak256("terms"));
        bytes32 newTc = keccak256("terms-indexed");
        bytes memory sig = _amendSig(attestorKey, id, 0, newTc, 2.4e18);
        vm.prank(issuer);
        vm.expectEmit(true, true, false, true);
        emit IMercesRegistry.TermsAmended(id, 0, newTc, 2.4e18, attestor);
        registry.amendTerms(id, newTc, 2.4e18, sig);
        assertEq(registry.getSeriesCore(id).termsCommitment, newTc);
        assertEq(registry.getSeriesCore(id).amendmentNonce, 1);
        assertEq(registry.getSeriesTerms(id).capMultipleWad, 2.4e18);

        // replay with the same signature fails (nonce moved on)
        vm.prank(issuer);
        vm.expectRevert();
        registry.amendTerms(id, newTc, 2.4e18, sig);

        // second amendment with nonce 1 works, cap unchanged allowed
        sig = _amendSig(attestorKey, id, 1, keccak256("t3"), 2.4e18);
        vm.prank(issuer);
        registry.amendTerms(id, keccak256("t3"), 2.4e18, sig);
        assertEq(registry.getSeriesCore(id).amendmentNonce, 2);
    }

    function test_amendTermsRejections() public {
        uint256 id = createSeries(keccak256("terms"));
        bytes32 newTc = keccak256("x");

        // cap may only decrease
        bytes memory sig = _amendSig(attestorKey, id, 0, newTc, 2.6e18);
        vm.prank(issuer);
        vm.expectRevert(CapMultipleIncrease.selector);
        registry.amendTerms(id, newTc, 2.6e18, sig);

        // below bounds
        sig = _amendSig(attestorKey, id, 0, newTc, 1.9e18);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("capMultipleWad")));
        registry.amendTerms(id, newTc, 1.9e18, sig);

        // not the issuer
        sig = _amendSig(attestorKey, id, 0, newTc, 2.5e18);
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        registry.amendTerms(id, newTc, 2.5e18, sig);

        // unregistered signer
        uint256 rogueKey = 0xDEAD;
        sig = _amendSig(rogueKey, id, 0, newTc, 2.5e18);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AttestorNotRegistered.selector, vm.addr(rogueKey)));
        registry.amendTerms(id, newTc, 2.5e18, sig);

        // revoked attestor
        vm.prank(admin);
        registry.revokeAttestor(attestor);
        sig = _amendSig(attestorKey, id, 0, newTc, 2.5e18);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AttestorNotRegistered.selector, attestor));
        registry.amendTerms(id, newTc, 2.5e18, sig);

        // zero commitment
        sig = _amendSig(attestor2Key, id, 0, bytes32(0), 2.5e18);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ParameterOutOfBounds.selector, bytes32("termsCommitment")));
        registry.amendTerms(id, bytes32(0), 2.5e18, sig);

        // terminal series cannot be amended
        _setContracts();
        vm.prank(vaultStub);
        registry.markTerminal(id, SeriesStatus.Retired);
        sig = _amendSig(attestor2Key, id, 0, newTc, 2.5e18);
        vm.prank(issuer);
        vm.expectRevert(SeriesTerminal.selector);
        registry.amendTerms(id, newTc, 2.5e18, sig);
    }

    // ------------------------------------------------------------ protocol write interface

    function test_protocolWriteAccess() public {
        uint256 id = createSeries(keccak256("terms"));
        vm.expectRevert(NotProtocolContract.selector);
        registry.markRaiseOpened(id, makeAddr("token"), 1);
        vm.expectRevert(NotProtocolContract.selector);
        registry.markRaiseResult(id, RaiseState.Settled, 1, 1, 1);
        vm.expectRevert(NotProtocolContract.selector);
        registry.markTerminal(id, SeriesStatus.Retired);
        _setContracts();
        vm.prank(vaultStub);
        vm.expectRevert(NotProtocolContract.selector);
        registry.markRaiseOpened(id, makeAddr("token"), 1);
        vm.prank(auctionStub);
        vm.expectRevert(NotProtocolContract.selector);
        registry.markTerminal(id, SeriesStatus.Retired);
    }

    function test_raiseTransitions() public {
        uint256 id = createSeries(keccak256("terms"));
        _setContracts();
        address token = makeAddr("token");
        vm.startPrank(auctionStub);
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markRaiseResult(id, RaiseState.Settled, 10, 100, 1e6); // not open yet
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
        // correction only downwards and with the same ts / price
        vm.expectRevert(UnitsSoldIncrease.selector);
        registry.markRaiseResult(id, RaiseState.Settled, 10, 101, 1e6);
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markRaiseResult(id, RaiseState.Settled, 11, 99, 1e6);
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markRaiseResult(id, RaiseState.Failed, 10, 0, 0);
        registry.markRaiseResult(id, RaiseState.Settled, 10, 98, 1e6);
        assertEq(registry.getSeriesCore(id).unitsSold, 98);
        vm.stopPrank();
        assertTrue(registry.isTransferLocked(id, 10 + 47_336_400 - 1));
        assertFalse(registry.isTransferLocked(id, 10 + 47_336_400));

        // failed / cancelled paths
        uint256 id2 = createSeries(keccak256("terms2"));
        vm.startPrank(auctionStub);
        registry.markRaiseOpened(id2, token, 5);
        registry.markRaiseResult(id2, RaiseState.Cancelled, 0, 0, 0);
        assertEq(uint8(registry.getSeriesCore(id2).raiseState), uint8(RaiseState.Cancelled));
        vm.expectRevert(InvalidRaiseTransition.selector);
        registry.markRaiseResult(id2, RaiseState.Settled, 1, 1, 1);
        vm.stopPrank();
        assertTrue(registry.isTransferLocked(id2, type(uint64).max));
    }

    function test_terminalTransitions() public {
        uint256 id = createSeries(keccak256("terms"));
        _setContracts();
        vm.startPrank(vaultStub);
        vm.expectRevert(InvalidTerminalStatus.selector);
        registry.markTerminal(id, SeriesStatus.Late);
        vm.expectEmit(true, false, false, true);
        emit IMercesRegistry.TerminalStatusSet(id, SeriesStatus.Redeemed);
        registry.markTerminal(id, SeriesStatus.Redeemed);
        assertEq(registry.getSeriesCore(id).terminalStatus, uint8(SeriesStatus.Redeemed));
        vm.expectRevert(AlreadyTerminal.selector);
        registry.markTerminal(id, SeriesStatus.Retired);
        // redeemed → extinguished is the one allowed second transition
        registry.markTerminal(id, SeriesStatus.Extinguished);
        assertEq(registry.getSeriesCore(id).terminalStatus, uint8(SeriesStatus.Extinguished));
        vm.expectRevert(AlreadyTerminal.selector);
        registry.markTerminal(id, SeriesStatus.Redeemed);
        vm.stopPrank();

        uint256 id2 = createSeries(keccak256("terms2"));
        vm.startPrank(vaultStub);
        registry.markTerminal(id2, SeriesStatus.Retired);
        vm.expectRevert(AlreadyTerminal.selector);
        registry.markTerminal(id2, SeriesStatus.Extinguished);
        vm.stopPrank();
    }

    /// @dev Charter fields are frozen after the raise opens: no function other than `amendTerms` writes them.
    function test_charterTermsFrozenAfterOpen() public {
        uint256 id = createSeries(keccak256("terms"));
        _setContracts();
        vm.prank(auctionStub);
        registry.markRaiseOpened(id, makeAddr("token"), uint64(block.timestamp));
        bytes32 before = keccak256(abi.encode(registry.getSeriesTerms(id), registry.getReleaseSchedule(id)));
        // run every non-amend write path that touches this series
        vm.startPrank(auctionStub);
        registry.markRaiseResult(id, RaiseState.Settled, uint64(block.timestamp), 900, 1e6);
        registry.markRaiseResult(id, RaiseState.Settled, uint64(block.timestamp), 890, 1e6);
        vm.stopPrank();
        vm.prank(vaultStub);
        registry.markTerminal(id, SeriesStatus.Retired);
        vm.startPrank(admin);
        registry.setDefaults(defaultParameters());
        registry.setFlags(true, true, true);
        registry.deactivateIssuer(issuer);
        vm.stopPrank();
        vm.prank(issuer);
        registry.stopIssuance();
        assertEq(keccak256(abi.encode(registry.getSeriesTerms(id), registry.getReleaseSchedule(id))), before);
    }

    function test_issuanceStopResume() public {
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
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
