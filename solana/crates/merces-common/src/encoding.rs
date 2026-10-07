//! Byte encodings of hashed messages (SPEC §1.3–§1.4). This module only builds pre-images; the
//! caller hashes them with keccak256 (a syscall on-chain, a library in tests), so the crate stays
//! free of hashing dependencies.
//!
//! Integers are big-endian fixed width; 32-byte values raw; wallets are 32 bytes (a Solana
//! pubkey as-is).

/// Maximum pre-image length across all messages (`MERCES_TRUEUP_V1`: 16 + 32 + 32 + 2 + 8 + 8 = 98;
/// `MERCES_AMEND_V1`: 15 + 32 + 32 + 8 + 32 + 8 = 127).
pub const MAX_PREIMAGE: usize = 160;

/// A fixed-capacity pre-image buffer.
#[derive(Debug, Clone, Copy)]
pub struct Preimage {
    buf: [u8; MAX_PREIMAGE],
    len: usize,
}

impl Default for Preimage {
    fn default() -> Self {
        Self::new()
    }
}

impl Preimage {
    pub const fn new() -> Self {
        Self {
            buf: [0u8; MAX_PREIMAGE],
            len: 0,
        }
    }

    fn push(&mut self, bytes: &[u8]) -> &mut Self {
        let end = self.len.saturating_add(bytes.len());
        // Every message below is bounded by MAX_PREIMAGE; a longer input is a programming error.
        assert!(end <= MAX_PREIMAGE, "preimage overflow");
        self.buf[self.len..end].copy_from_slice(bytes);
        self.len = end;
        self
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.buf[..self.len]
    }
}

pub const CHAIN_KIND_SOLANA: u8 = 1;
pub const CHAIN_KIND_EVM: u8 = 2;

/// `chain_kind_u8 ‖ chain_id_u64 ‖ registry_address_32` (SPEC §1.3 `domain`).
pub fn domain_preimage(chain_kind: u8, chain_id: u64, registry_address: &[u8; 32]) -> Preimage {
    let mut p = Preimage::new();
    p.push(&[chain_kind])
        .push(&chain_id.to_be_bytes())
        .push(registry_address);
    p
}

/// `price_u64 ‖ quantity_u64 ‖ salt_32 ‖ wallet_32` (bid / ask commitment).
pub fn commitment_preimage(
    price: u64,
    quantity: u64,
    salt: &[u8; 32],
    wallet: &[u8; 32],
) -> Preimage {
    let mut p = Preimage::new();
    p.push(&price.to_be_bytes())
        .push(&quantity.to_be_bytes())
        .push(salt)
        .push(wallet);
    p
}

/// `"MERCES_REPORT_V1" ‖ domain ‖ series_key ‖ period_u32 ‖ income_commitment_32 ‖ tier_u8`.
pub fn report_message(
    domain: &[u8; 32],
    series_key: &[u8; 32],
    period: u32,
    income_commitment: &[u8; 32],
    tier: u8,
) -> Preimage {
    let mut p = Preimage::new();
    p.push(b"MERCES_REPORT_V1")
        .push(domain)
        .push(series_key)
        .push(&period.to_be_bytes())
        .push(income_commitment)
        .push(&[tier]);
    p
}

/// `"MERCES_FX_V1" ‖ domain ‖ series_key ‖ period_u32 ‖ fx_rate_wad_u64`.
pub fn fx_message(
    domain: &[u8; 32],
    series_key: &[u8; 32],
    period: u32,
    fx_rate_wad: u64,
) -> Preimage {
    let mut p = Preimage::new();
    p.push(b"MERCES_FX_V1")
        .push(domain)
        .push(series_key)
        .push(&period.to_be_bytes())
        .push(&fx_rate_wad.to_be_bytes());
    p
}

/// `"MERCES_AMEND_V1" ‖ domain ‖ series_key ‖ amendment_nonce_u64 ‖ new_terms_commitment_32 ‖ new_cap_multiple_wad_u64`.
pub fn amend_message(
    domain: &[u8; 32],
    series_key: &[u8; 32],
    nonce: u64,
    new_terms_commitment: &[u8; 32],
    new_cap_multiple_wad: u64,
) -> Preimage {
    let mut p = Preimage::new();
    p.push(b"MERCES_AMEND_V1")
        .push(domain)
        .push(series_key)
        .push(&nonce.to_be_bytes())
        .push(new_terms_commitment)
        .push(&new_cap_multiple_wad.to_be_bytes());
    p
}

/// `"MERCES_PAUSE_V1" ‖ domain ‖ series_key ‖ pause_nonce_u64 ‖ pause_end_u64`.
pub fn pause_message(
    domain: &[u8; 32],
    series_key: &[u8; 32],
    nonce: u64,
    pause_end: u64,
) -> Preimage {
    let mut p = Preimage::new();
    p.push(b"MERCES_PAUSE_V1")
        .push(domain)
        .push(series_key)
        .push(&nonce.to_be_bytes())
        .push(&pause_end.to_be_bytes());
    p
}

/// `"MERCES_EXTINGUISH_V1" ‖ domain ‖ series_key ‖ extinguish_nonce_u64`.
pub fn extinguish_message(domain: &[u8; 32], series_key: &[u8; 32], nonce: u64) -> Preimage {
    let mut p = Preimage::new();
    p.push(b"MERCES_EXTINGUISH_V1")
        .push(domain)
        .push(series_key)
        .push(&nonce.to_be_bytes());
    p
}

/// `"MERCES_TRUEUP_V1" ‖ domain ‖ series_key ‖ year_u16 ‖ adjustment_i64 ‖ attestation_ts_u64`.
pub fn trueup_message(
    domain: &[u8; 32],
    series_key: &[u8; 32],
    year: u16,
    adjustment: i64,
    attestation_ts: u64,
) -> Preimage {
    let mut p = Preimage::new();
    p.push(b"MERCES_TRUEUP_V1")
        .push(domain)
        .push(series_key)
        .push(&year.to_be_bytes())
        .push(&adjustment.to_be_bytes())
        .push(&attestation_ts.to_be_bytes());
    p
}

/// secp256k1 group order halved: signatures with `s` above this are malleable and rejected.
pub const SECP256K1_HALF_ORDER: [u8; 32] = [
    0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B, 0x20, 0xA0,
];

/// Parses a 65-byte `(r, s, v)` signature: returns `(r‖s, recovery_id)` after enforcing
/// `v ∈ {27, 28}` and low-`s`.
pub fn parse_signature(sig: &[u8]) -> Option<([u8; 64], u8)> {
    if sig.len() != 65 {
        return None;
    }
    let v = sig[64];
    let recovery_id = match v {
        27 => 0u8,
        28 => 1u8,
        _ => return None,
    };
    let mut rs = [0u8; 64];
    rs.copy_from_slice(&sig[..64]);
    let s: &[u8] = &sig[32..64];
    if s > &SECP256K1_HALF_ORDER[..] {
        return None;
    }
    // r and s must be non-zero
    if sig[..32].iter().all(|b| *b == 0) || s.iter().all(|b| *b == 0) {
        return None;
    }
    Some((rs, recovery_id))
}

/// Encodes a `u64` as a 32-byte big-endian field element (public inputs for the verifier).
pub fn u64_to_be32(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&v.to_be_bytes());
    out
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    #[test]
    fn layouts() {
        let d = [1u8; 32];
        let s = [2u8; 32];
        let c = [3u8; 32];
        let m = report_message(&d, &s, 8104, &c, 2);
        assert_eq!(m.as_bytes().len(), 16 + 32 + 32 + 4 + 32 + 1);
        assert_eq!(&m.as_bytes()[..16], b"MERCES_REPORT_V1");
        assert_eq!(&m.as_bytes()[80..84], &8104u32.to_be_bytes());
        assert_eq!(m.as_bytes()[116], 2);
        assert_eq!(
            fx_message(&d, &s, 1, 2).as_bytes().len(),
            12 + 32 + 32 + 4 + 8
        );
        assert_eq!(
            amend_message(&d, &s, 1, &c, 2).as_bytes().len(),
            15 + 32 + 32 + 8 + 32 + 8
        );
        assert_eq!(
            pause_message(&d, &s, 1, 2).as_bytes().len(),
            15 + 32 + 32 + 8 + 8
        );
        assert_eq!(
            extinguish_message(&d, &s, 1).as_bytes().len(),
            20 + 32 + 32 + 8
        );
        assert_eq!(
            trueup_message(&d, &s, 2026, -5, 7).as_bytes().len(),
            16 + 32 + 32 + 2 + 8 + 8
        );
        assert_eq!(
            &trueup_message(&d, &s, 2026, -5, 7).as_bytes()[82..90],
            &(-5i64).to_be_bytes()
        );
        assert_eq!(
            commitment_preimage(1, 2, &c, &s).as_bytes().len(),
            8 + 8 + 32 + 32
        );
        assert_eq!(domain_preimage(1, 103, &s).as_bytes().len(), 1 + 8 + 32);
        assert_eq!(u64_to_be32(1)[31], 1);
    }

    #[test]
    fn signature_parsing() {
        let mut sig = [0u8; 65];
        sig[0] = 1;
        sig[32] = 1;
        sig[64] = 27;
        assert_eq!(parse_signature(&sig).unwrap().1, 0);
        sig[64] = 28;
        assert_eq!(parse_signature(&sig).unwrap().1, 1);
        sig[64] = 0;
        assert!(parse_signature(&sig).is_none());
        sig[64] = 27;
        sig[32..64].copy_from_slice(&SECP256K1_HALF_ORDER);
        assert!(parse_signature(&sig).is_some());
        sig[63] = 0xA1; // half order + 1
        assert!(parse_signature(&sig).is_none());
        assert!(parse_signature(&sig[..64]).is_none());
        let zero_r = {
            let mut z = [0u8; 65];
            z[32] = 1;
            z[64] = 27;
            z
        };
        assert!(parse_signature(&zero_r).is_none());
    }
}
