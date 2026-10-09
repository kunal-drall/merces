//! Holder claim path (SPEC v1.1 §6.3, §6.7–§6.9). Isolated so a private-payout implementation can
//! replace it without touching the accounting in `common.rs`.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self as ti, Mint, Token2022, TokenAccount, TokenInterface};
use merces_common::status::SeriesStatus;
use merces_common::vault::holder_delta;
use merces_onchain::seeds::ALLOW;
use merces_registry::state::{AllowlistEntry, Series};

use crate::common::*;
use crate::curve::settle_curve_holder;
use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::state::*;

// ------------------------------------------------------------------------------ register_holder

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RegisterHolder<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(seeds = [ALLOW, wallet.as_ref()], bump = allowlist_entry.bump, seeds::program = merces_registry::ID)]
    pub allowlist_entry: Box<Account<'info, AllowlistEntry>>,
    #[account(init_if_needed, payer = payer, space = 8 + Holder::INIT_SPACE, seeds = [seeds::HOLDER, series.key().as_ref(), wallet.as_ref()], bump)]
    pub holder: Box<Account<'info, Holder>>,
    pub system_program: Program<'info, System>,
}

/// Anyone may register a wallet that is allowlisted **now** (SPEC §6.3).
pub fn register_holder(ctx: Context<RegisterHolder>, wallet: Pubkey) -> Result<()> {
    let ledger = ctx.accounts.ledger.load()?;
    require!(
        ctx.accounts.allowlist_entry.allowed,
        ProtocolError::NotAllowlisted
    );
    let series = ctx.accounts.series.key();
    let bump = ctx.bumps.holder;
    register_holder_now(&ledger, &mut ctx.accounts.holder, series, wallet, bump)?;
    Ok(())
}

// ----------------------------------------------------------------------------------- claim set

/// Accounts shared by `claim`, `burn_retired`, `claim_redemption`, `claim_tail`, `claim_final`.
#[derive(Accounts)]
pub struct HolderClaim<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut, seeds = [seeds::HOLDER, series.key().as_ref(), holder_wallet.key().as_ref()], bump = holder.bump)]
    pub holder: Box<Account<'info, Holder>>,
    /// CHECK: the holder's wallet; payouts go to its associated token accounts only.
    #[account(address = holder.wallet @ ProtocolError::HolderNotRegistered)]
    pub holder_wallet: UncheckedAccount<'info>,
    #[account(mut, token::mint = unit_mint, token::authority = holder_wallet, token::token_program = token_2022_program)]
    pub holder_unit_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = holder_wallet, token::token_program = stablecoin_program)]
    pub holder_stable_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::VAULT_TOKEN, series.key().as_ref()], bump)]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less signer PDA, vault owner and permanent delegate.
    #[account(seeds = [seeds::VAULT_AUTH, series.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(mut, address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Owned handles for the permanent-delegate burn, so the holder record can be borrowed mutably
/// alongside (disjoint field borrows).
pub struct BurnCtx<'info> {
    series_key: Pubkey,
    holder_wallet: Pubkey,
    token_2022: AccountInfo<'info>,
    unit_mint: AccountInfo<'info>,
    from: AccountInfo<'info>,
    vault_auth: AccountInfo<'info>,
    bump: u8,
}

impl<'info> BurnCtx<'info> {
    /// Burns `units` from the holder's unit account through the permanent delegate (zero-amount
    /// rule: nothing is issued for 0) and reduces `units_outstanding`.
    fn burn(&self, ledger: &mut Ledger, units: u64, reason: u8) -> Result<()> {
        if units == 0 {
            return Ok(());
        }
        let bump_arr = [self.bump];
        let seeds: &[&[u8]] = &[seeds::VAULT_AUTH, self.series_key.as_ref(), &bump_arr];
        ti::burn(
            CpiContext::new_with_signer(
                *self.token_2022.key,
                ti::Burn {
                    mint: self.unit_mint.clone(),
                    from: self.from.clone(),
                    authority: self.vault_auth.clone(),
                },
                &[seeds],
            ),
            units,
        )?;
        ledger.units_outstanding = ledger
            .units_outstanding
            .checked_sub(units)
            .ok_or(ProtocolError::MathOverflow)?;
        emit!(UnitsBurned {
            series: self.series_key,
            holder: self.holder_wallet,
            units,
            reason,
        });
        Ok(())
    }
}

impl<'info> HolderClaim<'info> {
    /// ATA derivation of both holder token accounts.
    fn check_atas(&self) -> Result<()> {
        let wallet = self.holder.wallet;
        require_ata(
            &self.holder_unit_ata.to_account_info(),
            &wallet,
            &self.series.unit_mint,
            &self.token_2022_program.key(),
        )?;
        require_ata(
            &self.holder_stable_ata.to_account_info(),
            &wallet,
            &self.series.stablecoin,
            &self.series.stablecoin_program,
        )
    }

    fn burn_ctx(&self, bump: u8) -> BurnCtx<'info> {
        BurnCtx {
            series_key: self.series.key(),
            holder_wallet: self.holder.wallet,
            token_2022: self.token_2022_program.to_account_info(),
            unit_mint: self.unit_mint.to_account_info(),
            from: self.holder_unit_ata.to_account_info(),
            vault_auth: self.vault_auth.to_account_info(),
            bump,
        }
    }

    fn pay_out(&self, extra: &[AccountInfo<'info>], amount: u64, bump: u8) -> Result<()> {
        let series_key = self.series.key();
        let bump_arr = [bump];
        let seeds: &[&[u8]] = &[seeds::VAULT_AUTH, series_key.as_ref(), &bump_arr];
        transfer_stable(
            &self.stablecoin_program.to_account_info(),
            &self.vault_token.to_account_info(),
            &self.stablecoin_mint.to_account_info(),
            &self.holder_stable_ata.to_account_info(),
            &self.vault_auth.to_account_info(),
            extra,
            amount,
            self.series.stablecoin_decimals,
            &[seeds],
        )
    }
}

/// `claim` (SPEC §6.3): settles, pays `pending`, and burns the holder's units if the series is
/// Retired. Never requires current allowlist membership (C10).
pub fn claim<'info>(ctx: Context<'info, HolderClaim<'info>>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    ctx.accounts.check_atas()?;
    let series_key = ctx.accounts.series.key();
    if ledger.is_curve() {
        // curve mode: staked units earn, nothing is ever burned (CURVE_MODE §5, §7)
        settle_curve_holder(&ledger, &mut ctx.accounts.holder)?;
        let amount = ctx.accounts.holder.pending;
        ctx.accounts.holder.pending = 0;
        ctx.accounts
            .pay_out(ctx.remaining_accounts, amount, ctx.bumps.vault_auth)?;
        emit!(PayoutClaimed {
            series: series_key,
            holder: ctx.accounts.holder.wallet,
            amount,
            burned_units: 0,
        });
        return Ok(());
    }
    let status = ledger.stored_status();
    let balance = ctx.accounts.holder_unit_ata.amount;
    settle_holder(&ledger, &mut ctx.accounts.holder, balance)?;
    let amount = ctx.accounts.holder.pending;
    ctx.accounts.holder.pending = 0;
    ctx.accounts
        .pay_out(ctx.remaining_accounts, amount, ctx.bumps.vault_auth)?;
    let burned = if status == SeriesStatus::Retired && balance > 0 {
        ctx.accounts
            .burn_ctx(ctx.bumps.vault_auth)
            .burn(&mut ledger, balance, BURN_RETIRED)?;
        balance
    } else {
        0
    };
    emit!(PayoutClaimed {
        series: series_key,
        holder: ctx.accounts.holder.wallet,
        amount,
        burned_units: burned,
    });
    Ok(())
}

/// Accounts of `burn_retired`. The holder record and the unit account may not exist: a wallet
/// that never held units is a no-op (SPEC §1.1 zero-amount rule).
#[derive(Accounts)]
pub struct BurnRetired<'info> {
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    /// CHECK: the wallet's `Holder` PDA (address checked by the seeds; read only when it exists).
    #[account(mut, seeds = [seeds::HOLDER, series.key().as_ref(), holder_wallet.key().as_ref()], bump)]
    pub holder: UncheckedAccount<'info>,
    /// CHECK: the holder's wallet (only its key is used).
    pub holder_wallet: UncheckedAccount<'info>,
    /// CHECK: the wallet's unit ATA (derivation checked in the handler; may not exist).
    #[account(mut)]
    pub holder_unit_ata: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, permanent delegate.
    #[account(seeds = [seeds::VAULT_AUTH, series.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    /// CHECK: the unit mint recorded in the registry.
    #[account(mut, address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: UncheckedAccount<'info>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// `burn_retired` (SPEC §6.3): permissionless burn after retirement; `pending` stays claimable. A
/// zero balance (or a wallet that never held units) is a no-op that still emits
/// `UnitsBurned(units = 0)`, as on EVM.
pub fn burn_retired(ctx: Context<BurnRetired>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let series_key = ctx.accounts.series.key();
    let wallet = ctx.accounts.holder_wallet.key();
    require!(!ledger.is_curve(), ProtocolError::CurveModeNoBurn);
    let status = ledger.stored_status();
    require!(
        status == SeriesStatus::Retired,
        ProtocolError::TerminalStatus
    );
    let t22 = ctx.accounts.token_2022_program.key();
    let ata_info = ctx.accounts.holder_unit_ata.to_account_info();
    require_ata(&ata_info, &wallet, &ctx.accounts.series.unit_mint, &t22)?;
    let balance = if *ata_info.owner == t22 && !ata_info.data_is_empty() {
        token_account_amount(&ata_info)?
    } else {
        0
    };
    if balance == 0 {
        emit!(UnitsBurned {
            series: series_key,
            holder: wallet,
            units: 0,
            reason: BURN_RETIRED,
        });
        return Ok(());
    }
    // a wallet with units was registered when it received them (process_bid / window fill)
    let holder_info = ctx.accounts.holder.to_account_info();
    let mut holder = read_holder(&holder_info)?.ok_or(ProtocolError::HolderNotRegistered)?;
    settle_holder(&ledger, &mut holder, balance)?;
    store_holder(&holder_info, &holder)?;
    BurnCtx {
        series_key,
        holder_wallet: wallet,
        token_2022: ctx.accounts.token_2022_program.to_account_info(),
        unit_mint: ctx.accounts.unit_mint.to_account_info(),
        from: ata_info,
        vault_auth: ctx.accounts.vault_auth.to_account_info(),
        bump: ctx.bumps.vault_auth,
    }
    .burn(&mut ledger, balance, BURN_RETIRED)
}

/// The `claim_redemption` body (SPEC §6.7): settles, records `redeemed_units`, burns the balance
/// and returns `(units, pending + P_redeem × units)` (not yet paid).
fn redemption_body(
    burn: &BurnCtx<'_>,
    holder: &mut Holder,
    balance: u64,
    ledger: &mut Ledger,
) -> Result<(u64, u64)> {
    require!(ledger.redemption_ts != 0, ProtocolError::NotRedeemed);
    require!(
        holder.undelivered_units == 0 && holder.window_pending_units == 0,
        ProtocolError::DeliverFirst
    );
    // a cleared, unprocessed ask must be processed first — its units are split between the buyer
    // (sold) and the seller (returned), so the holder's true kept units are not yet known. An
    // uncleared (or NoMatch) ask is still wholly the holder's: it stays escrowed and is redeemed
    // when its units come back, so it does not block (C-S4, align to EVM).
    require!(
        !(holder.ask_escrow_units > 0 && ledger.window_cleared()),
        ProtocolError::DeliverFirst
    );
    settle_holder(ledger, holder, balance)?;
    let price = ledger.redemption_price;
    holder.redeemed_units = holder
        .redeemed_units
        .checked_add(balance)
        .ok_or(ProtocolError::MathOverflow)?;
    let redemption = price
        .checked_mul(balance)
        .ok_or(ProtocolError::MathOverflow)?;
    // Tail catch-up (S6 / C-S21): units redeemed after this holder already claimed tail (they came
    // back from, or were bought in, a window that cleared before redemption) are owed the tail that
    // accrued before that claim — `last_tail_acc_wad × balance / WAD`. The cursor is NOT reset, so
    // the later `claim_tail` delta `(tail_acc − last_tail) × redeemed_units` continues from it; the
    // two together pay each unit the full `tail_acc × units / WAD`. For a first redemption the
    // cursor is 0 (S1), so this term is 0. Matches EVM `MercesVault._redemptionBody`.
    let tail_catch_up = holder_delta(holder.last_tail_acc_wad, 0, balance).map_err(math)?;
    let amount = holder
        .pending
        .checked_add(redemption)
        .and_then(|v| v.checked_add(tail_catch_up))
        .ok_or(ProtocolError::MathOverflow)?;
    holder.pending = 0;
    burn.burn(ledger, balance, BURN_REDEEMED)?;
    Ok((balance, amount))
}

/// `claim_redemption` (SPEC §6.7). Available in `Redeemed` and `Extinguished`.
pub fn claim_redemption<'info>(ctx: Context<'info, HolderClaim<'info>>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    require!(!ledger.is_curve(), ProtocolError::CurveUsesTender);
    ctx.accounts.check_atas()?;
    let series_key = ctx.accounts.series.key();
    let burn = ctx.accounts.burn_ctx(ctx.bumps.vault_auth);
    let balance = ctx.accounts.holder_unit_ata.amount;
    let (units, amount) = redemption_body(&burn, &mut ctx.accounts.holder, balance, &mut ledger)?;
    ctx.accounts
        .pay_out(ctx.remaining_accounts, amount, ctx.bumps.vault_auth)?;
    emit!(RedemptionClaimed {
        series: series_key,
        holder: ctx.accounts.holder.wallet,
        units,
        amount,
    });
    Ok(())
}

/// `claim_tail` (SPEC §6.8): tail payouts weighted by `redeemed_units`; an unredeemed balance is
/// redeemed first.
pub fn claim_tail<'info>(ctx: Context<'info, HolderClaim<'info>>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    ctx.accounts.check_atas()?;
    let series_key = ctx.accounts.series.key();
    require!(ledger.redemption_ts != 0, ProtocolError::NotRedeemed);
    let mut total = 0u64;
    if ledger.is_curve() {
        // curve mode: units were tendered (tender_units); pending payouts are settled here too
        settle_curve_holder(&ledger, &mut ctx.accounts.holder)?;
        total = ctx.accounts.holder.pending;
        ctx.accounts.holder.pending = 0;
    }
    let balance = if ledger.is_curve() {
        0
    } else {
        ctx.accounts.holder_unit_ata.amount
    };
    if balance > 0 {
        let burn = ctx.accounts.burn_ctx(ctx.bumps.vault_auth);
        let (units, amount) =
            redemption_body(&burn, &mut ctx.accounts.holder, balance, &mut ledger)?;
        total = amount;
        emit!(RedemptionClaimed {
            series: series_key,
            holder: ctx.accounts.holder.wallet,
            units,
            amount,
        });
    }
    let holder = &mut ctx.accounts.holder;
    require!(holder.redeemed_units > 0, ProtocolError::NoRedeemedUnits);
    let tail = holder_delta(
        ledger.tail_acc_wad,
        holder.last_tail_acc_wad,
        holder.redeemed_units,
    )
    .map_err(math)?;
    holder.last_tail_acc_wad = ledger.tail_acc_wad;
    total = total.checked_add(tail).ok_or(ProtocolError::MathOverflow)?;
    ctx.accounts
        .pay_out(ctx.remaining_accounts, total, ctx.bumps.vault_auth)?;
    emit!(TailClaimed {
        series: series_key,
        holder: ctx.accounts.holder.wallet,
        amount: tail,
    });
    Ok(())
}

/// `claim_final` (SPEC §6.9): pending payouts plus the pro-rata share of the unreleased treasury
/// funds; units burned. Weight: `redeemed_units` (after redeeming any balance) for a redeemed
/// series, else the holder's accrual units.
pub fn claim_final<'info>(ctx: Context<'info, HolderClaim<'info>>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    ctx.accounts.check_atas()?;
    let series_key = ctx.accounts.series.key();
    let status = ledger.stored_status();
    require!(
        status == SeriesStatus::Extinguished,
        ProtocolError::NotExtinguished
    );
    let mut amount = 0u64;
    let mut burned = 0u64;
    if ledger.is_curve() {
        // curve mode: the final share is weighted by the tendered units of a redeemed series,
        // else by the stake (credited by the settlement); nothing is burned
        settle_curve_holder(&ledger, &mut ctx.accounts.holder)?;
        let holder = &mut ctx.accounts.holder;
        let (weight, share) = if ledger.redemption_ts != 0 {
            let w = holder.redeemed_units;
            let f =
                holder_delta(ledger.final_acc_wad, holder.last_final_acc_wad, w).map_err(math)?;
            holder.last_final_acc_wad = ledger.final_acc_wad;
            (w, f)
        } else {
            (holder.staked_units, 0)
        };
        let total = holder
            .pending
            .checked_add(share)
            .ok_or(ProtocolError::MathOverflow)?;
        holder.pending = 0;
        ctx.accounts
            .pay_out(ctx.remaining_accounts, total, ctx.bumps.vault_auth)?;
        emit!(FinalClaimed {
            series: series_key,
            holder: ctx.accounts.holder.wallet,
            units: weight,
            amount: total,
        });
        return Ok(());
    }
    let burn = ctx.accounts.burn_ctx(ctx.bumps.vault_auth);
    let balance = ctx.accounts.holder_unit_ata.amount;
    // Guards apply to both branches: window units awaiting delivery must reach the wallet first
    // (B-S13), and a cleared, unprocessed ask must be processed first — its units are split
    // between buyer and seller, so the holder's true final weight is not yet known (C-S4). An
    // uncleared (or NoMatch) ask's units are still wholly the holder's and carry their final share
    // now, like every unit that existed at extinguishment (align to EVM); they are redeemed/burned
    // when they come back.
    {
        let holder = &ctx.accounts.holder;
        require!(
            holder.undelivered_units == 0 && holder.window_pending_units == 0,
            ProtocolError::DeliverFirst
        );
        require!(
            !(holder.ask_escrow_units > 0 && ledger.window_cleared()),
            ProtocolError::DeliverFirst
        );
    }
    let escrow = ctx.accounts.holder.ask_escrow_units;
    let weight = if ledger.redemption_ts != 0 {
        if balance > 0 {
            let (units, redeemed) =
                redemption_body(&burn, &mut ctx.accounts.holder, balance, &mut ledger)?;
            amount = redeemed;
            burned = units;
            emit!(RedemptionClaimed {
                series: series_key,
                holder: ctx.accounts.holder.wallet,
                units,
                amount: redeemed,
            });
        }
        ctx.accounts
            .holder
            .redeemed_units
            .checked_add(escrow)
            .ok_or(ProtocolError::MathOverflow)?
    } else {
        settle_holder(&ledger, &mut ctx.accounts.holder, balance)?;
        amount = ctx.accounts.holder.pending;
        ctx.accounts.holder.pending = 0;
        burned = balance;
        burn.burn(&mut ledger, balance, BURN_EXTINGUISHED)?;
        balance
            .checked_add(escrow)
            .ok_or(ProtocolError::MathOverflow)?
    };
    let holder = &mut ctx.accounts.holder;
    let final_share =
        holder_delta(ledger.final_acc_wad, holder.last_final_acc_wad, weight).map_err(math)?;
    holder.last_final_acc_wad = ledger.final_acc_wad;
    let pending = holder.pending;
    holder.pending = 0;
    amount = amount
        .checked_add(final_share)
        .and_then(|v| v.checked_add(pending))
        .ok_or(ProtocolError::MathOverflow)?;
    ctx.accounts
        .pay_out(ctx.remaining_accounts, amount, ctx.bumps.vault_auth)?;
    emit!(FinalClaimed {
        series: series_key,
        holder: ctx.accounts.holder.wallet,
        units: burned,
        amount,
    });
    Ok(())
}
