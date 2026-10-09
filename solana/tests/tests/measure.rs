//! Compute-unit measurements per program instruction (`docs/solana/MEASUREMENTS.md`): every parity
//! vector (on the SPL mock USDC and again on the Token-2022 mock USDG), a full-page auction (30
//! bids, tally pages of 24), the window take-back flow, a 24-order window tally page, a 24-ask
//! take-back tally page, an early draw, an FX cross-check change, the admin/keeper paths the
//! vectors do not reach and a curve-mode lifecycle on the real DBC program are replayed; every
//! successful transaction's logs are parsed by `events::record_instruction_cu`. Writes
//! `target/measurements.md`.

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountSerialize, Space};
use merces_protocol::state::{Order, SIDE_ASK, SIDE_BID, TALLY_PAGE, WINDOW_SETTLED};
use merces_tests::events::cu_table;
use merces_tests::harness::*;
use merces_tests::scenarios::{curve_scenario, full_page_auction, takeback_window};
use merces_tests::vectors::{run_vector, Runner};
use merces_tests::zkfix::vector_path;
use serde_json::Value;
use solana_signer::Signer;

const VECTORS: [&str; 21] = [
    "01_happy_path.json",
    "02_failed_auction.json",
    "03_auction_edges.json",
    "04_zero_quarters.json",
    "05_cap_hit.json",
    "06_redemption_terms.json",
    "07_late_payment.json",
    "08_hardship_pause.json",
    "09_tail_clause.json",
    "10_transfer_window.json",
    "11_extinguishment.json",
    "12_multi_series_router.json",
    "13_fx.json",
    "14_amendment.json",
    "15_zero_valid_bids.json",
    "16_demand_limited_window.json",
    "17_undelivered_winner.json",
    "18_report_before_finalization.json",
    "19_pause_while_late.json",
    "20_tier3_trueup.json",
    "21_entry_rules.json",
];

fn vector(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(vector_path(name)).unwrap()).unwrap()
}

/// Vector 10 replayed to the end of its reveal phase (the clock at `reveal_end`).
fn window_after_reveal() -> (Runner, Pubkey, u32) {
    let v = vector("10_transfer_window.json");
    let steps = v["steps"].as_array().unwrap();
    let before_settle = steps
        .iter()
        .position(|s| s["op"] == "begin_window_settlement")
        .unwrap()
        - 1;
    let mut r = Runner::run_value(v.clone(), Some(before_settle));
    let series = r.series_pubkey("S1").unwrap();
    let period = 8109u32;
    let w = r.env.window(&series, period).unwrap();
    r.env.warp(w.reveal_end);
    (r, series, period)
}

/// Writes `TALLY_PAGE` synthetic revealed, valid orders of the window (one fresh owner each) and
/// returns their owners. `side(i)` and `price(i)` shape the page.
fn inject_orders(
    r: &mut Runner,
    series: Pubkey,
    period: u32,
    side: impl Fn(usize) -> u8,
    price: impl Fn(usize) -> u64,
) -> Vec<Pubkey> {
    let mut owners = Vec::new();
    for i in 0..TALLY_PAGE {
        let owner = Pubkey::new_unique();
        let (key, bump) = Pubkey::find_program_address(
            &[
                merces_protocol::state::seeds::ORDER,
                series.as_ref(),
                &period.to_le_bytes(),
                owner.as_ref(),
            ],
            &merces_protocol::ID,
        );
        let o = Order {
            series,
            period,
            owner,
            side: side(i),
            commitment: [0u8; 32],
            escrow: 1_000_000_000,
            reveal_index: 100 + i as u32,
            revealed: true,
            valid: true,
            price: price(i),
            quantity: 1,
            tallied_round: 0,
            processed: false,
            fill: 0,
            takeback_round: 0,
            pending_units: 0,
            pending_stable: 0,
            delivered: false,
            bump,
        };
        let mut data = Vec::with_capacity(8 + Order::INIT_SPACE);
        o.try_serialize(&mut data).unwrap();
        data.resize(8 + Order::INIT_SPACE, 0);
        let mut acc = r.env.svm.get_account(&config_pda()).unwrap();
        acc.lamports = r.env.svm.minimum_balance_for_rent_exemption(data.len());
        acc.data = data;
        acc.owner = merces_protocol::ID;
        r.env.svm.set_account(key, acc).unwrap();
        owners.push(owner);
    }
    owners
}

/// One `tally_orders` page over exactly 24 revealed orders (the worst-case page).
fn window_tally_page() {
    let (mut r, series, period) = window_after_reveal();
    let owners = inject_orders(
        &mut r,
        series,
        period,
        |i| if i % 2 == 0 { SIDE_BID } else { SIDE_ASK },
        |i| 120_000_000 + (i as u64) * 1_000_000,
    );
    r.env
        .begin_window_settlement(&series, period, 125_000_000, false)
        .unwrap();
    r.env.tally_orders(&series, period, &owners).unwrap();
}

/// One `tally_takeback` page over exactly 24 asks below `p*` (the worst-case page): the window is
/// put in the state the take-back starts from (settled, every bid processed, one cancelled unit
/// beyond the at-`p*` group).
fn takeback_tally_page() {
    let (mut r, series, period) = window_after_reveal();
    let owners = inject_orders(
        &mut r,
        series,
        period,
        |_| SIDE_ASK,
        |i| 100_000_000 + (i as u64) * 1_000_000,
    );
    let key = window_pda(&series, period);
    let mut w = r.env.window(&series, period).unwrap();
    w.state = WINDOW_SETTLED;
    w.clearing_price = 200_000_000;
    w.next_bid_index = w.revealed_bids;
    w.ask_at_total = 0;
    w.cancelled_units = 1;
    let mut acc = r.env.svm.get_account(&key).unwrap();
    let len = acc.data.len();
    let mut data = Vec::with_capacity(len);
    w.try_serialize(&mut data).unwrap();
    data.resize(len, 0);
    acc.data = data;
    r.env.svm.set_account(key, acc).unwrap();
    // the threshold is the highest-keyed ask: price 123 USDC, reveal index 123
    r.env
        .begin_takeback(&series, period, 123_000_000, 123)
        .unwrap();
    r.env.tally_takeback(&series, period, &owners).unwrap();
}

fn early_draw_and_crosscheck() {
    let v = vector("01_happy_path.json");
    let steps = v["steps"].as_array().unwrap();
    let settled = steps
        .iter()
        .rposition(|s| s["op"] == "deliver_bid")
        .unwrap();
    let mut r = Runner::run_value(v.clone(), Some(settled));
    let s1 = r.series_pubkey("S1").unwrap();
    let issuer = r.actor_keypair("issuer");
    let approver = r.env.new_wallet();
    r.env.set_early_draw_approver(approver.pubkey()).unwrap();
    r.env
        .request_early_draw(&issuer, &approver, &s1, 1_000 * ONE_USDC)
        .unwrap();
    let feed = [9u8; 32];
    let pair = fx_pair_id(&feed, false);
    r.env
        .set_fx_pair(pair, feed, false, Pubkey::default(), true)
        .unwrap();
    r.env
        .set_fx_crosscheck(pair, Pubkey::new_from_array([0xAA; 32]))
        .unwrap();
    r.env.set_fx_pair_enabled(pair, false).unwrap();
    // holder registration by a keeper for a wallet that is allowlisted now
    let fresh = r.env.new_wallet();
    r.env.allow(&fresh.pubkey(), true).unwrap();
    r.env.register_holder(&s1, &fresh.pubkey()).unwrap();
    // admin setters (future series only) and key rotation
    r.env
        .set_defaults(merces_common::params::Parameters::DEFAULT.into())
        .unwrap();
    let k = merces_tests::sig::EthSigner::from_seed(77);
    r.env.register_verifier(k.addr).unwrap();
    r.env.revoke_verifier(k.addr).unwrap();
    r.env.deactivate_issuer(&issuer.pubkey()).unwrap();
    // the issuer's release pause, role rotation and the two-step admin transfer
    r.env.set_release_pause(&issuer, &s1, true).unwrap();
    r.env.set_release_pause(&issuer, &s1, false).unwrap();
    let manager = r.env.allowlist_manager.pubkey();
    r.env.set_allowlist_manager(manager).unwrap();
    let collector = r.env.fee_collector.pubkey();
    r.env.set_fee_collector(collector).unwrap();
    let next_admin = r.env.new_wallet();
    r.env.transfer_admin(next_admin.pubkey()).unwrap();
    r.env.accept_admin(&next_admin).unwrap();
    // a raise cancelled before its first bid
    let mut env = Env::new();
    let other = env.new_wallet();
    let usdc = env.usdc;
    let series = env.setup_series(&other, &usdc, Env::default_series_args([6u8; 32]));
    env.open_raise(&other, &series).unwrap();
    env.cancel_raise(&other, &series).unwrap();
}

#[test]
fn compute_units_per_instruction() {
    for v in VECTORS {
        run_vector(v);
        // the same vector on the Token-2022 stablecoin (hooked transfers cost more)
        Runner::run_value_on(vector(v), None, true);
    }
    full_page_auction(30);
    takeback_window();
    window_tally_page();
    takeback_tally_page();
    early_draw_and_crosscheck();
    curve_scenario();
    let table = cu_table();
    let mut out = String::from(
        "| Program | Instruction | Max compute units | Samples |\n| --- | --- | ---: | ---: |\n",
    );
    for (key, (cu, n)) in &table {
        let (prog, ix) = key.split_once("::").unwrap();
        out.push_str(&format!("| `{prog}` | `{ix}` | {cu} | {n} |\n"));
    }
    // largest legacy transactions per shape (every send is asserted ≤ 1,232 bytes by the harness)
    let mut names = std::collections::HashMap::new();
    for prog in [
        "merces_registry",
        "merces_protocol",
        "merces_hook",
        "mock_usdg_hook",
    ] {
        let path = format!("{}/../idls/{prog}.json", env!("CARGO_MANIFEST_DIR"));
        let idl: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for ix in idl["instructions"].as_array().unwrap() {
            let disc: Vec<u8> = ix["discriminator"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect();
            names.insert(
                format!("{prog}:{}", hex::encode(disc)),
                ix["name"].as_str().unwrap().to_string(),
            );
        }
    }
    let mut sizes: Vec<(String, usize)> = merces_tests::events::tx_sizes()
        .into_iter()
        .map(|(k, v)| {
            let shape: Vec<String> = k
                .split('+')
                .map(|part| names.get(part).cloned().unwrap_or_else(|| part.to_string()))
                .collect();
            (shape.join(" + "), v)
        })
        .collect();
    sizes.sort_by_key(|(name, size)| (core::cmp::Reverse(*size), name.clone()));
    sizes.dedup_by(|a, b| a.0 == b.0);
    out.push_str(
        "\n| Transaction (Merces instructions) | Max bytes (limit 1,232) |\n| --- | ---: |\n",
    );
    for (shape, size) in sizes.iter().take(15) {
        out.push_str(&format!("| `{shape}` | {size} |\n"));
    }
    println!("{out}");
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/measurements.md");
    std::fs::write(path, &out).expect("write measurements");
    // every instruction fits a 1.4M-CU transaction with room for ATA creation and hook resolution
    for (key, (cu, _)) in &table {
        assert!(*cu < 1_200_000, "{key} consumes {cu} CU");
    }
    for must in [
        "merces_protocol::TallyBids",
        "merces_protocol::TallyOrders",
        "merces_protocol::SubmitReport",
        "merces_protocol::ProcessOrder",
        "merces_protocol::DeliverOrder",
        "merces_protocol::BeginTakeback",
        "merces_protocol::TallyTakeback",
        "merces_protocol::FinalizeTakeback",
        "merces_protocol::RequestEarlyDraw",
        "merces_registry::SetFxCrosscheck",
        "merces_hook::Execute (CPI)",
        "mock_usdg_hook::Execute (CPI)",
        "merces_registry::TransferAdmin",
        "merces_registry::AcceptAdmin",
        "merces_registry::SetAllowlistManager",
        "merces_registry::SetFeeCollector",
        "merces_protocol::SetReleasePause",
        "merces_protocol::PrepareCurve",
        "merces_protocol::ActivateCurve",
        "merces_protocol::CompleteCurve",
        "merces_protocol::CollectCurveProceeds",
        "merces_protocol::SyncCurveUnits",
        "merces_protocol::StakeUnits",
        "merces_protocol::UnstakeUnits",
        "merces_protocol::TenderUnits",
        "merces_registry::MarkCurveActivated (CPI)",
    ] {
        assert!(
            table.keys().any(|k| k == must),
            "{must} was not measured; measured: {:?}",
            table.keys().collect::<Vec<_>>()
        );
    }
}
