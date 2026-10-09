//! Test support for the Merces Solana programs: a LiteSVM harness that loads the compiled
//! programs from `target/deploy`, mock stablecoins (SPL "USDC" and Token-2022 "USDG" with the
//! real extension set), instruction builders for every registry and protocol instruction, event
//! decoding, secp256k1 attestor keys, ZK proof fixtures and the SPEC §11 parity-vector runner.

// Every builder returns LiteSVM's `Result<TransactionMetadata, FailedTransactionMetadata>` as-is so
// tests can inspect logs and compute units of failures; boxing it would only add noise.
#![allow(clippy::result_large_err)]
// Instruction builders mirror the on-chain argument lists one to one.
#![allow(clippy::too_many_arguments)]

pub mod curve;
pub mod events;
pub mod harness;
pub mod scenarios;
pub mod sig;
pub mod vectors;
pub mod zkfix;

pub use harness::*;
