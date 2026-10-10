//! stage1-oracle: Stage 1's Rust answering for the TypeScript port of its unit-scale and curve math.
//!
//! Reads one JSON case per line on stdin, `{"id":N,"fn":"<name>","a":{…}}`, and prints one line per case:
//! `{"id":N,"ok":{…}}`, `{"id":N,"err":"<MathError or program error>"}`, `{"id":N,"bad":"<malformed case>"}` or
//! `{"id":N,"panic":"…"}`. Integers are decimal strings.
//!
//! Every figure comes from merces-common (`stage1/solana/crates/merces-common`, the crate Stage 1's Solana programs
//! call). Where the TypeScript port mirrors a program routine rather than one merces-common function, the oracle
//! does what that routine does around the call and nothing else, citing it (`merces_protocol/src/common.rs` for the
//! vault and tail receipts, `exit.rs` for the redemption deposit and tail cap). Paths below are relative to
//! `stage1/solana`.

mod json;

use json::{boolean, int, obj, quote, J};
use merces_common::redemption::{redemption_price, year_gross_add, RedemptionInputs, YearGross};
use merces_common::vault::{receive_capped, ReceiveInput};
use merces_common::{curve, vault, MathError};
use std::io::{self, BufRead, BufWriter, Write};

enum Fail {
    /// merces-common's `MathError`
    Math(MathError),
    /// a program error the routine raises before calling merces-common (by its Stage 1 name)
    Program(&'static str),
    /// the case itself is malformed (never Stage 1's answer)
    Bad(String),
}

impl From<MathError> for Fail {
    fn from(e: MathError) -> Self {
        Fail::Math(e)
    }
}

impl From<String> for Fail {
    fn from(e: String) -> Self {
        Fail::Bad(e)
    }
}

type Out = Result<String, Fail>;

/// The tagged 4-slot `year_gross` ring as the Solana ledger stores it (`common.rs` `year_gross_ring`); a slot is
/// `{"year": <u32> | null, "gross_wad": "<u128>"}`, `null` for a slot never written (`set == false`).
fn ring_in(v: &J) -> Result<[YearGross; 4], String> {
    let slots = v.arr()?;
    if slots.len() != 4 {
        return Err(format!(
            "a year_gross ring has 4 slots, got {}",
            slots.len()
        ));
    }
    let mut ring = [YearGross::default(); 4];
    for (i, s) in slots.iter().enumerate() {
        let year = s.get("year")?;
        ring[i] = YearGross {
            year: if year.is_null() { 0 } else { year.u32()? },
            gross_wad: s.get("gross_wad")?.u128()?,
            set: !year.is_null(),
        };
    }
    Ok(ring)
}

fn ring_out(ring: &[YearGross; 4]) -> String {
    let slots: Vec<String> = ring
        .iter()
        .map(|s| {
            obj(&[
                (
                    "year",
                    if s.set {
                        s.year.to_string()
                    } else {
                        "null".into()
                    },
                ),
                ("gross_wad", int(s.gross_wad)),
            ])
        })
        .collect();
    format!("[{}]", slots.join(","))
}

fn add_u128(a: u128, b: u128) -> Result<u128, Fail> {
    a.checked_add(b).ok_or(Fail::Math(MathError::Overflow))
}

fn add_u64(a: u64, b: u64) -> Result<u64, Fail> {
    a.checked_add(b).ok_or(Fail::Math(MathError::Overflow))
}

fn run(f: &str, a: &J) -> Out {
    match f {
        // curve.rs:13-16
        "constants" => Ok(obj(&[
            (
                "curve_base_decimals",
                curve::CURVE_BASE_DECIMALS.to_string(),
            ),
            ("curve_unit_scale", int(curve::CURVE_UNIT_SCALE)),
        ])),
        // curve.rs:17-22
        "unit_scale_for" => Ok(obj(&[(
            "scale",
            int(curve::unit_scale_for(a.get("decimals")?.u8()?)?),
        )])),
        // vault.rs:125-135
        "wad_per_scaled_unit" => Ok(obj(&[(
            "wad",
            int(vault::wad_per_scaled_unit(a.get("unit_scale")?.u64()?)?),
        )])),
        // vault.rs:137-143
        "scaled_cap_wad" => Ok(obj(&[(
            "cap_wad",
            int(vault::scaled_cap_wad(
                a.get("cap_per_unit")?.u64()?,
                a.get("unit_scale")?.u64()?,
            )?),
        )])),
        // vault.rs:145-156
        "scaled_amount" => Ok(obj(&[(
            "amount",
            int(vault::scaled_amount(
                a.get("price")?.u64()?,
                a.get("units")?.u64()?,
                a.get("unit_scale")?.u64()?,
            )?),
        )])),
        // vault.rs:166-170
        "is_capped" => Ok(obj(&[(
            "capped",
            boolean(vault::is_capped(
                a.get("cap_per_unit")?.u64()?,
                a.get("paid_per_unit_wad")?.u128()?,
                a.get("unit_scale")?.u64()?,
            )?),
        )])),
        "receive_gross" => receive_gross(a),
        "receive_tail" => receive_tail(a),
        "redemption_price" => redemption(a),
        "cap_remaining" => cap_remaining(a),
        // curve.rs:24-39
        "p0_per_unit" => Ok(obj(&[(
            "p0",
            int(curve::p0_per_unit(
                a.get("migration_quote_threshold")?.u64()?,
                a.get("swap_base_amount")?.u64()?,
                a.get("token_decimal")?.u8()?,
            )?),
        )])),
        // curve.rs:41-53
        "swap_base_matches_offer" => Ok(obj(&[(
            "matches",
            boolean(curve::swap_base_matches_offer(
                a.get("swap_base_amount")?.u64()?,
                a.get("units_offered")?.u64()?,
                a.get("token_decimal")?.u8()?,
            )?),
        )])),
        // curve.rs:55-63
        "units_outstanding" => {
            let held: Vec<u64> = a
                .get("protocol_held")?
                .arr()?
                .iter()
                .map(|h| h.u64())
                .collect::<Result<_, _>>()?;
            Ok(obj(&[(
                "units",
                int(curve::units_outstanding(a.get("supply")?.u64()?, &held)?),
            )]))
        }
        // curve.rs:65-94
        "migration_fee_split" => {
            let (partner, creator) = curve::migration_fee_split(
                a.get("migration_quote_threshold")?.u64()?,
                a.get("fee_percentage")?.u8()?,
                a.get("creator_fee_percentage")?.u8()?,
            )?;
            Ok(obj(&[("partner", int(partner)), ("creator", int(creator))]))
        }
        // curve.rs:96-112
        "wallet_tender_fits" => Ok(obj(&[(
            "fits",
            boolean(curve::wallet_tender_fits(
                a.get("units_at_redemption")?.u64()?,
                a.get("tendered_total")?.u64()?,
                a.get("staked_total")?.u64()?,
                a.get("amount")?.u64()?,
            )?),
        )])),
        other => Err(Fail::Bad(format!("unknown fn `{other}`"))),
    }
}

/// The payout receipt as the Solana ledger books it (`programs/merces_protocol/src/common.rs:530-590`
/// `receive_gross`): `NoUnitsOutstanding` without units, merces-common's `receive_capped` (vault.rs:45-78), the
/// increment added to the year's slot (`year_gross_add`, redemption.rs:29-48) and the accumulators advanced.
fn receive_gross(a: &J) -> Out {
    let units = a.get("units")?.u64()?;
    if units == 0 {
        return Err(Fail::Program("NoUnitsOutstanding"));
    }
    let paid = a.get("paid_per_unit_wad")?.u128()?;
    let out = receive_capped(ReceiveInput {
        gross: a.get("gross")?.u64()?,
        units,
        cap_per_unit: a.get("cap_per_unit")?.u64()?,
        unit_scale: a.get("unit_scale")?.u64()?,
        paid_per_unit_wad: paid,
        carry_wad: a.get("carry_wad")?.u64()?,
        fee_bps: a.get("fee_bps")?.u16()?,
    })?;
    let mut ring = ring_in(a.get("ring")?)?;
    year_gross_add(&mut ring, a.get("year")?.u32()?, out.inc_wad)?;
    Ok(obj(&[
        ("accepted", int(out.accepted)),
        ("refund", int(out.refund)),
        ("inc_wad", int(out.inc_wad)),
        ("fee", int(out.fee)),
        ("net", int(out.net)),
        ("delta_acc_wad", int(out.delta_acc_wad)),
        ("carry_wad_out", int(out.carry_wad_out)),
        ("capped", boolean(out.capped)),
        ("paid_per_unit_wad", int(add_u128(paid, out.inc_wad)?)),
        (
            "net_acc_wad",
            int(add_u128(a.get("net_acc_wad")?.u128()?, out.delta_acc_wad)?),
        ),
        (
            "gross_received",
            int(add_u64(a.get("gross_received")?.u64()?, out.accepted)?),
        ),
        (
            "fee_collected",
            int(add_u64(a.get("fee_collected")?.u64()?, out.fee)?),
        ),
        (
            "refunded_to_issuer",
            int(add_u64(a.get("refunded_to_issuer")?.u64()?, out.refund)?),
        ),
        ("ring", ring_out(&ring)),
    ]))
}

/// The tail receipt as the Solana ledger books it (`common.rs:592-630` `receive_tail`): `NoUnitsOutstanding` without
/// units at redemption, `receive_capped` against the tail cap, the tail accumulators advanced; `capped` exhausts.
fn receive_tail(a: &J) -> Out {
    let units = a.get("units")?.u64()?;
    if units == 0 {
        return Err(Fail::Program("NoUnitsOutstanding"));
    }
    let paid = a.get("tail_paid_per_unit_wad")?.u128()?;
    let out = receive_capped(ReceiveInput {
        gross: a.get("gross")?.u64()?,
        units,
        cap_per_unit: a.get("tail_cap_per_unit")?.u64()?,
        unit_scale: a.get("unit_scale")?.u64()?,
        paid_per_unit_wad: paid,
        carry_wad: a.get("tail_carry_wad")?.u64()?,
        fee_bps: a.get("fee_bps")?.u16()?,
    })?;
    Ok(obj(&[
        ("accepted", int(out.accepted)),
        ("refund", int(out.refund)),
        ("inc_wad", int(out.inc_wad)),
        ("fee", int(out.fee)),
        ("net", int(out.net)),
        ("delta_acc_wad", int(out.delta_acc_wad)),
        ("carry_wad_out", int(out.carry_wad_out)),
        ("capped", boolean(out.capped)),
        ("tail_paid_per_unit_wad", int(add_u128(paid, out.inc_wad)?)),
        (
            "tail_acc_wad",
            int(add_u128(a.get("tail_acc_wad")?.u128()?, out.delta_acc_wad)?),
        ),
    ]))
}

/// The redemption price (redemption.rs:100-141 `redemption_price`) with the deposit and the tail cap `redeem` takes
/// from it (`programs/merces_protocol/src/exit.rs:125` `scaled_amount(price, units, scale)`, `:142-145`
/// `cap_remaining − price`).
fn redemption(a: &J) -> Out {
    let ring = ring_in(a.get("ring")?)?;
    let unit_scale = a.get("unit_scale")?.u64()?;
    let price = redemption_price(&RedemptionInputs {
        clearing_price: a.get("clearing_price")?.u64()?,
        hurdle_rate_wad: a.get("hurdle_rate_wad")?.u64()?,
        payout_multiple_k: a.get("payout_multiple_k")?.u16()?,
        cap_per_unit: a.get("cap_per_unit")?.u64()?,
        paid_per_unit_wad: a.get("paid_per_unit_wad")?.u128()?,
        year_gross: &ring,
        settlement_ts: a.get("settlement_ts")?.u64()?,
        now: a.get("now")?.u64()?,
        unit_scale,
    })?;
    let deposit = vault::scaled_amount(price.price, a.get("units")?.u64()?, unit_scale)?;
    let tail_cap = price
        .cap_remaining
        .checked_sub(price.price)
        .ok_or(Fail::Math(MathError::Overflow))?;
    Ok(obj(&[
        ("price", int(price.price)),
        ("hurdle", int(price.hurdle)),
        ("d_avg", int(price.d_avg)),
        ("cap_remaining", int(price.cap_remaining)),
        ("deposit", int(deposit)),
        ("tail_cap_per_unit", int(tail_cap)),
    ]))
}

/// `C_remaining` alone (redemption.rs:110-113), read off `redemption_price` with every other term neutral (no
/// elapsed time, a zero clearing price and hurdle, an empty ring), so only the cap and the paid accumulator decide.
fn cap_remaining(a: &J) -> Out {
    let ring = [YearGross::default(); 4];
    let price = redemption_price(&RedemptionInputs {
        clearing_price: 0,
        hurdle_rate_wad: 0,
        payout_multiple_k: 1,
        cap_per_unit: a.get("cap_per_unit")?.u64()?,
        paid_per_unit_wad: a.get("paid_per_unit_wad")?.u128()?,
        year_gross: &ring,
        settlement_ts: 0,
        now: 0,
        unit_scale: a.get("unit_scale")?.u64()?,
    })?;
    Ok(obj(&[("cap_remaining", int(price.cap_remaining))]))
}

fn math_name(e: MathError) -> &'static str {
    match e {
        MathError::Overflow => "Overflow",
        MathError::DivisionByZero => "DivisionByZero",
        MathError::InvalidInput => "InvalidInput",
    }
}

fn answer(line: &str) -> String {
    let case = match json::parse(line) {
        Ok(c) => c,
        Err(e) => return obj(&[("id", "null".into()), ("bad", quote(&e))]),
    };
    let id = match case.get("id").and_then(|v| v.u64()) {
        Ok(id) => id.to_string(),
        Err(e) => return obj(&[("id", "null".into()), ("bad", quote(&e))]),
    };
    let f = match case.get("fn") {
        Ok(J::Str(s)) => s.clone(),
        _ => return obj(&[("id", id), ("bad", quote("missing fn"))]),
    };
    let args = match case.get("a") {
        Ok(a) => a.clone(),
        Err(e) => return obj(&[("id", id), ("bad", quote(&e))]),
    };
    let outcome = std::panic::catch_unwind(|| run(&f, &args));
    match outcome {
        Ok(Ok(v)) => obj(&[("id", id), ("ok", v)]),
        Ok(Err(Fail::Math(e))) => obj(&[("id", id), ("err", quote(math_name(e)))]),
        Ok(Err(Fail::Program(name))) => obj(&[("id", id), ("err", quote(name))]),
        Ok(Err(Fail::Bad(why))) => obj(&[("id", id), ("bad", quote(&why))]),
        Err(p) => {
            let msg = p
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| p.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic".into());
            obj(&[("id", id), ("panic", quote(&msg))])
        }
    }
}

fn main() {
    // a panic is reported per case; keep the default hook from printing to stderr for each one
    std::panic::set_hook(Box::new(|_| {}));
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("stage1-oracle: cannot read stdin: {e}");
                std::process::exit(2);
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        if writeln!(out, "{}", answer(&line)).is_err() {
            std::process::exit(2);
        }
    }
    let _ = out.flush();
}
