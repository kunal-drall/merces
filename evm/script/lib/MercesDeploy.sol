// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TrexDeploy} from "./TrexDeploy.sol";
import {MercesRegistry} from "../../src/MercesRegistry.sol";
import {MercesAuction} from "../../src/MercesAuction.sol";
import {MercesTreasury} from "../../src/MercesTreasury.sol";
import {MercesVault} from "../../src/MercesVault.sol";
import {MercesIncome} from "../../src/MercesIncome.sol";
import {MercesRouter} from "../../src/MercesRouter.sol";
import {MercesWindow} from "../../src/MercesWindow.sol";
import {MercesFxAccumulator} from "../../src/MercesFxAccumulator.sol";
import {MercesTokenGovernor} from "../../src/MercesTokenGovernor.sol";
import {FeeCollector} from "../../src/FeeCollector.sol";
import {Groth16Verifier} from "../../src/zk/Groth16Verifier.sol";
import {PoseidonBytecode, PoseidonDeployer} from "../../src/zk/PoseidonBytecode.sol";
import {IAgentRole} from "../../src/interfaces/external/IAgentRole.sol";
import {IIdFactoryLite} from "../../src/interfaces/external/IIdFactoryLite.sol";
import {Parameters, ProtocolContracts} from "../../src/types/MercesTypes.sol";

/// @notice Deploys and wires the whole Merces EVM stack (SPEC v1.1 §0, §3, §4.2). Shared by the deploy scripts
/// and the test fixtures so both exercise the same wiring.
///
/// The registry fixes the protocol contracts at construction and the UUPS proxies need the registry address at
/// initialization, so the registry's address is predicted from the deployer's nonce (ten CREATEs ahead) and the
/// proxies are initialized against it before it exists; the deployment reverts if the prediction is wrong.
/// Ownership: the money proxies and the T-REX implementation authorities belong to the `TimelockController`;
/// the shared `IdentityRegistry` stack belongs to the `MercesTokenGovernor` (a dead end), with `MercesRegistry`
/// as its only agent; `MercesAuction` and `MercesWindow` get T-REX identities.
library MercesDeploy {
    struct Config {
        address admin;
        address allowlistManager;
        address timelockProposer;
        uint256 timelockDelay;
        address pyth;
        Parameters defaults;
    }

    struct Deployment {
        address timelock;
        address feeCollector;
        TrexDeploy.Stack trex;
        address poseidon2;
        address poseidon5;
        address groth16Verifier;
        address auctionImpl;
        address treasuryImpl;
        address vaultImpl;
        address fxImpl;
        address routerImpl;
        address incomeImpl;
        address windowImpl;
        address auction;
        address treasury;
        address vault;
        address fx;
        address router;
        address income;
        address window;
        address governor;
        address complianceModule;
        address tokenFactory;
        address registry;
    }

    /// @dev Number of CREATEs between the registry address prediction and the registry deployment: seven
    /// proxies, the governor, the compliance module and the token factory.
    uint64 internal constant CREATES_BEFORE_REGISTRY = 10;
    /// @dev The income proxy is the sixth proxy (0-based index 5); the router proxy needs its address first.
    uint64 internal constant CREATES_BEFORE_INCOME = 5;

    function deploy(Vm vm, address deployer, Config memory cfg) internal returns (Deployment memory d) {
        _deployInfrastructure(vm, d, cfg);
        _deployImplementations(d);
        _deployProxies(vm, deployer, d, cfg);
        _deployTokenUnit(vm, d);
        _deployRegistry(d, cfg);
        _wire(d);
    }

    function _deployInfrastructure(Vm vm, Deployment memory d, Config memory cfg) private {
        address[] memory proposers = new address[](1);
        proposers[0] = cfg.timelockProposer;
        address[] memory executors = new address[](1);
        executors[0] = cfg.timelockProposer;
        d.timelock = address(new TimelockController(cfg.timelockDelay, proposers, executors, address(0)));
        d.feeCollector = address(new FeeCollector(d.timelock));
        d.trex = TrexDeploy.deploy(vm);
        d.poseidon2 = PoseidonDeployer.deploy(PoseidonBytecode.poseidon2());
        d.poseidon5 = PoseidonDeployer.deploy(PoseidonBytecode.poseidon5());
        d.groth16Verifier = address(new Groth16Verifier());
    }

    function _deployImplementations(Deployment memory d) private {
        d.auctionImpl = address(new MercesAuction());
        d.treasuryImpl = address(new MercesTreasury());
        d.vaultImpl = address(new MercesVault());
        d.fxImpl = address(new MercesFxAccumulator());
        d.routerImpl = address(new MercesRouter());
        d.incomeImpl = address(new MercesIncome());
        d.windowImpl = address(new MercesWindow());
    }

    /// @dev The proxies are initialized against the predicted registry address (and the router against the
    /// predicted income address); both predictions are verified when the contracts are created.
    function _deployProxies(Vm vm, address deployer, Deployment memory d, Config memory cfg) private {
        uint64 nonce = vm.getNonce(deployer);
        d.registry = vm.computeCreateAddress(deployer, nonce + CREATES_BEFORE_REGISTRY);
        address incomePredicted = vm.computeCreateAddress(deployer, nonce + CREATES_BEFORE_INCOME);
        address tl = d.timelock;
        address reg = d.registry;
        d.auction = _proxy(d.auctionImpl, abi.encodeCall(MercesAuction.initialize, (tl, reg)));
        d.treasury = _proxy(d.treasuryImpl, abi.encodeCall(MercesTreasury.initialize, (tl, reg)));
        d.vault = _proxy(d.vaultImpl, abi.encodeCall(MercesVault.initialize, (tl, reg)));
        d.fx = _proxy(d.fxImpl, abi.encodeCall(MercesFxAccumulator.initialize, (tl, reg, cfg.pyth)));
        d.router = _proxy(d.routerImpl, abi.encodeCall(MercesRouter.initialize, (tl, reg, incomePredicted)));
        d.income = _proxy(
            d.incomeImpl,
            abi.encodeCall(MercesIncome.initialize, (tl, reg, d.groth16Verifier, d.fx, d.router, d.poseidon2))
        );
        require(d.income == incomePredicted, "MercesDeploy: income address mismatch");
        d.window = _proxy(d.windowImpl, abi.encodeCall(MercesWindow.initialize, (tl, reg)));
    }

    function _deployTokenUnit(Vm vm, Deployment memory d) private {
        d.governor = address(new MercesTokenGovernor());
        d.complianceModule = _create(vm, "MercesComplianceModule.sol:MercesComplianceModule", "");
        d.tokenFactory = _create(
            vm,
            "MercesTokenFactory.sol:MercesTokenFactory",
            abi.encode(
                d.trex.implementationAuthority,
                d.trex.identityRegistry,
                d.complianceModule,
                d.auction,
                d.vault,
                d.window,
                d.governor
            )
        );
    }

    function _deployRegistry(Deployment memory d, Config memory cfg) private {
        ProtocolContracts memory contracts = ProtocolContracts({
            auction: d.auction,
            treasury: d.treasury,
            income: d.income,
            vault: d.vault,
            window: d.window,
            tokenFactory: d.tokenFactory
        });
        address registry = address(
            new MercesRegistry(
                cfg.admin,
                cfg.allowlistManager,
                d.feeCollector,
                uint64(block.chainid),
                cfg.defaults,
                d.trex.identityRegistry,
                d.trex.idFactory,
                d.poseidon5,
                contracts
            )
        );
        require(registry == d.registry, "MercesDeploy: registry address mismatch");
    }

    /// @dev Identity wiring (SPEC §4.2): the registry is the identity registry's only agent and owns the
    /// IdFactory; the IR stack goes to the governor (no configuration surface) and the implementation
    /// authorities to the timelock.
    function _wire(Deployment memory d) private {
        IAgentRole(d.trex.identityRegistry).addAgent(d.registry);
        IIdFactoryLite(d.trex.idFactory).transferOwnership(d.registry);
        MercesRegistry(d.registry).registerProtocolIdentities();
        IAgentRole(d.trex.identityRegistry).transferOwnership(d.governor);
        IAgentRole(d.trex.identityRegistryStorage).transferOwnership(d.governor);
        IAgentRole(d.trex.claimTopicsRegistry).transferOwnership(d.governor);
        IAgentRole(d.trex.trustedIssuersRegistry).transferOwnership(d.governor);
        IAgentRole(d.trex.implementationAuthority).transferOwnership(d.timelock);
        IAgentRole(d.trex.identityImplementationAuthority).transferOwnership(d.timelock);
    }

    function _proxy(address impl, bytes memory init) private returns (address) {
        return address(new ERC1967Proxy(impl, init));
    }

    function _create(Vm vm, string memory artifact, bytes memory args) private returns (address addr) {
        bytes memory bytecode = abi.encodePacked(vm.getCode(artifact), args);
        assembly ("memory-safe") {
            addr := create(0, add(bytecode, 0x20), mload(bytecode))
        }
        require(addr != address(0), string.concat("MercesDeploy: deployment failed: ", artifact));
    }
}
