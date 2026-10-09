//! Groth16 proof material for tests, taken from the parity vectors' `submit_report` steps
//! (`proofSolana`: pre-negated A, `x.c1‖x.c0‖y.c1‖y.c0` B, C, six 32-byte public inputs).

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct ReportProof {
    pub period: u32,
    pub terms_commitment: [u8; 32],
    pub units_outstanding: u64,
    pub fx_avg_wad: u64,
    pub prior_income_commitment: [u8; 32],
    pub income_commitment: [u8; 32],
    pub payment_usd: u64,
    pub proof: Vec<u8>,
}

pub fn hex32(s: &str) -> [u8; 32] {
    let bytes = hex::decode(s.trim_start_matches("0x")).expect("hex");
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    out
}

pub fn hex_bytes(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).expect("hex")
}

pub fn dec_u64(s: &str) -> u64 {
    s.parse().expect("u64")
}

fn be32_to_u64(b: &[u8; 32]) -> u64 {
    assert!(b[..24].iter().all(|x| *x == 0), "public input exceeds u64");
    u64::from_be_bytes(b[24..].try_into().unwrap())
}

/// Path of a vector file inside `packages/vectors`.
pub fn vector_path(name: &str) -> String {
    format!(
        "{}/../../packages/vectors/{name}",
        env!("CARGO_MANIFEST_DIR")
    )
}

/// Every `submit_report` step of a vector (actions and `expect_revert` calls) as proof material,
/// in order of appearance.
pub fn report_proofs(vector: &str, series: &str) -> Vec<ReportProof> {
    let text = std::fs::read_to_string(vector_path(vector)).expect("vector present");
    let v: Value = serde_json::from_str(&text).expect("vector json");
    let mut out = Vec::new();
    for step in v["steps"].as_array().unwrap() {
        let call = if step["op"] == "expect_revert" {
            &step["call"]
        } else {
            step
        };
        if call["op"] != "submit_report" || call["series"] != series {
            continue;
        }
        let sol = &call["proofSolana"];
        let pi: Vec<[u8; 32]> = sol["publicInputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| hex32(x.as_str().unwrap()))
            .collect();
        out.push(ReportProof {
            period: call["period"].as_str().unwrap().parse().unwrap(),
            terms_commitment: pi[0],
            units_outstanding: be32_to_u64(&pi[1]),
            fx_avg_wad: be32_to_u64(&pi[2]),
            prior_income_commitment: pi[3],
            income_commitment: pi[4],
            payment_usd: be32_to_u64(&pi[5]),
            proof: hex_bytes(sol["proof"].as_str().unwrap()),
        });
    }
    out
}
