//! Merces Token-2022 transfer hook (SPEC v1.1 §4.1, brief C10/D2).
//!
//! Rule, evaluated on every transfer of a sealed-bid unit mint:
//! 1. both token accounts must carry Token-2022's "transferring" flag;
//! 2. curve-mode series are rejected;
//! 3. if the **source** is the series' auction escrow or window escrow → allow (deliveries, fills
//!    and returns: the protocol has already applied allowlist and cap rules);
//! 4. else if the **destination** is the window escrow → allow only if the protocol's `EscrowArm`
//!    for the mint is armed for exactly `(source_owner, amount)` (an armed `commit_ask`);
//! 5. otherwise (wallet-to-wallet, or into the auction escrow) → reject `DirectTransferForbidden`.
//!
//! Burns through the permanent delegate never invoke the hook, so retirement, redemption and
//! extinguishment burns can never be blocked here.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::spl_token_2022::extension::transfer_hook::TransferHookAccount;
use anchor_spl::token_interface::spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};
use anchor_spl::token_interface::spl_token_2022::state::Account as TokenAccountState;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};
use merces_onchain::seeds::{CONFIG, ESCROW_ARM};
use merces_registry::state::{ProtocolConfig, Series, MODE_SEALED_BID};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, InitializeExtraAccountMetaListInstruction};

declare_id!("2PuKMkGkGLCwsDMLCmm2bcbzjxtabvt9LVJni154ezRt");

/// Seed of the extra-account-metas PDA, fixed by the transfer-hook interface.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// Extra accounts appended to every `Execute`: ProtocolConfig, Series, the protocol program (needed
/// to resolve the external PDA) and the `EscrowArm` PDA of the protocol program for this mint.
pub const EXTRA_ACCOUNT_COUNT: usize = 4;

/// Byte offsets inside the protocol's `EscrowArm` account (8-byte Anchor discriminator first).
const ARM_OWNER_OFFSET: usize = 8;
const ARM_UNITS_OFFSET: usize = 40;
const ARM_MIN_LEN: usize = 48;

#[error_code]
pub enum HookError {
    #[msg("Direct wallet-to-wallet transfers of sealed-bid units are forbidden; use a transfer window")]
    DirectTransferForbidden,
    #[msg("The hook was called outside of a Token-2022 transfer")]
    ProgramCalledOutsideOfTransfer,
    #[msg("Deposit into the window escrow is not armed for this owner and amount")]
    UnarmedEscrowDeposit,
    #[msg("Curve-mode series units are not governed by this hook")]
    CurveModeNoHook,
    #[msg("Series does not belong to this mint")]
    SeriesMintMismatch,
    #[msg("EscrowArm account is not the protocol's PDA for this mint")]
    EscrowArmMismatch,
    #[msg("Mint authority must sign extra-account-metas initialisation")]
    MintAuthorityMismatch,
    #[msg("Token account could not be read")]
    InvalidTokenAccount,
    #[msg("Extra account list does not match the mint's ExtraAccountMetaList")]
    ExtraAccountsMismatch,
}

/// The extra account metas for a mint, in order (indices 5..=8 of the `Execute` instruction).
pub fn extra_account_metas(series: &Pubkey, protocol_program: &Pubkey) -> Result<Vec<ExtraAccountMeta>> {
    let (config, _) = Pubkey::find_program_address(&[CONFIG], &merces_registry::ID);
    Ok(vec![
        // 5: ProtocolConfig
        ExtraAccountMeta::new_with_pubkey(&config, false, false)?,
        // 6: Series (literal; the series PDA exists before the mint)
        ExtraAccountMeta::new_with_pubkey(series, false, false)?,
        // 7: merces_protocol program (the program of the external PDA below)
        ExtraAccountMeta::new_with_pubkey(protocol_program, false, false)?,
        // 8: EscrowArm = PDA(protocol_program, [ESCROW_ARM, mint]) — mint is account index 1
        ExtraAccountMeta::new_external_pda_with_seeds(
            7,
            &[Seed::Literal { bytes: ESCROW_ARM.to_vec() }, Seed::AccountKey { index: 1 }],
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
    /// for a Merces mint, and the registry must already map the series to the mint.
    #[instruction(discriminator = InitializeExtraAccountMetaListInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn initialize_extra_account_meta_list(ctx: Context<InitializeExtraAccountMetaList>) -> Result<()> {
        let authority: Option<Pubkey> = ctx.accounts.mint.mint_authority.into();
        require!(authority == Some(ctx.accounts.mint_authority.key()), HookError::MintAuthorityMismatch);
        require_keys_eq!(ctx.accounts.series.unit_mint, ctx.accounts.mint.key(), HookError::SeriesMintMismatch);
        let metas = extra_account_metas(&ctx.accounts.series.key(), &ctx.accounts.config.protocol_program)?;
        let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &metas)?;
        Ok(())
    }

    /// Called by Token-2022 on every transfer of the mint.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        // 1. transferring flags
        require!(is_transferring(&ctx.accounts.source_token.to_account_info())?, HookError::ProgramCalledOutsideOfTransfer);
        require!(is_transferring(&ctx.accounts.destination_token.to_account_info())?, HookError::ProgramCalledOutsideOfTransfer);
        // the resolved extra accounts must be exactly the mint's list
        {
            let list = ctx.accounts.extra_account_meta_list.try_borrow_data()?;
            let infos: Vec<AccountInfo> = ctx.accounts.to_account_infos();
            let mut ix_data = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE.to_vec();
            ix_data.extend_from_slice(&amount.to_le_bytes());
            ExtraAccountMetaList::check_account_infos::<ExecuteInstruction>(&infos, &ix_data, &crate::ID, &list)
                .map_err(|_| HookError::ExtraAccountsMismatch)?;
        }
        // 2. series by mint
        let series = &ctx.accounts.series;
        require_keys_eq!(series.unit_mint, ctx.accounts.mint.key(), HookError::SeriesMintMismatch);
        require!(series.mode == MODE_SEALED_BID, HookError::CurveModeNoHook);

        let source = ctx.accounts.source_token.key();
        let destination = ctx.accounts.destination_token.key();
        // 3. protocol escrow as the source: deliveries, fills, returns
        if source == series.auction_escrow_ata || source == series.window_escrow_ata {
            return Ok(());
        }
        // 4. armed deposit into the window escrow
        if destination == series.window_escrow_ata {
            let (armed_owner, armed_units) = read_arm(&ctx.accounts.escrow_arm, &ctx.accounts.config.protocol_program, &ctx.accounts.mint.key())?;
            require!(
                armed_owner == ctx.accounts.source_token.owner && armed_units == amount && amount > 0,
                HookError::UnarmedEscrowDeposit
            );
            return Ok(());
        }
        // 5. everything else
        Err(HookError::DirectTransferForbidden.into())
    }
}

fn is_transferring(acc: &AccountInfo) -> Result<bool> {
    let data = acc.try_borrow_data()?;
    let state = StateWithExtensions::<TokenAccountState>::unpack(&data).map_err(|_| HookError::InvalidTokenAccount)?;
    let ext = state.get_extension::<TransferHookAccount>().map_err(|_| HookError::ProgramCalledOutsideOfTransfer)?;
    Ok(bool::from(ext.transferring))
}

/// Validates the `EscrowArm` PDA (owner = protocol program, seeds `[ESCROW_ARM, mint]`) and reads
/// `(armed_owner, armed_units)`.
fn read_arm(arm: &AccountInfo, protocol_program: &Pubkey, mint: &Pubkey) -> Result<(Pubkey, u64)> {
    let (expected, _) = Pubkey::find_program_address(&[ESCROW_ARM, mint.as_ref()], protocol_program);
    require_keys_eq!(*arm.key, expected, HookError::EscrowArmMismatch);
    require_keys_eq!(*arm.owner, *protocol_program, HookError::EscrowArmMismatch);
    let data = arm.try_borrow_data()?;
    require!(data.len() >= ARM_MIN_LEN, HookError::EscrowArmMismatch);
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&data[ARM_OWNER_OFFSET..ARM_OWNER_OFFSET + 32]);
    let mut units = [0u8; 8];
    units.copy_from_slice(&data[ARM_UNITS_OFFSET..ARM_UNITS_OFFSET + 8]);
    Ok((Pubkey::new_from_array(owner), u64::from_le_bytes(units)))
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
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    /// The registry series that owns `mint` (`series.unit_mint == mint`, written by `mark_raise_opened`).
    pub series: Box<Account<'info, Series>>,
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
    /// CHECK: the ExtraAccountMetaList PDA; its contents are checked against the resolved accounts.
    #[account(seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub series: Box<Account<'info, Series>>,
    /// CHECK: the protocol program id, pinned to the registry configuration.
    #[account(address = config.protocol_program @ HookError::EscrowArmMismatch)]
    pub protocol_program: UncheckedAccount<'info>,
    /// CHECK: the protocol's `EscrowArm` PDA for this mint; validated in `read_arm`.
    pub escrow_arm: UncheckedAccount<'info>,
}
