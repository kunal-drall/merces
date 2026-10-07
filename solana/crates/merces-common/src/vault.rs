//! Payout-vault accounting (SPEC §6.3, §6.8, §6.9): cap truncation, fee, net accumulator, carry.

use crate::{add_u128, bps_of, mul_div, sub_u128, to_u64, MathError, MathResult, WAD};

/// Inputs to one gross receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReceiveInput {
    /// Gross amount offered (`G`).
    pub gross: u64,
    /// Units outstanding (`N`), must be `> 0`.
    pub units: u64,
    /// Per-unit cap in base units (`cap_per_unit`); `cap_wad = cap_per_unit × WAD`.
    pub cap_per_unit: u64,
    /// Current gross accumulator.
    pub paid_per_unit_wad: u128,
    /// Undistributed dust carried from earlier receipts.
    pub carry: u64,
    /// Payout fee (`payout_fee_bps`); 0 for `Final` distributions.
    pub fee_bps: u16,
}

/// Outcome of one gross receipt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReceiveOutcome {
    pub accepted: u64,
    pub refund: u64,
    pub inc_wad: u128,
    pub fee: u64,
    /// `net = accepted − fee + carry_in`.
    pub net: u64,
    pub delta_acc_wad: u128,
    pub distributed: u64,
    pub carry_out: u64,
    /// `true` when the cap was reached (series retires).
    pub retired: bool,
}

/// Payment / router receipt against the main cap (SPEC §6.3). The cap condition is
/// `paid + inc < cap` → accept all, otherwise truncate and retire.
pub fn receive_gross(input: ReceiveInput) -> MathResult<ReceiveOutcome> {
    if input.units == 0 {
        return Err(MathError::InvalidInput);
    }
    let n = u128::from(input.units);
    let g = u128::from(input.gross);
    let cap_wad = u128::from(input.cap_per_unit)
        .checked_mul(WAD)
        .ok_or(MathError::Overflow)?;
    let mut inc_wad = mul_div(g, WAD, n)?;
    let (accepted, refund, retired) = if add_u128(input.paid_per_unit_wad, inc_wad)? < cap_wad {
        (input.gross, 0u64, false)
    } else {
        let remaining_wad = sub_u128(cap_wad, input.paid_per_unit_wad)?;
        let accepted = to_u64(mul_div(remaining_wad, n, WAD)?)?;
        inc_wad = mul_div(u128::from(accepted), WAD, n)?;
        let refund = input
            .gross
            .checked_sub(accepted)
            .ok_or(MathError::Overflow)?;
        (accepted, refund, true)
    };
    distribute(input, accepted, refund, inc_wad, retired)
}

/// Tail receipt (SPEC §6.8): the cap condition is `paid + inc > cap` → truncate (no retire flag).
/// `cap_per_unit` here is `tail_cap_per_unit` and `paid_per_unit_wad` is `tail_paid_per_unit_wad`.
pub fn receive_tail(input: ReceiveInput) -> MathResult<ReceiveOutcome> {
    if input.units == 0 {
        return Err(MathError::InvalidInput);
    }
    let n = u128::from(input.units);
    let g = u128::from(input.gross);
    let cap_wad = u128::from(input.cap_per_unit)
        .checked_mul(WAD)
        .ok_or(MathError::Overflow)?;
    let mut inc_wad = mul_div(g, WAD, n)?;
    let (accepted, refund) = if add_u128(input.paid_per_unit_wad, inc_wad)? > cap_wad {
        let remaining_wad = sub_u128(cap_wad, input.paid_per_unit_wad)?;
        let accepted = to_u64(mul_div(remaining_wad, n, WAD)?)?;
        inc_wad = mul_div(u128::from(accepted), WAD, n)?;
        let refund = input
            .gross
            .checked_sub(accepted)
            .ok_or(MathError::Overflow)?;
        (accepted, refund)
    } else {
        (input.gross, 0u64)
    };
    distribute(input, accepted, refund, inc_wad, false)
}

/// Final (extinguishment) distribution (SPEC §6.9): no cap, no fee; `fee_bps` must be 0.
pub fn receive_final(gross: u64, units: u64, carry: u64) -> MathResult<ReceiveOutcome> {
    if units == 0 {
        return Err(MathError::InvalidInput);
    }
    let input = ReceiveInput {
        gross,
        units,
        cap_per_unit: u64::MAX,
        paid_per_unit_wad: 0,
        carry,
        fee_bps: 0,
    };
    distribute(input, gross, 0, 0, false)
}

fn distribute(
    input: ReceiveInput,
    accepted: u64,
    refund: u64,
    inc_wad: u128,
    retired: bool,
) -> MathResult<ReceiveOutcome> {
    let n = u128::from(input.units);
    let fee = bps_of(accepted, input.fee_bps)?;
    let net = accepted
        .checked_sub(fee)
        .ok_or(MathError::Overflow)?
        .checked_add(input.carry)
        .ok_or(MathError::Overflow)?;
    let delta_acc_wad = mul_div(u128::from(net), WAD, n)?;
    let distributed = to_u64(mul_div(delta_acc_wad, n, WAD)?)?;
    let carry_out = net.checked_sub(distributed).ok_or(MathError::Overflow)?;
    Ok(ReceiveOutcome {
        accepted,
        refund,
        inc_wad,
        fee,
        net,
        delta_acc_wad,
        distributed,
        carry_out,
        retired,
    })
}

/// Holder settlement: `floor((acc − last) × balance / WAD)`.
pub fn holder_delta(acc_wad: u128, last_acc_wad: u128, balance: u64) -> MathResult<u64> {
    let delta = sub_u128(acc_wad, last_acc_wad)?;
    to_u64(mul_div(delta, u128::from(balance), WAD)?)
}

/// `cap_per_unit = floor(cap_multiple_wad × P0 / WAD)`.
pub fn cap_per_unit(cap_multiple_wad: u64, clearing_price: u64) -> MathResult<u64> {
    to_u64(mul_div(
        u128::from(cap_multiple_wad),
        u128::from(clearing_price),
        WAD,
    )?)
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn plain_receipt() {
        let out = receive_gross(ReceiveInput {
            gross: 1_000_000,
            units: 100,
            cap_per_unit: 2_500_000,
            paid_per_unit_wad: 0,
            carry: 0,
            fee_bps: 500,
        })
        .unwrap();
        assert_eq!(out.accepted, 1_000_000);
        assert_eq!(out.refund, 0);
        assert_eq!(out.inc_wad, 10_000 * WAD);
        assert_eq!(out.fee, 50_000);
        assert_eq!(out.net, 950_000);
        assert_eq!(out.delta_acc_wad, 9_500 * WAD);
        assert_eq!(out.distributed, 950_000);
        assert_eq!(out.carry_out, 0);
        assert!(!out.retired);
    }

    #[test]
    fn dust_carries() {
        // net 999 over 7 units: delta = floor(999e18/7), distributed = floor(delta*7/1e18) = 994..998
        let out = receive_gross(ReceiveInput {
            gross: 999,
            units: 7,
            cap_per_unit: u64::MAX / 4,
            paid_per_unit_wad: 0,
            carry: 0,
            fee_bps: 0,
        })
        .unwrap();
        assert_eq!(out.distributed + out.carry_out, 999);
        assert!(out.carry_out < 7);
        // the carried dust is re-added next time
        let out2 = receive_gross(ReceiveInput {
            gross: 1,
            units: 7,
            cap_per_unit: u64::MAX / 4,
            paid_per_unit_wad: out.inc_wad,
            carry: out.carry_out,
            fee_bps: 0,
        })
        .unwrap();
        assert_eq!(out2.net, 1 + out.carry_out);
    }

    #[test]
    fn cap_truncation() {
        // cap 2_500_000 per unit, 100 units, already paid 2_400_000 per unit, gross 20_000_000
        let out = receive_gross(ReceiveInput {
            gross: 20_000_000,
            units: 100,
            cap_per_unit: 2_500_000,
            paid_per_unit_wad: 2_400_000 * WAD,
            carry: 0,
            fee_bps: 500,
        })
        .unwrap();
        assert!(out.retired);
        assert_eq!(out.accepted, 10_000_000);
        assert_eq!(out.refund, 10_000_000);
        assert_eq!(out.inc_wad, 100_000 * WAD);
        assert_eq!(out.fee, 500_000);
        // exactly at cap also retires
        let exact = receive_gross(ReceiveInput {
            gross: 10_000_000,
            units: 100,
            cap_per_unit: 2_500_000,
            paid_per_unit_wad: 2_400_000 * WAD,
            carry: 0,
            fee_bps: 500,
        })
        .unwrap();
        assert!(exact.retired);
        assert_eq!(exact.accepted, 10_000_000);
        assert_eq!(exact.refund, 0);
        // one below cap does not
        let below = receive_gross(ReceiveInput {
            gross: 9_999_999,
            units: 100,
            cap_per_unit: 2_500_000,
            paid_per_unit_wad: 2_400_000 * WAD,
            carry: 0,
            fee_bps: 500,
        })
        .unwrap();
        assert!(!below.retired);
    }

    #[test]
    fn tail_truncation_is_strict() {
        let exact = receive_tail(ReceiveInput {
            gross: 1_000,
            units: 10,
            cap_per_unit: 100,
            paid_per_unit_wad: 0,
            carry: 0,
            fee_bps: 500,
        })
        .unwrap();
        assert_eq!(exact.accepted, 1_000);
        assert_eq!(exact.refund, 0);
        let over = receive_tail(ReceiveInput {
            gross: 1_001,
            units: 10,
            cap_per_unit: 100,
            paid_per_unit_wad: 0,
            carry: 0,
            fee_bps: 500,
        })
        .unwrap();
        assert_eq!(over.accepted, 1_000);
        assert_eq!(over.refund, 1);
    }

    #[test]
    fn final_has_no_fee() {
        let out = receive_final(12_345, 10, 0).unwrap();
        assert_eq!(out.fee, 0);
        assert_eq!(out.distributed + out.carry_out, 12_345);
    }

    #[test]
    fn zero_units_rejected() {
        assert_eq!(
            receive_gross(ReceiveInput {
                gross: 1,
                units: 0,
                cap_per_unit: 1,
                paid_per_unit_wad: 0,
                carry: 0,
                fee_bps: 0
            }),
            Err(MathError::InvalidInput)
        );
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
            let paid_per_unit_wad = u128::from(core::cmp::min(paid_units, cap_per_unit)) * WAD;
            let out = receive_gross(ReceiveInput { gross, units, cap_per_unit, paid_per_unit_wad, carry, fee_bps }).unwrap();
            prop_assert_eq!(out.accepted + out.refund, gross);
            prop_assert!(paid_per_unit_wad + out.inc_wad <= u128::from(cap_per_unit) * WAD);
            prop_assert_eq!(out.accepted - out.fee + carry, out.net);
            prop_assert_eq!(out.distributed + out.carry_out, out.net);
            prop_assert!(out.carry_out < units);
            // each holder gets floor(delta × balance / WAD); the sum over any partition ≤ distributed
            let half = units / 2;
            let a = holder_delta(out.delta_acc_wad, 0, half).unwrap();
            let b = holder_delta(out.delta_acc_wad, 0, units - half).unwrap();
            prop_assert!(a + b <= out.distributed);
        }
    }
}
