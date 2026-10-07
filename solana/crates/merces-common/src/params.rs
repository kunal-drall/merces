//! Parameter defaults and bounds (SPEC §1.6). Enforced at series creation and on `set_defaults`.

use crate::{time, MathError, MathResult};

/// Every §1.6 parameter. Fixed-by-brief values (`report_due_days`, `grace_days`,
/// `formal_notice_days`, `trueup_days`, `tail_seconds`, `max_release_tranches`) are constants
/// below, not fields, because the brief does not allow them to vary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Parameters {
    pub cap_multiple_wad: u64,
    pub hurdle_rate_wad: u64,
    pub payout_multiple_k: u16,
    pub lockup_seconds: u64,
    pub wallet_cap_bps: u16,
    pub auction_fee_bps: u16,
    pub payout_fee_bps: u16,
    pub window_fee_bps: u16,
    pub non_reveal_charge_bps: u16,
    pub commit_duration: u64,
    pub reveal_duration: u64,
    pub window_commit_duration: u64,
    pub window_reveal_duration: u64,
    pub fx_min_coverage_bps: u16,
    pub fx_max_staleness_seconds: u64,
    pub fx_max_conf_bps: u16,
    pub fx_deviation_band_bps: u16,
}

pub const REPORT_DUE_DAYS: u64 = 30;
pub const GRACE_DAYS: u64 = 15;
pub const FORMAL_NOTICE_DAYS: u64 = 90;
pub const TRUEUP_DAYS: u64 = 60;
pub const TAIL_SECONDS: u64 = time::YEAR;
pub const MAX_RELEASE_TRANCHES: usize = 24;
pub const MAX_YEAR_BUCKETS: usize = 64;

pub const HOUR: u64 = 3_600;

impl Parameters {
    /// SPEC §1.6 defaults.
    pub const DEFAULT: Parameters = Parameters {
        cap_multiple_wad: 2_500_000_000_000_000_000,
        hurdle_rate_wad: 80_000_000_000_000_000,
        payout_multiple_k: 5,
        lockup_seconds: time::EIGHTEEN_MONTHS,
        wallet_cap_bps: 1_000,
        auction_fee_bps: 100,
        payout_fee_bps: 500,
        window_fee_bps: 100,
        non_reveal_charge_bps: 100,
        commit_duration: 7 * time::DAY,
        reveal_duration: 2 * time::DAY,
        window_commit_duration: 3 * time::DAY,
        window_reveal_duration: time::DAY,
        fx_min_coverage_bps: 8_000,
        fx_max_staleness_seconds: 3_600,
        fx_max_conf_bps: 100,
        fx_deviation_band_bps: 200,
    };

    /// Bounds check per §1.6. Returns `InvalidInput` naming nothing: callers report the
    /// field through their own error code by calling [`Parameters::first_violation`].
    pub fn validate(&self) -> MathResult<()> {
        match self.first_violation() {
            None => Ok(()),
            Some(_) => Err(MathError::InvalidInput),
        }
    }

    /// The first parameter outside its bounds, if any.
    pub fn first_violation(&self) -> Option<ParamField> {
        let r = |ok: bool, f: ParamField| if ok { None } else { Some(f) };
        r(
            (2_000_000_000_000_000_000..=3_000_000_000_000_000_000)
                .contains(&self.cap_multiple_wad),
            ParamField::CapMultiple,
        )
        .or(r(
            self.hurdle_rate_wad <= 250_000_000_000_000_000,
            ParamField::HurdleRate,
        ))
        .or(r(
            (1..=20).contains(&self.payout_multiple_k),
            ParamField::PayoutMultiple,
        ))
        .or(r(self.lockup_seconds <= 157_680_000, ParamField::Lockup))
        .or(r(
            (100..=10_000).contains(&self.wallet_cap_bps),
            ParamField::WalletCap,
        ))
        .or(r(self.auction_fee_bps <= 1_000, ParamField::AuctionFee))
        .or(r(self.payout_fee_bps <= 2_000, ParamField::PayoutFee))
        .or(r(self.window_fee_bps <= 1_000, ParamField::WindowFee))
        .or(r(
            self.non_reveal_charge_bps <= 1_000,
            ParamField::NonRevealCharge,
        ))
        .or(r(
            (HOUR..=30 * time::DAY).contains(&self.commit_duration),
            ParamField::CommitDuration,
        ))
        .or(r(
            (HOUR..=7 * time::DAY).contains(&self.reveal_duration),
            ParamField::RevealDuration,
        ))
        .or(r(
            (HOUR..=14 * time::DAY).contains(&self.window_commit_duration),
            ParamField::WindowCommitDuration,
        ))
        .or(r(
            (HOUR..=7 * time::DAY).contains(&self.window_reveal_duration),
            ParamField::WindowRevealDuration,
        ))
        .or(r(
            (5_000..=10_000).contains(&self.fx_min_coverage_bps),
            ParamField::FxMinCoverage,
        ))
        .or(r(
            (60..=86_400).contains(&self.fx_max_staleness_seconds),
            ParamField::FxMaxStaleness,
        ))
        .or(r(
            (1..=1_000).contains(&self.fx_max_conf_bps),
            ParamField::FxMaxConf,
        ))
        .or(r(
            (10..=5_000).contains(&self.fx_deviation_band_bps),
            ParamField::FxDeviationBand,
        ))
    }
}

/// Identifies the parameter that violated its bound.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamField {
    CapMultiple,
    HurdleRate,
    PayoutMultiple,
    Lockup,
    WalletCap,
    AuctionFee,
    PayoutFee,
    WindowFee,
    NonRevealCharge,
    CommitDuration,
    RevealDuration,
    WindowCommitDuration,
    WindowRevealDuration,
    FxMinCoverage,
    FxMaxStaleness,
    FxMaxConf,
    FxDeviationBand,
}

/// One release tranche: `bps` of the proceeds vest at `settlement_ts + at_offset_seconds`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tranche {
    pub at_offset_seconds: u64,
    pub bps: u16,
}

/// Release-schedule validation (SPEC §3.1): 1..=24 tranches, bps sum exactly 10 000,
/// offsets non-decreasing.
pub fn validate_schedule(schedule: &[Tranche]) -> MathResult<()> {
    if schedule.is_empty() || schedule.len() > MAX_RELEASE_TRANCHES {
        return Err(MathError::InvalidInput);
    }
    let mut sum: u64 = 0;
    let mut last_offset: u64 = 0;
    for t in schedule {
        if t.at_offset_seconds < last_offset {
            return Err(MathError::InvalidInput);
        }
        last_offset = t.at_offset_seconds;
        sum = sum
            .checked_add(u64::from(t.bps))
            .ok_or(MathError::Overflow)?;
    }
    if sum != crate::BPS_DENOMINATOR {
        return Err(MathError::InvalidInput);
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_in_bounds() {
        assert_eq!(Parameters::DEFAULT.first_violation(), None);
        assert!(Parameters::DEFAULT.validate().is_ok());
    }

    #[test]
    fn each_bound_is_enforced() {
        let mut p = Parameters::DEFAULT;
        p.cap_multiple_wad = 1_999_999_999_999_999_999;
        assert_eq!(p.first_violation(), Some(ParamField::CapMultiple));
        p = Parameters::DEFAULT;
        p.cap_multiple_wad = 3_000_000_000_000_000_001;
        assert_eq!(p.first_violation(), Some(ParamField::CapMultiple));
        p = Parameters::DEFAULT;
        p.hurdle_rate_wad = 250_000_000_000_000_001;
        assert_eq!(p.first_violation(), Some(ParamField::HurdleRate));
        p = Parameters::DEFAULT;
        p.payout_multiple_k = 0;
        assert_eq!(p.first_violation(), Some(ParamField::PayoutMultiple));
        p.payout_multiple_k = 21;
        assert_eq!(p.first_violation(), Some(ParamField::PayoutMultiple));
        p = Parameters::DEFAULT;
        p.lockup_seconds = 157_680_001;
        assert_eq!(p.first_violation(), Some(ParamField::Lockup));
        p = Parameters::DEFAULT;
        p.wallet_cap_bps = 99;
        assert_eq!(p.first_violation(), Some(ParamField::WalletCap));
        p = Parameters::DEFAULT;
        p.auction_fee_bps = 1_001;
        assert_eq!(p.first_violation(), Some(ParamField::AuctionFee));
        p = Parameters::DEFAULT;
        p.payout_fee_bps = 2_001;
        assert_eq!(p.first_violation(), Some(ParamField::PayoutFee));
        p = Parameters::DEFAULT;
        p.window_fee_bps = 1_001;
        assert_eq!(p.first_violation(), Some(ParamField::WindowFee));
        p = Parameters::DEFAULT;
        p.non_reveal_charge_bps = 1_001;
        assert_eq!(p.first_violation(), Some(ParamField::NonRevealCharge));
        p = Parameters::DEFAULT;
        p.commit_duration = 3_599;
        assert_eq!(p.first_violation(), Some(ParamField::CommitDuration));
        p = Parameters::DEFAULT;
        p.reveal_duration = 7 * time::DAY + 1;
        assert_eq!(p.first_violation(), Some(ParamField::RevealDuration));
        p = Parameters::DEFAULT;
        p.window_commit_duration = 14 * time::DAY + 1;
        assert_eq!(p.first_violation(), Some(ParamField::WindowCommitDuration));
        p = Parameters::DEFAULT;
        p.window_reveal_duration = 0;
        assert_eq!(p.first_violation(), Some(ParamField::WindowRevealDuration));
        p = Parameters::DEFAULT;
        p.fx_min_coverage_bps = 4_999;
        assert_eq!(p.first_violation(), Some(ParamField::FxMinCoverage));
        p = Parameters::DEFAULT;
        p.fx_max_staleness_seconds = 59;
        assert_eq!(p.first_violation(), Some(ParamField::FxMaxStaleness));
        p = Parameters::DEFAULT;
        p.fx_max_conf_bps = 0;
        assert_eq!(p.first_violation(), Some(ParamField::FxMaxConf));
        p = Parameters::DEFAULT;
        p.fx_deviation_band_bps = 9;
        assert_eq!(p.first_violation(), Some(ParamField::FxDeviationBand));
    }

    #[test]
    fn schedule_validation() {
        assert!(validate_schedule(&[]).is_err());
        assert!(validate_schedule(&[Tranche {
            at_offset_seconds: 0,
            bps: 10_000
        }])
        .is_ok());
        assert!(validate_schedule(&[
            Tranche {
                at_offset_seconds: 0,
                bps: 5_000
            },
            Tranche {
                at_offset_seconds: 10,
                bps: 5_000
            }
        ])
        .is_ok());
        // sum != 10000
        assert!(validate_schedule(&[Tranche {
            at_offset_seconds: 0,
            bps: 9_999
        }])
        .is_err());
        // decreasing offsets
        assert!(validate_schedule(&[
            Tranche {
                at_offset_seconds: 10,
                bps: 5_000
            },
            Tranche {
                at_offset_seconds: 9,
                bps: 5_000
            }
        ])
        .is_err());
        // too many
        let many = [Tranche {
            at_offset_seconds: 0,
            bps: 400,
        }; 25];
        assert!(validate_schedule(&many).is_err());
    }
}
