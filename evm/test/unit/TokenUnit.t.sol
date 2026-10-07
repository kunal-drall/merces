// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {MercesFixture} from "../utils/MercesFixture.sol";
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
import {IMercesTokenFactory} from "../../src/interfaces/IMercesTokenFactory.sol";
import {IAgentRole} from "../../src/interfaces/external/IAgentRole.sol";

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
    function window() external view returns (address);
}

/// @dev Stand-in for the window escrow: exposes `armedDeposit` like `MercesWindow` does.
contract WindowStub {
    mapping(address => uint256) public armedDeposit;

    function arm(address from, uint256 amount) external {
        armedDeposit[from] = amount;
    }

    function pull(IERC3643Token token, address from, uint256 amount) external {
        armedDeposit[from] = amount;
        token.transferFrom(from, address(this), amount);
        delete armedDeposit[from];
    }

    function push(IERC3643Token token, address to, uint256 amount) external {
        token.transfer(to, amount);
    }
}

contract TokenUnitTest is MercesFixture {
    IERC3643Token internal token;
    address internal compliance;
    WindowStub internal windowStub;

    function _deployProtocol() internal override {
        windowStub = new WindowStub();
        windowAddr = address(windowStub);
        auctionAddr = address(this);
        vaultAddr = makeAddr("vaultStub");
        _deployTokenUnit();
    }

    function setUp() public override {
        super.setUp();
        (address t, address c) = tokenFactory.createToken(1, "Merces HEU 1", "HEU");
        token = IERC3643Token(t);
        compliance = c;
        allow(b1);
        allow(b2);
        allow(address(windowStub));
    }

    function test_factoryWiring() public view {
        assertEq(token.decimals(), 0);
        assertEq(token.name(), "Merces HEU 1");
        assertEq(token.symbol(), "HEU");
        assertFalse(token.paused());
        assertEq(token.identityRegistry(), trex.identityRegistry);
        assertEq(token.compliance(), compliance);
        assertEq(token.owner(), address(timelock));
        assertEq(IModularComplianceLite(compliance).owner(), address(timelock));
        assertEq(IModularComplianceLite(compliance).getTokenBound(), address(token));
        address[] memory mods = IModularComplianceLite(compliance).getModules();
        assertEq(mods.length, 1);
        assertEq(mods[0], complianceModule);
        assertTrue(IModuleLite(complianceModule).isComplianceBound(compliance));
        assertTrue(IModuleLite(complianceModule).isPlugAndPlay());
        assertEq(IModuleLite(complianceModule).name(), "MercesComplianceModule");
        assertEq(IModuleLite(complianceModule).window(), address(windowStub));
        // agents: auction (mint) and vault (burn) only; factory removed itself
        assertTrue(token.isAgent(address(this)));
        assertTrue(token.isAgent(vaultAddr));
        assertFalse(token.isAgent(address(tokenFactory)));
        assertFalse(token.isAgent(address(windowStub)));
        assertEq(tokenFactory.tokenOf(1), address(token));
        assertEq(tokenFactory.tokenOwner(), address(timelock));
    }

    function test_onlyAuctionCreatesTokens() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("NotAuction()"));
        tokenFactory.createToken(2, "x", "y");
        vm.expectRevert(abi.encodeWithSignature("TokenExists()"));
        tokenFactory.createToken(1, "x", "y");
    }

    function test_mintToAllowlistedWorks_mintToOthersFails() public {
        token.mint(b1, 10);
        assertEq(token.balanceOf(b1), 10);
        assertEq(token.totalSupply(), 10);
        vm.expectRevert(bytes("Identity is not verified."));
        token.mint(stranger, 1);
        // only agents mint
        vm.prank(b1);
        vm.expectRevert(bytes("AgentRole: caller does not have the Agent role"));
        token.mint(b1, 1);
    }

    function test_directTransfersAlwaysFail() public {
        token.mint(b1, 10);
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
    }

    function test_escrowDepositRequiresArming() public {
        token.mint(b1, 10);
        vm.prank(b1);
        token.approve(address(windowStub), 10);
        // direct push into the escrow address is refused
        vm.prank(b1);
        vm.expectRevert(bytes("Transfer not possible"));
        token.transfer(address(windowStub), 3);
        // the window arms the exact amount and pulls
        windowStub.pull(token, b1, 3);
        assertEq(token.balanceOf(address(windowStub)), 3);
        assertEq(token.balanceOf(b1), 7);
        // armed amount must match exactly
        windowStub.arm(b1, 2);
        vm.prank(b1);
        vm.expectRevert(bytes("Transfer not possible"));
        token.transfer(address(windowStub), 3);
    }

    function test_escrowReleaseToVerifiedWalletOnly() public {
        token.mint(b1, 10);
        vm.prank(b1);
        token.approve(address(windowStub), 10);
        windowStub.pull(token, b1, 4);
        windowStub.push(token, b2, 4);
        assertEq(token.balanceOf(b2), 4);
        vm.prank(b2);
        token.approve(address(windowStub), 4);
        windowStub.pull(token, b2, 4);
        vm.expectRevert(bytes("Transfer not possible"));
        windowStub.push(token, stranger, 4); // not verified
    }

    function test_burnByVaultAgentAlwaysWorks() public {
        token.mint(b1, 10);
        disallow(b1); // removal from the allowlist never blocks burns
        vm.prank(vaultAddr);
        token.burn(b1, 10);
        assertEq(token.balanceOf(b1), 0);
        assertEq(token.totalSupply(), 0);
    }

    function test_moduleHooksOnlyFromBoundCompliance() public {
        vm.expectRevert(bytes("only bound compliance can call"));
        IModuleLike(complianceModule).moduleTransferAction(b1, b2, 1);
    }

    function test_timelockOwnsToken_noOneElseConfigures() public {
        vm.prank(admin);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        IAgentRole(address(token)).addAgent(admin);
        vm.prank(address(timelock));
        IAgentRole(address(token)).addAgent(admin);
        assertTrue(token.isAgent(admin));
    }
}

interface IModuleLike {
    function moduleTransferAction(address from, address to, uint256 value) external;
}
