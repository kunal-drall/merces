//! Protocol events (SPEC v1.1 §10). Field names match the EVM events (camelCase there).

use anchor_lang::prelude::*;

#[event]
pub struct RaiseOpened {
    pub series: Pubkey,
    pub unit_mint: Pubkey,
    pub opened_at: u64,
    pub commit_end: u64,
    pub reveal_end: u64,
}

#[event]
pub struct RaiseCancelled {
    pub series: Pubkey,
}

#[event]
pub struct BidCommitted {
    pub series: Pubkey,
    pub bidder: Pubkey,
    pub escrow: u64,
}

#[event]
pub struct BidRevealed {
    pub series: Pubkey,
    pub bidder: Pubkey,
    pub price: u64,
    pub quantity: u64,
    pub valid: bool,
}

#[event]
pub struct SettlementProposed {
    pub series: Pubkey,
    pub clearing_price: u64,
    pub round: u32,
}

/// `reason`: 1 = ClaimMismatch, 2 = InvalidClearingPrice.
#[event]
pub struct SettlementRejected {
    pub series: Pubkey,
    pub round: u32,
    pub clearing_price: u64,
    pub reason: u8,
}

#[event]
pub struct RaiseSettled {
    pub series: Pubkey,
    pub clearing_price: u64,
    pub units_sold: u64,
    pub proceeds: u64,
    pub settlement_ts: u64,
}

#[event]
pub struct RaiseFailed {
    pub series: Pubkey,
    pub clearing_price: u64,
    pub proceeds: u64,
    pub min_raise: u64,
}

#[event]
pub struct UnitsAllocated {
    pub series: Pubkey,
    pub bidder: Pubkey,
    pub units: u64,
    pub cost: u64,
    pub fee: u64,
    pub refund: u64,
}

#[event]
pub struct BidDelivered {
    pub series: Pubkey,
    pub bidder: Pubkey,
    pub units: u64,
    pub refund: u64,
}

#[event]
pub struct NonRevealCharged {
    pub series: Pubkey,
    pub bidder: Pubkey,
    pub charge: u64,
}

#[event]
pub struct RaiseMintFinalized {
    pub series: Pubkey,
    pub units_sold: u64,
    pub proceeds: u64,
}

#[event]
pub struct MintAuthorityRevoked {
    pub series: Pubkey,
}

#[event]
pub struct ReleaseClaimed {
    pub series: Pubkey,
    pub amount: u64,
    pub released_total: u64,
}

#[event]
pub struct ReleasePauseSet {
    pub series: Pubkey,
    pub paused: bool,
}

#[event]
pub struct EarlyDrawExecuted {
    pub series: Pubkey,
    pub amount: u64,
    pub approver: Pubkey,
}

#[event]
pub struct ReportAccepted {
    pub series: Pubkey,
    pub period: u32,
    pub payment_usd: u64,
    pub fx_avg_wad: u64,
    pub fx_fallback: bool,
    pub tier: u8,
    pub liquidity_event: bool,
    pub income_commitment: [u8; 32],
    pub due: u64,
}

#[event]
pub struct PaymentSettled {
    pub series: Pubkey,
    pub period: u32,
    pub gross: u64,
    pub accrual: u64,
    pub fee: u64,
    pub accepted: u64,
    pub refunded: u64,
}

/// `source`: 0 = Payment, 1 = Router, 2 = Tail, 3 = Final.
#[event]
pub struct PayoutDistributed {
    pub series: Pubkey,
    pub source: u8,
    pub gross: u64,
    pub accepted: u64,
    pub fee: u64,
    pub net_added: u64,
    pub delta_acc_wad: u128,
    pub paid_per_unit_wad: u128,
    pub retired: bool,
}

#[event]
pub struct PayoutClaimed {
    pub series: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
    pub burned_units: u64,
}

#[event]
pub struct HolderRegistered {
    pub series: Pubkey,
    pub holder: Pubkey,
}

/// `reason`: 0 = Retired, 1 = Redeemed, 2 = Extinguished.
#[event]
pub struct UnitsBurned {
    pub series: Pubkey,
    pub holder: Pubkey,
    pub units: u64,
    pub reason: u8,
}

#[event]
pub struct SeriesRetired {
    pub series: Pubkey,
    pub paid_per_unit_wad: u128,
    pub refund: u64,
}

#[event]
pub struct StatusChanged {
    pub series: Pubkey,
    pub old: u8,
    pub new: u8,
}

/// `trueup == false`: the report countdown of `period` reached the formal-notice threshold.
/// `trueup == true`: the true-up of calendar year `period` did (SPEC §6.4, `FormalNoticeDue(series, trueup)`).
#[event]
pub struct FormalNoticeDue {
    pub series: Pubkey,
    pub period: u32,
    pub trueup: bool,
}

#[event]
pub struct PauseRequested {
    pub series: Pubkey,
    pub nonce: u64,
}

#[event]
pub struct PauseRequestWithdrawn {
    pub series: Pubkey,
    pub nonce: u64,
}

#[event]
pub struct PauseApproved {
    pub series: Pubkey,
    pub start: u64,
    pub end: u64,
    pub attestor: [u8; 20],
}

#[event]
pub struct PauseEnded {
    pub series: Pubkey,
    pub paused_total: u64,
}

#[event]
pub struct IncomeRouted {
    pub series: Pubkey,
    pub amount: u64,
    pub pass_through: u64,
    pub routed: u64,
    pub ytd_received: u64,
}

#[event]
pub struct RouterPeriodClosed {
    pub series: Pubkey,
    pub period: u32,
    pub ytd_at_end: u64,
}

#[event]
pub struct TrueUpRecorded {
    pub series: Pubkey,
    pub year: u16,
    pub adjustment: i64,
    pub deadline: u64,
}

#[event]
pub struct TrueUpPaid {
    pub series: Pubkey,
    pub amount: u64,
    pub accrual: u64,
}

#[event]
pub struct FxSnapshot {
    pub pair: [u8; 32],
    pub day: u32,
    pub rate_wad: u64,
    pub sum_wad: u128,
    pub count: u32,
}

#[event]
pub struct FxDeviationFlagged {
    pub pair: [u8; 32],
    pub period: u32,
    pub rate_wad: u64,
    pub crosscheck_wad: u64,
}

#[event]
pub struct SeriesRedeemed {
    pub series: Pubkey,
    pub price: u64,
    pub hurdle: u64,
    pub d_avg: u64,
    pub cap_remaining: u64,
    pub units: u64,
    pub deposit: u64,
}

#[event]
pub struct RedemptionClaimed {
    pub series: Pubkey,
    pub holder: Pubkey,
    pub units: u64,
    pub amount: u64,
}

#[event]
pub struct TailDistributed {
    pub series: Pubkey,
    pub period: u32,
    pub gross: u64,
    pub accepted: u64,
    pub fee: u64,
    pub refunded: u64,
}

#[event]
pub struct TailClaimed {
    pub series: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SeriesExtinguished {
    pub series: Pubkey,
    pub unreleased: u64,
    pub attestor_a: [u8; 20],
    pub attestor_b: [u8; 20],
}

#[event]
pub struct FinalClaimed {
    pub series: Pubkey,
    pub holder: Pubkey,
    pub units: u64,
    pub amount: u64,
}

#[event]
pub struct WindowOpened {
    pub series: Pubkey,
    pub period: u32,
    pub commit_end: u64,
    pub reveal_end: u64,
}

#[event]
pub struct OrderCommitted {
    pub series: Pubkey,
    pub period: u32,
    pub owner: Pubkey,
    pub side: u8,
    pub escrow: u64,
}

#[event]
pub struct OrderRevealed {
    pub series: Pubkey,
    pub period: u32,
    pub owner: Pubkey,
    pub side: u8,
    pub price: u64,
    pub quantity: u64,
    pub valid: bool,
}

/// Window settlement proposal (Solana addition mirroring the auction's `SettlementProposed`;
/// SPEC §12: every state transition emits an event). `no_match = true` proposes `NO_MATCH`
/// (`clearing_price` is then `u64::MAX`).
#[event]
pub struct WindowSettlementProposed {
    pub series: Pubkey,
    pub period: u32,
    pub clearing_price: u64,
    pub no_match: bool,
    pub round: u32,
}

/// Take-back threshold proposal (Solana addition, SPEC §7 cancelled-buyer take-back from the asks
/// below `p*`): the order with key `(price, reveal_index)` is proposed as the last one cut.
#[event]
pub struct WindowTakebackProposed {
    pub series: Pubkey,
    pub period: u32,
    pub price: u64,
    pub reveal_index: u32,
    pub round: u32,
}

/// A take-back proposal that failed the tally check (never a revert).
#[event]
pub struct WindowTakebackRejected {
    pub series: Pubkey,
    pub period: u32,
    pub round: u32,
}

/// The take-back threshold is settled: `below_units` units come off the asks below `p*`.
#[event]
pub struct WindowTakebackSettled {
    pub series: Pubkey,
    pub period: u32,
    pub cancelled_units: u64,
    pub below_units: u64,
    pub price: u64,
    pub reveal_index: u32,
    pub partial: u64,
}

/// `deliver_order` paid what a processed window order owes its owner (Solana addition mirroring
/// `BidDelivered`): `units` (bid fill or ask return) and `amount` of stablecoin (bid refund or ask
/// proceeds).
#[event]
pub struct OrderDelivered {
    pub series: Pubkey,
    pub period: u32,
    pub owner: Pubkey,
    pub side: u8,
    pub units: u64,
    pub amount: u64,
}

/// `reason`: 1 = NoMatchInvalid, 2 = PriceNotRevealed, 3 = NoCrossing. `clearing_price` is
/// `u64::MAX` for a rejected `NO_MATCH` proposal.
#[event]
pub struct WindowSettlementRejected {
    pub series: Pubkey,
    pub period: u32,
    pub clearing_price: u64,
    pub reason: u8,
}

/// `branch`: 0 = SupplyLimited, 1 = DemandLimited.
#[event]
pub struct WindowCleared {
    pub series: Pubkey,
    pub period: u32,
    pub clearing_price: u64,
    pub matched_units: u64,
    pub branch: u8,
}

#[event]
pub struct WindowNoMatch {
    pub series: Pubkey,
    pub period: u32,
}

#[event]
pub struct OrderFilled {
    pub series: Pubkey,
    pub period: u32,
    pub owner: Pubkey,
    pub side: u8,
    pub fill: u64,
    pub price: u64,
    pub fee: u64,
    pub refund: u64,
}
