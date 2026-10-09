//! Payout-vault accounting (SPEC v1.1 §6.3, §6.8, §6.9): effective cap, truncation, fee, exact
//! WAD-scaled carry.
//!
//! The carry is kept as the exact WAD-scaled remainder (`carry_wad < N`, Track A defect S1): with
//! `num = net × WAD + carry_wad`, `delta_acc = floor(num / N)` and `carry_wad = num − delta_acc × N`,
//! `net_acc_wad × N + carry_wad == Σ net × WAD` holds exactly, so claims never exceed the vault.

use crate::{add_u128, bps_of, mul_div, sub_u128, to_u64, MathError, MathResult, WAD};

/// Inputs to one receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReceiveInput {
    /// Gross amount offered (`G`).
    pub gross: u64,
    /// Weight units (`N`), must be `> 0`.
    pub units: u64,
    /// Per-unit cap in base units per whole unit; `cap_wad = cap_per_unit × WAD / unit_scale`.
    pub cap_per_unit: u64,
    /// Accounting units per whole unit: 1 for sealed-bid series (whole units), `10^decimals` for
    /// curve-mode series, whose weights and per-unit accumulators are in base lamports (SPEC §9).
    pub unit_scale: u64,
    /// Current per-unit gross accumulator.
    pub paid_per_unit_wad: u128,
    /// Exact WAD-scaled remainder carried from earlier receipts (`< units`).
    pub carry_wad: u64,
    /// Fee (`payout_fee_bps`); 0 for `Final`.
    pub fee_bps: u16,
}

/// Outcome of one receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReceiveOutcome {
    pub accepted: u64,
    pub refund: u64,
    pub inc_wad: u128,
    pub fee: u64,
    /// `net = accepted − fee`.
    pub net: u64,
    pub delta_acc_wad: u128,
    pub carry_wad_out: u64,
    /// `true` when the (effective) cap was reached: the series retires / the tail is exhausted.
    pub capped: bool,
}

/// Receipt against a cap with the `<` boundary (SPEC §6.3 / §6.8): `paid + inc < cap_eff` accepts
/// all of `G`; otherwise the receipt is truncated to the remaining cap and `capped` is set.
/// `cap_eff_wad = max(cap_wad, paid_per_unit_wad)` so a lowered cap never underflows.
pub fn receive_capped(input: ReceiveInput) -> MathResult<ReceiveOutcome> {
    if input.units == 0 {
        return Err(MathError::InvalidInput);
    }
    let n = u128::from(input.units);
    let g = u128::from(input.gross);
    let cap_wad = scaled_cap_wad(input.cap_per_unit, input.unit_scale)?;
    let cap_eff_wad = core::cmp::max(cap_wad, input.paid_per_unit_wad);
    let mut inc_wad = mul_div(g, WAD, n)?;
    let (accepted, refund, capped) = if add_u128(input.paid_per_unit_wad, inc_wad)? < cap_eff_wad {
        (input.gross, 0u64, false)
    } else {
        let remaining_wad = sub_u128(cap_eff_wad, input.paid_per_unit_wad)?;
        let accepted = to_u64(mul_div(remaining_wad, n, WAD)?)?;
        inc_wad = mul_div(u128::from(accepted), WAD, n)?;
        let refund = input
            .gross
            .checked_sub(accepted)
            .ok_or(MathError::Overflow)?;
        (accepted, refund, true)
    };
    distribute(
        input.units,
        input.carry_wad,
        input.fee_bps,
        accepted,
        refund,
        inc_wad,
        capped,
    )
}

/// Final (extinguishment) distribution (SPEC §6.9): no cap, no fee.
pub fn receive_final(gross: u64, units: u64, carry_wad: u64) -> MathResult<ReceiveOutcome> {
    if units == 0 {
        return Err(MathError::InvalidInput);
    }
    distribute(units, carry_wad, 0, gross, 0, 0, false)
}

fn distribute(
    units: u64,
    carry_wad: u64,
    fee_bps: u16,
    accepted: u64,
    refund: u64,
    inc_wad: u128,
    capped: bool,
) -> MathResult<ReceiveOutcome> {
    let n = u128::from(units);
    let fee = bps_of(accepted, fee_bps)?;
    let net = accepted.checked_sub(fee).ok_or(MathError::Overflow)?;
    let num = u128::from(net)
        .checked_mul(WAD)
        .ok_or(MathError::Overflow)?
        .checked_add(u128::from(carry_wad))
        .ok_or(MathError::Overflow)?;
    let delta_acc_wad = num.checked_div(n).ok_or(MathError::DivisionByZero)?;
    let carry_wad_out = to_u64(num.checked_rem(n).ok_or(MathError::DivisionByZero)?)?;
    Ok(ReceiveOutcome {
        accepted,
        refund,
        inc_wad,
        fee,
        net,
        delta_acc_wad,
        carry_wad_out,
        capped,
    })
}

/// Holder settlement: `floor((acc − last) × weight / WAD)`.
pub fn holder_delta(acc_wad: u128, last_acc_wad: u128, weight: u64) -> MathResult<u64> {
    let delta = sub_u128(acc_wad, last_acc_wad)?;
    to_u64(mul_div(delta, u128::from(weight), WAD)?)
}

/// `WAD / unit_scale`: the WAD value of one base unit per whole unit, expressed per accounting
/// unit. `unit_scale` must divide `WAD` (1 or a power of ten up to 10^18), so the conversion is exact.
pub fn wad_per_scaled_unit(unit_scale: u64) -> MathResult<u128> {
    let s = u128::from(unit_scale);
    let q = WAD.checked_div(s).ok_or(MathError::InvalidInput)?;
    let r = WAD.checked_rem(s).ok_or(MathError::InvalidInput)?;
    if r != 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(q)
}

/// The cap per accounting unit as a WAD accumulator value: `cap_per_unit × WAD / unit_scale`
/// (exact; `unit_scale = 1` gives the SPEC §6.3 `cap_wad = cap_per_unit × WAD`).
pub fn scaled_cap_wad(cap_per_unit: u64, unit_scale: u64) -> MathResult<u128> {
    u128::from(cap_per_unit)
        .checked_mul(wad_per_scaled_unit(unit_scale)?)
        .ok_or(MathError::Overflow)
}

/// `floor(price × units / unit_scale)`: an amount for `units` accounting units at a price per
/// whole unit (redemption deposits and tenders of curve-mode series).
pub fn scaled_amount(price: u64, units: u64, unit_scale: u64) -> MathResult<u64> {
    if unit_scale == 0 {
        return Err(MathError::DivisionByZero);
    }
    to_u64(mul_div(
        u128::from(price),
        u128::from(units),
        u128::from(unit_scale),
    )?)
}

/// `cap_per_unit = floor(cap_multiple_wad × P0 / WAD)`.
pub fn cap_per_unit(cap_multiple_wad: u64, clearing_price: u64) -> MathResult<u64> {
    to_u64(mul_div(
        u128::from(cap_multiple_wad),
        u128::from(clearing_price),
        WAD,
    )?)
}

/// `cap_eff_wad − paid_per_unit_wad == 0` (a lowered cap already met): `retire_if_capped`.
pub fn is_capped(cap_per_unit: u64, paid_per_unit_wad: u128, unit_scale: u64) -> MathResult<bool> {
    Ok(paid_per_unit_wad >= scaled_cap_wad(cap_per_unit, unit_scale)?)
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn inp(gross: u64, units: u64, cap: u64, paid: u128, carry: u64, fee: u16) -> ReceiveInput {
        ReceiveInput {
            gross,
            units,
            cap_per_unit: cap,
            unit_scale: 1,
            paid_per_unit_wad: paid,
            carry_wad: carry,
            fee_bps: fee,
        }
    }

    #[test]
    fn plain_receipt() {
        let out = receive_capped(inp(1_000_000, 100, 2_500_000, 0, 0, 500)).unwrap();
        assert_eq!(out.accepted, 1_000_000);
        assert_eq!(out.refund, 0);
        assert_eq!(out.inc_wad, 10_000 * WAD);
        assert_eq!(out.fee, 50_000);
        assert_eq!(out.net, 950_000);
        assert_eq!(out.delta_acc_wad, 9_500 * WAD);
        assert_eq!(out.carry_wad_out, 0);
        assert!(!out.capped);
    }

    #[test]
    fn exact_carry_never_overpays() {
        // Track A S1 regression: N = 3, three net payments of 1 → a single holder of 3 units
        // must never claim more than 3.
        let mut acc = 0u128;
        let mut carry = 0u64;
        for _ in 0..3 {
            let out = receive_capped(inp(1, 3, u64::MAX / 4, 0, carry, 0)).unwrap();
            acc += out.delta_acc_wad;
            carry = out.carry_wad_out;
            assert!(carry < 3);
        }
        assert_eq!(holder_delta(acc, 0, 3).unwrap(), 3);
        assert_eq!(acc * 3 + u128::from(carry), 3 * WAD);
    }

    #[test]
    fn cap_truncation_and_effective_cap() {
        let out = receive_capped(inp(20_000_000, 100, 2_500_000, 2_400_000 * WAD, 0, 500)).unwrap();
        assert!(out.capped);
        assert_eq!(out.accepted, 10_000_000);
        assert_eq!(out.refund, 10_000_000);
        assert_eq!(out.inc_wad, 100_000 * WAD);
        // exactly at cap also caps
        let exact =
            receive_capped(inp(10_000_000, 100, 2_500_000, 2_400_000 * WAD, 0, 500)).unwrap();
        assert!(exact.capped);
        assert_eq!(exact.refund, 0);
        // one below does not
        assert!(
            !receive_capped(inp(9_999_999, 100, 2_500_000, 2_400_000 * WAD, 0, 500))
                .unwrap()
                .capped
        );
        // lowered cap below paid: effective cap = paid → accepted 0, full refund, capped
        let low = receive_capped(inp(5, 100, 1, 2_400_000 * WAD, 0, 500)).unwrap();
        assert!(low.capped);
        assert_eq!(low.accepted, 0);
        assert_eq!(low.refund, 5);
        assert!(is_capped(1, 2_400_000 * WAD, 1).unwrap());
        assert!(!is_capped(2_500_000, 2_400_000 * WAD, 1).unwrap());
        // curve-mode scale: 25 USDC per unit = 25 base units per base lamport (×WAD)
        assert!(is_capped(25_000_000, 25 * WAD, 1_000_000).unwrap());
        assert!(!is_capped(25_000_000, 25 * WAD - 1, 1_000_000).unwrap());
    }

    #[test]
    fn final_has_no_fee() {
        let out = receive_final(12_345, 10, 0).unwrap();
        assert_eq!(out.fee, 0);
        assert_eq!(
            out.delta_acc_wad * 10 + u128::from(out.carry_wad_out),
            12_345 * WAD
        );
    }

    #[test]
    fn zero_units_rejected() {
        assert_eq!(
            receive_capped(inp(1, 0, 1, 0, 0, 0)),
            Err(MathError::InvalidInput)
        );
        assert_eq!(receive_final(1, 0, 0), Err(MathError::InvalidInput));
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(2000))]
        #[test]
        fn cap_never_exceeded_and_conservation(
            gross in 0u64..10_000_000_000_000,
            units in 1u64..1_000_000,
            cap_per_unit in 1u64..1_000_000_000_000,
            paid_units in 0u64..1_000_000_000_000,
            carry in 0u64..1_000_000,
            fee_bps in 0u16..=2000,
        ) {
            let paid_per_unit_wad = u128::from(paid_units) * WAD;
            let carry = carry % units;
            let out = receive_capped(inp(gross, units, cap_per_unit, paid_per_unit_wad, carry, fee_bps)).unwrap();
            prop_assert_eq!(out.accepted + out.refund, gross);
            let cap_eff = core::cmp::max(u128::from(cap_per_unit) * WAD, paid_per_unit_wad);
            prop_assert!(paid_per_unit_wad + out.inc_wad <= cap_eff);
            prop_assert_eq!(out.accepted - out.fee, out.net);
            prop_assert!(out.carry_wad_out < units);
            // exactness of the WAD-scaled remainder
            prop_assert_eq!(out.delta_acc_wad * u128::from(units) + u128::from(out.carry_wad_out), u128::from(out.net) * WAD + u128::from(carry));
            // a partition of the units can never claim more than net
            let half = units / 2;
            let a = holder_delta(out.delta_acc_wad, 0, half).unwrap();
            let b = holder_delta(out.delta_acc_wad, 0, units - half).unwrap();
            prop_assert!(a + b <= out.net);
        }
    }
}
