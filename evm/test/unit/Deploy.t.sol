// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {MercesFixture} from "../utils/MercesFixture.sol";
import {IAgentRole} from "../../src/interfaces/external/IAgentRole.sol";
import {IIdentityRegistryLite} from "../../src/interfaces/external/IIdentityRegistryLite.sol";
import {IIdFactoryLite} from "../../src/interfaces/external/IIdFactoryLite.sol";
import {IPoseidon2, IPoseidon5} from "../../src/interfaces/IPoseidon.sol";
import {MercesTokenGovernor} from "../../src/MercesTokenGovernor.sol";
import {ProtocolContracts} from "../../src/types/MercesTypes.sol";

/// @notice Deployment wiring (SPEC v1.1 §0, §3.1, §4.2): fixed protocol contracts, ownership split between the
/// timelock and the governor, protocol identities, Poseidon hashers.
contract DeployTest is MercesFixture {
    function test_protocolContractsFixedAtInit() public view {
        ProtocolContracts memory c = registry.getProtocolContracts();
        assertEq(c.auction, address(auction));
        assertEq(c.treasury, address(treasury));
        assertEq(c.income, address(income));
        assertEq(c.vault, address(vault));
        assertEq(c.window, address(window));
        assertEq(c.tokenFactory, address(tokenFactory));
        assertEq(registry.poseidon5(), poseidon5);
        assertEq(registry.identityRegistry(), trex.identityRegistry);
        assertEq(registry.idFactory(), trex.idFactory);
    }

    function test_moneyCodeOwnedByTimelock() public view {
        assertEq(auction.owner(), address(timelock));
        assertEq(treasury.owner(), address(timelock));
        assertEq(vault.owner(), address(timelock));
        assertEq(income.owner(), address(timelock));
        assertEq(router.owner(), address(timelock));
        assertEq(window.owner(), address(timelock));
        assertEq(fx.owner(), address(timelock));
        assertEq(feeCollector.owner(), address(timelock));
        assertEq(IAgentRole(trex.implementationAuthority).owner(), address(timelock));
        assertEq(IAgentRole(trex.identityImplementationAuthority).owner(), address(timelock));
        assertEq(auction.registry().domain(), domain);
        assertEq(income.router(), address(router));
        assertEq(income.poseidon2(), poseidon2);
        assertEq(income.groth16Verifier(), groth16);
        assertEq(income.fxAccumulator(), address(fx));
        assertEq(router.income(), address(income));
        assertEq(fx.pyth(), address(pyth));
    }

    function test_identityStackOwnedByGovernor() public view {
        assertEq(IAgentRole(trex.identityRegistry).owner(), governor);
        assertEq(IAgentRole(trex.identityRegistryStorage).owner(), governor);
        assertEq(IAgentRole(trex.claimTopicsRegistry).owner(), governor);
        assertEq(IAgentRole(trex.trustedIssuersRegistry).owner(), governor);
        assertTrue(IAgentRole(trex.identityRegistry).isAgent(address(registry)));
        assertFalse(IAgentRole(trex.identityRegistry).isAgent(address(this)));
        assertEq(IIdFactoryLite(trex.idFactory).owner(), address(registry));
        assertEq(keccak256(bytes(MercesTokenGovernor(governor).VERSION())), keccak256("merces-token-governor-1"));
        // the governor has no configuration surface: an agent change through it is impossible
        assertEq(governor.code.length > 0, true);
    }

    function test_protocolIdentitiesRegistered() public view {
        IIdentityRegistryLite ir = IIdentityRegistryLite(trex.identityRegistry);
        assertTrue(ir.isVerified(address(auction)));
        assertTrue(ir.isVerified(address(window)));
        assertFalse(ir.contains(address(vault)));
        assertTrue(ir.isVerified(issuer));
    }

    function test_poseidonHashers() public view {
        // Poseidon(2)(0, 0) is the zero income commitment (SPEC §1.5)
        assertEq(IPoseidon2(poseidon2).poseidon([uint256(0), uint256(0)]), income.ZERO_INCOME_COMMITMENT());
        // Poseidon(5) over the test terms reproduces the proofs' terms commitment
        assertEq(
            IPoseidon5(poseidon5)
                .poseidon([uint256(80_000e6), uint256(1e15), uint256(840), uint256(0), uint256(11111)]),
            uint256(0x201faf2984873e67d24c9f09126f394ec18e666b7f75e3c1206258f4b76215b8)
        );
    }

    function test_tokenFactoryWiring() public view {
        assertEq(tokenFactory.auction(), address(auction));
        assertEq(tokenFactory.vault(), address(vault));
        assertEq(tokenFactory.tokenOwner(), governor);
        assertEq(tokenFactory.complianceModule(), complianceModule);
        assertEq(tokenFactory.identityRegistry(), trex.identityRegistry);
        assertEq(tokenFactory.implementationAuthority(), trex.implementationAuthority);
    }
}
