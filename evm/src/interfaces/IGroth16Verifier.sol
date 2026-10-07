// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice snarkjs-generated Groth16 verifier surface for the ProofOfIncome circuit (SPEC §8).
/// Public inputs in order: [termsCommitment, unitsOutstanding, fxAvgWad, priorIncomeCommitment,
/// incomeCommitment, paymentUsd], each a BN254 scalar field element (big-endian).
interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[6] calldata pubSignals
    ) external view returns (bool);
}
