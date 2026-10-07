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

/// @title MercesComplianceModule
/// @notice ERC-3643 compliance rule for sealed-bid series (SPEC §4.2, brief C10): units move only through
/// the transfer window. `moduleCheck` is true for mints (`from == 0`, the token already requires the
/// recipient to be verified), for burns, and for movements into or out of the series' window escrow.
/// Every other transfer is refused, so direct wallet-to-wallet transfers always fail
/// (`DirectTransferForbidden` on Solana; the T-REX token reverts with "Transfer not possible" here).
/// Lockup, report acceptance, allowlist and wallet cap are enforced by `MercesWindow` itself, mirroring the
/// Solana hook design. One module instance serves every series' compliance.
contract MercesComplianceModule is AbstractModule {
    /// @notice The protocol transfer-window contract (a UUPS proxy whose address never changes).
    address public immutable window;

    constructor(address window_) {
        require(window_ != address(0), "invalid argument - zero address");
        window = window_;
    }

    function moduleTransferAction(address, address, uint256) external override onlyComplianceCall {}

    function moduleMintAction(address, uint256) external override onlyComplianceCall {}

    function moduleBurnAction(address, uint256) external override onlyComplianceCall {}

    /// @inheritdoc IModule
    function moduleCheck(address _from, address _to, uint256 _value, address) external view override returns (bool) {
        if (_from == address(0) || _to == address(0)) return true; // mint / burn
        if (_from == window) return true; // escrow → wallet (window re-checks allowlist and cap)
        if (_to == window) return _value > 0 && IEscrowArming(window).armedDeposit(_from) == _value;
        return false; // direct transfers are forbidden at all times
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
