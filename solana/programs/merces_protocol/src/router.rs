//! Tier 1 split router (SPEC §6.5, brief D5).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use merces_common::router::route as route_math;
use merces_common::status::SeriesStatus;
use merces_common::time::{period_of, year_of};
use merces_onchain::seeds::CONFIG;
use merces_registry::program::MercesRegistry;
use merces_registry::state::{ProtocolConfig, Series};

use crate::common::*;
use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::state::*;

#[derive(Accounts)]
pub struct InitRouter<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(init, payer = issuer, space = 8 + Router::INIT_SPACE, seeds = [seeds::ROUTER, series.key().as_ref()], bump)]
    pub router: Box<Account<'info, Router>>,
    /// CHECK: data-less signer PDA, router receiving-account owner.
    #[account(seeds = [seeds::ROUTER_AUTH, series.key().as_ref()], bump)]
    pub router_auth: UncheckedAccount<'info>,
    #[account(
        init,
        payer = issuer,
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

/// Tier-1 series publish `theta` and `r_wad` in plaintext by the issuer's explicit choice (A22).
pub fn init_router(ctx: Context<InitRouter>, theta: u64, r_wad: u64) -> Result<()> {
    let series = &ctx.accounts.series;
    require!(
        series.tier_flags & (1 << (TIER_SPLIT - 1)) != 0,
        ProtocolError::NotTierOne
    );
    let r = &mut ctx.accounts.router;
    r.series = series.key();
    r.theta = theta;
    r.r_wad = r_wad;
    r.ytd_year = 0;
    r.ytd_received = 0;
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
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
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
    #[account(
        mut,
        associated_token::mint = stablecoin_mint,
        associated_token::authority = issuer,
        associated_token::token_program = stablecoin_program,
    )]
    pub issuer_stable_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the configured fee collector wallet.
    #[account(address = config.fee_collector @ ProtocolError::FeeCollectorMismatch)]
    pub fee_collector: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = stablecoin_mint,
        associated_token::authority = fee_collector,
        associated_token::token_program = stablecoin_program,
    )]
    pub fee_collector_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_SIGNER], bump)]
    pub registry_signer: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
    pub system_program: Program<'info, System>,
}

/// `route` (SPEC §6.5): sweeps the router's receiving account. Income below the annual threshold
/// passes through; above it `r × units` of each receipt goes to the vault and is credited against
/// the quarter's report.
pub fn route<'info>(ctx: Context<'info, Route<'info>>) -> Result<()> {
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let status = ctx.accounts.ledger.sync_status(now, series_key)?;
    require!(!status.is_terminal(), ProtocolError::SeriesTerminal);
    let amount = ctx.accounts.router_token.amount;
    require!(amount > 0, ProtocolError::NothingToRoute);
    let year = year_of(period_of(now).map_err(math)?);
    let router = &mut ctx.accounts.router;
    if router.ytd_year != year {
        router.ytd_year = year;
        router.ytd_received = 0;
    }
    let units = ctx.accounts.unit_mint.supply;
    let out = route_math(
        amount,
        router.theta,
        router.r_wad,
        units,
        router.ytd_received,
    )
    .map_err(math)?;
    router.ytd_received = out.ytd_received;

    let decimals = ctx.accounts.series.stablecoin_decimals;
    let fee_bps = ctx.accounts.series.payout_fee_bps;
    let token_program = ctx.accounts.stablecoin_program.to_account_info();
    let mint = ctx.accounts.stablecoin_mint.to_account_info();
    let router_token = ctx.accounts.router_token.to_account_info();
    let router_bump = [ctx.bumps.router_auth];
    let router_seeds: &[&[u8]] = &[seeds::ROUTER_AUTH, series_key.as_ref(), &router_bump];
    let router_auth = ctx.accounts.router_auth.to_account_info();

    // pass-through to the issuer
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
        // gross share to the vault, then the ledger receipt (cap truncation refunds the issuer)
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
        let rec = ctx.accounts.ledger.receive_gross(
            SOURCE_ROUTER,
            out.routed,
            units,
            fee_bps,
            now,
            series_key,
        )?;
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
        let ledger = &mut ctx.accounts.ledger;
        ledger.router_credit = ledger
            .router_credit
            .checked_add(rec.accepted)
            .ok_or(ProtocolError::MathOverflow)?;
        if rec.retired {
            ledger.open_due_amount = 0;
            ledger.open_due_period = None;
            ledger.trueup_due = 0;
            RegistryCpi {
                registry_program: ctx.accounts.registry_program.to_account_info(),
                config: ctx.accounts.config.to_account_info(),
                series: ctx.accounts.series.to_account_info(),
                protocol_signer: ctx.accounts.registry_signer.to_account_info(),
                signer_bump: ctx.bumps.registry_signer,
            }
            .mark_terminal(SeriesStatus::Retired)?;
            emit!(SeriesRetired {
                series: series_key,
                paid_per_unit_wad: ledger.paid_per_unit_wad,
                refund: rec.refund,
            });
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
