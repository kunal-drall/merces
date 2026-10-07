//! Merces Token-2022 transfer hook (SPEC §4.1, brief C10/D2).
//!
//! Rule, evaluated on every transfer of a sealed-bid unit mint:
//! 1. both token accounts must carry Token-2022's "transferring" flag;
//! 2. the series is resolved from the mint through the registry's `MintLink`; curve-mode mints
//!    are rejected;
//! 3. if the source **or** destination is the series' window escrow (owned by the protocol's
//!    `window_escrow_authority` PDA) the transfer is a window movement: the destination owner
//!    must be allowlisted and under the wallet cap unless the destination is the escrow itself;
//! 4. anything else is a direct wallet-to-wallet transfer and is always rejected.
//!
//! Burns through the permanent delegate never invoke the hook, so retirement, redemption and
//! extinguishment burns can never be blocked here.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::spl_token_2022::extension::transfer_hook::TransferHookAccount;
use anchor_spl::token_interface::spl_token_2022::extension::{
    BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_interface::spl_token_2022::state::Account as TokenAccountState;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};
use merces_common::bps_of;
use merces_onchain::seeds::{ALLOW, CONFIG, MINT_LINK, WINDOW_ESCROW};
use merces_registry::state::{AllowlistEntry, MintLink, ProtocolConfig, Series, MODE_SEALED_BID};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, pubkey_data::PubkeyData, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::{
    ExecuteInstruction, InitializeExtraAccountMetaListInstruction,
};

declare_id!("2PuKMkGkGLCwsDMLCmm2bcbzjxtabvt9LVJni154ezRt");

/// Seed of the extra-account-metas PDA, fixed by the transfer-hook interface.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// Number of extra accounts appended to every `Execute` (SPEC §4.1 list plus the registry program
/// needed to resolve its PDAs).
pub const EXTRA_ACCOUNT_COUNT: usize = 6;

#[error_code]
pub enum HookError {
    #[msg("Direct wallet-to-wallet transfers of sealed-bid units are forbidden; use a transfer window")]
    DirectTransferForbidden,
    #[msg("The hook was called outside of a Token-2022 transfer")]
    ProgramCalledOutsideOfTransfer,
    #[msg("Destination owner is not allowlisted")]
    DestinationNotAllowlisted,
    #[msg("Destination balance would exceed the per-wallet cap")]
    WalletCapExceeded,
    #[msg("Curve-mode series units are not governed by this hook")]
    CurveModeNoHook,
    #[msg("Series does not belong to this mint")]
    SeriesMintMismatch,
    #[msg("Allowlist entry account is not the expected PDA")]
    AllowlistEntryMismatch,
    #[msg("Mint authority must sign extra-account-metas initialisation")]
    MintAuthorityMismatch,
    #[msg("Token account could not be read")]
    InvalidTokenAccount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}

/// The extra account metas appended to `Execute`, in order (indices 5..=10 of the instruction).
pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    let (config, _) = Pubkey::find_program_address(&[CONFIG], &merces_registry::ID);
    Ok(vec![
        // 5: registry program (needed as the program for the external PDAs below)
        ExtraAccountMeta::new_with_pubkey(&merces_registry::ID, false, false)?,
        // 6: ProtocolConfig
        ExtraAccountMeta::new_with_pubkey(&config, false, false)?,
        // 7: MintLink = PDA(registry, [MINT_LINK, mint]) — mint is account index 1
        ExtraAccountMeta::new_external_pda_with_seeds(
            5,
            &[
                Seed::Literal {
                    bytes: MINT_LINK.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,
        // 8: Series = the pubkey stored at offset 8 of MintLink (after the discriminator)
        ExtraAccountMeta::new_with_pubkey_data(
            &PubkeyData::AccountData {
                account_index: 7,
                data_index: 8,
            },
            false,
            false,
        )?,
        // 9: AllowlistEntry(source owner) = PDA(registry, [ALLOW, source.owner]) — owner at bytes 32..64 of account 0
        ExtraAccountMeta::new_external_pda_with_seeds(
            5,
            &[
                Seed::Literal {
                    bytes: ALLOW.to_vec(),
                },
                Seed::AccountData {
                    account_index: 0,
                    data_index: 32,
                    length: 32,
                },
            ],
            false,
            false,
        )?,
        // 10: AllowlistEntry(destination owner)
        ExtraAccountMeta::new_external_pda_with_seeds(
            5,
            &[
                Seed::Literal {
                    bytes: ALLOW.to_vec(),
                },
                Seed::AccountData {
                    account_index: 2,
                    data_index: 32,
                    length: 32,
                },
            ],
            false,
            false,
        )?,
    ])
}

#[program]
pub mod merces_hook {
    use super::*;

    /// Creates the `ExtraAccountMetaList` for a unit mint. The mint authority (the protocol's
    /// `auction_authority` PDA) must sign, so only `merces_protocol::open_raise` can call this
    /// for a Merces mint.
    #[instruction(discriminator = InitializeExtraAccountMetaListInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let authority: Option<Pubkey> = ctx.accounts.mint.mint_authority.into();
        require!(
            authority == Some(ctx.accounts.mint_authority.key()),
            HookError::MintAuthorityMismatch
        );
        let metas = extra_account_metas()?;
        let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;
        Ok(())
    }

    /// Called by Token-2022 on every transfer of the mint.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, _amount: u64) -> Result<()> {
        // 1. transferring flags
        require!(
            is_transferring(&ctx.accounts.source_token.to_account_info())?,
            HookError::ProgramCalledOutsideOfTransfer
        );
        require!(
            is_transferring(&ctx.accounts.destination_token.to_account_info())?,
            HookError::ProgramCalledOutsideOfTransfer
        );
        // 2. series by mint
        let series = &ctx.accounts.series;
        require_keys_eq!(
            series.unit_mint,
            ctx.accounts.mint.key(),
            HookError::SeriesMintMismatch
        );
        require!(series.mode == MODE_SEALED_BID, HookError::CurveModeNoHook);

        // 3. window escrow movement?
        let (escrow_authority, _) = Pubkey::find_program_address(
            &[WINDOW_ESCROW, series.key().as_ref()],
            &ctx.accounts.config.protocol_program,
        );
        let source_owner = ctx.accounts.source_token.owner;
        let destination_owner = ctx.accounts.destination_token.owner;
        if source_owner != escrow_authority && destination_owner != escrow_authority {
            // 4. wallet-to-wallet
            return Err(HookError::DirectTransferForbidden.into());
        }
        if destination_owner != escrow_authority {
            // escrow → wallet: destination must be allowlisted and under the cap
            require!(
                allowlisted(&ctx.accounts.destination_allowlist, &destination_owner)?,
                HookError::DestinationNotAllowlisted
            );
            let cap = bps_of(ctx.accounts.mint.supply, series.wallet_cap_bps)
                .map_err(|_| HookError::MathOverflow)?;
            require!(
                ctx.accounts.destination_token.amount <= cap,
                HookError::WalletCapExceeded
            );
        }
        Ok(())
    }
}

fn is_transferring(acc: &AccountInfo) -> Result<bool> {
    let data = acc.try_borrow_data()?;
    let state = StateWithExtensions::<TokenAccountState>::unpack(&data)
        .map_err(|_| HookError::InvalidTokenAccount)?;
    let ext = state
        .get_extension::<TransferHookAccount>()
        .map_err(|_| HookError::ProgramCalledOutsideOfTransfer)?;
    Ok(bool::from(ext.transferring))
}

/// `true` iff `entry` is the registry's `AllowlistEntry` PDA for `wallet`, exists, and is allowed.
/// A missing account (never allowlisted) yields `false`.
fn allowlisted(entry: &AccountInfo, wallet: &Pubkey) -> Result<bool> {
    let (expected, _) =
        Pubkey::find_program_address(&[ALLOW, wallet.as_ref()], &merces_registry::ID);
    require_keys_eq!(*entry.key, expected, HookError::AllowlistEntryMismatch);
    if entry.data_is_empty() || *entry.owner != merces_registry::ID {
        return Ok(false);
    }
    let data = entry.try_borrow_data()?;
    let parsed = AllowlistEntry::try_deserialize(&mut &data[..])?;
    Ok(parsed.allowed && parsed.wallet == *wallet)
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PDA owned by this program, created here with the fixed interface seeds.
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_COUNT).unwrap(),
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(token::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub mint_authority: Signer<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(token::mint = mint, token::token_program = anchor_spl::token_2022::ID)]
    pub source_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(token::token_program = anchor_spl::token_2022::ID)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(token::mint = mint, token::token_program = anchor_spl::token_2022::ID)]
    pub destination_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the transfer authority; Token-2022 has already verified it.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the ExtraAccountMetaList PDA; only its address is checked, Token-2022 read it.
    #[account(seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: the registry program id (needed by Token-2022 to resolve external PDAs).
    #[account(address = merces_registry::ID)]
    pub registry_program: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(seeds = [MINT_LINK, mint.key().as_ref()], bump = mint_link.bump, seeds::program = merces_registry::ID)]
    pub mint_link: Box<Account<'info, MintLink>>,
    #[account(address = mint_link.series @ HookError::SeriesMintMismatch)]
    pub series: Box<Account<'info, Series>>,
    /// CHECK: registry `AllowlistEntry` PDA of the source owner; may not exist. Validated in `allowlisted`.
    pub source_allowlist: UncheckedAccount<'info>,
    /// CHECK: registry `AllowlistEntry` PDA of the destination owner; may not exist. Validated in `allowlisted`.
    pub destination_allowlist: UncheckedAccount<'info>,
}
