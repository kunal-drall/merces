//! Redemption formula price (SPEC v1.1 §6.7, brief C7).

use crate::vault::wad_per_scaled_unit;
use crate::{div_ceil, mul_div, time::YEAR, to_u64, MathError, MathResult, WAD};

/// One slot of the tagged `year_gross` ring (SPEC §6.3): gross paid per unit (WAD) in settlement
/// year `year`. A slot whose tag does not match reads as 0.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct YearGross {
    pub year: u32,
    pub gross_wad: u128,
    pub set: bool,
}

/// Reads `year_gross[y]` from the ring (slot `y % len`, tag must match).
pub fn year_gross_at(ring: &[YearGross], year: u32) -> u128 {
    if ring.is_empty() {
        return 0;
    }
    let idx = (year as usize).checked_rem(ring.len()).unwrap_or(0);
    let slot = &ring[idx];
    if slot.set && slot.year == year {
        slot.gross_wad
    } else {
        0
    }
}

/// Adds `inc_wad` to `year_gross[year]`, re-tagging (zeroing) the slot when it holds another year.
pub fn year_gross_add(ring: &mut [YearGross], year: u32, inc_wad: u128) -> MathResult<()> {
    if ring.is_empty() {
        return Err(MathError::InvalidInput);
    }
    let idx = (year as usize).checked_rem(ring.len()).unwrap_or(0);
    let slot = &mut ring[idx];
    if !slot.set || slot.year != year {
        *slot = YearGross {
            year,
            gross_wad: 0,
            set: true,
        };
    }
    slot.gross_wad = slot
        .gross_wad
        .checked_add(inc_wad)
        .ok_or(MathError::Overflow)?;
    Ok(())
}

/// `settlement_year(ts) = floor((ts − settlement_ts) / YEAR)`.
pub fn settlement_year(settlement_ts: u64, ts: u64) -> MathResult<u32> {
    let elapsed = ts.checked_sub(settlement_ts).ok_or(MathError::Overflow)?;
    u32::try_from(elapsed / YEAR).map_err(|_| MathError::Overflow)
}

/// Inputs to `redeem`.
#[derive(Debug, Clone, Copy)]
pub struct RedemptionInputs<'a> {
    pub clearing_price: u64,
    pub hurdle_rate_wad: u64,
    pub payout_multiple_k: u16,
    pub cap_per_unit: u64,
    pub paid_per_unit_wad: u128,
    pub year_gross: &'a [YearGross],
    pub settlement_ts: u64,
    pub now: u64,
    /// Accounting units per whole unit (1 sealed bid, `10^decimals` curve mode): the
    /// accumulators are per accounting unit, the prices per whole unit.
    pub unit_scale: u64,
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
/// has elapsed); `C_rem` saturates at 0.
pub fn redemption_price(inp: &RedemptionInputs) -> MathResult<RedemptionPrice> {
    let t = inp
        .now
        .checked_sub(inp.settlement_ts)
        .ok_or(MathError::Overflow)?;
    let years = t.checked_div(YEAR).ok_or(MathError::DivisionByZero)?;
    let hurdle = hurdle_price(inp.clearing_price, inp.hurdle_rate_wad, t)?;
    // per-accounting-unit WAD accumulators → base units per whole unit (exact for scale 1)
    let per_unit_den = wad_per_scaled_unit(inp.unit_scale)?;
    let paid_units = to_u64(div_ceil(inp.paid_per_unit_wad, per_unit_den)?)?;
    let cap_remaining = inp.cap_per_unit.saturating_sub(paid_units);
    let (d_avg, floor_term) = if years >= 1 {
        let n = core::cmp::min(years, 3);
        let start = years.checked_sub(n).ok_or(MathError::Overflow)?;
        let mut sum: u128 = 0;
        for y in start..years {
            let year = u32::try_from(y).map_err(|_| MathError::Overflow)?;
            sum = sum
                .checked_add(year_gross_at(inp.year_gross, year))
                .ok_or(MathError::Overflow)?;
        }
        let den = u128::from(n)
            .checked_mul(per_unit_den)
            .ok_or(MathError::Overflow)?;
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

    fn ring(entries: &[(u32, u128)]) -> [YearGross; 4] {
        let mut r = [YearGross::default(); 4];
        for (y, g) in entries {
            year_gross_add(&mut r, *y, *g).unwrap();
        }
        r
    }

    #[test]
    fn hurdle_compounds_yearly_and_interpolates() {
        assert_eq!(hurdle_price(1_000_000, H8, 0).unwrap(), 1_000_000);
        assert_eq!(hurdle_price(1_000_000, H8, YEAR).unwrap(), 1_080_000);
        assert_eq!(hurdle_price(1_000_000, H8, 2 * YEAR).unwrap(), 1_166_400);
        assert_eq!(hurdle_price(1_000_000, H8, YEAR / 2).unwrap(), 1_040_000);
        assert_eq!(
            hurdle_price(1_000_000, H8, YEAR + YEAR / 2).unwrap(),
            1_123_200
        );
    }

    #[test]
    fn each_term_can_decide() {
        let empty = ring(&[]);
        let p = redemption_price(&RedemptionInputs {
            clearing_price: 1_000_000,
            hurdle_rate_wad: H8,
            payout_multiple_k: 5,
            cap_per_unit: 2_500_000,
            paid_per_unit_wad: 0,
            year_gross: &empty,
            settlement_ts: 0,
            unit_scale: 1,
            now: YEAR / 2,
        })
        .unwrap();
        assert_eq!(p.price, 1_040_000);
        assert_eq!(p.d_avg, 0);
        let y = ring(&[(0, 300_000 * WAD), (1, 300_000 * WAD)]);
        let p = redemption_price(&RedemptionInputs {
            clearing_price: 1_000_000,
            hurdle_rate_wad: H8,
            payout_multiple_k: 5,
            cap_per_unit: 2_500_000,
            paid_per_unit_wad: 600_000 * WAD,
            year_gross: &y,
            settlement_ts: 0,
            unit_scale: 1,
            now: 2 * YEAR,
        })
        .unwrap();
        assert_eq!(p.d_avg, 300_000);
        assert_eq!(p.hurdle, 1_166_400);
        assert_eq!(p.cap_remaining, 1_900_000);
        assert_eq!(p.price, 1_500_000);
        let p = redemption_price(&RedemptionInputs {
            clearing_price: 1_000_000,
            hurdle_rate_wad: H8,
            payout_multiple_k: 5,
            cap_per_unit: 2_500_000,
            paid_per_unit_wad: 2_000_000 * WAD,
            year_gross: &y,
            settlement_ts: 0,
            unit_scale: 1,
            now: 2 * YEAR,
        })
        .unwrap();
        assert_eq!(p.price, 500_000);
        // ceil rounding favours the issuer; a lowered cap saturates to 0
        let p = redemption_price(&RedemptionInputs {
            clearing_price: 1_000_000,
            hurdle_rate_wad: H8,
            payout_multiple_k: 5,
            cap_per_unit: 2_000_000,
            paid_per_unit_wad: 2_000_000 * WAD + 1,
            year_gross: &y,
            settlement_ts: 0,
            unit_scale: 1,
            now: 2 * YEAR,
        })
        .unwrap();
        assert_eq!(p.cap_remaining, 0);
        assert_eq!(p.price, 0);
    }

    #[test]
    fn ring_retags_and_trailing_window() {
        let mut r = ring(&[
            (0, 900_000 * WAD),
            (1, 100_000 * WAD),
            (2, 200_000 * WAD),
            (3, 300_000 * WAD),
        ]);
        // year 4 reuses slot 0 and must zero year 0
        year_gross_add(&mut r, 4, 5 * WAD).unwrap();
        assert_eq!(year_gross_at(&r, 0), 0);
        assert_eq!(year_gross_at(&r, 4), 5 * WAD);
        assert_eq!(year_gross_at(&r, 3), 300_000 * WAD);
        let p = redemption_price(&RedemptionInputs {
            clearing_price: 1_000_000,
            hurdle_rate_wad: 0,
            payout_multiple_k: 1,
            cap_per_unit: 10_000_000,
            paid_per_unit_wad: 0,
            year_gross: &r,
            settlement_ts: 0,
            unit_scale: 1,
            now: 4 * YEAR,
        })
        .unwrap();
        assert_eq!(p.d_avg, 200_000);
        assert_eq!(p.price, 1_000_000);
        assert_eq!(settlement_year(100, 100 + 3 * YEAR - 1).unwrap(), 2);
    }
}
