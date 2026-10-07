// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IEarlyDrawApprover} from "../../src/interfaces/IEarlyDrawApprover.sol";

/// @dev Configurable approver for early-draw hook tests.
contract MockEarlyDrawApprover is IEarlyDrawApprover {
    bool public approveAll;
    mapping(bytes32 => bool) public approvals;

    function setApproveAll(bool v) external {
        approveAll = v;
    }

    function approve(uint256 seriesId, uint256 amount, uint256 nonce) external {
        approvals[keccak256(abi.encode(seriesId, amount, nonce))] = true;
    }

    function approveEarlyDraw(uint256 seriesId, uint256 amount, uint256 nonce) external view returns (bool) {
        return approveAll || approvals[keccak256(abi.encode(seriesId, amount, nonce))];
    }
}
