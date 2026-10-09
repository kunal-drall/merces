//! Compute-unit measurements per instruction family, taken from the parity-vector replays
//! (maximum compute units a Merces program consumed per vector op). Prints a Markdown table and
//! writes `target/measurements.md` for `docs/solana/MEASUREMENTS.md`.

use std::collections::BTreeMap;

use merces_tests::vectors::run_vector;

#[test]
fn compute_units_per_instruction() {
    let vectors = [
        "01_happy_path.json",
        "03_auction_edges.json",
        "08_hardship_pause.json",
        "09_tail_clause.json",
        "10_transfer_window.json",
        "11_extinguishment.json",
        "12_multi_series_router.json",
        "13_fx.json",
        "14_amendment.json",
        "20_tier3_trueup.json",
    ];
    let mut table: BTreeMap<String, (u64, String)> = BTreeMap::new();
    for v in vectors {
        let r = run_vector(v);
        for (op, cu) in &r.cu {
            let e = table.entry(op.clone()).or_insert((0, String::new()));
            if *cu > e.0 {
                *e = (*cu, v.to_string());
            }
        }
    }
    let mut out =
        String::from("| Vector op | Max compute units | Measured in |\n| --- | ---: | --- |\n");
    for (op, (cu, src)) in &table {
        out.push_str(&format!("| `{op}` | {cu} | `{src}` |\n"));
    }
    println!("{out}");
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/measurements.md");
    std::fs::write(path, &out).expect("write measurements");
    // every money path must fit comfortably in a 1.4M CU transaction next to ATA creation
    for (op, (cu, _)) in &table {
        assert!(*cu < 1_200_000, "{op} consumes {cu} CU");
    }
}
