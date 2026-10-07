//! Treasury (SPEC §5.3): scheduled releases, issuer pause, early-draw hook.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use merces_common::params::Tranche;
use merces_common::status::SeriesStatus;
use merces_common::treasury::claimable;
use merces_onchain::seeds::CONFIG;
use merces_registry::state::{ProtocolConfig, Series};

use crate::common::*;
use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::state::*;

#[derive(Accounts)]
pub struct ClaimRelease<'info> {
    pub issuer: Signer<'info>,
    #[account(constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::TREASURY, series.key().as_ref()], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(mut, seeds = [seeds::TREASURY_TOKEN, series.key().as_ref()], bump)]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less signer PDA, treasury owner.
    #[account(seeds = [seeds::TREASURY_AUTH, series.key().as_ref()], bump)]
    pub treasury_auth: UncheckedAccount<'info>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = issuer, token::token_program = stablecoin_program)]
    pub issuer_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
}

/// `claim_release` (SPEC §5.3): `amount = min(vested(now), proceeds) − released_total`. Blocked
/// only by the issuer's own pause, the derived `Late` status, or extinguishment (C11 §1).
pub fn claim_release<'info>(ctx: Context<'info, ClaimRelease<'info>>) -> Result<()> {
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    let t = &ctx.accounts.treasury;
    require!(t.finalized, ProtocolError::MintNotFinalized);
    require!(
        !t.issuer_paused_releases,
        ProtocolError::ReleasesPausedByIssuer
    );
    let status = ctx.accounts.ledger.sync_status(now, series_key)?;
    require!(
        status != SeriesStatus::Extinguished,
        ProtocolError::SeriesExtinguished
    );
    require!(status != SeriesStatus::Late, ProtocolError::SeriesLate);
    let schedule: Vec<Tranche> = series
        .release_schedule
        .iter()
        .map(|x| Tranche::from(*x))
        .collect();
    let amount = claimable(
        t.proceeds,
        &schedule,
        ctx.accounts.ledger.settlement_ts,
        now,
        t.released_total,
    )
    .map_err(math)?;
    require!(amount > 0, ProtocolError::NothingToRelease);
    let bump = [ctx.bumps.treasury_auth];
    let auth_seeds: &[&[u8]] = &[seeds::TREASURY_AUTH, series_key.as_ref(), &bump];
    transfer_stable(
        &ctx.accounts.stablecoin_program.to_account_info(),
        &ctx.accounts.treasury_token.to_account_info(),
        &ctx.accounts.stablecoin_mint.to_account_info(),
        &ctx.accounts.issuer_stable.to_account_info(),
        &ctx.accounts.treasury_auth.to_account_info(),
        ctx.remaining_accounts,
        amount,
        series.stablecoin_decimals,
        &[auth_seeds],
    )?;
    let t = &mut ctx.accounts.treasury;
    t.released_total = t
        .released_total
        .checked_add(amount)
        .ok_or(ProtocolError::MathOverflow)?;
    emit!(ReleaseClaimed {
        series: series_key,
        amount,
        released_total: t.released_total,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetReleasePause<'info> {
    pub issuer: Signer<'info>,
    #[account(constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::TREASURY, series.key().as_ref()], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
}

pub fn set_release_pause(ctx: Context<SetReleasePause>, paused: bool) -> Result<()> {
    ctx.accounts.treasury.issuer_paused_releases = paused;
    emit!(ReleasePauseSet {
        series: ctx.accounts.series.key(),
        paused,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RequestEarlyDraw<'info> {
    pub issuer: Signer<'info>,
    /// The configured early-draw approver must co-sign (SPEC §5.3). Unset by default.
    pub approver: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::TREASURY, series.key().as_ref()], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(mut, seeds = [seeds::TREASURY_TOKEN, series.key().as_ref()], bump)]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less signer PDA, treasury owner.
    #[account(seeds = [seeds::TREASURY_AUTH, series.key().as_ref()], bump)]
    pub treasury_auth: UncheckedAccount<'info>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = issuer, token::token_program = stablecoin_program)]
    pub issuer_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
}

/// Early draw (brief R7/D4): switched off while `early_draw_approver` is unset. Counts against
/// vesting (`released_total`), never beyond `proceeds`.
pub fn request_early_draw<'info>(
    ctx: Context<'info, RequestEarlyDraw<'info>>,
    amount: u64,
) -> Result<()> {
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let approver = ctx.accounts.config.early_draw_approver;
    require_keys_neq!(
        approver,
        Pubkey::default(),
        ProtocolError::EarlyDrawApproverUnset
    );
    require_keys_eq!(
        ctx.accounts.approver.key(),
        approver,
        ProtocolError::EarlyDrawApproverMismatch
    );
    let t = &ctx.accounts.treasury;
    require!(t.finalized, ProtocolError::MintNotFinalized);
    require!(amount > 0, ProtocolError::NothingToRelease);
    let status = ctx.accounts.ledger.sync_status(now, series_key)?;
    require!(
        status != SeriesStatus::Extinguished,
        ProtocolError::SeriesExtinguished
    );
    let new_total = t
        .released_total
        .checked_add(amount)
        .ok_or(ProtocolError::MathOverflow)?;
    require!(
        new_total <= t.proceeds,
        ProtocolError::EarlyDrawExceedsProceeds
    );
    let bump = [ctx.bumps.treasury_auth];
    let auth_seeds: &[&[u8]] = &[seeds::TREASURY_AUTH, series_key.as_ref(), &bump];
    transfer_stable(
        &ctx.accounts.stablecoin_program.to_account_info(),
        &ctx.accounts.treasury_token.to_account_info(),
        &ctx.accounts.stablecoin_mint.to_account_info(),
        &ctx.accounts.issuer_stable.to_account_info(),
        &ctx.accounts.treasury_auth.to_account_info(),
        ctx.remaining_accounts,
        amount,
        ctx.accounts.series.stablecoin_decimals,
        &[auth_seeds],
    )?;
    let t = &mut ctx.accounts.treasury;
    t.released_total = new_total;
    t.early_draw_total = t
        .early_draw_total
        .checked_add(amount)
        .ok_or(ProtocolError::MathOverflow)?;
    emit!(EarlyDrawExecuted {
        series: series_key,
        amount,
        approver,
    });
    Ok(())
}
