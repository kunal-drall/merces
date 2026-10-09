// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IGroth16Verifier} from "../../src/interfaces/IGroth16Verifier.sol";

/// @notice Test-only verifier that accepts every proof, so fuzz and invariant suites can drive arbitrary payment
/// amounts through `submitReport` (the real verifier binds payments to the circuit; it is exercised with genuine
/// proofs in the unit and parity suites). Installed through the timelock-owned `setGroth16Verifier`.
contract MockGroth16Verifier is IGroth16Verifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[6] calldata)
        external
        pure
        override
        returns (bool)
    {
        return true;
    }
}
