//! Curve mode (SPEC §9, `docs/meteora/CURVE_MODE.md`): a series whose primary sale runs on a
//! Meteora Dynamic Bonding Curve (DBC) pool instead of the sealed-bid auction.
//!
//! Lifecycle: `prepare_curve` (ledger, treasury, vault) → `activate_curve` (validates the DBC
//! config, pool and base mint, fixes `P0`, registry Draft → Open) → buyers trade on the DBC pool →
//! `complete_curve` (observes `quote_reserve ≥ migration_quote_threshold`, registry Open →
//! Settled at `finish_curve_timestamp`, mint final) → `collect_curve_proceeds` (DBC migration fee
//! and surplus into the treasury under the D4 schedule, partner trading fee into the fee
//! collector) → `sync_curve_units` before reports → repayment exactly as in sealed-bid mode.
//!
//! Units: the base mint has 6 decimals and no hook, freeze authority or permanent delegate, so
//! units move freely after graduation. The accounting unit is the base lamport (`unit_scale =
//! 10^6`); `units_outstanding = supply − protocol-held` (DAMM v2 pool vault, DBC base vault,
//! locker escrow, leftover receiver). Claims are gated: only allowlisted, registered holders earn,
//! and only for units they **stake** in the series stake vault (`stake_units` / `unstake_units`,
//! debt pattern: every stake change settles first). Reading wallet balances instead (CURVE_MODE §5
//! as written) would let the same units be counted by two wallets and paid twice
//! (`merces_common` test `balance_reading_scheme_double_pays`).
//!
//! Redemption is by tender: `redeem` snapshots `units_outstanding` and deposits `P_redeem × units /
//! 10^6`; holders `tender_units` from their stake (reserved) or wallet (shared quota) and the
//! tendered units are burned by their owner's authority (the stake vault's PDA or the holder's
//! signature): the base mint has no permanent delegate. At the cap, claims end and the series
//! retires without any burn.
//!
//! Every DBC / DAMM v2 / locker account is read through the byte layouts of the program sources
//! cited below (`PROG` = `dynamic-bonding-curve/programs/dynamic-bonding-curve/src`, program 0.2.1).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, AssociatedToken};
use anchor_spl::token_interface::{self as ti, Mint, Token2022, TokenAccount, TokenInterface};
use merces_common::curve::{
    migration_fee_split, p0_per_unit, swap_base_matches_offer, units_outstanding,
    wallet_tender_fits, CURVE_BASE_DECIMALS, CURVE_UNIT_SCALE,
};
use merces_common::time::period_end;
use merces_common::vault::scaled_amount;
use merces_onchain::seeds::{ALLOW, CONFIG};
use merces_registry::program::MercesRegistry;
use merces_registry::state::{
    AllowlistEntry, ProtocolConfig, Series, MODE_CURVE, RAISE_DRAFT, RAISE_OPEN, RAISE_SETTLED,
};
use spl_token_2022::extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions};

use crate::common::*;
use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::state::*;

// ------------------------------------------------------------------------------ external ids

/// Meteora DBC program (PROG/lib.rs:29; identical on every cluster).
pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// DBC pool authority, `PDA([b"pool_authority"], DBC)` (PROG/const_pda.rs:4-14).
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// DBC Anchor event authority, `PDA([b"__event_authority"], DBC)` (`#[event_cpi]` accounts).
pub const DBC_EVENT_AUTHORITY: Pubkey = pubkey!("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
/// Meteora DAMM v2 (`cp_amm`) program, the graduation target.
pub const DAMM_V2_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// Jupiter locker program used by DBC's `create_locker`.
pub const LOCKER_PROGRAM_ID: Pubkey = pubkey!("LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn");

/// Anchor discriminators (`sha256("account:<Name>")[..8]`, `sha256("global:<ix>")[..8]`).
pub mod disc {
    pub const POOL_CONFIG: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];
    pub const VIRTUAL_POOL: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
    pub const DAMM_CONFIG: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];
    pub const DAMM_POOL: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
    pub const WITHDRAW_MIGRATION_FEE: [u8; 8] = [237, 142, 45, 23, 129, 6, 222, 162];
    pub const CLAIM_TRADING_FEE: [u8; 8] = [8, 236, 89, 49, 152, 125, 177, 81];
    pub const PARTNER_WITHDRAW_SURPLUS: [u8; 8] = [168, 173, 72, 100, 201, 98, 38, 92];
    pub const CREATOR_WITHDRAW_SURPLUS: [u8; 8] = [165, 3, 137, 7, 28, 134, 76, 80];
}

/// Byte offsets (8-byte discriminator included) of `PoolConfig` (PROG/state/config.rs:498-588,
/// `#[account(zero_copy)]`, 1040 + 8 bytes) and `VirtualPool` / `PoolState`
/// (PROG/state/virtual_pool.rs:90-160, 416 + 8 bytes), and of the DAMM v2 `Config`
/// (`idls/damm_v2.json`, bytemuck).
pub mod layout {
    pub const POOL_CONFIG_LEN: usize = 8 + 1040;
    pub const CFG_QUOTE_MINT: usize = 8;
    pub const CFG_FEE_CLAIMER: usize = 40;
    pub const CFG_LEFTOVER_RECEIVER: usize = 72;
    /// `creator_liquidity_vesting_info.vesting_percentage` (struct at 192, field +1).
    pub const CFG_CREATOR_LIQ_VESTING_PCT: usize = 8 + 192 + 1;
    pub const CFG_MIGRATION_OPTION: usize = 8 + 225;
    pub const CFG_TOKEN_DECIMAL: usize = 8 + 227;
    pub const CFG_TOKEN_TYPE: usize = 8 + 229;
    pub const CFG_QUOTE_TOKEN_FLAG: usize = 8 + 230;
    pub const CFG_CREATOR_LIQ_PCT: usize = 8 + 234;
    pub const CFG_FIXED_SUPPLY_FLAG: usize = 8 + 236;
    pub const CFG_MIGRATION_FEE_PCT: usize = 8 + 239;
    pub const CFG_CREATOR_MIGRATION_FEE_PCT: usize = 8 + 240;
    pub const CFG_SWAP_BASE_AMOUNT: usize = 8 + 248;
    pub const CFG_MIGRATION_QUOTE_THRESHOLD: usize = 8 + 256;
    pub const CFG_MIGRATION_BASE_THRESHOLD: usize = 8 + 264;
    /// `locked_vesting_config`: five `u64` + padding (PROG/state/config.rs:336-343).
    pub const CFG_LOCKED_VESTING: usize = 8 + 288;

    pub const VIRTUAL_POOL_LEN: usize = 8 + 416;
    pub const POOL_CONFIG: usize = 8 + 64;
    pub const POOL_CREATOR: usize = 8 + 96;
    pub const POOL_BASE_MINT: usize = 8 + 128;
    pub const POOL_BASE_VAULT: usize = 8 + 160;
    pub const POOL_QUOTE_VAULT: usize = 8 + 192;
    pub const POOL_QUOTE_RESERVE: usize = 8 + 232;
    pub const POOL_PARTNER_QUOTE_FEE: usize = 8 + 264;
    pub const POOL_IS_PARTNER_WITHDRAW_SURPLUS: usize = 8 + 298;
    pub const POOL_MIGRATION_PROGRESS: usize = 8 + 300;
    pub const POOL_IS_CREATOR_WITHDRAW_SURPLUS: usize = 8 + 302;
    pub const POOL_MIGRATION_FEE_WITHDRAW_STATUS: usize = 8 + 303;
    pub const POOL_FINISH_CURVE_TIMESTAMP: usize = 8 + 336;

    pub const DAMM_CONFIG_MIN_LEN: usize = 8 + 64;
    pub const DAMM_CFG_POOL_CREATOR_AUTHORITY: usize = 8 + 32;
}

/// `MigrationProgress::CreatedPool` (PROG/state/virtual_pool.rs:66-88): migrated to DAMM v2.
pub const MIGRATION_PROGRESS_CREATED_POOL: u8 = 3;
/// `migration_fee_withdraw_status` bits (PROG/state/virtual_pool.rs:206-207).
pub const PARTNER_MIGRATION_FEE_MASK: u8 = 0b100;
pub const CREATOR_MIGRATION_FEE_MASK: u8 = 0b010;

fn pk_at(d: &[u8], off: usize) -> Pubkey {
    let mut b = [0u8; 32];
    b.copy_from_slice(&d[off..off + 32]);
    Pubkey::new_from_array(b)
}
fn u64_at(d: &[u8], off: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[off..off + 8]);
    u64::from_le_bytes(b)
}

// ---------------------------------------------------------------------------------- readers

/// The `PoolConfig` fields Merces checks.
#[derive(Clone, Copy, Debug)]
pub struct DbcConfigView {
    pub quote_mint: Pubkey,
    pub fee_claimer: Pubkey,
    pub leftover_receiver: Pubkey,
    pub migration_option: u8,
    pub token_decimal: u8,
    pub token_type: u8,
    pub quote_token_flag: u8,
    pub creator_liquidity_percentage: u8,
    pub creator_liquidity_vesting_percentage: u8,
    pub fixed_token_supply_flag: u8,
    pub migration_fee_percentage: u8,
    pub creator_migration_fee_percentage: u8,
    pub swap_base_amount: u64,
    pub migration_quote_threshold: u64,
    pub migration_base_threshold: u64,
    pub has_locked_vesting: bool,
}

/// Reads a DBC `PoolConfig` (owner = DBC, `PoolConfig` discriminator, full size). The
/// transfer-hook variant (`ConfigWithTransferHook`) has another discriminator and is refused.
pub fn read_dbc_config(info: &AccountInfo) -> Result<DbcConfigView> {
    use layout::*;
    require_keys_eq!(
        *info.owner,
        DBC_PROGRAM_ID,
        ProtocolError::DbcAccountInvalid
    );
    let d = info.try_borrow_data()?;
    require!(
        d.len() >= POOL_CONFIG_LEN && d[..8] == disc::POOL_CONFIG,
        ProtocolError::DbcAccountInvalid
    );
    let lv = &d[CFG_LOCKED_VESTING..CFG_LOCKED_VESTING + 40];
    Ok(DbcConfigView {
        quote_mint: pk_at(&d, CFG_QUOTE_MINT),
        fee_claimer: pk_at(&d, CFG_FEE_CLAIMER),
        leftover_receiver: pk_at(&d, CFG_LEFTOVER_RECEIVER),
        migration_option: d[CFG_MIGRATION_OPTION],
        token_decimal: d[CFG_TOKEN_DECIMAL],
        token_type: d[CFG_TOKEN_TYPE],
        quote_token_flag: d[CFG_QUOTE_TOKEN_FLAG],
        creator_liquidity_percentage: d[CFG_CREATOR_LIQ_PCT],
        creator_liquidity_vesting_percentage: d[CFG_CREATOR_LIQ_VESTING_PCT],
        fixed_token_supply_flag: d[CFG_FIXED_SUPPLY_FLAG],
        migration_fee_percentage: d[CFG_MIGRATION_FEE_PCT],
        creator_migration_fee_percentage: d[CFG_CREATOR_MIGRATION_FEE_PCT],
        swap_base_amount: u64_at(&d, CFG_SWAP_BASE_AMOUNT),
        migration_quote_threshold: u64_at(&d, CFG_MIGRATION_QUOTE_THRESHOLD),
        migration_base_threshold: u64_at(&d, CFG_MIGRATION_BASE_THRESHOLD),
        has_locked_vesting: lv.iter().any(|b| *b != 0),
    })
}

/// The `VirtualPool` fields Merces reads.
#[derive(Clone, Copy, Debug)]
pub struct DbcPoolView {
    pub config: Pubkey,
    pub creator: Pubkey,
    pub base_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub quote_reserve: u64,
    pub partner_quote_fee: u64,
    pub is_partner_withdraw_surplus: bool,
    pub is_creator_withdraw_surplus: bool,
    pub migration_progress: u8,
    pub migration_fee_withdraw_status: u8,
    pub finish_curve_timestamp: u64,
}

/// Reads a DBC `VirtualPool` (owner = DBC, `VirtualPool` discriminator, full size). The
/// transfer-hook pool (`TransferHookPool`) is refused.
pub fn read_dbc_pool(info: &AccountInfo) -> Result<DbcPoolView> {
    use layout::*;
    require_keys_eq!(
        *info.owner,
        DBC_PROGRAM_ID,
        ProtocolError::DbcAccountInvalid
    );
    let d = info.try_borrow_data()?;
    require!(
        d.len() >= VIRTUAL_POOL_LEN && d[..8] == disc::VIRTUAL_POOL,
        ProtocolError::DbcAccountInvalid
    );
    Ok(DbcPoolView {
        config: pk_at(&d, POOL_CONFIG),
        creator: pk_at(&d, POOL_CREATOR),
        base_mint: pk_at(&d, POOL_BASE_MINT),
        base_vault: pk_at(&d, POOL_BASE_VAULT),
        quote_vault: pk_at(&d, POOL_QUOTE_VAULT),
        quote_reserve: u64_at(&d, POOL_QUOTE_RESERVE),
        partner_quote_fee: u64_at(&d, POOL_PARTNER_QUOTE_FEE),
        is_partner_withdraw_surplus: d[POOL_IS_PARTNER_WITHDRAW_SURPLUS] != 0,
        is_creator_withdraw_surplus: d[POOL_IS_CREATOR_WITHDRAW_SURPLUS] != 0,
        migration_progress: d[POOL_MIGRATION_PROGRESS],
        migration_fee_withdraw_status: d[POOL_MIGRATION_FEE_WITHDRAW_STATUS],
        finish_curve_timestamp: u64_at(&d, POOL_FINISH_CURVE_TIMESTAMP),
    })
}

/// The series' DBC config and pool, both checked against the registry record.
fn series_dbc(
    series: &Series,
    config: &AccountInfo,
    pool: &AccountInfo,
) -> Result<(DbcConfigView, DbcPoolView)> {
    require_keys_eq!(
        *config.key,
        series.dbc_config,
        ProtocolError::DbcPoolMismatch
    );
    require_keys_eq!(*pool.key, series.dbc_pool, ProtocolError::DbcPoolMismatch);
    let c = read_dbc_config(config)?;
    let p = read_dbc_pool(pool)?;
    require_keys_eq!(p.config, *config.key, ProtocolError::DbcPoolMismatch);
    Ok((c, p))
}

/// The `curve_authority` PDA of a series (DBC `fee_claimer` / `leftover_receiver`).
pub fn curve_authority_of(series: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seeds::CURVE_AUTHORITY, series.as_ref()], &crate::ID)
}

/// Token amount of an account that may not exist: 0 when uninitialised; otherwise it must be a
/// Token-2022 account of `mint`.
fn optional_token_amount(info: &AccountInfo, mint: &Pubkey) -> Result<u64> {
    if info.data_is_empty() {
        return Ok(0);
    }
    require_keys_eq!(
        *info.owner,
        anchor_spl::token_2022::ID,
        ProtocolError::TokenProgramMismatch
    );
    let d = info.try_borrow_data()?;
    require!(d.len() >= 72, ProtocolError::CurveTokenAccountInvalid);
    require_keys_eq!(pk_at(&d, 0), *mint, ProtocolError::CurveTokenAccountInvalid);
    Ok(u64_at(&d, 64))
}

// ------------------------------------------------------------------------- units outstanding

/// The accounts that hold protocol-held base lamports (CURVE_MODE §4), in this order — also the
/// remaining-account order of a curve-mode `redeem`.
pub struct CurveUnitAccounts<'a, 'info> {
    pub base_mint: &'a AccountInfo<'info>,
    pub dbc_pool: &'a AccountInfo<'info>,
    pub dbc_base_vault: &'a AccountInfo<'info>,
    pub damm_config: &'a AccountInfo<'info>,
    pub damm_pool: &'a AccountInfo<'info>,
    pub damm_base_vault: &'a AccountInfo<'info>,
    pub locker_escrow_token: &'a AccountInfo<'info>,
    pub leftover_token: &'a AccountInfo<'info>,
}

pub const CURVE_UNIT_ACCOUNTS: usize = 8;

impl<'a, 'info> CurveUnitAccounts<'a, 'info> {
    pub fn from_slice(accs: &'a [AccountInfo<'info>]) -> Result<Self> {
        require!(
            accs.len() >= CURVE_UNIT_ACCOUNTS,
            ProtocolError::CurveAccountsMissing
        );
        Ok(Self {
            base_mint: &accs[0],
            dbc_pool: &accs[1],
            dbc_base_vault: &accs[2],
            damm_config: &accs[3],
            damm_pool: &accs[4],
            damm_base_vault: &accs[5],
            locker_escrow_token: &accs[6],
            leftover_token: &accs[7],
        })
    }
}

/// One snapshot of the base-lamport census.
#[derive(Clone, Copy, Debug)]
pub struct CurveUnits {
    pub supply: u64,
    pub protocol_held: u64,
    pub outstanding: u64,
}

/// `units_outstanding = supply − (DBC base vault + DAMM v2 base vault + locker escrow + leftover)`
/// with every account address derived on-chain (CURVE_MODE §4):
/// - DBC base vault = `pool.base_vault`;
/// - DAMM v2 pool = `PDA([b"pool", cfg, max(mints), min(mints)], cp_amm)` for a `cfg` owned by
///   `cp_amm` whose `pool_creator_authority` is the DBC pool authority (only DBC migrations can
///   create pools under such configs); once the DBC pool reports `CreatedPool` the pool must
///   exist, so the migrated pool's vault cannot be left out; its base vault =
///   `PDA([b"token_vault", base_mint, pool], cp_amm)`;
/// - locker escrow = `ATA(PDA([b"escrow", PDA([b"base_locker", dbc_pool], DBC)], locker), base_mint)`;
/// - leftover = `ATA(curve_authority, base_mint)`.
///
/// Accounts that do not exist yet count 0. The stake vault is not protocol-held: staked units are
/// the holders'. The result never falls below the staked total.
///
/// `exclude_damm_pool` drops the DAMM v2 base vault from the subtraction (S2, B-C13): at
/// **redemption** the deposit must cover every tenderable unit, but the pool's base vault is an AMM
/// balance the issuer can inflate in one transaction (swap base in → redeem → swap out) to deflate
/// the count and under-deposit. Because base is conserved (`supply = wallets + pool + dbc + locker
/// + leftover`), not subtracting the pool makes the count `wallets + pool`, an upper bound on what
/// holders can tender (wallets + stake) that the issuer can only *raise* by parking base (which
/// raises their own deposit), never lower. The pool's locked-LP share is never tendered and stays
/// as vault dust (C2). The honest over-count is the real pool base (≈ `migration_base_threshold`,
/// « `swap_base_amount` by construction). The regular `sync_curve_units` keeps the full census
/// (`exclude_damm_pool = false`): there `units_outstanding` cancels in the per-unit income math.
pub fn compute_curve_units(
    series: &Series,
    ledger: &Ledger,
    a: &CurveUnitAccounts<'_, '_>,
    exclude_damm_pool: bool,
) -> Result<CurveUnits> {
    let base_mint = series.base_mint;
    require_keys_eq!(*a.base_mint.key, base_mint, ProtocolError::UnitMintMismatch);
    require_keys_eq!(
        *a.dbc_pool.key,
        series.dbc_pool,
        ProtocolError::DbcPoolMismatch
    );
    let pool = read_dbc_pool(a.dbc_pool)?;
    let supply = {
        require_keys_eq!(
            *a.base_mint.owner,
            anchor_spl::token_2022::ID,
            ProtocolError::TokenProgramMismatch
        );
        let d = a.base_mint.try_borrow_data()?;
        require!(d.len() >= 44, ProtocolError::InvalidMint);
        u64_at(&d, 36)
    };
    // DBC base vault (unsold base, migration deposit until migration, fee buckets)
    require_keys_eq!(
        *a.dbc_base_vault.key,
        pool.base_vault,
        ProtocolError::DbcVaultMismatch
    );
    let dbc_vault = optional_token_amount(a.dbc_base_vault, &base_mint)?;
    // DAMM v2 graduated pool
    {
        require_keys_eq!(
            *a.damm_config.owner,
            DAMM_V2_PROGRAM_ID,
            ProtocolError::DammConfigInvalid
        );
        let d = a.damm_config.try_borrow_data()?;
        require!(
            d.len() >= layout::DAMM_CONFIG_MIN_LEN && d[..8] == disc::DAMM_CONFIG,
            ProtocolError::DammConfigInvalid
        );
        require_keys_eq!(
            pk_at(&d, layout::DAMM_CFG_POOL_CREATOR_AUTHORITY),
            DBC_POOL_AUTHORITY,
            ProtocolError::DammConfigInvalid
        );
    }
    let quote = series.stablecoin;
    let (hi, lo) = if base_mint > quote {
        (base_mint, quote)
    } else {
        (quote, base_mint)
    };
    let (damm_pool, _) = Pubkey::find_program_address(
        &[
            b"pool",
            a.damm_config.key.as_ref(),
            hi.as_ref(),
            lo.as_ref(),
        ],
        &DAMM_V2_PROGRAM_ID,
    );
    require_keys_eq!(*a.damm_pool.key, damm_pool, ProtocolError::DammPoolMismatch);
    let pool_exists = !a.damm_pool.data_is_empty();
    if pool_exists {
        require_keys_eq!(
            *a.damm_pool.owner,
            DAMM_V2_PROGRAM_ID,
            ProtocolError::DammPoolMismatch
        );
        let d = a.damm_pool.try_borrow_data()?;
        require!(
            d.len() >= 8 && d[..8] == disc::DAMM_POOL,
            ProtocolError::DammPoolMismatch
        );
    } else {
        require!(
            pool.migration_progress != MIGRATION_PROGRESS_CREATED_POOL,
            ProtocolError::DammPoolMissing
        );
    }
    let (damm_vault_key, _) = Pubkey::find_program_address(
        &[b"token_vault", base_mint.as_ref(), damm_pool.as_ref()],
        &DAMM_V2_PROGRAM_ID,
    );
    require_keys_eq!(
        *a.damm_base_vault.key,
        damm_vault_key,
        ProtocolError::DammVaultMismatch
    );
    let damm_vault = optional_token_amount(a.damm_base_vault, &base_mint)?;
    // Jupiter-locker escrow of the issuer allocation (vesting from finish_curve_timestamp)
    let (locker_base, _) =
        Pubkey::find_program_address(&[b"base_locker", series.dbc_pool.as_ref()], &DBC_PROGRAM_ID);
    let (escrow, _) =
        Pubkey::find_program_address(&[b"escrow", locker_base.as_ref()], &LOCKER_PROGRAM_ID);
    let escrow_token = get_associated_token_address_with_program_id(
        &escrow,
        &base_mint,
        &anchor_spl::token_2022::ID,
    );
    require_keys_eq!(
        *a.locker_escrow_token.key,
        escrow_token,
        ProtocolError::LockerEscrowMismatch
    );
    let locker = optional_token_amount(a.locker_escrow_token, &base_mint)?;
    // leftover receiver (base dust after migration) = the series curve_authority
    let (curve_authority, _) = curve_authority_of(&ledger.series);
    let leftover_key = get_associated_token_address_with_program_id(
        &curve_authority,
        &base_mint,
        &anchor_spl::token_2022::ID,
    );
    require_keys_eq!(
        *a.leftover_token.key,
        leftover_key,
        ProtocolError::LeftoverAccountMismatch
    );
    let leftover = optional_token_amount(a.leftover_token, &base_mint)?;
    // S2 / B-C13: the pool's base vault is excluded at redemption (not subtracted) so the issuer
    // cannot deflate the tenderable count by transiently parking base in the pool.
    let counted_damm = if exclude_damm_pool { 0 } else { damm_vault };
    let held = [dbc_vault, counted_damm, locker, leftover];
    let outstanding = units_outstanding(supply, &held)
        .map_err(|_| error!(ProtocolError::CurveUnitsInconsistent))?;
    require!(
        outstanding >= ledger.staked_total,
        ProtocolError::CurveUnitsBelowStake
    );
    Ok(CurveUnits {
        supply,
        protocol_held: supply
            .checked_sub(outstanding)
            .ok_or(ProtocolError::MathOverflow)?,
        outstanding,
    })
}

/// Stores a census in the ledger and emits `CurveUnitsSynced`.
pub fn store_curve_units(
    ledger: &mut Ledger,
    u: CurveUnits,
    now: u64,
    series_key: Pubkey,
) -> Result<()> {
    ledger.units_outstanding = u.outstanding;
    ledger.units_synced_at = now;
    emit!(CurveUnitsSynced {
        series: series_key,
        supply: u.supply,
        protocol_held: u.protocol_held,
        units_outstanding: u.outstanding,
        staked_total: ledger.staked_total,
    });
    Ok(())
}

// ---------------------------------------------------------------------------- holder accounting

/// Curve-mode holder settlement (debt pattern): credits the staked weight's share of the regular
/// accumulator and — for a series that was not redeemed — of the final (extinguishment) one, and
/// moves both snapshots forward. Every stake change, claim and tender calls it first, so a holder
/// is paid exactly for the receipts that happened while its units were staked.
pub fn settle_curve_holder(ledger: &Ledger, holder: &mut Holder) -> Result<()> {
    use merces_common::vault::holder_delta;
    require!(holder.registered, ProtocolError::HolderNotRegistered);
    let w = holder.staked_units;
    let d = holder_delta(ledger.net_acc_wad, holder.last_net_acc_wad, w).map_err(math)?;
    holder.pending = holder
        .pending
        .checked_add(d)
        .ok_or(ProtocolError::MathOverflow)?;
    holder.last_net_acc_wad = ledger.net_acc_wad;
    if ledger.redemption_ts == 0 {
        let f = holder_delta(ledger.final_acc_wad, holder.last_final_acc_wad, w).map_err(math)?;
        holder.pending = holder
            .pending
            .checked_add(f)
            .ok_or(ProtocolError::MathOverflow)?;
        holder.last_final_acc_wad = ledger.final_acc_wad;
    }
    Ok(())
}

fn transfer_base<'info>(
    token_2022: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    ti::transfer_checked(
        CpiContext::new_with_signer(
            *token_2022.key,
            ti::TransferChecked {
                from: from.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: authority.clone(),
            },
            signer,
        ),
        amount,
        CURVE_BASE_DECIMALS,
    )
}

fn burn_base<'info>(
    token_2022: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    ti::burn(
        CpiContext::new_with_signer(
            *token_2022.key,
            ti::Burn {
                mint: mint.clone(),
                from: from.clone(),
                authority: authority.clone(),
            },
            signer,
        ),
        amount,
    )
}

// ---------------------------------------------------------------------------- prepare_curve

#[derive(Accounts)]
pub struct PrepareCurve<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    /// CHECK: data-less signer PDA, vault owner.
    #[account(seeds = [seeds::VAULT_AUTH, series.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA, treasury owner.
    #[account(seeds = [seeds::TREASURY_AUTH, series.key().as_ref()], bump)]
    pub treasury_auth: UncheckedAccount<'info>,
    #[account(init, payer = issuer, space = 8 + Treasury::INIT_SPACE, seeds = [seeds::TREASURY, series.key().as_ref()], bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(init, payer = issuer, space = Ledger::LEN, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
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

/// `prepare_curve` (issuer, Draft): creates the curve series' ledger (base-lamport accounting),
/// treasury and stablecoin accounts. No auction, escrow or window accounts exist in curve mode.
pub fn prepare_curve(ctx: Context<PrepareCurve>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_init()?;
    let series = &ctx.accounts.series;
    require!(series.mode == MODE_CURVE, ProtocolError::NotCurveMode);
    require!(series.raise_state == RAISE_DRAFT, ProtocolError::NotDraft);
    let series_key = series.key();
    let t = &mut ctx.accounts.treasury;
    t.series = series_key;
    t.bump = ctx.bumps.treasury;
    ledger.series = series_key;
    ledger.unit_scale = CURVE_UNIT_SCALE;
    ledger.curve = 1;
    ledger.bump = ctx.bumps.ledger;
    Ok(())
}

// ---------------------------------------------------------------------------- activate_curve

#[derive(Accounts)]
pub struct ActivateCurve<'info> {
    pub issuer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(seeds = [ALLOW, issuer.key().as_ref()], bump = issuer_allowlist.bump, seeds::program = merces_registry::ID)]
    pub issuer_allowlist: Box<Account<'info, AllowlistEntry>>,
    #[account(seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    /// CHECK: the DBC `PoolConfig`; owner, discriminator and every field checked in the handler.
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: the DBC `VirtualPool`; owner, discriminator and every field checked in the handler.
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: the pool's base mint; owner (Token-2022), decimals, authorities and extensions
    /// checked in the handler.
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: data-less PDA: the DBC `fee_claimer` / `leftover_receiver` the config must name.
    #[account(seeds = [seeds::CURVE_AUTHORITY, series.key().as_ref()], bump)]
    pub curve_authority: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_AUTHORITY], bump)]
    pub registry_authority: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
}

/// `activate_curve` (issuer): binds a DBC pool to the series (CURVE_MODE §2) and fixes
/// `P0 = floor(X × 10^6 / swap_base_amount)` (§3). Registry Draft → Open.
///
/// Checks, in order: curve series in Draft with a prepared curve ledger; config and pool owned by
/// the DBC program with the right discriminators, the pool on this config and not yet complete,
/// the pool's base mint; quote
/// mint = series stablecoin = the registry's curve quote mint, with the matching token program;
/// `fee_claimer = leftover_receiver = curve_authority`; DAMM v2 migration; fixed-supply Token-2022
/// base mint with 6 decimals; proceeds cannot bypass the treasury (issuer-creator: no creator
/// migration-fee share and no creator-withdrawable liquidity; curve_authority-creator: no locked
/// issuer allocation); `min_raise = migration_quote_threshold`; `swap_base_amount` sells
/// `units_offered`; base mint without mint/freeze authority and with metadata extensions only.
pub fn activate_curve(ctx: Context<ActivateCurve>) -> Result<()> {
    let ledger = ctx.accounts.ledger.load()?;
    let now = now_ts()?;
    let series = &ctx.accounts.series;
    let series_key = series.key();
    require!(series.mode == MODE_CURVE, ProtocolError::NotCurveMode);
    require!(series.raise_state == RAISE_DRAFT, ProtocolError::NotDraft);
    require!(ledger.is_curve(), ProtocolError::NotCurveMode);
    require_keys_eq!(
        series.stablecoin,
        ctx.accounts.config.curve_quote_mint,
        ProtocolError::DbcQuoteMintMismatch
    );
    let cfg_info = ctx.accounts.dbc_config.to_account_info();
    let pool_info = ctx.accounts.dbc_pool.to_account_info();
    let c = read_dbc_config(&cfg_info)?;
    let p = read_dbc_pool(&pool_info)?;
    require_keys_eq!(p.config, cfg_info.key(), ProtocolError::DbcPoolMismatch);
    // terms are bound while the sale runs: a completed curve can no longer be activated (the
    // issuer cannot wait for the outcome before committing the series)
    require!(
        p.quote_reserve < c.migration_quote_threshold,
        ProtocolError::CurveAlreadyComplete
    );
    let base_mint = ctx.accounts.base_mint.key();
    require_keys_eq!(p.base_mint, base_mint, ProtocolError::DbcPoolMismatch);
    require_keys_eq!(
        c.quote_mint,
        series.stablecoin,
        ProtocolError::DbcQuoteMintMismatch
    );
    let quote_program_ok = match c.quote_token_flag {
        0 => series.stablecoin_program == anchor_spl::token::ID,
        1 => series.stablecoin_program == anchor_spl::token_2022::ID,
        _ => false,
    };
    require!(quote_program_ok, ProtocolError::DbcQuoteProgramMismatch);
    let curve_authority = ctx.accounts.curve_authority.key();
    require!(
        c.fee_claimer == curve_authority && c.leftover_receiver == curve_authority,
        ProtocolError::DbcFeeClaimerMismatch
    );
    require!(
        c.migration_option == 1,
        ProtocolError::DbcMigrationOptionUnsupported
    );
    require!(
        c.token_decimal == CURVE_BASE_DECIMALS
            && c.token_type == 1
            && c.fixed_token_supply_flag == 1,
        ProtocolError::DbcTokenUnsupported
    );
    if p.creator == series.issuer {
        require!(
            c.creator_migration_fee_percentage == 0,
            ProtocolError::CreatorMigrationFeeBypassesTreasury
        );
        require!(
            c.creator_liquidity_percentage == 0 && c.creator_liquidity_vesting_percentage == 0,
            ProtocolError::CreatorLiquidityBypassesTreasury
        );
    } else if p.creator == curve_authority {
        require!(
            !c.has_locked_vesting,
            ProtocolError::CurveCreatorLockedVesting
        );
    } else {
        return Err(ProtocolError::CurveCreatorInvalid.into());
    }
    require!(
        series.min_raise == c.migration_quote_threshold,
        ProtocolError::CurveThresholdMismatch
    );
    require!(
        swap_base_matches_offer(c.swap_base_amount, series.units_offered, c.token_decimal)
            .map_err(math)?,
        ProtocolError::CurveUnitsMismatch
    );
    // the base mint: DBC's Token-2022 mint, metadata only, nobody can mint, freeze or move units
    {
        let info = ctx.accounts.base_mint.to_account_info();
        require_keys_eq!(
            *info.owner,
            anchor_spl::token_2022::ID,
            ProtocolError::TokenProgramMismatch
        );
        let d = info.try_borrow_data()?;
        let m = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&d)
            .map_err(|_| error!(ProtocolError::InvalidMint))?;
        require!(
            m.base.decimals == CURVE_BASE_DECIMALS,
            ProtocolError::DbcTokenUnsupported
        );
        require!(
            m.base.mint_authority.is_none() && m.base.freeze_authority.is_none(),
            ProtocolError::CurveMintAuthority
        );
        let exts = m
            .get_extension_types()
            .map_err(|_| error!(ProtocolError::InvalidMint))?;
        require!(
            exts.iter().all(|e| matches!(
                e,
                ExtensionType::MetadataPointer | ExtensionType::TokenMetadata
            )),
            ProtocolError::CurveMintExtension
        );
    }
    let p0 = p0_per_unit(
        c.migration_quote_threshold,
        c.swap_base_amount,
        c.token_decimal,
    )
    .map_err(math)?;
    require!(p0 >= 1, ProtocolError::CurveThresholdMismatch);
    drop(ledger);
    RegistryCpi {
        registry_program: ctx.accounts.registry_program.to_account_info(),
        config: ctx.accounts.config.to_account_info(),
        series: ctx.accounts.series.to_account_info(),
        registry_authority: ctx.accounts.registry_authority.to_account_info(),
        authority_bump: ctx.bumps.registry_authority,
    }
    .mark_curve_activated(
        &ctx.accounts.issuer_allowlist.to_account_info(),
        cfg_info.key(),
        pool_info.key(),
        base_mint,
        p.creator,
        now,
        c.swap_base_amount,
        p0,
    )?;
    emit!(RaiseOpened {
        series: series_key,
        unit_mint: base_mint,
        opened_at: now,
        commit_end: 0,
        reveal_end: 0,
    });
    Ok(())
}

// ---------------------------------------------------------------------------- complete_curve

#[derive(Accounts)]
pub struct CompleteCurve<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut, seeds = [seeds::TREASURY, series.key().as_ref()], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    /// CHECK: the series' DBC `PoolConfig` (address = registry record; layout checked).
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: the series' DBC `VirtualPool` (address = registry record; layout checked).
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_AUTHORITY], bump)]
    pub registry_authority: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
}

/// `complete_curve` (anyone): observes the curve's completion (`quote_reserve ≥
/// migration_quote_threshold`, PROG/state/virtual_pool.rs:1122-1124) and settles the raise in the
/// registry at `settlement_ts = finish_curve_timestamp`, with the `P0` and design units fixed at
/// activation; the base mint is final from creation (no mint authority), so the repayment path and
/// the treasury open now. A pool that never completes stays Open (SPEC §9: no cancel, no failure).
pub fn complete_curve(ctx: Context<CompleteCurve>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let series = &ctx.accounts.series;
    let series_key = series.key();
    require!(series.mode == MODE_CURVE, ProtocolError::NotCurveMode);
    require!(
        series.raise_state == RAISE_OPEN,
        ProtocolError::RaiseNotOpen
    );
    let (c, p) = series_dbc(
        series,
        &ctx.accounts.dbc_config.to_account_info(),
        &ctx.accounts.dbc_pool.to_account_info(),
    )?;
    require!(
        p.quote_reserve >= c.migration_quote_threshold && p.finish_curve_timestamp != 0,
        ProtocolError::CurveNotComplete
    );
    let settlement_ts = p.finish_curve_timestamp;
    let (units_sold, p0) = (series.units_sold, series.clearing_price);
    let registry = RegistryCpi {
        registry_program: ctx.accounts.registry_program.to_account_info(),
        config: ctx.accounts.config.to_account_info(),
        series: ctx.accounts.series.to_account_info(),
        registry_authority: ctx.accounts.registry_authority.to_account_info(),
        authority_bump: ctx.bumps.registry_authority,
    };
    registry.mark_raise_result(RAISE_SETTLED, settlement_ts, units_sold, p0)?;
    registry.mark_mint_finalized()?;
    ledger.init_after_settlement(settlement_ts)?;
    ledger.mint_finalized = 1;
    ctx.accounts.treasury.mint_finalized = true;
    emit!(RaiseSettled {
        series: series_key,
        clearing_price: p0,
        units_sold,
        proceeds: 0,
        settlement_ts,
    });
    emit!(RaiseMintFinalized {
        series: series_key,
        units_sold,
        proceeds: 0,
    });
    Ok(())
}

// --------------------------------------------------------------------------- sync_curve_units

#[derive(Accounts)]
pub struct SyncCurveUnits<'info> {
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    /// CHECK: the base mint (address = registry record, owner Token-2022; supply read).
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: the series' DBC `VirtualPool` (address = registry record; layout checked).
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: `pool.base_vault` (address checked; amount read).
    pub dbc_base_vault: UncheckedAccount<'info>,
    /// CHECK: a DAMM v2 `Config` whose `pool_creator_authority` is the DBC pool authority.
    pub damm_config: UncheckedAccount<'info>,
    /// CHECK: the DAMM v2 pool PDA of that config and the series mints (may not exist yet).
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: the DAMM v2 base vault PDA of that pool (may not exist yet).
    pub damm_base_vault: UncheckedAccount<'info>,
    /// CHECK: the locker escrow's base-mint ATA (may not exist).
    pub locker_escrow_token: UncheckedAccount<'info>,
    /// CHECK: the curve_authority's base-mint ATA (leftover receiver; may not exist).
    pub leftover_token: UncheckedAccount<'info>,
}

/// `sync_curve_units` (anyone): recomputes `units_outstanding` from the protocol-held balances
/// (CURVE_MODE §4). Required after a period ends and before its report is accepted (the value is
/// the proof's public input and the vault's weight), and before staking beyond the last snapshot.
pub fn sync_curve_units(ctx: Context<SyncCurveUnits>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series = &ctx.accounts.series;
    require!(
        series.mode == MODE_CURVE && ledger.is_curve(),
        ProtocolError::NotCurveMode
    );
    require!(
        series.raise_state == RAISE_OPEN || series.raise_state == RAISE_SETTLED,
        ProtocolError::RaiseNotOpen
    );
    require!(!ledger.is_terminal(), ProtocolError::TerminalStatus);
    let a = CurveUnitAccounts {
        base_mint: ctx.accounts.base_mint.as_ref(),
        dbc_pool: ctx.accounts.dbc_pool.as_ref(),
        dbc_base_vault: ctx.accounts.dbc_base_vault.as_ref(),
        damm_config: ctx.accounts.damm_config.as_ref(),
        damm_pool: ctx.accounts.damm_pool.as_ref(),
        damm_base_vault: ctx.accounts.damm_base_vault.as_ref(),
        locker_escrow_token: ctx.accounts.locker_escrow_token.as_ref(),
        leftover_token: ctx.accounts.leftover_token.as_ref(),
    };
    // the crank keeps the full census (the pool share is not held by holders); the income math is
    // invariant to it (see `compute_curve_units`), and redemption uses the robust variant
    let u = compute_curve_units(series, &ledger, &a, false)?;
    store_curve_units(&mut ledger, u, now, series.key())
}

// --------------------------------------------------------------------- collect_curve_proceeds

#[derive(Accounts)]
pub struct CollectCurveProceeds<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::TREASURY, series.key().as_ref()], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [seeds::TREASURY_TOKEN, series.key().as_ref()], bump)]
    pub treasury_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = config.fee_collector, token::token_program = stablecoin_program)]
    pub fee_collector_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less PDA, the DBC `fee_claimer` (and possibly `creator`); signs by CPI.
    #[account(seeds = [seeds::CURVE_AUTHORITY, series.key().as_ref()], bump)]
    pub curve_authority: UncheckedAccount<'info>,
    /// CHECK: the DBC pool authority (constant PDA of the DBC program).
    #[account(address = DBC_POOL_AUTHORITY @ ProtocolError::DbcAccountInvalid)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: the series' DBC `PoolConfig` (address = registry record; layout checked).
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: the series' DBC `VirtualPool` (address = registry record; layout checked).
    #[account(mut)]
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: `pool.quote_vault` (address checked here and by DBC).
    #[account(mut)]
    pub dbc_quote_vault: UncheckedAccount<'info>,
    /// CHECK: `pool.base_vault` (address checked here and by DBC).
    #[account(mut)]
    pub dbc_base_vault: UncheckedAccount<'info>,
    /// CHECK: the series base mint (address = registry record).
    #[account(address = series.base_mint @ ProtocolError::UnitMintMismatch)]
    pub base_mint: UncheckedAccount<'info>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    /// CHECK: the DBC event authority (constant PDA of the DBC program).
    #[account(address = DBC_EVENT_AUTHORITY @ ProtocolError::DbcAccountInvalid)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: the DBC program.
    #[account(address = DBC_PROGRAM_ID @ ProtocolError::DbcAccountInvalid)]
    pub dbc_program: UncheckedAccount<'info>,
}

impl<'info> CollectCurveProceeds<'info> {
    /// `withdraw_migration_fee(flag)` / `partner_withdraw_surplus` / `creator_withdraw_surplus`
    /// share one account list: pool authority, config, pool, receiver (the treasury), quote vault,
    /// quote mint, sender (curve_authority), quote token program, event authority, program.
    fn quote_withdrawal(&self, data: Vec<u8>, seeds: &[&[u8]]) -> Result<()> {
        let ix = Instruction {
            program_id: DBC_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
                AccountMeta::new_readonly(self.dbc_config.key(), false),
                AccountMeta::new(self.dbc_pool.key(), false),
                AccountMeta::new(self.treasury_token.key(), false),
                AccountMeta::new(self.dbc_quote_vault.key(), false),
                AccountMeta::new_readonly(self.stablecoin_mint.key(), false),
                AccountMeta::new_readonly(self.curve_authority.key(), true),
                AccountMeta::new_readonly(self.stablecoin_program.key(), false),
                AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false),
                AccountMeta::new_readonly(DBC_PROGRAM_ID, false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                self.dbc_pool_authority.to_account_info(),
                self.dbc_config.to_account_info(),
                self.dbc_pool.to_account_info(),
                self.treasury_token.to_account_info(),
                self.dbc_quote_vault.to_account_info(),
                self.stablecoin_mint.to_account_info(),
                self.curve_authority.to_account_info(),
                self.stablecoin_program.to_account_info(),
                self.dbc_event_authority.to_account_info(),
                self.dbc_program.to_account_info(),
            ],
            &[seeds],
        )
        .map_err(Into::into)
    }

    /// `claim_trading_fee(max_base = 0, max_quote = u64::MAX)`: the partner quote fee into the fee
    /// collector; base fees (`OutputToken` mode) stay in the DBC vault (counted protocol-held).
    fn claim_trading_fee(&self, seeds: &[&[u8]]) -> Result<()> {
        let mut data = disc::CLAIM_TRADING_FEE.to_vec();
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        let ix = Instruction {
            program_id: DBC_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
                AccountMeta::new_readonly(self.dbc_config.key(), false),
                AccountMeta::new(self.dbc_pool.key(), false),
                // token_a_account receives base fees: max_base_amount = 0, nothing moves to it
                AccountMeta::new(self.treasury_token.key(), false),
                AccountMeta::new(self.fee_collector_token.key(), false),
                AccountMeta::new(self.dbc_base_vault.key(), false),
                AccountMeta::new(self.dbc_quote_vault.key(), false),
                AccountMeta::new_readonly(self.base_mint.key(), false),
                AccountMeta::new_readonly(self.stablecoin_mint.key(), false),
                AccountMeta::new_readonly(self.curve_authority.key(), true),
                AccountMeta::new_readonly(self.token_2022_program.key(), false),
                AccountMeta::new_readonly(self.stablecoin_program.key(), false),
                AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false),
                AccountMeta::new_readonly(DBC_PROGRAM_ID, false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                self.dbc_pool_authority.to_account_info(),
                self.dbc_config.to_account_info(),
                self.dbc_pool.to_account_info(),
                self.treasury_token.to_account_info(),
                self.fee_collector_token.to_account_info(),
                self.dbc_base_vault.to_account_info(),
                self.dbc_quote_vault.to_account_info(),
                self.base_mint.to_account_info(),
                self.stablecoin_mint.to_account_info(),
                self.curve_authority.to_account_info(),
                self.token_2022_program.to_account_info(),
                self.stablecoin_program.to_account_info(),
                self.dbc_event_authority.to_account_info(),
                self.dbc_program.to_account_info(),
            ],
            &[seeds],
        )
        .map_err(Into::into)
    }
}

/// `collect_curve_proceeds` (anyone, CURVE_MODE §7, PROCEEDS_OPTIONS §6.2): the protocol's
/// `curve_authority` PDA signs the DBC withdrawals by CPI, so the raise's proceeds can only land
/// in the series treasury and follow the D4 release schedule from `settlement_ts`:
/// - after completion: the partner migration-fee share (`withdraw_migration_fee(0)`), the creator
///   share too when the PDA is the pool creator (`withdraw_migration_fee(1)`), and the partner /
///   creator surplus — each once, as DBC records;
/// - any time: the partner trading fee (`claim_trading_fee`) into the fee collector (the backer
///   fee, mirror of the sealed-bid auction fee).
///
/// The treasury's `proceeds` grow by exactly what arrived in its token account.
pub fn collect_curve_proceeds(ctx: Context<CollectCurveProceeds>) -> Result<()> {
    let series = &ctx.accounts.series;
    let series_key = series.key();
    require!(series.mode == MODE_CURVE, ProtocolError::NotCurveMode);
    require!(
        series.raise_state == RAISE_OPEN || series.raise_state == RAISE_SETTLED,
        ProtocolError::RaiseNotOpen
    );
    let (c, p) = series_dbc(
        series,
        &ctx.accounts.dbc_config.to_account_info(),
        &ctx.accounts.dbc_pool.to_account_info(),
    )?;
    require_keys_eq!(
        ctx.accounts.dbc_quote_vault.key(),
        p.quote_vault,
        ProtocolError::DbcVaultMismatch
    );
    require_keys_eq!(
        ctx.accounts.dbc_base_vault.key(),
        p.base_vault,
        ProtocolError::DbcVaultMismatch
    );
    let curve_authority = ctx.accounts.curve_authority.key();
    let bump = [ctx.bumps.curve_authority];
    let seeds: &[&[u8]] = &[seeds::CURVE_AUTHORITY, series_key.as_ref(), &bump];
    let treasury_before = ctx.accounts.treasury_token.amount;
    let fee_before = ctx.accounts.fee_collector_token.amount;
    let complete = p.quote_reserve >= c.migration_quote_threshold;
    let creator_is_pda = p.creator == curve_authority;
    let (partner_fee, creator_fee) = migration_fee_split(
        c.migration_quote_threshold,
        c.migration_fee_percentage,
        c.creator_migration_fee_percentage,
    )
    .map_err(math)?;
    let mut migration_fee = 0u64;
    if complete {
        if partner_fee > 0 && p.migration_fee_withdraw_status & PARTNER_MIGRATION_FEE_MASK == 0 {
            let mut data = disc::WITHDRAW_MIGRATION_FEE.to_vec();
            data.push(0);
            ctx.accounts.quote_withdrawal(data, seeds)?;
            migration_fee = migration_fee
                .checked_add(partner_fee)
                .ok_or(ProtocolError::MathOverflow)?;
        }
        if creator_is_pda
            && creator_fee > 0
            && p.migration_fee_withdraw_status & CREATOR_MIGRATION_FEE_MASK == 0
        {
            let mut data = disc::WITHDRAW_MIGRATION_FEE.to_vec();
            data.push(1);
            ctx.accounts.quote_withdrawal(data, seeds)?;
            migration_fee = migration_fee
                .checked_add(creator_fee)
                .ok_or(ProtocolError::MathOverflow)?;
        }
        let surplus = p.quote_reserve > c.migration_quote_threshold;
        if surplus && !p.is_partner_withdraw_surplus {
            ctx.accounts
                .quote_withdrawal(disc::PARTNER_WITHDRAW_SURPLUS.to_vec(), seeds)?;
        }
        if surplus && creator_is_pda && !p.is_creator_withdraw_surplus {
            ctx.accounts
                .quote_withdrawal(disc::CREATOR_WITHDRAW_SURPLUS.to_vec(), seeds)?;
        }
    }
    if p.partner_quote_fee > 0 {
        ctx.accounts.claim_trading_fee(seeds)?;
    }
    ctx.accounts.treasury_token.reload()?;
    ctx.accounts.fee_collector_token.reload()?;
    let received = ctx
        .accounts
        .treasury_token
        .amount
        .checked_sub(treasury_before)
        .ok_or(ProtocolError::MathOverflow)?;
    let trading_fee = ctx
        .accounts
        .fee_collector_token
        .amount
        .checked_sub(fee_before)
        .ok_or(ProtocolError::MathOverflow)?;
    let surplus = received.saturating_sub(migration_fee);
    let t = &mut ctx.accounts.treasury;
    t.proceeds = t
        .proceeds
        .checked_add(received)
        .ok_or(ProtocolError::MathOverflow)?;
    t.proceeds_received = t
        .proceeds_received
        .checked_add(received)
        .ok_or(ProtocolError::MathOverflow)?;
    emit!(CurveProceedsCollected {
        series: series_key,
        migration_fee: received.min(migration_fee),
        surplus,
        trading_fee,
        proceeds: t.proceeds,
    });
    Ok(())
}

// ------------------------------------------------------------------------------ stake / unstake

#[derive(Accounts)]
pub struct StakeUnits<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut, seeds = [seeds::HOLDER, series.key().as_ref(), owner.key().as_ref()], bump = holder.bump)]
    pub holder: Box<Account<'info, Holder>>,
    /// CHECK: the owner's registry `AllowlistEntry` PDA (address checked; a missing entry reads
    /// as not allowed).
    #[account(seeds = [ALLOW, owner.key().as_ref()], bump, seeds::program = merces_registry::ID)]
    pub owner_allowlist: UncheckedAccount<'info>,
    #[account(mut, token::mint = base_mint, token::authority = owner, token::token_program = token_2022_program)]
    pub owner_base_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less PDA owning the stake vault.
    #[account(seeds = [seeds::CURVE_STAKE, series.key().as_ref()], bump)]
    pub stake_auth: UncheckedAccount<'info>,
    /// CHECK: `ATA(stake_auth, base_mint)` (created idempotently; derivation validated).
    #[account(mut)]
    pub stake_vault: UncheckedAccount<'info>,
    #[account(address = series.base_mint @ ProtocolError::UnitMintMismatch)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// `stake_units(units)` (registered, allowlisted holder): moves base lamports into the series
/// stake vault; they earn from now on (debt pattern: pending is settled at the old weight first).
/// Bounded by the synced `units_outstanding` (sync first when more units circulate); closed in
/// terminal statuses, so stakes at redemption or extinguishment can only fall.
pub fn stake_units(ctx: Context<StakeUnits>, units: u64) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let series = &ctx.accounts.series;
    let series_key = series.key();
    let owner = ctx.accounts.owner.key();
    require!(
        series.mode == MODE_CURVE && ledger.is_curve(),
        ProtocolError::NotCurveMode
    );
    require!(
        series.raise_state == RAISE_OPEN || series.raise_state == RAISE_SETTLED,
        ProtocolError::RaiseNotOpen
    );
    require!(!ledger.is_terminal(), ProtocolError::TerminalStatus);
    require!(units > 0, ProtocolError::ZeroUnits);
    require!(
        is_allowlisted(&ctx.accounts.owner_allowlist.to_account_info(), &owner)?,
        ProtocolError::NotAllowlisted
    );
    let staked_after = ledger
        .staked_total
        .checked_add(units)
        .ok_or(ProtocolError::MathOverflow)?;
    require!(
        staked_after <= ledger.units_outstanding,
        ProtocolError::StakeExceedsOutstanding
    );
    let h = &mut ctx.accounts.holder;
    settle_curve_holder(&ledger, h)?;
    let t22 = ctx.accounts.token_2022_program.to_account_info();
    let stake_auth = ctx.accounts.stake_auth.to_account_info();
    let vault = ctx.accounts.stake_vault.to_account_info();
    let mint = ctx.accounts.base_mint.to_account_info();
    create_ata_idempotent(CreateAta {
        payer: &ctx.accounts.owner.to_account_info(),
        ata: &vault,
        owner: &stake_auth,
        mint: &mint,
        system_program: &ctx.accounts.system_program.to_account_info(),
        token_program: &t22,
        ata_program: &ctx.accounts.associated_token_program.to_account_info(),
    })?;
    transfer_base(
        &t22,
        &ctx.accounts.owner_base_ata.to_account_info(),
        &mint,
        &vault,
        &ctx.accounts.owner.to_account_info(),
        units,
        &[],
    )?;
    h.staked_units = h
        .staked_units
        .checked_add(units)
        .ok_or(ProtocolError::MathOverflow)?;
    ledger.staked_total = staked_after;
    emit!(UnitsStaked {
        series: series_key,
        holder: owner,
        units,
        staked: h.staked_units,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct UnstakeUnits<'info> {
    pub owner: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut, seeds = [seeds::HOLDER, series.key().as_ref(), owner.key().as_ref()], bump = holder.bump)]
    pub holder: Box<Account<'info, Holder>>,
    #[account(mut, token::mint = base_mint, token::authority = owner, token::token_program = token_2022_program)]
    pub owner_base_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less PDA owning the stake vault.
    #[account(seeds = [seeds::CURVE_STAKE, series.key().as_ref()], bump)]
    pub stake_auth: UncheckedAccount<'info>,
    /// CHECK: `ATA(stake_auth, base_mint)` (derivation validated).
    #[account(mut)]
    pub stake_vault: UncheckedAccount<'info>,
    #[account(address = series.base_mint @ ProtocolError::UnitMintMismatch)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// `unstake_units(units)` (holder, any status): settles first (pending payouts, and the final
/// share of an extinguished series), then returns the units to the holder's ATA. Never blocked.
pub fn unstake_units(ctx: Context<UnstakeUnits>, units: u64) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let series_key = ctx.accounts.series.key();
    let owner = ctx.accounts.owner.key();
    require!(ledger.is_curve(), ProtocolError::NotCurveMode);
    require!(units > 0, ProtocolError::ZeroUnits);
    let h = &mut ctx.accounts.holder;
    require!(units <= h.staked_units, ProtocolError::InsufficientStake);
    settle_curve_holder(&ledger, h)?;
    let t22 = ctx.accounts.token_2022_program.to_account_info();
    let vault = ctx.accounts.stake_vault.to_account_info();
    let stake_auth = ctx.accounts.stake_auth.to_account_info();
    require_ata(
        &vault,
        stake_auth.key,
        &ctx.accounts.series.base_mint,
        t22.key,
    )
    .map_err(|_| error!(ProtocolError::StakeVaultMismatch))?;
    let bump = [ctx.bumps.stake_auth];
    let seeds: &[&[u8]] = &[seeds::CURVE_STAKE, series_key.as_ref(), &bump];
    transfer_base(
        &t22,
        &vault,
        &ctx.accounts.base_mint.to_account_info(),
        &ctx.accounts.owner_base_ata.to_account_info(),
        &stake_auth,
        units,
        &[seeds],
    )?;
    h.staked_units = h
        .staked_units
        .checked_sub(units)
        .ok_or(ProtocolError::MathOverflow)?;
    ledger.staked_total = ledger
        .staked_total
        .checked_sub(units)
        .ok_or(ProtocolError::MathOverflow)?;
    emit!(UnitsUnstaked {
        series: series_key,
        holder: owner,
        units,
        staked: h.staked_units,
    });
    Ok(())
}

// --------------------------------------------------------------------------------- tender_units

#[derive(Accounts)]
pub struct TenderUnits<'info> {
    pub owner: Signer<'info>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    #[account(mut, seeds = [seeds::HOLDER, series.key().as_ref(), owner.key().as_ref()], bump = holder.bump)]
    pub holder: Box<Account<'info, Holder>>,
    #[account(mut, token::mint = base_mint, token::authority = owner, token::token_program = token_2022_program)]
    pub owner_base_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = owner, token::token_program = stablecoin_program)]
    pub owner_stable_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less PDA owning the stake vault (burns staked units it holds).
    #[account(seeds = [seeds::CURVE_STAKE, series.key().as_ref()], bump)]
    pub stake_auth: UncheckedAccount<'info>,
    /// CHECK: `ATA(stake_auth, base_mint)` (derivation validated when staked units are tendered).
    #[account(mut)]
    pub stake_vault: UncheckedAccount<'info>,
    #[account(mut, address = series.base_mint @ ProtocolError::UnitMintMismatch)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [seeds::VAULT_TOKEN, series.key().as_ref()], bump)]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less signer PDA, vault owner.
    #[account(seeds = [seeds::VAULT_AUTH, series.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

/// `tender_units(from_stake, from_wallet)` (registered holder of a redeemed series, SPEC §9 /
/// CURVE_MODE §7): pays `floor(P_redeem × units / 10^6)` plus any pending payout from the
/// redemption deposit and burns the units by their owner's authority — the stake vault PDA for
/// staked units, the holder's signature for wallet units (the base mint has no permanent
/// delegate). Staked units are always covered (reserved at redemption); wallet units share
/// `units_at_redemption − tendered − staked` (`TenderQuotaExhausted` once it is used up), so the
/// deposit is never exceeded even though units keep circulating after redemption.
pub fn tender_units<'info>(
    ctx: Context<'info, TenderUnits<'info>>,
    from_stake: u64,
    from_wallet: u64,
) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let series_key = ctx.accounts.series.key();
    let owner = ctx.accounts.owner.key();
    require!(ledger.is_curve(), ProtocolError::NotCurveMode);
    require!(ledger.redemption_ts != 0, ProtocolError::NotRedeemed);
    let units = from_stake
        .checked_add(from_wallet)
        .ok_or(ProtocolError::MathOverflow)?;
    require!(units > 0, ProtocolError::ZeroUnits);
    let h = &mut ctx.accounts.holder;
    require!(
        from_stake <= h.staked_units,
        ProtocolError::InsufficientStake
    );
    require!(
        wallet_tender_fits(
            ledger.units_at_redemption,
            ledger.tendered_total,
            ledger.staked_total,
            from_wallet
        )
        .map_err(math)?,
        ProtocolError::TenderQuotaExhausted
    );
    settle_curve_holder(&ledger, h)?;
    let t22 = ctx.accounts.token_2022_program.to_account_info();
    let mint = ctx.accounts.base_mint.to_account_info();
    if from_stake > 0 {
        let vault = ctx.accounts.stake_vault.to_account_info();
        let stake_auth = ctx.accounts.stake_auth.to_account_info();
        require_ata(
            &vault,
            stake_auth.key,
            &ctx.accounts.series.base_mint,
            t22.key,
        )
        .map_err(|_| error!(ProtocolError::StakeVaultMismatch))?;
        let bump = [ctx.bumps.stake_auth];
        let seeds: &[&[u8]] = &[seeds::CURVE_STAKE, series_key.as_ref(), &bump];
        burn_base(&t22, &vault, &mint, &stake_auth, from_stake, &[seeds])?;
        h.staked_units = h
            .staked_units
            .checked_sub(from_stake)
            .ok_or(ProtocolError::MathOverflow)?;
        ledger.staked_total = ledger
            .staked_total
            .checked_sub(from_stake)
            .ok_or(ProtocolError::MathOverflow)?;
    }
    burn_base(
        &t22,
        &ctx.accounts.owner_base_ata.to_account_info(),
        &mint,
        &ctx.accounts.owner.to_account_info(),
        from_wallet,
        &[],
    )?;
    ledger.tendered_total = ledger
        .tendered_total
        .checked_add(units)
        .ok_or(ProtocolError::MathOverflow)?;
    h.redeemed_units = h
        .redeemed_units
        .checked_add(units)
        .ok_or(ProtocolError::MathOverflow)?;
    let redemption = scaled_amount(ledger.redemption_price, units, ledger.scale()).map_err(math)?;
    let amount = h
        .pending
        .checked_add(redemption)
        .ok_or(ProtocolError::MathOverflow)?;
    h.pending = 0;
    let bump = [ctx.bumps.vault_auth];
    let seeds: &[&[u8]] = &[seeds::VAULT_AUTH, series_key.as_ref(), &bump];
    transfer_stable(
        &ctx.accounts.stablecoin_program.to_account_info(),
        &ctx.accounts.vault_token.to_account_info(),
        &ctx.accounts.stablecoin_mint.to_account_info(),
        &ctx.accounts.owner_stable_ata.to_account_info(),
        &ctx.accounts.vault_auth.to_account_info(),
        ctx.remaining_accounts,
        amount,
        ctx.accounts.series.stablecoin_decimals,
        &[seeds],
    )?;
    emit!(UnitsBurned {
        series: series_key,
        holder: owner,
        units,
        reason: BURN_REDEEMED,
    });
    emit!(RedemptionClaimed {
        series: series_key,
        holder: owner,
        units,
        amount,
    });
    Ok(())
}

/// Curve-mode check used by `submit_report`: the units snapshot must postdate the reported period
/// (it is the proof's public input and the vault's weight).
pub fn require_units_synced_for(ledger: &Ledger, period: u32) -> Result<()> {
    if !ledger.is_curve() {
        return Ok(());
    }
    let end = period_end(period).map_err(math)?;
    require!(
        ledger.units_synced_at >= end && ledger.units_outstanding > 0,
        ProtocolError::CurveUnitsNotSynced
    );
    Ok(())
}
