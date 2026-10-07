// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TrexDeploy} from "../../script/lib/TrexDeploy.sol";
import {MercesRegistry} from "../../src/MercesRegistry.sol";
import {FeeCollector} from "../../src/FeeCollector.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {IAgentRole} from "../../src/interfaces/external/IAgentRole.sol";
import {IIdFactoryLite} from "../../src/interfaces/external/IIdFactoryLite.sol";
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
import {IMercesTokenFactory} from "../../src/interfaces/IMercesTokenFactory.sol";
import {
    Parameters,
    ProtocolContracts,
    ReleaseTranche,
    SeriesMode,
    SeriesParams,
    TierFlags
} from "../../src/types/MercesTypes.sol";

/// @notice Shared deployment fixture: mock stablecoin, timelock, T-REX suite, registry, fee collector and
/// the 0.8.17 token factory / compliance module (deployed from artifacts).
abstract contract MercesFixture is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant USDC = 1e6;

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
    TimelockController internal timelock;
    TrexDeploy.Stack internal trex;
    FeeCollector internal feeCollector;
    MercesRegistry internal registry;
    address internal complianceModule;
    IMercesTokenFactory internal tokenFactory;

    /// @dev Addresses the compliance module / factory are wired to. Milestone fixtures override these with
    /// the real proxies; the base fixture uses stand-ins so the token unit can be tested in isolation.
    address internal windowAddr;
    address internal auctionAddr;
    address internal vaultAddr;

    uint64 internal constant T0 = 1_767_225_600; // 2026-01-01T00:00:00Z

    function setUp() public virtual {
        vm.warp(T0);
        usdc = new MockUSDC();

        address[] memory proposers = new address[](1);
        proposers[0] = admin;
        address[] memory executors = new address[](1);
        executors[0] = admin;
        timelock = new TimelockController(1 days, proposers, executors, address(0));

        trex = TrexDeploy.deploy(vm);
        feeCollector = new FeeCollector(address(timelock));
        registry = new MercesRegistry(
            admin,
            allowlistManager,
            address(feeCollector),
            uint64(block.chainid),
            defaultParameters(),
            trex.identityRegistry,
            trex.idFactory
        );

        // identity wiring: the registry is an identity-registry agent and owns the IdFactory (SPEC §4.2)
        IAgentRole(trex.identityRegistry).addAgent(address(registry));
        IIdFactoryLite(trex.idFactory).transferOwnership(address(registry));

        _deployProtocol();

        // hand T-REX ownership to the timelock
        IAgentRole(trex.identityRegistry).transferOwnership(address(timelock));
        IAgentRole(trex.identityRegistryStorage).transferOwnership(address(timelock));
        IAgentRole(trex.claimTopicsRegistry).transferOwnership(address(timelock));
        IAgentRole(trex.trustedIssuersRegistry).transferOwnership(address(timelock));
        IAgentRole(trex.implementationAuthority).transferOwnership(address(timelock));
        IAgentRole(trex.identityImplementationAuthority).transferOwnership(address(timelock));

        vm.startPrank(admin);
        registry.setStablecoin(address(usdc), true);
        registry.registerAttestor(attestor);
        registry.registerAttestor(attestor2);
        registry.registerVerifierKey(verifier);
        registry.registerIssuer(issuer);
        vm.stopPrank();

        allow(issuer);
    }

    /// @dev Base behaviour: stand-in addresses, token unit only. Milestone fixtures override.
    function _deployProtocol() internal virtual {
        windowAddr = makeAddr("windowStub");
        auctionAddr = address(this);
        vaultAddr = makeAddr("vaultStub");
        _deployTokenUnit();
    }

    function _deployTokenUnit() internal {
        complianceModule = deployCode("MercesComplianceModule.sol:MercesComplianceModule", abi.encode(windowAddr));
        tokenFactory = IMercesTokenFactory(
            deployCode(
                "MercesTokenFactory.sol:MercesTokenFactory",
                abi.encode(
                    trex.implementationAuthority,
                    trex.identityRegistry,
                    complianceModule,
                    auctionAddr,
                    vaultAddr,
                    address(timelock)
                )
            )
        );
    }

    // ---------------------------------------------------------------- helpers

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
            fxDeviationBandBps: 200
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

    function createSeries(bytes32 termsCommitment) internal returns (uint256 id) {
        vm.prank(issuer);
        id = registry.createSeries(
            defaultSeriesParams(),
            defaultSchedule(),
            termsCommitment,
            TierFlags.TIER2_ZKTLS | TierFlags.TIER3_ATTESTOR,
            bytes32(0),
            SeriesMode.SealedBid,
            false
        );
        vm.prank(issuer);
        registry.setContractHash(id, keccak256("signed HEU contract + charter"));
    }

    function deployProxy(address impl, bytes memory init) internal returns (address) {
        return address(new ERC1967Proxy(impl, init));
    }
}
