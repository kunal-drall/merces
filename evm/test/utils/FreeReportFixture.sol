// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "./FullFixture.sol";
import {MockGroth16Verifier} from "../mocks/MockGroth16Verifier.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Periods} from "../../src/libraries/Periods.sol";

/// @notice Full fixture with an accept-all Groth16 verifier installed through the timelock-owned setter, so fuzz
/// and invariant suites can report arbitrary payment amounts. Every other report rule (sequence, timing, prior
/// commitment chain, tier-2 verifier signature, FX) still applies.
abstract contract FreeReportFixture is FullFixture {
    function installMockVerifier() internal {
        address mock = address(new MockGroth16Verifier());
        vm.prank(address(timelock));
        income.setGroth16Verifier(mock);
    }

    /// @dev A deterministic, non-zero field element per (series, period).
    function incomeCommitmentOf(uint256 sid, uint32 period) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode("merces.fuzz.income", sid, period))) >> 4);
    }

    /// @dev Tier-2 report input for `payment` with the correct prior commitment for the chain rule (SPEC §6.2.5).
    function freeReportInput(uint256 sid, uint32 period, uint64 payment, bool liquidityEvent)
        internal
        view
        returns (IMercesIncome.ReportInput memory r)
    {
        IMercesIncome.Ledger memory l = income.getLedger(sid);
        bytes32 prior;
        if (Periods.quarterIndex(period) == 0) prior = bytes32(income.ZERO_INCOME_COMMITMENT());
        else if (l.hasIncomeCommitment) prior = l.lastIncomeCommitment;
        else prior = bytes32(uint256(1));
        r.seriesId = sid;
        r.period = period;
        r.paymentUsd = payment;
        r.fxAvgWad = 1e18;
        r.priorIncomeCommitment = prior;
        r.incomeCommitment = incomeCommitmentOf(sid, period);
        r.tier = 2;
        r.liquidityEvent = liquidityEvent;
        r.attestationSignature = sign(
            verifierKey, MercesMessages.reportDigest(domain, sid, period, prior, r.incomeCommitment, 2, liquidityEvent)
        );
    }

    /// @dev Warps to the end of `period` if needed, reports `payment` and returns the opened due.
    function freeReport(uint256 sid, uint32 period, uint64 payment) internal returns (uint64 due) {
        if (vm.getBlockTimestamp() < Periods.periodEnd(period)) vm.warp(Periods.periodEnd(period));
        IMercesIncome.ReportInput memory r = freeReportInput(sid, period, payment, false);
        vm.prank(issuer);
        income.submitReport(r);
        (due,) = income.openDue(sid);
    }
}
