//! Every parity vector replayed with the Token-2022 mock USDG as the series stablecoin
//! (ASSUMPTIONS A24: `TransferHook` → `mock_usdg_hook`, `TransferFeeConfig` 0/0,
//! `MetadataPointer`). Every stablecoin movement (bid escrow, proceeds, fees, refunds, releases,
//! payments, router sweeps, claims, redemption, window escrow) then runs `transfer_checked` on
//! Token-2022 with the stablecoin's extra accounts resolved from the remaining accounts, and must
//! give exactly the balances the vectors expect for the SPL mock USDC.

use merces_tests::vectors::Runner;
use merces_tests::zkfix::vector_path;
use serde_json::Value;

fn replay_on_usdg(name: &str) {
    let text = std::fs::read_to_string(vector_path(name)).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    let r = Runner::run_value_on(v, None, true);
    // the series really ran on the Token-2022 stablecoin
    for key in r.series_keys() {
        let s = r.env.series(&key);
        assert_eq!(s.stablecoin, r.env.usdg, "{name}: series stablecoin");
        assert_eq!(s.stablecoin_program, merces_tests::harness::TOKEN_2022);
    }
}

macro_rules! usdg_vectors {
    ($($test:ident => $file:literal),* $(,)?) => {
        $(
            #[test]
            fn $test() {
                replay_on_usdg($file);
            }
        )*
    };
}

usdg_vectors! {
    usdg_01_happy_path => "01_happy_path.json",
    usdg_02_failed_auction => "02_failed_auction.json",
    usdg_03_auction_edges => "03_auction_edges.json",
    usdg_04_zero_quarters => "04_zero_quarters.json",
    usdg_05_cap_hit => "05_cap_hit.json",
    usdg_06_redemption_terms => "06_redemption_terms.json",
    usdg_07_late_payment => "07_late_payment.json",
    usdg_08_hardship_pause => "08_hardship_pause.json",
    usdg_09_tail_clause => "09_tail_clause.json",
    usdg_10_transfer_window => "10_transfer_window.json",
    usdg_11_extinguishment => "11_extinguishment.json",
    usdg_12_multi_series_router => "12_multi_series_router.json",
    usdg_13_fx => "13_fx.json",
    usdg_14_amendment => "14_amendment.json",
    usdg_15_zero_valid_bids => "15_zero_valid_bids.json",
    usdg_16_demand_limited_window => "16_demand_limited_window.json",
    usdg_17_undelivered_winner => "17_undelivered_winner.json",
    usdg_18_report_before_finalization => "18_report_before_finalization.json",
    usdg_19_pause_while_late => "19_pause_while_late.json",
    usdg_20_tier3_trueup => "20_tier3_trueup.json",
    usdg_21_entry_rules => "21_entry_rules.json",
    usdg_22_late_holder_tail_final => "22_late_holder_tail_final.json",
    usdg_23_redeem_twice_with_tail => "23_redeem_twice_with_tail.json",
    usdg_24_inverted_fx => "24_inverted_fx.json",
    usdg_25_window_on_terminal => "25_window_on_terminal.json",
}
