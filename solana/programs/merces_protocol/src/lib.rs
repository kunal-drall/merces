//! Merces protocol program: auction (D3), treasury (D4), split router (D5), ProofOfIncome
//! verifier (D6), payout vault (D7), redemption / tail / pause / extinguishment (D8), transfer
//! window (D9) and rate accumulator (C9). One program so every money module shares one per-series
//! ledger (SPEC §0). Upgradeable through the multisig + timelock upgrade authority only; it writes
//! to the registry solely through the §3.2 interface signed by its `registry_authority` PDA.
#![allow(unexpected_cfgs)]
#![allow(clippy::too_many_arguments)]

use anchor_lang::prelude::*;

pub mod claims;
pub mod common;
pub mod error;
pub mod events;
pub mod exit;
pub mod fx;
pub mod income;
pub mod raise;
pub mod router;
pub mod state;
pub mod treasury;
pub mod window;
pub mod zk;

use claims::*;
use exit::*;
use fx::*;
use income::*;
use raise::*;
use router::*;
use treasury::*;
use window::*;

declare_id!("EuaPg2nTXsf3CmmeJMfdiQb4C2hU7AfLfFyDLpD69six");

#[program]
pub mod merces_protocol {
    use super::*;

    // ---- raise path (SPEC §5)
    pub fn prepare_raise(ctx: Context<PrepareRaise>) -> Result<()> {
        raise::prepare_raise(ctx)
    }
    pub fn open_raise(ctx: Context<OpenRaise>) -> Result<()> {
        raise::open_raise(ctx)
    }
    pub fn cancel_raise(ctx: Context<CancelRaise>) -> Result<()> {
        raise::cancel_raise(ctx)
    }
    pub fn commit_bid<'info>(
        ctx: Context<'info, CommitBid<'info>>,
        commitment: [u8; 32],
        escrow: u64,
    ) -> Result<()> {
        raise::commit_bid(ctx, commitment, escrow)
    }
    pub fn reveal_bid(
        ctx: Context<RevealBid>,
        price: u64,
        quantity: u64,
        salt: [u8; 32],
    ) -> Result<()> {
        raise::reveal_bid(ctx, price, quantity, salt)
    }
    pub fn begin_settlement(
        ctx: Context<BeginSettlement>,
        clearing_price: u64,
        q_above_claim: u64,
        q_at_claim: u64,
    ) -> Result<()> {
        raise::begin_settlement(ctx, clearing_price, q_above_claim, q_at_claim)
    }
    pub fn tally_bids<'info>(ctx: Context<'info, TallyBids<'info>>) -> Result<()> {
        raise::tally_bids(ctx)
    }
    pub fn finalize_settlement(ctx: Context<FinalizeSettlement>) -> Result<()> {
        raise::finalize_settlement(ctx)
    }
    pub fn process_bid<'info>(ctx: Context<'info, ProcessBid<'info>>) -> Result<()> {
        raise::process_bid(ctx)
    }
    pub fn deliver_bid<'info>(ctx: Context<'info, DeliverBid<'info>>) -> Result<()> {
        raise::deliver_bid(ctx)
    }

    // ---- treasury (SPEC §5.3)
    pub fn claim_release<'info>(ctx: Context<'info, ClaimRelease<'info>>) -> Result<()> {
        treasury::claim_release(ctx)
    }
    pub fn set_release_pause(ctx: Context<SetReleasePause>, paused: bool) -> Result<()> {
        treasury::set_release_pause(ctx, paused)
    }
    pub fn request_early_draw<'info>(
        ctx: Context<'info, RequestEarlyDraw<'info>>,
        amount: u64,
    ) -> Result<()> {
        treasury::request_early_draw(ctx, amount)
    }

    // ---- repayment path (SPEC §6)
    pub fn submit_report(ctx: Context<SubmitReport>, args: SubmitReportArgs) -> Result<()> {
        income::submit_report(ctx, args)
    }
    pub fn pay<'info>(ctx: Context<'info, Pay<'info>>) -> Result<()> {
        income::pay(ctx)
    }
    pub fn submit_trueup(
        ctx: Context<SubmitTrueUp>,
        year: u16,
        adjustment: i64,
        attestation_ts: u64,
        attestor_addr: [u8; 20],
        attestor_sig: [u8; 65],
    ) -> Result<()> {
        income::submit_trueup(
            ctx,
            year,
            adjustment,
            attestation_ts,
            attestor_addr,
            attestor_sig,
        )
    }
    pub fn pay_trueup<'info>(ctx: Context<'info, Pay<'info>>) -> Result<()> {
        income::pay_trueup(ctx)
    }
    pub fn crank_status(ctx: Context<CrankStatus>) -> Result<()> {
        income::crank_status(ctx)
    }
    pub fn retire_if_capped(ctx: Context<RetireIfCapped>) -> Result<()> {
        income::retire_if_capped(ctx)
    }
    pub fn request_pause(ctx: Context<IssuerLedger>) -> Result<()> {
        income::request_pause(ctx)
    }
    pub fn withdraw_pause_request(ctx: Context<IssuerLedger>) -> Result<()> {
        income::withdraw_pause_request(ctx)
    }
    pub fn approve_pause(
        ctx: Context<ApprovePause>,
        pause_end: u64,
        attestor_addr: [u8; 20],
        attestor_sig: [u8; 65],
    ) -> Result<()> {
        income::approve_pause(ctx, pause_end, attestor_addr, attestor_sig)
    }
    pub fn end_pause(ctx: Context<IssuerLedger>) -> Result<()> {
        income::end_pause(ctx)
    }

    // ---- claims (SPEC §6.3, §6.7–§6.9)
    pub fn register_holder(ctx: Context<RegisterHolder>, wallet: Pubkey) -> Result<()> {
        claims::register_holder(ctx, wallet)
    }
    pub fn claim<'info>(ctx: Context<'info, HolderClaim<'info>>) -> Result<()> {
        claims::claim(ctx)
    }
    pub fn burn_retired<'info>(ctx: Context<'info, HolderClaim<'info>>) -> Result<()> {
        claims::burn_retired(ctx)
    }
    pub fn claim_redemption<'info>(ctx: Context<'info, HolderClaim<'info>>) -> Result<()> {
        claims::claim_redemption(ctx)
    }
    pub fn claim_tail<'info>(ctx: Context<'info, HolderClaim<'info>>) -> Result<()> {
        claims::claim_tail(ctx)
    }
    pub fn claim_final<'info>(ctx: Context<'info, HolderClaim<'info>>) -> Result<()> {
        claims::claim_final(ctx)
    }

    // ---- tier 1 router (SPEC §6.5)
    pub fn init_router(ctx: Context<InitRouter>) -> Result<()> {
        router::init_router(ctx)
    }
    pub fn route<'info>(ctx: Context<'info, Route<'info>>) -> Result<()> {
        router::route(ctx)
    }
    pub fn close_router_period(ctx: Context<CloseRouterPeriod>, period: u32) -> Result<()> {
        router::close_router_period(ctx, period)
    }

    // ---- rate accumulator (SPEC §6.6)
    pub fn init_fx_pair(ctx: Context<InitFxPair>, pair_id: [u8; 32]) -> Result<()> {
        fx::init_fx_pair(ctx, pair_id)
    }
    pub fn snapshot_fx(ctx: Context<SnapshotFx>, period: u32) -> Result<()> {
        fx::snapshot_fx(ctx, period)
    }

    // ---- exit (SPEC §6.7, §6.9)
    pub fn redeem<'info>(ctx: Context<'info, Redeem<'info>>) -> Result<()> {
        exit::redeem(ctx)
    }
    pub fn extinguish<'info>(
        ctx: Context<'info, Extinguish<'info>>,
        attestor_a: [u8; 20],
        sig_a: [u8; 65],
        attestor_b: [u8; 20],
        sig_b: [u8; 65],
    ) -> Result<()> {
        exit::extinguish(ctx, attestor_a, sig_a, attestor_b, sig_b)
    }

    // ---- transfer window (SPEC §7)
    pub fn open_window(ctx: Context<OpenWindow>, period: u32) -> Result<()> {
        window::open_window(ctx, period)
    }
    pub fn commit_ask<'info>(
        ctx: Context<'info, CommitAsk<'info>>,
        commitment: [u8; 32],
        units: u64,
    ) -> Result<()> {
        window::commit_ask(ctx, commitment, units)
    }
    pub fn window_commit_bid<'info>(
        ctx: Context<'info, WindowCommitBid<'info>>,
        commitment: [u8; 32],
        escrow: u64,
    ) -> Result<()> {
        window::window_commit_bid(ctx, commitment, escrow)
    }
    pub fn reveal_order(
        ctx: Context<RevealOrder>,
        price: u64,
        quantity: u64,
        salt: [u8; 32],
    ) -> Result<()> {
        window::reveal_order(ctx, price, quantity, salt)
    }
    pub fn begin_window_settlement(
        ctx: Context<WindowSettle>,
        clearing_price: u64,
        no_match: bool,
    ) -> Result<()> {
        window::begin_window_settlement(ctx, clearing_price, no_match)
    }
    pub fn tally_orders<'info>(ctx: Context<'info, WindowSettle<'info>>) -> Result<()> {
        window::tally_orders(ctx)
    }
    pub fn finalize_window(ctx: Context<WindowSettle>) -> Result<()> {
        window::finalize_window(ctx)
    }
    pub fn process_order<'info>(ctx: Context<'info, ProcessOrder<'info>>) -> Result<()> {
        window::process_order(ctx)
    }
}
