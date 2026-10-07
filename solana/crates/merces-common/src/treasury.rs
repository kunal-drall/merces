//! Treasury vesting arithmetic (SPEC §5.3).

use crate::{bps_of, params::Tranche, MathError, MathResult};

/// `tranche_amount(i)`: `floor(proceeds × bps_i / 10000)` for every tranche but the last, which
/// takes the remainder so the tranches sum exactly to `proceeds`.
pub fn tranche_amount(proceeds: u64, schedule: &[Tranche], i: usize) -> MathResult<u64> {
    let last = schedule
        .len()
        .checked_sub(1)
        .ok_or(MathError::InvalidInput)?;
    if i > last {
        return Err(MathError::InvalidInput);
    }
    if i < last {
        return bps_of(proceeds, schedule[i].bps);
    }
    let mut others: u64 = 0;
    for t in &schedule[..last] {
        others = others
            .checked_add(bps_of(proceeds, t.bps)?)
            .ok_or(MathError::Overflow)?;
    }
    proceeds.checked_sub(others).ok_or(MathError::Overflow)
}

/// `vested(now) = Σ_{i : settlement_ts + at_offset_i ≤ now} tranche_amount(i)`.
pub fn vested(
    proceeds: u64,
    schedule: &[Tranche],
    settlement_ts: u64,
    now: u64,
) -> MathResult<u64> {
    let mut total: u64 = 0;
    for (i, t) in schedule.iter().enumerate() {
        let unlock = settlement_ts
            .checked_add(t.at_offset_seconds)
            .ok_or(MathError::Overflow)?;
        if unlock <= now {
            total = total
                .checked_add(tranche_amount(proceeds, schedule, i)?)
                .ok_or(MathError::Overflow)?;
        }
    }
    Ok(total)
}

/// `claim_release` amount: `min(vested(now), proceeds) − released_total`.
pub fn claimable(
    proceeds: u64,
    schedule: &[Tranche],
    settlement_ts: u64,
    now: u64,
    released_total: u64,
) -> MathResult<u64> {
    let v = core::cmp::min(vested(proceeds, schedule, settlement_ts, now)?, proceeds);
    Ok(v.saturating_sub(released_total))
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn sched() -> [Tranche; 3] {
        [
            Tranche {
                at_offset_seconds: 0,
                bps: 3_333,
            },
            Tranche {
                at_offset_seconds: 100,
                bps: 3_333,
            },
            Tranche {
                at_offset_seconds: 200,
                bps: 3_334,
            },
        ]
    }

    #[test]
    fn tranches_sum_exactly() {
        let s = sched();
        let p = 1_000_001;
        let a: u64 = (0..3).map(|i| tranche_amount(p, &s, i).unwrap()).sum();
        assert_eq!(a, p);
        assert_eq!(tranche_amount(p, &s, 0).unwrap(), 333_300);
        assert_eq!(tranche_amount(p, &s, 2).unwrap(), 1_000_001 - 666_600);
    }

    #[test]
    fn vesting_schedule() {
        let s = sched();
        assert_eq!(vested(1_000_000, &s, 1_000, 999).unwrap(), 0);
        assert_eq!(vested(1_000_000, &s, 1_000, 1_000).unwrap(), 333_300);
        assert_eq!(vested(1_000_000, &s, 1_000, 1_100).unwrap(), 666_600);
        assert_eq!(vested(1_000_000, &s, 1_000, 1_200).unwrap(), 1_000_000);
        assert_eq!(
            claimable(1_000_000, &s, 1_000, 1_100, 333_300).unwrap(),
            333_300
        );
        assert_eq!(claimable(1_000_000, &s, 1_000, 1_100, 700_000).unwrap(), 0);
    }

    proptest! {
        #[test]
        fn tranche_sum_invariant(
            proceeds in 0u64..u64::MAX / 2,
            bps in proptest::collection::vec(1u16..5000, 1..24)
        ) {
            // normalise to 10000
            let mut v = bps.clone();
            let s: u64 = v.iter().map(|b| u64::from(*b)).sum();
            // scale so the sum is 10000 (last takes the rest)
            let mut acc = 0u64;
            for b in v.iter_mut() {
                let nb = (u64::from(*b) * 10_000 / s) as u16;
                *b = nb; acc += u64::from(nb);
            }
            let last = v.len() - 1;
            v[last] = (u64::from(v[last]) + (10_000 - acc)) as u16;
            let schedule: alloc_vec::Vec<Tranche> = v.iter().enumerate().map(|(i, b)| Tranche { at_offset_seconds: i as u64, bps: *b }).collect();
            let sum: u64 = (0..schedule.len()).map(|i| tranche_amount(proceeds, &schedule, i).unwrap()).sum();
            prop_assert_eq!(sum, proceeds);
            prop_assert_eq!(vested(proceeds, &schedule, 0, u64::MAX).unwrap(), proceeds);
        }
    }

    mod alloc_vec {
        extern crate std;
        pub use std::vec::Vec;
    }
}
