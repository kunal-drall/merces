//! No-op Token-2022 transfer hook used by the **mock USDG** mint in tests and on devnet
//! (ASSUMPTIONS A24). It exists so the protocol's stablecoin paths exercise real transfer-hook
//! account resolution. It never rejects a transfer and holds no state beyond the empty
//! `ExtraAccountMetaList` that Token-2022 requires.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, Token2022};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::{
    ExecuteInstruction, InitializeExtraAccountMetaListInstruction,
};

declare_id!("ALQgHjCyfNAtP5mWxYny5i2eW61pK6etSC8Vx6PpgHhA");

pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

#[program]
pub mod mock_usdg_hook {
    use super::*;

    /// Creates an empty `ExtraAccountMetaList` for `mint`. Anyone may call it (the mock mint has
    /// no privileged owner), and it can only be created once per mint.
    #[instruction(discriminator = InitializeExtraAccountMetaListInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &[])?;
        Ok(())
    }

    /// Always allows the transfer.
    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn execute(_ctx: Context<Execute>, _amount: u64) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PDA owned by this program, created here with the fixed interface seeds.
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(0).unwrap(),
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(token::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: source token account, validated by Token-2022.
    pub source_token: UncheckedAccount<'info>,
    /// CHECK: the mint, validated by Token-2022.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: destination token account, validated by Token-2022.
    pub destination_token: UncheckedAccount<'info>,
    /// CHECK: transfer authority, validated by Token-2022.
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the ExtraAccountMetaList PDA for this mint.
    #[account(seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
}
