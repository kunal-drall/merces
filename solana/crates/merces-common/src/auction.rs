//! Sealed-bid uniform-price auction arithmetic (SPEC §5.2).

use crate::{bps_of, mul_div, to_u64, MathError, MathResult, BPS_DENOMINATOR};

/// `floor(units_offered × wallet_cap_bps / 10000)` — the per-wallet quantity cap applied at reveal.
pub fn wallet_cap_units(units: u64, wallet_cap_bps: u16) -> MathResult<u64> {
    bps_of(units, wallet_cap_bps)
}

/// `price × quantity + floor(price × quantity × auction_fee_bps / 10000)`; `None` when the
/// product does not fit `u64` (such a bid can never be collateralised and is invalid).
pub fn required_escrow(price: u64, quantity: u64, auction_fee_bps: u16) -> MathResult<u64> {
    let cost = price.checked_mul(quantity).ok_or(MathError::Overflow)?;
    let fee = bps_of(cost, auction_fee_bps)?;
    cost.checked_add(fee).ok_or(MathError::Overflow)
}

/// Reveal validity (SPEC §5.2 `reveal_bid`).
pub fn bid_is_valid(
    price: u64,
    quantity: u64,
    escrow: u64,
    reserve_price: u64,
    wallet_cap_units_at_auction: u64,
    auction_fee_bps: u16,
) -> bool {
    if price < reserve_price || quantity == 0 || quantity > wallet_cap_units_at_auction {
        return false;
    }
    match required_escrow(price, quantity, auction_fee_bps) {
        Ok(required) => escrow >= required,
        Err(_) => false,
    }
}

/// Result of `finalize_settlement`'s validity check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clearing {
    /// Units allotted to the marginal bids (`R = min(N − q_above, q_at)`).
    pub remainder_at_margin: u64,
    /// `q_above + R`.
    pub units_sold_upper: u64,
    /// `p* × units_sold_upper`.
    pub proceeds_upper: u64,
}

/// Validates a proposed clearing price against the tally and computes the margin remainder.
/// Returns `Ok(None)` when the proposal is not the uniform clearing price (`InvalidClearingPrice`).
///
/// Conditions (SPEC §5.2): `q_at > 0`, `q_above < N`, and either `D ≥ N` or `min_valid_price == p*`.
pub fn check_clearing(
    units_offered: u64,
    clearing_price: u64,
    q_above: u64,
    q_at: u64,
    min_valid_price: u64,
) -> MathResult<Option<Clearing>> {
    let n = units_offered;
    if q_at == 0 || q_above >= n {
        return Ok(None);
    }
    let demand = q_above.checked_add(q_at).ok_or(MathError::Overflow)?;
    if demand < n && min_valid_price != clearing_price {
        return Ok(None);
    }
    let room = n.checked_sub(q_above).ok_or(MathError::Overflow)?;
    let r = core::cmp::min(room, q_at);
    let units_sold_upper = q_above.checked_add(r).ok_or(MathError::Overflow)?;
    let proceeds_upper = clearing_price
        .checked_mul(units_sold_upper)
        .ok_or(MathError::Overflow)?;
    Ok(Some(Clearing {
        remainder_at_margin: r,
        units_sold_upper,
        proceeds_upper,
    }))
}

/// Allocation for one revealed, valid bid after settlement.
pub fn allocation(
    price: u64,
    quantity: u64,
    clearing_price: u64,
    remainder_at_margin: u64,
    q_at: u64,
) -> MathResult<u64> {
    if price > clearing_price {
        Ok(quantity)
    } else if price == clearing_price {
        if q_at == 0 {
            return Err(MathError::DivisionByZero);
        }
        to_u64(mul_div(
            u128::from(remainder_at_margin),
            u128::from(quantity),
            u128::from(q_at),
        )?)
    } else {
        Ok(0)
    }
}

/// Money movement for a winning allocation: `(cost, fee, refund)`.
pub fn settle_winner(
    clearing_price: u64,
    alloc: u64,
    escrow: u64,
    auction_fee_bps: u16,
) -> MathResult<(u64, u64, u64)> {
    let cost = clearing_price
        .checked_mul(alloc)
        .ok_or(MathError::Overflow)?;
    let fee = bps_of(cost, auction_fee_bps)?;
    let spent = cost.checked_add(fee).ok_or(MathError::Overflow)?;
    let refund = escrow.checked_sub(spent).ok_or(MathError::Overflow)?;
    Ok((cost, fee, refund))
}

/// Non-reveal charge: `floor(escrow × non_reveal_charge_bps / 10000)`; refund is the rest.
pub fn non_reveal_split(escrow: u64, charge_bps: u16) -> MathResult<(u64, u64)> {
    if u64::from(charge_bps) > BPS_DENOMINATOR {
        return Err(MathError::InvalidInput);
    }
    let charge = bps_of(escrow, charge_bps)?;
    let refund = escrow.checked_sub(charge).ok_or(MathError::Overflow)?;
    Ok((charge, refund))
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn escrow_and_validity() {
        assert_eq!(required_escrow(1_000_000, 100, 100).unwrap(), 101_000_000);
        assert_eq!(required_escrow(999, 1, 100).unwrap(), 999 + 9);
        assert!(bid_is_valid(
            1_000_000,
            100,
            101_000_000,
            1_000_000,
            100,
            100
        ));
        assert!(!bid_is_valid(
            1_000_000,
            100,
            100_999_999,
            1_000_000,
            100,
            100
        ));
        assert!(!bid_is_valid(999_999, 1, 1_010_000, 1_000_000, 100, 100)); // below reserve
        assert!(!bid_is_valid(1_000_000, 101, u64::MAX, 1_000_000, 100, 100)); // above cap
        assert!(!bid_is_valid(1_000_000, 0, u64::MAX, 1_000_000, 100, 100)); // zero qty
        assert!(!bid_is_valid(u64::MAX, 2, u64::MAX, 1, u64::MAX, 100)); // overflow
    }

    #[test]
    fn clearing_rules() {
        // 10 @ 5, 10 @ 4, N = 15 → p* = 4 valid, 5 invalid, 3 invalid
        assert_eq!(
            check_clearing(15, 4, 10, 10, 4).unwrap(),
            Some(Clearing {
                remainder_at_margin: 5,
                units_sold_upper: 15,
                proceeds_upper: 60
            })
        );
        assert_eq!(check_clearing(15, 5, 0, 10, 4).unwrap(), None);
        assert_eq!(check_clearing(15, 3, 20, 0, 4).unwrap(), None);
        // undersubscribed: 10 @ 5, 2 @ 4, N = 15 → p* = 4 (lowest valid) valid
        assert_eq!(
            check_clearing(15, 4, 10, 2, 4).unwrap(),
            Some(Clearing {
                remainder_at_margin: 2,
                units_sold_upper: 12,
                proceeds_upper: 48
            })
        );
        assert_eq!(check_clearing(15, 5, 0, 10, 4).unwrap(), None);
    }

    #[test]
    fn allocations_and_settlement() {
        assert_eq!(allocation(5, 10, 4, 5, 10).unwrap(), 10);
        assert_eq!(allocation(4, 10, 4, 5, 10).unwrap(), 5);
        assert_eq!(allocation(4, 3, 4, 5, 10).unwrap(), 1); // floor(5*3/10)
        assert_eq!(allocation(3, 10, 4, 5, 10).unwrap(), 0);
        assert_eq!(settle_winner(4, 5, 100, 100).unwrap(), (20, 0, 80));
        assert_eq!(
            settle_winner(1_000_000, 100, 101_000_000, 100).unwrap(),
            (100_000_000, 1_000_000, 0)
        );
        assert_eq!(
            non_reveal_split(101_000_000, 100).unwrap(),
            (1_010_000, 99_990_000)
        );
    }

    proptest! {
        #[test]
        fn marginal_allocations_never_exceed_remainder(
            r in 0u64..1_000_000, qs in proptest::collection::vec(1u64..10_000, 1..50)
        ) {
            let q_at: u64 = qs.iter().sum();
            let r = core::cmp::min(r, q_at);
            let total: u64 = qs.iter().map(|q| allocation(7, *q, 7, r, q_at).unwrap()).sum();
            prop_assert!(total <= r);
            // dust is bounded by the number of marginal bids − 1
            prop_assert!(r - total < qs.len() as u64);
        }

        #[test]
        fn winner_refund_is_consistent(
            p in 1u64..1_000_000_000, q in 1u64..10_000, fee_bps in 0u16..=1000, extra in 0u64..1_000_000
        ) {
            let escrow = required_escrow(p, q, fee_bps).unwrap() + extra;
            let (cost, fee, refund) = settle_winner(p, q, escrow, fee_bps).unwrap();
            prop_assert_eq!(cost + fee + refund, escrow);
            prop_assert_eq!(refund, extra);
        }
    }
}
