//! Redemption (SPEC v1.1 §6.7) and extinguishment (SPEC v1.1 §6.9).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use merces_common::encoding::extinguish_message;
use merces_common::redemption::{redemption_price, RedemptionInputs};
use merces_common::status::SeriesStatus;
use merces_common::time::period_of;
use merces_common::treasury::vested;
use merces_common::vault::scaled_amount;
use merces_onchain::keccak;
use merces_onchain::seeds::CONFIG;
use merces_registry::program::MercesRegistry;
use merces_registry::state::{ProtocolConfig, Series, RAISE_SETTLED};

use crate::common::*;
use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::income::{require_active_attestor, require_signer};
use crate::state::*;

// --------------------------------------------------------------------------------------- redeem

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = issuer, token::token_program = stablecoin_program)]
    pub issuer_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::VAULT_TOKEN, series.key().as_ref()], bump)]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_AUTHORITY], bump)]
    pub registry_authority: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
}

/// `redeem` (SPEC §6.7): issuer only, after lockup, with every own obligation met. Never
/// blockable by anyone else (C7). No fee. A series with nothing left under the cap retires instead.
pub fn redeem<'info>(ctx: Context<'info, Redeem<'info>>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    require!(
        series.raise_state == RAISE_SETTLED,
        ProtocolError::RaiseNotSettled
    );
    require!(ledger.is_mint_finalized(), ProtocolError::MintNotFinalized);
    let status = ledger.sync_status(now, series_key)?;
    // the issuer's own obligations only (SPEC §6.7, A15): status ∈ {OnTime, InGrace, Paused}
    require!(!status.is_terminal(), ProtocolError::TerminalStatus);
    require!(status != SeriesStatus::Late, ProtocolError::SeriesLate);
    let unlock = ledger
        .settlement_ts
        .checked_add(series.lockup_seconds)
        .ok_or(ProtocolError::MathOverflow)?;
    require!(now >= unlock, ProtocolError::LockupActive);
    require!(ledger.open_due_amount == 0, ProtocolError::DueOutstanding);
    require!(ledger.trueup_due == 0, ProtocolError::TrueUpOutstanding);
    let current = period_of(now).map_err(math)?;
    if let Some(prev) = current.checked_sub(1) {
        if prev >= ledger.first_period {
            require!(
                matches!(ledger.last_accepted_period(), Some(p) if p >= prev),
                ProtocolError::UnreportedPeriods
            );
        }
    }
    // curve mode: the units snapshot is taken now from the eight census accounts passed as
    // remaining accounts (CURVE_MODE §4, §7), so the deposit covers every unit outstanding at
    // redemption; USDC has no transfer hook, so no stablecoin hook accounts follow
    let hook_accounts: &[AccountInfo<'info>] = if ledger.is_curve() {
        require!(
            ctx.remaining_accounts.len() == crate::curve::CURVE_UNIT_ACCOUNTS,
            ProtocolError::CurveAccountsMissing
        );
        let a = crate::curve::CurveUnitAccounts::from_slice(ctx.remaining_accounts)?;
        // S2 / B-C13: exclude the DAMM v2 pool base vault so the redemption deposit covers an upper
        // bound on tenderable units the issuer cannot deflate by sandwiching the pool.
        let u = crate::curve::compute_curve_units(series, &ledger, &a, true)?;
        crate::curve::store_curve_units(&mut ledger, u, now, series_key)?;
        &[]
    } else {
        ctx.remaining_accounts
    };
    let units = ledger.units_outstanding;
    require!(units > 0, ProtocolError::NoUnitsOutstanding);
    let cap = cap_per_unit_of(series)?;
    let ring = ledger.year_gross_ring();
    let price = redemption_price(&RedemptionInputs {
        clearing_price: series.clearing_price,
        hurdle_rate_wad: series.hurdle_rate_wad,
        payout_multiple_k: series.payout_multiple_k,
        cap_per_unit: cap,
        paid_per_unit_wad: ledger.paid_per_unit_wad,
        year_gross: &ring,
        settlement_ts: ledger.settlement_ts,
        now,
        unit_scale: ledger.scale(),
    })
    .map_err(math)?;
    let registry = RegistryCpi {
        registry_program: ctx.accounts.registry_program.to_account_info(),
        config: ctx.accounts.config.to_account_info(),
        series: ctx.accounts.series.to_account_info(),
        registry_authority: ctx.accounts.registry_authority.to_account_info(),
        authority_bump: ctx.bumps.registry_authority,
    };
    if price.cap_remaining == 0 {
        // nothing is owed either way
        return retire(&mut ledger, &registry, series_key, 0);
    }
    // `P_redeem × units` (sealed bid) or `floor(P_redeem × base lamports / 10^6)` (curve mode)
    let deposit = scaled_amount(price.price, units, ledger.scale()).map_err(math)?;
    transfer_stable(
        &ctx.accounts.stablecoin_program.to_account_info(),
        &ctx.accounts.issuer_stable.to_account_info(),
        &ctx.accounts.stablecoin_mint.to_account_info(),
        &ctx.accounts.vault_token.to_account_info(),
        &ctx.accounts.issuer.to_account_info(),
        hook_accounts,
        deposit,
        series.stablecoin_decimals,
        &[],
    )?;
    let old = ledger.status;
    ledger.status = SeriesStatus::Redeemed as u8;
    ledger.redemption_ts = now;
    ledger.redemption_price = price.price;
    ledger.units_at_redemption = units;
    ledger.tail_cap_per_unit = price
        .cap_remaining
        .checked_sub(price.price)
        .ok_or(ProtocolError::MathOverflow)?;
    ledger.pause_requested = 0;
    registry.mark_terminal(SeriesStatus::Redeemed)?;
    emit!(StatusChanged {
        series: series_key,
        old,
        new: SeriesStatus::Redeemed as u8,
    });
    emit!(SeriesRedeemed {
        series: series_key,
        price: price.price,
        hurdle: price.hurdle,
        d_avg: price.d_avg,
        cap_remaining: price.cap_remaining,
        units,
        deposit,
    });
    Ok(())
}

// ----------------------------------------------------------------------------------- extinguish

#[derive(Accounts)]
pub struct Extinguish<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut, seeds = [seeds::TREASURY, series.key().as_ref()], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [seeds::TREASURY_TOKEN, series.key().as_ref()], bump)]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less signer PDA, treasury owner.
    #[account(seeds = [seeds::TREASURY_AUTH, series.key().as_ref()], bump)]
    pub treasury_auth: UncheckedAccount<'info>,
    #[account(mut, seeds = [seeds::VAULT_TOKEN, series.key().as_ref()], bump)]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    /// CHECK: registry `AttestorKey` PDA for `attestor_a`; validated in the handler.
    pub attestor_key_a: UncheckedAccount<'info>,
    /// CHECK: registry `AttestorKey` PDA for `attestor_b`; validated in the handler.
    pub attestor_key_b: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_AUTHORITY], bump)]
    pub registry_authority: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
}

/// `extinguish` (SPEC §6.9, C11 §6): two distinct active attestors sign; allowed in every status
/// but `Extinguished`. The unvested treasury balance moves to the vault as a no-fee final
/// distribution; vested-but-unclaimed tranches stay with the estate; open dues are cleared.
pub fn extinguish<'info>(
    ctx: Context<'info, Extinguish<'info>>,
    attestor_a: [u8; 20],
    sig_a: [u8; 65],
    attestor_b: [u8; 20],
    sig_b: [u8; 65],
) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    // check order: distinct attestors, both active and signing the current nonce, settled raise,
    // finalised mint, not yet extinguished
    require!(
        attestor_a != attestor_b,
        ProtocolError::AttestorsNotDistinct
    );
    require_active_attestor(&ctx.accounts.attestor_key_a.to_account_info(), &attestor_a)?;
    require_active_attestor(&ctx.accounts.attestor_key_b.to_account_info(), &attestor_b)?;
    let msg = keccak(&[extinguish_message(
        &ctx.accounts.config.domain,
        &series_key.to_bytes(),
        ledger.extinguish_nonce,
    )
    .as_bytes()]);
    require_signer(&msg, &sig_a, &attestor_a)?;
    require_signer(&msg, &sig_b, &attestor_b)?;
    require!(
        series.raise_state == RAISE_SETTLED,
        ProtocolError::RaiseNotSettled
    );
    require!(
        ctx.accounts.treasury.mint_finalized,
        ProtocolError::MintNotFinalized
    );
    let status = ledger.sync_status(now, series_key)?;
    require!(
        status != SeriesStatus::Extinguished,
        ProtocolError::TerminalStatus
    );

    // unreleased = proceeds − vested(now); early draws beyond the vested amount are already gone
    let t = &ctx.accounts.treasury;
    let schedule = schedule_of(series);
    let vested_now = core::cmp::min(
        vested(t.proceeds, &schedule, ledger.settlement_ts, now).map_err(math)?,
        t.proceeds,
    );
    let base = core::cmp::max(vested_now, t.released_total);
    let unreleased = t
        .proceeds
        .checked_sub(base)
        .ok_or(ProtocolError::MathOverflow)?;
    let bump = [ctx.bumps.treasury_auth];
    let auth_seeds: &[&[u8]] = &[seeds::TREASURY_AUTH, series_key.as_ref(), &bump];
    transfer_stable(
        &ctx.accounts.stablecoin_program.to_account_info(),
        &ctx.accounts.treasury_token.to_account_info(),
        &ctx.accounts.stablecoin_mint.to_account_info(),
        &ctx.accounts.vault_token.to_account_info(),
        &ctx.accounts.treasury_auth.to_account_info(),
        ctx.remaining_accounts,
        unreleased,
        series.stablecoin_decimals,
        &[auth_seeds],
    )?;
    ledger.final_units = if ledger.redemption_ts != 0 {
        ledger.units_at_redemption
    } else {
        ledger.units_outstanding
    };
    if unreleased > 0 && ledger.final_units > 0 {
        ledger.receive_final(unreleased, series_key)?;
    }
    let old = ledger.status;
    ledger.status = SeriesStatus::Extinguished as u8;
    ledger.extinguished_at = now;
    ledger.clear_dues();
    ledger.extinguish_nonce = ledger
        .extinguish_nonce
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    let t = &mut ctx.accounts.treasury;
    t.extinguished_at = now;
    RegistryCpi {
        registry_program: ctx.accounts.registry_program.to_account_info(),
        config: ctx.accounts.config.to_account_info(),
        series: ctx.accounts.series.to_account_info(),
        registry_authority: ctx.accounts.registry_authority.to_account_info(),
        authority_bump: ctx.bumps.registry_authority,
    }
    .mark_terminal(SeriesStatus::Extinguished)?;
    emit!(StatusChanged {
        series: series_key,
        old,
        new: SeriesStatus::Extinguished as u8,
    });
    emit!(SeriesExtinguished {
        series: series_key,
        unreleased,
        attestor_a,
        attestor_b,
    });
    Ok(())
}
