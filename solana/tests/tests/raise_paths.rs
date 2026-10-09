//! Raise and treasury paths beyond the parity vectors: a raise without any bid fails and
//! finalises an empty mint (authority revoked), cancellation revokes the mint authority, an
//! undeliverable winner never blocks the other deliveries or treasury releases, the early-draw
//! hook stays off until an approver co-signs, and tier-1 income of a raise that never settled
//! passes straight back to the issuer.

use anchor_lang::prelude::Pubkey;
use merces_protocol::error::ProtocolError;
use merces_protocol::state::{RAISE_CANCELLED, RAISE_FAILED};
use merces_registry::state::{RAISE_CANCELLED as REG_CANCELLED, RAISE_FAILED as REG_FAILED};
use merces_tests::harness::*;
use merces_tests::vectors::Runner;
use merces_tests::zkfix::vector_path;
use serde_json::Value;
use solana_signer::Signer;

fn expect_code(res: TxResult, e: ProtocolError) {
    match res {
        Ok(_) => panic!("expected {e:?}, transaction succeeded"),
        Err(f) => {
            let code = u32::from(e);
            assert!(
                format!("{:?}", f.err).contains(&format!("Custom({code})")),
                "expected {e:?} ({code}), got {:?}\n{}",
                f.err,
                f.meta.logs.join("\n")
            );
        }
    }
}

/// `true` when the Token-2022 mint has no mint authority (COption tag at bytes 0..4).
fn mint_authority_revoked(env: &Env, mint: &Pubkey) -> bool {
    let d = env.account_data(mint).expect("mint");
    d[0..4] == [0, 0, 0, 0]
}

fn vector(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(vector_path(name)).unwrap()).unwrap()
}

fn set_token_state(env: &mut Env, account: &Pubkey, state: u8) {
    let mut acc = env.svm.get_account(account).expect("token account");
    acc.data[108] = state;
    env.svm.set_account(*account, acc).unwrap();
}

#[test]
fn raise_without_bids_fails_and_finalises_an_empty_mint() {
    let mut env = Env::new();
    let issuer = env.new_wallet();
    let usdc = env.usdc;
    let series = env.setup_series(&issuer, &usdc, Env::default_series_args([1u8; 32]));
    env.open_raise(&issuer, &series).unwrap();
    let p = pdas(series);
    assert!(!mint_authority_revoked(&env, &p.unit_mint));
    let a = env.auction(&series).unwrap();
    env.warp(a.reveal_end);
    // whatever is proposed, no valid bid ⇒ Failed (SPEC §5.2 step 1)
    env.begin_settlement(&series, 1_000 * ONE_USDC, 7, 3)
        .unwrap();
    env.finalize_settlement(&series).unwrap();
    let a = env.auction(&series).unwrap();
    assert_eq!(a.state, RAISE_FAILED);
    assert!(a.mint_finalized && a.mint_authority_revoked);
    assert_eq!(a.clearing_price, 0);
    let s = env.series(&series);
    assert_eq!(s.raise_state, REG_FAILED);
    assert!(s.mint_finalized);
    assert!(mint_authority_revoked(&env, &p.unit_mint));
    assert_eq!(env.mint_supply(&p.unit_mint), 0);
    // the repayment path never opens for a failed raise
    let l = env.ledger(&series).unwrap();
    assert!(!l.is_mint_finalized());
    assert_eq!(l.units_outstanding, 0);
    expect_code(
        env.claim_release(&issuer, &series),
        ProtocolError::RaiseNotSettled,
    );
    expect_code(
        env.request_pause(&issuer, &series),
        ProtocolError::RaiseNotSettled,
    );
    expect_code(env.redeem(&issuer, &series), ProtocolError::RaiseNotSettled);
}

#[test]
fn cancelled_raise_revokes_the_mint_authority() {
    let mut env = Env::new();
    let issuer = env.new_wallet();
    let usdc = env.usdc;
    let series = env.setup_series(&issuer, &usdc, Env::default_series_args([2u8; 32]));
    env.open_raise(&issuer, &series).unwrap();
    env.cancel_raise(&issuer, &series).unwrap();
    let p = pdas(series);
    assert!(mint_authority_revoked(&env, &p.unit_mint));
    assert_eq!(env.auction(&series).unwrap().state, RAISE_CANCELLED);
    assert_eq!(env.series(&series).raise_state, REG_CANCELLED);
    expect_code(
        env.cancel_raise(&issuer, &series),
        ProtocolError::RaiseNotOpen,
    );
}

/// A winner whose stablecoin account is frozen cannot receive its refund: its delivery fails and
/// can be retried, while every other delivery and the treasury release go through (SPEC §5.2,
/// §12 liveness). The undelivered units keep their accrual weight meanwhile.
#[test]
fn undeliverable_winner_blocks_nothing() {
    let v = vector("01_happy_path.json");
    let steps = v["steps"].as_array().unwrap();
    let last_process = steps
        .iter()
        .rposition(|s| s["op"] == "process_bid")
        .unwrap();
    let release_at = steps
        .iter()
        .find(|s| s["op"] == "claim_release")
        .map(|s| s["t"].as_str().unwrap().parse::<u64>().unwrap())
        .unwrap();
    let mut r = Runner::run_value(v.clone(), Some(last_process));
    let s1 = r.series_pubkey("S1").unwrap();
    assert!(r.env.series(&s1).mint_finalized);
    let usdc = r.env.usdc;
    let bidders: Vec<Pubkey> = ["b1", "b2", "b3", "b4"]
        .iter()
        .map(|n| r.actor_pubkey(n).unwrap())
        .collect();
    let stuck = *bidders
        .iter()
        .find(|b| r.env.bid(&s1, b).unwrap().pending_refund > 0)
        .expect("a bidder with a refund");
    let stuck_bid = r.env.bid(&s1, &stuck).unwrap();
    let stuck_ata = r.env.ata_of(&stuck, &usdc);
    let before = r.env.balance_of(&stuck, &usdc);
    set_token_state(&mut r.env, &stuck_ata, 2);
    assert!(r.env.deliver_bid(&s1, &stuck).is_err());
    for b in bidders.iter().filter(|b| **b != stuck) {
        r.env.deliver_bid(&s1, b).unwrap();
    }
    // the undelivered units still count for the holder
    let h = r.env.holder(&s1, &stuck).unwrap();
    assert_eq!(h.undelivered_units, stuck_bid.pending_units);
    r.env.warp(release_at);
    let issuer = r.actor_keypair("issuer");
    r.env.claim_release(&issuer, &s1).unwrap();
    set_token_state(&mut r.env, &stuck_ata, 1);
    r.env.deliver_bid(&s1, &stuck).unwrap();
    assert_eq!(
        r.env.balance_of(&stuck, &usdc),
        before + stuck_bid.pending_refund
    );
    assert_eq!(r.env.holder(&s1, &stuck).unwrap().undelivered_units, 0);
}

/// The early-draw hook (brief R7/D4): off while the approver is unset; with an approver configured
/// the draw needs its co-signature, counts against vesting and never exceeds the proceeds.
#[test]
fn early_draw_needs_the_configured_approver() {
    let v = vector("01_happy_path.json");
    let steps = v["steps"].as_array().unwrap();
    let settled = steps
        .iter()
        .rposition(|s| s["op"] == "deliver_bid")
        .unwrap();
    let mut r = Runner::run_value(v.clone(), Some(settled));
    let s1 = r.series_pubkey("S1").unwrap();
    let issuer = r.actor_keypair("issuer");
    let approver = r.env.new_wallet();
    let impostor = r.env.new_wallet();
    expect_code(
        r.env.request_early_draw(&issuer, &approver, &s1, ONE_USDC),
        ProtocolError::EarlyDrawApproverUnset,
    );
    r.env.set_early_draw_approver(approver.pubkey()).unwrap();
    expect_code(
        r.env.request_early_draw(&issuer, &impostor, &s1, ONE_USDC),
        ProtocolError::EarlyDrawApproverMismatch,
    );
    let t = r.env.treasury(&s1).unwrap();
    expect_code(
        r.env
            .request_early_draw(&issuer, &approver, &s1, t.proceeds - t.released_total + 1),
        ProtocolError::EarlyDrawExceedsProceeds,
    );
    let usdc = r.env.usdc;
    let before = r.env.balance_of(&issuer.pubkey(), &usdc);
    r.env
        .request_early_draw(&issuer, &approver, &s1, 1_000 * ONE_USDC)
        .unwrap();
    assert_eq!(
        r.env.balance_of(&issuer.pubkey(), &usdc),
        before + 1_000 * ONE_USDC
    );
    let t2 = r.env.treasury(&s1).unwrap();
    assert_eq!(t2.released_total, t.released_total + 1_000 * ONE_USDC);
    assert_eq!(t2.early_draw_total, 1_000 * ONE_USDC);
    // turning the approver off again closes the hook
    r.env.set_early_draw_approver(Pubkey::default()).unwrap();
    expect_code(
        r.env.request_early_draw(&issuer, &approver, &s1, ONE_USDC),
        ProtocolError::EarlyDrawApproverUnset,
    );
}

/// Tier-1 income that reaches the router of a raise that never settles (cancelled) is not
/// stranded: `route` passes all of it to the issuer.
#[test]
fn router_of_a_cancelled_raise_passes_income_through() {
    let mut env = Env::new();
    let issuer = env.new_wallet();
    let client = env.new_wallet();
    let usdc = env.usdc;
    let salt = [3u8; 32];
    let (theta, r_wad) = (50_000 * ONE_USDC, 1_000_000_000_000_000u64);
    let commitment = merces_onchain::poseidon5(&[
        merces_onchain::u64_field(theta),
        merces_onchain::u64_field(r_wad),
        merces_onchain::u64_field(840),
        merces_onchain::u64_field(0),
        salt,
    ])
    .unwrap();
    let mut args = Env::default_series_args(commitment);
    args.tier_flags = 0b0001;
    args.tier1_terms = Some(Env::tier1_terms(theta, r_wad, 840, 0, salt));
    let series = env.setup_series(&issuer, &usdc, args);
    env.init_router(&series).unwrap();
    env.open_raise(&issuer, &series).unwrap();
    env.cancel_raise(&issuer, &series).unwrap();
    env.fund(&client.pubkey(), &usdc, 70_000 * ONE_USDC);
    let p = pdas(series);
    let ix = env.transfer_stable_ix(&client.pubkey(), &usdc, &p.router_token, 70_000 * ONE_USDC);
    env.send_ok(&[ix], &[&client]);
    let before = env.balance_of(&issuer.pubkey(), &usdc);
    env.route(&series).unwrap();
    assert_eq!(
        env.balance_of(&issuer.pubkey(), &usdc),
        before + 70_000 * ONE_USDC
    );
    assert_eq!(env.token_balance(&p.router_token), 0);
    assert_eq!(env.token_balance(&p.vault_token), 0);
}

/// S5: a tier-1 (split-router) amendment rewrites the series' θ / r and the amended share routes on
/// the next receipt. Solana now accepts the tier-1 plaintext in `amend_terms`, re-checks the §6.5
/// Poseidon(5) binding to the attestor-signed commitment, and `route` reads θ / r live from the
/// series (the `Router` snapshot stays at the creation value), matching EVM.
#[test]
fn tier1_amendment_reroutes_the_share() {
    use merces_common::encoding::amend_message;
    use merces_common::router::route as route_math;
    use merces_tests::sig::{keccak, EthSigner};

    let field = merces_onchain::u64_field;
    let commit5 = |theta: u64, r: u64, cur: u32, idx: u32, salt: [u8; 32]| {
        merces_onchain::poseidon5(&[
            field(theta),
            field(r),
            field(u64::from(cur)),
            field(u64::from(idx)),
            salt,
        ])
        .unwrap()
    };

    let mut env = Env::new();
    let issuer = env.new_wallet();
    let bidder = env.new_wallet();
    let client = env.new_wallet();
    let usdc = env.usdc;
    let attestor = EthSigner::from_seed(77);
    env.register_attestor(attestor.addr).unwrap();
    env.allow(&bidder.pubkey(), true).unwrap();

    // tier-1 series: θ = 50_000 USDC, r0 = 1e14 per unit (1 % over 100 units)
    let (theta, r0, r1) = (
        50_000 * ONE_USDC,
        100_000_000_000_000u64,
        200_000_000_000_000u64,
    );
    let (cur, idx) = (840u32, 0u32);
    let salt0 = [7u8; 32];
    let mut args = Env::default_series_args(commit5(theta, r0, cur, idx, salt0));
    args.tier_flags = 0b0001;
    args.wallet_cap_bps = 10_000; // one bidder takes the whole offer (no per-wallet cap)
    args.tier1_terms = Some(Env::tier1_terms(theta, r0, cur, idx, salt0));
    let series = env.setup_series(&issuer, &usdc, args);
    env.init_router(&series).unwrap();

    // settle a one-bid raise (100 units @ 1_000 USDC) so the mint finalises
    let price = 1_000 * ONE_USDC;
    let salt_bid = [9u8; 32];
    env.fund(&bidder.pubkey(), &usdc, 500_000 * ONE_USDC);
    env.open_raise(&issuer, &series).unwrap();
    let s = env.series(&series);
    env.commit_bid(
        &series,
        &bidder,
        commitment(price, 100, &salt_bid, &bidder.pubkey()),
        150_000 * ONE_USDC,
    )
    .unwrap();
    env.warp(START_TS + s.commit_duration);
    env.reveal_bid(&series, &bidder, price, 100, salt_bid).unwrap();
    env.warp(START_TS + s.commit_duration + s.reveal_duration + 1);
    env.settle(&series, price, 0, 100, &[bidder.pubkey()]).unwrap();
    assert!(env.series(&series).mint_finalized);
    let units = env.ledger(&series).unwrap().units_outstanding;
    assert_eq!(units, 100);

    // amend r0 → r1 (θ / currency / indexing unchanged, new salt + commitment)
    let salt1 = [11u8; 32];
    let tc1 = commit5(theta, r1, cur, idx, salt1);
    let new_cap = env.series(&series).cap_multiple_wad;
    let nonce = env.series(&series).amendment_nonce;
    let msg = keccak(&[amend_message(
        &env.config().domain,
        &series.to_bytes(),
        nonce,
        &tc1,
        new_cap,
    )
    .as_bytes()]);

    // a plaintext that does not match the signed commitment is rejected (§6.5 Poseidon binding)
    let bad = env.amend_terms(
        &issuer,
        &series,
        tc1,
        new_cap,
        Some(Env::tier1_terms(theta, r1 + 1, cur, idx, salt1)),
        attestor.addr,
        attestor.sign(&msg),
    );
    let mismatch = u32::from(merces_registry::error::RegistryError::Tier1TermsMismatch);
    assert!(
        format!("{:?}", bad.unwrap_err().err).contains(&format!("Custom({mismatch})")),
        "expected Tier1TermsMismatch"
    );

    // the real amendment rewrites θ / r on the series
    env.amend_terms(
        &issuer,
        &series,
        tc1,
        new_cap,
        Some(Env::tier1_terms(theta, r1, cur, idx, salt1)),
        attestor.addr,
        attestor.sign(&msg),
    )
    .unwrap();
    assert_eq!(env.series(&series).router_r_wad, r1);
    assert_eq!(env.series(&series).router_theta, theta);

    // route a receipt above θ: the issuer keeps `pass_through = amount − share`, so the amended r1
    // (not the stale r0 snapshot in the Router) determines how much is withheld for holders
    let amount = 100_000 * ONE_USDC;
    let p = pdas(series);
    env.fund(&client.pubkey(), &usdc, amount);
    let ix = env.transfer_stable_ix(&client.pubkey(), &usdc, &p.router_token, amount);
    env.send_ok(&[ix], &[&client]);
    let issuer_before = env.balance_of(&issuer.pubkey(), &usdc);
    env.route(&series).unwrap();
    let got = env.balance_of(&issuer.pubkey(), &usdc) - issuer_before;
    let expect1 = route_math(amount, theta, r1, units, 0).unwrap();
    let expect0 = route_math(amount, theta, r0, units, 0).unwrap();
    assert_ne!(
        expect1.pass_through, expect0.pass_through,
        "r1 must change the split"
    );
    assert_eq!(got, expect1.pass_through, "route used the amended r1");
}
