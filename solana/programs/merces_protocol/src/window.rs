//! Transfer window (SPEC v1.1 §7, brief D9): the only path through which sealed-bid units change
//! hands. One order per wallet per window; armed ask deposits; two-branch clearing; first-come
//! fills at the margin; buyers re-checked against the allowlist at fill. Ships closed
//! (`windows_enabled = false`).
//!
//! Settlement is two-step, like the primary auction (SPEC §5.2): `process_order` does the
//! accounting in a fixed order (revealed bids by reveal index, then revealed asks by reveal index;
//! unrevealed orders and `NoMatch` windows in any order), moves only the window fee to the fee
//! collector and records what the owner is owed; `deliver_order` pays it out and can be retried
//! forever, so no recipient-side failure (frozen stablecoin account, closed token account) can block
//! another order (SPEC §12 liveness). A buyer cancelled at fill gives its units back to the sellers
//! exactly as SPEC §7 orders it: asks at `p*` in descending reveal index, then asks below `p*` in
//! descending `(price, reveal_index)` — the latter through a keeper-proposed, tally-verified
//! threshold (`begin_takeback` / `tally_takeback` / `finalize_takeback`, never reverting on a wrong
//! proposal) when the cut reaches below `p*`.

use anchor_lang::prelude::*;
use anchor_lang::AccountsExit;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount, TokenInterface};
use merces_common::auction::wallet_cap_units;
use merces_common::encoding::commitment_preimage;
use merces_common::status::SeriesStatus;
use merces_common::time::period_of;
use merces_common::window::{
    ask_at_budget, ask_at_total, ask_is_valid, below_cut, below_takeback, bid_is_valid,
    check_window_clearing, classify, no_match_is_valid, settle_buyer, takeback_threshold_valid,
    taken_before, Branch, FillClass, WindowTally,
};
use merces_onchain::keccak;
use merces_onchain::seeds::{ALLOW, CONFIG};
use merces_registry::state::{ProtocolConfig, Series, RAISE_SETTLED};

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

/// Validates an `Order` PDA of `(series, period)` passed as a remaining account and returns it.
fn load_order_page_entry(info: &AccountInfo, series_key: &Pubkey, period: u32) -> Result<Order> {
    require_keys_eq!(*info.owner, crate::ID, ProtocolError::OrderMismatch);
    let o: Order = {
        let data = info.try_borrow_data()?;
        Order::try_deserialize(&mut &data[..])?
    };
    require!(
        o.series == *series_key && o.period == period,
        ProtocolError::OrderMismatch
    );
    let expected = Pubkey::create_program_address(
        &[
            seeds::ORDER,
            series_key.as_ref(),
            &period.to_le_bytes(),
            o.owner.as_ref(),
            &[o.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| ProtocolError::OrderMismatch)?;
    require_keys_eq!(expected, *info.key, ProtocolError::OrderMismatch);
    Ok(o)
}

fn store_order(info: &AccountInfo, o: &Order) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut writer: &mut [u8] = &mut data;
    o.try_serialize(&mut writer)
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

/// `open_window(series, period)` (SPEC §7): anyone, once the windows flag is on, the lockup is
/// over, the series is current (`OnTime`/`InGrace`), the report for `period` (the previous quarter)
/// is paid and no earlier window of the series is still being processed.
pub fn open_window(ctx: Context<OpenWindow>, period: u32) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    require!(
        ctx.accounts.config.windows_enabled,
        ProtocolError::WindowsDisabled
    );
    // curve-mode units trade freely on DAMM v2: there is no transfer window (SPEC §9)
    require!(!ledger.is_curve(), ProtocolError::NotSealedBid);
    require!(
        series.raise_state == RAISE_SETTLED,
        ProtocolError::RaiseNotSettled
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
    /// CHECK: the owner's registry `AllowlistEntry` PDA; validated in the handler (address, owner,
    /// `allowed`).
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
    require_allowlisted(
        &ctx.accounts.owner_allowlist.to_account_info(),
        &ctx.accounts.owner.key(),
    )?;
    require!(escrow > 0, ProtocolError::ZeroEscrow);
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
    /// CHECK: the owner's `Holder` PDA (address checked by the seeds; read when it exists) — its
    /// undelivered auction and window units count toward the wallet cap.
    #[account(seeds = [seeds::HOLDER, series.key().as_ref(), owner.key().as_ref()], bump)]
    pub holder: UncheckedAccount<'info>,
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
        let holder = read_holder(&ctx.accounts.holder.to_account_info())?;
        let owned = owned_units(holder.as_ref(), balance)?;
        let cap =
            wallet_cap_units(ledger.units_outstanding, series.wallet_cap_bps).map_err(math)?;
        bid_is_valid(price, quantity, o.escrow, series.window_fee_bps, cap, owned)
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
    let series_key = ctx.accounts.series.key();
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
    w.clearing_price = if no_match {
        NO_MATCH_PRICE
    } else {
        clearing_price
    };
    w.no_match_proposed = no_match;
    w.d_above = 0;
    w.d_at = 0;
    w.s_below = 0;
    w.s_at = 0;
    w.max_bid = 0;
    w.min_ask = u64::MAX;
    w.valid_count = 0;
    w.valid_bids = 0;
    w.valid_asks = 0;
    w.tallied_count = 0;
    emit!(WindowSettlementProposed {
        series: series_key,
        period: w.period,
        clearing_price: w.clearing_price,
        no_match,
        round: w.tally_round,
    });
    Ok(())
}

/// Remaining accounts: up to 24 `Order` PDAs of this window (writable). Unrevealed orders and
/// orders already tallied in this round are skipped, so pages may overlap safely.
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
        let mut o = load_order_page_entry(info, &series_key, w.period)?;
        if !o.revealed || o.tallied_round == w.tally_round {
            continue;
        }
        if o.valid {
            w.valid_count = w
                .valid_count
                .checked_add(1)
                .ok_or(ProtocolError::MathOverflow)?;
            if o.side == SIDE_BID {
                w.valid_bids = w
                    .valid_bids
                    .checked_add(1)
                    .ok_or(ProtocolError::MathOverflow)?;
                if !w.no_match_proposed {
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
                }
                w.max_bid = core::cmp::max(w.max_bid, o.price);
            } else {
                w.valid_asks = w
                    .valid_asks
                    .checked_add(1)
                    .ok_or(ProtocolError::MathOverflow)?;
                if !w.no_match_proposed {
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
                }
                w.min_ask = core::cmp::min(w.min_ask, o.price);
            }
        }
        o.tallied_round = w.tally_round;
        w.tallied_count = w
            .tallied_count
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
        store_order(info, &o)?;
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
        valid_bids: w.valid_bids,
        valid_asks: w.valid_asks,
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
    // S3 / C-S5: a terminal series (Retired / Redeemed / Extinguished) can no longer trade. A
    // window that is mid-settlement when the series goes terminal is forced to NoMatch regardless
    // of the proposal — no clearing is accepted and no NoMatch proposal is rejected — so a keeper
    // cannot push a non-consensual transfer. Escrowed units and bids come back through
    // `process_order` / `deliver_order` as on any NoMatch window. Matches EVM `MercesWindow`.
    if ledger.is_terminal() {
        w.state = WINDOW_NO_MATCH;
        emit!(WindowNoMatch {
            series: series_key,
            period: w.period,
        });
        if w.order_count == 0 && ledger.active_window() == Some(w.period) {
            ledger.set_active_window(None);
            ledger.clear_window_cleared();
        }
        return Ok(());
    }
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
                w.ask_at_total =
                    ask_at_total(c.branch, w.s_at, w.s_below, c.matched_units).map_err(math)?;
                w.ask_at_filled = 0;
                w.cancelled_units = 0;
                w.next_bid_index = 0;
                w.next_ask_index = 0;
                // C-S4: from this instant a matched ask's escrow stops earning (snapshot on the
                // ledger, read by every `settle_holder`); the sold units are credited to the buyer
                // and the unsold ones to the seller from here on, at `process_order`.
                let acc_at_clear = ledger.net_acc_wad;
                ledger.set_window_cleared(acc_at_clear);
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
    // a window without orders is done right away; otherwise the last processed order closes it
    if w.order_count == 0 && ledger.active_window() == Some(w.period) {
        ledger.set_active_window(None);
        ledger.clear_window_cleared();
    }
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
    /// CHECK: the order's owner (only its key is used; nothing is sent to it here).
    #[account(address = order.owner @ ProtocolError::OrderMismatch)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the owner's `Holder` PDA (address checked by the seeds); created for a buyer's first
    /// fill, required (registered) for a seller.
    #[account(mut, seeds = [seeds::HOLDER, series.key().as_ref(), owner.key().as_ref()], bump)]
    pub holder: UncheckedAccount<'info>,
    /// CHECK: the owner's registry `AllowlistEntry` PDA, always supplied (address checked; a
    /// missing entry reads as not allowed) so the buyer re-check at fill cannot be bypassed or
    /// forced by omission. Ignored for asks.
    #[account(seeds = [ALLOW, owner.key().as_ref()], bump, seeds::program = merces_registry::ID)]
    pub owner_allowlist: UncheckedAccount<'info>,
    /// CHECK: the owner's unit ATA (accrual weight; derivation validated; may not exist).
    pub owner_unit_ata: UncheckedAccount<'info>,
    /// CHECK: the window stablecoin escrow PDA created in `prepare_raise`.
    #[account(mut, seeds = [seeds::WINDOW_STABLE, series.key().as_ref()], bump)]
    pub window_stable: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA owning both window escrows.
    #[account(seeds = [seeds::WINDOW_ESCROW, series.key().as_ref()], bump)]
    pub window_escrow_auth: UncheckedAccount<'info>,
    /// CHECK: the fee collector's ATA; derivation validated in the handler.
    #[account(mut)]
    pub fee_collector_ata: UncheckedAccount<'info>,
    /// CHECK: the stablecoin mint recorded in the registry.
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: UncheckedAccount<'info>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// `process_order` (SPEC §7), exhaustive; accounting only. Revealed bids go in ascending reveal
/// index, then revealed asks in ascending reveal index (`OutOfOrder` / `BidsNotProcessed`), so the
/// first-come margin is deterministic and the cancelled-buyer units are known before any ask is
/// settled. Unrevealed orders and every order of a `NoMatch` window can be processed at any time.
/// Only the window fee leaves the escrow here; refunds, proceeds and units are recorded on the
/// order for `deliver_order`. Remaining accounts: the stablecoin's hook accounts, if any.
pub fn process_order<'info>(ctx: Context<'info, ProcessOrder<'info>>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let series_key = ctx.accounts.series.key();
    let w = &ctx.accounts.window;
    require!(
        w.state == WINDOW_SETTLED || w.state == WINDOW_NO_MATCH,
        ProtocolError::WindowNotSettled
    );
    let o = &ctx.accounts.order;
    require!(!o.processed, ProtocolError::OrderAlreadyProcessed);
    let owner = ctx.accounts.owner.key();
    let series = &ctx.accounts.series;
    let stable_program = ctx.accounts.stablecoin_program.key();
    let t22 = ctx.accounts.token_2022_program.key();
    let unit_ata = ctx.accounts.owner_unit_ata.to_account_info();
    require_ata(&unit_ata, &owner, &series.unit_mint, &t22)?;
    require_ata(
        &ctx.accounts.fee_collector_ata.to_account_info(),
        &ctx.accounts.config.fee_collector,
        &series.stablecoin,
        &stable_program,
    )?;
    let balance = if *unit_ata.owner == t22 && !unit_ata.data_is_empty() {
        token_account_amount(&unit_ata)?
    } else {
        0
    };
    let no_match = w.state == WINDOW_NO_MATCH;
    let live = !no_match && o.revealed && o.valid;
    if !no_match && o.revealed {
        if o.side == SIDE_BID {
            require!(
                o.reveal_index == w.next_bid_index,
                ProtocolError::OutOfOrder
            );
        } else {
            require!(
                w.next_bid_index == w.revealed_bids,
                ProtocolError::BidsNotProcessed
            );
            require!(
                o.reveal_index == w.next_ask_index,
                ProtocolError::OutOfOrder
            );
        }
    }
    let p = w.clearing_price;
    let branch = branch_of(w);
    let holder_info = ctx.accounts.holder.to_account_info();

    let (fill, fee, refund) = if o.side == SIDE_BID {
        // class fill: full side, losing side, or first-come at the margin (branch A)
        let mut marginal_remaining = w.marginal_remaining;
        let class = if live {
            match classify(SIDE_BID, o.price, p, branch) {
                FillClass::Full => o.quantity,
                FillClass::Losing => 0,
                FillClass::Marginal => {
                    let f = core::cmp::min(o.quantity, marginal_remaining);
                    marginal_remaining = marginal_remaining
                        .checked_sub(f)
                        .ok_or(ProtocolError::MathOverflow)?;
                    f
                }
            }
        } else {
            0
        };
        // buyer re-check at fill: a buyer no longer allowlisted is refunded in full and its units
        // go back to the sellers (SPEC §7)
        let cancelled =
            class > 0 && !is_allowlisted(&ctx.accounts.owner_allowlist.to_account_info(), &owner)?;
        let fill = if cancelled { 0 } else { class };
        let (_cost, fee, refund) =
            settle_buyer(p, fill, o.escrow, series.window_fee_bps).map_err(math)?;
        let escrow_bump = [ctx.bumps.window_escrow_auth];
        let escrow_seeds: &[&[u8]] = &[seeds::WINDOW_ESCROW, series_key.as_ref(), &escrow_bump];
        transfer_stable(
            &ctx.accounts.stablecoin_program.to_account_info(),
            &ctx.accounts.window_stable.to_account_info(),
            &ctx.accounts.stablecoin_mint.to_account_info(),
            &ctx.accounts.fee_collector_ata.to_account_info(),
            &ctx.accounts.window_escrow_auth.to_account_info(),
            ctx.remaining_accounts,
            fee,
            series.stablecoin_decimals,
            &[escrow_seeds],
        )?;
        if fill > 0 {
            // register (first units) or settle at the current weight, then add the bought units
            let mut h = load_or_create_holder(
                &holder_info,
                &ctx.accounts.payer.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                &series_key,
                &owner,
                ctx.bumps.holder,
            )?;
            if !register_holder_now(&ledger, &mut h, series_key, owner, ctx.bumps.holder)? {
                settle_holder(&ledger, &mut h, balance)?;
            }
            // the buyer owns the sold units from the clearing point (C-S4): the payouts since then
            // are credited now (the seller's escrow stopped earning them at `acc_at_clear`), then
            // the units count as window-pending and earn forward like any held unit
            credit_window_accrual(&ledger, &mut h, fill, ledger.window_acc_at_clear)?;
            h.window_pending_units = h
                .window_pending_units
                .checked_add(fill)
                .ok_or(ProtocolError::MathOverflow)?;
            store_holder(&holder_info, &h)?;
        }
        let w = &mut ctx.accounts.window;
        w.marginal_remaining = marginal_remaining;
        if cancelled {
            w.cancelled_units = w
                .cancelled_units
                .checked_add(class)
                .ok_or(ProtocolError::MathOverflow)?;
        }
        w.escrow_stable = w
            .escrow_stable
            .checked_sub(fee)
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
        let o = &mut ctx.accounts.order;
        o.pending_units = fill;
        o.pending_stable = refund;
        (fill, fee, refund)
    } else {
        let mut at_filled = w.ask_at_filled;
        let fill = if live {
            if o.price == p {
                // at-p* group: first-come against the budget left after cancellations
                let budget = ask_at_budget(w.ask_at_total, w.cancelled_units);
                let room = budget.saturating_sub(at_filled);
                let f = core::cmp::min(o.quantity, room);
                at_filled = at_filled
                    .checked_add(f)
                    .ok_or(ProtocolError::MathOverflow)?;
                f
            } else if o.price < p {
                // below p*: full, minus the threshold cut when the take-back reaches this group
                let r_below = below_takeback(w.ask_at_total, w.cancelled_units);
                if r_below == 0 {
                    o.quantity
                } else {
                    require!(w.tb_settled, ProtocolError::TakebackRequired);
                    let cut = below_cut(
                        o.price,
                        o.reveal_index,
                        o.quantity,
                        w.tb_price,
                        w.tb_index,
                        w.tb_partial,
                    );
                    o.quantity
                        .checked_sub(cut)
                        .ok_or(ProtocolError::MathOverflow)?
                }
            } else {
                0
            }
        } else {
            0
        };
        let proceeds = p.checked_mul(fill).ok_or(ProtocolError::MathOverflow)?;
        let units_back = o
            .escrow
            .checked_sub(fill)
            .ok_or(ProtocolError::MathOverflow)?;
        // seller: settle while the escrow still counts (capped at `acc_at_clear` for a cleared
        // window, C-S4), then move the escrow units to "pending delivery"
        let mut h = read_holder(&holder_info)?.ok_or(ProtocolError::HolderNotRegistered)?;
        settle_holder(&ledger, &mut h, balance)?;
        // the unsold units coming back are the seller's from the clearing point: credit the
        // payouts since then (the sold units' share went to the buyers), then count them pending
        if !no_match {
            credit_window_accrual(&ledger, &mut h, units_back, ledger.window_acc_at_clear)?;
        }
        h.ask_escrow_units = h
            .ask_escrow_units
            .checked_sub(o.escrow)
            .ok_or(ProtocolError::MathOverflow)?;
        h.window_pending_units = h
            .window_pending_units
            .checked_add(units_back)
            .ok_or(ProtocolError::MathOverflow)?;
        store_holder(&holder_info, &h)?;
        let w = &mut ctx.accounts.window;
        w.ask_at_filled = at_filled;
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
        let o = &mut ctx.accounts.order;
        o.pending_units = units_back;
        o.pending_stable = proceeds;
        (fill, 0u64, units_back)
    };
    let w = &mut ctx.accounts.window;
    w.processed_count = w
        .processed_count
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    if w.processed_count == w.order_count && ledger.active_window() == Some(w.period) {
        ledger.set_active_window(None);
        ledger.clear_window_cleared();
    }
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

// ------------------------------------------------------------------------------------ take-back

#[derive(Accounts)]
pub struct WindowTakeback<'info> {
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
}

/// Units the asks below `p*` must give back, available once every revealed bid is processed.
fn takeback_units(w: &Window) -> Result<u64> {
    require!(w.state == WINDOW_SETTLED, ProtocolError::WindowNotSettled);
    require!(
        w.next_bid_index == w.revealed_bids,
        ProtocolError::BidsNotProcessed
    );
    Ok(below_takeback(w.ask_at_total, w.cancelled_units))
}

/// Proposes the threshold ask `(price, reveal_index)` — the last order (in descending
/// `(price, reveal_index)`) the take-back below `p*` reaches. Anyone; allowed only when no round is
/// in progress (`TakebackInProgress`), so honest keepers' tallies cannot be reset.
pub fn begin_takeback(ctx: Context<WindowTakeback>, price: u64, reveal_index: u32) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let w = &mut ctx.accounts.window;
    let r_below = takeback_units(w)?;
    require!(r_below > 0, ProtocolError::TakebackNotRequired);
    require!(!w.tb_settled, ProtocolError::TakebackAlreadySettled);
    require!(
        w.tb_round == 0 || w.tb_rejected,
        ProtocolError::TakebackInProgress
    );
    w.tb_round = w
        .tb_round
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    w.tb_rejected = false;
    w.tb_price = price;
    w.tb_index = reveal_index;
    w.tb_above_sum = 0;
    w.tb_found = false;
    w.tb_k_quantity = 0;
    w.tb_tallied = 0;
    emit!(WindowTakebackProposed {
        series: series_key,
        period: w.period,
        price,
        reveal_index,
        round: w.tb_round,
    });
    Ok(())
}

/// Remaining accounts: up to 24 `Order` PDAs of this window (read-write). Every revealed ask is
/// counted once per round; valid asks below `p*` with a larger key than the proposal add to
/// `Σ_{key > k} q`, the proposed order itself records its quantity.
pub fn tally_takeback<'info>(ctx: Context<'info, WindowTakeback<'info>>) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let w = &mut ctx.accounts.window;
    require!(
        w.state == WINDOW_SETTLED && w.tb_round > 0 && !w.tb_rejected && !w.tb_settled,
        ProtocolError::TakebackNotTallying
    );
    require!(
        ctx.remaining_accounts.len() <= TALLY_PAGE,
        ProtocolError::TallyPageTooLarge
    );
    for info in ctx.remaining_accounts.iter() {
        let mut o = load_order_page_entry(info, &series_key, w.period)?;
        if o.side != SIDE_ASK || !o.revealed || o.takeback_round == w.tb_round {
            continue;
        }
        if o.valid && o.price < w.clearing_price {
            if taken_before(o.price, o.reveal_index, w.tb_price, w.tb_index) {
                w.tb_above_sum = w
                    .tb_above_sum
                    .checked_add(o.quantity)
                    .ok_or(ProtocolError::MathOverflow)?;
            } else if o.price == w.tb_price && o.reveal_index == w.tb_index {
                w.tb_found = true;
                w.tb_k_quantity = o.quantity;
            }
        }
        o.takeback_round = w.tb_round;
        w.tb_tallied = w
            .tb_tallied
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
        store_order(info, &o)?;
    }
    Ok(())
}

/// Accepts the threshold iff `Σ_{key > k} q < R ≤ Σ_{key > k} q + q_k` (unique when it exists,
/// and it always exists because `R ≤ s_below`); a wrong proposal is recorded, never reverted.
pub fn finalize_takeback(ctx: Context<WindowTakeback>) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let w = &mut ctx.accounts.window;
    require!(
        w.state == WINDOW_SETTLED && w.tb_round > 0 && !w.tb_rejected && !w.tb_settled,
        ProtocolError::TakebackNotTallying
    );
    require!(
        w.tb_tallied == w.revealed_asks,
        ProtocolError::TallyIncomplete
    );
    let r_below = takeback_units(w)?;
    if takeback_threshold_valid(r_below, w.tb_above_sum, w.tb_found, w.tb_k_quantity)
        .map_err(math)?
    {
        w.tb_settled = true;
        w.tb_partial = r_below
            .checked_sub(w.tb_above_sum)
            .ok_or(ProtocolError::MathOverflow)?;
        emit!(WindowTakebackSettled {
            series: series_key,
            period: w.period,
            cancelled_units: w.cancelled_units,
            below_units: r_below,
            price: w.tb_price,
            reveal_index: w.tb_index,
            partial: w.tb_partial,
        });
    } else {
        w.tb_rejected = true;
        emit!(WindowTakebackRejected {
            series: series_key,
            period: w.period,
            round: w.tb_round,
        });
    }
    Ok(())
}

// -------------------------------------------------------------------------------- deliver_order

#[derive(Accounts)]
pub struct DeliverOrder<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::WINDOW, series.key().as_ref(), window.period.to_le_bytes().as_ref()], bump = window.bump)]
    pub window: Box<Account<'info, Window>>,
    #[account(mut, seeds = [seeds::ORDER, series.key().as_ref(), window.period.to_le_bytes().as_ref(), owner.key().as_ref()], bump = order.bump)]
    pub order: Box<Account<'info, Order>>,
    /// CHECK: the order's owner; units and stablecoin go to its associated token accounts only.
    #[account(address = order.owner @ ProtocolError::OrderMismatch)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the owner's `Holder` PDA (address checked by the seeds; required when units move).
    #[account(mut, seeds = [seeds::HOLDER, series.key().as_ref(), owner.key().as_ref()], bump)]
    pub holder: UncheckedAccount<'info>,
    /// CHECK: the owner's unit ATA (created idempotently; derivation validated).
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

/// `deliver_order`: anyone (or the owner), after `process_order`, once. Pays the recorded
/// stablecoin (bid refund or ask proceeds) and moves the recorded units (bid fill or ask return)
/// from the window escrow (hook rule 3) to the owner's associated accounts, created idempotently.
/// A delivery that fails for recipient-side reasons can be retried forever and never affects any
/// other order. Remaining accounts: the Merces hook accounts for the unit mint, then the
/// stablecoin's hook accounts, if any.
pub fn deliver_order<'info>(ctx: Context<'info, DeliverOrder<'info>>) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    let o = &ctx.accounts.order;
    require!(o.processed, ProtocolError::OrderNotProcessed);
    require!(!o.delivered, ProtocolError::OrderAlreadyDelivered);
    let owner = ctx.accounts.owner.key();
    let units = o.pending_units;
    let amount = o.pending_stable;
    let side = o.side;
    let escrow_bump = [ctx.bumps.window_escrow_auth];
    let escrow_seeds: &[&[u8]] = &[seeds::WINDOW_ESCROW, series_key.as_ref(), &escrow_bump];
    let payer = ctx.accounts.payer.to_account_info();
    let owner_info = ctx.accounts.owner.to_account_info();
    let system_program = ctx.accounts.system_program.to_account_info();
    let ata_program = ctx.accounts.associated_token_program.to_account_info();
    if amount > 0 {
        create_ata_idempotent(CreateAta {
            payer: &payer,
            ata: &ctx.accounts.owner_stable_ata.to_account_info(),
            owner: &owner_info,
            mint: &ctx.accounts.stablecoin_mint.to_account_info(),
            system_program: &system_program,
            token_program: &ctx.accounts.stablecoin_program.to_account_info(),
            ata_program: &ata_program,
        })?;
        transfer_stable(
            &ctx.accounts.stablecoin_program.to_account_info(),
            &ctx.accounts.window_stable.to_account_info(),
            &ctx.accounts.stablecoin_mint.to_account_info(),
            &ctx.accounts.owner_stable_ata.to_account_info(),
            &ctx.accounts.window_escrow_auth.to_account_info(),
            ctx.remaining_accounts,
            amount,
            series.stablecoin_decimals,
            &[escrow_seeds],
        )?;
    }
    if units > 0 {
        let holder_info = ctx.accounts.holder.to_account_info();
        let mut h = read_holder(&holder_info)?.ok_or(ProtocolError::HolderNotRegistered)?;
        create_ata_idempotent(CreateAta {
            payer: &payer,
            ata: &ctx.accounts.owner_unit_ata.to_account_info(),
            owner: &owner_info,
            mint: &ctx.accounts.unit_mint.to_account_info(),
            system_program: &system_program,
            token_program: &ctx.accounts.token_2022_program.to_account_info(),
            ata_program: &ata_program,
        })?;
        transfer_units(
            &ctx.accounts.token_2022_program.to_account_info(),
            &ctx.accounts.window_escrow_ata.to_account_info(),
            &ctx.accounts.unit_mint.to_account_info(),
            &ctx.accounts.owner_unit_ata.to_account_info(),
            &ctx.accounts.window_escrow_auth.to_account_info(),
            ctx.remaining_accounts,
            units,
            &[escrow_seeds],
        )?;
        // delivery does not change the accrual weight: pending units become balance units
        h.window_pending_units = h
            .window_pending_units
            .checked_sub(units)
            .ok_or(ProtocolError::MathOverflow)?;
        store_holder(&holder_info, &h)?;
    }
    let w = &mut ctx.accounts.window;
    w.escrow_stable = w
        .escrow_stable
        .checked_sub(amount)
        .ok_or(ProtocolError::MathOverflow)?;
    w.escrow_units = w
        .escrow_units
        .checked_sub(units)
        .ok_or(ProtocolError::MathOverflow)?;
    w.delivered_count = w
        .delivered_count
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    let o = &mut ctx.accounts.order;
    o.delivered = true;
    emit!(OrderDelivered {
        series: series_key,
        period: o.period,
        owner,
        side,
        units,
        amount,
    });
    Ok(())
}
