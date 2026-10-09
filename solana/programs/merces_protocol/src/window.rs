//! Transfer window (SPEC v1.1 §7, brief D9): the only path through which sealed-bid units change
//! hands. One order per wallet per window; armed ask deposits; two-branch clearing; first-come
//! fills at the margin. Ships closed (`windows_enabled = false`).

use anchor_lang::prelude::*;
use anchor_lang::AccountsExit;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount, TokenInterface};
use merces_common::auction::wallet_cap_units;
use merces_common::encoding::commitment_preimage;
use merces_common::status::SeriesStatus;
use merces_common::time::period_of;
use merces_common::window::{
    ask_is_valid, bid_is_valid, check_window_clearing, classify, no_match_is_valid, settle_buyer,
    Branch, FillClass, WindowTally,
};
use merces_onchain::keccak;
use merces_onchain::seeds::{ALLOW, CONFIG};
use merces_registry::state::{AllowlistEntry, ProtocolConfig, Series};

use crate::common::*;
use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::state::*;

/// Reason codes (`WindowSettlementRejected.reason`).
pub const WINDOW_REJECT_NO_MATCH_INVALID: u8 = 1;
pub const WINDOW_REJECT_PRICE_NOT_REVEALED: u8 = 2;
pub const WINDOW_REJECT_NO_CROSSING: u8 = 3;

/// Clearing price sentinel for a `NO_MATCH` proposal in events.
pub const NO_MATCH_PRICE: u64 = u64::MAX;

fn branch_of(w: &Window) -> Branch {
    if w.branch == Branch::DemandLimited as u8 {
        Branch::DemandLimited
    } else {
        Branch::SupplyLimited
    }
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
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    /// `init_if_needed` so a second `open_window` for the same period reverts `WindowAlreadyOpen`
    /// instead of failing account creation; the handler refuses any already-used window account.
    #[account(init_if_needed, payer = payer, space = 8 + Window::INIT_SPACE, seeds = [seeds::WINDOW, series.key().as_ref(), period.to_le_bytes().as_ref()], bump)]
    pub window: Box<Account<'info, Window>>,
    pub system_program: Program<'info, System>,
}

pub fn open_window(ctx: Context<OpenWindow>, period: u32) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    require!(
        ctx.accounts.config.windows_enabled,
        ProtocolError::WindowsDisabled
    );
    require!(ledger.is_mint_finalized(), ProtocolError::MintNotFinalized);
    let status = ledger.sync_status(now, series_key)?;
    require!(
        matches!(status, SeriesStatus::OnTime | SeriesStatus::InGrace),
        ProtocolError::WindowStatusNotAllowed
    );
    let unlock = ledger
        .settlement_ts
        .checked_add(series.lockup_seconds)
        .ok_or(ProtocolError::MathOverflow)?;
    require!(now >= unlock, ProtocolError::LockupActive);
    require!(
        matches!(ledger.last_paid_period(), Some(p) if p >= period),
        ProtocolError::ReportNotPaid
    );
    let current = period_of(now).map_err(math)?;
    require!(
        current.checked_sub(1) == Some(period),
        ProtocolError::WindowWrongPeriod
    );
    require!(
        ledger.active_window().is_none(),
        ProtocolError::WindowAlreadyOpen
    );
    require!(
        ctx.accounts.window.state == WINDOW_CLOSED
            && ctx.accounts.window.series == Pubkey::default(),
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
    ledger.set_active_window(Some(period));
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
    #[account(seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
    #[account(init, payer = owner, space = 8 + Order::INIT_SPACE, seeds = [seeds::ORDER, series.key().as_ref(), window.period.to_le_bytes().as_ref(), owner.key().as_ref()], bump)]
    pub order: Box<Account<'info, Order>>,
    #[account(mut, seeds = [seeds::HOLDER, series.key().as_ref(), owner.key().as_ref()], bump = holder.bump)]
    pub holder: Box<Account<'info, Holder>>,
    /// Armed by this instruction right before the transfer and cleared after it (SPEC §4.1).
    #[account(mut, seeds = [seeds::ESCROW_ARM, unit_mint.key().as_ref()], bump = escrow_arm.bump)]
    pub escrow_arm: Box<Account<'info, EscrowArm>>,
    /// CHECK: the owner's unit ATA; derivation validated in the handler.
    #[account(mut)]
    pub owner_unit_ata: UncheckedAccount<'info>,
    /// CHECK: the window unit escrow ATA recorded in the registry.
    #[account(mut, address = series.window_escrow_ata @ ProtocolError::EscrowAccountMismatch)]
    pub window_escrow_ata: UncheckedAccount<'info>,
    /// CHECK: the unit mint recorded in the registry.
    #[account(address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: UncheckedAccount<'info>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Escrows `units` with a sealed ask through an armed deposit. Remaining accounts: the Merces hook
/// accounts for the unit mint.
pub fn commit_ask<'info>(
    ctx: Context<'info, CommitAsk<'info>>,
    commitment: [u8; 32],
    units: u64,
) -> Result<()> {
    let ledger = ctx.accounts.ledger.load()?;
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let owner = ctx.accounts.owner.key();
    let w = &ctx.accounts.window;
    require!(
        w.state == WINDOW_COMMIT && now < w.commit_end,
        ProtocolError::WindowNotCommit
    );
    require!(units > 0, ProtocolError::ZeroUnits);
    require_ata(
        &ctx.accounts.owner_unit_ata.to_account_info(),
        &owner,
        &ctx.accounts.series.unit_mint,
        &ctx.accounts.token_2022_program.key(),
    )?;
    let balance = token_account_amount(&ctx.accounts.owner_unit_ata.to_account_info())?;
    require!(units <= balance, ProtocolError::AskExceedsBalance);
    // settle before the escrow accounting changes (the weight itself is unchanged)
    settle_holder(&ledger, &mut ctx.accounts.holder, balance)?;
    // arm, transfer, clear
    let arm = &mut ctx.accounts.escrow_arm;
    require!(arm.armed_units == 0, ProtocolError::EscrowArmBusy);
    arm.armed_owner = owner;
    arm.armed_units = units;
    ctx.accounts.escrow_arm.exit(&crate::ID)?;
    transfer_units(
        &ctx.accounts.token_2022_program.to_account_info(),
        &ctx.accounts.owner_unit_ata.to_account_info(),
        &ctx.accounts.unit_mint.to_account_info(),
        &ctx.accounts.window_escrow_ata.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        ctx.remaining_accounts,
        units,
        &[],
    )?;
    let arm = &mut ctx.accounts.escrow_arm;
    arm.armed_owner = Pubkey::default();
    arm.armed_units = 0;
    let h = &mut ctx.accounts.holder;
    h.ask_escrow_units = h
        .ask_escrow_units
        .checked_add(units)
        .ok_or(ProtocolError::MathOverflow)?;
    let w = &mut ctx.accounts.window;
    w.escrow_units = w
        .escrow_units
        .checked_add(units)
        .ok_or(ProtocolError::MathOverflow)?;
    w.ask_count = w
        .ask_count
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    w.order_count = w
        .order_count
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    let o = &mut ctx.accounts.order;
    o.series = series_key;
    o.period = w.period;
    o.owner = owner;
    o.side = SIDE_ASK;
    o.commitment = commitment;
    o.escrow = units;
    o.bump = ctx.bumps.order;
    emit!(OrderCommitted {
        series: series_key,
        period: w.period,
        owner,
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
    /// CHECK: the owner's registry `AllowlistEntry` PDA; validated in the handler after the phase checks.
    pub owner_allowlist: UncheckedAccount<'info>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
    #[account(init, payer = owner, space = 8 + Order::INIT_SPACE, seeds = [seeds::ORDER, series.key().as_ref(), window.period.to_le_bytes().as_ref(), owner.key().as_ref()], bump)]
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
    require_allowlisted(
        &ctx.accounts.owner_allowlist.to_account_info(),
        &ctx.accounts.owner.key(),
    )?;
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
    w.order_count = w
        .order_count
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
pub struct RevealOrder<'info> {
    pub owner: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
    #[account(mut, seeds = [seeds::ORDER, series.key().as_ref(), window.period.to_le_bytes().as_ref(), owner.key().as_ref()], bump = order.bump)]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the owner's unit ATA (bids: wallet-cap room); derivation validated in the handler.
    pub owner_unit_ata: UncheckedAccount<'info>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Reveals the order; a validity failure records `valid = false` and never reverts.
pub fn reveal_order(
    ctx: Context<RevealOrder>,
    price: u64,
    quantity: u64,
    salt: [u8; 32],
) -> Result<()> {
    let ledger = ctx.accounts.ledger.load()?;
    let now = now_ts()?;
    let series = &ctx.accounts.series;
    let w = &mut ctx.accounts.window;
    require!(
        w.state == WINDOW_COMMIT && now >= w.commit_end && now < w.reveal_end,
        ProtocolError::WindowNotReveal
    );
    let o = &mut ctx.accounts.order;
    require!(!o.revealed, ProtocolError::AlreadyRevealed);
    let wallet = ctx.accounts.owner.key().to_bytes();
    let expected = keccak(&[commitment_preimage(price, quantity, &salt, &wallet).as_bytes()]);
    require!(expected == o.commitment, ProtocolError::CommitmentMismatch);
    o.revealed = true;
    o.price = price;
    o.quantity = quantity;
    let valid = if o.side == SIDE_ASK {
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
        require_ata(
            &ctx.accounts.owner_unit_ata.to_account_info(),
            &ctx.accounts.owner.key(),
            &series.unit_mint,
            &ctx.accounts.token_2022_program.key(),
        )?;
        // a missing ATA holds no units
        let balance = if ctx.accounts.owner_unit_ata.data_is_empty() {
            0
        } else {
            token_account_amount(&ctx.accounts.owner_unit_ata.to_account_info())?
        };
        let cap =
            wallet_cap_units(ledger.units_outstanding, series.wallet_cap_bps).map_err(math)?;
        bid_is_valid(
            price,
            quantity,
            o.escrow,
            series.window_fee_bps,
            cap,
            balance,
        )
    };
    o.valid = valid;
    w.revealed_count = w
        .revealed_count
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    emit!(OrderRevealed {
        series: series.key(),
        period: w.period,
        owner: o.owner,
        side: o.side,
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
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
}

/// Proposes `clearing_price` (or `NO_MATCH`). Allowed only when no round is in progress.
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
    require!(
        w.tally_round == 0 || w.round_rejected,
        ProtocolError::TallyInProgress
    );
    w.state = WINDOW_SETTLING;
    w.tally_round = w
        .tally_round
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    w.round_rejected = false;
    w.rejection_reason = 0;
    w.clearing_price = clearing_price;
    w.no_match_proposed = no_match;
    w.d_above = 0;
    w.d_at = 0;
    w.s_below = 0;
    w.s_at = 0;
    w.max_bid = 0;
    w.min_ask = u64::MAX;
    w.valid_count = 0;
    w.tallied_count = 0;
    Ok(())
}

/// Remaining accounts: up to 24 `Order` PDAs of this window (writable).
pub fn tally_orders<'info>(ctx: Context<'info, WindowSettle<'info>>) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let w = &mut ctx.accounts.window;
    require!(
        w.state == WINDOW_SETTLING && !w.round_rejected,
        ProtocolError::WindowNotSettling
    );
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
            w.valid_count = w
                .valid_count
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
        w.tallied_count = w
            .tallied_count
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
        let mut data = info.try_borrow_mut_data()?;
        o.try_serialize(&mut &mut data[..])?;
    }
    Ok(())
}

/// `finalize_window` (SPEC §7): never reverts on a wrong proposal.
pub fn finalize_window(ctx: Context<WindowSettle>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let series_key = ctx.accounts.series.key();
    let w = &mut ctx.accounts.window;
    require!(
        w.state == WINDOW_SETTLING && !w.round_rejected,
        ProtocolError::WindowNotSettling
    );
    require!(
        w.tallied_count == w.revealed_count,
        ProtocolError::TallyIncomplete
    );
    let tally = WindowTally {
        d_above: w.d_above,
        d_at: w.d_at,
        s_below: w.s_below,
        s_at: w.s_at,
        max_bid: w.max_bid,
        min_ask: w.min_ask,
        valid_count: w.valid_count,
    };
    let reject = |w: &mut Window, price: u64, reason: u8| {
        w.round_rejected = true;
        w.rejection_reason = reason;
        emit!(WindowSettlementRejected {
            series: series_key,
            period: w.period,
            clearing_price: price,
            reason,
        });
    };
    if w.no_match_proposed {
        if !no_match_is_valid(&tally) {
            reject(w, NO_MATCH_PRICE, WINDOW_REJECT_NO_MATCH_INVALID);
            return Ok(());
        }
        w.state = WINDOW_NO_MATCH;
        emit!(WindowNoMatch {
            series: series_key,
            period: w.period,
        });
    } else {
        match check_window_clearing(&tally).map_err(math)? {
            Ok(c) => {
                w.state = WINDOW_SETTLED;
                w.branch = c.branch as u8;
                w.matched_units = c.matched_units;
                w.marginal_remaining = c.marginal_remaining;
                w.ask_budget = c.matched_units;
                w.next_bid_index = 0;
                w.next_ask_index = 0;
                emit!(WindowCleared {
                    series: series_key,
                    period: w.period,
                    clearing_price: w.clearing_price,
                    matched_units: c.matched_units,
                    branch: c.branch as u8,
                });
            }
            Err(r) => {
                let p = w.clearing_price;
                reject(w, p, r as u8);
                return Ok(());
            }
        }
    }
    ledger.set_active_window(None);
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
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
    #[account(mut, seeds = [seeds::ORDER, series.key().as_ref(), window.period.to_le_bytes().as_ref(), owner.key().as_ref()], bump = order.bump)]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the order's owner; units and stablecoin go to its associated token accounts only.
    #[account(address = order.owner @ ProtocolError::OrderMismatch)]
    pub owner: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = payer, space = 8 + Holder::INIT_SPACE, seeds = [seeds::HOLDER, series.key().as_ref(), owner.key().as_ref()], bump)]
    pub holder: Box<Account<'info, Holder>>,
    /// The buyer's allowlist entry (re-checked at fill); a missing or `allowed = false` entry
    /// cancels the fill. Ignored for asks.
    #[account(seeds = [ALLOW, owner.key().as_ref()], bump = owner_allowlist.bump, seeds::program = merces_registry::ID)]
    pub owner_allowlist: Option<Box<Account<'info, AllowlistEntry>>>,
    /// CHECK: the owner's unit ATA (created idempotently for buyers; derivation validated).
    #[account(mut)]
    pub owner_unit_ata: UncheckedAccount<'info>,
    /// CHECK: the owner's stablecoin ATA (created idempotently; derivation validated).
    #[account(mut)]
    pub owner_stable_ata: UncheckedAccount<'info>,
    /// CHECK: the window unit escrow ATA recorded in the registry.
    #[account(mut, address = series.window_escrow_ata @ ProtocolError::EscrowAccountMismatch)]
    pub window_escrow_ata: UncheckedAccount<'info>,
    /// CHECK: the window stablecoin escrow PDA created in `prepare_raise`.
    #[account(mut, seeds = [seeds::WINDOW_STABLE, series.key().as_ref()], bump)]
    pub window_stable: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA owning both window escrows.
    #[account(seeds = [seeds::WINDOW_ESCROW, series.key().as_ref()], bump)]
    pub window_escrow_auth: UncheckedAccount<'info>,
    /// CHECK: the fee collector's ATA; derivation validated in the handler.
    #[account(mut)]
    pub fee_collector_ata: UncheckedAccount<'info>,
    /// CHECK: the unit mint recorded in the registry.
    #[account(address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: UncheckedAccount<'info>,
    /// CHECK: the stablecoin mint recorded in the registry.
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: UncheckedAccount<'info>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// `process_order` (SPEC §7), exhaustive. Revealed orders are processed in ascending per-side
/// reveal index, every bid before any ask, so first-come marginal fills are deterministic and a
/// buyer whose fill is cancelled (allowlist removed) shrinks the asks' budget before any ask is
/// paid. Unrevealed orders and every order of a `NoMatch` window can be processed at any time.
/// Remaining accounts: the Merces hook accounts for the unit mint and the stablecoin's hook
/// accounts, if any.
pub fn process_order<'info>(ctx: Context<'info, ProcessOrder<'info>>) -> Result<()> {
    let ledger = ctx.accounts.ledger.load()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    let w = &ctx.accounts.window;
    require!(
        w.state == WINDOW_SETTLED || w.state == WINDOW_NO_MATCH,
        ProtocolError::WindowNotSettled
    );
    let o = &ctx.accounts.order;
    require!(!o.processed, ProtocolError::OrderAlreadyProcessed);
    let owner = ctx.accounts.owner.key();
    let stable_program = ctx.accounts.stablecoin_program.key();
    let t22 = ctx.accounts.token_2022_program.key();
    require_ata(
        &ctx.accounts.owner_unit_ata.to_account_info(),
        &owner,
        &series.unit_mint,
        &t22,
    )?;
    require_ata(
        &ctx.accounts.owner_stable_ata.to_account_info(),
        &owner,
        &series.stablecoin,
        &stable_program,
    )?;
    require_ata(
        &ctx.accounts.fee_collector_ata.to_account_info(),
        &ctx.accounts.config.fee_collector,
        &series.stablecoin,
        &stable_program,
    )?;
    let no_match = w.state == WINDOW_NO_MATCH;
    let live = !no_match && o.revealed && o.valid;
    // ordering
    if !no_match && o.revealed {
        if o.side == SIDE_BID {
            require!(
                o.reveal_index == w.next_bid_index,
                ProtocolError::OutOfOrder
            );
        } else {
            require!(
                w.next_bid_index == w.revealed_bids,
                ProtocolError::OutOfOrder
            );
            require!(
                o.reveal_index == w.next_ask_index,
                ProtocolError::OutOfOrder
            );
        }
    }
    let p = w.clearing_price;
    let branch = branch_of(w);
    let decimals = series.stablecoin_decimals;
    let escrow_bump = [ctx.bumps.window_escrow_auth];
    let escrow_seeds: &[&[u8]] = &[seeds::WINDOW_ESCROW, series_key.as_ref(), &escrow_bump];
    let token_2022 = ctx.accounts.token_2022_program.to_account_info();
    let stable_program_info = ctx.accounts.stablecoin_program.to_account_info();
    let unit_mint = ctx.accounts.unit_mint.to_account_info();
    let stable_mint = ctx.accounts.stablecoin_mint.to_account_info();
    let window_units = ctx.accounts.window_escrow_ata.to_account_info();
    let window_stable = ctx.accounts.window_stable.to_account_info();
    let escrow_auth = ctx.accounts.window_escrow_auth.to_account_info();
    let owner_units = ctx.accounts.owner_unit_ata.to_account_info();
    let owner_stable = ctx.accounts.owner_stable_ata.to_account_info();
    let payer = ctx.accounts.payer.to_account_info();
    let owner_info = ctx.accounts.owner.to_account_info();
    let system_program = ctx.accounts.system_program.to_account_info();
    let ata_program = ctx.accounts.associated_token_program.to_account_info();

    // class fill (before budget / allowlist adjustments)
    let mut fill = if live {
        match classify(o.side, o.price, p, branch) {
            FillClass::Full => o.quantity,
            FillClass::Losing => 0,
            FillClass::Marginal => core::cmp::min(o.quantity, w.marginal_remaining),
        }
    } else {
        0
    };
    let class_fill = fill;

    let (fee, refund) = if o.side == SIDE_BID {
        let allowed = ctx
            .accounts
            .owner_allowlist
            .as_ref()
            .is_some_and(|e| e.allowed);
        if fill > 0 && !allowed {
            // cancelled: full refund; the units stay unmatched and return through the asks
            fill = 0;
        }
        let (_cost, fee, refund) =
            settle_buyer(p, fill, o.escrow, series.window_fee_bps).map_err(math)?;
        create_ata_idempotent(CreateAta {
            payer: &payer,
            ata: &owner_stable,
            owner: &owner_info,
            mint: &stable_mint,
            system_program: &system_program,
            token_program: &stable_program_info,
            ata_program: &ata_program,
        })?;
        transfer_stable(
            &stable_program_info,
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
            &stable_program_info,
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
            create_ata_idempotent(CreateAta {
                payer: &payer,
                ata: &owner_units,
                owner: &owner_info,
                mint: &unit_mint,
                system_program: &system_program,
                token_program: &token_2022,
                ata_program: &ata_program,
            })?;
            // register / settle the buyer before its balance changes
            let bump = ctx.bumps.holder;
            if !register_holder_now(&ledger, &mut ctx.accounts.holder, series_key, owner, bump)? {
                let balance = token_account_amount(&owner_units)?;
                settle_holder(&ledger, &mut ctx.accounts.holder, balance)?;
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
        if live {
            if class_fill > 0 && fill == 0 {
                w.ask_budget = w
                    .ask_budget
                    .checked_sub(class_fill)
                    .ok_or(ProtocolError::MathOverflow)?;
            }
            if classify(SIDE_BID, o.price, p, branch) == FillClass::Marginal {
                w.marginal_remaining = w
                    .marginal_remaining
                    .checked_sub(class_fill)
                    .ok_or(ProtocolError::MathOverflow)?;
            }
        }
        // fee and refund leave the escrow now; the cost stays for the asks
        let leaving = fee.checked_add(refund).ok_or(ProtocolError::MathOverflow)?;
        w.escrow_stable = w
            .escrow_stable
            .checked_sub(leaving)
            .ok_or(ProtocolError::MathOverflow)?;
        w.escrow_units = w
            .escrow_units
            .checked_sub(fill)
            .ok_or(ProtocolError::MathOverflow)?;
        w.bids_processed = w
            .bids_processed
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
        if !no_match && o.revealed {
            w.next_bid_index = w
                .next_bid_index
                .checked_add(1)
                .ok_or(ProtocolError::MathOverflow)?;
        }
        (fee, refund)
    } else {
        if live {
            fill = core::cmp::min(fill, w.ask_budget);
        }
        let proceeds = p.checked_mul(fill).ok_or(ProtocolError::MathOverflow)?;
        let units_back = o
            .escrow
            .checked_sub(fill)
            .ok_or(ProtocolError::MathOverflow)?;
        // seller: settle at the current weight, then release the escrow accounting
        require!(
            ctx.accounts.holder.registered,
            ProtocolError::HolderNotRegistered
        );
        let balance = token_account_amount(&owner_units)?;
        settle_holder(&ledger, &mut ctx.accounts.holder, balance)?;
        let h = &mut ctx.accounts.holder;
        h.ask_escrow_units = h
            .ask_escrow_units
            .checked_sub(o.escrow)
            .ok_or(ProtocolError::MathOverflow)?;
        if proceeds > 0 {
            create_ata_idempotent(CreateAta {
                payer: &payer,
                ata: &owner_stable,
                owner: &owner_info,
                mint: &stable_mint,
                system_program: &system_program,
                token_program: &stable_program_info,
                ata_program: &ata_program,
            })?;
            transfer_stable(
                &stable_program_info,
                &window_stable,
                &stable_mint,
                &owner_stable,
                &escrow_auth,
                ctx.remaining_accounts,
                proceeds,
                decimals,
                &[escrow_seeds],
            )?;
        }
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
        if live {
            w.ask_budget = w
                .ask_budget
                .checked_sub(fill)
                .ok_or(ProtocolError::MathOverflow)?;
            if classify(SIDE_ASK, o.price, p, branch) == FillClass::Marginal {
                w.marginal_remaining = w
                    .marginal_remaining
                    .checked_sub(class_fill)
                    .ok_or(ProtocolError::MathOverflow)?;
            }
        }
        w.escrow_units = w
            .escrow_units
            .checked_sub(units_back)
            .ok_or(ProtocolError::MathOverflow)?;
        w.escrow_stable = w
            .escrow_stable
            .checked_sub(proceeds)
            .ok_or(ProtocolError::MathOverflow)?;
        w.asks_processed = w
            .asks_processed
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
        if !no_match && o.revealed {
            w.next_ask_index = w
                .next_ask_index
                .checked_add(1)
                .ok_or(ProtocolError::MathOverflow)?;
        }
        (0u64, units_back)
    };
    let w = &mut ctx.accounts.window;
    w.processed_count = w
        .processed_count
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
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
