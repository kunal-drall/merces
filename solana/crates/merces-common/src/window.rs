//! Transfer-window call-auction arithmetic (SPEC v1.1 §7): two-branch clearing and first-come
//! fills at the margin.

use crate::{bps_of, MathError, MathResult};

pub const SIDE_BID: u8 = 0;
pub const SIDE_ASK: u8 = 1;

/// Which side limits the match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Branch {
    SupplyLimited = 0,
    DemandLimited = 1,
}

/// Tally of valid revealed orders against a proposed clearing price.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowTally {
    pub d_above: u64,
    pub d_at: u64,
    pub s_below: u64,
    pub s_at: u64,
    pub max_bid: u64,
    pub min_ask: u64,
    pub valid_count: u32,
}

/// Result of a valid clearing proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowClearing {
    pub branch: Branch,
    pub matched_units: u64,
    /// Units for the marginal side at `p*` (`S − d_above` or `D − s_below`).
    pub marginal_remaining: u64,
}

/// Why a window proposal was rejected (`WindowSettlementRejected.reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum WindowReject {
    NoMatchInvalid = 1,
    PriceNotRevealed = 2,
    NoCrossing = 3,
}

/// `finalize_window` validity (SPEC §7): `p*` must be a revealed valid price and exactly one of
/// (A) supply-limited `S > 0 && d_above < S && S ≤ D`, (B) demand-limited `D > 0 && s_below ≤ D && D < S`.
pub fn check_window_clearing(t: &WindowTally) -> MathResult<Result<WindowClearing, WindowReject>> {
    let s = t.s_below.checked_add(t.s_at).ok_or(MathError::Overflow)?;
    let d = t.d_above.checked_add(t.d_at).ok_or(MathError::Overflow)?;
    if t.d_at == 0 && t.s_at == 0 {
        return Ok(Err(WindowReject::PriceNotRevealed));
    }
    let a = s > 0 && t.d_above < s && s <= d;
    let b = d > 0 && t.s_below <= d && d < s;
    if a {
        Ok(Ok(WindowClearing {
            branch: Branch::SupplyLimited,
            matched_units: s,
            marginal_remaining: s.checked_sub(t.d_above).ok_or(MathError::Overflow)?,
        }))
    } else if b {
        Ok(Ok(WindowClearing {
            branch: Branch::DemandLimited,
            matched_units: d,
            marginal_remaining: d.checked_sub(t.s_below).ok_or(MathError::Overflow)?,
        }))
    } else {
        Ok(Err(WindowReject::NoCrossing))
    }
}

/// `NO_MATCH` validity: no valid orders, or `max_bid < min_ask`.
pub fn no_match_is_valid(t: &WindowTally) -> bool {
    t.valid_count == 0 || t.max_bid < t.min_ask
}

/// Fill class of a valid revealed order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillClass {
    Full,
    Losing,
    Marginal,
}

/// Classifies an order under the clearing branch (SPEC §7 `process_order`).
pub fn classify(side: u8, price: u64, clearing_price: u64, branch: Branch) -> FillClass {
    match (branch, side) {
        (Branch::SupplyLimited, SIDE_BID) => {
            if price > clearing_price {
                FillClass::Full
            } else if price == clearing_price {
                FillClass::Marginal
            } else {
                FillClass::Losing
            }
        }
        (Branch::SupplyLimited, _) => {
            if price <= clearing_price {
                FillClass::Full
            } else {
                FillClass::Losing
            }
        }
        (Branch::DemandLimited, SIDE_BID) => {
            if price >= clearing_price {
                FillClass::Full
            } else {
                FillClass::Losing
            }
        }
        (Branch::DemandLimited, _) => {
            if price < clearing_price {
                FillClass::Full
            } else if price == clearing_price {
                FillClass::Marginal
            } else {
                FillClass::Losing
            }
        }
    }
}

/// Buyer money movement: `(cost, fee, refund)`.
pub fn settle_buyer(clearing_price: u64, fill: u64, escrow: u64, window_fee_bps: u16) -> MathResult<(u64, u64, u64)> {
    let cost = clearing_price.checked_mul(fill).ok_or(MathError::Overflow)?;
    let fee = bps_of(cost, window_fee_bps)?;
    let spent = cost.checked_add(fee).ok_or(MathError::Overflow)?;
    let refund = escrow.checked_sub(spent).ok_or(MathError::Overflow)?;
    Ok((cost, fee, refund))
}

/// Bid reveal validity: `price ≥ 1`, `quantity ≥ 1`, escrow covers `p × q × (1 + fee)`, and
/// `balance + quantity ≤ wallet_cap_units`.
pub fn bid_is_valid(price: u64, quantity: u64, escrow: u64, window_fee_bps: u16, wallet_cap_units: u64, balance: u64) -> bool {
    if price == 0 || quantity == 0 {
        return false;
    }
    match balance.checked_add(quantity) {
        Some(after) if after <= wallet_cap_units => {}
        _ => return false,
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
    fn supply_limited() {
        // asks: 10 @ 9, 5 @ 10 ; bids: 8 @ 11, 10 @ 10 → p* = 10: S = 15, D = 18, d_above = 8 < 15 ≤ 18
        let t = WindowTally { d_above: 8, d_at: 10, s_below: 10, s_at: 5, max_bid: 11, min_ask: 9, valid_count: 4 };
        assert_eq!(
            check_window_clearing(&t).unwrap(),
            Ok(WindowClearing { branch: Branch::SupplyLimited, matched_units: 15, marginal_remaining: 7 })
        );
        assert_eq!(classify(SIDE_BID, 11, 10, Branch::SupplyLimited), FillClass::Full);
        assert_eq!(classify(SIDE_BID, 10, 10, Branch::SupplyLimited), FillClass::Marginal);
        assert_eq!(classify(SIDE_BID, 9, 10, Branch::SupplyLimited), FillClass::Losing);
        assert_eq!(classify(SIDE_ASK, 10, 10, Branch::SupplyLimited), FillClass::Full);
        assert_eq!(classify(SIDE_ASK, 11, 10, Branch::SupplyLimited), FillClass::Losing);
    }

    #[test]
    fn demand_limited() {
        // asks 8 × 5 (at 5), bid 10 × 1 → p* = 5: D = 1, S = 8, s_below = 0 ≤ 1 < 8
        let t = WindowTally { d_above: 1, d_at: 0, s_below: 0, s_at: 8, max_bid: 10, min_ask: 5, valid_count: 2 };
        assert_eq!(
            check_window_clearing(&t).unwrap(),
            Ok(WindowClearing { branch: Branch::DemandLimited, matched_units: 1, marginal_remaining: 1 })
        );
        assert_eq!(classify(SIDE_ASK, 5, 5, Branch::DemandLimited), FillClass::Marginal);
        assert_eq!(classify(SIDE_ASK, 4, 5, Branch::DemandLimited), FillClass::Full);
        assert_eq!(classify(SIDE_BID, 5, 5, Branch::DemandLimited), FillClass::Full);
        assert_eq!(classify(SIDE_BID, 4, 5, Branch::DemandLimited), FillClass::Losing);
    }

    #[test]
    fn rejections() {
        let nm = WindowTally { max_bid: 8, min_ask: 9, valid_count: 2, ..Default::default() };
        assert!(no_match_is_valid(&nm));
        assert!(no_match_is_valid(&WindowTally::default()));
        let crossing = WindowTally { d_above: 8, d_at: 10, s_below: 10, s_at: 5, max_bid: 11, min_ask: 9, valid_count: 4 };
        assert!(!no_match_is_valid(&crossing));
        // price not revealed
        let t = WindowTally { d_above: 5, d_at: 0, s_below: 5, s_at: 0, max_bid: 9, min_ask: 1, valid_count: 2 };
        assert_eq!(check_window_clearing(&t).unwrap(), Err(WindowReject::PriceNotRevealed));
        // no crossing: d_above == S with nothing marginal at p* on the demand side and D > S... S=5,D=5,d_above=5 → A fails (d_above<S), B fails (D<S)
        let t = WindowTally { d_above: 5, d_at: 0, s_below: 0, s_at: 5, max_bid: 9, min_ask: 5, valid_count: 2 };
        assert_eq!(check_window_clearing(&t).unwrap(), Err(WindowReject::NoCrossing));
    }

    #[test]
    fn validity_and_buyer() {
        assert!(bid_is_valid(10, 5, 51, 100, 10, 5));
        assert!(!bid_is_valid(10, 6, 61, 100, 10, 5));
        assert!(!bid_is_valid(1_000, 5, 5_049, 100, 10, 0));
        assert!(bid_is_valid(1_000, 5, 5_050, 100, 10, 0));
        assert!(!bid_is_valid(0, 5, 100, 100, 10, 0));
        assert!(ask_is_valid(1, 1, 1));
        assert!(!ask_is_valid(1, 2, 1));
        assert_eq!(settle_buyer(1_000_000, 7, 7_070_000, 100).unwrap(), (7_000_000, 70_000, 0));
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(3000))]
        #[test]
        fn exactly_one_branch_or_none(d_above in 0u64..50, d_at in 0u64..50, s_below in 0u64..50, s_at in 0u64..50) {
            let t = WindowTally { d_above, d_at, s_below, s_at, max_bid: 1, min_ask: 1, valid_count: 1 };
            let s = s_below + s_at; let d = d_above + d_at;
            let a = s > 0 && d_above < s && s <= d;
            let b = d > 0 && s_below <= d && d < s;
            prop_assert!(!(a && b));
            match check_window_clearing(&t).unwrap() {
                Ok(c) => {
                    prop_assert!(d_at > 0 || s_at > 0);
                    if c.branch == Branch::SupplyLimited { prop_assert!(a); prop_assert_eq!(c.matched_units, s); }
                    else { prop_assert!(b); prop_assert_eq!(c.matched_units, d); }
                    prop_assert!(c.marginal_remaining <= c.matched_units);
                }
                Err(_) => prop_assert!(!(a || b) || (d_at == 0 && s_at == 0)),
            }
        }
    }
}
