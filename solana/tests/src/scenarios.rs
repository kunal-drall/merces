//! Scenarios that are not parity vectors, shared by the measurement test and the scenario tests:
//! worst-case settlement pages and the window take-back flow.

use anchor_lang::prelude::Pubkey;
use merces_common::window::below_takeback;
use merces_protocol::state::{SIDE_ASK, TALLY_PAGE};
use serde_json::Value;
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::harness::*;
use crate::vectors::Runner;
use crate::zkfix::vector_path;

/// A raise of 1,000 units with `bidders` valid bids (50 units each, distinct prices from the
/// reserve upwards, oversubscribed), settled with the honest proposal, tallied in pages of 24,
/// processed and delivered. Returns the environment and the series.
pub fn full_page_auction(bidders: usize) -> (Env, Pubkey, Vec<Keypair>) {
    let mut env = Env::new();
    let issuer = env.new_wallet();
    let usdc = env.usdc;
    let mut args = Env::default_series_args([8u8; 32]);
    args.units_offered = 1_000;
    args.reserve_price = 100 * ONE_USDC;
    args.min_raise = 10_000 * ONE_USDC;
    let series = env.setup_series(&issuer, &usdc, args);
    env.open_raise(&issuer, &series).unwrap();
    let mut wallets = Vec::new();
    let mut book = Vec::new();
    for i in 0..bidders {
        let w = env.new_wallet();
        env.allow(&w.pubkey(), true).unwrap();
        let price = (100 + i as u64) * ONE_USDC;
        let qty = 50u64;
        env.fund(&w.pubkey(), &usdc, price * qty * 2);
        let s = salt(i as u8);
        env.commit_bid(
            &series,
            &w,
            commitment(price, qty, &s, &w.pubkey()),
            price * qty * 2,
        )
        .unwrap();
        book.push((price, qty, s));
        wallets.push(w);
    }
    let a = env.auction(&series).unwrap();
    env.warp(a.commit_end);
    for (w, (price, qty, s)) in wallets.iter().zip(&book) {
        env.reveal_bid(&series, w, *price, *qty, *s).unwrap();
    }
    env.warp(a.reveal_end);
    // the honest proposal: the lowest price whose cumulative demand from the top reaches N
    let n = 1_000u64;
    let mut prices: Vec<u64> = book.iter().map(|b| b.0).collect();
    prices.sort_unstable_by(|a, b| b.cmp(a));
    let mut clearing = (0u64, 0u64, 0u64);
    for p in prices {
        let above: u64 = book.iter().filter(|b| b.0 > p).map(|b| b.1).sum();
        let at: u64 = book.iter().filter(|b| b.0 == p).map(|b| b.1).sum();
        if above < n && above + at >= n {
            clearing = (p, above, at);
            break;
        }
    }
    let keys: Vec<Pubkey> = wallets.iter().map(|w| w.pubkey()).collect();
    env.begin_settlement(&series, clearing.0, clearing.1, clearing.2)
        .unwrap();
    for page in keys.chunks(TALLY_PAGE) {
        env.tally_bids(&series, page).unwrap();
    }
    env.finalize_settlement(&series).unwrap();
    for k in &keys {
        env.process_bid(&series, k).unwrap();
    }
    for k in &keys {
        env.deliver_bid(&series, k).unwrap();
    }
    (env, series, wallets)
}

/// `10_transfer_window.json` replayed to its settled window, then b6 (a full-side buyer of 20)
/// is de-allowlisted so the take-back reaches below the clearing price; the window is processed
/// (threshold round included) and every order delivered.
pub fn takeback_window() -> Runner {
    let text = std::fs::read_to_string(vector_path("10_transfer_window.json")).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    let steps = v["steps"].as_array().unwrap();
    let upto = steps
        .iter()
        .position(|s| s["op"] == "process_orders")
        .unwrap()
        - 1;
    let mut r = Runner::run_value(v, Some(upto));
    let series = r.series_pubkey("S1").unwrap();
    let period = 8109;
    let names = ["b5", "b6", "b7", "b1", "b2", "b3"];
    let owners: Vec<Pubkey> = names.iter().map(|n| r.actor_pubkey(n).unwrap()).collect();
    r.env.allow(&owners[1], false).unwrap();
    for o in &owners[..3] {
        r.env.process_order(&series, period, o).unwrap();
    }
    let w = r.env.window(&series, period).unwrap();
    let r_below = below_takeback(w.ask_at_total, w.cancelled_units);
    assert!(r_below > 0);
    let mut asks: Vec<(u64, u32, u64)> = owners
        .iter()
        .filter_map(|o| r.env.order(&series, period, o))
        .filter(|o| o.side == SIDE_ASK && o.revealed && o.valid && o.price < w.clearing_price)
        .map(|o| (o.price, o.reveal_index, o.quantity))
        .collect();
    asks.sort_by_key(|a| core::cmp::Reverse((a.0, a.1)));
    let mut above = 0u64;
    let mut k = None;
    for (p, i, q) in asks {
        if above < r_below && r_below <= above + q {
            k = Some((p, i));
            break;
        }
        above += q;
    }
    let (p, i) = k.unwrap();
    r.env.begin_takeback(&series, period, p, i).unwrap();
    r.env.tally_takeback(&series, period, &owners).unwrap();
    r.env.finalize_takeback(&series, period).unwrap();
    for o in &owners[3..] {
        r.env.process_order(&series, period, o).unwrap();
    }
    for o in &owners {
        r.env.deliver_order(&series, period, o).unwrap();
    }
    r
}
