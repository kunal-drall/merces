// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice circomlib Poseidon hashers (BN254) as deployed from `PoseidonBytecode` (SPEC §1.5).
interface IPoseidon2 {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

interface IPoseidon5 {
    function poseidon(uint256[5] calldata inputs) external pure returns (uint256);
}
