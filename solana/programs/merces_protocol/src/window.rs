//! Transfer window (SPEC §7, brief D9): the only path through which sealed-bid units change hands.
//! Ships closed (`windows_enabled = false`).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount, TokenInterface};
use merces_common::auction::wallet_cap_units;
use merces_common::encoding::commitment_preimage;
use merces_common::status::SeriesStatus;
use merces_common::time::period_of;
use merces_common::vault::holder_delta;
use merces_common::window::{
    ask_fill, ask_is_valid, bid_fill, bid_is_valid, check_window_clearing, no_match_is_valid,
    settle_buyer, WindowTally,
};
use merces_onchain::keccak;
use merces_onchain::seeds::{ALLOW, CONFIG};
use merces_registry::state::{AllowlistEntry, ProtocolConfig, Series};

use crate::common::*;
use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::state::*;

/// Transfers `amount` units between `source` and `destination` through Token-2022, resolving the
/// Merces hook accounts from `extra`.
#[allow(clippy::too_many_arguments)]
fn transfer_units<'info>(
    token_2022: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    extra: &[AccountInfo<'info>],
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    spl_token_2022::onchain::invoke_transfer_checked(
        token_2022.key,
        source.clone(),
        mint.clone(),
        destination.clone(),
        authority.clone(),
        extra,
        amount,
        0,
        signer_seeds,
    )
    .map_err(Into::into)
}

// ---------------------------------------------------------------------------------- open_window

#[derive(Accounts)]
#[instruction(period: u32)]
pub struct OpenWindow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(init, payer = payer, space = 8 + Window::INIT_SPACE, seeds = [seeds::WINDOW, series.key().as_ref(), period.to_le_bytes().as_ref()], bump)]
    pub window: Box<Account<'info, Window>>,
    /// CHECK: data-less signer PDA owning both window escrows (the hook recognises it).
    #[account(seeds = [seeds::WINDOW_ESCROW, series.key().as_ref()], bump)]
    pub window_escrow: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        seeds = [seeds::WINDOW_UNITS, series.key().as_ref()],
        bump,
        token::mint = unit_mint,
        token::authority = window_escrow,
        token::token_program = token_2022_program,
    )]
    pub window_units: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = payer,
        seeds = [seeds::WINDOW_STABLE, series.key().as_ref()],
        bump,
        token::mint = stablecoin_mint,
        token::authority = window_escrow,
        token::token_program = stablecoin_program,
    )]
    pub window_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn open_window(ctx: Context<OpenWindow>, period: u32) -> Result<()> {
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    require!(
        ctx.accounts.config.windows_enabled,
        ProtocolError::WindowsDisabled
    );
    let status = ctx.accounts.ledger.sync_status(now, series_key)?;
    require!(
        matches!(status, SeriesStatus::OnTime | SeriesStatus::InGrace),
        ProtocolError::WindowStatusNotAllowed
    );
    let ledger = &ctx.accounts.ledger;
    let unlock = ledger
        .settlement_ts
        .checked_add(series.lockup_seconds)
        .ok_or(ProtocolError::MathOverflow)?;
    require!(now >= unlock, ProtocolError::LockupActive);
    require!(
        matches!(ledger.last_paid_period, Some(p) if p >= period),
        ProtocolError::ReportNotPaid
    );
    let current = period_of(now).map_err(math)?;
    require!(
        current.checked_sub(1) == Some(period),
        ProtocolError::WindowWrongPeriod
    );
    require!(
        ledger.active_window.is_none(),
        ProtocolError::WindowAlreadyOpen
    );
    let commit_end = now
        .checked_add(series.window_commit_duration)
        .ok_or(ProtocolError::MathOverflow)?;
    let reveal_end = commit_end
        .checked_add(series.window_reveal_duration)
        .ok_or(ProtocolError::MathOverflow)?;
    let w = &mut ctx.accounts.window;
    w.series = series_key;
    w.period = period;
    w.state = WINDOW_COMMIT;
    w.opens_at = now;
    w.commit_end = commit_end;
    w.reveal_end = reveal_end;
    w.min_ask = u64::MAX;
    w.bump = ctx.bumps.window;
    ctx.accounts.ledger.active_window = Some(period);
    emit!(WindowOpened {
        series: series_key,
        period,
        commit_end,
        reveal_end,
    });
    Ok(())
}

// ---------------------------------------------------------------------------------- commit_ask

#[derive(Accounts)]
pub struct CommitAsk<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
    #[account(init, payer = owner, space = 8 + Order::INIT_SPACE, seeds = [seeds::ORDER, series.key().as_ref(), window.period.to_le_bytes().as_ref(), owner.key().as_ref(), &[SIDE_ASK]], bump)]
    pub order: Box<Account<'info, Order>>,
    #[account(mut, seeds = [seeds::HOLDER, series.key().as_ref(), owner.key().as_ref()], bump = holder.bump)]
    pub holder: Box<Account<'info, Holder>>,
    #[account(mut, associated_token::mint = unit_mint, associated_token::authority = owner, associated_token::token_program = token_2022_program)]
    pub owner_unit_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::WINDOW_UNITS, series.key().as_ref()], bump)]
    pub window_units: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Escrows `units` with a sealed ask. Remaining accounts: the hook's extra accounts for the unit mint.
pub fn commit_ask<'info>(
    ctx: Context<'info, CommitAsk<'info>>,
    commitment: [u8; 32],
    units: u64,
) -> Result<()> {
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let w = &ctx.accounts.window;
    require!(
        w.state == WINDOW_COMMIT && now < w.commit_end,
        ProtocolError::WindowNotCommit
    );
    require!(units > 0, ProtocolError::ZeroUnits);
    require!(
        units <= ctx.accounts.owner_unit_ata.amount,
        ProtocolError::AskExceedsEscrow
    );
    // settle before the balance changes
    settle_holder(
        &ctx.accounts.ledger,
        &mut ctx.accounts.holder,
        ctx.accounts.owner_unit_ata.amount,
    )?;
    transfer_units(
        &ctx.accounts.token_2022_program.to_account_info(),
        &ctx.accounts.owner_unit_ata.to_account_info(),
        &ctx.accounts.unit_mint.to_account_info(),
        &ctx.accounts.window_units.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        ctx.remaining_accounts,
        units,
        &[],
    )?;
    let w = &mut ctx.accounts.window;
    w.escrow_units = w
        .escrow_units
        .checked_add(units)
        .ok_or(ProtocolError::MathOverflow)?;
    w.ask_count = w
        .ask_count
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    let o = &mut ctx.accounts.order;
    o.series = series_key;
    o.period = w.period;
    o.owner = ctx.accounts.owner.key();
    o.side = SIDE_ASK;
    o.commitment = commitment;
    o.escrow = units;
    o.net_acc_snapshot = ctx.accounts.ledger.net_acc_wad;
    o.bump = ctx.bumps.order;
    emit!(OrderCommitted {
        series: series_key,
        period: w.period,
        owner: o.owner,
        side: SIDE_ASK,
        escrow: units,
    });
    Ok(())
}

// --------------------------------------------------------------------------- window_commit_bid

#[derive(Accounts)]
pub struct WindowCommitBid<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(seeds = [ALLOW, owner.key().as_ref()], bump = owner_allowlist.bump, seeds::program = merces_registry::ID)]
    pub owner_allowlist: Box<Account<'info, AllowlistEntry>>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
    #[account(init, payer = owner, space = 8 + Order::INIT_SPACE, seeds = [seeds::ORDER, series.key().as_ref(), window.period.to_le_bytes().as_ref(), owner.key().as_ref(), &[SIDE_BID]], bump)]
    pub order: Box<Account<'info, Order>>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = owner, token::token_program = stablecoin_program)]
    pub owner_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::WINDOW_STABLE, series.key().as_ref()], bump)]
    pub window_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn window_commit_bid<'info>(
    ctx: Context<'info, WindowCommitBid<'info>>,
    commitment: [u8; 32],
    escrow: u64,
) -> Result<()> {
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let w = &ctx.accounts.window;
    require!(
        w.state == WINDOW_COMMIT && now < w.commit_end,
        ProtocolError::WindowNotCommit
    );
    require!(escrow > 0, ProtocolError::ZeroEscrow);
    require!(
        ctx.accounts.owner_allowlist.allowed,
        ProtocolError::NotAllowlisted
    );
    transfer_stable(
        &ctx.accounts.stablecoin_program.to_account_info(),
        &ctx.accounts.owner_stable.to_account_info(),
        &ctx.accounts.stablecoin_mint.to_account_info(),
        &ctx.accounts.window_stable.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        ctx.remaining_accounts,
        escrow,
        ctx.accounts.series.stablecoin_decimals,
        &[],
    )?;
    let w = &mut ctx.accounts.window;
    w.escrow_stable = w
        .escrow_stable
        .checked_add(escrow)
        .ok_or(ProtocolError::MathOverflow)?;
    w.bid_count = w
        .bid_count
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    let o = &mut ctx.accounts.order;
    o.series = series_key;
    o.period = w.period;
    o.owner = ctx.accounts.owner.key();
    o.side = SIDE_BID;
    o.commitment = commitment;
    o.escrow = escrow;
    o.bump = ctx.bumps.order;
    emit!(OrderCommitted {
        series: series_key,
        period: w.period,
        owner: o.owner,
        side: SIDE_BID,
        escrow,
    });
    Ok(())
}

// --------------------------------------------------------------------------------- reveal_order

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct RevealOrder<'info> {
    pub owner: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
    #[account(mut, seeds = [seeds::ORDER, series.key().as_ref(), window.period.to_le_bytes().as_ref(), owner.key().as_ref(), &[side]], bump = order.bump)]
    pub order: Box<Account<'info, Order>>,
    /// The owner's unit balance (bids: wallet-cap room).
    #[account(associated_token::mint = unit_mint, associated_token::authority = owner, associated_token::token_program = token_2022_program)]
    pub owner_unit_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_2022_program: Program<'info, Token2022>,
}

pub fn reveal_order(
    ctx: Context<RevealOrder>,
    side: u8,
    price: u64,
    quantity: u64,
    salt: [u8; 32],
) -> Result<()> {
    let now = now_ts()?;
    let series = &ctx.accounts.series;
    let w = &mut ctx.accounts.window;
    require!(w.state == WINDOW_COMMIT, ProtocolError::WindowNotReveal);
    require!(
        now >= w.commit_end && now < w.reveal_end,
        ProtocolError::WindowNotReveal
    );
    let o = &mut ctx.accounts.order;
    require!(o.side == side, ProtocolError::WrongSide);
    require!(!o.revealed, ProtocolError::AlreadyRevealed);
    let wallet = ctx.accounts.owner.key().to_bytes();
    let expected = keccak(&[commitment_preimage(price, quantity, &salt, &wallet).as_bytes()]);
    require!(expected == o.commitment, ProtocolError::CommitmentMismatch);
    o.revealed = true;
    o.price = price;
    o.quantity = quantity;
    let valid = if side == SIDE_ASK {
        o.reveal_index = w.revealed_asks;
        w.revealed_asks = w
            .revealed_asks
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
        ask_is_valid(price, quantity, o.escrow)
    } else {
        o.reveal_index = w.revealed_bids;
        w.revealed_bids = w
            .revealed_bids
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
        let cap =
            wallet_cap_units(ctx.accounts.unit_mint.supply, series.wallet_cap_bps).map_err(math)?;
        bid_is_valid(
            price,
            quantity,
            o.escrow,
            series.window_fee_bps,
            cap,
            ctx.accounts.owner_unit_ata.amount,
        )
    };
    o.valid = valid;
    if valid {
        w.valid_orders = w
            .valid_orders
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
    }
    emit!(OrderRevealed {
        series: series.key(),
        period: w.period,
        owner: o.owner,
        side,
        price,
        quantity,
        valid,
    });
    Ok(())
}

// ---------------------------------------------------------------- begin / tally / finalize

#[derive(Accounts)]
pub struct WindowSettle<'info> {
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
}

pub fn begin_window_settlement(
    ctx: Context<WindowSettle>,
    clearing_price: u64,
    no_match: bool,
) -> Result<()> {
    let now = now_ts()?;
    let w = &mut ctx.accounts.window;
    require!(
        w.state == WINDOW_COMMIT || w.state == WINDOW_SETTLING,
        ProtocolError::WindowNotSettling
    );
    require!(now >= w.reveal_end, ProtocolError::WindowRevealNotOver);
    w.state = WINDOW_SETTLING;
    w.clearing_price = clearing_price;
    w.no_match_proposed = no_match;
    w.d_above = 0;
    w.d_at = 0;
    w.s_below = 0;
    w.s_at = 0;
    w.max_bid = 0;
    w.min_ask = u64::MAX;
    w.valid_orders = 0;
    w.tallied = 0;
    w.tally_round = w
        .tally_round
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    Ok(())
}

/// Remaining accounts: up to 24 `Order` PDAs of this window (writable).
pub fn tally_orders<'info>(ctx: Context<'info, WindowSettle<'info>>) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let w = &mut ctx.accounts.window;
    require!(w.state == WINDOW_SETTLING, ProtocolError::WindowNotSettling);
    require!(
        ctx.remaining_accounts.len() <= TALLY_PAGE,
        ProtocolError::TallyPageTooLarge
    );
    for info in ctx.remaining_accounts.iter() {
        require_keys_eq!(*info.owner, crate::ID, ProtocolError::OrderMismatch);
        let mut o: Order = {
            let data = info.try_borrow_data()?;
            Order::try_deserialize(&mut &data[..])?
        };
        require!(
            o.series == series_key && o.period == w.period,
            ProtocolError::OrderMismatch
        );
        let expected = Pubkey::create_program_address(
            &[
                seeds::ORDER,
                series_key.as_ref(),
                &w.period.to_le_bytes(),
                o.owner.as_ref(),
                &[o.side],
                &[o.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| ProtocolError::OrderMismatch)?;
        require_keys_eq!(expected, *info.key, ProtocolError::OrderMismatch);
        if !o.revealed || o.tallied_round == w.tally_round {
            continue;
        }
        if o.valid {
            w.valid_orders = w
                .valid_orders
                .checked_add(1)
                .ok_or(ProtocolError::MathOverflow)?;
            if o.side == SIDE_BID {
                if o.price > w.clearing_price {
                    w.d_above = w
                        .d_above
                        .checked_add(o.quantity)
                        .ok_or(ProtocolError::MathOverflow)?;
                } else if o.price == w.clearing_price {
                    w.d_at = w
                        .d_at
                        .checked_add(o.quantity)
                        .ok_or(ProtocolError::MathOverflow)?;
                }
                w.max_bid = core::cmp::max(w.max_bid, o.price);
            } else {
                if o.price < w.clearing_price {
                    w.s_below = w
                        .s_below
                        .checked_add(o.quantity)
                        .ok_or(ProtocolError::MathOverflow)?;
                } else if o.price == w.clearing_price {
                    w.s_at = w
                        .s_at
                        .checked_add(o.quantity)
                        .ok_or(ProtocolError::MathOverflow)?;
                }
                w.min_ask = core::cmp::min(w.min_ask, o.price);
            }
        }
        o.tallied_round = w.tally_round;
        w.tallied = w
            .tallied
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
        let mut data = info.try_borrow_mut_data()?;
        o.try_serialize(&mut &mut data[..])?;
    }
    Ok(())
}

pub fn finalize_window(ctx: Context<WindowSettle>) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let w = &mut ctx.accounts.window;
    require!(w.state == WINDOW_SETTLING, ProtocolError::WindowNotSettling);
    let revealed = w
        .revealed_bids
        .checked_add(w.revealed_asks)
        .ok_or(ProtocolError::MathOverflow)?;
    require!(w.tallied == revealed, ProtocolError::TallyIncomplete);
    let tally = WindowTally {
        d_above: w.d_above,
        d_at: w.d_at,
        s_below: w.s_below,
        s_at: w.s_at,
        max_bid: w.max_bid,
        min_ask: w.min_ask,
        valid_orders: w.valid_orders,
    };
    if w.no_match_proposed {
        require!(
            no_match_is_valid(&tally),
            ProtocolError::InvalidWindowClearing
        );
        w.state = WINDOW_NO_MATCH;
        emit!(WindowNoMatch {
            series: series_key,
            period: w.period,
        });
    } else {
        let c = check_window_clearing(&tally)
            .map_err(math)?
            .ok_or(ProtocolError::InvalidWindowClearing)?;
        w.state = WINDOW_SETTLED;
        w.matched_units = c.matched_units;
        w.remainder_for_bids_at = c.remainder_for_bids_at;
        emit!(WindowCleared {
            series: series_key,
            period: w.period,
            clearing_price: w.clearing_price,
            matched_units: c.matched_units,
        });
    }
    ctx.accounts.ledger.active_window = None;
    Ok(())
}

// -------------------------------------------------------------------------------- process_order

#[derive(Accounts)]
pub struct ProcessOrder<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
    #[account(mut, seeds = [seeds::ORDER, series.key().as_ref(), window.period.to_le_bytes().as_ref(), owner.key().as_ref(), &[order.side]], bump = order.bump)]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the order's owner; units and stablecoin go to its associated token accounts only.
    #[account(address = order.owner @ ProtocolError::OrderMismatch)]
    pub owner: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = payer, space = 8 + Holder::INIT_SPACE, seeds = [seeds::HOLDER, series.key().as_ref(), owner.key().as_ref()], bump)]
    pub holder: Box<Account<'info, Holder>>,
    #[account(
        mut,
        associated_token::mint = unit_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_2022_program,
    )]
    pub owner_unit_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = stablecoin_mint,
        associated_token::authority = owner,
        associated_token::token_program = stablecoin_program,
    )]
    pub owner_stable_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::WINDOW_UNITS, series.key().as_ref()], bump)]
    pub window_units: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::WINDOW_STABLE, series.key().as_ref()], bump)]
    pub window_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less signer PDA owning both window escrows.
    #[account(seeds = [seeds::WINDOW_ESCROW, series.key().as_ref()], bump)]
    pub window_escrow: UncheckedAccount<'info>,
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
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// `process_order` (SPEC §7). Bids are processed first; asks only once every bid is processed and
/// the unmatched remainder has been assigned by `return_dust`. In the `NoMatch` state every order
/// is refunded in full. Remaining accounts: hook extra accounts for the unit mint (and for a
/// Token-2022 stablecoin).
pub fn process_order<'info>(ctx: Context<'info, ProcessOrder<'info>>) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    let w = &ctx.accounts.window;
    require!(
        w.state == WINDOW_SETTLED || w.state == WINDOW_NO_MATCH,
        ProtocolError::WindowNotSettled
    );
    let o = &ctx.accounts.order;
    require!(!o.processed, ProtocolError::OrderAlreadyProcessed);
    let decimals = series.stablecoin_decimals;
    let escrow_bump = [ctx.bumps.window_escrow];
    let escrow_seeds: &[&[u8]] = &[seeds::WINDOW_ESCROW, series_key.as_ref(), &escrow_bump];
    let token_2022 = ctx.accounts.token_2022_program.to_account_info();
    let stable_program = ctx.accounts.stablecoin_program.to_account_info();
    let unit_mint = ctx.accounts.unit_mint.to_account_info();
    let stable_mint = ctx.accounts.stablecoin_mint.to_account_info();
    let window_units = ctx.accounts.window_units.to_account_info();
    let window_stable = ctx.accounts.window_stable.to_account_info();
    let escrow_auth = ctx.accounts.window_escrow.to_account_info();
    let owner_units = ctx.accounts.owner_unit_ata.to_account_info();
    let owner_stable = ctx.accounts.owner_stable_ata.to_account_info();
    let owner = ctx.accounts.owner.key();
    let no_match = w.state == WINDOW_NO_MATCH;
    let p = w.clearing_price;

    let (fill, fee, refund) = if o.side == SIDE_BID {
        let fill = if no_match || !o.revealed || !o.valid {
            0
        } else {
            bid_fill(o.price, o.quantity, p, w.remainder_for_bids_at, w.d_at).map_err(math)?
        };
        let (cost, fee, refund) =
            settle_buyer(p, fill, o.escrow, series.window_fee_bps).map_err(math)?;
        // wallet cap re-check (the hook enforces it too)
        if fill > 0 {
            let cap = wallet_cap_units(ctx.accounts.unit_mint.supply, series.wallet_cap_bps)
                .map_err(math)?;
            let after = ctx
                .accounts
                .owner_unit_ata
                .amount
                .checked_add(fill)
                .ok_or(ProtocolError::MathOverflow)?;
            require!(after <= cap, ProtocolError::WalletCapExceeded);
        }
        transfer_stable(
            &stable_program,
            &window_stable,
            &stable_mint,
            &ctx.accounts.fee_collector_ata.to_account_info(),
            &escrow_auth,
            ctx.remaining_accounts,
            fee,
            decimals,
            &[escrow_seeds],
        )?;
        transfer_stable(
            &stable_program,
            &window_stable,
            &stable_mint,
            &owner_stable,
            &escrow_auth,
            ctx.remaining_accounts,
            refund,
            decimals,
            &[escrow_seeds],
        )?;
        if fill > 0 {
            // register / settle the buyer before its balance changes
            let bump = ctx.bumps.holder;
            if !register_holder_now(
                &ctx.accounts.ledger,
                &mut ctx.accounts.holder,
                series_key,
                owner,
                bump,
            )? {
                settle_holder(
                    &ctx.accounts.ledger,
                    &mut ctx.accounts.holder,
                    ctx.accounts.owner_unit_ata.amount,
                )?;
            }
            transfer_units(
                &token_2022,
                &window_units,
                &unit_mint,
                &owner_units,
                &escrow_auth,
                ctx.remaining_accounts,
                fill,
                &[escrow_seeds],
            )?;
        }
        let w = &mut ctx.accounts.window;
        w.bid_fills_total = w
            .bid_fills_total
            .checked_add(fill)
            .ok_or(ProtocolError::MathOverflow)?;
        w.bids_processed = w
            .bids_processed
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
        let _ = cost;
        (fill, fee, refund)
    } else {
        if !no_match {
            require!(
                w.bids_processed == w.bid_count,
                ProtocolError::BidsBeforeAsks
            );
            let unmatched = w
                .matched_units
                .checked_sub(w.bid_fills_total)
                .ok_or(ProtocolError::MathOverflow)?;
            require!(w.dust_assigned == unmatched, ProtocolError::DustNotReturned);
        }
        let fill = if no_match || !o.revealed || !o.valid {
            0
        } else {
            ask_fill(o.price, o.quantity, p)
                .checked_sub(o.dust_received)
                .ok_or(ProtocolError::MathOverflow)?
        };
        let proceeds = p.checked_mul(fill).ok_or(ProtocolError::MathOverflow)?;
        let units_back = o
            .escrow
            .checked_sub(fill)
            .ok_or(ProtocolError::MathOverflow)?;
        // seller: settle current balance, then credit escrow-period payouts on the escrowed units
        require!(
            ctx.accounts.holder.registered,
            ProtocolError::HolderNotRegistered
        );
        settle_holder(
            &ctx.accounts.ledger,
            &mut ctx.accounts.holder,
            ctx.accounts.owner_unit_ata.amount,
        )?;
        let escrow_accrual = holder_delta(
            ctx.accounts.ledger.net_acc_wad,
            o.net_acc_snapshot,
            o.escrow,
        )
        .map_err(math)?;
        ctx.accounts.holder.pending = ctx
            .accounts
            .holder
            .pending
            .checked_add(escrow_accrual)
            .ok_or(ProtocolError::MathOverflow)?;
        transfer_stable(
            &stable_program,
            &window_stable,
            &stable_mint,
            &owner_stable,
            &escrow_auth,
            ctx.remaining_accounts,
            proceeds,
            decimals,
            &[escrow_seeds],
        )?;
        transfer_units(
            &token_2022,
            &window_units,
            &unit_mint,
            &owner_units,
            &escrow_auth,
            ctx.remaining_accounts,
            units_back,
            &[escrow_seeds],
        )?;
        let w = &mut ctx.accounts.window;
        w.asks_processed = w
            .asks_processed
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
        (fill, 0u64, units_back)
    };
    let o = &mut ctx.accounts.order;
    o.processed = true;
    o.fill = fill;
    emit!(OrderFilled {
        series: series_key,
        period: o.period,
        owner,
        side: o.side,
        fill,
        price: if no_match { 0 } else { p },
        fee,
        refund,
    });
    Ok(())
}

// ---------------------------------------------------------------------------------- return_dust

#[derive(Accounts)]
pub struct ReturnDust<'info> {
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
}

/// Assigns the unmatched remainder `U = S − Σ bid fills` back to the asks at or below `p*`, in
/// descending price then descending reveal-index order (remaining accounts, ≤ 24 per call). Asks
/// then receive `quantity − dust_received` as their fill when processed.
pub fn return_dust<'info>(ctx: Context<'info, ReturnDust<'info>>) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let w = &mut ctx.accounts.window;
    require!(w.state == WINDOW_SETTLED, ProtocolError::WindowNotSettled);
    require!(
        w.bids_processed == w.bid_count,
        ProtocolError::BidsBeforeAsks
    );
    require!(
        ctx.remaining_accounts.len() <= TALLY_PAGE,
        ProtocolError::TallyPageTooLarge
    );
    let unmatched = w
        .matched_units
        .checked_sub(w.bid_fills_total)
        .ok_or(ProtocolError::MathOverflow)?;
    for info in ctx.remaining_accounts.iter() {
        if w.dust_assigned >= unmatched {
            break;
        }
        require_keys_eq!(*info.owner, crate::ID, ProtocolError::OrderMismatch);
        let mut o: Order = {
            let data = info.try_borrow_data()?;
            Order::try_deserialize(&mut &data[..])?
        };
        require!(
            o.series == series_key && o.period == w.period && o.side == SIDE_ASK,
            ProtocolError::OrderMismatch
        );
        let expected = Pubkey::create_program_address(
            &[
                seeds::ORDER,
                series_key.as_ref(),
                &w.period.to_le_bytes(),
                o.owner.as_ref(),
                &[o.side],
                &[o.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| ProtocolError::OrderMismatch)?;
        require_keys_eq!(expected, *info.key, ProtocolError::OrderMismatch);
        require!(
            o.revealed && o.valid && o.price <= w.clearing_price && !o.processed,
            ProtocolError::DustOrderViolation
        );
        if w.dust_started {
            let before = o.price < w.dust_cursor_price
                || (o.price == w.dust_cursor_price && o.reveal_index < w.dust_cursor_index);
            require!(before, ProtocolError::DustOrderViolation);
        }
        let room = o
            .quantity
            .checked_sub(o.dust_received)
            .ok_or(ProtocolError::MathOverflow)?;
        let give = core::cmp::min(
            room,
            unmatched
                .checked_sub(w.dust_assigned)
                .ok_or(ProtocolError::MathOverflow)?,
        );
        o.dust_received = o
            .dust_received
            .checked_add(give)
            .ok_or(ProtocolError::MathOverflow)?;
        w.dust_assigned = w
            .dust_assigned
            .checked_add(give)
            .ok_or(ProtocolError::MathOverflow)?;
        w.dust_started = true;
        w.dust_cursor_price = o.price;
        w.dust_cursor_index = o.reveal_index;
        let mut data = info.try_borrow_mut_data()?;
        o.try_serialize(&mut &mut data[..])?;
    }
    Ok(())
}
