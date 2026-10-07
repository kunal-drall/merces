//! Tier 1 split router arithmetic (SPEC §6.5, brief D5).

use crate::{mul_div, to_u64, MathError, MathResult, WAD};

/// Outcome of routing one receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteOutcome {
    /// Amount passed through to the issuer (`amount − share`).
    pub pass_through: u64,
    /// Gross amount routed to the vault (`share`).
    pub routed: u64,
    /// New `ytd_received`.
    pub ytd_received: u64,
}

/// ```text
/// below  = max(0, theta − ytd_received)
/// pass_a = min(amount, below)
/// above  = amount − pass_a
/// share  = min(floor(r_wad × units_outstanding × above / WAD), above)
/// ```
pub fn route(
    amount: u64,
    theta: u64,
    r_wad: u64,
    units_outstanding: u64,
    ytd_received: u64,
) -> MathResult<RouteOutcome> {
    let below = theta.saturating_sub(ytd_received);
    let pass_a = core::cmp::min(amount, below);
    let above = amount.checked_sub(pass_a).ok_or(MathError::Overflow)?;
    let r_units = u128::from(r_wad)
        .checked_mul(u128::from(units_outstanding))
        .ok_or(MathError::Overflow)?;
    let share = to_u64(mul_div(r_units, u128::from(above), WAD)?)?;
    let share = core::cmp::min(share, above);
    Ok(RouteOutcome {
        pass_through: amount.checked_sub(share).ok_or(MathError::Overflow)?,
        routed: share,
        ytd_received: ytd_received
            .checked_add(amount)
            .ok_or(MathError::Overflow)?,
    })
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const R: u64 = 1_000_000_000_000_000; // 0.1% per unit
    const UNITS: u64 = 100; // total share 10%

    #[test]
    fn below_threshold_passes_through() {
        let o = route(5_000, 10_000, R, UNITS, 0).unwrap();
        assert_eq!(
            o,
            RouteOutcome {
                pass_through: 5_000,
                routed: 0,
                ytd_received: 5_000
            }
        );
    }

    #[test]
    fn crossing_threshold_splits_the_excess() {
        // ytd 8_000, theta 10_000, amount 5_000 → above 3_000 → share 10% = 300
        let o = route(5_000, 10_000, R, UNITS, 8_000).unwrap();
        assert_eq!(
            o,
            RouteOutcome {
                pass_through: 4_700,
                routed: 300,
                ytd_received: 13_000
            }
        );
        let o2 = route(1_000, 10_000, R, UNITS, o.ytd_received).unwrap();
        assert_eq!(o2.routed, 100);
    }

    #[test]
    fn share_is_capped_at_the_excess() {
        // r × units = 150% → share capped at `above`
        let o = route(1_000, 0, 15 * WAD as u64 / 10, 1, 0).unwrap();
        assert_eq!(o.routed, 1_000);
        assert_eq!(o.pass_through, 0);
    }

    proptest! {
        #[test]
        fn conservation(amount in 0u64..1_000_000_000_000, theta in 0u64..1_000_000_000_000,
                        r in 0u64..=WAD as u64, units in 0u64..100_000, ytd in 0u64..1_000_000_000_000) {
            let o = route(amount, theta, r, units, ytd).unwrap();
            prop_assert_eq!(o.pass_through + o.routed, amount);
            prop_assert!(o.routed <= amount.saturating_sub(theta.saturating_sub(ytd)));
        }
    }
}
