//! Status derivation, deadlines and late accrual (SPEC §1.7, §6.4).

use crate::{
    mul_div,
    params::{FORMAL_NOTICE_DAYS, GRACE_DAYS, REPORT_DUE_DAYS},
    time::{period_end, DAY},
    to_u64, MathError, MathResult, WAD,
};

/// `SeriesStatus` (SPEC §1.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SeriesStatus {
    OnTime = 0,
    InGrace = 1,
    Late = 2,
    Paused = 3,
    Retired = 4,
    Redeemed = 5,
    Extinguished = 6,
}

impl SeriesStatus {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Self::OnTime,
            1 => Self::InGrace,
            2 => Self::Late,
            3 => Self::Paused,
            4 => Self::Retired,
            5 => Self::Redeemed,
            6 => Self::Extinguished,
            _ => return None,
        })
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Retired | Self::Redeemed | Self::Extinguished)
    }
}

/// The ledger fields the status derivation reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatusInputs {
    pub stored: SeriesStatus,
    pub pause_start: u64,
    pub pause_end: u64,
    pub paused_total: u64,
    /// `earliest_unpaid()` — the open due period if a due is open, else the next expected period.
    pub earliest_unpaid_period: u32,
}

/// `pause_elapsed(now)`.
pub fn pause_elapsed(pause_start: u64, pause_end: u64, now: u64) -> MathResult<u64> {
    if pause_start == 0 {
        return Ok(0);
    }
    core::cmp::min(now, pause_end)
        .checked_sub(pause_start)
        .ok_or(MathError::Overflow)
}

/// `effective_now(now) = now − paused_total − pause_elapsed(now)`.
pub fn effective_now(
    pause_start: u64,
    pause_end: u64,
    paused_total: u64,
    now: u64,
) -> MathResult<u64> {
    now.checked_sub(paused_total)
        .ok_or(MathError::Overflow)?
        .checked_sub(pause_elapsed(pause_start, pause_end, now)?)
        .ok_or(MathError::Overflow)
}

pub fn is_paused(pause_start: u64, pause_end: u64, now: u64) -> bool {
    pause_start != 0 && now < pause_end
}

/// `deadline(p) = period_end(p) + 30 d`.
pub fn deadline(period: u32) -> MathResult<u64> {
    period_end(period)?
        .checked_add(
            REPORT_DUE_DAYS
                .checked_mul(DAY)
                .ok_or(MathError::Overflow)?,
        )
        .ok_or(MathError::Overflow)
}

/// `grace_end(p) = deadline(p) + 15 d`.
pub fn grace_end(period: u32) -> MathResult<u64> {
    deadline(period)?
        .checked_add(GRACE_DAYS.checked_mul(DAY).ok_or(MathError::Overflow)?)
        .ok_or(MathError::Overflow)
}

/// `formal_notice_at(p) = deadline(p) + 90 d`.
pub fn formal_notice_at(period: u32) -> MathResult<u64> {
    deadline(period)?
        .checked_add(
            FORMAL_NOTICE_DAYS
                .checked_mul(DAY)
                .ok_or(MathError::Overflow)?,
        )
        .ok_or(MathError::Overflow)
}

/// `derive_status(now)` (SPEC §6.4).
pub fn derive_status(inp: &StatusInputs, now: u64) -> MathResult<SeriesStatus> {
    if inp.stored.is_terminal() {
        return Ok(inp.stored);
    }
    if is_paused(inp.pause_start, inp.pause_end, now) {
        return Ok(SeriesStatus::Paused);
    }
    let e = effective_now(inp.pause_start, inp.pause_end, inp.paused_total, now)?;
    let p = inp.earliest_unpaid_period;
    if e <= deadline(p)? {
        Ok(SeriesStatus::OnTime)
    } else if e <= grace_end(p)? {
        Ok(SeriesStatus::InGrace)
    } else {
        Ok(SeriesStatus::Late)
    }
}

/// `late_days(p, now) = max(0, floor((effective_now − grace_end(p)) / DAY))`, with an explicit
/// `grace_end` so the true-up path can substitute its own deadline.
pub fn late_days_from(effective_now: u64, grace_end_ts: u64) -> u64 {
    effective_now.saturating_sub(grace_end_ts) / DAY
}

/// `late_accrual = floor(amount × h × late_days / (365 × WAD))`.
pub fn late_accrual(amount: u64, hurdle_rate_wad: u64, late_days: u64) -> MathResult<u64> {
    let num = u128::from(amount)
        .checked_mul(u128::from(hurdle_rate_wad))
        .ok_or(MathError::Overflow)?;
    let den = WAD.checked_mul(365).ok_or(MathError::Overflow)?;
    to_u64(mul_div(num, u128::from(late_days), den)?)
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;
    use crate::time::period_start;

    fn inputs(p: u32) -> StatusInputs {
        StatusInputs {
            stored: SeriesStatus::OnTime,
            pause_start: 0,
            pause_end: 0,
            paused_total: 0,
            earliest_unpaid_period: p,
        }
    }

    #[test]
    fn deadlines_for_2026_q1() {
        let p = 8104;
        let end = period_end(p).unwrap();
        assert_eq!(deadline(p).unwrap(), end + 30 * DAY);
        assert_eq!(grace_end(p).unwrap(), end + 45 * DAY);
        assert_eq!(formal_notice_at(p).unwrap(), end + 120 * DAY);
    }

    #[test]
    fn status_transitions() {
        let p = 8104;
        let i = inputs(p);
        assert_eq!(
            derive_status(&i, period_start(p).unwrap()).unwrap(),
            SeriesStatus::OnTime
        );
        assert_eq!(
            derive_status(&i, deadline(p).unwrap()).unwrap(),
            SeriesStatus::OnTime
        );
        assert_eq!(
            derive_status(&i, deadline(p).unwrap() + 1).unwrap(),
            SeriesStatus::InGrace
        );
        assert_eq!(
            derive_status(&i, grace_end(p).unwrap()).unwrap(),
            SeriesStatus::InGrace
        );
        assert_eq!(
            derive_status(&i, grace_end(p).unwrap() + 1).unwrap(),
            SeriesStatus::Late
        );
    }

    #[test]
    fn pause_stops_the_clock() {
        let p = 8104;
        let mut i = inputs(p);
        let d = deadline(p).unwrap();
        // pause started 10 days before the deadline and lasts 30 days
        i.pause_start = d - 10 * DAY;
        i.pause_end = d + 20 * DAY;
        assert_eq!(
            derive_status(&i, d + 5 * DAY).unwrap(),
            SeriesStatus::Paused
        );
        // after the pause, 30 days are excluded: at pause_end effective = d − 10 d → OnTime
        assert_eq!(
            derive_status(&i, d + 20 * DAY).unwrap(),
            SeriesStatus::OnTime
        );
        assert_eq!(
            derive_status(&i, d + 30 * DAY).unwrap(),
            SeriesStatus::OnTime
        );
        assert_eq!(
            derive_status(&i, d + 30 * DAY + 1).unwrap(),
            SeriesStatus::InGrace
        );
        // once closed into paused_total the result is identical
        let mut j = inputs(p);
        j.paused_total = 30 * DAY;
        assert_eq!(
            derive_status(&j, d + 30 * DAY + 1).unwrap(),
            SeriesStatus::InGrace
        );
        assert_eq!(
            derive_status(&j, grace_end(p).unwrap() + 30 * DAY + 1).unwrap(),
            SeriesStatus::Late
        );
    }

    #[test]
    fn terminal_is_sticky() {
        let mut i = inputs(8104);
        i.stored = SeriesStatus::Retired;
        assert_eq!(
            derive_status(&i, u64::MAX / 2).unwrap(),
            SeriesStatus::Retired
        );
    }

    #[test]
    fn accrual() {
        // 1_000_000 × 8% × 73 days / 365 = 16_000
        assert_eq!(
            late_accrual(1_000_000, 80_000_000_000_000_000, 73).unwrap(),
            16_000
        );
        assert_eq!(
            late_accrual(1_000_000, 80_000_000_000_000_000, 0).unwrap(),
            0
        );
        assert_eq!(late_accrual(1, 80_000_000_000_000_000, 1).unwrap(), 0);
        assert_eq!(late_days_from(100 * DAY, 90 * DAY + 1), 9);
        assert_eq!(late_days_from(10, 20), 0);
    }
}
