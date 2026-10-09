//! Transfer-window settlement beyond the parity vectors (SPEC §7, track-b B-21/B-22): the exact
//! cancelled-buyer take-back (asks at `p*` in descending reveal index, then asks below `p*` in
//! descending `(price, reveal_index)` through a tally-verified threshold), wrong threshold
//! proposals recorded instead of reverted, and two-step settlement where a recipient-side failure
//! (a frozen stablecoin account) never blocks any other order.
//!
//! Every scenario replays `10_transfer_window.json` up to the settled window (clearing price 125,
//! supply-limited, matched 35) and then diverges: the book is asks b1 20 @ 120 (reveal 0), b2 15 @
//! 125 (1), b3 10 @ 130 (2); bids b5 30 @ 125 (0, marginal), b6 20 @ 128 (1), b7 41 @ 126 (2,
//! invalid: above the wallet cap).

use anchor_lang::prelude::Pubkey;
use merces_common::vault::holder_delta;
use merces_protocol::error::ProtocolError;
use merces_protocol::state::WINDOW_SETTLED;
use merces_tests::harness::*;
use merces_tests::vectors::Runner;
use merces_tests::zkfix::vector_path;
use serde_json::Value;

const PERIOD: u32 = 8109;
const P: u64 = 125_000_000;

fn settled_window() -> Runner {
    let text = std::fs::read_to_string(vector_path("10_transfer_window.json")).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    let steps = v["steps"].as_array().unwrap();
    // the last step before `process_orders`: the expect after round 4
    let upto = steps
        .iter()
        .position(|s| s["op"] == "process_orders")
        .expect("process_orders step")
        - 1;
    let r = Runner::run_value(v, Some(upto));
    let s1 = r.series_pubkey("S1").unwrap();
    let w = r.env.window(&s1, PERIOD).unwrap();
    assert_eq!(w.state, WINDOW_SETTLED);
    assert_eq!(w.clearing_price, P);
    assert_eq!(w.matched_units, 35);
    r
}

fn who(r: &Runner, name: &str) -> Pubkey {
    r.actor_pubkey(name).unwrap()
}

fn expect_code(res: TxResult, e: ProtocolError) {
    match res {
        Ok(_) => panic!("expected {e:?}, transaction succeeded"),
        Err(f) => {
            let code = u32::from(e);
            assert!(
                format!("{:?}", f.err).contains(&format!("Custom({code})")),
                "expected {e:?} ({code}), got {:?}\n{}",
                f.err,
                f.meta.logs.join("\n")
            );
        }
    }
}

fn all_orders(r: &Runner) -> Vec<Pubkey> {
    ["b1", "b2", "b3", "b5", "b6", "b7"]
        .iter()
        .map(|n| who(r, n))
        .collect()
}

fn fill_of(r: &Runner, series: &Pubkey, owner: &Pubkey) -> u64 {
    r.env.order(series, PERIOD, owner).unwrap().fill
}

/// Sets the SPL token-account state byte (offset 108): 1 = initialized, 2 = frozen.
fn set_token_state(r: &mut Runner, account: &Pubkey, state: u8) {
    let mut acc = r.env.svm.get_account(account).expect("token account");
    acc.data[108] = state;
    r.env.svm.set_account(*account, acc).unwrap();
}

/// A cancelled full-side buyer (b6, 20 units) takes back more than the at-price asks hold
/// (b2, 15): b2 fills nothing and the remaining 5 units come off the ask below `p*` (b1), exactly
/// as the reference `computeFills` orders it. Final fills: b5 15, b1 15, b2 0.
#[test]
fn takeback_reaching_below_the_clearing_price() {
    let mut r = settled_window();
    let s1 = r.series_pubkey("S1").unwrap();
    let (b1, b2, b3, b5, b6, b7) = (
        who(&r, "b1"),
        who(&r, "b2"),
        who(&r, "b3"),
        who(&r, "b5"),
        who(&r, "b6"),
        who(&r, "b7"),
    );
    let usdc = r.env.usdc;
    let fee_before = r.env.balance_of(&r.env.fee_collector.pubkey_v(), &usdc);
    let stable = |r: &Runner, w: &Pubkey| r.env.balance_of(w, &usdc);
    let (b1_s, b5_s, b6_s, b7_s) = (
        stable(&r, &b1),
        stable(&r, &b5),
        stable(&r, &b6),
        stable(&r, &b7),
    );

    // b6 is removed from the allowlist after revealing
    r.env.allow(&b6, false).unwrap();
    // asks wait for every revealed bid
    expect_code(
        r.env.process_order(&s1, PERIOD, &b1),
        ProtocolError::BidsNotProcessed,
    );
    // bids in reveal order: b5 (marginal), b6 (cancelled), b7 (invalid)
    expect_code(
        r.env.process_order(&s1, PERIOD, &b6),
        ProtocolError::OutOfOrder,
    );
    for b in [b5, b6, b7] {
        r.env.process_order(&s1, PERIOD, &b).unwrap();
    }
    let w = r.env.window(&s1, PERIOD).unwrap();
    assert_eq!(w.cancelled_units, 20);
    assert_eq!(w.ask_at_total, 15);
    assert_eq!(fill_of(&r, &s1, &b5), 15);
    assert_eq!(fill_of(&r, &s1, &b6), 0);
    // the ask below p* needs the threshold first
    expect_code(
        r.env.process_order(&s1, PERIOD, &b1),
        ProtocolError::TakebackRequired,
    );
    // a wrong proposal (b2 sits at p*, not below it) is recorded, not reverted
    r.env.begin_takeback(&s1, PERIOD, P, 1).unwrap();
    expect_code(
        r.env.begin_takeback(&s1, PERIOD, 120_000_000, 0),
        ProtocolError::TakebackInProgress,
    );
    let owners = all_orders(&r);
    r.env.tally_takeback(&s1, PERIOD, &owners[..2]).unwrap();
    expect_code(
        r.env.finalize_takeback(&s1, PERIOD),
        ProtocolError::TallyIncomplete,
    );
    r.env.tally_takeback(&s1, PERIOD, &owners).unwrap();
    r.env.finalize_takeback(&s1, PERIOD).unwrap();
    let w = r.env.window(&s1, PERIOD).unwrap();
    assert!(w.tb_rejected && !w.tb_settled);
    // the right threshold: b1 (120, reveal 0) gives back R = 20 − 15 = 5
    r.env.begin_takeback(&s1, PERIOD, 120_000_000, 0).unwrap();
    r.env.tally_takeback(&s1, PERIOD, &owners).unwrap();
    r.env.finalize_takeback(&s1, PERIOD).unwrap();
    let w = r.env.window(&s1, PERIOD).unwrap();
    assert!(w.tb_settled);
    assert_eq!(w.tb_partial, 5);
    expect_code(
        r.env.begin_takeback(&s1, PERIOD, 120_000_000, 0),
        ProtocolError::TakebackAlreadySettled,
    );
    for a in [b1, b2, b3] {
        r.env.process_order(&s1, PERIOD, &a).unwrap();
    }
    assert_eq!(fill_of(&r, &s1, &b1), 15);
    assert_eq!(fill_of(&r, &s1, &b2), 0);
    assert_eq!(fill_of(&r, &s1, &b3), 0);
    // the window is done once every order is processed: the ledger releases it
    assert_eq!(r.env.ledger(&s1).unwrap().active_window(), None);
    for o in &owners {
        r.env.deliver_order(&s1, PERIOD, o).unwrap();
    }
    expect_code(
        r.env.deliver_order(&s1, PERIOD, &b1),
        ProtocolError::OrderAlreadyDelivered,
    );
    let p = pdas(s1);
    assert_eq!(r.env.token_balance(&p.window_stable), 0);
    assert_eq!(r.env.token_balance(&p.window_escrow_ata), 0);
    let units = |r: &Runner, w: &Pubkey| r.env.token_balance(&ata(w, &p.unit_mint, &TOKEN_2022));
    assert_eq!(units(&r, &b1), 85);
    assert_eq!(units(&r, &b2), 100);
    assert_eq!(units(&r, &b3), 100);
    assert_eq!(units(&r, &b5), 15);
    assert_eq!(units(&r, &b6), 0);
    let cost = 15 * P;
    let fee = cost / 100;
    assert_eq!(stable(&r, &b1), b1_s + cost);
    assert_eq!(stable(&r, &b5), b5_s + 3_787_500_000 - cost - fee);
    assert_eq!(stable(&r, &b6), b6_s + 2_585_600_000);
    assert_eq!(stable(&r, &b7), b7_s + 5_217_660_000);
    assert_eq!(
        r.env.balance_of(&r.env.fee_collector.pubkey_v(), &usdc),
        fee_before + fee
    );
    for w in [b1, b2, b3, b5] {
        let h = r.env.holder(&s1, &w).unwrap();
        assert_eq!(h.window_pending_units, 0);
        assert_eq!(h.ask_escrow_units, 0);
    }
    // a buyer cancelled at fill leaves no holder record behind
    assert!(r.env.holder(&s1, &b6).is_none());
}

/// A cancelled marginal buyer (b5, 15 units at p*) is absorbed entirely by the at-price ask (b2):
/// no threshold round is needed and the ask below p* fills in full.
#[test]
fn takeback_confined_to_the_clearing_price() {
    let mut r = settled_window();
    let s1 = r.series_pubkey("S1").unwrap();
    let (b1, b2, b3, b5, b6, b7) = (
        who(&r, "b1"),
        who(&r, "b2"),
        who(&r, "b3"),
        who(&r, "b5"),
        who(&r, "b6"),
        who(&r, "b7"),
    );
    r.env.allow(&b5, false).unwrap();
    for b in [b5, b6, b7] {
        r.env.process_order(&s1, PERIOD, &b).unwrap();
    }
    let w = r.env.window(&s1, PERIOD).unwrap();
    assert_eq!(w.cancelled_units, 15);
    expect_code(
        r.env.begin_takeback(&s1, PERIOD, 120_000_000, 0),
        ProtocolError::TakebackNotRequired,
    );
    for a in [b1, b2, b3] {
        r.env.process_order(&s1, PERIOD, &a).unwrap();
    }
    assert_eq!(fill_of(&r, &s1, &b6), 20);
    assert_eq!(fill_of(&r, &s1, &b5), 0);
    assert_eq!(fill_of(&r, &s1, &b1), 20);
    assert_eq!(fill_of(&r, &s1, &b2), 0);
    for o in all_orders(&r) {
        r.env.deliver_order(&s1, PERIOD, &o).unwrap();
    }
    let p = pdas(s1);
    assert_eq!(r.env.token_balance(&p.window_stable), 0);
    assert_eq!(r.env.token_balance(&p.window_escrow_ata), 0);
}

/// Two-step settlement: with the seller's stablecoin account frozen, every order still processes,
/// every other delivery succeeds, the window closes, and the frozen delivery succeeds on retry once
/// the account thaws (SPEC §12 liveness).
#[test]
fn frozen_recipient_never_blocks_other_orders() {
    let mut r = settled_window();
    let s1 = r.series_pubkey("S1").unwrap();
    let usdc = r.env.usdc;
    let b1 = who(&r, "b1");
    let b1_usdc = r.env.ata_of(&b1, &usdc);
    let b1_before = r.env.balance_of(&b1, &usdc);
    set_token_state(&mut r, &b1_usdc, 2);
    let owners = all_orders(&r);
    // processing order: bids by reveal index, then asks by reveal index
    for name in ["b5", "b6", "b7", "b1", "b2", "b3"] {
        let w = who(&r, name);
        r.env.process_order(&s1, PERIOD, &w).unwrap();
    }
    assert_eq!(r.env.ledger(&s1).unwrap().active_window(), None);
    assert!(r.env.deliver_order(&s1, PERIOD, &b1).is_err());
    for o in owners.iter().filter(|o| **o != b1) {
        r.env.deliver_order(&s1, PERIOD, o).unwrap();
    }
    // b1's 20 units sold: proceeds and nothing else wait in the window escrow
    let p = pdas(s1);
    assert_eq!(r.env.token_balance(&p.window_stable), 20 * P);
    assert_eq!(r.env.token_balance(&p.window_escrow_ata), 0);
    set_token_state(&mut r, &b1_usdc, 1);
    r.env.deliver_order(&s1, PERIOD, &b1).unwrap();
    assert_eq!(r.env.balance_of(&b1, &usdc), b1_before + 20 * P);
    assert_eq!(r.env.token_balance(&p.window_stable), 0);
}

/// C-S4 (money safety): a payout that lands between a matched bid's processing and the matching
/// ask's processing must not be earned twice on the sold units — once by the buyer's pending units,
/// once by the seller's still-escrowed units — or the vault goes insolvent. The window clears
/// (matched 35 @ 125), the winning bids are processed (the buyers now hold the sold units as
/// window-pending), a report is paid into the gap, and then every holder must be able to claim
/// without draining the vault: the seller's cleared escrow earns only up to the clearing snapshot,
/// so the gap payout on the sold units is the buyers' alone. Then the asks are processed (the
/// returned units carry their gap share to the sellers) and, once everyone has claimed, only
/// rounding dust is left.
#[test]
fn window_payout_in_the_gap_keeps_the_vault_solvent() {
    let mut r = settled_window();
    let s1 = r.series_pubkey("S1").unwrap();
    let p = pdas(s1);
    let usdc = r.env.usdc;
    let holders: Vec<Pubkey> = ["b1", "b2", "b3", "b4", "b5", "b6"]
        .iter()
        .map(|n| who(&r, n))
        .collect();
    let (b1, b2, b3) = (who(&r, "b1"), who(&r, "b2"), who(&r, "b3"));
    let (b5, b6, b7) = (who(&r, "b5"), who(&r, "b6"), who(&r, "b7"));

    // the winning bids are processed: the buyers now hold the 35 sold units as window-pending
    for b in [b5, b6, b7] {
        r.env.process_order(&s1, PERIOD, &b).unwrap();
    }

    // a report is paid while the matching asks are still escrowed — the C-S4 gap
    let steps = r.vector()["steps"].as_array().unwrap().clone();
    let net_before = r.env.ledger(&s1).unwrap().net_acc_wad;
    r.step(82, &steps[82]); // submit_report(8110)
    r.step(83, &steps[83]); // pay
    let l = r.env.ledger(&s1).unwrap();
    assert!(
        l.net_acc_wad > net_before,
        "the gap payout must advance the accumulator"
    );
    assert!(
        l.window_cleared(),
        "the cleared window is still unprocessed, so the escrow cap is live"
    );
    let vault_mid = r.env.token_balance(&p.vault_token);

    // solvency across the gap: every holder can claim right now and the total never exceeds the
    // vault (without the cap the sold units would pay both buyer and seller and a claim would fail)
    let mut paid = 0u64;
    for w in &holders {
        let before = r.env.balance_of(w, &usdc);
        r.env.claim(&s1, w).unwrap();
        paid += r.env.balance_of(w, &usdc) - before;
    }
    assert!(
        paid <= vault_mid,
        "gap claims {paid} exceeded the vault {vault_mid} (double-counted sold units)"
    );

    // the asks are processed and everything is delivered: the returned units carry their gap share
    // to the sellers, the sold units stay with the buyers, and the window closes
    for a in [b1, b2, b3] {
        r.env.process_order(&s1, PERIOD, &a).unwrap();
    }
    assert_eq!(r.env.ledger(&s1).unwrap().active_window(), None);
    assert!(!r.env.ledger(&s1).unwrap().window_cleared());
    for o in [b1, b2, b3, b5, b6, b7] {
        r.env.deliver_order(&s1, PERIOD, &o).unwrap();
    }

    // a final claim settles the credited returns; afterwards nothing is owed and the vault holds
    // only the exact WAD carry dust
    for w in &holders {
        r.env.claim(&s1, w).unwrap();
    }
    let l = r.env.ledger(&s1).unwrap();
    let mut claimable = 0u128;
    for w in &holders {
        let balance = r.env.token_balance(&ata(w, &p.unit_mint, &TOKEN_2022));
        let h = r.env.holder(&s1, w).unwrap();
        assert_eq!(h.ask_escrow_units, 0);
        assert_eq!(h.window_pending_units, 0);
        claimable += u128::from(h.pending)
            + u128::from(holder_delta(l.net_acc_wad, h.last_net_acc_wad, balance).unwrap());
    }
    assert_eq!(claimable, 0, "every payout is claimed");
    let vault_end = r.env.token_balance(&p.vault_token);
    assert!(
        u128::from(vault_end) < u128::from(l.units_outstanding),
        "only rounding dust remains, got {vault_end}"
    );
}

trait PubkeyOf {
    fn pubkey_v(&self) -> Pubkey;
}

impl PubkeyOf for solana_keypair::Keypair {
    fn pubkey_v(&self) -> Pubkey {
        solana_signer::Signer::pubkey(self)
    }
}
