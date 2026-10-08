// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

// Compiled with solc 0.8.17 together with the vendored T-REX 4.1.6 sources (OpenZeppelin 4.9.6 under @oz4).
import {TokenProxy} from "@tokenysolutions/t-rex/contracts/proxy/TokenProxy.sol";
import {ModularComplianceProxy} from "@tokenysolutions/t-rex/contracts/proxy/ModularComplianceProxy.sol";
import {IModularCompliance} from "@tokenysolutions/t-rex/contracts/compliance/modular/IModularCompliance.sol";
import {Token} from "@tokenysolutions/t-rex/contracts/token/Token.sol";
import {ModularCompliance} from "@tokenysolutions/t-rex/contracts/compliance/modular/ModularCompliance.sol";
import {MercesComplianceModule} from "./MercesComplianceModule.sol";

/// @title MercesTokenFactory
/// @notice Creates one ERC-3643 unit token per sealed-bid series (SPEC v1.1 §4.2 "T-REX governance"): a
/// `TokenProxy` and a `ModularComplianceProxy` against the shared `TREXImplementationAuthority`, with the shared
/// `IdentityRegistry`, `decimals = 0`, the `MercesComplianceModule` bound and pointed at the auction and window
/// escrows, exactly `MercesAuction`, `MercesVault` and `MercesWindow` as token agents (mint / burn / escrow
/// movements), the token unpaused, and ownership of both proxies handed to the `MercesTokenGovernor` (a contract
/// with no configuration surface). Only `MercesAuction.openRaise` may call it. Non-upgradeable.
contract MercesTokenFactory {
    event UnitTokenCreated(uint256 indexed series, address indexed token, address compliance);

    address public immutable implementationAuthority;
    address public immutable identityRegistry;
    address public immutable complianceModule;
    address public immutable auction;
    address public immutable vault;
    address public immutable window;
    address public immutable tokenOwner;

    mapping(uint256 => address) public tokenOf;

    error NotAuction();
    error TokenExists();

    constructor(
        address implementationAuthority_,
        address identityRegistry_,
        address complianceModule_,
        address auction_,
        address vault_,
        address window_,
        address tokenOwner_
    ) {
        require(
            implementationAuthority_ != address(0) && identityRegistry_ != address(0)
                && complianceModule_ != address(0) && auction_ != address(0) && vault_ != address(0)
                && window_ != address(0) && tokenOwner_ != address(0),
            "invalid argument - zero address"
        );
        implementationAuthority = implementationAuthority_;
        identityRegistry = identityRegistry_;
        complianceModule = complianceModule_;
        auction = auction_;
        vault = vault_;
        window = window_;
        tokenOwner = tokenOwner_;
    }

    /// @notice Deploys and wires the unit token of `seriesId`.
    function createToken(uint256 seriesId, string calldata name, string calldata symbol)
        external
        returns (address token, address compliance)
    {
        if (msg.sender != auction) revert NotAuction();
        if (tokenOf[seriesId] != address(0)) revert TokenExists();

        // The factory is `msg.sender` of both proxy constructors, so the delegatecalled `init` makes it the
        // owner of the compliance and the token until ownership is handed over below.
        ModularComplianceProxy mc = new ModularComplianceProxy(implementationAuthority);
        TokenProxy tp = new TokenProxy(implementationAuthority, identityRegistry, address(mc), name, symbol, 0, address(0));
        token = address(tp);
        compliance = address(mc);
        tokenOf[seriesId] = token;

        IModularCompliance(compliance).addModule(complianceModule);
        IModularCompliance(compliance).callModuleFunction(
            abi.encodeWithSelector(MercesComplianceModule.setEscrows.selector, auction, window), complianceModule
        );

        Token t = Token(token);
        t.addAgent(auction);
        t.addAgent(vault);
        t.addAgent(window);
        t.addAgent(address(this));
        t.unpause();
        t.removeAgent(address(this));
        t.transferOwnership(tokenOwner);
        ModularCompliance(compliance).transferOwnership(tokenOwner);

        emit UnitTokenCreated(seriesId, token, compliance);
    }
}
