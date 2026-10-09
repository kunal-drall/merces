//! Registry events (SPEC §10). Field names are shared with the EVM events (camelCase there).

use anchor_lang::prelude::*;

use crate::state::ParametersData;

#[event]
pub struct ProtocolInitialized {
    pub admin: Pubkey,
    pub allowlist_manager: Pubkey,
    pub fee_collector: Pubkey,
    pub chain_id: u64,
    pub domain: [u8; 32],
    pub protocol_program: Pubkey,
    pub protocol_authority: Pubkey,
}

#[event]
pub struct AdminTransferStarted {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminTransferred {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[event]
pub struct AllowlistManagerSet {
    pub allowlist_manager: Pubkey,
}

#[event]
pub struct FeeCollectorSet {
    pub fee_collector: Pubkey,
}

#[event]
pub struct FlagsSet {
    pub new_raises_paused: bool,
    pub windows_enabled: bool,
    pub tier4_enabled: bool,
}

#[event]
pub struct EarlyDrawApproverSet {
    pub approver: Pubkey,
}

#[event]
pub struct DefaultsSet {
    pub defaults: ParametersData,
}

#[event]
pub struct AttestorRegistered {
    pub addr: [u8; 20],
}

#[event]
pub struct AttestorRevoked {
    pub addr: [u8; 20],
    pub revoked_at: u64,
}

#[event]
pub struct VerifierKeyRegistered {
    pub addr: [u8; 20],
}

#[event]
pub struct VerifierKeyRevoked {
    pub addr: [u8; 20],
    pub revoked_at: u64,
}

#[event]
pub struct FxPairSet {
    pub pair_id: [u8; 32],
    pub feed_id: [u8; 32],
    pub inverted: bool,
    pub crosscheck: Pubkey,
    pub crosscheck_effective_period: u32,
    pub enabled: bool,
}

#[event]
pub struct IssuerRegistered {
    pub wallet: Pubkey,
}

#[event]
pub struct IssuerDeactivated {
    pub wallet: Pubkey,
}

#[event]
pub struct IssuanceStopped {
    pub wallet: Pubkey,
}

#[event]
pub struct IssuanceResumed {
    pub wallet: Pubkey,
}

#[event]
pub struct AllowlistUpdated {
    pub wallet: Pubkey,
    pub allowed: bool,
}

#[event]
pub struct SeriesCreated {
    pub series: Pubkey,
    pub series_id: u64,
    pub issuer: Pubkey,
    pub mode: u8,
    pub stablecoin: Pubkey,
    pub units_offered: u64,
    pub reserve_price: u64,
    pub min_raise: u64,
    pub cap_multiple_wad: u64,
    pub hurdle_rate_wad: u64,
    pub k: u16,
    pub lockup_seconds: u64,
    pub wallet_cap_bps: u16,
    pub auction_fee_bps: u16,
    pub payout_fee_bps: u16,
    pub window_fee_bps: u16,
    pub non_reveal_charge_bps: u16,
    pub terms_commitment: [u8; 32],
    pub tier_flags: u8,
    pub fx_pair_id: [u8; 32],
}

#[event]
pub struct ContractHashSet {
    pub series: Pubkey,
    pub hash: [u8; 32],
}

#[event]
pub struct TermsAmended {
    pub series: Pubkey,
    pub nonce: u64,
    pub new_terms_commitment: [u8; 32],
    pub new_cap_multiple_wad: u64,
    pub attestor: [u8; 20],
}

#[event]
pub struct RaiseStateChanged {
    pub series: Pubkey,
    pub state: u8,
}

#[event]
pub struct MintFinalized {
    pub series: Pubkey,
}

#[event]
pub struct TerminalStatusSet {
    pub series: Pubkey,
    pub status: u8,
}

#[event]
pub struct CurveActivated {
    pub series: Pubkey,
    pub dbc_config: Pubkey,
    pub dbc_pool: Pubkey,
    pub base_mint: Pubkey,
    pub dbc_creator: Pubkey,
    pub units_sold: u64,
    pub clearing_price: u64,
}
