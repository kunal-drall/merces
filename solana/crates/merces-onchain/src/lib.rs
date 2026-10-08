//! Solana-side helpers shared by `merces_registry`, `merces_hook` and `merces_protocol`.
//!
//! Everything here is thin glue over syscalls and the SPL crates; the money math stays in
//! `merces-common`.
#![forbid(unsafe_code)]
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::account_info::AccountInfo;
use anchor_spl::token_interface::spl_token_2022::extension::{
    transfer_fee::TransferFeeConfig, BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_interface::spl_token_2022::state::Mint as MintState;
use merces_common::encoding::parse_signature;

/// PDA seeds shared between programs.
pub mod seeds {
    /// `merces_protocol`: window escrow authority, `[WINDOW_ESCROW, series]` (owner of the window
    /// escrow ATAs).
    pub const WINDOW_ESCROW: &[u8] = b"window_escrow";
    /// `merces_protocol`: auction escrow authority, `[AUCTION_ESCROW, series]` (owner of the
    /// auction unit escrow ATA that holds minted-but-undelivered units).
    pub const AUCTION_ESCROW: &[u8] = b"auction_escrow";
    /// `merces_protocol`: `[ESCROW_ARM, unit_mint]` — armed `commit_ask` deposit (SPEC §4.1).
    pub const ESCROW_ARM: &[u8] = b"escrow_arm";
    /// `merces_protocol`: the signer PDA for the registry's narrow write interface,
    /// `[REGISTRY_AUTHORITY]` (SPEC §3.2 `registry_authority`).
    pub const REGISTRY_AUTHORITY: &[u8] = b"registry_authority";
    /// `merces_registry`: `[CONFIG]`.
    pub const CONFIG: &[u8] = b"config";
    /// `merces_registry`: `[SERIES, series_id_le_u64]`.
    pub const SERIES: &[u8] = b"series";
    /// `merces_registry`: `[ALLOW, wallet]`.
    pub const ALLOW: &[u8] = b"allow";
    /// `merces_registry`: `[ISSUER, wallet]`.
    pub const ISSUER: &[u8] = b"issuer";
    /// `merces_registry`: `[ATTESTOR, addr20]`.
    pub const ATTESTOR: &[u8] = b"attestor";
    /// `merces_registry`: `[VERIFIER, addr20]`.
    pub const VERIFIER: &[u8] = b"verifier";
    /// `merces_registry`: `[FX, pair_id]`.
    pub const FX: &[u8] = b"fx";
}

/// `keccak256` of the concatenation of `parts`.
pub fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    solana_keccak_hasher::hashv(parts).to_bytes()
}

/// A `u64` as a 32-byte big-endian BN254 field element.
pub fn u64_field(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&v.to_be_bytes());
    out
}

/// `Poseidon(2)(a, b)` over BN254 (circomlib parameters) via the `sol_poseidon` syscall; inputs and
/// output are 32-byte big-endian field elements.
#[allow(deprecated)]
pub fn poseidon2(a: &[u8; 32], b: &[u8; 32]) -> Result<[u8; 32]> {
    let h = solana_poseidon::hashv(
        solana_poseidon::Parameters::Bn254X5,
        solana_poseidon::Endianness::BigEndian,
        &[a, b],
    )
    .map_err(|_| error!(HelperError::PoseidonFailed))?;
    Ok(h.to_bytes())
}

/// `Poseidon(5)(a, b, c, d, e)` over BN254 via the `sol_poseidon` syscall.
#[allow(deprecated)]
pub fn poseidon5(inputs: &[[u8; 32]; 5]) -> Result<[u8; 32]> {
    let refs: [&[u8]; 5] = [&inputs[0], &inputs[1], &inputs[2], &inputs[3], &inputs[4]];
    let h = solana_poseidon::hashv(
        solana_poseidon::Parameters::Bn254X5,
        solana_poseidon::Endianness::BigEndian,
        &refs,
    )
    .map_err(|_| error!(HelperError::PoseidonFailed))?;
    Ok(h.to_bytes())
}

/// Failure modes of [`recover_eth_address`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigError {
    /// Wrong length, `v ∉ {27, 28}`, high-`s`, or zero `r`/`s`.
    Malformed,
    /// The syscall rejected the signature.
    RecoveryFailed,
}

/// Recovers the 20-byte Ethereum-style address of the secp256k1 key that signed `msg_hash`
/// with the 65-byte `(r, s, v)` signature (SPEC §1.4).
pub fn recover_eth_address(
    msg_hash: &[u8; 32],
    sig: &[u8],
) -> core::result::Result<[u8; 20], SigError> {
    let (rs, recovery_id) = parse_signature(sig).ok_or(SigError::Malformed)?;
    let pubkey = solana_secp256k1_recover::secp256k1_recover(msg_hash, recovery_id, &rs)
        .map_err(|_| SigError::RecoveryFailed)?;
    let hash = keccak(&[&pubkey.to_bytes()]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..32]);
    Ok(addr)
}

/// Failure modes of [`assert_zero_transfer_fee`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeCheckError {
    /// The mint data could not be unpacked.
    InvalidMint,
    /// A `TransferFeeConfig` extension exists with a non-zero fee or maximum (SPEC §5.3).
    TransferFeeNotZero,
}

/// For Token-2022 mints: if a `TransferFeeConfig` extension exists, both the older and the newer
/// fee must be `0 bps / 0 maximum`. Classic SPL mints trivially pass.
pub fn assert_zero_transfer_fee(mint: &AccountInfo) -> core::result::Result<(), FeeCheckError> {
    if *mint.owner != anchor_spl::token_2022::ID {
        return Ok(());
    }
    let data = mint
        .try_borrow_data()
        .map_err(|_| FeeCheckError::InvalidMint)?;
    let state =
        StateWithExtensions::<MintState>::unpack(&data).map_err(|_| FeeCheckError::InvalidMint)?;
    if let Ok(cfg) = state.get_extension::<TransferFeeConfig>() {
        for fee in [&cfg.older_transfer_fee, &cfg.newer_transfer_fee] {
            if u16::from(fee.transfer_fee_basis_points) != 0 || u64::from(fee.maximum_fee) != 0 {
                return Err(FeeCheckError::TransferFeeNotZero);
            }
        }
    }
    Ok(())
}

/// Accounts for one hook-aware `transfer_checked`.
pub struct TransferAccounts<'a, 'info> {
    pub token_program: &'a AccountInfo<'info>,
    pub source: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
    pub destination: &'a AccountInfo<'info>,
    pub authority: &'a AccountInfo<'info>,
    /// Remaining accounts supplied by the caller for transfer-hook resolution.
    pub extra: &'a [AccountInfo<'info>],
}

/// `transfer_checked` through the mint's own token program, resolving transfer-hook extra accounts
/// via `spl_token_2022::onchain` for Token-2022 mints and asserting the transfer fee is zero
/// (SPEC §5.3). `amount == 0` is a no-op (SPEC §1.1 zero-amount rule).
pub fn transfer_checked_hooked<'info>(
    accounts: TransferAccounts<'_, 'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    require_keys_eq!(
        *accounts.mint.owner,
        *accounts.token_program.key,
        HelperError::TokenProgramMismatch
    );
    assert_zero_transfer_fee(accounts.mint).map_err(|e| match e {
        FeeCheckError::InvalidMint => error!(HelperError::InvalidMint),
        FeeCheckError::TransferFeeNotZero => error!(HelperError::TransferFeeNotZero),
    })?;
    spl_token_2022::onchain::invoke_transfer_checked(
        accounts.token_program.key,
        accounts.source.clone(),
        accounts.mint.clone(),
        accounts.destination.clone(),
        accounts.authority.clone(),
        accounts.extra,
        amount,
        decimals,
        signer_seeds,
    )
    .map_err(Into::into)
}

/// Errors raised by the helpers.
#[error_code]
pub enum HelperError {
    #[msg("The token program is not the mint's owner")]
    TokenProgramMismatch = 7000,
    #[msg("The stablecoin mint has a non-zero transfer fee configured")]
    TransferFeeNotZero,
    #[msg("The mint account could not be unpacked")]
    InvalidMint,
    #[msg("Poseidon syscall failed (input not a canonical field element)")]
    PoseidonFailed,
}

/// Reads `mint.supply`.
pub fn mint_supply(mint: &AccountInfo) -> Result<u64> {
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)
        .map_err(|_| error!(HelperError::InvalidMint))?;
    Ok(state.base.supply)
}

/// Reads `mint.decimals`.
pub fn mint_decimals(mint: &AccountInfo) -> Result<u8> {
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)
        .map_err(|_| error!(HelperError::InvalidMint))?;
    Ok(state.base.decimals)
}

/// Owner (wallet) and amount of a token account, read from the base layout
/// (`owner` at bytes 32..64, `amount` at 64..72), valid for SPL Token and Token-2022 accounts.
pub fn token_account_owner_and_amount(acc: &AccountInfo) -> Result<(Pubkey, u64)> {
    let data = acc.try_borrow_data()?;
    if data.len() < 72 {
        return Err(error!(HelperError::InvalidMint));
    }
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&data[32..64]);
    let mut amount = [0u8; 8];
    amount.copy_from_slice(&data[64..72]);
    Ok((Pubkey::new_from_array(owner), u64::from_le_bytes(amount)))
}
