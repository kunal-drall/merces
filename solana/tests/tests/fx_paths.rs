//! Rate-accumulator paths beyond the parity vectors (SPEC §3.1, §6.6): cross-check feed changes
//! never alter the rule of a running quarter, snapshots stay permissionless for a disabled pair,
//! and a quarter without a single snapshot can still be reported with an attestor fallback rate.

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey;
use merces_common::time::{period_of, period_start, DAY};
use merces_protocol::error::ProtocolError;
use merces_registry::error::RegistryError;
use merces_tests::harness::*;
use merces_tests::vectors::Runner;
use merces_tests::zkfix::vector_path;
use serde_json::Value;

fn expect_code(res: TxResult, code: u32) {
    match res {
        Ok(_) => panic!("expected error {code}, transaction succeeded"),
        Err(f) => assert!(
            format!("{:?}", f.err).contains(&format!("Custom({code})")),
            "expected {code}, got {:?}\n{}",
            f.err,
            f.meta.logs.join("\n")
        ),
    }
}

const FEED: [u8; 32] = [9u8; 32];
const PRICE: i64 = 108_500_000; // 1.085 at expo −8

fn snapshot(env: &mut Env, pair: [u8; 32], cross: Option<[u8; 32]>) -> TxResult {
    let now = i64::try_from(env.now).unwrap();
    env.snapshot_fx(
        pair,
        FEED,
        PRICE,
        10_000,
        -8,
        now,
        cross.map(|c| (c, PRICE, -8)),
    )
}

/// Cross-check changes (registry `set_fx_crosscheck`): from zero it applies at once; a later
/// change (new feed or removal) applies from the next period while the running period keeps the
/// feed in force (`prev_crosscheck`).
#[test]
fn crosscheck_changes_apply_from_the_next_period() {
    let mut env = Env::new();
    let pair = fx_pair_id(&FEED, false);
    env.set_fx_pair(pair, FEED, false, Pubkey::default(), true)
        .unwrap();
    env.init_fx_pair(pair).unwrap();
    let a = [0xAAu8; 32];
    let b = [0xBBu8; 32];
    // 2026-01-05 (Mon), 8104
    env.warp(START_TS + 4 * DAY);
    let q1 = period_of(env.now).unwrap();
    snapshot(&mut env, pair, None).unwrap();
    env.set_fx_crosscheck(pair, Pubkey::new_from_array(a))
        .unwrap();
    let cfg = env.fx_config(&pair).unwrap();
    assert_eq!(cfg.crosscheck_effective_period, q1);
    assert_eq!(cfg.prev_crosscheck, Pubkey::default());
    expect_code(
        env.set_fx_crosscheck(pair, Pubkey::new_from_array(a)),
        u32::from(RegistryError::CrosscheckUnchanged),
    );
    env.advance(DAY);
    expect_code(
        snapshot(&mut env, pair, None),
        u32::from(ProtocolError::CrosscheckRequired),
    );
    snapshot(&mut env, pair, Some(a)).unwrap();
    // change to B: applies from Q2, A stays in force for the rest of Q1
    env.set_fx_crosscheck(pair, Pubkey::new_from_array(b))
        .unwrap();
    let cfg = env.fx_config(&pair).unwrap();
    assert_eq!(cfg.crosscheck_effective_period, q1 + 1);
    assert_eq!(cfg.prev_crosscheck, Pubkey::new_from_array(a));
    env.advance(DAY);
    expect_code(
        snapshot(&mut env, pair, Some(b)),
        u32::from(ProtocolError::FeedIdMismatch),
    );
    snapshot(&mut env, pair, Some(a)).unwrap();
    // 2026-04-01 (Wed), Q2: B in force
    env.warp(period_start(q1 + 1).unwrap() + 3_600);
    expect_code(
        snapshot(&mut env, pair, Some(a)),
        u32::from(ProtocolError::FeedIdMismatch),
    );
    snapshot(&mut env, pair, Some(b)).unwrap();
    // removal: Q2 keeps B, Q3 needs none
    env.set_fx_crosscheck(pair, Pubkey::default()).unwrap();
    env.advance(DAY);
    expect_code(
        snapshot(&mut env, pair, None),
        u32::from(ProtocolError::CrosscheckRequired),
    );
    snapshot(&mut env, pair, Some(b)).unwrap();
    env.warp(period_start(q1 + 2).unwrap() + 3_600);
    snapshot(&mut env, pair, None).unwrap();
    // disabling a pair only stops new series from referencing it: snapshots continue
    env.set_fx_pair_enabled(pair, false).unwrap();
    env.advance(DAY);
    snapshot(&mut env, pair, None).unwrap();
    assert_eq!(env.fx_pair(&pair).unwrap().count, 7);
}

/// Vector 13 without any snapshot in Q2 2026: the quarter has no checkpoint at all, yet its report
/// goes through with the attestor-signed fallback rate, and every later quarter still reports
/// (Q3 by fallback, Q4 from the live end checkpoint).
#[test]
fn quarter_without_snapshots_reports_with_a_fallback_rate() {
    let text = std::fs::read_to_string(vector_path("13_fx.json")).unwrap();
    let mut v: Value = serde_json::from_str(&text).unwrap();
    let q2 = 8105u32;
    let steps = v["steps"].as_array().unwrap().clone();
    let first_cut = steps
        .iter()
        .position(|s| {
            s["op"] == "fx_snapshot"
                && period_of(s["t"].as_str().unwrap().parse().unwrap()).unwrap() == q2
        })
        .unwrap();
    let kept: Vec<Value> = steps
        .into_iter()
        .enumerate()
        .filter(|(i, s)| {
            let op = s["op"].as_str().unwrap();
            let t: u64 = s["t"].as_str().unwrap().parse().unwrap();
            let q2_snapshot = op == "fx_snapshot" && period_of(t).unwrap() == q2;
            let later_check = *i >= first_cut && (op == "expect" || op == "expect_revert");
            !q2_snapshot && !later_check
        })
        .map(|(_, s)| s)
        .collect();
    v["steps"] = Value::Array(kept);
    let r = Runner::run_value(v, None);
    let s1 = r.series_pubkey("S1").unwrap();
    let pair = r.env.series(&s1).fx_pair_id;
    assert!(r.env.fx_checkpoint(&pair, q2).is_none());
    let rep = r.env.report(&s1, q2).expect("Q2 report accepted");
    assert!(rep.fx_fallback);
    assert_eq!(rep.fx_avg_wad, 1_090_000_000_000_000_000);
    let l = r.env.ledger(&s1).unwrap();
    assert_eq!(l.last_accepted_period(), Some(8107));
    assert_eq!(l.last_paid_period(), Some(8107));
}
