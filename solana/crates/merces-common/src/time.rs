//! Time, days and periods (SPEC §1.2). Civil-date arithmetic follows Howard Hinnant's
//! `days_from_civil` / `civil_from_days`, exact for every unix timestamp ≥ 0.

use crate::{MathError, MathResult};

pub const DAY: u64 = 86_400;
pub const YEAR: u64 = 365 * DAY; // 31_536_000
pub const MONTH_SECONDS: u64 = 2_629_800; // 30.4375 days
pub const EIGHTEEN_MONTHS: u64 = 18 * MONTH_SECONDS; // 47_336_400

/// Days since 1970-01-01 for a proleptic Gregorian civil date.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> MathResult<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(MathError::InvalidInput);
    }
    let y = if m <= 2 {
        y.checked_sub(1).ok_or(MathError::Overflow)?
    } else {
        y
    };
    let era = if y >= 0 {
        y
    } else {
        y.checked_sub(399).ok_or(MathError::Overflow)?
    }
    .checked_div(400)
    .ok_or(MathError::DivisionByZero)?;
    let yoe = y
        .checked_sub(era.checked_mul(400).ok_or(MathError::Overflow)?)
        .ok_or(MathError::Overflow)?; // [0, 399]
    let mp = i64::from(if m > 2 {
        m.checked_sub(3).ok_or(MathError::Overflow)?
    } else {
        m.checked_add(9).ok_or(MathError::Overflow)?
    }); // [0, 11]
    let doy = (153i64
        .checked_mul(mp)
        .ok_or(MathError::Overflow)?
        .checked_add(2)
        .ok_or(MathError::Overflow)?)
    .checked_div(5)
    .ok_or(MathError::DivisionByZero)?
    .checked_add(i64::from(d))
    .ok_or(MathError::Overflow)?
    .checked_sub(1)
    .ok_or(MathError::Overflow)?; // [0, 365]
    let doe = yoe
        .checked_mul(365)
        .ok_or(MathError::Overflow)?
        .checked_add(yoe.checked_div(4).ok_or(MathError::DivisionByZero)?)
        .ok_or(MathError::Overflow)?
        .checked_sub(yoe.checked_div(100).ok_or(MathError::DivisionByZero)?)
        .ok_or(MathError::Overflow)?
        .checked_add(doy)
        .ok_or(MathError::Overflow)?; // [0, 146096]
    era.checked_mul(146_097)
        .ok_or(MathError::Overflow)?
        .checked_add(doe)
        .ok_or(MathError::Overflow)?
        .checked_sub(719_468)
        .ok_or(MathError::Overflow)
}

/// Civil date `(year, month, day)` for a day count since 1970-01-01.
pub fn civil_from_days(z: i64) -> MathResult<(i64, u32, u32)> {
    let z = z.checked_add(719_468).ok_or(MathError::Overflow)?;
    let era = if z >= 0 {
        z
    } else {
        z.checked_sub(146_096).ok_or(MathError::Overflow)?
    }
    .checked_div(146_097)
    .ok_or(MathError::DivisionByZero)?;
    let doe = z
        .checked_sub(era.checked_mul(146_097).ok_or(MathError::Overflow)?)
        .ok_or(MathError::Overflow)?; // [0, 146096]
    let yoe = doe
        .checked_sub(doe.checked_div(1460).ok_or(MathError::DivisionByZero)?)
        .ok_or(MathError::Overflow)?
        .checked_add(doe.checked_div(36_524).ok_or(MathError::DivisionByZero)?)
        .ok_or(MathError::Overflow)?
        .checked_sub(doe.checked_div(146_096).ok_or(MathError::DivisionByZero)?)
        .ok_or(MathError::Overflow)?
        .checked_div(365)
        .ok_or(MathError::DivisionByZero)?; // [0, 399]
    let y = yoe
        .checked_add(era.checked_mul(400).ok_or(MathError::Overflow)?)
        .ok_or(MathError::Overflow)?;
    let doy = doe
        .checked_sub(
            365i64
                .checked_mul(yoe)
                .ok_or(MathError::Overflow)?
                .checked_add(yoe.checked_div(4).ok_or(MathError::DivisionByZero)?)
                .ok_or(MathError::Overflow)?
                .checked_sub(yoe.checked_div(100).ok_or(MathError::DivisionByZero)?)
                .ok_or(MathError::Overflow)?,
        )
        .ok_or(MathError::Overflow)?; // [0, 365]
    let mp = 5i64
        .checked_mul(doy)
        .ok_or(MathError::Overflow)?
        .checked_add(2)
        .ok_or(MathError::Overflow)?
        .checked_div(153)
        .ok_or(MathError::DivisionByZero)?; // [0, 11]
    let d = doy
        .checked_sub(
            153i64
                .checked_mul(mp)
                .ok_or(MathError::Overflow)?
                .checked_add(2)
                .ok_or(MathError::Overflow)?
                .checked_div(5)
                .ok_or(MathError::DivisionByZero)?,
        )
        .ok_or(MathError::Overflow)?
        .checked_add(1)
        .ok_or(MathError::Overflow)?; // [1, 31]
    let m = if mp < 10 {
        mp.checked_add(3).ok_or(MathError::Overflow)?
    } else {
        mp.checked_sub(9).ok_or(MathError::Overflow)?
    }; // [1, 12]
    let y = if m <= 2 {
        y.checked_add(1).ok_or(MathError::Overflow)?
    } else {
        y
    };
    Ok((
        y,
        u32::try_from(m).map_err(|_| MathError::Overflow)?,
        u32::try_from(d).map_err(|_| MathError::Overflow)?,
    ))
}

/// `period_id = year × 4 + (quarter − 1)` for the UTC quarter containing `ts`.
pub fn period_of(ts: u64) -> MathResult<u32> {
    let days = i64::try_from(ts.checked_div(DAY).ok_or(MathError::DivisionByZero)?)
        .map_err(|_| MathError::Overflow)?;
    let (y, m, _) = civil_from_days(days)?;
    let quarter_index = m.checked_sub(1).ok_or(MathError::Overflow)? / 3; // 0..=3
    let y = u32::try_from(y).map_err(|_| MathError::Overflow)?;
    y.checked_mul(4)
        .ok_or(MathError::Overflow)?
        .checked_add(quarter_index)
        .ok_or(MathError::Overflow)
}

/// Calendar year of a period id.
pub fn year_of(pid: u32) -> u32 {
    pid / 4
}

/// Quarter index of a period id (0 = Q1).
pub fn quarter_index(pid: u32) -> u32 {
    pid % 4
}

/// First second of the quarter.
pub fn period_start(pid: u32) -> MathResult<u64> {
    let y = i64::from(year_of(pid));
    let m = quarter_index(pid)
        .checked_mul(3)
        .ok_or(MathError::Overflow)?
        .checked_add(1)
        .ok_or(MathError::Overflow)?;
    let days = days_from_civil(y, m, 1)?;
    let days = u64::try_from(days).map_err(|_| MathError::Overflow)?;
    days.checked_mul(DAY).ok_or(MathError::Overflow)
}

/// First second of the next quarter (exclusive end).
pub fn period_end(pid: u32) -> MathResult<u64> {
    period_start(pid.checked_add(1).ok_or(MathError::Overflow)?)
}

/// Number of days in a quarter (90, 91 or 92).
pub fn days_in_period(pid: u32) -> MathResult<u64> {
    let len = period_end(pid)?
        .checked_sub(period_start(pid)?)
        .ok_or(MathError::Overflow)?;
    len.checked_div(DAY).ok_or(MathError::DivisionByZero)
}

/// `floor(ts / DAY)` as the UTC day number used by the FX accumulator.
pub fn day_of(ts: u64) -> u32 {
    // ts / DAY < 2^32 for every timestamp before year 11 million.
    u32::try_from(ts / DAY).unwrap_or(u32::MAX)
}

/// Monday–Friday civil days in `[period_start(pid), period_end(pid))` (SPEC §6.6 coverage base).
/// 1970-01-01 was a Thursday, so `weekday = (days + 4) % 7` with `0 = Sunday`.
pub fn trading_days_in_period(pid: u32) -> MathResult<u64> {
    let start = period_start(pid)?.checked_div(DAY).ok_or(MathError::DivisionByZero)?;
    let end = period_end(pid)?.checked_div(DAY).ok_or(MathError::DivisionByZero)?;
    let mut count: u64 = 0;
    let mut d = start;
    while d < end {
        let weekday = d.checked_add(4).ok_or(MathError::Overflow)? % 7;
        if (1..=5).contains(&weekday) {
            count = count.checked_add(1).ok_or(MathError::Overflow)?;
        }
        d = d.checked_add(1).ok_or(MathError::Overflow)?;
    }
    Ok(count)
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    #[test]
    fn epoch_and_known_dates() {
        assert_eq!(days_from_civil(1970, 1, 1).unwrap(), 0);
        assert_eq!(civil_from_days(0).unwrap(), (1970, 1, 1));
        assert_eq!(days_from_civil(2000, 3, 1).unwrap(), 11_017);
        assert_eq!(civil_from_days(11_017).unwrap(), (2000, 3, 1));
        // 2026-01-01T00:00:00Z = 1767225600
        assert_eq!(
            days_from_civil(2026, 1, 1).unwrap() as u64 * DAY,
            1_767_225_600
        );
    }

    #[test]
    fn spec_example_period() {
        // SPEC §1.2: 2026 Q1 → 8104
        assert_eq!(period_of(1_767_225_600).unwrap(), 8104);
        assert_eq!(period_start(8104).unwrap(), 1_767_225_600);
        assert_eq!(period_end(8104).unwrap(), 1_767_225_600 + 90 * DAY); // 2026 is not a leap year
        assert_eq!(days_in_period(8104).unwrap(), 90);
        assert_eq!(days_in_period(8105).unwrap(), 91); // Q2: Apr+May+Jun
        assert_eq!(days_in_period(8106).unwrap(), 92); // Q3
        assert_eq!(days_in_period(8107).unwrap(), 92); // Q4
        assert_eq!(days_in_period(8112).unwrap(), 91); // 2028 Q1 (leap year)
        assert_eq!(year_of(8104), 2026);
        assert_eq!(quarter_index(8107), 3);
    }

    #[test]
    fn period_boundaries_are_consistent() {
        for pid in 8000u32..8200 {
            let s = period_start(pid).unwrap();
            let e = period_end(pid).unwrap();
            assert_eq!(period_of(s).unwrap(), pid);
            assert_eq!(period_of(e - 1).unwrap(), pid);
            assert_eq!(period_of(e).unwrap(), pid + 1);
            let d = days_in_period(pid).unwrap();
            assert!((90..=92).contains(&d));
        }
    }

    #[test]
    fn civil_roundtrip_range() {
        let mut day: i64 = -800_000;
        while day < 800_000 {
            let (y, m, d) = civil_from_days(day).unwrap();
            assert_eq!(days_from_civil(y, m, d).unwrap(), day);
            day += 97;
        }
    }

    #[test]
    fn trading_days() {
        // 2026 Q1: Jan 1 (Thu) … Mar 31 (Tue): 90 days, 64 weekdays
        assert_eq!(trading_days_in_period(8104).unwrap(), 64);
        // 2026 Q2: Apr 1 (Wed) … Jun 30 (Tue): 91 days, 65 weekdays
        assert_eq!(trading_days_in_period(8105).unwrap(), 65);
        // 1970 Q1 starts on a Thursday
        assert_eq!((0 + 4) % 7, 4);
        for pid in 8000u32..8120 {
            let t = trading_days_in_period(pid).unwrap();
            assert!((64..=66).contains(&t), "{pid}: {t}");
        }
    }

    #[test]
    fn eighteen_months_constant() {
        assert_eq!(EIGHTEEN_MONTHS, 47_336_400);
        assert_eq!(YEAR, 31_536_000);
    }
}
