// Regenerates evm/src/zk/PoseidonBytecode.sol from circomlibjs (run from the repo root: `node evm/scripts/gen-poseidon.mjs`).
// The hashers are circomlib's BN254 Poseidon(2) and Poseidon(5), identical to the circuit and to poseidon-lite.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(new URL("../../circuits/package.json", import.meta.url));
const { poseidonContract } = require("circomlibjs");
const chunk = (hex) => {
  const body = hex.slice(2);
  const lines = [];
  for (let i = 0; i < body.length; i += 120) lines.push('            hex"' + body.slice(i, i + 120) + '"');
  return lines.join(",\n");
};
const c2 = poseidonContract.createCode(2);
const c5 = poseidonContract.createCode(5);
const out = `// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice EVM creation bytecode of circomlib's Poseidon hashers (BN254, circomlib parameters), generated with
/// \`circomlibjs\` 0.1.7 \`poseidonContract.createCode(n)\` (see evm/scripts/gen-poseidon.mjs). The deployed contracts
/// expose \`poseidon(uint256[n]) pure returns (uint256)\` and \`poseidon(bytes32[n]) pure returns (bytes32)\` and
/// match \`poseidon-lite\` / the circuit exactly (SPEC §1.5). Deploy with \`PoseidonDeployer.deploy\`.
library PoseidonBytecode {
    /// @dev Poseidon(2): ${(c2.length - 2) / 2} bytes of creation code.
    function poseidon2() internal pure returns (bytes memory) {
        return bytes.concat(
${chunk(c2)}
        );
    }

    /// @dev Poseidon(5): ${(c5.length - 2) / 2} bytes of creation code.
    function poseidon5() internal pure returns (bytes memory) {
        return bytes.concat(
${chunk(c5)}
        );
    }
}

/// @notice Deploys raw creation bytecode (used for the Poseidon hashers).
library PoseidonDeployer {
    error PoseidonDeploymentFailed();

    function deploy(bytes memory code) internal returns (address addr) {
        assembly ("memory-safe") {
            addr := create(0, add(code, 0x20), mload(code))
        }
        if (addr == address(0)) revert PoseidonDeploymentFailed();
    }
}
`;
writeFileSync(new URL("../src/zk/PoseidonBytecode.sol", import.meta.url), out);
console.log("written PoseidonBytecode.sol", (c2.length - 2) / 2, (c5.length - 2) / 2);
