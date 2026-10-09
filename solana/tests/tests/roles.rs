//! Role paths (SPEC §2, §3.2, §5.3) the parity vectors do not reach: the two-step admin
//! transfer, allowlist-manager and fee-collector rotation (each only by the admin, never to the
//! zero key), and the issuer's own release pause.

use anchor_lang::prelude::Pubkey;
use anchor_lang::InstructionData;
use merces_protocol::error::ProtocolError;
use merces_registry::error::RegistryError;
use merces_tests::harness::*;
use merces_tests::vectors::Runner;
use merces_tests::zkfix::vector_path;
use serde_json::Value;
use solana_signer::Signer;

fn expect_code(res: TxResult, code: u32, what: &str) {
    match res {
        Ok(_) => panic!("{what}: expected error {code}, transaction succeeded"),
        Err(f) => assert!(
            format!("{:?}", f.err).contains(&format!("Custom({code})")),
            "{what}: expected {code}, got {:?}\n{}",
            f.err,
            f.meta.logs.join("\n")
        ),
    }
}

#[test]
fn admin_transfer_is_two_step() {
    let mut env = Env::new();
    let old_admin = env.admin.insecure_clone();
    let next = env.new_wallet();
    let stranger = env.new_wallet();
    // only the admin starts a transfer, never to the zero key
    let ix = Env::admin_ix_by(
        &stranger.pubkey(),
        merces_registry::instruction::TransferAdmin {
            new_admin: stranger.pubkey(),
        }
        .data(),
    );
    expect_code(
        env.send(&[ix], &[&stranger]),
        u32::from(RegistryError::Unauthorized),
        "stranger transfer_admin",
    );
    expect_code(
        env.transfer_admin(Pubkey::default()),
        u32::from(RegistryError::ZeroAddress),
        "transfer to the zero key",
    );
    env.transfer_admin(next.pubkey()).unwrap();
    let cfg = env.config();
    assert_eq!(
        cfg.admin,
        old_admin.pubkey(),
        "the admin changes only on acceptance"
    );
    assert_eq!(cfg.pending_admin, next.pubkey());
    // only the pending admin accepts
    expect_code(
        env.accept_admin(&stranger),
        u32::from(RegistryError::NotPendingAdmin),
        "stranger accept_admin",
    );
    env.accept_admin(&next).unwrap();
    let cfg = env.config();
    assert_eq!(cfg.admin, next.pubkey());
    assert_eq!(cfg.pending_admin, Pubkey::default());
    // the old admin lost every admin path; the new one has them
    let ix = Env::admin_ix_by(
        &old_admin.pubkey(),
        merces_registry::instruction::SetFlags {
            new_raises_paused: true,
            windows_enabled: true,
            tier4_enabled: false,
        }
        .data(),
    );
    expect_code(
        env.send(&[ix], &[&old_admin]),
        u32::from(RegistryError::Unauthorized),
        "old admin after the transfer",
    );
    env.set_flags(false, true, false).unwrap();
    // a second acceptance is impossible: nothing is pending any more
    expect_code(
        env.accept_admin(&next),
        u32::from(RegistryError::NotPendingAdmin),
        "accept twice",
    );
}

#[test]
fn allowlist_manager_and_fee_collector_rotation() {
    let mut env = Env::new();
    let manager = env.new_wallet();
    let collector = env.new_wallet();
    let wallet = env.new_wallet();
    expect_code(
        env.set_allowlist_manager(Pubkey::default()),
        u32::from(RegistryError::ZeroAddress),
        "zero allowlist manager",
    );
    expect_code(
        env.set_fee_collector(Pubkey::default()),
        u32::from(RegistryError::ZeroAddress),
        "zero fee collector",
    );
    env.set_allowlist_manager(manager.pubkey()).unwrap();
    // the previous manager can no longer write the allowlist
    expect_code(
        env.allow(&wallet.pubkey(), true),
        u32::from(RegistryError::Unauthorized),
        "old allowlist manager",
    );
    env.allowlist_manager = manager.insecure_clone();
    env.allow(&wallet.pubkey(), true).unwrap();
    assert!(env.allowlist(&wallet.pubkey()).is_some_and(|e| e.allowed));
    env.set_fee_collector(collector.pubkey()).unwrap();
    assert_eq!(env.config().fee_collector, collector.pubkey());
    assert_eq!(env.config().allowlist_manager, manager.pubkey());
}

#[test]
fn issuer_release_pause() {
    let text = std::fs::read_to_string(vector_path("01_happy_path.json")).unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    let steps = v["steps"].as_array().unwrap();
    let settled = steps
        .iter()
        .rposition(|s| s["op"] == "deliver_bid")
        .unwrap();
    let mut r = Runner::run_value(v.clone(), Some(settled));
    let s1 = r.series_pubkey("S1").unwrap();
    let issuer = r.actor_keypair("issuer");
    let stranger = r.env.new_wallet();
    expect_code(
        r.env.set_release_pause(&stranger, &s1, true),
        u32::from(ProtocolError::NotIssuer),
        "stranger pauses releases",
    );
    r.env.set_release_pause(&issuer, &s1, true).unwrap();
    expect_code(
        r.env.claim_release(&issuer, &s1),
        u32::from(ProtocolError::ReleasesPausedByIssuer),
        "release while paused by the issuer",
    );
    r.env.set_release_pause(&issuer, &s1, false).unwrap();
    let before = r.env.treasury(&s1).unwrap().released_total;
    r.env.claim_release(&issuer, &s1).unwrap();
    assert!(r.env.treasury(&s1).unwrap().released_total > before);
}
