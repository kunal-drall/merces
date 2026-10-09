//! Raise path (SPEC v1.1 §5): unit mint and escrows, sealed-bid commit/reveal, claim-based paged
//! settlement, `process_bid` (protocol-side effects only) and retryable `deliver_bid`.

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
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
    allocation, bid_is_valid, check_proposal, marginal_alloc, non_reveal_split, r_claim,
    settle_winner, wallet_cap_units, RejectReason,
};
use merces_common::encoding::commitment_preimage;
use merces_onchain::keccak;
use merces_onchain::seeds::{ALLOW, CONFIG};
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
/// ledger, escrow arm) and the stablecoin PDAs (auction escrow, treasury, vault, window escrow).
/// Split from `open_raise` to keep each instruction's account-validation frame under the SBF
/// stack limit.
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
    /// CHECK: the future unit mint PDA (created in `open_raise`); only its address is used here.
    #[account(seeds = [seeds::UNIT_MINT, series.key().as_ref()], bump)]
    pub unit_mint: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, permanent delegate and vault owner.
    #[account(seeds = [seeds::VAULT_AUTH, series.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, auction stablecoin escrow owner.
    #[account(seeds = [seeds::ESCROW_AUTH, series.key().as_ref()], bump)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, treasury owner.
    #[account(seeds = [seeds::TREASURY_AUTH, series.key().as_ref()], bump)]
    pub treasury_auth: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, window escrow owner (units and stablecoin).
    #[account(seeds = [seeds::WINDOW_ESCROW, series.key().as_ref()], bump)]
    pub window_escrow_auth: UncheckedAccount<'info>,
    #[account(init, payer = issuer, space = 8 + Auction::INIT_SPACE, seeds = [seeds::AUCTION, series.key().as_ref()], bump)]
    pub auction: Box<Account<'info, Auction>>,
    #[account(init, payer = issuer, space = 8 + Treasury::INIT_SPACE, seeds = [seeds::TREASURY, series.key().as_ref()], bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(init, payer = issuer, space = Ledger::LEN, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(init, payer = issuer, space = 8 + EscrowArm::INIT_SPACE, seeds = [seeds::ESCROW_ARM, unit_mint.key().as_ref()], bump)]
    pub escrow_arm: Box<Account<'info, EscrowArm>>,
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
    #[account(
        init,
        payer = issuer,
        seeds = [seeds::WINDOW_STABLE, series.key().as_ref()],
        bump,
        token::mint = stablecoin_mint,
        token::authority = window_escrow_auth,
        token::token_program = stablecoin_program,
    )]
    pub window_stable: Box<InterfaceAccount<'info, TokenAccount>>,
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
    let arm = &mut ctx.accounts.escrow_arm;
    arm.armed_owner = Pubkey::default();
    arm.armed_units = 0;
    arm.bump = ctx.bumps.escrow_arm;
    ledger.series = series_key;
    ledger.bump = ctx.bumps.ledger;
    Ok(())
}

// ------------------------------------------------------------------------------------ open_raise

/// Step 2: creates the Token-2022 unit mint (SPEC §4.1), records the raise in the registry
/// (which maps the mint and the two unit escrow ATAs to the series), creates the hook's
/// extra-account-metas list and the escrow ATAs, then opens the commit phase.
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
    /// CHECK: data-less signer PDA owning the auction unit escrow ATA.
    #[account(seeds = [seeds::AUCTION_ESCROW, series.key().as_ref()], bump)]
    pub auction_escrow_auth: UncheckedAccount<'info>,
    /// CHECK: ATA of `auction_escrow_auth` for the unit mint, created here; address validated.
    #[account(mut)]
    pub auction_escrow_ata: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA owning the window escrows.
    #[account(seeds = [seeds::WINDOW_ESCROW, series.key().as_ref()], bump)]
    pub window_escrow_auth: UncheckedAccount<'info>,
    /// CHECK: ATA of `window_escrow_auth` for the unit mint, created here; address validated.
    #[account(mut)]
    pub window_escrow_ata: UncheckedAccount<'info>,
    /// CHECK: the hook's ExtraAccountMetaList PDA, created by the hook program via CPI.
    #[account(mut, seeds = [merces_hook::EXTRA_ACCOUNT_METAS_SEED, unit_mint.key().as_ref()], bump, seeds::program = merces_hook::ID)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_AUTHORITY], bump)]
    pub registry_authority: UncheckedAccount<'info>,
    pub hook_program: Program<'info, merces_hook::program::MercesHook>,
    pub registry_program: Program<'info, MercesRegistry>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
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
    require!(
        ctx.accounts.auction.state == RAISE_DRAFT,
        ProtocolError::RaiseNotOpen
    );

    let series_key = series.key();
    let mint_key = ctx.accounts.unit_mint.key();
    let t22 = ctx.accounts.token_2022_program.key();
    let auction_escrow_ata = ata_address(&ctx.accounts.auction_escrow_auth.key(), &mint_key, &t22);
    let window_escrow_ata = ata_address(&ctx.accounts.window_escrow_auth.key(), &mint_key, &t22);
    require_keys_eq!(
        ctx.accounts.auction_escrow_ata.key(),
        auction_escrow_ata,
        ProtocolError::AtaMismatch
    );
    require_keys_eq!(
        ctx.accounts.window_escrow_ata.key(),
        window_escrow_ata,
        ProtocolError::AtaMismatch
    );

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
    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            system_program::CreateAccount {
                from: ctx.accounts.issuer.to_account_info(),
                to: ctx.accounts.unit_mint.to_account_info(),
            },
            &[mint_seeds],
        ),
        rent.minimum_balance(space),
        space as u64,
        &t22,
    )?;
    // 2. extensions (before initialize_mint2)
    transfer_hook_initialize(
        CpiContext::new(
            t22,
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
            t22,
            PermanentDelegateInitialize {
                token_program_id: ctx.accounts.token_2022_program.to_account_info(),
                mint: ctx.accounts.unit_mint.to_account_info(),
            },
        ),
        &ctx.accounts.vault_auth.key(),
    )?;
    metadata_pointer_initialize(
        CpiContext::new(
            t22,
            MetadataPointerInitialize {
                token_program_id: ctx.accounts.token_2022_program.to_account_info(),
                mint: ctx.accounts.unit_mint.to_account_info(),
            },
        ),
        None,
        Some(mint_key),
    )?;
    ti::initialize_mint2(
        CpiContext::new(
            t22,
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
        mint: mint_key,
        name: name.clone(),
        symbol: symbol.clone(),
        uri: uri.clone(),
        additional_metadata: vec![],
    };
    let new_len = ctx
        .accounts
        .unit_mint
        .data_len()
        .checked_add(metadata.tlv_size_of()?)
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
            t22,
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
    // 4. registry: Draft → Open, mint and escrow ATAs recorded (the hook reads them)
    let authority_bump = [ctx.bumps.registry_authority];
    let authority_seeds: &[&[u8]] = &[seeds::REGISTRY_AUTHORITY, &authority_bump];
    merces_registry::cpi::mark_raise_opened(
        CpiContext::new_with_signer(
            ctx.accounts.registry_program.key(),
            merces_registry::cpi::accounts::MarkRaiseOpened {
                config: ctx.accounts.config.to_account_info(),
                protocol_authority: ctx.accounts.registry_authority.to_account_info(),
                series: ctx.accounts.series.to_account_info(),
                issuer_allowlist: ctx.accounts.issuer_allowlist.to_account_info(),
            },
            &[authority_seeds],
        ),
        mint_key,
        now,
        auction_escrow_ata,
        window_escrow_ata,
    )?;
    // 5. hook extra account metas (mint authority signs; requires series.unit_mint == mint)
    merces_hook::cpi::initialize_extra_account_meta_list(CpiContext::new_with_signer(
        ctx.accounts.hook_program.key(),
        merces_hook::cpi::accounts::InitializeExtraAccountMetaList {
            payer: ctx.accounts.issuer.to_account_info(),
            extra_account_meta_list: ctx.accounts.extra_account_meta_list.to_account_info(),
            mint: ctx.accounts.unit_mint.to_account_info(),
            mint_authority: ctx.accounts.auction_auth.to_account_info(),
            config: ctx.accounts.config.to_account_info(),
            series: ctx.accounts.series.to_account_info(),
            token_program: ctx.accounts.token_2022_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
        &[auth_seeds],
    ))?;
    // 6. unit escrow ATAs (Token-2022 adds the TransferHookAccount extension automatically)
    for (ata, owner) in [
        (
            &ctx.accounts.auction_escrow_ata,
            &ctx.accounts.auction_escrow_auth,
        ),
        (
            &ctx.accounts.window_escrow_ata,
            &ctx.accounts.window_escrow_auth,
        ),
    ] {
        create_ata_idempotent(CreateAta {
            payer: &ctx.accounts.issuer.to_account_info(),
            ata: &ata.to_account_info(),
            owner: &owner.to_account_info(),
            mint: &ctx.accounts.unit_mint.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
            token_program: &ctx.accounts.token_2022_program.to_account_info(),
            ata_program: &ctx.accounts.associated_token_program.to_account_info(),
        })?;
    }

    // 7. auction state
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
        unit_mint: mint_key,
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
    #[account(seeds = [seeds::REGISTRY_AUTHORITY], bump)]
    pub registry_authority: UncheckedAccount<'info>,
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
        registry_authority: ctx.accounts.registry_authority.to_account_info(),
        authority_bump: ctx.bumps.registry_authority,
    }
    .mark_raise_result(RAISE_CANCELLED, 0, 0, 0)?;
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
    /// CHECK: the bidder's registry `AllowlistEntry` PDA; validated in the handler after the phase checks.
    pub bidder_allowlist: UncheckedAccount<'info>,
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
    require_allowlisted(
        &ctx.accounts.bidder_allowlist.to_account_info(),
        &ctx.accounts.bidder.key(),
    )?;
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

/// Starts a settlement round with the proposer's claims (SPEC §5.2). Allowed only when no round
/// is in progress (`tally_round == 0 || round_rejected`), so honest keepers' tallies cannot be reset.
pub fn begin_settlement(
    ctx: Context<BeginSettlement>,
    clearing_price: u64,
    q_above_claim: u64,
    q_at_claim: u64,
) -> Result<()> {
    let now = now_ts()?;
    let series = &ctx.accounts.series;
    let a = &mut ctx.accounts.auction;
    require!(
        a.state == RAISE_OPEN || a.state == RAISE_SETTLING,
        ProtocolError::RaiseNotOpen
    );
    require!(now >= a.reveal_end, ProtocolError::RevealPhaseNotOver);
    require!(
        a.tally_round == 0 || a.round_rejected,
        ProtocolError::TallyInProgress
    );
    a.state = RAISE_SETTLING;
    a.tally_round = a
        .tally_round
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    a.round_rejected = false;
    a.rejection_reason = 0;
    a.clearing_price = clearing_price;
    a.q_above_claim = q_above_claim;
    a.q_at_claim = q_at_claim;
    a.r_claim = r_claim(series.units_offered, q_above_claim, q_at_claim);
    a.q_above = 0;
    a.q_at = 0;
    a.alloc_sum = 0;
    a.min_valid_price = u64::MAX;
    a.tallied_count = 0;
    emit!(SettlementProposed {
        series: series.key(),
        clearing_price,
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
    require!(!a.round_rejected, ProtocolError::NotSettling);
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
            a.min_valid_price = core::cmp::min(a.min_valid_price, bid.price);
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
                let alloc = marginal_alloc(a.r_claim, bid.quantity, a.q_at_claim).map_err(math)?;
                a.alloc_sum = a
                    .alloc_sum
                    .checked_add(alloc)
                    .ok_or(ProtocolError::MathOverflow)?;
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
    #[account(mut, seeds = [seeds::TREASURY, series.key().as_ref()], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_AUTHORITY], bump)]
    pub registry_authority: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
}

/// `finalize_settlement` (SPEC §5.2): never reverts on a wrong proposal; exact results in one
/// pass from the tallied claims.
pub fn finalize_settlement(ctx: Context<FinalizeSettlement>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series = &ctx.accounts.series;
    let series_key = series.key();
    let a = &mut ctx.accounts.auction;
    require!(a.state == RAISE_SETTLING, ProtocolError::NotSettling);
    require!(!a.round_rejected, ProtocolError::NotSettling);
    require!(
        a.tallied_count == a.revealed_count,
        ProtocolError::TallyIncomplete
    );
    let registry = RegistryCpi {
        registry_program: ctx.accounts.registry_program.to_account_info(),
        config: ctx.accounts.config.to_account_info(),
        series: ctx.accounts.series.to_account_info(),
        registry_authority: ctx.accounts.registry_authority.to_account_info(),
        authority_bump: ctx.bumps.registry_authority,
    };
    let fail =
        |a: &mut Auction, clearing_price: u64, units_sold: u64, proceeds: u64| -> Result<()> {
            a.state = RAISE_FAILED;
            a.clearing_price = clearing_price;
            a.settlement_ts = now;
            // the would-be results stay readable; nothing is minted or deposited
            a.units_sold = units_sold;
            a.proceeds = proceeds;
            a.r_claim = 0;
            registry.mark_raise_result(RAISE_FAILED, now, 0, clearing_price)?;
            emit!(RaiseFailed {
                series: series_key,
                clearing_price,
                proceeds,
                min_raise: series.min_raise,
            });
            Ok(())
        };
    // 1. no valid bids
    if a.valid_count == 0 {
        return fail(a, 0, 0, 0);
    } // 2–3. claims and price validity
    let check = check_proposal(
        series.units_offered,
        a.clearing_price,
        a.q_above_claim,
        a.q_at_claim,
        a.q_above,
        a.q_at,
        a.min_valid_price,
    )
    .map_err(math)?;
    if let Err(reason) = check {
        a.round_rejected = true;
        a.rejection_reason = reason as u8;
        emit!(SettlementRejected {
            series: series_key,
            round: a.tally_round,
            clearing_price: a.clearing_price,
            reason: reason as u8,
        });
        return Ok(());
    }
    // 4. exact results
    let units_sold = a
        .q_above
        .checked_add(a.alloc_sum)
        .ok_or(ProtocolError::MathOverflow)?;
    let proceeds = a
        .clearing_price
        .checked_mul(units_sold)
        .ok_or(ProtocolError::MathOverflow)?;
    // 5. min raise (a zero allocation — only possible with sub-unit marginal shares — fails too)
    if proceeds < series.min_raise || units_sold == 0 {
        let p = a.clearing_price;
        return fail(a, p, units_sold, proceeds);
    }
    a.state = RAISE_SETTLED;
    a.settlement_ts = now;
    a.units_sold = units_sold;
    a.proceeds = proceeds;
    ctx.accounts.treasury.proceeds = proceeds;
    registry.mark_raise_result(RAISE_SETTLED, now, units_sold, a.clearing_price)?;
    ledger.init_after_settlement(now)?;
    emit!(RaiseSettled {
        series: series_key,
        clearing_price: a.clearing_price,
        units_sold,
        proceeds,
        settlement_ts: now,
    });
    Ok(())
}

// ---------------------------------------------------------------------------------- process_bid

#[derive(Accounts)]
pub struct ProcessBid<'info> {
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
    /// CHECK: the bid's owner (only its key is used; nothing is sent to it here).
    #[account(address = bid.bidder)]
    pub bidder: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, auction stablecoin escrow owner.
    #[account(seeds = [seeds::ESCROW_AUTH, series.key().as_ref()], bump)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, mint authority.
    #[account(seeds = [seeds::AUCTION_AUTH, series.key().as_ref()], bump)]
    pub auction_auth: UncheckedAccount<'info>,
    /// CHECK: the auction stablecoin escrow PDA created in `prepare_raise`.
    #[account(mut, seeds = [seeds::ESCROW_TOKEN, series.key().as_ref()], bump)]
    pub escrow_token: UncheckedAccount<'info>,
    /// CHECK: the treasury stablecoin PDA created in `prepare_raise`.
    #[account(mut, seeds = [seeds::TREASURY_TOKEN, series.key().as_ref()], bump)]
    pub treasury_token: UncheckedAccount<'info>,
    /// CHECK: the fee collector's ATA; derivation validated in the handler.
    #[account(mut)]
    pub fee_collector_ata: UncheckedAccount<'info>,
    /// CHECK: the auction unit escrow ATA recorded in the registry.
    #[account(mut, address = series.auction_escrow_ata @ ProtocolError::EscrowAccountMismatch)]
    pub auction_escrow_ata: UncheckedAccount<'info>,
    /// CHECK: the unit mint recorded in the registry.
    #[account(mut, address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: UncheckedAccount<'info>,
    /// CHECK: the stablecoin mint recorded in the registry.
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: UncheckedAccount<'info>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_AUTHORITY], bump)]
    pub registry_authority: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
    pub system_program: Program<'info, System>,
}

/// `process_bid` (SPEC §5.2): moves funds only to protocol-owned accounts and records what the
/// bidder is owed; the last call finalises the mint. Remaining accounts: hook accounts for a
/// Token-2022 stablecoin, if any.
pub fn process_bid<'info>(ctx: Context<'info, ProcessBid<'info>>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    let a = &ctx.accounts.auction;
    require!(
        a.state == RAISE_SETTLED || a.state == RAISE_FAILED,
        ProtocolError::NotSettledOrFailed
    );
    let b = &ctx.accounts.bid;
    require!(!b.processed, ProtocolError::BidAlreadyProcessed);
    let stable_program = ctx.accounts.stablecoin_program.key();
    require_ata(
        &ctx.accounts.fee_collector_ata.to_account_info(),
        &ctx.accounts.config.fee_collector,
        &series.stablecoin,
        &stable_program,
    )?;
    let bidder = ctx.accounts.bidder.key();
    let decimals = series.stablecoin_decimals;

    // allocation and money split
    let (alloc, cost, fee, pending_refund, charge) = if a.state == RAISE_FAILED {
        (0u64, 0u64, 0u64, b.escrow, 0u64)
    } else if !b.revealed {
        let (charge, refund) =
            non_reveal_split(b.escrow, series.non_reveal_charge_bps).map_err(math)?;
        (0, 0, 0, refund, charge)
    } else if !b.valid {
        (0, 0, 0, b.escrow, 0)
    } else {
        let alloc = allocation(
            b.price,
            b.quantity,
            a.clearing_price,
            a.r_claim,
            a.q_at_claim,
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

    // money: escrow → treasury (cost), → fee collector (fee + non-reveal charge)
    let escrow_bump = [ctx.bumps.escrow_auth];
    let escrow_seeds: &[&[u8]] = &[seeds::ESCROW_AUTH, series_key.as_ref(), &escrow_bump];
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
    transfer_stable(
        &token_program,
        &escrow,
        &mint,
        &ctx.accounts.fee_collector_ata.to_account_info(),
        &auth,
        ctx.remaining_accounts,
        fee.checked_add(charge).ok_or(ProtocolError::MathOverflow)?,
        decimals,
        &[escrow_seeds],
    )?;
    if charge > 0 {
        emit!(NonRevealCharged {
            series: series_key,
            bidder,
            charge,
        });
    }

    if alloc > 0 {
        // mint to the auction escrow; the holder is registered with the units as pending weight
        let auth_bump = [ctx.bumps.auction_auth];
        let auth_seeds: &[&[u8]] = &[seeds::AUCTION_AUTH, series_key.as_ref(), &auth_bump];
        ti::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.key(),
                ti::MintTo {
                    mint: ctx.accounts.unit_mint.to_account_info(),
                    to: ctx.accounts.auction_escrow_ata.to_account_info(),
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
        let h = &mut ctx.accounts.holder;
        h.undelivered_units = h
            .undelivered_units
            .checked_add(alloc)
            .ok_or(ProtocolError::MathOverflow)?;
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
            refund: pending_refund,
        });
    }

    let a = &mut ctx.accounts.auction;
    let b = &mut ctx.accounts.bid;
    b.processed = true;
    b.allocation = alloc;
    b.pending_units = alloc;
    b.pending_refund = pending_refund;
    a.units_minted = a
        .units_minted
        .checked_add(alloc)
        .ok_or(ProtocolError::MathOverflow)?;
    a.bids_processed = a
        .bids_processed
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;

    if a.bids_processed == a.bid_count && a.state == RAISE_SETTLED {
        require!(
            a.units_minted == a.units_sold,
            ProtocolError::MintedUnitsMismatch
        );
        let t = &mut ctx.accounts.treasury;
        require!(
            t.proceeds_received == a.proceeds,
            ProtocolError::ProceedsMismatch
        );
        t.proceeds = a.proceeds;
        t.mint_finalized = true;
        a.mint_finalized = true;
        if !a.mint_authority_revoked {
            let auth_bump = [ctx.bumps.auction_auth];
            let auth_seeds: &[&[u8]] = &[seeds::AUCTION_AUTH, series_key.as_ref(), &auth_bump];
            ti::set_authority(
                CpiContext::new_with_signer(
                    ctx.accounts.token_2022_program.key(),
                    ti::SetAuthority {
                        account_or_mint: ctx.accounts.unit_mint.to_account_info(),
                        current_authority: ctx.accounts.auction_auth.to_account_info(),
                    },
                    &[auth_seeds],
                ),
                AuthorityType::MintTokens,
                None,
            )?;
            a.mint_authority_revoked = true;
            emit!(MintAuthorityRevoked { series: series_key });
        }
        RegistryCpi {
            registry_program: ctx.accounts.registry_program.to_account_info(),
            config: ctx.accounts.config.to_account_info(),
            series: ctx.accounts.series.to_account_info(),
            registry_authority: ctx.accounts.registry_authority.to_account_info(),
            authority_bump: ctx.bumps.registry_authority,
        }
        .mark_mint_finalized()?;
        ledger.units_outstanding = a.units_sold;
        ledger.mint_finalized = 1;
        emit!(RaiseMintFinalized {
            series: series_key,
            units_sold: a.units_sold,
            proceeds: a.proceeds,
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------------- deliver_bid

#[derive(Accounts)]
pub struct DeliverBid<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::BID, series.key().as_ref(), bidder.key().as_ref()], bump = bid.bump)]
    pub bid: Box<Account<'info, Bid>>,
    /// CHECK: the bid's owner; refunds and units go to its associated token accounts only.
    #[account(address = bid.bidder)]
    pub bidder: UncheckedAccount<'info>,
    /// Required when units are pending (every winner has one from `process_bid`).
    #[account(mut, seeds = [seeds::HOLDER, series.key().as_ref(), bidder.key().as_ref()], bump = holder.bump)]
    pub holder: Option<Box<Account<'info, Holder>>>,
    /// CHECK: the bidder's stablecoin ATA (created idempotently; derivation validated).
    #[account(mut)]
    pub bidder_stable_ata: UncheckedAccount<'info>,
    /// CHECK: the bidder's unit ATA (created idempotently; derivation validated).
    #[account(mut)]
    pub bidder_unit_ata: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, auction stablecoin escrow owner.
    #[account(seeds = [seeds::ESCROW_AUTH, series.key().as_ref()], bump)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: the auction stablecoin escrow PDA.
    #[account(mut, seeds = [seeds::ESCROW_TOKEN, series.key().as_ref()], bump)]
    pub escrow_token: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA owning the auction unit escrow ATA.
    #[account(seeds = [seeds::AUCTION_ESCROW, series.key().as_ref()], bump)]
    pub auction_escrow_auth: UncheckedAccount<'info>,
    /// CHECK: the auction unit escrow ATA recorded in the registry.
    #[account(mut, address = series.auction_escrow_ata @ ProtocolError::EscrowAccountMismatch)]
    pub auction_escrow_ata: UncheckedAccount<'info>,
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

/// `deliver_bid` (SPEC §5.2): pays the pending refund and moves the pending units from the
/// auction escrow to the bidder (hook rule 3). Retryable; never touches counters or the
/// treasury. Remaining accounts: the Merces hook accounts for the unit mint
/// `[hook_program, extra_account_meta_list, config, series, merces_protocol, escrow_arm]` and
/// the stablecoin's hook accounts, if any.
pub fn deliver_bid<'info>(ctx: Context<'info, DeliverBid<'info>>) -> Result<()> {
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    let b = &ctx.accounts.bid;
    require!(b.processed, ProtocolError::BidNotProcessed);
    require!(!b.delivered, ProtocolError::BidAlreadyDelivered);
    let bidder = ctx.accounts.bidder.key();
    let units = b.pending_units;
    let refund = b.pending_refund;

    if refund > 0 {
        create_ata_idempotent(CreateAta {
            payer: &ctx.accounts.payer.to_account_info(),
            ata: &ctx.accounts.bidder_stable_ata.to_account_info(),
            owner: &ctx.accounts.bidder.to_account_info(),
            mint: &ctx.accounts.stablecoin_mint.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
            token_program: &ctx.accounts.stablecoin_program.to_account_info(),
            ata_program: &ctx.accounts.associated_token_program.to_account_info(),
        })?;
        let bump = [ctx.bumps.escrow_auth];
        let escrow_seeds: &[&[u8]] = &[seeds::ESCROW_AUTH, series_key.as_ref(), &bump];
        transfer_stable(
            &ctx.accounts.stablecoin_program.to_account_info(),
            &ctx.accounts.escrow_token.to_account_info(),
            &ctx.accounts.stablecoin_mint.to_account_info(),
            &ctx.accounts.bidder_stable_ata.to_account_info(),
            &ctx.accounts.escrow_auth.to_account_info(),
            ctx.remaining_accounts,
            refund,
            series.stablecoin_decimals,
            &[escrow_seeds],
        )?;
    }
    if units > 0 {
        let holder = ctx
            .accounts
            .holder
            .as_mut()
            .ok_or(ProtocolError::HolderNotRegistered)?;
        require!(holder.registered, ProtocolError::HolderNotRegistered);
        create_ata_idempotent(CreateAta {
            payer: &ctx.accounts.payer.to_account_info(),
            ata: &ctx.accounts.bidder_unit_ata.to_account_info(),
            owner: &ctx.accounts.bidder.to_account_info(),
            mint: &ctx.accounts.unit_mint.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
            token_program: &ctx.accounts.token_2022_program.to_account_info(),
            ata_program: &ctx.accounts.associated_token_program.to_account_info(),
        })?;
        let bump = [ctx.bumps.auction_escrow_auth];
        let escrow_seeds: &[&[u8]] = &[seeds::AUCTION_ESCROW, series_key.as_ref(), &bump];
        transfer_units(
            &ctx.accounts.token_2022_program.to_account_info(),
            &ctx.accounts.auction_escrow_ata.to_account_info(),
            &ctx.accounts.unit_mint.to_account_info(),
            &ctx.accounts.bidder_unit_ata.to_account_info(),
            &ctx.accounts.auction_escrow_auth.to_account_info(),
            ctx.remaining_accounts,
            units,
            &[escrow_seeds],
        )?;
        // delivery does not change the accrual weight: escrow units become balance units
        holder.undelivered_units = holder
            .undelivered_units
            .checked_sub(units)
            .ok_or(ProtocolError::MathOverflow)?;
    }
    let b = &mut ctx.accounts.bid;
    b.delivered = true;
    b.pending_units = 0;
    b.pending_refund = 0;
    emit!(BidDelivered {
        series: series_key,
        bidder,
        units,
        refund,
    });
    Ok(())
}

/// Reason codes re-exported for tests.
pub const REJECT_CLAIM_MISMATCH: u8 = RejectReason::ClaimMismatch as u8;
pub const REJECT_INVALID_CLEARING_PRICE: u8 = RejectReason::InvalidClearingPrice as u8;
