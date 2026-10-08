//! Decoding of Anchor `emit!` events from transaction logs (`Program data: <base64>`).

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
    assert_eq!(evs.len(), 1, "expected exactly one event, got {}", evs.len());
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
