// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Periods} from "../../src/libraries/Periods.sol";

contract PeriodsTest is Test {
    function test_specExample_2026Q1() public pure {
        // 2026-01-01T00:00:00Z = 1767225600
        assertEq(Periods.periodOf(1_767_225_600), 8104);
        assertEq(Periods.periodStart(8104), 1_767_225_600);
        // 2026-04-01T00:00:00Z = 1775001600 (31 + 28 + 31 = 90 days after 2026-01-01)
        assertEq(Periods.periodEnd(8104), 1_775_001_600);
        assertEq(Periods.daysInPeriod(8104), 90);
        assertEq(Periods.daysInPeriod(8105), 91); // Q2 2026
        assertEq(Periods.daysInPeriod(8106), 92); // Q3
        assertEq(Periods.daysInPeriod(8107), 92); // Q4
        assertEq(Periods.yearOf(8104), 2026);
        assertEq(Periods.quarterIndex(8107), 3);
    }

    function test_leapYear() public pure {
        // 2028 is a leap year: Q1 has 91 days
        assertEq(Periods.daysInPeriod(2028 * 4), 91);
        // 2100 is not a leap year
        assertEq(Periods.daysInPeriod(2100 * 4), 90);
        // 2000 is a leap year
        assertEq(Periods.daysInPeriod(2000 * 4), 91);
    }

    function test_epoch() public pure {
        (uint256 y, uint256 m, uint256 d) = Periods.civilFromDays(0);
        assertEq(y, 1970);
        assertEq(m, 1);
        assertEq(d, 1);
        assertEq(Periods.daysFromCivil(1970, 1, 1), 0);
        assertEq(Periods.periodOf(0), 1970 * 4);
    }

    function test_lastSecondOfQuarterBelongsToIt() public pure {
        uint32 p = 8104;
        assertEq(Periods.periodOf(Periods.periodEnd(p) - 1), p);
        assertEq(Periods.periodOf(Periods.periodEnd(p)), p + 1);
    }

    function testFuzz_civilRoundTrip(uint32 daysSinceEpoch) public pure {
        (uint256 y, uint256 m, uint256 d) = Periods.civilFromDays(daysSinceEpoch);
        assertTrue(m >= 1 && m <= 12);
        assertTrue(d >= 1 && d <= 31);
        assertEq(Periods.daysFromCivil(y, m, d), daysSinceEpoch);
    }

    function testFuzz_periodBoundaries(uint64 ts) public pure {
        ts = uint64(bound(ts, 0, type(uint32).max * uint256(86_400)));
        uint32 p = Periods.periodOf(ts);
        assertLe(Periods.periodStart(p), ts);
        assertLt(ts, Periods.periodEnd(p));
        uint64 len = Periods.daysInPeriod(p);
        assertTrue(len == 90 || len == 91 || len == 92);
    }
}
