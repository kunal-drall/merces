//! Rate accumulator (SPEC v1.1 §6.6, brief C9) fed by Pyth `PriceUpdateV2` accounts.

use anchor_lang::prelude::*;
use merces_common::fx::{conf_ok, deviates, invert, normalize};
use merces_common::time::{day_of, period_of};
use merces_onchain::seeds::{CONFIG, FX};
use merces_registry::state::{FxPairConfig, ProtocolConfig};
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::common::*;
use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::state::*;

#[derive(Accounts)]
#[instruction(pair_id: [u8; 32])]
pub struct InitFxPair<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [FX, pair_id.as_ref()], bump = pair_config.bump, seeds::program = merces_registry::ID)]
    pub pair_config: Box<Account<'info, FxPairConfig>>,
    #[account(init, payer = payer, space = 8 + FxPair::INIT_SPACE, seeds = [seeds::FX_PAIR, pair_id.as_ref()], bump)]
    pub pair: Box<Account<'info, FxPair>>,
    pub system_program: Program<'info, System>,
}

/// Creates the accumulator for a registry-configured pair (anyone may pay for it). A disabled
/// pair still gets an accumulator: `enabled` only gates new series (SPEC §3.1).
pub fn init_fx_pair(ctx: Context<InitFxPair>, pair_id: [u8; 32]) -> Result<()> {
    let p = &mut ctx.accounts.pair;
    p.pair_id = pair_id;
    p.sum_wad = 0;
    p.count = 0;
    p.last_day = 0;
    p.bump = ctx.bumps.pair;
    Ok(())
}

#[derive(Accounts)]
#[instruction(period: u32)]
pub struct SnapshotFx<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [FX, pair.pair_id.as_ref()], bump = pair_config.bump, seeds::program = merces_registry::ID)]
    pub pair_config: Box<Account<'info, FxPairConfig>>,
    #[account(mut, seeds = [seeds::FX_PAIR, pair.pair_id.as_ref()], bump = pair.bump)]
    pub pair: Box<Account<'info, FxPair>>,
    /// Checkpoint for the current period, created on the first snapshot of the period.
    #[account(
        init_if_needed,
        payer = keeper,
        space = 8 + FxCheckpoint::INIT_SPACE,
        seeds = [seeds::FX_CHECKPOINT, pair.pair_id.as_ref(), period.to_le_bytes().as_ref()],
        bump
    )]
    pub checkpoint: Box<Account<'info, FxCheckpoint>>,
    /// Owner (Pyth receiver program) and discriminator checked by Anchor.
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
    /// The cross-check feed's update (the pair's `crosscheck`, read as a Pyth feed id); required
    /// once a cross-check is configured and effective for the period.
    pub crosscheck_update: Option<Box<Account<'info, PriceUpdateV2>>>,
    pub system_program: Program<'info, System>,
}

/// `snapshot` (SPEC §6.6): one per UTC day per pair; validates the Pyth update (full verification,
/// feed id, staleness, confidence), normalises the rate to WAD, writes the period checkpoint on the
/// first snapshot of a quarter, and adds to the running sum. Staleness and confidence bounds are the
/// protocol defaults (the accumulator is shared by every series of the pair). Snapshots stay
/// permissionless for disabled pairs (live series keep their pair, SPEC §3.1).
pub fn snapshot_fx(ctx: Context<SnapshotFx>, period: u32) -> Result<()> {
    let now = now_ts()?;
    require!(
        period == period_of(now).map_err(math)?,
        ProtocolError::WrongPeriod
    );
    let day = day_of(now);
    let defaults = ctx.accounts.config.defaults;
    let cfg = &ctx.accounts.pair_config;
    let pair = &mut ctx.accounts.pair;
    require!(
        pair.count == 0 || day > pair.last_day,
        ProtocolError::SnapshotAlreadyTaken
    );

    // 1. Pyth validation
    let update = &ctx.accounts.price_update;
    require!(
        update.verification_level == VerificationLevel::Full,
        ProtocolError::InsufficientVerification
    );
    let msg = &update.price_message;
    require!(msg.feed_id == cfg.feed_id, ProtocolError::FeedIdMismatch);
    let publish_time = u64::try_from(msg.publish_time).map_err(|_| ProtocolError::PriceStale)?;
    require!(
        publish_time
            .checked_add(defaults.fx_max_staleness_seconds)
            .ok_or(ProtocolError::MathOverflow)?
            >= now,
        ProtocolError::PriceStale
    );
    require!(msg.price > 0, ProtocolError::PriceNotPositive);
    require!(
        conf_ok(msg.price, msg.conf, defaults.fx_max_conf_bps).map_err(math)?,
        ProtocolError::ConfidenceTooWide
    );

    // 2. normalise
    let mut rate_wad = normalize(msg.price, msg.exponent).map_err(math)?;
    if cfg.inverted {
        rate_wad = invert(rate_wad).map_err(math)?;
    }

    // 3. checkpoint before adding (first snapshot in the period closes the previous one)
    let cp = &mut ctx.accounts.checkpoint;
    if cp.pair_id == [0u8; 32] {
        cp.pair_id = pair.pair_id;
        cp.period = period;
        cp.sum_wad = pair.sum_wad;
        cp.count = pair.count;
        cp.flagged = false;
        cp.bump = ctx.bumps.checkpoint;
    }
    // 4. cross-check: a second Pyth feed (no Chainlink on Solana); a deviation above the band
    //    flags the period so its average needs a fallback. The feed in force for this period is
    //    `crosscheck` from its effective period on, `prev_crosscheck` before (SPEC §3.1).
    let crosscheck = if period >= cfg.crosscheck_effective_period {
        cfg.crosscheck
    } else {
        cfg.prev_crosscheck
    };
    if crosscheck != Pubkey::default() {
        let cl = ctx
            .accounts
            .crosscheck_update
            .as_ref()
            .ok_or(ProtocolError::CrosscheckRequired)?;
        require!(
            cl.verification_level == VerificationLevel::Full,
            ProtocolError::InsufficientVerification
        );
        let m = &cl.price_message;
        require!(
            m.feed_id == crosscheck.to_bytes(),
            ProtocolError::FeedIdMismatch
        );
        let cl_time = u64::try_from(m.publish_time).map_err(|_| ProtocolError::PriceStale)?;
        require!(
            cl_time
                .checked_add(defaults.fx_max_staleness_seconds)
                .ok_or(ProtocolError::MathOverflow)?
                >= now,
            ProtocolError::PriceStale
        );
        require!(m.price > 0, ProtocolError::PriceNotPositive);
        let mut cl_wad = normalize(m.price, m.exponent).map_err(math)?;
        if cfg.inverted {
            cl_wad = invert(cl_wad).map_err(math)?;
        }
        if deviates(rate_wad, cl_wad, defaults.fx_deviation_band_bps).map_err(math)? {
            cp.flagged = true;
            emit!(FxDeviationFlagged {
                pair: pair.pair_id,
                period,
                rate_wad,
                crosscheck_wad: cl_wad,
            });
        }
    } // 5. accumulate
    pair.sum_wad = pair
        .sum_wad
        .checked_add(u128::from(rate_wad))
        .ok_or(ProtocolError::MathOverflow)?;
    pair.count = pair
        .count
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    pair.last_day = day;
    emit!(FxSnapshot {
        pair: pair.pair_id,
        day,
        rate_wad,
        sum_wad: pair.sum_wad,
        count: pair.count,
    });
    Ok(())
}
