//! secp256k1 attestor / verifier keys for tests (SPEC §1.4): 65-byte `(r, s, v)` signatures with
//! `v ∈ {27, 28}` and low-`s`, identified by the 20-byte Ethereum-style address.

use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use k256::elliptic_curve::sec1::ToEncodedPoint;

/// A test signer.
#[derive(Clone)]
pub struct EthSigner {
    pub sk: SigningKey,
    pub addr: [u8; 20],
}

impl EthSigner {
    /// Deterministic key from a seed byte (never zero).
    pub fn from_seed(seed: u8) -> Self {
        let mut bytes = [0u8; 32];
        bytes[31] = seed;
        bytes[0] = 0x11;
        let sk = SigningKey::from_bytes(&bytes.into()).expect("valid secp256k1 scalar");
        let addr = eth_address(&sk);
        Self { sk, addr }
    }

    /// Signs a 32-byte digest, returning `r ‖ s ‖ v` with low-`s`.
    pub fn sign(&self, digest: &[u8; 32]) -> [u8; 65] {
        let (sig, rid): (Signature, RecoveryId) = self.sk.sign_prehash_recoverable(digest).expect("sign");
        let (sig, rid) = match sig.normalize_s() {
            Some(normalized) => (normalized, RecoveryId::new(!rid.is_y_odd(), rid.is_x_reduced())),
            None => (sig, rid),
        };
        let mut out = [0u8; 65];
        out[..64].copy_from_slice(&sig.to_bytes());
        out[64] = 27 + rid.to_byte();
        out
    }
}

/// `keccak256(uncompressed_pubkey[1..65])[12..32]`.
pub fn eth_address(sk: &SigningKey) -> [u8; 20] {
    let point = sk.verifying_key().to_encoded_point(false);
    let bytes = point.as_bytes();
    let hash = solana_keccak_hasher::hashv(&[&bytes[1..65]]).to_bytes();
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..32]);
    addr
}

/// keccak256 of concatenated parts.
pub fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    solana_keccak_hasher::hashv(parts).to_bytes()
}
