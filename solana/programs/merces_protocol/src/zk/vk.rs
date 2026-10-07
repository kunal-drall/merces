//! PLACEHOLDER verifying key — replaced by the generated development key before tests run.
//!
//! Track A generates `vk.rs` from `circuits/build/verification_key.json` (SPEC §8). Until that file
//! lands, this module keeps the exact shape (`VERIFYINGKEY: Groth16Verifyingkey` with 7 `vk_ic`
//! entries for 6 public inputs) so the program compiles. The all-zero points below are the point
//! at infinity, for which the pairing check is vacuously true; **this key must never be deployed**.
//! `solana/scripts/gen-zk-fixtures.mjs` overwrites this file from a real verification key.

use groth16_solana::groth16::Groth16Verifyingkey;

pub const VERIFYINGKEY: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: 6,
    vk_alpha_g1: [0u8; 64],
    vk_beta_g2: [0u8; 128],
    vk_gamme_g2: [0u8; 128],
    vk_delta_g2: [0u8; 128],
    vk_ic: &[[0u8; 64]; 7],
};
