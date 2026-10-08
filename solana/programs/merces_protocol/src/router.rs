//! Tier 1 split router (SPEC v1.1 §6.5, brief D5) with period checkpoints for tier-1 report
//! binding.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use merces_common::router::route as route_math;
use merces_common::time::{period_end, period_of, year_of};
use merces_onchain::seeds::CONFIG;
use merces_registry::program::MercesRegistry;
use merces_registry::state::{ProtocolConfig, Series, RAISE_SETTLED, TIER_FLAG_SPLIT};

use crate::common::*;
use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::state::*;

/// Records checkpoints for every period in `(last_checkpoint_period, target]`. Exact by
/// construction: every receipt closes all earlier periods first, so a period `p ≥
/// last_receipt_period` in the running year ends at `ytd_received`, and a period in a later year
/// (no receipt yet) ends at 0.
fn close_through(r: &mut Router, target: u32, series_key: Pubkey) -> Result<()> {
    let mut p = r
        .last_checkpoint_period
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    while p <= target {
        let ytd = if year_of(p) == r.ytd_year && p >= r.last_receipt_period {
            r.ytd_received
        } else {
            0
        };
        r.set_checkpoint(p, ytd);
        emit!(RouterPeriodClosed {
            series: series_key,
            period: p,
            ytd_at_end: ytd,
        });
        r.last_checkpoint_period = p;
        p = p.checked_add(1).ok_or(ProtocolError::MathOverflow)?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct InitRouter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(init, payer = payer, space = 8 + Router::INIT_SPACE, seeds = [seeds::ROUTER, series.key().as_ref()], bump)]
    pub router: Box<Account<'info, Router>>,
    /// CHECK: data-less signer PDA, router receiving-account owner.
    #[account(seeds = [seeds::ROUTER_AUTH, series.key().as_ref()], bump)]
    pub router_auth: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::ROUTER_TOKEN, series.key().as_ref()],
        bump,
        token::mint = stablecoin_mint,
        token::authority = router_auth,
        token::token_program = stablecoin_program,
    )]
    pub router_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Creates the router from the series' plaintext tier-1 terms (anyone may pay). Must happen
/// before settlement so a checkpoint exists for every reportable period.
pub fn init_router(ctx: Context<InitRouter>) -> Result<()> {
    let now = now_ts()?;
    let series = &ctx.accounts.series;
    require!(
        series.tier_flags & TIER_FLAG_SPLIT != 0,
        ProtocolError::NotTierOne
    );
    require!(
        series.raise_state < RAISE_SETTLED,
        ProtocolError::RouterTooLate
    );
    let current = period_of(now).map_err(math)?;
    let prev = current.checked_sub(1).ok_or(ProtocolError::MathOverflow)?;
    let r = &mut ctx.accounts.router;
    r.series = series.key();
    r.theta = series.router_theta;
    r.r_wad = series.router_r_wad;
    r.ytd_year = year_of(current);
    r.ytd_received = 0;
    r.last_receipt_period = current;
    r.last_checkpoint_period = prev;
    r.set_checkpoint(prev, 0);
    r.bump = ctx.bumps.router;
    Ok(())
}

#[derive(Accounts)]
pub struct Route<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut, seeds = [seeds::ROUTER, series.key().as_ref()], bump = router.bump)]
    pub router: Box<Account<'info, Router>>,
    /// CHECK: data-less signer PDA, router receiving-account owner.
    #[account(seeds = [seeds::ROUTER_AUTH, series.key().as_ref()], bump)]
    pub router_auth: UncheckedAccount<'info>,
    #[account(mut, seeds = [seeds::ROUTER_TOKEN, series.key().as_ref()], bump)]
    pub router_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::VAULT_TOKEN, series.key().as_ref()], bump)]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less signer PDA, vault owner.
    #[account(seeds = [seeds::VAULT_AUTH, series.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    /// CHECK: the series issuer (pass-through destination owner).
    #[account(address = series.issuer @ ProtocolError::NotIssuer)]
    pub issuer: UncheckedAccount<'info>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = issuer, token::token_program = stablecoin_program)]
    pub issuer_stable_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = config.fee_collector, token::token_program = stablecoin_program)]
    pub fee_collector_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_AUTHORITY], bump)]
    pub registry_authority: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
    pub system_program: Program<'info, System>,
}

/// `route` / `sweep` (SPEC §6.5): sweeps the router's receiving account. Income below the annual
/// threshold passes through; above it `r × units_outstanding` of each receipt goes to the vault and
/// is credited against the quarter's report. In a terminal status everything passes through.
pub fn route<'info>(ctx: Context<'info, Route<'info>>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let status = ledger.sync_status(now, series_key)?;
    require!(ledger.is_mint_finalized(), ProtocolError::MintNotFinalized);
    let amount = ctx.accounts.router_token.amount;
    require!(amount > 0, ProtocolError::NothingToRoute);
    let series = &ctx.accounts.series;
    let stable_program = ctx.accounts.stablecoin_program.key();
    require_ata(
        &ctx.accounts.issuer_stable_ata.to_account_info(),
        &series.issuer,
        &series.stablecoin,
        &stable_program,
    )?;
    require_ata(
        &ctx.accounts.fee_collector_ata.to_account_info(),
        &ctx.accounts.config.fee_collector,
        &series.stablecoin,
        &stable_program,
    )?;
    let current = period_of(now).map_err(math)?;
    let router = &mut ctx.accounts.router;
    // close_period_if_needed()
    if router.last_receipt_period < current {
        close_through(
            router,
            current.checked_sub(1).ok_or(ProtocolError::MathOverflow)?,
            series_key,
        )?;
    }
    let year = year_of(current);
    if router.ytd_year != year {
        router.ytd_year = year;
        router.ytd_received = 0;
    }
    let units = ledger.units_outstanding;
    let mut out = route_math(
        amount,
        router.theta,
        router.r_wad,
        units,
        router.ytd_received,
    )
    .map_err(math)?;
    if status.is_terminal() {
        out.routed = 0;
        out.pass_through = amount;
    }
    router.ytd_received = out.ytd_received;
    router.last_receipt_period = current;

    let decimals = series.stablecoin_decimals;
    let fee_bps = series.payout_fee_bps;
    let token_program = ctx.accounts.stablecoin_program.to_account_info();
    let mint = ctx.accounts.stablecoin_mint.to_account_info();
    let router_token = ctx.accounts.router_token.to_account_info();
    let router_bump = [ctx.bumps.router_auth];
    let router_seeds: &[&[u8]] = &[seeds::ROUTER_AUTH, series_key.as_ref(), &router_bump];
    let router_auth = ctx.accounts.router_auth.to_account_info();

    transfer_stable(
        &token_program,
        &router_token,
        &mint,
        &ctx.accounts.issuer_stable_ata.to_account_info(),
        &router_auth,
        ctx.remaining_accounts,
        out.pass_through,
        decimals,
        &[router_seeds],
    )?;

    if out.routed > 0 {
        transfer_stable(
            &token_program,
            &router_token,
            &mint,
            &ctx.accounts.vault_token.to_account_info(),
            &router_auth,
            ctx.remaining_accounts,
            out.routed,
            decimals,
            &[router_seeds],
        )?;
        let cap = cap_per_unit_of(series)?;
        let rec = ledger.receive_gross(SOURCE_ROUTER, out.routed, cap, now, fee_bps, series_key)?;
        let vault_bump = [ctx.bumps.vault_auth];
        let vault_seeds: &[&[u8]] = &[seeds::VAULT_AUTH, series_key.as_ref(), &vault_bump];
        let vault = ctx.accounts.vault_token.to_account_info();
        let vault_auth = ctx.accounts.vault_auth.to_account_info();
        transfer_stable(
            &token_program,
            &vault,
            &mint,
            &ctx.accounts.fee_collector_ata.to_account_info(),
            &vault_auth,
            ctx.remaining_accounts,
            rec.fee,
            decimals,
            &[vault_seeds],
        )?;
        transfer_stable(
            &token_program,
            &vault,
            &mint,
            &ctx.accounts.issuer_stable_ata.to_account_info(),
            &vault_auth,
            ctx.remaining_accounts,
            rec.refund,
            decimals,
            &[vault_seeds],
        )?;
        ledger.router_credit = ledger
            .router_credit
            .checked_add(rec.accepted)
            .ok_or(ProtocolError::MathOverflow)?;
        if rec.capped {
            let registry = RegistryCpi {
                registry_program: ctx.accounts.registry_program.to_account_info(),
                config: ctx.accounts.config.to_account_info(),
                series: ctx.accounts.series.to_account_info(),
                registry_authority: ctx.accounts.registry_authority.to_account_info(),
                authority_bump: ctx.bumps.registry_authority,
            };
            retire(&mut ledger, &registry, series_key, rec.refund)?;
        }
    }
    emit!(IncomeRouted {
        series: series_key,
        amount,
        pass_through: out.pass_through,
        routed: out.routed,
        ytd_received: out.ytd_received,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseRouterPeriod<'info> {
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::ROUTER, series.key().as_ref()], bump = router.bump)]
    pub router: Box<Account<'info, Router>>,
}

/// `close_router_period(series, period)` (SPEC §6.5): records the checkpoint for `period` (and
/// any earlier missing ones) once the period has ended.
pub fn close_router_period(ctx: Context<CloseRouterPeriod>, period: u32) -> Result<()> {
    let now = now_ts()?;
    require!(
        now >= period_end(period).map_err(math)?,
        ProtocolError::RouterPeriodNotEnded
    );
    let series_key = ctx.accounts.series.key();
    let router = &mut ctx.accounts.router;
    require!(
        period > router.last_checkpoint_period,
        ProtocolError::RouterPeriodAlreadyClosed
    );
    close_through(router, period, series_key)
}
