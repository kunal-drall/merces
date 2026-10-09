//! The checked-in IDLs (`solana/idls/`, exported by `scripts/export-idls.sh`) are exactly the ones
//! `anchor build` generated for the tested programs.

#[test]
fn exported_idls_match_the_build() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
    for p in [
        "merces_registry",
        "merces_hook",
        "merces_protocol",
        "mock_usdg_hook",
    ] {
        let built = std::fs::read_to_string(format!("{root}/target/idl/{p}.json"))
            .unwrap_or_else(|_| panic!("target/idl/{p}.json missing (run scripts/build.sh)"));
        let exported = std::fs::read_to_string(format!("{root}/idls/{p}.json"))
            .unwrap_or_else(|_| panic!("idls/{p}.json missing (run scripts/export-idls.sh)"));
        let a: serde_json::Value = serde_json::from_str(&built).unwrap();
        let b: serde_json::Value = serde_json::from_str(&exported).unwrap();
        assert_eq!(a, b, "idls/{p}.json is stale: run scripts/export-idls.sh");
    }
}
