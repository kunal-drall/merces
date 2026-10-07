// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal ERC-3643 (T-REX `Token`) surface used by the Merces protocol contracts.
/// ABI-compatible subset of the T-REX `IToken` interface; declared here so the 0.8.30 unit never
/// imports the 0.8.17 T-REX sources.
interface IERC3643Token is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address userAddress, uint256 amount) external;
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
    function decimals() external view returns (uint8);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function identityRegistry() external view returns (address);
    function compliance() external view returns (address);
    function isAgent(address agent) external view returns (bool);
    function owner() external view returns (address);
    function isFrozen(address userAddress) external view returns (bool);
    function getFrozenTokens(address userAddress) external view returns (uint256);
}
