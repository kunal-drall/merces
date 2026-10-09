//! Property (fuzz) tests over the money math (brief F2): conservation, caps, monotonicity and
//! uniqueness laws checked on random inputs. Each module also carries example-based unit tests.

#![allow(clippy::arithmetic_side_effects)]

extern crate std;

use proptest::prelude::*;
use std::vec::Vec;

use crate::auction::{check_proposal, marginal_alloc, r_claim, required_escrow};
use crate::fx::{invert, normalize, quarter_average, Checkpoint};
use crate::params::Tranche;
use crate::redemption::{
    hurdle_price, redemption_price, year_gross_add, year_gross_at, RedemptionInputs, YearGross,
};
use crate::status::{
    derive_status, is_late_underlying, late_accrual, paused_within, unpaused, Pause, SeriesStatus,
    StatusInputs,
};
use crate::time::{period_end, period_of, period_start, DAY, YEAR};
use crate::treasury::{claimable, vested};
use crate::vault::{holder_delta, receive_capped, receive_final, ReceiveInput};
use crate::WAD;

fn rank(s: SeriesStatus) -> u8 {
    match s {
        SeriesStatus::OnTime => 0,
        SeriesStatus::InGrace => 1,
        SeriesStatus::Late => 2,
        other => 10 + other as u8,
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1500))]

    /// A whole sequence of receipts against one cap: every holder partition claims at most what was
    /// distributed net (WAD carry), the per-unit gross never passes the effective cap, accepted plus
    /// refunded equals offered, and once capped nothing more is accepted.
    #[test]
    fn vault_sequences_conserve_and_respect_the_cap(
        units in 1u64..5_000,
        cap_per_unit in 1u64..10_000_000,
        fee_bps in 0u16..=2_000,
        grosses in proptest::collection::vec(0u64..2_000_000_000, 1..12),
        cut in 0u64..5_000,
    ) {
        let mut paid = 0u128;
        let mut acc = 0u128;
        let mut carry = 0u64;
        let mut net_total = 0u128;
        let mut capped = false;
        for g in grosses {
            let out = receive_capped(ReceiveInput {
                gross: g, units, cap_per_unit, paid_per_unit_wad: paid, carry_wad: carry, fee_bps,
            }).unwrap();
            prop_assert_eq!(out.accepted + out.refund, g);
            if capped {
                prop_assert_eq!(out.accepted, 0);
            }
            paid += out.inc_wad;
            prop_assert!(paid <= core::cmp::max(u128::from(cap_per_unit) * WAD, 0));
            acc += out.delta_acc_wad;
            carry = out.carry_wad_out;
            prop_assert!(carry < units);
            net_total += u128::from(out.net);
            prop_assert_eq!(acc * u128::from(units) + u128::from(carry), net_total * WAD);
            capped |= out.capped;
        }
        let a = cut % (units + 1);
        let claims = holder_delta(acc, 0, a).unwrap() + holder_delta(acc, 0, units - a).unwrap();
        prop_assert!(u128::from(claims) <= net_total);
        // the gross per unit only ever counts accepted money
        prop_assert!(paid * u128::from(units) <= (u128::from(cap_per_unit) * WAD) * u128::from(units));
    }

    /// Final (extinguishment) distributions take no fee and conserve exactly.
    #[test]
    fn final_distribution_is_exact(amounts in proptest::collection::vec(0u64..u64::MAX / 8, 1..6), units in 1u64..100_000) {
        let mut acc = 0u128;
        let mut carry = 0u64;
        let mut total = 0u128;
        for a in amounts {
            let out = receive_final(a, units, carry).unwrap();
            prop_assert_eq!(out.fee, 0);
            acc += out.delta_acc_wad;
            carry = out.carry_wad_out;
            total += u128::from(a);
            prop_assert_eq!(acc * u128::from(units) + u128::from(carry), total * WAD);
        }
    }

    /// Unpaused time never exceeds elapsed time, grows with the end point, and paused + unpaused
    /// equals the elapsed span.
    #[test]
    fn unpaused_time_laws(
        raw in proptest::collection::vec((0u64..400, 1u64..120), 0..6),
        a in 0u64..500, len in 0u64..500, extra in 0u64..100,
    ) {
        let base = 1_800_000_000u64;
        let pauses: Vec<Pause> = raw
            .iter()
            .scan(base, |cursor, (gap, l)| {
                let start = *cursor + gap * DAY;
                let end = start + l * DAY;
                *cursor = end;
                Some(Pause { start, end })
            })
            .collect();
        let a = base + a * DAY;
        let b = a + len * DAY;
        let now = b + extra * DAY;
        let u = unpaused(&pauses, a, b, now);
        prop_assert!(u <= b - a);
        prop_assert_eq!(u + paused_within(&pauses, a, b, now), b - a);
        prop_assert!(unpaused(&pauses, a, b + DAY, now + DAY) >= u);
    }

    /// Without pauses or new reports, the status only moves forward in time (OnTime → InGrace →
    /// Late) and `is_late_underlying` agrees with Late.
    #[test]
    fn status_moves_forward_without_pauses(p in 8100u32..8200, t1 in 0u64..200, dt in 0u64..200, trueup in 0u64..2) {
        let start = period_end(p).unwrap();
        let inp = StatusInputs {
            stored: SeriesStatus::OnTime,
            pauses: &[],
            earliest_unpaid_period: p,
            trueup_due: trueup,
            trueup_attested_at: start,
        };
        let s1 = derive_status(&inp, start + t1 * DAY).unwrap();
        let s2 = derive_status(&inp, start + (t1 + dt) * DAY).unwrap();
        prop_assert!(rank(s1) <= rank(s2));
        prop_assert_eq!(s2 == SeriesStatus::Late, is_late_underlying(&inp, start + (t1 + dt) * DAY).unwrap());
    }

    /// A pause approved before the deadline can only move the status backwards in severity.
    #[test]
    fn pauses_never_worsen_the_status(p in 8100u32..8200, ps in 0u64..60, pl in 1u64..200, t in 0u64..400) {
        let start = period_end(p).unwrap();
        let pauses = [Pause { start: start + ps * DAY, end: start + (ps + pl) * DAY }];
        let now = start + t * DAY;
        let with = StatusInputs { stored: SeriesStatus::OnTime, pauses: &pauses, earliest_unpaid_period: p, trueup_due: 0, trueup_attested_at: 0 };
        let without = StatusInputs { pauses: &[], ..with };
        let a = derive_status(&with, now).unwrap();
        let b = derive_status(&without, now).unwrap();
        if a != SeriesStatus::Paused {
            prop_assert!(rank(a) <= rank(b));
        }
        prop_assert!(!is_late_underlying(&with, now).unwrap() || is_late_underlying(&without, now).unwrap());
    }

    /// Late accrual is monotone in days and amount and never above simple interest.
    #[test]
    fn late_accrual_bounds(amount in 0u64..u64::MAX / 4, h in 0u64..=250_000_000_000_000_000, d in 0u64..3_650, extra in 0u64..100) {
        let a = late_accrual(amount, h, d).unwrap();
        prop_assert!(late_accrual(amount, h, d + extra).unwrap() >= a);
        prop_assert!(late_accrual(amount / 2, h, d).unwrap() <= a);
        let simple = u128::from(amount) * u128::from(h) / WAD * u128::from(d) / 365;
        prop_assert!(u128::from(a) <= simple + 1);
    }

    /// The redemption price never exceeds the remaining cap; the hurdle grows with time and never
    /// falls below `P0`; `k × D_avg` only counts after a full year.
    #[test]
    fn redemption_price_bounds(
        p0 in 1u64..1_000_000_000,
        h in 0u64..=250_000_000_000_000_000,
        k in 1u16..=20,
        cap_mult in 2_000_000_000_000_000_000u64..=3_000_000_000_000_000_000,
        paid_units in 0u64..4_000_000_000,
        years in proptest::collection::vec(0u64..500_000_000, 4),
        t in 0u64..(6 * YEAR),
    ) {
        let cap = crate::vault::cap_per_unit(cap_mult, p0).unwrap();
        let mut ring = [YearGross::default(); 4];
        for (y, g) in years.iter().enumerate() {
            year_gross_add(&mut ring, y as u32 + (t / YEAR) as u32 / 4 * 4, u128::from(*g) * WAD).unwrap();
        }
        let q = redemption_price(&RedemptionInputs {
            clearing_price: p0, hurdle_rate_wad: h, payout_multiple_k: k, cap_per_unit: cap,
            paid_per_unit_wad: u128::from(paid_units) * WAD, year_gross: &ring, settlement_ts: 0, now: t,
        }).unwrap();
        prop_assert!(q.price <= q.cap_remaining);
        prop_assert!(q.hurdle >= p0);
        prop_assert!(hurdle_price(p0, h, t + DAY).unwrap() >= q.hurdle);
        if t < YEAR {
            prop_assert_eq!(q.d_avg, 0);
            prop_assert_eq!(q.price, core::cmp::min(q.cap_remaining, q.hurdle));
        }
    }

    /// The tagged ring returns what was added for every year of the last four and zero otherwise.
    #[test]
    fn year_ring_reads_back(adds in proptest::collection::vec((0u32..40, 1u64..1_000_000), 1..30)) {
        let mut ring = [YearGross::default(); 4];
        let mut latest = 0u32;
        let mut model: std::collections::BTreeMap<u32, u128> = std::collections::BTreeMap::new();
        let mut sorted = adds.clone();
        sorted.sort_by_key(|a| a.0);
        for (y, g) in sorted {
            year_gross_add(&mut ring, y, u128::from(g)).unwrap();
            *model.entry(y).or_insert(0) += u128::from(g);
            latest = y;
        }
        for y in latest.saturating_sub(3)..=latest {
            prop_assert_eq!(year_gross_at(&ring, y), model.get(&y).copied().unwrap_or(0));
        }
        if latest >= 4 {
            prop_assert_eq!(year_gross_at(&ring, latest - 4), 0);
        }
    }

    /// Vesting is monotone in time, bounded by the proceeds and sums the tranches exactly at the end.
    #[test]
    fn vesting_laws(proceeds in 0u64..u64::MAX / 4, n in 1usize..24, t1 in 0u64..(10 * YEAR), dt in 0u64..YEAR, released in 0u64..u64::MAX / 4) {
        let mut schedule: Vec<Tranche> = (0..n).map(|i| Tranche { at_offset_seconds: i as u64 * YEAR / 2, bps: (10_000 / n) as u16 }).collect();
        let used: u64 = schedule.iter().map(|t| u64::from(t.bps)).sum();
        schedule[n - 1].bps += (10_000 - used) as u16;
        let v1 = vested(proceeds, &schedule, 0, t1).unwrap();
        let v2 = vested(proceeds, &schedule, 0, t1 + dt).unwrap();
        prop_assert!(v1 <= v2 && v2 <= proceeds);
        prop_assert_eq!(vested(proceeds, &schedule, 0, u64::MAX / 2).unwrap(), proceeds);
        let c = claimable(proceeds, &schedule, 0, t1, released).unwrap();
        prop_assert!(c <= proceeds.saturating_sub(released));
    }

    /// A quarter average lies between the smallest and the largest snapshot rate.
    #[test]
    fn quarter_average_is_bounded(rates in proptest::collection::vec(1u64..10_000_000_000_000_000_000, 1..70), base_sum in 0u64..1_000_000_000_000_000_000, base_count in 0u32..1000) {
        let start = Checkpoint { sum_wad: u128::from(base_sum), count: base_count, flagged: false };
        let sum: u128 = rates.iter().map(|r| u128::from(*r)).sum();
        let end = Checkpoint { sum_wad: start.sum_wad + sum, count: base_count + rates.len() as u32, flagged: false };
        let (_, avg) = quarter_average(8104, &start, &end, 8_000).unwrap();
        prop_assert!(avg >= *rates.iter().min().unwrap());
        prop_assert!(avg <= *rates.iter().max().unwrap());
    }

    /// Normalisation is exact when the WAD rate fits u64 (and an error otherwise, SPEC §1.1), and
    /// inversion is the floor of `WAD² / rate`.
    #[test]
    fn fx_normalisation(price in 1i64..10_000_000_000, expo in -18i32..=0) {
        let exact = price as u128 * 10u128.pow((18 + expo) as u32);
        match normalize(price, expo) {
            Ok(r) => {
                prop_assert_eq!(u128::from(r), exact);
                match invert(r) {
                    Ok(inv) => {
                        prop_assert!(u128::from(inv) * u128::from(r) <= WAD * WAD);
                        prop_assert!((u128::from(inv) + 1) * u128::from(r) > WAD * WAD);
                    }
                    Err(_) => prop_assert!(WAD * WAD / u128::from(r) > u128::from(u64::MAX)),
                }
            }
            Err(_) => prop_assert!(exact > u128::from(u64::MAX)),
        }
    }

    /// Periods: every timestamp lies inside its period and period boundaries round-trip.
    #[test]
    fn period_laws(ts in 0u64..4_102_444_800) {
        let p = period_of(ts).unwrap();
        prop_assert!(period_start(p).unwrap() <= ts && ts < period_end(p).unwrap());
        prop_assert_eq!(period_of(period_start(p).unwrap()).unwrap(), p);
        prop_assert_eq!(period_of(period_end(p).unwrap()).unwrap(), p + 1);
    }

    /// Uniform-price auction (SPEC §5.2): for every book with at least one valid bid exactly one
    /// honest proposal (with the true claims) is accepted, and its results are consistent:
    /// `units_sold ≤ N`, every winning bid pays at most its price, marginal shares sum to `alloc_sum`.
    #[test]
    fn exactly_one_clearing_price(
        n in 1u64..60,
        bids in proptest::collection::vec((1u64..12, 1u64..20), 1..15),
    ) {
        let mut prices: Vec<u64> = bids.iter().map(|b| b.0).collect();
        prices.sort_unstable();
        prices.dedup();
        let min_valid = *prices.first().unwrap();
        let mut accepted = Vec::new();
        for &p in &prices {
            let q_above: u64 = bids.iter().filter(|b| b.0 > p).map(|b| b.1).sum();
            let q_at: u64 = bids.iter().filter(|b| b.0 == p).map(|b| b.1).sum();
            if check_proposal(n, p, q_above, q_at, q_above, q_at, min_valid).unwrap().is_ok() {
                accepted.push((p, q_above, q_at));
            }
        }
        prop_assert_eq!(accepted.len(), 1, "accepted {:?}", accepted);
        let (p, q_above, q_at) = accepted[0];
        let r = r_claim(n, q_above, q_at);
        let alloc_sum: u64 = bids.iter().filter(|b| b.0 == p).map(|b| marginal_alloc(r, b.1, q_at).unwrap()).sum();
        prop_assert!(alloc_sum <= r);
        prop_assert!(q_above + alloc_sum <= n);
        for b in &bids {
            prop_assert!(required_escrow(b.0, b.1, 100).unwrap() >= b.0 * b.1);
        }
    }
}
