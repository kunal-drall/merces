//! SPEC §11 parity vectors replayed against the compiled programs (one test per vector).

use merces_tests::vectors::run_vector;

#[test]
fn v01_happy_path() {
    run_vector("01_happy_path.json");
}

#[test]
fn v02_failed_auction() {
    run_vector("02_failed_auction.json");
}

#[test]
fn v03_auction_edges() {
    run_vector("03_auction_edges.json");
}

#[test]
fn v04_zero_quarters() {
    run_vector("04_zero_quarters.json");
}

#[test]
fn v05_cap_hit() {
    run_vector("05_cap_hit.json");
}

#[test]
fn v06_redemption_terms() {
    run_vector("06_redemption_terms.json");
}

#[test]
fn v07_late_payment() {
    run_vector("07_late_payment.json");
}

#[test]
fn v08_hardship_pause() {
    run_vector("08_hardship_pause.json");
}

#[test]
fn v09_tail_clause() {
    run_vector("09_tail_clause.json");
}

#[test]
fn v10_transfer_window() {
    run_vector("10_transfer_window.json");
}

#[test]
fn v11_extinguishment() {
    run_vector("11_extinguishment.json");
}

#[test]
fn v12_multi_series_router() {
    run_vector("12_multi_series_router.json");
}

#[test]
fn v13_fx() {
    run_vector("13_fx.json");
}

#[test]
fn v14_amendment() {
    run_vector("14_amendment.json");
}

#[test]
fn v15_zero_valid_bids() {
    run_vector("15_zero_valid_bids.json");
}

#[test]
fn v16_demand_limited_window() {
    run_vector("16_demand_limited_window.json");
}

#[test]
fn v17_undelivered_winner() {
    run_vector("17_undelivered_winner.json");
}

#[test]
fn v18_report_before_finalization() {
    run_vector("18_report_before_finalization.json");
}

#[test]
fn v19_pause_while_late() {
    run_vector("19_pause_while_late.json");
}

#[test]
fn v20_tier3_trueup() {
    run_vector("20_tier3_trueup.json");
}

#[test]
fn v21_entry_rules() {
    run_vector("21_entry_rules.json");
}
