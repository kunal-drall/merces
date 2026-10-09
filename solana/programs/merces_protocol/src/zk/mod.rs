//! Groth16 verification over BN254 using the alt_bn128 syscalls through `groth16-solana`
//! (SPEC §6.2 step 6, §8).
//!
//! Proof encoding accepted by `submit_report` (256 bytes, all big-endian, EIP-197 layout):
//! `A = x ‖ q − y` (64, **already negated** by the prover/SDK as `packages/vectors` and
//! `circuits/README.md` specify), `B = x_im ‖ x_re ‖ y_im ‖ y_re` (128), `C = x ‖ y` (64). The
//! crate's pairing check expects `e(−A, B) · e(α, β) · e(L, γ) · e(C, δ) = 1`; `negate_g1` is kept
//! as a helper for clients that hold an un-negated `pi_a`.

pub mod vk;

use crate::error::ProtocolError;
use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;
pub use vk::NR_PUBLIC_INPUTS;

/// BN254 base field modulus `q`, big-endian.
pub const BN254_FQ_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

/// BN254 scalar field modulus `r`, big-endian (public inputs must be `< r`).
pub const BN254_FR_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

fn is_zero(bytes: &[u8]) -> bool {
    bytes.iter().all(|b| *b == 0)
}

/// Big-endian `a < b` for equal-length byte strings.
fn lt_be(a: &[u8], b: &[u8]) -> bool {
    a < b
}

/// `q − y` in big-endian bytes; requires `0 < y < q`.
fn fq_neg_be(y: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow: i16 = 0;
    for i in (0..32).rev() {
        let d = i16::from(BN254_FQ_BE[i]) - i16::from(y[i]) - borrow;
        if d < 0 {
            out[i] = (d + 256) as u8;
            borrow = 1;
        } else {
            out[i] = d as u8;
            borrow = 0;
        }
    }
    out
}

/// Negates a G1 point `(x, y)` → `(x, q − y)`; the point at infinity `(0, 0)` is unchanged.
pub fn negate_g1(point: &[u8; 64]) -> Result<[u8; 64]> {
    let mut y = [0u8; 32];
    y.copy_from_slice(&point[32..64]);
    require!(
        lt_be(&point[..32], &BN254_FQ_BE),
        ProtocolError::MalformedProof
    );
    require!(lt_be(&y, &BN254_FQ_BE), ProtocolError::MalformedProof);
    let mut out = *point;
    if !is_zero(&y) {
        out[32..64].copy_from_slice(&fq_neg_be(&y));
    }
    Ok(out)
}

/// Verifies a Groth16 proof for the report circuit. `public_inputs` are 32-byte big-endian field
/// elements in SPEC §8 order.
pub fn verify_report_proof(
    proof: &[u8; 256],
    public_inputs: &[[u8; 32]; NR_PUBLIC_INPUTS],
) -> Result<()> {
    for input in public_inputs {
        require!(
            lt_be(input, &BN254_FR_BE),
            ProtocolError::PublicInputNotCanonical
        );
    }
    let mut proof_a = [0u8; 64];
    proof_a.copy_from_slice(&proof[0..64]);
    require!(
        lt_be(&proof_a[..32], &BN254_FQ_BE) && lt_be(&proof_a[32..], &BN254_FQ_BE),
        ProtocolError::MalformedProof
    );
    let mut proof_b = [0u8; 128];
    proof_b.copy_from_slice(&proof[64..192]);
    let mut proof_c = [0u8; 64];
    proof_c.copy_from_slice(&proof[192..256]);
    let mut verifier = Groth16Verifier::<NR_PUBLIC_INPUTS>::new(
        &proof_a,
        &proof_b,
        &proof_c,
        public_inputs,
        &vk::VERIFYING_KEY,
    )
    .map_err(|_| error!(ProtocolError::MalformedProof))?;
    // Inputs were checked against `r` above, so the crate's field-size check (which pulls in
    // arkworks) is not needed.
    verifier
        .verify_unchecked()
        .map_err(|_| error!(ProtocolError::InvalidProof))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex32(s: &str) -> [u8; 32] {
        let b = hex_decode(s.trim_start_matches("0x"));
        let mut out = [0u8; 32];
        out.copy_from_slice(&b);
        out
    }

    fn hex_decode(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// The committed verifying key verifies the parity vectors' Groth16 proofs on the host
    /// (solana-bn254 runs arkworks natively off-chain) and rejects a tampered public input.
    #[test]
    fn vector_proofs_verify_against_vk() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/vectors/01_happy_path.json"
        );
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let steps = json["steps"].as_array().unwrap();
        let mut checked = 0;
        for step in steps.iter().filter(|s| s["op"] == "submit_report") {
            let sol = &step["proofSolana"];
            let pi = sol["publicInputs"].as_array().unwrap();
            assert_eq!(pi.len(), NR_PUBLIC_INPUTS);
            let mut inputs = [[0u8; 32]; NR_PUBLIC_INPUTS];
            for (i, v) in pi.iter().enumerate() {
                inputs[i] = hex32(v.as_str().unwrap());
            }
            let proof_bytes = hex_decode(sol["proof"].as_str().unwrap().trim_start_matches("0x"));
            let mut proof = [0u8; 256];
            proof.copy_from_slice(&proof_bytes);
            verify_report_proof(&proof, &inputs)
                .unwrap_or_else(|e| panic!("period {} failed: {e:?}", step["period"]));
            // tamper with the payment
            let mut bad = inputs;
            bad[5][31] ^= 1;
            assert!(verify_report_proof(&proof, &bad).is_err());
            checked += 1;
        }
        assert!(
            checked >= 5,
            "expected at least five report steps, found {checked}"
        );
    }

    #[test]
    fn negation_roundtrip() {
        let mut p = [0u8; 64];
        p[63] = 1; // y = 1
        let n = negate_g1(&p).unwrap();
        // q − 1
        let mut expect = BN254_FQ_BE;
        expect[31] -= 1;
        assert_eq!(&n[32..], &expect);
        let back = negate_g1(&n).unwrap();
        assert_eq!(back, p);
        // infinity stays
        let inf = [0u8; 64];
        assert_eq!(negate_g1(&inf).unwrap(), inf);
        // y ≥ q rejected
        let mut bad = [0u8; 64];
        bad[32..].copy_from_slice(&BN254_FQ_BE);
        assert!(negate_g1(&bad).is_err());
    }
}
