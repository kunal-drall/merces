//! Chain-neutral Merces math (SPEC.md §1, §5–§7). Pure functions over integers; no Solana types.
//!
//! Every formula that decides who gets paid lives here exactly once. The programs call these
//! functions; the tests fuzz them. All arithmetic is checked and returns [`MathError`] on
//! overflow instead of panicking, so the on-chain callers can map it to a distinct error code.
#![no_std]
#![forbid(unsafe_code)]
#![deny(clippy::arithmetic_side_effects)]

pub mod auction;
pub mod curve;
pub mod encoding;
pub mod fx;
pub mod params;
#[cfg(test)]
mod properties;
pub mod redemption;
pub mod router;
pub mod status;
pub mod time;
pub mod treasury;
pub mod vault;
pub mod window;

/// 1e18 fixed point.
pub const WAD: u128 = 1_000_000_000_000_000_000;
/// `WAD` as `u64` (fits: 1e18 < 2^64).
pub const WAD_U64: u64 = 1_000_000_000_000_000_000;
/// 100% in basis points.
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Arithmetic failure. The on-chain programs map every variant to a distinct error code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    /// A checked operation overflowed `u64`/`u128`.
    Overflow,
    /// Division by zero.
    DivisionByZero,
    /// An input violates a documented precondition (for example a `bps` above 10 000).
    InvalidInput,
}

pub type MathResult<T> = Result<T, MathError>;

/// `floor(a × b / c)` in 128-bit arithmetic (SPEC §1.1 `mulDiv`).
pub fn mul_div(a: u128, b: u128, c: u128) -> MathResult<u128> {
    if c == 0 {
        return Err(MathError::DivisionByZero);
    }
    a.checked_mul(b)
        .ok_or(MathError::Overflow)?
        .checked_div(c)
        .ok_or(MathError::DivisionByZero)
}

/// `ceil(a / b)`.
pub fn div_ceil(a: u128, b: u128) -> MathResult<u128> {
    if b == 0 {
        return Err(MathError::DivisionByZero);
    }
    let q = a.checked_div(b).ok_or(MathError::DivisionByZero)?;
    let r = a.checked_rem(b).ok_or(MathError::DivisionByZero)?;
    if r == 0 {
        Ok(q)
    } else {
        q.checked_add(1).ok_or(MathError::Overflow)
    }
}

/// `floor(amount × bps / 10 000)` for a `u64` amount, returned as `u64`.
pub fn bps_of(amount: u64, bps: u16) -> MathResult<u64> {
    if u64::from(bps) > BPS_DENOMINATOR {
        return Err(MathError::InvalidInput);
    }
    let v = mul_div(
        u128::from(amount),
        u128::from(bps),
        u128::from(BPS_DENOMINATOR),
    )?;
    to_u64(v)
}

/// Narrow a `u128` to `u64`, failing with `Overflow` when it does not fit.
pub fn to_u64(v: u128) -> MathResult<u64> {
    u64::try_from(v).map_err(|_| MathError::Overflow)
}

/// Checked `u64` addition.
pub fn add_u64(a: u64, b: u64) -> MathResult<u64> {
    a.checked_add(b).ok_or(MathError::Overflow)
}

/// Checked `u64` subtraction (`a − b`, requires `a ≥ b`).
pub fn sub_u64(a: u64, b: u64) -> MathResult<u64> {
    a.checked_sub(b).ok_or(MathError::Overflow)
}

/// Checked `u64` multiplication.
pub fn mul_u64(a: u64, b: u64) -> MathResult<u64> {
    a.checked_mul(b).ok_or(MathError::Overflow)
}

/// Checked `u128` addition.
pub fn add_u128(a: u128, b: u128) -> MathResult<u128> {
    a.checked_add(b).ok_or(MathError::Overflow)
}

/// Checked `u128` subtraction.
pub fn sub_u128(a: u128, b: u128) -> MathResult<u128> {
    a.checked_sub(b).ok_or(MathError::Overflow)
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;

    #[test]
    fn mul_div_rounds_down() {
        assert_eq!(mul_div(7, 3, 2).unwrap(), 10);
        assert_eq!(mul_div(0, 3, 2).unwrap(), 0);
        assert_eq!(mul_div(u128::MAX, 1, 1).unwrap(), u128::MAX);
        assert_eq!(mul_div(u128::MAX, 2, 1), Err(MathError::Overflow));
        assert_eq!(mul_div(1, 1, 0), Err(MathError::DivisionByZero));
    }

    #[test]
    fn div_ceil_works() {
        assert_eq!(div_ceil(0, 5).unwrap(), 0);
        assert_eq!(div_ceil(5, 5).unwrap(), 1);
        assert_eq!(div_ceil(6, 5).unwrap(), 2);
        assert_eq!(div_ceil(1, 0), Err(MathError::DivisionByZero));
    }

    #[test]
    fn bps_of_bounds() {
        assert_eq!(bps_of(1_000_000, 100).unwrap(), 10_000);
        assert_eq!(bps_of(1_000_000, 10_000).unwrap(), 1_000_000);
        assert_eq!(bps_of(1, 10_001), Err(MathError::InvalidInput));
        assert_eq!(bps_of(u64::MAX, 10_000).unwrap(), u64::MAX);
        assert_eq!(bps_of(999, 100).unwrap(), 9);
    }
}
