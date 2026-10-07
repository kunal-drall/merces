//! Transfer-window call-auction arithmetic (SPEC §7).

use crate::{bps_of, mul_div, to_u64, MathError, MathResult};

/// Tally of valid revealed orders against a proposed clearing price.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowTally {
    pub d_above: u64,
    pub d_at: u64,
    pub s_below: u64,
    pub s_at: u64,
    pub max_bid: u64,
    pub min_ask: u64,
    pub valid_orders: u32,
}

/// Result of a valid clearing proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowClearing {
    /// `S = s_below + s_at`, the matched volume.
    pub matched_units: u64,
    /// `R = S − d_above`, units for the bids at `p*`.
    pub remainder_for_bids_at: u64,
}

/// `finalize_window` validity: `S > 0`, `d_above < S`, `S ≤ D`, and (`s_at > 0` or `d_at > 0`).
pub fn check_window_clearing(t: &WindowTally) -> MathResult<Option<WindowClearing>> {
    let s = t.s_below.checked_add(t.s_at).ok_or(MathError::Overflow)?;
    let d = t.d_above.checked_add(t.d_at).ok_or(MathError::Overflow)?;
    if s == 0 || t.d_above >= s || s > d || (t.s_at == 0 && t.d_at == 0) {
        return Ok(None);
    }
    Ok(Some(WindowClearing {
        matched_units: s,
        remainder_for_bids_at: s.checked_sub(t.d_above).ok_or(MathError::Overflow)?,
    }))
}

/// `NO_MATCH` validity: no valid orders, or `max_bid < min_ask`.
pub fn no_match_is_valid(t: &WindowTally) -> bool {
    t.valid_orders == 0 || t.max_bid < t.min_ask
}

/// Bid fill: `price > p*` → quantity; `== p*` → `floor(R × quantity / d_at)`; `< p*` → 0.
pub fn bid_fill(
    price: u64,
    quantity: u64,
    clearing_price: u64,
    r: u64,
    d_at: u64,
) -> MathResult<u64> {
    if price > clearing_price {
        Ok(quantity)
    } else if price == clearing_price {
        if d_at == 0 {
            return Err(MathError::DivisionByZero);
        }
        to_u64(mul_div(
            u128::from(r),
            u128::from(quantity),
            u128::from(d_at),
        )?)
    } else {
        Ok(0)
    }
}

/// Ask fill: `price ≤ p*` → quantity (all supply at or below `p*` is sold); else 0.
pub fn ask_fill(price: u64, quantity: u64, clearing_price: u64) -> u64 {
    if price <= clearing_price {
        quantity
    } else {
        0
    }
}

/// Buyer money movement: `(cost, fee, refund)`.
pub fn settle_buyer(
    clearing_price: u64,
    fill: u64,
    escrow: u64,
    window_fee_bps: u16,
) -> MathResult<(u64, u64, u64)> {
    let cost = clearing_price
        .checked_mul(fill)
        .ok_or(MathError::Overflow)?;
    let fee = bps_of(cost, window_fee_bps)?;
    let spent = cost.checked_add(fee).ok_or(MathError::Overflow)?;
    let refund = escrow.checked_sub(spent).ok_or(MathError::Overflow)?;
    Ok((cost, fee, refund))
}

/// Bid reveal validity: `price ≥ 1`, `quantity ≥ 1`, escrow covers `p × q × (1 + fee)`, and
/// `quantity ≤ wallet_cap_units − balance`.
pub fn bid_is_valid(
    price: u64,
    quantity: u64,
    escrow: u64,
    window_fee_bps: u16,
    wallet_cap_units: u64,
    balance: u64,
) -> bool {
    if price == 0 || quantity == 0 {
        return false;
    }
    let room = wallet_cap_units.saturating_sub(balance);
    if quantity > room {
        return false;
    }
    match crate::auction::required_escrow(price, quantity, window_fee_bps) {
        Ok(required) => escrow >= required,
        Err(_) => false,
    }
}

/// Ask reveal validity: `price ≥ 1`, `quantity ≥ 1`, `quantity ≤ escrow_units`.
pub fn ask_is_valid(price: u64, quantity: u64, escrow_units: u64) -> bool {
    price >= 1 && quantity >= 1 && quantity <= escrow_units
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn clearing_conditions() {
        // asks: 10 @ 9, 5 @ 10 ; bids: 8 @ 11, 10 @ 10 → p* = 10: S = 15, D = 18, d_above = 8 < 15 ✓
        let t = WindowTally {
            d_above: 8,
            d_at: 10,
            s_below: 10,
            s_at: 5,
            max_bid: 11,
            min_ask: 9,
            valid_orders: 4,
        };
        assert_eq!(
            check_window_clearing(&t).unwrap(),
            Some(WindowClearing {
                matched_units: 15,
                remainder_for_bids_at: 7
            })
        );
        // p* = 9 → S = 10, D = 18, d_above = 18 ≥ S ✗
        let t9 = WindowTally {
            d_above: 18,
            d_at: 0,
            s_below: 0,
            s_at: 10,
            max_bid: 11,
            min_ask: 9,
            valid_orders: 4,
        };
        assert_eq!(check_window_clearing(&t9).unwrap(), None);
        // p* = 11 → S = 15, D = 8 < S ✗
        let t11 = WindowTally {
            d_above: 0,
            d_at: 8,
            s_below: 15,
            s_at: 0,
            max_bid: 11,
            min_ask: 9,
            valid_orders: 4,
        };
        assert_eq!(check_window_clearing(&t11).unwrap(), None);
        assert!(!no_match_is_valid(&t));
        let nm = WindowTally {
            max_bid: 8,
            min_ask: 9,
            valid_orders: 2,
            ..Default::default()
        };
        assert!(no_match_is_valid(&nm));
        assert!(no_match_is_valid(&WindowTally::default()));
    }

    #[test]
    fn fills() {
        assert_eq!(bid_fill(11, 8, 10, 7, 10).unwrap(), 8);
        assert_eq!(bid_fill(10, 10, 10, 7, 10).unwrap(), 7);
        assert_eq!(bid_fill(9, 10, 10, 7, 10).unwrap(), 0);
        assert_eq!(ask_fill(9, 10, 10), 10);
        assert_eq!(ask_fill(10, 5, 10), 5);
        assert_eq!(ask_fill(11, 5, 10), 0);
        assert_eq!(settle_buyer(10, 7, 1_000, 100).unwrap(), (70, 0, 930));
        assert_eq!(
            settle_buyer(1_000_000, 7, 7_070_000, 100).unwrap(),
            (7_000_000, 70_000, 0)
        );
    }

    #[test]
    fn validity() {
        assert!(bid_is_valid(10, 5, 51, 100, 10, 5));
        assert!(!bid_is_valid(10, 6, 61, 100, 10, 5)); // cap room is 5
        assert!(!bid_is_valid(1_000, 5, 5_049, 100, 10, 0)); // escrow short by the fee
        assert!(bid_is_valid(1_000, 5, 5_050, 100, 10, 0));
        assert!(!bid_is_valid(0, 5, 100, 100, 10, 0));
        assert!(ask_is_valid(1, 1, 1));
        assert!(!ask_is_valid(1, 2, 1));
        assert!(!ask_is_valid(0, 1, 1));
    }

    proptest! {
        #[test]
        fn bid_fills_never_exceed_supply(
            r in 0u64..100_000, qs in proptest::collection::vec(1u64..1_000, 1..40), d_above in 0u64..100_000
        ) {
            let d_at: u64 = qs.iter().sum();
            let r = core::cmp::min(r, d_at);
            let fills: u64 = qs.iter().map(|q| bid_fill(5, *q, 5, r, d_at).unwrap()).sum();
            prop_assert!(fills <= r);
            prop_assert!(fills + d_above <= r + d_above);
            prop_assert!(r - fills < qs.len() as u64); // dust returned to marginal asks
        }
    }
}
