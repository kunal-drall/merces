//! Redemption (SPEC §6.7) and extinguishment (SPEC §6.9).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use merces_common::encoding::extinguish_message;
use merces_common::redemption::{redemption_price, RedemptionInputs};
use merces_common::status::SeriesStatus;
use merces_onchain::seeds::CONFIG;
use merces_onchain::{keccak, recover_eth_address};
use merces_registry::program::MercesRegistry;
use merces_registry::state::{ProtocolConfig, Series};

use crate::common::*;
use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::income::{map_sig_error, require_active_attestor};
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
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(seeds = [seeds::TREASURY, series.key().as_ref()], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = issuer, token::token_program = stablecoin_program)]
    pub issuer_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::VAULT_TOKEN, series.key().as_ref()], bump)]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_SIGNER], bump)]
    pub registry_signer: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
}

/// `redeem` (SPEC §6.7): issuer only, after lockup, with no open due. Never blockable by anyone
/// else (C7). No fee.
pub fn redeem<'info>(ctx: Context<'info, Redeem<'info>>) -> Result<()> {
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    let status = ctx.accounts.ledger.sync_status(now, series_key)?;
    require!(!status.is_terminal(), ProtocolError::SeriesTerminal);
    require!(
        ctx.accounts.treasury.finalized,
        ProtocolError::MintNotFinalized
    );
    let ledger = &ctx.accounts.ledger;
    let unlock = ledger
        .settlement_ts
        .checked_add(series.lockup_seconds)
        .ok_or(ProtocolError::MathOverflow)?;
    require!(now >= unlock, ProtocolError::LockupActive);
    require!(ledger.open_due_amount == 0, ProtocolError::DueOutstanding);
    let units = ctx.accounts.unit_mint.supply;
    require!(units > 0, ProtocolError::NoUnitsOutstanding);
    let price = redemption_price(&RedemptionInputs {
        clearing_price: series.clearing_price,
        hurdle_rate_wad: series.hurdle_rate_wad,
        payout_multiple_k: series.payout_multiple_k,
        cap_per_unit: ledger.cap_per_unit,
        paid_per_unit_wad: ledger.paid_per_unit_wad,
        year_gross_wad: &ledger.year_gross_wad,
        settlement_ts: ledger.settlement_ts,
        now,
    })
    .map_err(math)?;
    let deposit = price
        .price
        .checked_mul(units)
        .ok_or(ProtocolError::MathOverflow)?;
    transfer_stable(
        &ctx.accounts.stablecoin_program.to_account_info(),
        &ctx.accounts.issuer_stable.to_account_info(),
        &ctx.accounts.stablecoin_mint.to_account_info(),
        &ctx.accounts.vault_token.to_account_info(),
        &ctx.accounts.issuer.to_account_info(),
        ctx.remaining_accounts,
        deposit,
        series.stablecoin_decimals,
        &[],
    )?;
    let ledger = &mut ctx.accounts.ledger;
    let old = ledger.status;
    ledger.status = SeriesStatus::Redeemed as u8;
    ledger.redemption_ts = now;
    ledger.redemption_price = price.price;
    ledger.units_at_redemption = units;
    ledger.tail_cap_per_unit = price
        .cap_remaining
        .checked_sub(price.price)
        .ok_or(ProtocolError::MathOverflow)?;
    ledger.trueup_due = 0;
    RegistryCpi {
        registry_program: ctx.accounts.registry_program.to_account_info(),
        config: ctx.accounts.config.to_account_info(),
        series: ctx.accounts.series.to_account_info(),
        protocol_signer: ctx.accounts.registry_signer.to_account_info(),
        signer_bump: ctx.bumps.registry_signer,
    }
    .mark_terminal(SeriesStatus::Redeemed)?;
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
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(mut, seeds = [seeds::TREASURY, series.key().as_ref()], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [seeds::TREASURY_TOKEN, series.key().as_ref()], bump)]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less signer PDA, treasury owner.
    #[account(seeds = [seeds::TREASURY_AUTH, series.key().as_ref()], bump)]
    pub treasury_auth: UncheckedAccount<'info>,
    #[account(mut, seeds = [seeds::VAULT_TOKEN, series.key().as_ref()], bump)]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    /// CHECK: registry `AttestorKey` PDA for `attestor_a`; validated in the handler.
    pub attestor_key_a: UncheckedAccount<'info>,
    /// CHECK: registry `AttestorKey` PDA for `attestor_b`; validated in the handler.
    pub attestor_key_b: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_SIGNER], bump)]
    pub registry_signer: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
}

/// `extinguish` (SPEC §6.9, C11 §6): two distinct active attestors sign; unreleased treasury
/// funds move to the vault as a no-fee final distribution; open dues are cleared.
pub fn extinguish<'info>(
    ctx: Context<'info, Extinguish<'info>>,
    attestor_a: [u8; 20],
    sig_a: [u8; 65],
    attestor_b: [u8; 20],
    sig_b: [u8; 65],
) -> Result<()> {
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let status = ctx.accounts.ledger.sync_status(now, series_key)?;
    require!(
        status != SeriesStatus::Extinguished && status != SeriesStatus::Retired,
        ProtocolError::SeriesTerminal
    );
    require!(
        attestor_a != attestor_b,
        ProtocolError::AttestorsNotDistinct
    );
    let msg = keccak(&[extinguish_message(
        &ctx.accounts.config.domain,
        &series_key.to_bytes(),
        ctx.accounts.ledger.extinguish_nonce,
    )
    .as_bytes()]);
    let rec_a = recover_eth_address(&msg, &sig_a).map_err(map_sig_error)?;
    let rec_b = recover_eth_address(&msg, &sig_b).map_err(map_sig_error)?;
    require!(
        rec_a == attestor_a && rec_b == attestor_b,
        ProtocolError::SignerMismatch
    );
    require_active_attestor(&ctx.accounts.attestor_key_a.to_account_info(), &attestor_a)?;
    require_active_attestor(&ctx.accounts.attestor_key_b.to_account_info(), &attestor_b)?;

    let t = &ctx.accounts.treasury;
    let unreleased = if t.finalized {
        t.proceeds
            .checked_sub(t.released_total)
            .ok_or(ProtocolError::MathOverflow)?
    } else {
        // settlement never finalised: everything the treasury received is unreleased
        t.proceeds_received
            .checked_sub(t.released_total)
            .ok_or(ProtocolError::MathOverflow)?
    };
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
        ctx.accounts.series.stablecoin_decimals,
        &[auth_seeds],
    )?;
    let ledger = &mut ctx.accounts.ledger;
    let weights = if ledger.units_at_redemption > 0 {
        ledger.units_at_redemption
    } else {
        ctx.accounts.unit_mint.supply
    };
    if unreleased > 0 {
        ledger.receive_final(unreleased, weights, series_key)?;
    }
    let old = ledger.status;
    ledger.status = SeriesStatus::Extinguished as u8;
    ledger.open_due_amount = 0;
    ledger.open_due_period = None;
    ledger.open_due_is_tail = false;
    ledger.trueup_due = 0;
    ledger.pause_requested = false;
    ledger.extinguish_nonce = ledger
        .extinguish_nonce
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    let t = &mut ctx.accounts.treasury;
    t.released_total = t
        .released_total
        .checked_add(unreleased)
        .ok_or(ProtocolError::MathOverflow)?;
    RegistryCpi {
        registry_program: ctx.accounts.registry_program.to_account_info(),
        config: ctx.accounts.config.to_account_info(),
        series: ctx.accounts.series.to_account_info(),
        protocol_signer: ctx.accounts.registry_signer.to_account_info(),
        signer_bump: ctx.bumps.registry_signer,
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
