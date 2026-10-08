//! Sealed-bid uniform-price auction arithmetic (SPEC v1.1 §5.2): claim-based one-pass settlement.

use crate::{bps_of, mul_div, to_u64, MathError, MathResult, BPS_DENOMINATOR};

/// `floor(units × wallet_cap_bps / 10000)` — the per-wallet quantity cap applied at reveal.
pub fn wallet_cap_units(units: u64, wallet_cap_bps: u16) -> MathResult<u64> {
    bps_of(units, wallet_cap_bps)
}

/// `price × quantity + floor(price × quantity × auction_fee_bps / 10000)`.
pub fn required_escrow(price: u64, quantity: u64, auction_fee_bps: u16) -> MathResult<u64> {
    let cost = price.checked_mul(quantity).ok_or(MathError::Overflow)?;
    let fee = bps_of(cost, auction_fee_bps)?;
    cost.checked_add(fee).ok_or(MathError::Overflow)
}

/// Reveal validity (SPEC §5.2 `reveal_bid`); never errors — an unrepresentable bid is invalid.
pub fn bid_is_valid(price: u64, quantity: u64, escrow: u64, reserve_price: u64, wallet_cap_units_at_auction: u64, auction_fee_bps: u16) -> bool {
    if price < reserve_price || quantity == 0 || quantity > wallet_cap_units_at_auction {
        return false;
    }
    match required_escrow(price, quantity, auction_fee_bps) {
        Ok(required) => escrow >= required,
        Err(_) => false,
    }
}

/// `r_claim = min(units_offered − q_above_claim, q_at_claim)` (saturating).
pub fn r_claim(units_offered: u64, q_above_claim: u64, q_at_claim: u64) -> u64 {
    core::cmp::min(units_offered.saturating_sub(q_above_claim), q_at_claim)
}

/// Marginal allocation `floor(r_claim × quantity / q_at_claim)`; 0 when `q_at_claim == 0`.
pub fn marginal_alloc(r_claim: u64, quantity: u64, q_at_claim: u64) -> MathResult<u64> {
    if q_at_claim == 0 {
        return Ok(0);
    }
    to_u64(mul_div(u128::from(r_claim), u128::from(quantity), u128::from(q_at_claim))?)
}

/// Why a proposal was rejected (`SettlementRejected.reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RejectReason {
    ClaimMismatch = 1,
    InvalidClearingPrice = 2,
}

/// `finalize_settlement` steps 2–3 (SPEC §5.2): the proposer's claims must match the tally and the
/// price must be the unique uniform clearing price.
pub fn check_proposal(units_offered: u64, clearing_price: u64, q_above_claim: u64, q_at_claim: u64, q_above: u64, q_at: u64, min_valid_price: u64) -> MathResult<Result<(), RejectReason>> {
    if q_above != q_above_claim || q_at != q_at_claim {
        return Ok(Err(RejectReason::ClaimMismatch));
    }
    let n = units_offered;
    let demand = q_above.checked_add(q_at).ok_or(MathError::Overflow)?;
    let oversubscribed = q_at > 0 && q_above < n && demand >= n;
    let undersubscribed = demand < n && min_valid_price == clearing_price;
    if oversubscribed || undersubscribed {
        Ok(Ok(()))
    } else {
        Ok(Err(RejectReason::InvalidClearingPrice))
    }
}

/// Allocation for one revealed valid bid after settlement.
pub fn allocation(price: u64, quantity: u64, clearing_price: u64, r_claim: u64, q_at_claim: u64) -> MathResult<u64> {
    if price > clearing_price {
        Ok(quantity)
    } else if price == clearing_price {
        marginal_alloc(r_claim, quantity, q_at_claim)
    } else {
        Ok(0)
    }
}

/// Money movement for a winning allocation: `(cost, fee, refund)`.
pub fn settle_winner(clearing_price: u64, alloc: u64, escrow: u64, auction_fee_bps: u16) -> MathResult<(u64, u64, u64)> {
    let cost = clearing_price.checked_mul(alloc).ok_or(MathError::Overflow)?;
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
        assert!(bid_is_valid(1_000_000, 100, 101_000_000, 1_000_000, 100, 100));
        assert!(!bid_is_valid(1_000_000, 100, 100_999_999, 1_000_000, 100, 100));
        assert!(!bid_is_valid(999_999, 1, 1_010_000, 1_000_000, 100, 100));
        assert!(!bid_is_valid(1_000_000, 101, u64::MAX, 1_000_000, 100, 100));
        assert!(!bid_is_valid(1_000_000, 0, u64::MAX, 1_000_000, 100, 100));
        assert!(!bid_is_valid(u64::MAX, 2, u64::MAX, 1, u64::MAX, 100));
    }

    #[test]
    fn proposal_rules() {
        // 10 @ 5, 10 @ 4, N = 15
        assert_eq!(check_proposal(15, 4, 10, 10, 10, 10, 4).unwrap(), Ok(()));
        assert_eq!(check_proposal(15, 5, 0, 10, 0, 10, 4).unwrap(), Err(RejectReason::InvalidClearingPrice));
        assert_eq!(check_proposal(15, 3, 20, 0, 20, 0, 4).unwrap(), Err(RejectReason::InvalidClearingPrice));
        assert_eq!(check_proposal(15, 4, 9, 10, 10, 10, 4).unwrap(), Err(RejectReason::ClaimMismatch));
        // undersubscribed: 10 @ 5, 2 @ 4 → p* = 4
        assert_eq!(check_proposal(15, 4, 10, 2, 10, 2, 4).unwrap(), Ok(()));
        assert_eq!(r_claim(15, 10, 2), 2);
        assert_eq!(r_claim(15, 20, 2), 0);
    }

    #[test]
    fn allocations_and_settlement() {
        assert_eq!(allocation(5, 10, 4, 5, 10).unwrap(), 10);
        assert_eq!(allocation(4, 10, 4, 5, 10).unwrap(), 5);
        assert_eq!(allocation(4, 3, 4, 5, 10).unwrap(), 1);
        assert_eq!(allocation(3, 10, 4, 5, 10).unwrap(), 0);
        assert_eq!(marginal_alloc(5, 3, 0).unwrap(), 0);
        assert_eq!(settle_winner(4, 5, 100, 100).unwrap(), (20, 0, 80));
        assert_eq!(settle_winner(1_000_000, 100, 101_000_000, 100).unwrap(), (100_000_000, 1_000_000, 0));
        assert_eq!(non_reveal_split(101_000_000, 100).unwrap(), (1_010_000, 99_990_000));
    }

    proptest! {
        #[test]
        fn marginal_sum_bounded(r in 0u64..1_000_000, qs in proptest::collection::vec(1u64..10_000, 1..50)) {
            let q_at: u64 = qs.iter().sum();
            let r = core::cmp::min(r, q_at);
            let total: u64 = qs.iter().map(|q| marginal_alloc(r, *q, q_at).unwrap()).sum();
            prop_assert!(total <= r);
            prop_assert!(r - total < qs.len() as u64);
        }

        #[test]
        fn winner_refund_consistent(p in 1u64..1_000_000_000, q in 1u64..10_000, fee_bps in 0u16..=1000, extra in 0u64..1_000_000) {
            let escrow = required_escrow(p, q, fee_bps).unwrap() + extra;
            let (cost, fee, refund) = settle_winner(p, q, escrow, fee_bps).unwrap();
            prop_assert_eq!(cost + fee + refund, escrow);
            prop_assert_eq!(refund, extra);
        }
    }
}
