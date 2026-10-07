//! Chain-neutral Merces math (SPEC.md §1, §5–§7). Pure functions over integers; no Solana types.
#![no_std]
#![forbid(unsafe_code)]
#![deny(clippy::arithmetic_side_effects)]

/// 1e18 fixed point.
pub const WAD: u128 = 1_000_000_000_000_000_000;
