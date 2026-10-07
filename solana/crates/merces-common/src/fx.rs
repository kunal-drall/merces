//! Rate accumulator arithmetic (SPEC §6.6, brief C9).

use crate::{mul_div, time::days_in_period, to_u64, MathError, MathResult, BPS_DENOMINATOR, WAD};

/// `normalize(price, expo)`: `price × 10^(18 + expo)` as WAD. Handles `expo < −18` by dividing.
/// Requires `price > 0`.
pub fn normalize(price: i64, expo: i32) -> MathResult<u64> {
    if price <= 0 {
        return Err(MathError::InvalidInput);
    }
    let p = u128::try_from(price).map_err(|_| MathError::Overflow)?;
    let shift = 18i32.checked_add(expo).ok_or(MathError::Overflow)?;
    let v = if shift >= 0 {
        let e = u32::try_from(shift).map_err(|_| MathError::Overflow)?;
        if e > 38 {
            return Err(MathError::Overflow);
        }
        p.checked_mul(10u128.pow(e)).ok_or(MathError::Overflow)?
    } else {
        let e = u32::try_from(shift.checked_neg().ok_or(MathError::Overflow)?)
            .map_err(|_| MathError::Overflow)?;
        if e > 38 {
            return Ok(0);
        }
        p.checked_div(10u128.pow(e))
            .ok_or(MathError::DivisionByZero)?
    };
    to_u64(v)
}

/// `floor(WAD × WAD / rate_wad)`.
pub fn invert(rate_wad: u64) -> MathResult<u64> {
    if rate_wad == 0 {
        return Err(MathError::DivisionByZero);
    }
    to_u64(mul_div(WAD, WAD, u128::from(rate_wad))?)
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

/// A checkpoint of the accumulator at the first snapshot of a period.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Checkpoint {
    pub sum_wad: u128,
    pub count: u32,
    pub flagged: bool,
}

/// `quarter_average(pair, p)` from the checkpoints at `p` and `p + 1`. Returns `(ok, avg_wad)`.
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
    let required = days_in_period(period)?
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
        // EUR/USD 1.08543210 with expo −8
        assert_eq!(
            normalize(108_543_210, -8).unwrap(),
            1_085_432_100_000_000_000
        );
        assert_eq!(normalize(1, 0).unwrap(), WAD as u64);
        assert_eq!(normalize(123, -20).unwrap(), 1); // 123e-20 → 1.23e-18 → floor 1 wei
        assert_eq!(normalize(0, -8), Err(MathError::InvalidInput));
        assert_eq!(normalize(-5, -8), Err(MathError::InvalidInput));
        assert_eq!(invert(2 * WAD as u64).unwrap(), WAD as u64 / 2);
        assert_eq!(
            invert(1_085_432_100_000_000_000).unwrap(),
            921_292_082_664_590_442
        );
    }

    #[test]
    fn confidence_and_deviation() {
        assert!(conf_ok(100_000_000, 1_000_000, 100).unwrap()); // 1% exactly
        assert!(!conf_ok(100_000_000, 1_000_001, 100).unwrap());
        assert!(!deviates(1_020 * 10u64.pow(15), WAD as u64, 200).unwrap()); // 2% exactly
        assert!(deviates(1_020 * 10u64.pow(15) + 1, WAD as u64, 200).unwrap());
        assert!(deviates(980 * 10u64.pow(15) - 1, WAD as u64, 200).unwrap());
    }

    #[test]
    fn averages_and_coverage() {
        let start = Checkpoint {
            sum_wad: 10 * WAD,
            count: 10,
            flagged: false,
        };
        // 2026 Q1 has 90 days; 72 snapshots = 80%
        let end = Checkpoint {
            sum_wad: 10 * WAD + 72 * WAD + 36 * WAD,
            count: 82,
            flagged: false,
        };
        let (ok, avg) = quarter_average(8104, &start, &end, 8000).unwrap();
        assert!(ok);
        assert_eq!(avg, (WAD + WAD / 2) as u64);
        let short = Checkpoint {
            sum_wad: 10 * WAD + 71 * WAD,
            count: 81,
            flagged: false,
        };
        let (ok, avg) = quarter_average(8104, &start, &short, 8000).unwrap();
        assert!(!ok);
        assert_eq!(avg, WAD as u64);
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
