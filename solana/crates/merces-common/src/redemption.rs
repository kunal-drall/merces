//! Redemption formula price (SPEC §6.7, brief C7).

use crate::{
    div_ceil, mul_div, params::MAX_YEAR_BUCKETS, time::YEAR, to_u64, MathError, MathResult, WAD,
};

/// Inputs to `redeem`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RedemptionInputs<'a> {
    pub clearing_price: u64,
    pub hurdle_rate_wad: u64,
    pub payout_multiple_k: u16,
    pub cap_per_unit: u64,
    pub paid_per_unit_wad: u128,
    /// `year_gross_wad[y]` indexed by settlement year.
    pub year_gross_wad: &'a [u128],
    pub settlement_ts: u64,
    pub now: u64,
}

/// The terms of the formula, all in base units per unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RedemptionPrice {
    pub price: u64,
    pub hurdle: u64,
    pub d_avg: u64,
    pub cap_remaining: u64,
}

/// `P_hurdle = P0 × (1 + h)^Y × (1 + h × frac)` with the exact rounding sequence of SPEC §6.7.
pub fn hurdle_price(clearing_price: u64, hurdle_rate_wad: u64, elapsed: u64) -> MathResult<u64> {
    let y = elapsed.checked_div(YEAR).ok_or(MathError::DivisionByZero)?;
    let rem = elapsed
        .checked_sub(y.checked_mul(YEAR).ok_or(MathError::Overflow)?)
        .ok_or(MathError::Overflow)?;
    let frac_wad = mul_div(u128::from(rem), WAD, u128::from(YEAR))?;
    let h = u128::from(hurdle_rate_wad);
    let one_plus_h = WAD.checked_add(h).ok_or(MathError::Overflow)?;
    let mut p = u128::from(clearing_price);
    for _ in 0..y {
        p = mul_div(p, one_plus_h, WAD)?;
    }
    let partial = WAD
        .checked_add(mul_div(h, frac_wad, WAD)?)
        .ok_or(MathError::Overflow)?;
    p = mul_div(p, partial, WAD)?;
    to_u64(p)
}

/// `P_redeem = min(C_rem, max(P_hurdle, k × D_avg))` (the `k × D_avg` term only once a full year
/// has elapsed).
pub fn redemption_price(inp: &RedemptionInputs) -> MathResult<RedemptionPrice> {
    let t = inp
        .now
        .checked_sub(inp.settlement_ts)
        .ok_or(MathError::Overflow)?;
    let years = t.checked_div(YEAR).ok_or(MathError::DivisionByZero)?;
    let hurdle = hurdle_price(inp.clearing_price, inp.hurdle_rate_wad, t)?;
    let paid_units = to_u64(div_ceil(inp.paid_per_unit_wad, WAD)?)?;
    let cap_remaining = inp
        .cap_per_unit
        .checked_sub(paid_units)
        .ok_or(MathError::Overflow)?;
    let (d_avg, floor_term) = if years >= 1 {
        let n = core::cmp::min(years, 3);
        let start = years.checked_sub(n).ok_or(MathError::Overflow)?;
        let mut sum: u128 = 0;
        for y in start..years {
            let idx = usize::try_from(y).map_err(|_| MathError::Overflow)?;
            if idx >= MAX_YEAR_BUCKETS || idx >= inp.year_gross_wad.len() {
                return Err(MathError::InvalidInput);
            }
            sum = sum
                .checked_add(inp.year_gross_wad[idx])
                .ok_or(MathError::Overflow)?;
        }
        let den = u128::from(n).checked_mul(WAD).ok_or(MathError::Overflow)?;
        let d_avg = to_u64(sum.checked_div(den).ok_or(MathError::DivisionByZero)?)?;
        let k_term = u64::from(inp.payout_multiple_k)
            .checked_mul(d_avg)
            .ok_or(MathError::Overflow)?;
        (d_avg, core::cmp::max(hurdle, k_term))
    } else {
        (0, hurdle)
    };
    Ok(RedemptionPrice {
        price: core::cmp::min(cap_remaining, floor_term),
        hurdle,
        d_avg,
        cap_remaining,
    })
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    const H8: u64 = 80_000_000_000_000_000;

    #[test]
    fn hurdle_compounds_yearly_and_interpolates() {
        assert_eq!(hurdle_price(1_000_000, H8, 0).unwrap(), 1_000_000);
        assert_eq!(hurdle_price(1_000_000, H8, YEAR).unwrap(), 1_080_000);
        assert_eq!(hurdle_price(1_000_000, H8, 2 * YEAR).unwrap(), 1_166_400);
        // half a year: 1_000_000 × (1 + 0.04) = 1_040_000 (frac = 0.5 exactly? 182.5 d → frac_wad = 0.5e18)
        assert_eq!(hurdle_price(1_000_000, H8, YEAR / 2).unwrap(), 1_040_000);
        assert_eq!(
            hurdle_price(1_000_000, H8, YEAR + YEAR / 2).unwrap(),
            1_123_200
        );
    }

    #[test]
    fn each_term_can_decide() {
        let years = [0u128; 64];
        // < 1 year: hurdle decides when below the cap
        let p = redemption_price(&RedemptionInputs {
            clearing_price: 1_000_000,
            hurdle_rate_wad: H8,
            payout_multiple_k: 5,
            cap_per_unit: 2_500_000,
            paid_per_unit_wad: 0,
            year_gross_wad: &years,
            settlement_ts: 0,
            now: YEAR / 2,
        })
        .unwrap();
        assert_eq!(p.price, 1_040_000);
        assert_eq!(p.d_avg, 0);
        assert_eq!(p.cap_remaining, 2_500_000);
        // 2 years, paid 300_000/unit/yr → D_avg 300_000, k×D = 1_500_000 > hurdle 1_166_400
        let mut y = [0u128; 64];
        y[0] = 300_000 * WAD;
        y[1] = 300_000 * WAD;
        let p = redemption_price(&RedemptionInputs {
            clearing_price: 1_000_000,
            hurdle_rate_wad: H8,
            payout_multiple_k: 5,
            cap_per_unit: 2_500_000,
            paid_per_unit_wad: 600_000 * WAD,
            year_gross_wad: &y,
            settlement_ts: 0,
            now: 2 * YEAR,
        })
        .unwrap();
        assert_eq!(p.d_avg, 300_000);
        assert_eq!(p.hurdle, 1_166_400);
        assert_eq!(p.cap_remaining, 1_900_000);
        assert_eq!(p.price, 1_500_000);
        // remaining cap decides: paid 2_000_000 → C_rem 500_000
        let p = redemption_price(&RedemptionInputs {
            clearing_price: 1_000_000,
            hurdle_rate_wad: H8,
            payout_multiple_k: 5,
            cap_per_unit: 2_500_000,
            paid_per_unit_wad: 2_000_000 * WAD,
            year_gross_wad: &y,
            settlement_ts: 0,
            now: 2 * YEAR,
        })
        .unwrap();
        assert_eq!(p.price, 500_000);
        // ceil rounding of paid units favours the issuer
        let p = redemption_price(&RedemptionInputs {
            clearing_price: 1_000_000,
            hurdle_rate_wad: H8,
            payout_multiple_k: 5,
            cap_per_unit: 2_500_000,
            paid_per_unit_wad: 2_000_000 * WAD + 1,
            year_gross_wad: &y,
            settlement_ts: 0,
            now: 2 * YEAR,
        })
        .unwrap();
        assert_eq!(p.cap_remaining, 499_999);
    }

    #[test]
    fn trailing_window_is_three_years() {
        let mut y = [0u128; 64];
        y[0] = 900_000 * WAD; // excluded once 4 years elapsed
        y[1] = 100_000 * WAD;
        y[2] = 200_000 * WAD;
        y[3] = 300_000 * WAD;
        let p = redemption_price(&RedemptionInputs {
            clearing_price: 1_000_000,
            hurdle_rate_wad: 0,
            payout_multiple_k: 1,
            cap_per_unit: 10_000_000,
            paid_per_unit_wad: 0,
            year_gross_wad: &y,
            settlement_ts: 0,
            now: 4 * YEAR,
        })
        .unwrap();
        assert_eq!(p.d_avg, 200_000);
        assert_eq!(p.price, 1_000_000); // hurdle (h = 0) = P0 > k × D_avg
    }
}
