// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";

contract MessagesTest is Test {
    bytes32 internal constant DOM = keccak256("domain");

    function test_domainEncoding() public pure {
        address reg = address(0x1234);
        bytes32 expected = keccak256(abi.encodePacked(uint8(2), uint64(10143), bytes32(uint256(uint160(reg)))));
        assertEq(MercesMessages.domain(10143, reg), expected);
        // 1 + 8 + 32 = 41 bytes preimage
        assertEq(abi.encodePacked(uint8(2), uint64(10143), bytes32(uint256(uint160(reg)))).length, 41);
    }

    function test_orderCommitmentEncoding() public pure {
        address w = address(0xBEEF);
        bytes32 salt = keccak256("salt");
        bytes memory pre = abi.encodePacked(uint64(1_000_000), uint64(100), salt, bytes32(uint256(uint160(w))));
        assertEq(pre.length, 8 + 8 + 32 + 32);
        assertEq(MercesMessages.orderCommitment(1_000_000, 100, salt, w), keccak256(pre));
    }

    function test_reportDigestEncoding() public pure {
        bytes32 ic = keccak256("income");
        bytes32 prior = keccak256("prior");
        bytes memory pre =
            abi.encodePacked("MERCES_REPORT_V1", DOM, bytes32(uint256(7)), uint32(8104), prior, ic, uint8(2), uint8(1));
        assertEq(pre.length, 16 + 32 + 32 + 4 + 32 + 32 + 1 + 1);
        assertEq(MercesMessages.reportDigest(DOM, 7, 8104, prior, ic, 2, true), keccak256(pre));
        // the liquidity flag is part of the message: a tail attestation cannot be reused for a regular report
        assertTrue(
            MercesMessages.reportDigest(DOM, 7, 8104, prior, ic, 2, true)
                != MercesMessages.reportDigest(DOM, 7, 8104, prior, ic, 2, false)
        );
    }

    function test_otherDigests() public pure {
        assertEq(
            MercesMessages.fxDigest(DOM, 7, 8104, 1.1e18),
            keccak256(abi.encodePacked("MERCES_FX_V1", DOM, bytes32(uint256(7)), uint32(8104), uint64(1.1e18)))
        );
        assertEq(
            MercesMessages.amendDigest(DOM, 7, 3, bytes32(uint256(9)), 2e18),
            keccak256(
                abi.encodePacked(
                    "MERCES_AMEND_V1", DOM, bytes32(uint256(7)), uint64(3), bytes32(uint256(9)), uint64(2e18)
                )
            )
        );
        assertEq(
            MercesMessages.pauseDigest(DOM, 7, 1, 1_800_000_000),
            keccak256(abi.encodePacked("MERCES_PAUSE_V1", DOM, bytes32(uint256(7)), uint64(1), uint64(1_800_000_000)))
        );
        assertEq(
            MercesMessages.extinguishDigest(DOM, 7, 0),
            keccak256(abi.encodePacked("MERCES_EXTINGUISH_V1", DOM, bytes32(uint256(7)), uint64(0)))
        );
        bytes memory pre = abi.encodePacked(
            "MERCES_TRUEUP_V1", DOM, bytes32(uint256(7)), uint64(4), uint16(2026), int64(-5), uint64(1_800_000_000)
        );
        assertEq(pre.length, 16 + 32 + 32 + 8 + 2 + 8 + 8);
        // two's complement big-endian for -5
        assertEq(uint8(pre[16 + 32 + 32 + 8 + 2]), 0xff);
        assertEq(uint8(pre[16 + 32 + 32 + 8 + 2 + 7]), 0xfb);
        assertEq(MercesMessages.trueupDigest(DOM, 7, 4, 2026, -5, 1_800_000_000), keccak256(pre));
    }

    function test_rawDigestSignatureRecovers() public pure {
        uint256 pk = 0xA11CE;
        bytes32 digest = MercesMessages.reportDigest(DOM, 1, 8104, keccak256("p"), keccak256("x"), 2, false);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        // raw digest, no EIP-191 prefix
        assertEq(ECDSA.recover(digest, abi.encodePacked(r, s, v)), vm.addr(pk));
    }
}
