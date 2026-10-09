//! Curve mode (SPEC §9, `docs/meteora/CURVE_MODE.md`): the pure arithmetic of a series raised on a
//! Meteora Dynamic Bonding Curve — `P0` from the pool config, units outstanding from the
//! protocol-held balances, the migration-fee split, and the tender quota of a redemption.
//!
//! Accounting unit: the base lamport. The DBC program forbids 0-decimal base mints, so a curve
//! series' unit mint has `CURVE_BASE_DECIMALS = 6` and one whole unit (HEU) is `10^6` base lamports;
//! weights, `units_outstanding` and the per-unit WAD accumulators of the vault are per base lamport
//! (CURVE_MODE §4 option 1), while prices (`P0`, the cap, `P_redeem`) stay per whole unit. The
//! vault and redemption functions take the `unit_scale` (`10^6` here, 1 for sealed-bid series).

use crate::{mul_div, to_u64, MathError, MathResult};

/// Base-mint decimals of a curve-mode series (the generator and `activate_curve` require 6).
pub const CURVE_BASE_DECIMALS: u8 = 6;
/// Accounting units (base lamports) per whole unit of a curve-mode series.
pub const CURVE_UNIT_SCALE: u64 = 1_000_000;
/// Base lamports per whole unit for `decimals`.
pub fn unit_scale_for(decimals: u8) -> MathResult<u64> {
    10u64
        .checked_pow(u32::from(decimals))
        .ok_or(MathError::Overflow)
}

/// `P0 = floor(migration_quote_threshold × 10^token_decimal / swap_base_amount)`, quote base units
/// per whole unit, fixed from the `PoolConfig` alone (CURVE_MODE §3; rounding favours the issuer).
pub fn p0_per_unit(
    migration_quote_threshold: u64,
    swap_base_amount: u64,
    token_decimal: u8,
) -> MathResult<u64> {
    if swap_base_amount == 0 {
        return Err(MathError::DivisionByZero);
    }
    to_u64(mul_div(
        u128::from(migration_quote_threshold),
        u128::from(unit_scale_for(token_decimal)?),
        u128::from(swap_base_amount),
    )?)
}

/// Whether the config's `swap_base_amount` sells the series' `units_offered` whole units: the
/// generator makes `swap_base_amount = N_pub × 10^d` up to the program's rounding, so
/// `floor(swap_base_amount / 10^d)` is within one unit of `N_pub` (CURVE_MODE §2).
pub fn swap_base_matches_offer(
    swap_base_amount: u64,
    units_offered: u64,
    token_decimal: u8,
) -> MathResult<bool> {
    let whole = swap_base_amount
        .checked_div(unit_scale_for(token_decimal)?)
        .ok_or(MathError::DivisionByZero)?;
    Ok(whole.abs_diff(units_offered) <= 1)
}

/// `units_outstanding = supply − Σ protocol_held` (CURVE_MODE §4): the DAMM v2 pool's base vault,
/// the DBC base vault, the Jupiter-locker escrow of the issuer allocation and the leftover receiver.
pub fn units_outstanding(supply: u64, protocol_held: &[u64]) -> MathResult<u64> {
    let mut held: u64 = 0;
    for h in protocol_held {
        held = held.checked_add(*h).ok_or(MathError::Overflow)?;
    }
    supply.checked_sub(held).ok_or(MathError::InvalidInput)
}

/// The DBC migration fee and its split (PROG/state/config.rs:846-874):
/// `q_gross = ceil(X × (100 − f) / 100)`, `fee = X − q_gross`, `creator = floor(fee × c / 100)`,
/// `partner = fee − creator`. Returns `(partner, creator)`.
pub fn migration_fee_split(
    migration_quote_threshold: u64,
    fee_percentage: u8,
    creator_fee_percentage: u8,
) -> MathResult<(u64, u64)> {
    if fee_percentage > 100 || creator_fee_percentage > 100 {
        return Err(MathError::InvalidInput);
    }
    let x = u128::from(migration_quote_threshold);
    let keep = 100u128
        .checked_sub(u128::from(fee_percentage))
        .ok_or(MathError::Overflow)?;
    let num = x.checked_mul(keep).ok_or(MathError::Overflow)?;
    let q_gross = num
        .checked_add(99)
        .ok_or(MathError::Overflow)?
        .checked_div(100)
        .ok_or(MathError::DivisionByZero)?;
    let fee = to_u64(x.checked_sub(q_gross).ok_or(MathError::Overflow)?)?;
    let creator = to_u64(mul_div(
        u128::from(fee),
        u128::from(creator_fee_percentage),
        100,
    )?)?;
    let partner = fee.checked_sub(creator).ok_or(MathError::Overflow)?;
    Ok((partner, creator))
}

/// Tender quota of a redeemed curve-mode series: units staked at redemption are reserved for
/// their holders (staking is closed after redemption, so `staked_total` only falls), and units
/// tendered from wallets share the rest of the snapshot `units_at_redemption`. Invariant:
/// `tendered_total + staked_total ≤ units_at_redemption`, hence every tender is covered by the
/// deposit `P_redeem × units_at_redemption / unit_scale`.
pub fn wallet_tender_fits(
    units_at_redemption: u64,
    tendered_total: u64,
    staked_total: u64,
    amount: u64,
) -> MathResult<bool> {
    let used = tendered_total
        .checked_add(staked_total)
        .and_then(|v| v.checked_add(amount))
        .ok_or(MathError::Overflow)?;
    Ok(used <= units_at_redemption)
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn p0_of_the_worked_series() {
        // CURVE_MODE §3 / the LiteSVM fixture: X = 1,000 USDC over 100 units → 10 USDC
        assert_eq!(
            p0_per_unit(1_000_000_000, 100_000_000, 6).unwrap(),
            10_000_000
        );
        // research memo §4: X = 100,000 USDC over 10,000 units → 10 USDC
        assert_eq!(
            p0_per_unit(100_000_000_000, 10_000_000_000, 6).unwrap(),
            10_000_000
        );
        // rounds down (issuer-favourable)
        assert_eq!(
            p0_per_unit(1_000_000_000, 100_000_002, 6).unwrap(),
            9_999_999
        );
        assert_eq!(p0_per_unit(1, 0, 6), Err(MathError::DivisionByZero));
    }

    #[test]
    fn offer_matching_tolerates_program_rounding() {
        assert!(swap_base_matches_offer(100_000_000, 100, 6).unwrap());
        assert!(swap_base_matches_offer(99_999_998, 100, 6).unwrap());
        assert!(swap_base_matches_offer(101_000_000, 100, 6).unwrap());
        assert!(!swap_base_matches_offer(98_999_999, 100, 6).unwrap());
        assert!(!swap_base_matches_offer(102_000_000, 100, 6).unwrap());
    }

    #[test]
    fn migration_fee_split_matches_the_program() {
        // PROCEEDS_OPTIONS §4 table, X = 100,000 USDC
        let x = 100_000_000_000u64;
        assert_eq!(migration_fee_split(x, 0, 0).unwrap(), (0, 0));
        assert_eq!(
            migration_fee_split(x, 20, 100).unwrap(),
            (0, 20_000_000_000)
        );
        assert_eq!(migration_fee_split(x, 99, 0).unwrap(), (99_000_000_000, 0));
        assert_eq!(
            migration_fee_split(x, 99, 50).unwrap(),
            (49_500_000_000, 49_500_000_000)
        );
        // research memo §4.7, X = 750 USDC, f = 10, c = 50
        assert_eq!(
            migration_fee_split(750_000_000, 10, 50).unwrap(),
            (37_500_000, 37_500_000)
        );
        // the LiteSVM fixture: X = 1,000 USDC, f = 99, c = 0
        assert_eq!(
            migration_fee_split(1_000_000_000, 99, 0).unwrap(),
            (990_000_000, 0)
        );
    }

    #[test]
    fn outstanding_and_quota() {
        assert_eq!(
            units_outstanding(110, &[10, 0, 363, 0]),
            Err(MathError::InvalidInput)
        );
        assert_eq!(units_outstanding(1_000, &[10, 20, 30, 40]).unwrap(), 900);
        assert!(wallet_tender_fits(100, 30, 50, 20).unwrap());
        assert!(!wallet_tender_fits(100, 30, 50, 21).unwrap());
    }

    proptest! {
        /// `ceil` keeps the pool share whole: partner + creator + q_gross == X, creator ≤ fee.
        #[test]
        fn fee_split_conserves(x in 0u64..=u64::MAX / 128, f in 0u8..=99, c in 0u8..=100) {
            let (p, cr) = migration_fee_split(x, f, c).unwrap();
            let keep = (u128::from(x) * u128::from(100 - f)).div_ceil(100);
            prop_assert_eq!(u128::from(p) + u128::from(cr) + keep, u128::from(x));
            prop_assert!(u128::from(cr) * 100 <= u128::from(p + cr) * u128::from(c));
        }

        /// P0 × swap_base ≤ X × 10^d < (P0 + 1) × swap_base.
        #[test]
        fn p0_is_the_floor(x in 1u64..=1_000_000_000_000_000, sb in 1u64..=10_000_000_000_000) {
            let p0 = u128::from(p0_per_unit(x, sb, 6).unwrap());
            let lhs = u128::from(x) * 1_000_000;
            prop_assert!(p0 * u128::from(sb) <= lhs);
            prop_assert!((p0 + 1) * u128::from(sb) > lhs);
        }
    }
}
