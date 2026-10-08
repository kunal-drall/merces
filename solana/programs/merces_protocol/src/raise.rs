//! Raise path (SPEC §5): unit mint creation, sealed-bid commit/reveal, paged settlement, claims.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_2022::spl_token_2022::extension::ExtensionType;
use anchor_spl::token_2022::spl_token_2022::instruction::AuthorityType;
use anchor_spl::token_2022::spl_token_2022::state::Mint as MintState;
use anchor_spl::token_interface::{
    self as ti, metadata_pointer_initialize, permanent_delegate_initialize,
    spl_token_metadata_interface, token_metadata_initialize, transfer_hook_initialize,
    MetadataPointerInitialize, Mint, PermanentDelegateInitialize, Token2022, TokenAccount,
    TokenInterface, TokenMetadataInitialize, TransferHookInitialize,
};
use merces_common::auction::{
    allocation, bid_is_valid, check_clearing, non_reveal_split, settle_winner, wallet_cap_units,
};
use merces_common::encoding::commitment_preimage;
use merces_common::vault::cap_per_unit;
use merces_onchain::keccak;
use merces_onchain::seeds::{ALLOW, CONFIG, MINT_LINK};
use merces_registry::program::MercesRegistry;
use merces_registry::state::{
    AllowlistEntry, ProtocolConfig, Series, MODE_SEALED_BID, RAISE_DRAFT,
};
use spl_token_metadata_interface::state::TokenMetadata;

use crate::common::*;
use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::state::*;

// --------------------------------------------------------------------------------- prepare_raise

/// Step 1 of opening a raise: creates the per-series protocol accounts (auction, treasury,
/// ledger) and the three stablecoin PDAs (escrow, treasury, vault). Split from `open_raise` to
/// keep each instruction's account-validation frame under the SBF stack limit.
#[derive(Accounts)]
pub struct PrepareRaise<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    /// CHECK: data-less signer PDA, permanent delegate and vault owner.
    #[account(seeds = [seeds::VAULT_AUTH, series.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, auction escrow owner.
    #[account(seeds = [seeds::ESCROW_AUTH, series.key().as_ref()], bump)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, treasury owner.
    #[account(seeds = [seeds::TREASURY_AUTH, series.key().as_ref()], bump)]
    pub treasury_auth: UncheckedAccount<'info>,
    #[account(init, payer = issuer, space = 8 + Auction::INIT_SPACE, seeds = [seeds::AUCTION, series.key().as_ref()], bump)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(init, payer = issuer, space = 8 + Treasury::INIT_SPACE, seeds = [seeds::TREASURY, series.key().as_ref()], bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(init, payer = issuer, space = Ledger::LEN, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(
        init,
        payer = issuer,
        seeds = [seeds::ESCROW_TOKEN, series.key().as_ref()],
        bump,
        token::mint = stablecoin_mint,
        token::authority = escrow_auth,
        token::token_program = stablecoin_program,
    )]
    pub escrow_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = issuer,
        seeds = [seeds::TREASURY_TOKEN, series.key().as_ref()],
        bump,
        token::mint = stablecoin_mint,
        token::authority = treasury_auth,
        token::token_program = stablecoin_program,
    )]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = issuer,
        seeds = [seeds::VAULT_TOKEN, series.key().as_ref()],
        bump,
        token::mint = stablecoin_mint,
        token::authority = vault_auth,
        token::token_program = stablecoin_program,
    )]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
}

pub fn prepare_raise(ctx: Context<PrepareRaise>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_init()?;
    let series = &ctx.accounts.series;
    require!(series.mode == MODE_SEALED_BID, ProtocolError::NotSealedBid);
    require!(series.raise_state == RAISE_DRAFT, ProtocolError::NotDraft);
    let series_key = series.key();
    let a = &mut ctx.accounts.auction;
    a.series = series_key;
    a.min_valid_price = u64::MAX;
    a.bump = ctx.bumps.auction;
    let t = &mut ctx.accounts.treasury;
    t.series = series_key;
    t.bump = ctx.bumps.treasury;
    ledger.series = series_key;
    ledger.bump = ctx.bumps.ledger;
    Ok(())
}

// ------------------------------------------------------------------------------------ open_raise

/// Step 2: creates the Token-2022 unit mint (SPEC §4.1), the hook's extra-account-metas list and
/// the registry `MintLink`, then opens the commit phase.
#[derive(Accounts)]
pub struct OpenRaise<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(seeds = [ALLOW, issuer.key().as_ref()], bump = issuer_allowlist.bump, seeds::program = merces_registry::ID)]
    pub issuer_allowlist: Box<Account<'info, AllowlistEntry>>,
    /// CHECK: created here as the Token-2022 unit mint PDA.
    #[account(mut, seeds = [seeds::UNIT_MINT, series.key().as_ref()], bump)]
    pub unit_mint: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, mint authority.
    #[account(seeds = [seeds::AUCTION_AUTH, series.key().as_ref()], bump)]
    pub auction_auth: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, permanent delegate and vault owner.
    #[account(seeds = [seeds::VAULT_AUTH, series.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(mut, seeds = [seeds::AUCTION, series.key().as_ref()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    /// CHECK: the hook's ExtraAccountMetaList PDA, created by the hook program via CPI.
    #[account(mut, seeds = [merces_hook::EXTRA_ACCOUNT_METAS_SEED, unit_mint.key().as_ref()], bump, seeds::program = merces_hook::ID)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: the registry's MintLink PDA, created by the registry via CPI.
    #[account(mut, seeds = [MINT_LINK, unit_mint.key().as_ref()], bump, seeds::program = merces_registry::ID)]
    pub mint_link: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_SIGNER], bump)]
    pub registry_signer: UncheckedAccount<'info>,
    pub hook_program: Program<'info, merces_hook::program::MercesHook>,
    pub registry_program: Program<'info, MercesRegistry>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn open_raise(ctx: Context<OpenRaise>) -> Result<()> {
    let now = now_ts()?;
    let series = &ctx.accounts.series;
    let config = &ctx.accounts.config;
    require!(series.mode == MODE_SEALED_BID, ProtocolError::NotSealedBid);
    require!(series.raise_state == RAISE_DRAFT, ProtocolError::NotDraft);
    require!(
        series.contract_hash != [0u8; 32],
        ProtocolError::ContractHashNotSet
    );
    require!(!config.new_raises_paused, ProtocolError::NewRaisesPaused);
    require!(
        ctx.accounts.issuer_allowlist.allowed,
        ProtocolError::NotAllowlisted
    );
    require!(ctx.accounts.auction.state == 0, ProtocolError::RaiseNotOpen);

    let series_key = series.key();
    let mint_bump = [ctx.bumps.unit_mint];
    let mint_seeds: &[&[u8]] = &[seeds::UNIT_MINT, series_key.as_ref(), &mint_bump];
    let auth_bump = [ctx.bumps.auction_auth];
    let auth_seeds: &[&[u8]] = &[seeds::AUCTION_AUTH, series_key.as_ref(), &auth_bump];
    let rent = Rent::get()?;

    // 1. create the mint account with room for the three extensions
    let space = ExtensionType::try_calculate_account_len::<MintState>(&[
        ExtensionType::TransferHook,
        ExtensionType::PermanentDelegate,
        ExtensionType::MetadataPointer,
    ])?;
    let lamports = rent.minimum_balance(space);
    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            system_program::CreateAccount {
                from: ctx.accounts.issuer.to_account_info(),
                to: ctx.accounts.unit_mint.to_account_info(),
            },
            &[mint_seeds],
        ),
        lamports,
        space as u64,
        &ctx.accounts.token_2022_program.key(),
    )?;
    // 2. extensions (before initialize_mint2)
    transfer_hook_initialize(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            TransferHookInitialize {
                token_program_id: ctx.accounts.token_2022_program.to_account_info(),
                mint: ctx.accounts.unit_mint.to_account_info(),
            },
        ),
        None,
        Some(merces_hook::ID),
    )?;
    permanent_delegate_initialize(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            PermanentDelegateInitialize {
                token_program_id: ctx.accounts.token_2022_program.to_account_info(),
                mint: ctx.accounts.unit_mint.to_account_info(),
            },
        ),
        &ctx.accounts.vault_auth.key(),
    )?;
    metadata_pointer_initialize(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            MetadataPointerInitialize {
                token_program_id: ctx.accounts.token_2022_program.to_account_info(),
                mint: ctx.accounts.unit_mint.to_account_info(),
            },
        ),
        None,
        Some(ctx.accounts.unit_mint.key()),
    )?;
    ti::initialize_mint2(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            ti::InitializeMint2 {
                mint: ctx.accounts.unit_mint.to_account_info(),
            },
        ),
        0,
        &ctx.accounts.auction_auth.key(),
        None,
    )?;
    // 3. token metadata (realloc needs lamports on the mint first)
    let name = format!("Merces HEU {}", series.series_id);
    let symbol = "HEU".to_string();
    let uri = series.metadata_uri.clone();
    let metadata = TokenMetadata {
        update_authority: Some(ctx.accounts.auction_auth.key()).try_into()?,
        mint: ctx.accounts.unit_mint.key(),
        name: name.clone(),
        symbol: symbol.clone(),
        uri: uri.clone(),
        additional_metadata: vec![],
    };
    let metadata_len = metadata.tlv_size_of()?;
    let new_len = ctx
        .accounts
        .unit_mint
        .data_len()
        .checked_add(metadata_len)
        .ok_or(ProtocolError::MathOverflow)?;
    let required = rent.minimum_balance(new_len);
    let current = ctx.accounts.unit_mint.lamports();
    if required > current {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.issuer.to_account_info(),
                    to: ctx.accounts.unit_mint.to_account_info(),
                },
            ),
            required
                .checked_sub(current)
                .ok_or(ProtocolError::MathOverflow)?,
        )?;
    }
    token_metadata_initialize(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            TokenMetadataInitialize {
                program_id: ctx.accounts.token_2022_program.to_account_info(),
                metadata: ctx.accounts.unit_mint.to_account_info(),
                update_authority: ctx.accounts.auction_auth.to_account_info(),
                mint_authority: ctx.accounts.auction_auth.to_account_info(),
                mint: ctx.accounts.unit_mint.to_account_info(),
            },
            &[auth_seeds],
        ),
        name,
        symbol,
        uri,
    )?;
    // 4. hook extra account metas (mint authority signs)
    merces_hook::cpi::initialize_extra_account_meta_list(CpiContext::new_with_signer(
        ctx.accounts.hook_program.key(),
        merces_hook::cpi::accounts::InitializeExtraAccountMetaList {
            payer: ctx.accounts.issuer.to_account_info(),
            extra_account_meta_list: ctx.accounts.extra_account_meta_list.to_account_info(),
            mint: ctx.accounts.unit_mint.to_account_info(),
            mint_authority: ctx.accounts.auction_auth.to_account_info(),
            token_program: ctx.accounts.token_2022_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
        &[auth_seeds],
    ))?;
    // 5. registry: Draft → Open, MintLink
    let signer_bump = [ctx.bumps.registry_signer];
    let signer_seeds: &[&[u8]] = &[seeds::REGISTRY_SIGNER, &signer_bump];
    merces_registry::cpi::mark_raise_opened(
        CpiContext::new_with_signer(
            ctx.accounts.registry_program.key(),
            merces_registry::cpi::accounts::MarkRaiseOpened {
                config: ctx.accounts.config.to_account_info(),
                protocol_signer: ctx.accounts.registry_signer.to_account_info(),
                series: ctx.accounts.series.to_account_info(),
                issuer_allowlist: ctx.accounts.issuer_allowlist.to_account_info(),
                unit_mint: ctx.accounts.unit_mint.to_account_info(),
                mint_link: ctx.accounts.mint_link.to_account_info(),
                payer: ctx.accounts.issuer.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[signer_seeds],
        ),
        ctx.accounts.unit_mint.key(),
        now,
    )?;

    // 6. auction state
    let commit_end = now
        .checked_add(series.commit_duration)
        .ok_or(ProtocolError::MathOverflow)?;
    let reveal_end = commit_end
        .checked_add(series.reveal_duration)
        .ok_or(ProtocolError::MathOverflow)?;
    let a = &mut ctx.accounts.auction;
    a.state = RAISE_OPEN;
    a.opened_at = now;
    a.commit_end = commit_end;
    a.reveal_end = reveal_end;

    emit!(RaiseOpened {
        series: series_key,
        unit_mint: ctx.accounts.unit_mint.key(),
        opened_at: now,
        commit_end,
        reveal_end,
    });
    Ok(())
}

// --------------------------------------------------------------------------------- cancel_raise

#[derive(Accounts)]
pub struct CancelRaise<'info> {
    pub issuer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::AUCTION, series.key().as_ref()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_SIGNER], bump)]
    pub registry_signer: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
}

pub fn cancel_raise(ctx: Context<CancelRaise>) -> Result<()> {
    let a = &mut ctx.accounts.auction;
    require!(a.state == RAISE_OPEN, ProtocolError::RaiseNotOpen);
    require!(a.bid_count == 0, ProtocolError::RaiseHasBids);
    a.state = RAISE_CANCELLED;
    RegistryCpi {
        registry_program: ctx.accounts.registry_program.to_account_info(),
        config: ctx.accounts.config.to_account_info(),
        series: ctx.accounts.series.to_account_info(),
        protocol_signer: ctx.accounts.registry_signer.to_account_info(),
        signer_bump: ctx.bumps.registry_signer,
    }
    .mark_raise_result(RAISE_CANCELLED, 0, 0, 0, true)?;
    emit!(RaiseCancelled {
        series: ctx.accounts.series.key()
    });
    Ok(())
}

// ----------------------------------------------------------------------------------- commit_bid

#[derive(Accounts)]
pub struct CommitBid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(seeds = [ALLOW, bidder.key().as_ref()], bump = bidder_allowlist.bump, seeds::program = merces_registry::ID)]
    pub bidder_allowlist: Box<Account<'info, AllowlistEntry>>,
    #[account(mut, seeds = [seeds::AUCTION, series.key().as_ref()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(init, payer = bidder, space = 8 + Bid::INIT_SPACE, seeds = [seeds::BID, series.key().as_ref(), bidder.key().as_ref()], bump)]
    pub bid: Box<Account<'info, Bid>>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = bidder, token::token_program = stablecoin_program)]
    pub bidder_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::ESCROW_TOKEN, series.key().as_ref()], bump)]
    pub escrow_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn commit_bid<'info>(
    ctx: Context<'info, CommitBid<'info>>,
    commitment: [u8; 32],
    escrow: u64,
) -> Result<()> {
    let now = now_ts()?;
    let a = &ctx.accounts.auction;
    require!(a.state == RAISE_OPEN, ProtocolError::RaiseNotOpen);
    require!(now < a.commit_end, ProtocolError::CommitPhaseOver);
    require!(escrow > 0, ProtocolError::ZeroEscrow);
    require!(
        ctx.accounts.bidder_allowlist.allowed,
        ProtocolError::NotAllowlisted
    );
    transfer_stable(
        &ctx.accounts.stablecoin_program.to_account_info(),
        &ctx.accounts.bidder_stable.to_account_info(),
        &ctx.accounts.stablecoin_mint.to_account_info(),
        &ctx.accounts.escrow_token.to_account_info(),
        &ctx.accounts.bidder.to_account_info(),
        ctx.remaining_accounts,
        escrow,
        ctx.accounts.series.stablecoin_decimals,
        &[],
    )?;
    let a = &mut ctx.accounts.auction;
    a.escrow_total = a
        .escrow_total
        .checked_add(escrow)
        .ok_or(ProtocolError::MathOverflow)?;
    a.bid_count = a
        .bid_count
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    let b = &mut ctx.accounts.bid;
    b.series = ctx.accounts.series.key();
    b.bidder = ctx.accounts.bidder.key();
    b.commitment = commitment;
    b.escrow = escrow;
    b.bump = ctx.bumps.bid;
    emit!(BidCommitted {
        series: ctx.accounts.series.key(),
        bidder: ctx.accounts.bidder.key(),
        escrow,
    });
    Ok(())
}

// ----------------------------------------------------------------------------------- reveal_bid

#[derive(Accounts)]
pub struct RevealBid<'info> {
    pub bidder: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::AUCTION, series.key().as_ref()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [seeds::BID, series.key().as_ref(), bidder.key().as_ref()], bump = bid.bump)]
    pub bid: Box<Account<'info, Bid>>,
}

pub fn reveal_bid(
    ctx: Context<RevealBid>,
    price: u64,
    quantity: u64,
    salt: [u8; 32],
) -> Result<()> {
    let now = now_ts()?;
    let series = &ctx.accounts.series;
    let a = &mut ctx.accounts.auction;
    require!(a.state == RAISE_OPEN, ProtocolError::RaiseNotOpen);
    require!(
        now >= a.commit_end && now < a.reveal_end,
        ProtocolError::NotRevealPhase
    );
    let b = &mut ctx.accounts.bid;
    require!(!b.revealed, ProtocolError::AlreadyRevealed);
    let wallet = ctx.accounts.bidder.key().to_bytes();
    let expected = keccak(&[commitment_preimage(price, quantity, &salt, &wallet).as_bytes()]);
    require!(expected == b.commitment, ProtocolError::CommitmentMismatch);
    b.revealed = true;
    b.reveal_index = a.revealed_count;
    a.revealed_count = a
        .revealed_count
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    let cap_units = wallet_cap_units(series.units_offered, series.wallet_cap_bps).map_err(math)?;
    let valid = bid_is_valid(
        price,
        quantity,
        b.escrow,
        series.reserve_price,
        cap_units,
        series.auction_fee_bps,
    );
    b.valid = valid;
    b.price = price;
    b.quantity = quantity;
    if valid {
        a.valid_count = a
            .valid_count
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
    }
    emit!(BidRevealed {
        series: series.key(),
        bidder: ctx.accounts.bidder.key(),
        price,
        quantity,
        valid,
    });
    Ok(())
}

// ----------------------------------------------------------------------------- begin_settlement

#[derive(Accounts)]
pub struct BeginSettlement<'info> {
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::AUCTION, series.key().as_ref()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
}

pub fn begin_settlement(ctx: Context<BeginSettlement>, proposed_clearing_price: u64) -> Result<()> {
    let now = now_ts()?;
    let a = &mut ctx.accounts.auction;
    require!(
        a.state == RAISE_OPEN || a.state == RAISE_SETTLING,
        ProtocolError::RaiseNotOpen
    );
    require!(now >= a.reveal_end, ProtocolError::RevealPhaseNotOver);
    a.state = RAISE_SETTLING;
    a.clearing_price = proposed_clearing_price;
    a.q_above = 0;
    a.q_at = 0;
    a.min_valid_price = u64::MAX;
    a.tallied_count = 0;
    a.tally_round = a
        .tally_round
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    emit!(SettlementProposed {
        series: ctx.accounts.series.key(),
        clearing_price: proposed_clearing_price,
        round: a.tally_round,
    });
    Ok(())
}

// ----------------------------------------------------------------------------------- tally_bids

#[derive(Accounts)]
pub struct TallyBids<'info> {
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::AUCTION, series.key().as_ref()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
}

/// Remaining accounts: up to 24 `Bid` PDAs of this series (writable). Unrevealed bids and bids
/// already tallied in this round are skipped, so pages may overlap safely.
pub fn tally_bids<'info>(ctx: Context<'info, TallyBids<'info>>) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let a = &mut ctx.accounts.auction;
    require!(a.state == RAISE_SETTLING, ProtocolError::NotSettling);
    require!(
        ctx.remaining_accounts.len() <= TALLY_PAGE,
        ProtocolError::TallyPageTooLarge
    );
    for info in ctx.remaining_accounts.iter() {
        require_keys_eq!(*info.owner, crate::ID, ProtocolError::BidPdaMismatch);
        let mut bid: Bid = {
            let data = info.try_borrow_data()?;
            Bid::try_deserialize(&mut &data[..])?
        };
        require_keys_eq!(bid.series, series_key, ProtocolError::BidSeriesMismatch);
        let expected = Pubkey::create_program_address(
            &[
                seeds::BID,
                series_key.as_ref(),
                bid.bidder.as_ref(),
                &[bid.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| ProtocolError::BidPdaMismatch)?;
        require_keys_eq!(expected, *info.key, ProtocolError::BidPdaMismatch);
        if !bid.revealed || bid.tallied_round == a.tally_round {
            continue;
        }
        if bid.valid {
            if bid.price > a.clearing_price {
                a.q_above = a
                    .q_above
                    .checked_add(bid.quantity)
                    .ok_or(ProtocolError::MathOverflow)?;
            } else if bid.price == a.clearing_price {
                a.q_at = a
                    .q_at
                    .checked_add(bid.quantity)
                    .ok_or(ProtocolError::MathOverflow)?;
            }
            if bid.price < a.min_valid_price {
                a.min_valid_price = bid.price;
            }
        }
        bid.tallied_round = a.tally_round;
        a.tallied_count = a
            .tallied_count
            .checked_add(1)
            .ok_or(ProtocolError::MathOverflow)?;
        let mut data = info.try_borrow_mut_data()?;
        bid.try_serialize(&mut &mut data[..])?;
    }
    Ok(())
}

// -------------------------------------------------------------------------- finalize_settlement

#[derive(Accounts)]
pub struct FinalizeSettlement<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::AUCTION, series.key().as_ref()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_SIGNER], bump)]
    pub registry_signer: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
}

pub fn finalize_settlement(ctx: Context<FinalizeSettlement>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series = &ctx.accounts.series;
    let a = &mut ctx.accounts.auction;
    require!(a.state == RAISE_SETTLING, ProtocolError::NotSettling);
    require!(
        a.tallied_count == a.revealed_count,
        ProtocolError::TallyIncomplete
    );
    let registry = RegistryCpi {
        registry_program: ctx.accounts.registry_program.to_account_info(),
        config: ctx.accounts.config.to_account_info(),
        series: ctx.accounts.series.to_account_info(),
        protocol_signer: ctx.accounts.registry_signer.to_account_info(),
        signer_bump: ctx.bumps.registry_signer,
    };
    let fail = |a: &mut Auction, proceeds_upper: u64| -> Result<()> {
        a.state = RAISE_FAILED;
        a.settlement_ts = now;
        a.units_sold = 0;
        a.proceeds = 0;
        registry.mark_raise_result(RAISE_FAILED, now, 0, a.clearing_price, true)?;
        emit!(RaiseFailed {
            series: series.key(),
            clearing_price: a.clearing_price,
            proceeds_upper,
            min_raise: series.min_raise,
        });
        Ok(())
    };
    if a.valid_count == 0 {
        return fail(a, 0);
    }
    let clearing = check_clearing(
        series.units_offered,
        a.clearing_price,
        a.q_above,
        a.q_at,
        a.min_valid_price,
    )
    .map_err(math)?
    .ok_or(ProtocolError::InvalidClearingPrice)?;
    if clearing.proceeds_upper < series.min_raise {
        return fail(a, clearing.proceeds_upper);
    }
    a.state = RAISE_SETTLED;
    a.settlement_ts = now;
    a.remainder_at_margin = clearing.remainder_at_margin;
    a.units_sold = clearing.units_sold_upper;
    a.proceeds = clearing.proceeds_upper;
    registry.mark_raise_result(
        RAISE_SETTLED,
        now,
        clearing.units_sold_upper,
        a.clearing_price,
        false,
    )?;
    let cap = cap_per_unit(series.cap_multiple_wad, a.clearing_price).map_err(math)?;
    ledger.init_after_settlement(now, cap)?;
    emit!(RaiseSettled {
        series: series.key(),
        clearing_price: a.clearing_price,
        units_sold_upper: clearing.units_sold_upper,
        proceeds_upper: clearing.proceeds_upper,
        settlement_ts: now,
    });
    Ok(())
}

// ------------------------------------------------------------------------------------ claim_win

#[derive(Accounts)]
pub struct ClaimWin<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::AUCTION, series.key().as_ref()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [seeds::BID, series.key().as_ref(), bidder.key().as_ref()], bump = bid.bump)]
    pub bid: Box<Account<'info, Bid>>,
    #[account(mut, seeds = [seeds::TREASURY, series.key().as_ref()], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(init_if_needed, payer = payer, space = 8 + Holder::INIT_SPACE, seeds = [seeds::HOLDER, series.key().as_ref(), bidder.key().as_ref()], bump)]
    pub holder: Box<Account<'info, Holder>>,
    /// CHECK: the bid's owner; refunds and units go to its associated token accounts only.
    #[account(address = bid.bidder)]
    pub bidder: UncheckedAccount<'info>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = bidder, token::token_program = stablecoin_program)]
    pub bidder_stable_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = unit_mint, token::authority = bidder, token::token_program = token_2022_program)]
    pub bidder_unit_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::ESCROW_TOKEN, series.key().as_ref()], bump)]
    pub escrow_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::TREASURY_TOKEN, series.key().as_ref()], bump)]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = config.fee_collector, token::token_program = stablecoin_program)]
    pub fee_collector_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less signer PDA, auction escrow owner.
    #[account(seeds = [seeds::ESCROW_AUTH, series.key().as_ref()], bump)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, mint authority.
    #[account(seeds = [seeds::AUCTION_AUTH, series.key().as_ref()], bump)]
    pub auction_auth: UncheckedAccount<'info>,
    #[account(mut, address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_SIGNER], bump)]
    pub registry_signer: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
    pub system_program: Program<'info, System>,
}

pub fn claim_win<'info>(ctx: Context<'info, ClaimWin<'info>>) -> Result<()> {
    let ledger = ctx.accounts.ledger.load_mut()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    let a = &ctx.accounts.auction;
    require!(a.state == RAISE_SETTLED, ProtocolError::NotSettledOrFailed);
    let b = &ctx.accounts.bid;
    require!(!b.processed, ProtocolError::BidAlreadyProcessed);
    let decimals = series.stablecoin_decimals;
    let escrow_bump = [ctx.bumps.escrow_auth];
    let escrow_seeds: &[&[u8]] = &[seeds::ESCROW_AUTH, series_key.as_ref(), &escrow_bump];
    let bidder = ctx.accounts.bidder.key();
    let stable_program = ctx.accounts.stablecoin_program.key();
    require_ata(
        &ctx.accounts.bidder_stable_ata.to_account_info(),
        &bidder,
        &series.stablecoin,
        &stable_program,
    )?;
    require_ata(
        &ctx.accounts.bidder_unit_ata.to_account_info(),
        &bidder,
        &series.unit_mint,
        &ctx.accounts.token_2022_program.key(),
    )?;
    require_ata(
        &ctx.accounts.fee_collector_ata.to_account_info(),
        &ctx.accounts.config.fee_collector,
        &series.stablecoin,
        &stable_program,
    )?;

    // Compute the allocation and the money split.
    let (alloc, cost, fee, refund, charge) = if !b.revealed {
        let (charge, refund) =
            non_reveal_split(b.escrow, series.non_reveal_charge_bps).map_err(math)?;
        (0u64, 0u64, 0u64, refund, charge)
    } else if !b.valid {
        (0, 0, 0, b.escrow, 0)
    } else {
        let alloc = allocation(
            b.price,
            b.quantity,
            a.clearing_price,
            a.remainder_at_margin,
            a.q_at,
        )
        .map_err(math)?;
        if alloc == 0 {
            (0, 0, 0, b.escrow, 0)
        } else {
            let (cost, fee, refund) =
                settle_winner(a.clearing_price, alloc, b.escrow, series.auction_fee_bps)
                    .map_err(math)?;
            (alloc, cost, fee, refund, 0)
        }
    };

    // Move the money: escrow → treasury (cost), → fee collector (fee + non-reveal charge), → bidder (refund).
    let token_program = ctx.accounts.stablecoin_program.to_account_info();
    let mint = ctx.accounts.stablecoin_mint.to_account_info();
    let escrow = ctx.accounts.escrow_token.to_account_info();
    let auth = ctx.accounts.escrow_auth.to_account_info();
    transfer_stable(
        &token_program,
        &escrow,
        &mint,
        &ctx.accounts.treasury_token.to_account_info(),
        &auth,
        ctx.remaining_accounts,
        cost,
        decimals,
        &[escrow_seeds],
    )?;
    let fee_total = fee.checked_add(charge).ok_or(ProtocolError::MathOverflow)?;
    transfer_stable(
        &token_program,
        &escrow,
        &mint,
        &ctx.accounts.fee_collector_ata.to_account_info(),
        &auth,
        ctx.remaining_accounts,
        fee_total,
        decimals,
        &[escrow_seeds],
    )?;
    transfer_stable(
        &token_program,
        &escrow,
        &mint,
        &ctx.accounts.bidder_stable_ata.to_account_info(),
        &auth,
        ctx.remaining_accounts,
        refund,
        decimals,
        &[escrow_seeds],
    )?;

    if alloc > 0 {
        let auth_bump = [ctx.bumps.auction_auth];
        let auth_seeds: &[&[u8]] = &[seeds::AUCTION_AUTH, series_key.as_ref(), &auth_bump];
        ti::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.key(),
                ti::MintTo {
                    mint: ctx.accounts.unit_mint.to_account_info(),
                    to: ctx.accounts.bidder_unit_ata.to_account_info(),
                    authority: ctx.accounts.auction_auth.to_account_info(),
                },
                &[auth_seeds],
            ),
            alloc,
        )?;
        let holder_bump = ctx.bumps.holder;
        register_holder_now(
            &ledger,
            &mut ctx.accounts.holder,
            series_key,
            bidder,
            holder_bump,
        )?;
        let t = &mut ctx.accounts.treasury;
        t.proceeds_received = t
            .proceeds_received
            .checked_add(cost)
            .ok_or(ProtocolError::MathOverflow)?;
        emit!(UnitsAllocated {
            series: series_key,
            bidder,
            units: alloc,
            cost,
            fee,
            refund,
        });
    } else {
        if charge > 0 {
            emit!(NonRevealCharged {
                series: series_key,
                bidder,
                charge,
            });
        }
        emit!(BidRefunded {
            series: series_key,
            bidder,
            refund,
            charge,
        });
    }

    let a = &mut ctx.accounts.auction;
    let b = &mut ctx.accounts.bid;
    b.processed = true;
    b.allocation = alloc;
    a.units_minted = a
        .units_minted
        .checked_add(alloc)
        .ok_or(ProtocolError::MathOverflow)?;
    a.bids_processed = a
        .bids_processed
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;

    if a.bids_processed == a.bid_count {
        finalize_mint(
            a,
            &mut ctx.accounts.treasury,
            series_key,
            &ctx.accounts.token_2022_program.to_account_info(),
            &ctx.accounts.unit_mint.to_account_info(),
            &ctx.accounts.auction_auth.to_account_info(),
            ctx.bumps.auction_auth,
            RegistryCpi {
                registry_program: ctx.accounts.registry_program.to_account_info(),
                config: ctx.accounts.config.to_account_info(),
                series: ctx.accounts.series.to_account_info(),
                protocol_signer: ctx.accounts.registry_signer.to_account_info(),
                signer_bump: ctx.bumps.registry_signer,
            },
        )?;
    }
    Ok(())
}

/// `finalize_mint` semantics (SPEC §5.2): exact `units_sold`, exact proceeds, mint authority
/// revoked, registry corrected.
#[allow(clippy::too_many_arguments)]
fn finalize_mint<'info>(
    a: &mut Auction,
    t: &mut Treasury,
    series_key: Pubkey,
    token_2022_program: &AccountInfo<'info>,
    unit_mint: &AccountInfo<'info>,
    auction_auth: &AccountInfo<'info>,
    auction_auth_bump: u8,
    registry: RegistryCpi<'info>,
) -> Result<()> {
    a.units_sold = a.units_minted;
    a.proceeds = a
        .clearing_price
        .checked_mul(a.units_sold)
        .ok_or(ProtocolError::MathOverflow)?;
    require!(
        t.proceeds_received == a.proceeds,
        ProtocolError::MathOverflow
    );
    t.proceeds = a.proceeds;
    t.finalized = true;
    a.mint_finalized = true;
    if !a.mint_authority_revoked {
        let bump = [auction_auth_bump];
        let seeds: &[&[u8]] = &[seeds::AUCTION_AUTH, series_key.as_ref(), &bump];
        ti::set_authority(
            CpiContext::new_with_signer(
                *token_2022_program.key,
                ti::SetAuthority {
                    account_or_mint: unit_mint.clone(),
                    current_authority: auction_auth.clone(),
                },
                &[seeds],
            ),
            AuthorityType::MintTokens,
            None,
        )?;
        a.mint_authority_revoked = true;
        emit!(MintAuthorityRevoked { series: series_key });
    }
    registry.mark_raise_result(
        RAISE_SETTLED,
        a.settlement_ts,
        a.units_sold,
        a.clearing_price,
        true,
    )?;
    emit!(RaiseMintFinalized {
        series: series_key,
        units_sold: a.units_sold,
        proceeds: a.proceeds,
    });
    Ok(())
}

// ----------------------------------------------------------------------------------- refund_bid

#[derive(Accounts)]
pub struct RefundBid<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::AUCTION, series.key().as_ref()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(mut, seeds = [seeds::BID, series.key().as_ref(), bidder.key().as_ref()], bump = bid.bump)]
    pub bid: Box<Account<'info, Bid>>,
    /// CHECK: the bid's owner; the refund goes to its associated token account only.
    #[account(address = bid.bidder)]
    pub bidder: UncheckedAccount<'info>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = bidder, token::token_program = stablecoin_program)]
    pub bidder_stable_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::ESCROW_TOKEN, series.key().as_ref()], bump)]
    pub escrow_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less signer PDA, auction escrow owner.
    #[account(seeds = [seeds::ESCROW_AUTH, series.key().as_ref()], bump)]
    pub escrow_auth: UncheckedAccount<'info>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Failed raise: every bid is refunded in full, revealed or not, no fee (SPEC §5.2).
pub fn refund_bid<'info>(ctx: Context<'info, RefundBid<'info>>) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let a = &ctx.accounts.auction;
    require!(a.state == RAISE_FAILED, ProtocolError::NotSettledOrFailed);
    let b = &ctx.accounts.bid;
    require!(!b.processed, ProtocolError::BidAlreadyProcessed);
    require_ata(
        &ctx.accounts.bidder_stable_ata.to_account_info(),
        &b.bidder,
        &ctx.accounts.series.stablecoin,
        &ctx.accounts.stablecoin_program.key(),
    )?;
    let escrow_bump = [ctx.bumps.escrow_auth];
    let escrow_seeds: &[&[u8]] = &[seeds::ESCROW_AUTH, series_key.as_ref(), &escrow_bump];
    transfer_stable(
        &ctx.accounts.stablecoin_program.to_account_info(),
        &ctx.accounts.escrow_token.to_account_info(),
        &ctx.accounts.stablecoin_mint.to_account_info(),
        &ctx.accounts.bidder_stable_ata.to_account_info(),
        &ctx.accounts.escrow_auth.to_account_info(),
        ctx.remaining_accounts,
        b.escrow,
        ctx.accounts.series.stablecoin_decimals,
        &[escrow_seeds],
    )?;
    let refund = b.escrow;
    let bidder = b.bidder;
    let b = &mut ctx.accounts.bid;
    b.processed = true;
    let a = &mut ctx.accounts.auction;
    a.bids_processed = a
        .bids_processed
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    emit!(BidRefunded {
        series: series_key,
        bidder,
        refund,
        charge: 0,
    });
    Ok(())
}

// ------------------------------------------------------------------------ revoke_mint_authority

#[derive(Accounts)]
pub struct RevokeMintAuthority<'info> {
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::AUCTION, series.key().as_ref()], bump = auction.bump)]
    pub auction: Box<Account<'info, Auction>>,
    /// CHECK: data-less signer PDA, mint authority.
    #[account(seeds = [seeds::AUCTION_AUTH, series.key().as_ref()], bump)]
    pub auction_auth: UncheckedAccount<'info>,
    #[account(mut, address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// Safety crank (SPEC §4.1): revokes the mint authority once every bid is processed, if the
/// `claim_win` path did not already do so.
pub fn revoke_mint_authority(ctx: Context<RevokeMintAuthority>) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let a = &mut ctx.accounts.auction;
    require!(
        a.state == RAISE_SETTLED || a.state == RAISE_FAILED,
        ProtocolError::NotSettledOrFailed
    );
    require!(
        a.bids_processed == a.bid_count,
        ProtocolError::BidsNotProcessed
    );
    require!(
        !a.mint_authority_revoked,
        ProtocolError::MintAuthorityAlreadyRevoked
    );
    let bump = [ctx.bumps.auction_auth];
    let seeds: &[&[u8]] = &[seeds::AUCTION_AUTH, series_key.as_ref(), &bump];
    ti::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            ti::SetAuthority {
                account_or_mint: ctx.accounts.unit_mint.to_account_info(),
                current_authority: ctx.accounts.auction_auth.to_account_info(),
            },
            &[seeds],
        ),
        AuthorityType::MintTokens,
        None,
    )?;
    a.mint_authority_revoked = true;
    emit!(MintAuthorityRevoked { series: series_key });
    Ok(())
}
