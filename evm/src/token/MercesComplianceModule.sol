// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

// Compiled with solc 0.8.17 together with the vendored T-REX 4.1.6 sources (OpenZeppelin 4.9.6 under @oz4).
// Written against the GPL-only `IModule` / `AbstractModule` interfaces; it does not derive from any of
// Tokeny's shipped modules (which carry a CC-BY-NC-4.0 rider).
import {AbstractModule} from "@tokenysolutions/t-rex/contracts/compliance/modular/modules/AbstractModule.sol";
import {IModule} from "@tokenysolutions/t-rex/contracts/compliance/modular/modules/IModule.sol";

/// @dev The window escrow "arms" each expected unit deposit before calling `transferFrom`, so units can only
/// enter the escrow through `MercesWindow.commitAsk` (SPEC §7) and never through a direct push.
interface IEscrowArming {
    function armedDeposit(address from) external view returns (uint256);
}

/// @dev Same selectors as the Merces error set (`src/types/MercesErrors.sol`) and the Solana hook's error names.
error DirectTransferForbidden();
error UnarmedEscrowDeposit();

/// @title MercesComplianceModule
/// @notice ERC-3643 compliance rule for sealed-bid series (SPEC v1.1 §4.2, brief C10). `moduleCheck` is true
/// only for: mints to the auction escrow (`from == 0 && to == auction`), burns (`to == 0`), movements out of
/// the auction or window escrows (deliveries, fills, returns — the protocol has already applied allowlist and
/// cap rules) and armed deposits into the window escrow. Everything else is refused with the same error names as
/// the Solana hook: `UnarmedEscrowDeposit` for an unarmed push into the window escrow, `DirectTransferForbidden`
/// otherwise. The revert propagates through `ModularCompliance.canTransfer` and the T-REX `Token`, so a direct
/// transfer between two verified wallets reverts with that custom error (a destination that never had an
/// identity still gets T-REX's own "Transfer not possible"). One module instance serves every series'
/// compliance; the escrow addresses are stored per compliance by the token factory at creation.
contract MercesComplianceModule is AbstractModule {
    struct Escrows {
        address auction;
        address window;
    }

    mapping(address => Escrows) private _escrows;

    event EscrowsSet(address indexed compliance, address auction, address window);

    /// @notice Per-compliance escrow addresses; called by the compliance owner (the token factory at creation)
    /// through `ModularCompliance.callModuleFunction`.
    function setEscrows(address auction, address window) external onlyComplianceCall {
        require(auction != address(0) && window != address(0), "invalid argument - zero address");
        _escrows[msg.sender] = Escrows({auction: auction, window: window});
        emit EscrowsSet(msg.sender, auction, window);
    }

    function escrowsOf(address compliance) external view returns (address auction, address window) {
        Escrows storage e = _escrows[compliance];
        return (e.auction, e.window);
    }

    function moduleTransferAction(address, address, uint256) external override onlyComplianceCall {}

    function moduleMintAction(address, uint256) external override onlyComplianceCall {}

    function moduleBurnAction(address, uint256) external override onlyComplianceCall {}

    /// @inheritdoc IModule
    function moduleCheck(address _from, address _to, uint256 _value, address _compliance)
        external
        view
        override
        returns (bool)
    {
        Escrows storage e = _escrows[_compliance];
        if (_from == address(0)) {
            if (_to != e.auction) revert DirectTransferForbidden(); // mint: to the auction escrow only
            return true;
        }
        if (_to == address(0)) return true; // burn (never reaches the compliance in T-REX, kept for symmetry)
        if (_from == e.auction || _from == e.window) return true; // delivery, fill or return
        if (_to == e.window) {
            if (_value == 0 || IEscrowArming(e.window).armedDeposit(_from) != _value) revert UnarmedEscrowDeposit();
            return true;
        }
        revert DirectTransferForbidden(); // direct transfers are forbidden at all times
    }

    function canComplianceBind(address) external pure override returns (bool) {
        return true;
    }

    function isPlugAndPlay() external pure override returns (bool) {
        return true;
    }

    function name() external pure override returns (string memory) {
        return "MercesComplianceModule";
    }
}
