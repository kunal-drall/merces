// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Deploys one T-REX token (+ its ModularCompliance) per sealed-bid series (SPEC §4.2).
/// Implemented in the 0.8.17 compilation unit (`src/token/MercesTokenFactory.sol`).
interface IMercesTokenFactory {
    event UnitTokenCreated(uint256 indexed series, address indexed token, address compliance);

    function createToken(uint256 seriesId, string calldata name, string calldata symbol)
        external
        returns (address token, address compliance);

    function implementationAuthority() external view returns (address);
    function identityRegistry() external view returns (address);
    function complianceModule() external view returns (address);
    function auction() external view returns (address);
    function vault() external view returns (address);
    function tokenOwner() external view returns (address);
    function tokenOf(uint256 seriesId) external view returns (address);
}
