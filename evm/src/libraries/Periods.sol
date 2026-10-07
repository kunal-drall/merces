// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @notice UTC calendar quarters (SPEC §1.2). `period_id = year × 4 + (quarter − 1)`; 2026 Q1 → 8104.
/// Civil-date conversion uses Howard Hinnant's `civil_from_days` / `days_from_civil`, exact for all
/// unix timestamps ≥ 0.
library Periods {
    uint256 internal constant DAY = 86_400;

    /// @dev Returns (year, month, day) for a count of days since 1970-01-01.
    function civilFromDays(uint256 z) internal pure returns (uint256 y, uint256 m, uint256 d) {
        unchecked {
            z += 719_468;
            uint256 era = z / 146_097;
            uint256 doe = z - era * 146_097; // [0, 146096]
            uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
            y = yoe + era * 400;
            uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
            uint256 mp = (5 * doy + 2) / 153; // [0, 11]
            d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
            m = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
            if (m <= 2) y += 1;
        }
    }

    /// @dev Days since 1970-01-01 for a civil date (month 1..12, day 1..31).
    function daysFromCivil(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        unchecked {
            if (m <= 2) y -= 1;
            uint256 era = y / 400;
            uint256 yoe = y - era * 400; // [0, 399]
            uint256 doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1; // [0, 365]
            uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
            return era * 146_097 + doe - 719_468;
        }
    }

    function periodOf(uint256 timestamp) internal pure returns (uint32) {
        (uint256 y, uint256 m,) = civilFromDays(timestamp / DAY);
        return uint32(y * 4 + (m - 1) / 3);
    }

    function yearOf(uint32 pid) internal pure returns (uint16) {
        return uint16(pid / 4);
    }

    function quarterIndex(uint32 pid) internal pure returns (uint8) {
        return uint8(pid % 4);
    }

    /// @dev First second of the quarter.
    function periodStart(uint32 pid) internal pure returns (uint64) {
        uint256 y = pid / 4;
        uint256 m = uint256(pid % 4) * 3 + 1;
        return uint64(daysFromCivil(y, m, 1) * DAY);
    }

    /// @dev First second of the next quarter (exclusive end).
    function periodEnd(uint32 pid) internal pure returns (uint64) {
        return periodStart(pid + 1);
    }

    function daysInPeriod(uint32 pid) internal pure returns (uint64) {
        return (periodEnd(pid) - periodStart(pid)) / uint64(DAY);
    }

    /// @dev Civil year of a timestamp.
    function civilYear(uint256 timestamp) internal pure returns (uint16) {
        (uint256 y,,) = civilFromDays(timestamp / DAY);
        return uint16(y);
    }
}
