//! Protocol account layouts (SPEC §5.1, §5.3, §6.1, §6.5, §6.6, §7).

use anchor_lang::prelude::*;
use merces_common::params::MAX_YEAR_BUCKETS;

/// PDA seeds of `merces_protocol`. Every per-series PDA includes the registry `Series` key.
pub mod seeds {
    pub const AUCTION: &[u8] = b"auction";
    pub const BID: &[u8] = b"bid";
    pub const TREASURY: &[u8] = b"treasury";
    pub const LEDGER: &[u8] = b"ledger";
    pub const HOLDER: &[u8] = b"holder";
    pub const REPORT: &[u8] = b"report";
    pub const ROUTER: &[u8] = b"router";
    pub const FX_PAIR: &[u8] = b"fxpair";
    pub const FX_CHECKPOINT: &[u8] = b"fxcp";
    pub const WINDOW: &[u8] = b"window";
    pub const ORDER: &[u8] = b"order";
    pub const UNIT_MINT: &[u8] = b"unit_mint";
    // data-less signer PDAs
    pub const AUCTION_AUTH: &[u8] = b"auction_auth";
    pub const VAULT_AUTH: &[u8] = b"vault_auth";
    pub const ESCROW_AUTH: &[u8] = b"escrow_auth";
    pub const TREASURY_AUTH: &[u8] = b"treasury_auth";
    pub const ROUTER_AUTH: &[u8] = b"router_auth";
    pub use merces_onchain::seeds::{REGISTRY_SIGNER, WINDOW_ESCROW};
    // token accounts (PDAs owned by the authorities above)
    pub const ESCROW_TOKEN: &[u8] = b"escrow_token";
    pub const TREASURY_TOKEN: &[u8] = b"treasury_token";
    pub const VAULT_TOKEN: &[u8] = b"vault_token";
    pub const ROUTER_TOKEN: &[u8] = b"router_token";
    pub const WINDOW_UNITS: &[u8] = b"window_units";
    pub const WINDOW_STABLE: &[u8] = b"window_stable";
}

/// Maximum bids per `tally_bids` page and orders per `tally_orders` page (SPEC §5.2).
pub const TALLY_PAGE: usize = 24;

/// `RaiseState` mirror (SPEC §1.7).
pub const RAISE_OPEN: u8 = 1;
pub const RAISE_SETTLING: u8 = 3;
pub const RAISE_SETTLED: u8 = 4;
pub const RAISE_FAILED: u8 = 5;
pub const RAISE_CANCELLED: u8 = 6;

/// `PayoutDistributed.source`.
pub const SOURCE_PAYMENT: u8 = 0;
pub const SOURCE_ROUTER: u8 = 1;
pub const SOURCE_TAIL: u8 = 2;
pub const SOURCE_FINAL: u8 = 3;

/// `UnitsBurned.reason`.
pub const BURN_RETIRED: u8 = 0;
pub const BURN_REDEEMED: u8 = 1;
pub const BURN_EXTINGUISHED: u8 = 2;

/// Window states (SPEC §7).
pub const WINDOW_CLOSED: u8 = 0;
pub const WINDOW_COMMIT: u8 = 1;
pub const WINDOW_REVEAL: u8 = 2;
pub const WINDOW_SETTLING: u8 = 3;
pub const WINDOW_SETTLED: u8 = 4;
pub const WINDOW_NO_MATCH: u8 = 5;

/// Order sides.
pub const SIDE_BID: u8 = 0;
pub const SIDE_ASK: u8 = 1;

/// Tiers.
pub const TIER_SPLIT: u8 = 1;
pub const TIER_ZKTLS: u8 = 2;
pub const TIER_ATTESTOR: u8 = 3;
pub const TIER_SELF: u8 = 4;

/// Sealed-bid auction state (`[AUCTION, series]`).
#[account]
#[derive(InitSpace)]
pub struct Auction {
    pub series: Pubkey,
    pub state: u8,
    pub opened_at: u64,
    pub commit_end: u64,
    pub reveal_end: u64,
    pub escrow_total: u64,
    pub bid_count: u32,
    pub revealed_count: u32,
    pub valid_count: u32,
    // settlement proposal and tally
    pub clearing_price: u64,
    pub q_above: u64,
    pub q_at: u64,
    pub min_valid_price: u64,
    pub tallied_count: u32,
    pub tally_round: u32,
    // results
    pub units_sold: u64,
    pub proceeds: u64,
    pub remainder_at_margin: u64,
    pub units_minted: u64,
    pub bids_processed: u32,
    pub settlement_ts: u64,
    pub mint_authority_revoked: bool,
    pub mint_finalized: bool,
    pub bump: u8,
}

/// One bid per wallet per series (`[BID, series, bidder]`).
#[account]
#[derive(InitSpace)]
pub struct Bid {
    pub series: Pubkey,
    pub bidder: Pubkey,
    pub commitment: [u8; 32],
    pub escrow: u64,
    pub reveal_index: u32,
    pub revealed: bool,
    pub valid: bool,
    pub price: u64,
    pub quantity: u64,
    pub tallied_round: u32,
    pub processed: bool,
    pub allocation: u64,
    pub bump: u8,
}

/// Treasury bookkeeping (`[TREASURY, series]`); the stablecoin sits in the `treasury_token` PDA.
#[account]
#[derive(InitSpace)]
pub struct Treasury {
    pub series: Pubkey,
    /// Exact proceeds (`p* × units_sold`), known once the mint is finalised.
    pub proceeds: u64,
    pub proceeds_received: u64,
    pub released_total: u64,
    pub issuer_paused_releases: bool,
    pub early_draw_total: u64,
    pub finalized: bool,
    pub bump: u8,
}

/// Per-series repayment ledger (`[LEDGER, series]`). Zero-copy: the 64-entry `year_gross_wad`
/// table would otherwise sit on the stack during account validation. Optional periods are encoded
/// as `(value, has_*)` pairs; booleans as `u8`. Field order avoids padding (bytemuck `Pod`).
#[account(zero_copy)]
#[repr(C)]
pub struct Ledger {
    // u128
    pub paid_per_unit_wad: u128,
    pub net_acc_wad: u128,
    pub tail_acc_wad: u128,
    pub tail_paid_per_unit_wad: u128,
    pub final_acc_wad: u128,
    pub year_gross_wad: [u128; MAX_YEAR_BUCKETS],
    // u64
    pub settlement_ts: u64,
    pub open_due_amount: u64,
    pub router_credit: u64,
    pub trueup_due: u64,
    pub trueup_deadline: u64,
    pub pause_nonce: u64,
    pub pause_start: u64,
    pub pause_end: u64,
    pub paused_total: u64,
    pub cap_per_unit: u64,
    pub carry: u64,
    pub fee_collected: u64,
    pub gross_received: u64,
    pub refunded_to_issuer: u64,
    pub redemption_ts: u64,
    pub redemption_price: u64,
    pub units_at_redemption: u64,
    pub tail_cap_per_unit: u64,
    pub tail_carry: u64,
    pub final_carry: u64,
    pub extinguish_nonce: u64,
    // 32-byte
    pub series: Pubkey,
    pub last_income_commitment: [u8; 32],
    // u32 (optional values; see the `has_*` flags)
    pub first_period: u32,
    pub last_accepted_period_v: u32,
    pub last_paid_period_v: u32,
    pub open_due_period_v: u32,
    pub formal_notice_emitted_for_v: u32,
    pub last_income_period_v: u32,
    pub active_window_v: u32,
    // u8
    pub status: u8,
    pub has_last_accepted_period: u8,
    pub has_last_paid_period: u8,
    pub has_open_due_period: u8,
    pub has_formal_notice: u8,
    pub has_last_income_period: u8,
    pub has_active_window: u8,
    pub open_due_tier: u8,
    /// `true` when the open due belongs to a tail report (routes to the tail accumulators).
    pub open_due_is_tail: u8,
    pub pause_requested: u8,
    pub bump: u8,
    pub _padding: [u8; 1],
}

impl Ledger {
    /// Account size including the 8-byte discriminator.
    pub const LEN: usize = 8 + core::mem::size_of::<Ledger>();

    pub fn last_accepted_period(&self) -> Option<u32> {
        (self.has_last_accepted_period != 0).then_some(self.last_accepted_period_v)
    }
    pub fn set_last_accepted_period(&mut self, v: Option<u32>) {
        self.has_last_accepted_period = u8::from(v.is_some());
        self.last_accepted_period_v = v.unwrap_or(0);
    }
    pub fn last_paid_period(&self) -> Option<u32> {
        (self.has_last_paid_period != 0).then_some(self.last_paid_period_v)
    }
    pub fn set_last_paid_period(&mut self, v: Option<u32>) {
        self.has_last_paid_period = u8::from(v.is_some());
        self.last_paid_period_v = v.unwrap_or(0);
    }
    pub fn open_due_period(&self) -> Option<u32> {
        (self.has_open_due_period != 0).then_some(self.open_due_period_v)
    }
    pub fn set_open_due_period(&mut self, v: Option<u32>) {
        self.has_open_due_period = u8::from(v.is_some());
        self.open_due_period_v = v.unwrap_or(0);
    }
    pub fn formal_notice_emitted_for(&self) -> Option<u32> {
        (self.has_formal_notice != 0).then_some(self.formal_notice_emitted_for_v)
    }
    pub fn set_formal_notice_emitted_for(&mut self, v: Option<u32>) {
        self.has_formal_notice = u8::from(v.is_some());
        self.formal_notice_emitted_for_v = v.unwrap_or(0);
    }
    pub fn last_income_period(&self) -> Option<u32> {
        (self.has_last_income_period != 0).then_some(self.last_income_period_v)
    }
    pub fn set_last_income_period(&mut self, v: Option<u32>) {
        self.has_last_income_period = u8::from(v.is_some());
        self.last_income_period_v = v.unwrap_or(0);
    }
    pub fn active_window(&self) -> Option<u32> {
        (self.has_active_window != 0).then_some(self.active_window_v)
    }
    pub fn set_active_window(&mut self, v: Option<u32>) {
        self.has_active_window = u8::from(v.is_some());
        self.active_window_v = v.unwrap_or(0);
    }
    pub fn is_open_due_tail(&self) -> bool {
        self.open_due_is_tail != 0
    }
    pub fn is_pause_requested(&self) -> bool {
        self.pause_requested != 0
    }
}

#[cfg(test)]
mod ledger_layout {
    #[test]
    fn ledger_is_16_byte_aligned_without_padding() {
        // 5 + 64 u128 (1104) + 21 u64 (168) + 2×32 (64) + 7 u32 (28) + 11 u8 + 1 pad = 1376
        assert_eq!(core::mem::size_of::<super::Ledger>(), 1376);
        assert_eq!(core::mem::size_of::<super::Ledger>() % 16, 0);
    }
}

/// Holder record (`[HOLDER, series, wallet]`).
#[account]
#[derive(InitSpace)]
pub struct Holder {
    pub series: Pubkey,
    pub wallet: Pubkey,
    pub registered: bool,
    pub last_net_acc_wad: u128,
    pub pending: u64,
    pub redeemed_units: u64,
    pub last_tail_acc_wad: u128,
    pub last_final_acc_wad: u128,
    pub bump: u8,
}

/// Accepted report (`[REPORT, series, period]`).
#[account]
#[derive(InitSpace)]
pub struct Report {
    pub series: Pubkey,
    pub period: u32,
    pub accepted_at: u64,
    pub payment_usd: u64,
    pub fx_avg_wad: u64,
    pub fx_fallback: bool,
    pub tier: u8,
    pub liquidity_event: bool,
    pub income_commitment: [u8; 32],
    pub due: u64,
    pub accrual_paid: u64,
    pub paid_at: u64,
    pub bump: u8,
}

/// Tier 1 split router (`[ROUTER, series]`); income lands in the `router_token` PDA.
#[account]
#[derive(InitSpace)]
pub struct Router {
    pub series: Pubkey,
    pub theta: u64,
    pub r_wad: u64,
    pub ytd_year: u32,
    pub ytd_received: u64,
    pub bump: u8,
}

/// Rate accumulator (`[FX_PAIR, pair_id]`).
#[account]
#[derive(InitSpace)]
pub struct FxPair {
    pub pair_id: [u8; 32],
    pub sum_wad: u128,
    pub count: u32,
    pub last_day: u32,
    pub bump: u8,
}

/// Accumulator checkpoint at the first snapshot of a period (`[FX_CHECKPOINT, pair_id, period]`).
#[account]
#[derive(InitSpace)]
pub struct FxCheckpoint {
    pub pair_id: [u8; 32],
    pub period: u32,
    pub sum_wad: u128,
    pub count: u32,
    pub flagged: bool,
    pub bump: u8,
}

/// Transfer window (`[WINDOW, series, period]`).
#[account]
#[derive(InitSpace)]
pub struct Window {
    pub series: Pubkey,
    pub period: u32,
    pub state: u8,
    pub opens_at: u64,
    pub commit_end: u64,
    pub reveal_end: u64,
    pub bid_count: u32,
    pub ask_count: u32,
    pub revealed_bids: u32,
    pub revealed_asks: u32,
    pub escrow_units: u64,
    pub escrow_stable: u64,
    // proposal and tally
    pub clearing_price: u64,
    pub no_match_proposed: bool,
    pub d_above: u64,
    pub d_at: u64,
    pub s_below: u64,
    pub s_at: u64,
    pub max_bid: u64,
    pub min_ask: u64,
    pub valid_orders: u32,
    pub tallied: u32,
    pub tally_round: u32,
    // results
    pub matched_units: u64,
    pub remainder_for_bids_at: u64,
    pub bids_processed: u32,
    pub asks_processed: u32,
    pub bid_fills_total: u64,
    pub dust_assigned: u64,
    /// Cursor for `return_dust` ordering: last (price, reveal_index) served.
    pub dust_cursor_price: u64,
    pub dust_cursor_index: u32,
    pub dust_started: bool,
    pub bump: u8,
}

/// Window order, one per wallet per side per window (`[ORDER, series, period, owner, side]`).
#[account]
#[derive(InitSpace)]
pub struct Order {
    pub series: Pubkey,
    pub period: u32,
    pub owner: Pubkey,
    pub side: u8,
    pub commitment: [u8; 32],
    /// Stablecoin for bids, units for asks.
    pub escrow: u64,
    pub reveal_index: u32,
    pub revealed: bool,
    pub valid: bool,
    pub price: u64,
    pub quantity: u64,
    pub tallied_round: u32,
    pub processed: bool,
    pub fill: u64,
    /// Asks: `net_acc_wad` when the units were escrowed, so escrow-period payouts reach the seller.
    pub net_acc_snapshot: u128,
    /// Asks at or below `p*`: units handed back by `return_dust`.
    pub dust_received: u64,
    pub bump: u8,
}
