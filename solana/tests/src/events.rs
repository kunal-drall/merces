//! Decoding of Anchor `emit!` events from transaction logs (`Program data: <base64>`).

use std::collections::BTreeMap;
use std::sync::Mutex;

use anchor_lang::{AnchorDeserialize, Discriminator};
use base64::Engine;

/// Every event of type `T` in the logs, in order.
pub fn events_of<T: Discriminator + AnchorDeserialize>(logs: &[String]) -> Vec<T> {
    let mut out = Vec::new();
    for line in logs {
        if let Some(b64) = line.strip_prefix("Program data: ") {
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                if bytes.len() >= 8 && bytes[..8] == *T::DISCRIMINATOR {
                    if let Ok(ev) = T::try_from_slice(&bytes[8..]) {
                        out.push(ev);
                    }
                }
            }
        }
    }
    out
}

/// The single event of type `T`, panicking if there is not exactly one.
pub fn single_event<T: Discriminator + AnchorDeserialize>(logs: &[String]) -> T {
    let mut evs = events_of::<T>(logs);
    assert_eq!(
        evs.len(),
        1,
        "expected exactly one event, got {}",
        evs.len()
    );
    evs.remove(0)
}

/// Compute-unit consumption reported by the runtime for `program` in the logs
/// (`Program <id> consumed N of M compute units`).
pub fn consumed_cu(logs: &[String], program: &str) -> Option<u64> {
    let prefix = format!("Program {program} consumed ");
    logs.iter().find_map(|l| {
        l.strip_prefix(&prefix)
            .and_then(|rest| rest.split(' ').next())
            .and_then(|n| n.parse().ok())
    })
}

/// Per-instruction compute units observed in successful transactions: `(max, samples)` keyed by
/// `program::Instruction` (top-level) or `program::Instruction (CPI)` (an inner invocation: the
/// registry write interface called by the protocol, the hook called by Token-2022).
static CU_TABLE: Mutex<BTreeMap<String, (u64, u64)>> = Mutex::new(BTreeMap::new());

fn program_name(id: &str) -> Option<&'static str> {
    if id == merces_protocol::ID.to_string() {
        Some("merces_protocol")
    } else if id == merces_registry::ID.to_string() {
        Some("merces_registry")
    } else if id == merces_hook::ID.to_string() {
        Some("merces_hook")
    } else if id == mock_usdg_hook::ID.to_string() {
        Some("mock_usdg_hook")
    } else {
        None
    }
}

/// Largest serialized size seen per transaction shape (the instruction names of the Merces
/// instructions in it, by discriminator), for `MEASUREMENTS.md`.
static TX_SIZES: std::sync::Mutex<BTreeMap<String, usize>> = std::sync::Mutex::new(BTreeMap::new());

/// Records the serialized size of a transaction under the Merces program ids it calls.
pub fn record_tx_size(message: &solana_message::Message, size: usize) {
    let mut names: Vec<String> = Vec::new();
    for ix in &message.instructions {
        let id = message.account_keys[ix.program_id_index as usize].to_string();
        if let Some(p) = program_name(&id) {
            let disc = ix.data.get(..8).map(hex::encode).unwrap_or_default();
            names.push(format!("{p}:{disc}"));
        }
    }
    if names.is_empty() {
        return;
    }
    let mut t = TX_SIZES.lock().unwrap_or_else(|e| e.into_inner());
    let e = t.entry(names.join("+")).or_insert(0);
    *e = (*e).max(size);
}

/// Largest serialized transaction size per shape.
pub fn tx_sizes() -> BTreeMap<String, usize> {
    TX_SIZES.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Parses `Program <id> invoke [d]`, `Program log: Instruction: <Name>`, `Program <id> consumed
/// <n> of <m> compute units` and `Program <id> success|failed` lines and records the consumption
/// of every Merces program invocation (and of the mock USDG hook).
pub fn record_instruction_cu(logs: &[String]) {
    let mut stack: Vec<(String, Option<String>)> = Vec::new();
    let mut found: Vec<(String, u64)> = Vec::new();
    for line in logs {
        let Some(rest) = line.strip_prefix("Program ") else {
            continue;
        };
        if let Some(name) = rest.strip_prefix("log: Instruction: ") {
            if let Some(top) = stack.last_mut() {
                if top.1.is_none() {
                    top.1 = Some(name.trim().to_string());
                }
            }
            continue;
        }
        let mut parts = rest.split_whitespace();
        let (Some(id), Some(verb)) = (parts.next(), parts.next()) else {
            continue;
        };
        match verb {
            "invoke" => stack.push((id.to_string(), None)),
            "consumed" => {
                let n = parts.next().and_then(|n| n.parse::<u64>().ok());
                if let (Some(n), Some(prog)) = (n, program_name(id)) {
                    let depth = stack.len();
                    if let Some((_, Some(ix))) = stack.last() {
                        if depth == 1 {
                            found.push((format!("{prog}::{ix}"), n));
                        } else {
                            found.push((format!("{prog}::{ix} (CPI)"), n));
                        }
                    }
                }
            }
            "success" | "failed" => {
                stack.pop();
            }
            _ => {}
        }
    }
    if found.is_empty() {
        return;
    }
    let mut table = CU_TABLE.lock().unwrap_or_else(|e| e.into_inner());
    for (k, n) in found {
        let e = table.entry(k).or_insert((0, 0));
        e.0 = e.0.max(n);
        e.1 += 1;
    }
}

/// A copy of the compute-unit table recorded so far in this test binary.
pub fn cu_table() -> BTreeMap<String, (u64, u64)> {
    CU_TABLE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
