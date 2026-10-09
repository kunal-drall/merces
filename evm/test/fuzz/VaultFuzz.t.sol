// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FreeReportFixture} from "../utils/FreeReportFixture.sol";
import {IMercesVault} from "../../src/interfaces/IMercesVault.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {SeriesStatus} from "../../src/types/MercesTypes.sol";

/// @notice Property tests of the payout vault (SPEC v1.1 §6.3, brief F2) over random payment sequences, random
/// claim timing and random (favourable) cap amendments:
/// - no unit ever receives more than its (effective) cap; reaching it retires the series and refunds the excess;
/// - the accumulator is exact: `netAcc × N + carry == (accepted − fee) × WAD`;
/// - the vault is always solvent: balance ≥ Σ pending, and the excess is rounding dust (< 1 base unit per
///   settle, SPEC §6.1, plus the carry);
/// - fees are exactly 5% (floor) of accepted gross, taken from the holders' side: everything the issuer pays is
///   either accepted into the vault or refunded to the issuer.
contract VaultFuzzTest is FreeReportFixture {
    uint256 internal constant N = 300;
    uint256 internal sid;
    address[3] internal holders;
    uint256 internal auctionFees;
    /// @dev Every `settle_holder` floors (SPEC §6.1), so the vault may keep < 1 base unit per settle as dust.
    uint256 internal settles;
    /// @dev `paid_per_unit_wad` when a cap was lowered below it (0 = never).
    uint256 internal paidAtLowering;

    function setUp() public override {
        super.setUp();
        sid = runStandardRaise();
        installMockVerifier();
        holders = [b1, b2, b3];
        auctionFees = usdc.balanceOf(address(feeCollector));
    }

    function testFuzz_payoutsRespectCapAndStaySolvent(uint64[10] memory pays, uint256 claimSeed, uint256 amendAt)
        public
    {
        uint256 issuerPaid;
        amendAt = bound(amendAt, 0, 12); // ≥ 10: no amendment
        for (uint256 q = 0; q < pays.length; q++) {
            if (registry.getSeriesCore(sid).terminalStatus != 0) break;
            if (q == amendAt) {
                _lowerCap(q);
                if (registry.getSeriesCore(sid).terminalStatus != 0) break;
            }
            uint64 pay = uint64(bound(pays[q], 0, 40_000e6));
            uint64 due = freeReport(sid, Q1_2026 + uint32(q), pay);
            assertEq(due, pay);
            if (due > 0) issuerPaid += payDue(sid, issuer);
            uint256 bits = uint256(keccak256(abi.encode(claimSeed, q)));
            for (uint256 h = 0; h < 3; h++) {
                if ((bits >> h) & 1 == 1) {
                    vm.prank(holders[h]);
                    vault.claim(sid);
                    settles++;
                }
            }
            _check(issuerPaid);
        }
        // everybody claims at the end: the vault keeps only the carry dust
        for (uint256 h = 0; h < 3; h++) {
            vm.prank(holders[h]);
            vault.claim(sid);
            settles++;
        }
        _check(issuerPaid);
        assertLe(usdc.balanceOf(address(vault)), settles + 1, "dust");
    }

    /// @dev A favourable amendment (cap lowered within [2.0, current]) at a random quarter.
    function _lowerCap(uint256 q) internal {
        uint64 newCap = uint64(2e18 + (uint256(keccak256(abi.encode(q))) % 5e17));
        if (newCap > registry.getSeriesTerms(sid).capMultipleWad) return;
        bytes32 c = registry.getSeriesCore(sid).termsCommitment;
        uint64 nonce = registry.getSeriesCore(sid).amendmentNonce;
        bytes memory sig = sign(attestorKey, MercesMessages.amendDigest(domain, sid, nonce, c, newCap));
        vm.prank(issuer);
        registry.amendTerms(sid, c, newCap, sig, noTier1());
        // a cap lowered to or below what is already paid retires at the next crank (no underflow anywhere)
        if (vault.capEffWad(sid) <= vault.getLedger(sid).paidPerUnitWad) {
            paidAtLowering = vault.getLedger(sid).paidPerUnitWad;
            vm.prank(keeper);
            vault.retireIfCapped(sid);
            assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Retired));
        }
    }

    function _check(uint256 issuerPaid) internal view {
        IMercesVault.Ledger memory l = vault.getLedger(sid);
        uint256 capEff = vault.capEffWad(sid);
        assertLe(l.paidPerUnitWad, capEff, "a unit received more than its cap");
        assertLe(l.paidPerUnitWad, 250e6 * 1e18, "above the original cap (2.5 x P0)");
        if (l.paidPerUnitWad > uint256(vault.capPerUnit(sid)) * 1e18) {
            // only possible when an amendment lowered the cap below what was already paid: nothing more is paid
            assertEq(l.paidPerUnitWad, paidAtLowering);
            assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Retired));
        }
        if (l.paidPerUnitWad == capEff) {
            assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Retired), "cap met: retired");
        }
        // exact accumulator
        assertEq(l.netAccWad * N + l.carryWad, (uint256(l.grossReceived) - l.feeCollected) * 1e18, "carry");
        // fees: exactly the payout fee on accepted gross, nothing from the issuer
        assertEq(usdc.balanceOf(address(feeCollector)), auctionFees + l.feeCollected);
        assertEq(issuerPaid, uint256(l.grossReceived) + l.refundedToIssuer, "issuer pays only what holders receive");
        // solvency: what the vault holds covers every holder's entitlement, with at most rounding dust left over
        uint256 owed;
        for (uint256 h = 0; h < 3; h++) {
            owed += vault.pendingOf(sid, holders[h]);
        }
        uint256 bal = usdc.balanceOf(address(vault));
        assertGe(bal, owed, "vault insolvent");
        assertLe(bal - owed, settles + 4, "unaccounted vault funds"); // 3 unsettled floors + the carry
        assertEq(bal, uint256(l.grossReceived) - l.feeCollected - l.claimedTotal);
    }
}
