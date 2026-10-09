// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {MercesDeploy} from "../../script/lib/MercesDeploy.sol";
import {TrexDeploy} from "../../script/lib/TrexDeploy.sol";
import {MercesRegistry} from "../../src/MercesRegistry.sol";
import {MercesAuction} from "../../src/MercesAuction.sol";
import {MercesTreasury} from "../../src/MercesTreasury.sol";
import {MercesVault} from "../../src/MercesVault.sol";
import {MercesIncome} from "../../src/MercesIncome.sol";
import {MercesRouter} from "../../src/MercesRouter.sol";
import {MercesWindow} from "../../src/MercesWindow.sol";
import {MercesFxAccumulator} from "../../src/MercesFxAccumulator.sol";
import {FeeCollector} from "../../src/FeeCollector.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockPyth} from "../../src/mocks/MockPyth.sol";
import {IMercesTokenFactory} from "../../src/interfaces/IMercesTokenFactory.sol";
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
import {
    Parameters,
    ReleaseTranche,
    SeriesMode,
    SeriesParams,
    Tier1Terms,
    TierFlags
} from "../../src/types/MercesTypes.sol";

/// @notice Shared deployment fixture: the whole protocol stack wired exactly as the deploy script does it
/// (`MercesDeploy`), a mock stablecoin and a mock Pyth, plus the actors and helpers every test uses.
abstract contract MercesFixture is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant USDC = 1e6;
    uint64 internal constant T0 = 1_767_225_600; // 2026-01-01T00:00:00Z

    // actors
    address internal admin = makeAddr("admin");
    address internal allowlistManager = makeAddr("allowlistManager");
    address internal issuer = makeAddr("issuer");
    address internal b1 = makeAddr("b1");
    address internal b2 = makeAddr("b2");
    address internal b3 = makeAddr("b3");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");
    uint256 internal attestorKey = 0xA11CE;
    address internal attestor = vm.addr(attestorKey);
    uint256 internal attestor2Key = 0xB0B;
    address internal attestor2 = vm.addr(attestor2Key);
    uint256 internal verifierKey = 0xC0FFEE;
    address internal verifier = vm.addr(verifierKey);

    // infrastructure
    MockUSDC internal usdc;
    MockPyth internal pyth;
    TimelockController internal timelock;
    FeeCollector internal feeCollector;
    MercesRegistry internal registry;
    MercesAuction internal auction;
    MercesTreasury internal treasury;
    MercesVault internal vault;
    MercesIncome internal income;
    MercesRouter internal router;
    MercesWindow internal window;
    MercesFxAccumulator internal fx;
    IMercesTokenFactory internal tokenFactory;
    address internal complianceModule;
    address internal governor;
    address internal groth16;
    address internal poseidon2;
    address internal poseidon5;
    TrexDeploy.Stack internal trex;
    /// @dev Cached so test helpers can build digests without an external call (which would consume a prank).
    bytes32 internal domain;

    function setUp() public virtual {
        vm.warp(T0);
        usdc = new MockUSDC();
        pyth = new MockPyth(0);
        MercesDeploy.Deployment memory d = MercesDeploy.deploy(
            vm,
            address(this),
            MercesDeploy.Config({
                admin: admin,
                allowlistManager: allowlistManager,
                timelockProposer: admin,
                timelockDelay: 1 days,
                pyth: address(pyth),
                defaults: defaultParameters()
            })
        );
        timelock = TimelockController(payable(d.timelock));
        feeCollector = FeeCollector(d.feeCollector);
        registry = MercesRegistry(d.registry);
        auction = MercesAuction(d.auction);
        treasury = MercesTreasury(d.treasury);
        vault = MercesVault(d.vault);
        income = MercesIncome(d.income);
        router = MercesRouter(d.router);
        window = MercesWindow(d.window);
        fx = MercesFxAccumulator(d.fx);
        tokenFactory = IMercesTokenFactory(d.tokenFactory);
        complianceModule = d.complianceModule;
        governor = d.governor;
        groth16 = d.groth16Verifier;
        poseidon2 = d.poseidon2;
        poseidon5 = d.poseidon5;
        trex = d.trex;
        domain = registry.domain();

        vm.startPrank(admin);
        registry.setStablecoin(address(usdc), true);
        registry.registerAttestor(attestor);
        registry.registerAttestor(attestor2);
        registry.registerVerifierKey(verifier);
        registry.registerIssuer(issuer);
        vm.stopPrank();

        allow(issuer);
    }

    // ---------------------------------------------------------------- parameters

    function defaultParameters() internal pure returns (Parameters memory) {
        return Parameters({
            capMultipleWad: 2.5e18,
            hurdleRateWad: 0.08e18,
            payoutMultipleK: 5,
            lockupSeconds: 47_336_400,
            walletCapBps: 1000,
            auctionFeeBps: 100,
            payoutFeeBps: 500,
            windowFeeBps: 100,
            nonRevealChargeBps: 100,
            commitDuration: 7 days,
            revealDuration: 2 days,
            windowCommitDuration: 3 days,
            windowRevealDuration: 1 days,
            fxMinCoverageBps: 8000,
            fxMaxStalenessSeconds: 3600,
            fxMaxConfBps: 100,
            fxDeviationBandBps: 200,
            maxPauseSeconds: 31_536_000,
            maxCumulativePauseSeconds: 63_072_000
        });
    }

    function defaultSeriesParams() internal view returns (SeriesParams memory) {
        return SeriesParams({
            stablecoin: address(usdc),
            unitsOffered: 1000,
            reservePrice: 1_000_000, // 1 USDC per unit
            minRaise: 500_000_000, // 500 USDC
            capMultipleWad: 2.5e18,
            hurdleRateWad: 0.08e18,
            payoutMultipleK: 5,
            lockupSeconds: 47_336_400,
            walletCapBps: 1000,
            commitDuration: 7 days,
            revealDuration: 2 days,
            windowCommitDuration: 3 days,
            windowRevealDuration: 1 days
        });
    }

    function defaultSchedule() internal pure returns (ReleaseTranche[] memory s) {
        s = new ReleaseTranche[](4);
        s[0] = ReleaseTranche({atOffsetSeconds: 0, bps: 2500});
        s[1] = ReleaseTranche({atOffsetSeconds: 90 days, bps: 2500});
        s[2] = ReleaseTranche({atOffsetSeconds: 180 days, bps: 2500});
        s[3] = ReleaseTranche({atOffsetSeconds: 270 days, bps: 2500});
    }

    function noTier1() internal pure returns (Tier1Terms memory t) {}

    /// @dev Plaintext of the terms commitment used by the test proofs (test/utils/Proofs.sol).
    function proofTier1Terms() internal pure returns (Tier1Terms memory) {
        return Tier1Terms({theta: 80_000e6, rWad: 1e15, currencyCode: 840, indexingRule: 0, termsSalt: 11111});
    }

    function walletCap(uint16 bps) internal pure returns (Parameters memory p) {
        p = defaultParameters();
        p.walletCapBps = bps;
    }

    // ---------------------------------------------------------------- actions

    function allow(address wallet) internal {
        vm.prank(allowlistManager);
        registry.setAllowed(wallet, true);
    }

    function disallow(address wallet) internal {
        vm.prank(allowlistManager);
        registry.setAllowed(wallet, false);
    }

    function fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
    }

    function sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Default series: tiers 2 + 3, stablecoin income, contract hash set.
    function createSeries(bytes32 termsCommitment) internal returns (uint256 id) {
        return createSeriesWith(
            defaultSeriesParams(),
            defaultSchedule(),
            termsCommitment,
            TierFlags.TIER2_ZKTLS | TierFlags.TIER3_ATTESTOR,
            bytes32(0),
            noTier1()
        );
    }

    function createSeriesWith(
        SeriesParams memory p,
        ReleaseTranche[] memory schedule,
        bytes32 termsCommitment,
        uint8 tierFlags,
        bytes32 fxPairId,
        Tier1Terms memory t1
    ) internal returns (uint256 id) {
        vm.prank(issuer);
        id = registry.createSeries(p, schedule, termsCommitment, tierFlags, fxPairId, SeriesMode.SealedBid, false, t1);
        vm.prank(issuer);
        registry.setContractHash(id, keccak256("signed HEU contract + charter"));
    }

    function unitToken(uint256 seriesId) internal view returns (IERC3643Token) {
        return IERC3643Token(registry.getSeriesCore(seriesId).unitToken);
    }

    function settlementTs(uint256 sid) internal view returns (uint64) {
        return registry.getSeriesCore(sid).settlementTs;
    }
}
