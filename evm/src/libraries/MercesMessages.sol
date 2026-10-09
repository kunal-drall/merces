// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice Hashing and signed-message encodings (SPEC v1.1 §1.3, §1.4).
/// Integers are big-endian fixed width, 32-byte values raw, wallets are 32 bytes (an EVM address
/// left-padded with 12 zero bytes). Digests are signed raw (no EIP-191 prefix); the magic string is
/// the domain separation.
library MercesMessages {
    uint8 internal constant CHAIN_KIND_EVM = 2;

    function wallet32(address wallet) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(wallet)));
    }

    function seriesKey(uint256 seriesId) internal pure returns (bytes32) {
        return bytes32(seriesId);
    }

    /// @dev `domain = keccak256(chain_kind_u8 ‖ chain_id_u64 ‖ registry_address_32)`.
    function domain(uint64 chainId, address registry) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(CHAIN_KIND_EVM, chainId, wallet32(registry)));
    }

    /// @dev Bid / ask commitment: `keccak256(price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32)`.
    function orderCommitment(uint64 price, uint64 quantity, bytes32 salt, address wallet)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(price, quantity, salt, wallet32(wallet)));
    }

    /// @dev `"MERCES_REPORT_V1" ‖ domain ‖ series_key ‖ period_u32 ‖ prior_income_commitment_32 ‖
    /// income_commitment_32 ‖ tier_u8 ‖ liquidity_event_u8`.
    function reportDigest(
        bytes32 dom,
        uint256 seriesId,
        uint32 period,
        bytes32 priorIncomeCommitment,
        bytes32 incomeCommitment,
        uint8 tier,
        bool liquidityEvent
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "MERCES_REPORT_V1",
                dom,
                seriesKey(seriesId),
                period,
                priorIncomeCommitment,
                incomeCommitment,
                tier,
                liquidityEvent ? uint8(1) : uint8(0)
            )
        );
    }

    function fxDigest(bytes32 dom, uint256 seriesId, uint32 period, uint64 fxRateWad) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("MERCES_FX_V1", dom, seriesKey(seriesId), period, fxRateWad));
    }

    function amendDigest(bytes32 dom, uint256 seriesId, uint64 nonce, bytes32 newTermsCommitment, uint64 newCapWad)
        internal
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encodePacked("MERCES_AMEND_V1", dom, seriesKey(seriesId), nonce, newTermsCommitment, newCapWad)
            );
    }

    function pauseDigest(bytes32 dom, uint256 seriesId, uint64 nonce, uint64 pauseEnd) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("MERCES_PAUSE_V1", dom, seriesKey(seriesId), nonce, pauseEnd));
    }

    function extinguishDigest(bytes32 dom, uint256 seriesId, uint64 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("MERCES_EXTINGUISH_V1", dom, seriesKey(seriesId), nonce));
    }

    /// @dev `"MERCES_TRUEUP_V1" ‖ domain ‖ series_key ‖ trueup_nonce_u64 ‖ year_u16 ‖ adjustment_i64 ‖
    /// attestation_ts_u64`.
    function trueupDigest(
        bytes32 dom,
        uint256 seriesId,
        uint64 nonce,
        uint16 year,
        int64 adjustment,
        uint64 attestationTs
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encodePacked("MERCES_TRUEUP_V1", dom, seriesKey(seriesId), nonce, year, adjustment, attestationTs)
        );
    }
}
