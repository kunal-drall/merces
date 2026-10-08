//! Status derivation, deadlines and accrual (SPEC v1.1 §1.7, §6.4).
//!
//! Countdowns run in **unpaused time from their own start**: `countdown(p, now) =
//! unpaused(period_end(p), now)` where paused time is taken from a bounded pause history.

use crate::{
    mul_div,
    params::{FORMAL_NOTICE_DAYS, GRACE_DAYS, REPORT_DUE_DAYS, TRUEUP_DAYS},
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

/// One hardship pause `[start, end)`; `end` is the approved end or the early end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Pause {
    pub start: u64,
    pub end: u64,
}

pub const DEADLINE_S: u64 = REPORT_DUE_DAYS * DAY;
pub const GRACE_S: u64 = (REPORT_DUE_DAYS + GRACE_DAYS) * DAY;
pub const NOTICE_S: u64 = FORMAL_NOTICE_DAYS * DAY;
pub const TRUEUP_S: u64 = TRUEUP_DAYS * DAY;

/// Σ over pauses (open ones clipped at `min(now, end)`) of `|[start, end] ∩ [a, b]|`.
pub fn paused_within(pauses: &[Pause], a: u64, b: u64, now: u64) -> u64 {
    if b <= a {
        return 0;
    }
    let mut total: u64 = 0;
    for p in pauses {
        if p.start == 0 && p.end == 0 {
            continue;
        }
        let end = core::cmp::min(p.end, now);
        let lo = core::cmp::max(p.start, a);
        let hi = core::cmp::min(end, b);
        if hi > lo {
            total = total.saturating_add(hi - lo);
        }
    }
    total
}

/// `(b − a) − paused_within(a, b)`; 0 when `b ≤ a`.
pub fn unpaused(pauses: &[Pause], a: u64, b: u64, now: u64) -> u64 {
    if b <= a {
        return 0;
    }
    (b - a).saturating_sub(paused_within(pauses, a, b, now))
}

/// An open pause exists with `start ≤ now < end`.
pub fn is_paused(pauses: &[Pause], now: u64) -> bool {
    pauses.iter().any(|p| p.start != 0 && p.start <= now && now < p.end)
}

/// `countdown(p, now) = unpaused(period_end(p), now)`.
pub fn countdown(pauses: &[Pause], period: u32, now: u64) -> MathResult<u64> {
    Ok(unpaused(pauses, period_end(period)?, now, now))
}

/// Inputs to the status machine.
#[derive(Debug, Clone, Copy)]
pub struct StatusInputs<'a> {
    pub stored: SeriesStatus,
    pub pauses: &'a [Pause],
    /// `earliest_unpaid()` — the open due period if a due is open, else the next expected period.
    pub earliest_unpaid_period: u32,
    pub trueup_due: u64,
    pub trueup_attested_at: u64,
}

/// `trueup_due > 0 && unpaused(trueup_attested_at, now) > trueup_days × DAY`.
pub fn trueup_overdue(inp: &StatusInputs, now: u64) -> bool {
    inp.trueup_due > 0 && unpaused(inp.pauses, inp.trueup_attested_at, now, now) > TRUEUP_S
}

/// `derive_status(now)` (SPEC §6.4).
pub fn derive_status(inp: &StatusInputs, now: u64) -> MathResult<SeriesStatus> {
    if inp.stored.is_terminal() {
        return Ok(inp.stored);
    }
    if is_paused(inp.pauses, now) {
        return Ok(SeriesStatus::Paused);
    }
    if trueup_overdue(inp, now) {
        return Ok(SeriesStatus::Late);
    }
    let c = countdown(inp.pauses, inp.earliest_unpaid_period, now)?;
    Ok(if c <= DEADLINE_S {
        SeriesStatus::OnTime
    } else if c <= GRACE_S {
        SeriesStatus::InGrace
    } else {
        SeriesStatus::Late
    })
}

/// `is_late_underlying(now)`: the Late condition ignoring an active pause.
pub fn is_late_underlying(inp: &StatusInputs, now: u64) -> MathResult<bool> {
    if inp.stored.is_terminal() {
        return Ok(false);
    }
    Ok(trueup_overdue(inp, now) || countdown(inp.pauses, inp.earliest_unpaid_period, now)? > GRACE_S)
}

/// `max(0, floor((countdown − grace_s) / DAY))`.
pub fn late_days_from_countdown(countdown_s: u64) -> u64 {
    countdown_s.saturating_sub(GRACE_S) / DAY
}

/// `late_accrual = mulDiv(mulDiv(amount, hurdle_rate_wad, WAD), late_days, 365)` (SPEC §1.1 nesting).
pub fn late_accrual(amount: u64, hurdle_rate_wad: u64, late_days: u64) -> MathResult<u64> {
    let yearly = mul_div(u128::from(amount), u128::from(hurdle_rate_wad), WAD)?;
    to_u64(mul_div(yearly, u128::from(late_days), 365)?)
}

/// Late days of a true-up: `max(0, floor((unpaused(attested_at, now) − trueup_days × DAY) / DAY))`.
pub fn trueup_late_days(pauses: &[Pause], attested_at: u64, now: u64) -> u64 {
    unpaused(pauses, attested_at, now, now).saturating_sub(TRUEUP_S) / DAY
}

/// `FormalNoticeDue` threshold for a period: `countdown ≥ notice_s`.
pub fn formal_notice_due(countdown_s: u64) -> bool {
    countdown_s >= NOTICE_S
}

/// `FormalNoticeDue` threshold for a true-up: `unpaused ≥ trueup_s + (notice_s − grace_s)`.
pub fn trueup_notice_due(pauses: &[Pause], attested_at: u64, now: u64) -> bool {
    unpaused(pauses, attested_at, now, now) >= TRUEUP_S + (NOTICE_S - GRACE_S)
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;
    use crate::time::period_start;

    fn inputs<'a>(p: u32, pauses: &'a [Pause]) -> StatusInputs<'a> {
        StatusInputs {
            stored: SeriesStatus::OnTime,
            pauses,
            earliest_unpaid_period: p,
            trueup_due: 0,
            trueup_attested_at: 0,
        }
    }

    #[test]
    fn transitions_without_pauses() {
        let p = 8104;
        let end = period_end(p).unwrap();
        let i = inputs(p, &[]);
        assert_eq!(derive_status(&i, period_start(p).unwrap()).unwrap(), SeriesStatus::OnTime);
        assert_eq!(derive_status(&i, end + 30 * DAY).unwrap(), SeriesStatus::OnTime);
        assert_eq!(derive_status(&i, end + 30 * DAY + 1).unwrap(), SeriesStatus::InGrace);
        assert_eq!(derive_status(&i, end + 45 * DAY).unwrap(), SeriesStatus::InGrace);
        assert_eq!(derive_status(&i, end + 45 * DAY + 1).unwrap(), SeriesStatus::Late);
        assert!(is_late_underlying(&i, end + 45 * DAY + 1).unwrap());
        assert!(!is_late_underlying(&i, end + 45 * DAY).unwrap());
        assert!(formal_notice_due(countdown(&[], p, end + 90 * DAY).unwrap()));
        assert!(!formal_notice_due(countdown(&[], p, end + 90 * DAY - 1).unwrap()));
    }

    #[test]
    fn pause_stops_the_running_clock_only() {
        let p = 8104;
        let end = period_end(p).unwrap();
        // pause from deadline − 10 d for 30 d
        let pauses = [Pause {
            start: end + 20 * DAY,
            end: end + 50 * DAY,
        }];
        let i = inputs(p, &pauses);
        assert_eq!(derive_status(&i, end + 25 * DAY).unwrap(), SeriesStatus::Paused);
        // countdown at end + 50 d = 50 − 30 = 20 d → OnTime
        assert_eq!(countdown(&pauses, p, end + 50 * DAY).unwrap(), 20 * DAY);
        assert_eq!(derive_status(&i, end + 60 * DAY).unwrap(), SeriesStatus::OnTime);
        assert_eq!(derive_status(&i, end + 60 * DAY + 1).unwrap(), SeriesStatus::InGrace);
        assert_eq!(derive_status(&i, end + 75 * DAY + 1).unwrap(), SeriesStatus::Late);
        // a later obligation that starts after the pause is unaffected
        assert_eq!(countdown(&pauses, p + 1, period_end(p + 1).unwrap() + 10 * DAY).unwrap(), 10 * DAY);
        // open pause clipped at now
        let open = [Pause {
            start: end + 20 * DAY,
            end: end + 400 * DAY,
        }];
        assert_eq!(paused_within(&open, end, end + 30 * DAY, end + 30 * DAY), 10 * DAY);
    }

    #[test]
    fn pause_does_not_lift_a_release_block() {
        let p = 8104;
        let end = period_end(p).unwrap();
        let pauses = [Pause {
            start: end + 50 * DAY,
            end: end + 80 * DAY,
        }];
        let i = inputs(p, &pauses);
        // already Late when the pause starts (45 d grace)
        assert_eq!(derive_status(&i, end + 60 * DAY).unwrap(), SeriesStatus::Paused);
        assert!(is_late_underlying(&i, end + 60 * DAY).unwrap());
    }

    #[test]
    fn trueup_visible_to_status() {
        let p = 8104;
        let end = period_end(p).unwrap();
        let mut i = inputs(p, &[]);
        i.trueup_due = 1;
        i.trueup_attested_at = end;
        assert_eq!(derive_status(&i, end + 60 * DAY).unwrap(), SeriesStatus::OnTime);
        assert_eq!(derive_status(&i, end + 60 * DAY + 1).unwrap(), SeriesStatus::Late);
        assert_eq!(trueup_late_days(&[], end, end + 62 * DAY), 2);
        assert!(trueup_notice_due(&[], end, end + 105 * DAY));
        assert!(!trueup_notice_due(&[], end, end + 105 * DAY - 1));
    }

    #[test]
    fn accrual_nesting() {
        // mulDiv(mulDiv(1_000_000, 0.08e18, WAD), 73, 365) = mulDiv(80_000, 73, 365) = 16_000
        assert_eq!(late_accrual(1_000_000, 80_000_000_000_000_000, 73).unwrap(), 16_000);
        // rounding point: floor(floor(999 × 0.08) × 1 / 365) = floor(79 / 365) = 0
        assert_eq!(late_accrual(999, 80_000_000_000_000_000, 1).unwrap(), 0);
        assert_eq!(late_days_from_countdown(GRACE_S + 2 * DAY + 5), 2);
        assert_eq!(late_days_from_countdown(GRACE_S), 0);
    }

    #[test]
    fn terminal_is_sticky() {
        let mut i = inputs(8104, &[]);
        i.stored = SeriesStatus::Retired;
        assert_eq!(derive_status(&i, u64::MAX / 2).unwrap(), SeriesStatus::Retired);
    }
}
