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
    /// Valid revealed bids (a side with no valid order counts as "no crossing" for `NO_MATCH`).
    pub valid_bids: u32,
    /// Valid revealed asks.
    pub valid_asks: u32,
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

/// `NO_MATCH` validity: no valid orders, one side without a valid order, or `max_bid < min_ask`
/// (reference `isNoMatchValid`: an empty side is "no crossing" whatever the other side's prices).
pub fn no_match_is_valid(t: &WindowTally) -> bool {
    t.valid_count == 0 || t.valid_bids == 0 || t.valid_asks == 0 || t.max_bid < t.min_ask
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
/// `balance + quantity ≤ wallet_cap_units`.
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

// ------------------------------------------------------------------------------------ take-back
//
// SPEC §7: a filled bid whose buyer is not allowlisted at fill is cancelled (full refund) and the
// units it would have bought are "taken back from the sell side before asks are settled: from asks
// at p* in descending reveal index first, then from asks below p*" (reference `computeFills`: asks
// below p* in descending price, then descending reveal index). Asks are settled one at a time in
// ascending reveal index on Solana, so the take-back is decomposed exactly:
//
// * at-p* group: its class fills are a first-come prefix in ascending reveal index (branch B) or
//   every order in full (branch A); cutting `cancelled` units from the highest reveal indices of a
//   prefix leaves the first-come prefix of the smaller budget `G_at − cancelled` — computable in
//   ascending order with a running total;
// * below-p* group: every order fills in full; the remaining `R = cancelled − G_at` units come off
//   the orders with the largest keys `(price, reveal_index)`. The cut is a prefix of the key order
//   ending at a single threshold order `k` with `Σ_{key > k} q < R ≤ Σ_{key ≥ k} q`; a keeper
//   proposes `k`, a paged tally verifies the inequality, and each order's cut follows from its key.

/// Class fill of the at-`p*` ask group before any cancellation: (A) `s_at` (every ask at `p*`
/// fills in full), (B) `matched − s_below` (= `D − s_below`, the marginal budget).
pub fn ask_at_total(
    branch: Branch,
    s_at: u64,
    s_below: u64,
    matched_units: u64,
) -> MathResult<u64> {
    match branch {
        Branch::SupplyLimited => Ok(s_at),
        Branch::DemandLimited => matched_units
            .checked_sub(s_below)
            .ok_or(MathError::Overflow),
    }
}

/// Budget left for the at-`p*` asks after `cancelled` buyer units were taken back from them.
pub fn ask_at_budget(at_total: u64, cancelled: u64) -> u64 {
    at_total.saturating_sub(cancelled)
}

/// Units the asks below `p*` give back (`max(0, cancelled − G_at)`).
pub fn below_takeback(at_total: u64, cancelled: u64) -> u64 {
    cancelled.saturating_sub(at_total)
}

/// Take-back order: `a` is cut before `b` when its key `(price, reveal_index)` is larger.
pub fn taken_before(price_a: u64, index_a: u32, price_b: u64, index_b: u32) -> bool {
    (price_a, index_a) > (price_b, index_b)
}

/// A proposed threshold order `k` is the right one iff it exists among the valid asks below `p*`
/// and `Σ_{key > k} q < R ≤ Σ_{key > k} q + q_k`.
pub fn takeback_threshold_valid(
    r_below: u64,
    above_sum: u64,
    found: bool,
    k_quantity: u64,
) -> MathResult<bool> {
    let upto = above_sum
        .checked_add(k_quantity)
        .ok_or(MathError::Overflow)?;
    Ok(found && above_sum < r_below && r_below <= upto)
}

/// Units cut from one valid ask below `p*` once threshold `k` is accepted: the whole order when
/// its key is above `k`, `partial = R − Σ_{key > k} q` for `k` itself, nothing below.
pub fn below_cut(
    price: u64,
    index: u32,
    quantity: u64,
    k_price: u64,
    k_index: u32,
    partial: u64,
) -> u64 {
    if taken_before(price, index, k_price, k_index) {
        quantity
    } else if price == k_price && index == k_index {
        core::cmp::min(partial, quantity)
    } else {
        0
    }
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    extern crate std;
    use std::vec::Vec;

    fn tally(
        d_above: u64,
        d_at: u64,
        s_below: u64,
        s_at: u64,
        max_bid: u64,
        min_ask: u64,
    ) -> WindowTally {
        WindowTally {
            d_above,
            d_at,
            s_below,
            s_at,
            max_bid,
            min_ask,
            valid_count: 4,
            valid_bids: 2,
            valid_asks: 2,
        }
    }

    #[test]
    fn supply_limited() {
        // asks: 10 @ 9, 5 @ 10 ; bids: 8 @ 11, 10 @ 10 → p* = 10: S = 15, D = 18, d_above = 8 < 15 ≤ 18
        let t = tally(8, 10, 10, 5, 11, 9);
        assert_eq!(
            check_window_clearing(&t).unwrap(),
            Ok(WindowClearing {
                branch: Branch::SupplyLimited,
                matched_units: 15,
                marginal_remaining: 7
            })
        );
        assert_eq!(
            classify(SIDE_BID, 11, 10, Branch::SupplyLimited),
            FillClass::Full
        );
        assert_eq!(
            classify(SIDE_BID, 10, 10, Branch::SupplyLimited),
            FillClass::Marginal
        );
        assert_eq!(
            classify(SIDE_BID, 9, 10, Branch::SupplyLimited),
            FillClass::Losing
        );
        assert_eq!(
            classify(SIDE_ASK, 10, 10, Branch::SupplyLimited),
            FillClass::Full
        );
        assert_eq!(
            classify(SIDE_ASK, 11, 10, Branch::SupplyLimited),
            FillClass::Losing
        );
        assert_eq!(ask_at_total(Branch::SupplyLimited, 5, 10, 15).unwrap(), 5);
    }

    #[test]
    fn demand_limited() {
        // asks 8 × 5 (at 5), bid 10 × 1 → p* = 5: D = 1, S = 8, s_below = 0 ≤ 1 < 8
        let t = tally(1, 0, 0, 8, 10, 5);
        assert_eq!(
            check_window_clearing(&t).unwrap(),
            Ok(WindowClearing {
                branch: Branch::DemandLimited,
                matched_units: 1,
                marginal_remaining: 1
            })
        );
        assert_eq!(
            classify(SIDE_ASK, 5, 5, Branch::DemandLimited),
            FillClass::Marginal
        );
        assert_eq!(
            classify(SIDE_ASK, 4, 5, Branch::DemandLimited),
            FillClass::Full
        );
        assert_eq!(
            classify(SIDE_BID, 5, 5, Branch::DemandLimited),
            FillClass::Full
        );
        assert_eq!(
            classify(SIDE_BID, 4, 5, Branch::DemandLimited),
            FillClass::Losing
        );
        assert_eq!(ask_at_total(Branch::DemandLimited, 8, 0, 1).unwrap(), 1);
    }

    #[test]
    fn rejections() {
        let nm = WindowTally {
            max_bid: 8,
            min_ask: 9,
            valid_count: 2,
            valid_bids: 1,
            valid_asks: 1,
            ..Default::default()
        };
        assert!(no_match_is_valid(&nm));
        assert!(no_match_is_valid(&WindowTally::default()));
        assert!(!no_match_is_valid(&tally(8, 10, 10, 5, 11, 9)));
        // one side empty: NO_MATCH even with a bid at u64::MAX (min_ask stays u64::MAX)
        let bids_only = WindowTally {
            d_at: 1,
            max_bid: u64::MAX,
            min_ask: u64::MAX,
            valid_count: 1,
            valid_bids: 1,
            valid_asks: 0,
            ..Default::default()
        };
        assert!(no_match_is_valid(&bids_only));
        // price not revealed
        assert_eq!(
            check_window_clearing(&tally(5, 0, 5, 0, 9, 1)).unwrap(),
            Err(WindowReject::PriceNotRevealed)
        );
        // no crossing: S = 5, D = 5, d_above = 5 → A fails (d_above < S), B fails (D < S)
        assert_eq!(
            check_window_clearing(&tally(5, 0, 0, 5, 9, 5)).unwrap(),
            Err(WindowReject::NoCrossing)
        );
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
        assert_eq!(
            settle_buyer(1_000_000, 7, 7_070_000, 100).unwrap(),
            (7_000_000, 70_000, 0)
        );
    }

    #[test]
    fn takeback_pieces() {
        assert_eq!(ask_at_budget(10, 3), 7);
        assert_eq!(ask_at_budget(10, 13), 0);
        assert_eq!(below_takeback(10, 3), 0);
        assert_eq!(below_takeback(10, 13), 3);
        assert!(taken_before(9, 0, 8, 7));
        assert!(taken_before(9, 3, 9, 2));
        assert!(!taken_before(9, 2, 9, 2));
        // R = 5 over keys (9,1)=3, (9,0)=4, (8,2)=10: threshold (9,0): 3 < 5 ≤ 7
        assert!(takeback_threshold_valid(5, 3, true, 4).unwrap());
        assert!(!takeback_threshold_valid(5, 0, true, 3).unwrap());
        assert!(!takeback_threshold_valid(5, 7, true, 10).unwrap());
        assert!(!takeback_threshold_valid(5, 3, false, 4).unwrap());
        assert_eq!(below_cut(9, 1, 3, 9, 0, 2), 3);
        assert_eq!(below_cut(9, 0, 4, 9, 0, 2), 2);
        assert_eq!(below_cut(8, 2, 10, 9, 0, 2), 0);
    }

    // ---------------------------------------------------------------- model-based property test

    #[derive(Debug, Clone)]
    struct Ord {
        side: u8,
        price: u64,
        qty: u64,
        idx: u32,
        allowed: bool,
    }

    fn tally_of(orders: &[Ord], p: u64) -> WindowTally {
        let mut t = WindowTally {
            min_ask: u64::MAX,
            ..Default::default()
        };
        for o in orders {
            t.valid_count += 1;
            if o.side == SIDE_BID {
                t.valid_bids += 1;
                t.max_bid = t.max_bid.max(o.price);
                if o.price > p {
                    t.d_above += o.qty;
                } else if o.price == p {
                    t.d_at += o.qty;
                }
            } else {
                t.valid_asks += 1;
                t.min_ask = t.min_ask.min(o.price);
                if o.price < p {
                    t.s_below += o.qty;
                } else if o.price == p {
                    t.s_at += o.qty;
                }
            }
        }
        t
    }

    /// Direct port of the reference `computeFills` (sort-based take-back).
    fn reference_fills(orders: &[Ord], p: u64, c: &WindowClearing) -> Vec<u64> {
        let supply = c.branch == Branch::SupplyLimited;
        let mut fill: Vec<i128> = orders
            .iter()
            .map(|o| {
                if o.side == SIDE_BID {
                    if o.price > p {
                        o.qty as i128
                    } else if o.price == p {
                        if supply {
                            -1
                        } else {
                            o.qty as i128
                        }
                    } else {
                        0
                    }
                } else if o.price < p {
                    o.qty as i128
                } else if o.price == p {
                    if supply {
                        o.qty as i128
                    } else {
                        -1
                    }
                } else {
                    0
                }
            })
            .collect();
        let marginal_side = if supply { SIDE_BID } else { SIDE_ASK };
        let mut marginal: Vec<usize> = (0..orders.len())
            .filter(|&i| orders[i].side == marginal_side && orders[i].price == p)
            .collect();
        marginal.sort_by_key(|&i| orders[i].idx);
        let mut remaining = c.marginal_remaining as i128;
        for i in marginal {
            let f = (orders[i].qty as i128).min(remaining);
            fill[i] = f;
            remaining -= f;
        }
        assert_eq!(remaining, 0);
        let mut returned: i128 = 0;
        for (i, o) in orders.iter().enumerate() {
            if o.side == SIDE_BID && fill[i] > 0 && !o.allowed {
                returned += fill[i];
                fill[i] = 0;
            }
        }
        let mut take: Vec<usize> = (0..orders.len())
            .filter(|&i| orders[i].side == SIDE_ASK && orders[i].price <= p)
            .collect();
        take.sort_by(|&a, &b| {
            (orders[b].price, orders[b].idx).cmp(&(orders[a].price, orders[a].idx))
        });
        for i in take {
            if returned == 0 {
                break;
            }
            let back = fill[i].min(returned);
            fill[i] -= back;
            returned -= back;
        }
        assert_eq!(returned, 0);
        fill.into_iter().map(|f| f as u64).collect()
    }

    /// The Solana algorithm: bids in ascending reveal index (first-come margin, cancellations
    /// counted), then asks in ascending reveal index with the at-p* budget and the below-p*
    /// threshold (found here by brute force, verified with `takeback_threshold_valid`).
    fn incremental_fills(orders: &[Ord], p: u64, t: &WindowTally, c: &WindowClearing) -> Vec<u64> {
        let mut fill = std::vec![0u64; orders.len()];
        let mut bids: Vec<usize> = (0..orders.len())
            .filter(|&i| orders[i].side == SIDE_BID)
            .collect();
        bids.sort_by_key(|&i| orders[i].idx);
        let mut marginal_remaining = c.marginal_remaining;
        let mut cancelled = 0u64;
        for i in bids {
            let o = &orders[i];
            let class = match classify(SIDE_BID, o.price, p, c.branch) {
                FillClass::Full => o.qty,
                FillClass::Losing => 0,
                FillClass::Marginal => {
                    let f = o.qty.min(marginal_remaining);
                    marginal_remaining -= f;
                    f
                }
            };
            if class > 0 && !o.allowed {
                cancelled += class;
            } else {
                fill[i] = class;
            }
        }
        let at_total = ask_at_total(c.branch, t.s_at, t.s_below, c.matched_units).unwrap();
        let budget = ask_at_budget(at_total, cancelled);
        let r_below = below_takeback(at_total, cancelled);
        // threshold by brute force over the below-p* asks
        let below: Vec<usize> = (0..orders.len())
            .filter(|&i| orders[i].side == SIDE_ASK && orders[i].price < p)
            .collect();
        let mut threshold = None;
        if r_below > 0 {
            for &k in &below {
                let ko = &orders[k];
                let above: u64 = below
                    .iter()
                    .filter(|&&j| taken_before(orders[j].price, orders[j].idx, ko.price, ko.idx))
                    .map(|&j| orders[j].qty)
                    .sum();
                if takeback_threshold_valid(r_below, above, true, ko.qty).unwrap() {
                    assert!(threshold.is_none(), "threshold not unique");
                    threshold = Some((ko.price, ko.idx, r_below - above));
                }
            }
            assert!(threshold.is_some(), "no threshold for R = {r_below}");
        }
        let mut asks: Vec<usize> = (0..orders.len())
            .filter(|&i| orders[i].side == SIDE_ASK)
            .collect();
        asks.sort_by_key(|&i| orders[i].idx);
        let mut at_filled = 0u64;
        for i in asks {
            let o = &orders[i];
            fill[i] = if o.price == p {
                let f = o.qty.min(budget - at_filled);
                at_filled += f;
                f
            } else if o.price < p {
                match threshold {
                    None => o.qty,
                    Some((kp, ki, partial)) => {
                        o.qty - below_cut(o.price, o.idx, o.qty, kp, ki, partial)
                    }
                }
            } else {
                0
            };
        }
        fill
    }

    fn book() -> impl Strategy<Value = Vec<Ord>> {
        proptest::collection::vec(
            (0u8..2, 1u64..8, 1u64..6, proptest::bool::weighted(0.7)),
            1..14,
        )
        .prop_map(|v| {
            let mut bid_idx = 0u32;
            let mut ask_idx = 0u32;
            v.into_iter()
                .map(|(side, price, qty, allowed)| {
                    let idx = if side == SIDE_BID {
                        bid_idx += 1;
                        bid_idx - 1
                    } else {
                        ask_idx += 1;
                        ask_idx - 1
                    };
                    Ord {
                        side,
                        price,
                        qty,
                        idx,
                        allowed,
                    }
                })
                .collect()
        })
    }

    /// Deterministic sweep (xorshift books) asserting that the comparison above is not vacuous:
    /// both take-back groups are exercised, in both branches.
    #[test]
    fn takeback_paths_are_exercised() {
        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = |m: u64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state % m
        };
        let (mut at_cut, mut below_cut_seen, mut demand) = (0u32, 0u32, 0u32);
        for _ in 0..40_000 {
            let n = 2 + next(12) as usize;
            let (mut bi, mut ai) = (0u32, 0u32);
            let orders: Vec<Ord> = (0..n)
                .map(|_| {
                    let side = next(2) as u8;
                    let idx = if side == SIDE_BID {
                        bi += 1;
                        bi - 1
                    } else {
                        ai += 1;
                        ai - 1
                    };
                    Ord {
                        side,
                        price: 1 + next(7),
                        qty: 1 + next(5),
                        idx,
                        allowed: next(10) < 6,
                    }
                })
                .collect();
            let mut prices: Vec<u64> = orders.iter().map(|o| o.price).collect();
            prices.sort_unstable();
            prices.dedup();
            for p in prices {
                let t = tally_of(&orders, p);
                if let Ok(c) = check_window_clearing(&t).unwrap() {
                    let reference = reference_fills(&orders, p, &c);
                    let incremental = incremental_fills(&orders, p, &t, &c);
                    assert_eq!(reference, incremental, "book {orders:?} at {p}");
                    let mut mr = c.marginal_remaining;
                    let mut cancelled = 0u64;
                    let mut bids: Vec<&Ord> =
                        orders.iter().filter(|o| o.side == SIDE_BID).collect();
                    bids.sort_by_key(|o| o.idx);
                    for o in bids {
                        let class = match classify(SIDE_BID, o.price, p, c.branch) {
                            FillClass::Full => o.qty,
                            FillClass::Losing => 0,
                            FillClass::Marginal => {
                                let f = o.qty.min(mr);
                                mr -= f;
                                f
                            }
                        };
                        if class > 0 && !o.allowed {
                            cancelled += class;
                        }
                    }
                    let at_total =
                        ask_at_total(c.branch, t.s_at, t.s_below, c.matched_units).unwrap();
                    if cancelled > 0 && at_total > 0 {
                        at_cut += 1;
                    }
                    if below_takeback(at_total, cancelled) > 0 {
                        below_cut_seen += 1;
                    }
                    if c.branch == Branch::DemandLimited && cancelled > 0 {
                        demand += 1;
                    }
                }
            }
        }
        assert!(
            at_cut > 100 && below_cut_seen > 100 && demand > 100,
            "{at_cut} {below_cut_seen} {demand}"
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(3000))]
        #[test]
        fn exactly_one_branch_or_none(d_above in 0u64..50, d_at in 0u64..50, s_below in 0u64..50, s_at in 0u64..50) {
            let t = WindowTally { d_above, d_at, s_below, s_at, max_bid: 1, min_ask: 1, valid_count: 2, valid_bids: 1, valid_asks: 1 };
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

        /// Exactly one of {a unique crossing price, NO_MATCH} is valid for every book, and the
        /// incremental (per-order, ascending reveal index) settlement equals the reference fills,
        /// including cancelled buyers and the two-group take-back. Units are conserved.
        #[test]
        fn incremental_settlement_matches_reference(orders in book()) {
            let mut prices: Vec<u64> = orders.iter().map(|o| o.price).collect();
            prices.sort_unstable();
            prices.dedup();
            let crossing: Vec<(u64, WindowClearing)> = prices
                .iter()
                .filter_map(|&p| check_window_clearing(&tally_of(&orders, p)).unwrap().ok().map(|c| (p, c)))
                .collect();
            let nm = no_match_is_valid(&tally_of(&orders, 0));
            prop_assert!(crossing.len() <= 1, "crossing price not unique");
            prop_assert!(crossing.len() == 1 || nm, "neither a crossing price nor NO_MATCH");
            prop_assert!(!(crossing.len() == 1 && nm), "both a crossing price and NO_MATCH");
            if let Some((p, c)) = crossing.first().copied() {
                let t = tally_of(&orders, p);
                let reference = reference_fills(&orders, p, &c);
                let incremental = incremental_fills(&orders, p, &t, &c);
                prop_assert_eq!(&reference, &incremental);
                let bought: u64 = orders.iter().zip(&incremental).filter(|(o, _)| o.side == SIDE_BID).map(|(_, f)| *f).sum();
                let sold: u64 = orders.iter().zip(&incremental).filter(|(o, _)| o.side == SIDE_ASK).map(|(_, f)| *f).sum();
                prop_assert_eq!(bought, sold);
                for (o, f) in orders.iter().zip(&incremental) {
                    prop_assert!(*f <= o.qty);
                }
            }
        }
    }
}
