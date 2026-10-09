//! Rate accumulator arithmetic (SPEC v1.1 §6.6, brief C9).

use crate::{
    mul_div, time::trading_days_in_period, to_u64, MathError, MathResult, BPS_DENOMINATOR, WAD,
};

/// `normalize(price, expo)`: `expo ≤ 0` → `price × 10^(18 + expo)` (requires `expo ≥ −18`);
/// `expo > 0` → `price × 10^18 × 10^expo`. Requires `price > 0`. Returns the WAD-scaled rate as a
/// **u128** so an inverted pair can be divided down before the u64 cap applies (S4): a USD/JPY-type
/// pair (≈150, expo −8) normalizes to 1.5e20 > `u64::MAX`, which `invert` turns into ≈6.7e15 that
/// fits. A non-inverted pair's caller applies `to_u64` to this value directly (it must fit).
pub fn normalize(price: i64, expo: i32) -> MathResult<u128> {
    if price <= 0 {
        return Err(MathError::InvalidInput);
    }
    let p = u128::try_from(price).map_err(|_| MathError::Overflow)?;
    if expo <= 0 {
        if expo < -18 {
            return Err(MathError::InvalidInput);
        }
        let shift = u32::try_from(18i32.checked_add(expo).ok_or(MathError::Overflow)?)
            .map_err(|_| MathError::Overflow)?;
        p.checked_mul(10u128.pow(shift)).ok_or(MathError::Overflow)
    } else {
        let e = u32::try_from(expo).map_err(|_| MathError::Overflow)?;
        if e > 20 {
            return Err(MathError::Overflow);
        }
        p.checked_mul(WAD)
            .ok_or(MathError::Overflow)?
            .checked_mul(10u128.pow(e))
            .ok_or(MathError::Overflow)
    }
}

/// `floor(WAD × WAD / rate_wad)` with a u128 dividend, capped to u64 only on the inverted result
/// (S4). `rate_wad` is the un-capped normalized rate (`normalize`).
pub fn invert(rate_wad: u128) -> MathResult<u64> {
    if rate_wad == 0 {
        return Err(MathError::DivisionByZero);
    }
    to_u64(mul_div(WAD, WAD, rate_wad)?)
}

/// Confidence check: `conf × 10000 ≤ price × max_conf_bps`.
pub fn conf_ok(price: i64, conf: u64, max_conf_bps: u16) -> MathResult<bool> {
    if price <= 0 {
        return Ok(false);
    }
    let lhs = u128::from(conf)
        .checked_mul(u128::from(BPS_DENOMINATOR))
        .ok_or(MathError::Overflow)?;
    let rhs = u128::try_from(price)
        .map_err(|_| MathError::Overflow)?
        .checked_mul(u128::from(max_conf_bps))
        .ok_or(MathError::Overflow)?;
    Ok(lhs <= rhs)
}

/// Deviation check against a cross-check rate: `|rate − cl| × 10000 > cl × band_bps` → flagged.
pub fn deviates(rate_wad: u64, crosscheck_wad: u64, band_bps: u16) -> MathResult<bool> {
    let diff = u128::from(rate_wad.abs_diff(crosscheck_wad));
    let lhs = diff
        .checked_mul(u128::from(BPS_DENOMINATOR))
        .ok_or(MathError::Overflow)?;
    let rhs = u128::from(crosscheck_wad)
        .checked_mul(u128::from(band_bps))
        .ok_or(MathError::Overflow)?;
    Ok(lhs > rhs)
}

/// Accumulator totals at a point in time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Checkpoint {
    pub sum_wad: u128,
    pub count: u32,
    pub flagged: bool,
}

/// `quarter_average(pair, p)` from the checkpoint at `p` and the end totals (checkpoint `p + 1` or
/// the live totals). Returns `(ok, avg_wad)`; coverage counts Monday–Friday days of the period.
pub fn quarter_average(
    period: u32,
    start: &Checkpoint,
    end: &Checkpoint,
    min_coverage_bps: u16,
) -> MathResult<(bool, u64)> {
    let n = end
        .count
        .checked_sub(start.count)
        .ok_or(MathError::Overflow)?;
    if n == 0 {
        return Ok((false, 0));
    }
    let sum = end
        .sum_wad
        .checked_sub(start.sum_wad)
        .ok_or(MathError::Overflow)?;
    let avg = to_u64(
        sum.checked_div(u128::from(n))
            .ok_or(MathError::DivisionByZero)?,
    )?;
    let coverage = u64::from(n)
        .checked_mul(BPS_DENOMINATOR)
        .ok_or(MathError::Overflow)?;
    let required = trading_days_in_period(period)?
        .checked_mul(u64::from(min_coverage_bps))
        .ok_or(MathError::Overflow)?;
    let ok = coverage >= required && !start.flagged;
    Ok((ok, avg))
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    #[test]
    fn normalization() {
        assert_eq!(
            normalize(108_543_210, -8).unwrap(),
            1_085_432_100_000_000_000u128
        );
        assert_eq!(normalize(1, 0).unwrap(), WAD);
        assert_eq!(normalize(1, 1).unwrap(), 10u128.pow(19));
        // normalize keeps the intermediate in u128 (S4): a value above u64 is returned, not an
        // error; the u64 cap is the caller's (non-inverted) or `invert`'s (inverted)
        assert_eq!(normalize(5, 2).unwrap(), 5u128 * 10u128.pow(20));
        assert_eq!(normalize(123, -19), Err(MathError::InvalidInput));
        assert_eq!(normalize(0, -8), Err(MathError::InvalidInput));
        assert_eq!(normalize(-5, -8), Err(MathError::InvalidInput));
        assert_eq!(invert(2 * WAD).unwrap(), WAD as u64 / 2);
        assert_eq!(
            invert(1_085_432_100_000_000_000u128).unwrap(),
            921_292_082_664_590_442
        );
        // USD/JPY-type (Pyth price 150×10^8, expo −8): pre-inversion 1.5e20 > u64::MAX, inverts to
        // ≈6.67e15 which fits (S4)
        assert_eq!(normalize(15_000_000_000, -8).unwrap(), 150u128 * 10u128.pow(18));
        assert!(u64::try_from(normalize(15_000_000_000, -8).unwrap()).is_err());
        assert_eq!(
            invert(normalize(15_000_000_000, -8).unwrap()).unwrap(),
            6_666_666_666_666_666
        );
    }

    #[test]
    fn confidence_and_deviation() {
        assert!(conf_ok(100_000_000, 1_000_000, 100).unwrap());
        assert!(!conf_ok(100_000_000, 1_000_001, 100).unwrap());
        assert!(!deviates(1_020 * 10u64.pow(15), WAD as u64, 200).unwrap());
        assert!(deviates(1_020 * 10u64.pow(15) + 1, WAD as u64, 200).unwrap());
    }

    #[test]
    fn averages_and_trading_day_coverage() {
        // 2026 Q1 (Jan 1 – Mar 31) has 64 trading days; 80% → 52 snapshots required (51.2 → ceil via ≥)
        assert_eq!(trading_days_in_period(8104).unwrap(), 64);
        let start = Checkpoint {
            sum_wad: 10 * WAD,
            count: 10,
            flagged: false,
        };
        let end = Checkpoint {
            sum_wad: 10 * WAD + 52 * WAD + 26 * WAD,
            count: 62,
            flagged: false,
        };
        let (ok, avg) = quarter_average(8104, &start, &end, 8000).unwrap();
        assert!(ok);
        assert_eq!(avg, (WAD + WAD / 2) as u64);
        let short = Checkpoint {
            sum_wad: 10 * WAD + 51 * WAD,
            count: 61,
            flagged: false,
        };
        assert!(!quarter_average(8104, &start, &short, 8000).unwrap().0);
        let flagged = Checkpoint {
            flagged: true,
            ..start
        };
        assert!(!quarter_average(8104, &flagged, &end, 8000).unwrap().0);
        assert_eq!(
            quarter_average(8104, &start, &start, 8000).unwrap(),
            (false, 0)
        );
    }
}
