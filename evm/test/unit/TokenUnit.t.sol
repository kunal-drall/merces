// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
import {IAgentRole} from "../../src/interfaces/external/IAgentRole.sol";
import {IIdentityRegistryLite} from "../../src/interfaces/external/IIdentityRegistryLite.sol";

interface IModularComplianceLite {
    function getModules() external view returns (address[] memory);
    function getTokenBound() external view returns (address);
    function canTransfer(address from, address to, uint256 value) external view returns (bool);
    function owner() external view returns (address);
}

interface IModuleLite {
    function name() external pure returns (string memory);
    function isPlugAndPlay() external pure returns (bool);
    function isComplianceBound(address compliance) external view returns (bool);
    function escrowsOf(address compliance) external view returns (address auction, address window);
    function moduleTransferAction(address from, address to, uint256 value) external;
}

/// @notice ERC-3643 unit token wiring and compliance rules (SPEC v1.1 §4.2, brief C10).
contract TokenUnitTest is FullFixture {
    uint256 internal sid;
    IERC3643Token internal token;
    address internal compliance;

    function setUp() public override {
        super.setUp();
        sid = runStandardRaise();
        token = unitToken(sid);
        compliance = token.compliance();
    }

    function test_factoryWiring() public view {
        assertEq(token.decimals(), 0);
        assertEq(token.name(), string.concat("Merces HEU ", vm.toString(sid)));
        assertEq(token.symbol(), "HEU");
        assertFalse(token.paused());
        assertEq(token.identityRegistry(), trex.identityRegistry);
        assertEq(token.owner(), governor);
        assertEq(IModularComplianceLite(compliance).owner(), governor);
        assertEq(IModularComplianceLite(compliance).getTokenBound(), address(token));
        address[] memory mods = IModularComplianceLite(compliance).getModules();
        assertEq(mods.length, 1);
        assertEq(mods[0], complianceModule);
        assertTrue(IModuleLite(complianceModule).isComplianceBound(compliance));
        assertTrue(IModuleLite(complianceModule).isPlugAndPlay());
        assertEq(IModuleLite(complianceModule).name(), "MercesComplianceModule");
        (address a, address w) = IModuleLite(complianceModule).escrowsOf(compliance);
        assertEq(a, address(auction));
        assertEq(w, address(window));
        // agents: exactly auction, vault and window; the factory removed itself
        assertTrue(token.isAgent(address(auction)));
        assertTrue(token.isAgent(address(vault)));
        assertTrue(token.isAgent(address(window)));
        assertFalse(token.isAgent(address(tokenFactory)));
        assertFalse(token.isAgent(address(treasury)));
        assertFalse(token.isAgent(address(income)));
        assertEq(tokenFactory.tokenOf(sid), address(token));
        assertEq(tokenFactory.tokenOwner(), governor);
        assertEq(token.totalSupply(), 300);
    }

    function test_onlyAuctionCreatesTokens() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("NotAuction()"));
        tokenFactory.createToken(99, "x", "y");
        vm.prank(address(auction));
        vm.expectRevert(abi.encodeWithSignature("TokenExists()"));
        tokenFactory.createToken(sid, "x", "y");
    }

    function test_mintOnlyToAuctionEscrowByAgents() public {
        // only agents mint
        vm.prank(b1);
        vm.expectRevert(bytes("AgentRole: caller does not have the Agent role"));
        token.mint(b1, 1);
        // an agent may only mint to the auction escrow (compliance rule 1)
        vm.prank(address(vault));
        vm.expectRevert(bytes("Compliance not followed"));
        token.mint(b1, 1);
        vm.prank(address(vault));
        token.mint(address(auction), 1);
        assertEq(token.balanceOf(address(auction)), 1);
    }

    function test_directTransfersAlwaysFail() public {
        assertEq(token.balanceOf(b1), 100);
        assertFalse(IModularComplianceLite(compliance).canTransfer(b1, b2, 1));
        vm.prank(b1);
        vm.expectRevert(bytes("Transfer not possible"));
        token.transfer(b2, 1);
        vm.prank(b1);
        token.approve(b2, 5);
        vm.prank(b2);
        vm.expectRevert(bytes("Transfer not possible"));
        token.transferFrom(b1, b2, 1);
        // even after the lockup would have passed — the token never allows wallet-to-wallet moves
        vm.warp(block.timestamp + 10 * 365 days);
        vm.prank(b1);
        vm.expectRevert(bytes("Transfer not possible"));
        token.transfer(b2, 1);
        // nor a push into the auction escrow
        vm.prank(b1);
        vm.expectRevert(bytes("Transfer not possible"));
        token.transfer(address(auction), 1);
    }

    function test_escrowRules() public view {
        IModularComplianceLite c = IModularComplianceLite(compliance);
        // mint: only to the auction escrow
        assertTrue(c.canTransfer(address(0), address(auction), 5));
        assertFalse(c.canTransfer(address(0), b1, 5));
        assertFalse(c.canTransfer(address(0), address(window), 5));
        // out of either escrow: always (deliveries, fills, returns)
        assertTrue(c.canTransfer(address(auction), b1, 5));
        assertTrue(c.canTransfer(address(window), b1, 5));
        assertTrue(c.canTransfer(address(window), stranger, 5));
        // into the window escrow: only when armed for exactly that amount
        assertFalse(c.canTransfer(b1, address(window), 5));
        assertEq(window.armedDeposit(b1), 0);
    }

    function test_identityPersistsAfterRemovalFromAllowlist() public {
        IIdentityRegistryLite ir = IIdentityRegistryLite(trex.identityRegistry);
        assertTrue(ir.isVerified(b1));
        disallow(b1);
        assertFalse(registry.isAllowed(b1));
        assertTrue(ir.isVerified(b1)); // identities are never deleted (SPEC §4.2)
        // protocol-initiated movements to the wallet still work: a window return / auction delivery
        vm.prank(address(window));
        vm.expectRevert(bytes("Insufficient Balance")); // the escrow is empty here, but the compliance passed
        token.transfer(b1, 1);
    }

    function test_burnByVaultAgentAlwaysWorks() public {
        disallow(b1); // removal from the allowlist never blocks burns
        vm.prank(address(vault));
        token.burn(b1, 100);
        assertEq(token.balanceOf(b1), 0);
        assertEq(token.totalSupply(), 200);
        vm.prank(stranger);
        vm.expectRevert(bytes("AgentRole: caller does not have the Agent role"));
        token.burn(b2, 1);
    }

    function test_moduleHooksOnlyFromBoundCompliance() public {
        vm.expectRevert(bytes("only bound compliance can call"));
        IModuleLite(complianceModule).moduleTransferAction(b1, b2, 1);
    }

    function test_governorIsADeadEnd() public {
        // nobody but the governor may configure the token, and the governor exposes no function to do so
        vm.prank(admin);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        IAgentRole(address(token)).addAgent(admin);
        vm.prank(address(timelock));
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        IAgentRole(address(token)).addAgent(admin);
        (bool ok,) = governor.call(abi.encodeWithSignature("forward(address,bytes)", address(token), ""));
        assertFalse(ok);
        assertEq(IAgentRole(trex.identityRegistry).owner(), governor);
        vm.prank(admin);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        IAgentRole(trex.identityRegistry).addAgent(admin);
    }
}
