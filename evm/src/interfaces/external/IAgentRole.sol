// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice ABI-compatible subset of T-REX `AgentRoleUpgradeable` / OpenZeppelin 4 `Ownable`.
interface IAgentRole {
    function addAgent(address agent) external;
    function removeAgent(address agent) external;
    function isAgent(address agent) external view returns (bool);
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}
