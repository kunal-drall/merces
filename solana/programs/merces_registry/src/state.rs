//! Registry account layouts (SPEC v1.1 §3.1).

use anchor_lang::prelude::*;
use merces_common::params::{Parameters, Tranche};

/// Series mode (SPEC §3.1).
pub const MODE_SEALED_BID: u8 = 0;
pub const MODE_CURVE: u8 = 1;

/// `RaiseState` (SPEC §1.7).
pub const RAISE_DRAFT: u8 = 0;
pub const RAISE_OPEN: u8 = 1;
pub const RAISE_REVEAL: u8 = 2;
pub const RAISE_SETTLING: u8 = 3;
pub const RAISE_SETTLED: u8 = 4;
pub const RAISE_FAILED: u8 = 5;
pub const RAISE_CANCELLED: u8 = 6;

/// Terminal statuses mirrored for the hook (SPEC §1.7 numbering).
pub const TERMINAL_NONE: u8 = 0;
pub const TERMINAL_RETIRED: u8 = 4;
pub const TERMINAL_REDEEMED: u8 = 5;
pub const TERMINAL_EXTINGUISHED: u8 = 6;

/// Tier flag bits.
pub const TIER_FLAG_SPLIT: u8 = 1 << 0;
pub const TIER_FLAG_ZKTLS: u8 = 1 << 1;
pub const TIER_FLAG_ATTESTOR: u8 = 1 << 2;
pub const TIER_FLAG_SELF: u8 = 1 << 3;
pub const TIER_FLAGS_MASK: u8 = 0x0F;

pub const MAX_METADATA_URI: usize = 200;

/// Borsh-serialisable mirror of [`Parameters`].
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace, Default)]
pub struct ParametersData {
    pub cap_multiple_wad: u64,
    pub hurdle_rate_wad: u64,
    pub payout_multiple_k: u16,
    pub lockup_seconds: u64,
    pub wallet_cap_bps: u16,
    pub auction_fee_bps: u16,
    pub payout_fee_bps: u16,
    pub window_fee_bps: u16,
    pub non_reveal_charge_bps: u16,
    pub commit_duration: u64,
    pub reveal_duration: u64,
    pub window_commit_duration: u64,
    pub window_reveal_duration: u64,
    pub fx_min_coverage_bps: u16,
    pub fx_max_staleness_seconds: u64,
    pub fx_max_conf_bps: u16,
    pub fx_deviation_band_bps: u16,
    pub max_pause_seconds: u64,
    pub max_cumulative_pause_seconds: u64,
}

impl From<ParametersData> for Parameters {
    fn from(p: ParametersData) -> Self {
        Parameters {
            cap_multiple_wad: p.cap_multiple_wad,
            hurdle_rate_wad: p.hurdle_rate_wad,
            payout_multiple_k: p.payout_multiple_k,
            lockup_seconds: p.lockup_seconds,
            wallet_cap_bps: p.wallet_cap_bps,
            auction_fee_bps: p.auction_fee_bps,
            payout_fee_bps: p.payout_fee_bps,
            window_fee_bps: p.window_fee_bps,
            non_reveal_charge_bps: p.non_reveal_charge_bps,
            commit_duration: p.commit_duration,
            reveal_duration: p.reveal_duration,
            window_commit_duration: p.window_commit_duration,
            window_reveal_duration: p.window_reveal_duration,
            fx_min_coverage_bps: p.fx_min_coverage_bps,
            fx_max_staleness_seconds: p.fx_max_staleness_seconds,
            fx_max_conf_bps: p.fx_max_conf_bps,
            fx_deviation_band_bps: p.fx_deviation_band_bps,
            max_pause_seconds: p.max_pause_seconds,
            max_cumulative_pause_seconds: p.max_cumulative_pause_seconds,
        }
    }
}

impl From<Parameters> for ParametersData {
    fn from(p: Parameters) -> Self {
        ParametersData {
            cap_multiple_wad: p.cap_multiple_wad,
            hurdle_rate_wad: p.hurdle_rate_wad,
            payout_multiple_k: p.payout_multiple_k,
            lockup_seconds: p.lockup_seconds,
            wallet_cap_bps: p.wallet_cap_bps,
            auction_fee_bps: p.auction_fee_bps,
            payout_fee_bps: p.payout_fee_bps,
            window_fee_bps: p.window_fee_bps,
            non_reveal_charge_bps: p.non_reveal_charge_bps,
            commit_duration: p.commit_duration,
            reveal_duration: p.reveal_duration,
            window_commit_duration: p.window_commit_duration,
            window_reveal_duration: p.window_reveal_duration,
            fx_min_coverage_bps: p.fx_min_coverage_bps,
            fx_max_staleness_seconds: p.fx_max_staleness_seconds,
            fx_max_conf_bps: p.fx_max_conf_bps,
            fx_deviation_band_bps: p.fx_deviation_band_bps,
            max_pause_seconds: p.max_pause_seconds,
            max_cumulative_pause_seconds: p.max_cumulative_pause_seconds,
        }
    }
}

/// Borsh-serialisable mirror of [`Tranche`].
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace, Default)]
pub struct TrancheData {
    pub at_offset_seconds: u64,
    pub bps: u16,
}

impl From<TrancheData> for Tranche {
    fn from(t: TrancheData) -> Self {
        Tranche {
            at_offset_seconds: t.at_offset_seconds,
            bps: t.bps,
        }
    }
}

/// Plaintext tier-1 terms (public by the issuer's choice, SPEC §6.5); checked against
/// `terms_commitment` with Poseidon(5) at series creation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace, Default)]
pub struct Tier1Terms {
    pub theta: u64,
    pub r_wad: u64,
    pub currency_code: u32,
    pub indexing_rule: u32,
    /// The commitment salt as a 32-byte big-endian field element.
    pub terms_salt: [u8; 32],
}

/// Global protocol configuration, one per deployment (`[CONFIG]`).
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub allowlist_manager: Pubkey,
    pub fee_collector: Pubkey,
    /// `keccak256(1u8 ‖ chain_id_be ‖ registry_program_id)` (SPEC §1.3).
    pub domain: [u8; 32],
    pub chain_id: u64,
    pub new_raises_paused: bool,
    pub windows_enabled: bool,
    pub tier4_enabled: bool,
    /// Zero when unset (early draws off).
    pub early_draw_approver: Pubkey,
    pub defaults: ParametersData,
    /// The `merces_protocol` program id, fixed at init (no setter).
    pub protocol_program: Pubkey,
    /// `find_program_address([REGISTRY_AUTHORITY], protocol_program)`: the only key allowed to call
    /// the write interface (SPEC §3.2 `registry_authority`).
    pub protocol_authority: Pubkey,
    pub series_count: u64,
    /// Active key counts (a kind's last active key cannot be revoked, SPEC §1.4).
    pub attestor_count: u32,
    pub verifier_count: u32,
    pub bump: u8,
}

/// Issuer record (`[ISSUER, wallet]`).
#[account]
#[derive(InitSpace)]
pub struct Issuer {
    pub wallet: Pubkey,
    pub active: bool,
    pub issuance_stopped: bool,
    pub series_count: u32,
    pub bump: u8,
}

/// Allowlist entry (`[ALLOW, wallet]`). A missing account means "never allowlisted".
#[account]
#[derive(InitSpace)]
pub struct AllowlistEntry {
    pub wallet: Pubkey,
    pub allowed: bool,
    pub updated_at: i64,
    pub bump: u8,
}

/// Attestor key (`[ATTESTOR, addr20]`). `revoked_at == 0` while active (SPEC §1.4).
#[account]
#[derive(InitSpace)]
pub struct AttestorKey {
    pub addr: [u8; 20],
    pub active: bool,
    pub revoked_at: u64,
    pub bump: u8,
}

/// Report-verifier key (`[VERIFIER, addr20]`).
#[account]
#[derive(InitSpace)]
pub struct VerifierKey {
    pub addr: [u8; 20],
    pub active: bool,
    pub revoked_at: u64,
    pub bump: u8,
}

/// FX pair configuration (`[FX, pair_id]`), `pair_id = keccak256(feed_id ‖ inverted_u8)`.
#[account]
#[derive(InitSpace)]
pub struct FxPairConfig {
    pub pair_id: [u8; 32],
    pub feed_id: [u8; 32],
    pub inverted: bool,
    /// Zero when no cross-check feed is configured (always zero on Solana in this version, A21).
    pub crosscheck: Pubkey,
    /// Period from which the current `crosscheck` applies (SPEC §3.1).
    pub crosscheck_effective_period: u32,
    pub enabled: bool,
    pub bump: u8,
}

/// One raise by one issuer (`[SERIES, series_id_le]`). The charter block is frozen once
/// `raise_state != Draft` (SPEC §3.3).
#[account]
#[derive(InitSpace)]
pub struct Series {
    // identity
    pub series_id: u64,
    pub issuer: Pubkey,
    pub mode: u8,
    pub stablecoin: Pubkey,
    pub stablecoin_decimals: u8,
    /// The stablecoin mint's owner program (SPL Token or Token-2022).
    pub stablecoin_program: Pubkey,
    /// Set by `mark_raise_opened` (sealed bid) or `mark_curve_activated` (curve).
    pub unit_mint: Pubkey,
    // charter terms (immutable once raise_state != Draft)
    pub units_offered: u64,
    pub reserve_price: u64,
    pub min_raise: u64,
    pub cap_multiple_wad: u64,
    pub hurdle_rate_wad: u64,
    pub payout_multiple_k: u16,
    pub lockup_seconds: u64,
    pub wallet_cap_bps: u16,
    pub auction_fee_bps: u16,
    pub payout_fee_bps: u16,
    pub window_fee_bps: u16,
    pub non_reveal_charge_bps: u16,
    pub commit_duration: u64,
    pub reveal_duration: u64,
    pub window_commit_duration: u64,
    pub window_reveal_duration: u64,
    pub fx_min_coverage_bps: u16,
    pub max_pause_seconds: u64,
    pub max_cumulative_pause_seconds: u64,
    #[max_len(24)]
    pub release_schedule: Vec<TrancheData>,
    pub contract_hash: [u8; 32],
    pub tier_flags: u8,
    pub fx_pair_id: [u8; 32],
    pub issuer_accepts_public_price: bool,
    #[max_len(200)]
    pub metadata_uri: String,
    /// Tier-1 plaintext terms (zero unless bit0 of `tier_flags` is set).
    pub router_theta: u64,
    pub router_r_wad: u64,
    // amendable (only via amend_terms)
    pub terms_commitment: [u8; 32],
    pub amendment_nonce: u64,
    // raise results (written by the protocol via the write interface, once)
    pub raise_state: u8,
    pub opened_at: u64,
    pub settlement_ts: u64,
    pub units_sold: u64,
    pub clearing_price: u64,
    pub mint_finalized: bool,
    pub terminal_status: u8,
    // protocol escrow token accounts for the unit mint (read by the hook)
    pub auction_escrow_ata: Pubkey,
    pub window_escrow_ata: Pubkey,
    // curve mode (SPEC §9; filled by `mark_curve_activated`, unused for sealed-bid series)
    pub dbc_config: Pubkey,
    pub dbc_pool: Pubkey,
    pub base_mint: Pubkey,
    pub bump: u8,
}

impl Series {
    pub fn is_terminal(&self) -> bool {
        self.terminal_status != TERMINAL_NONE
    }
}
