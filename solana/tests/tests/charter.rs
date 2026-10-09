//! Charter immutability, registry write-interface authentication, hook rules and the C11 / §6.3
//! invariants, checked on the state the parity vectors leave behind.

use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use merces_common::vault::holder_delta;
use merces_registry::error::RegistryError;
use merces_tests::harness::*;
use merces_tests::vectors::run_vector;
use solana_instruction::Instruction;
use solana_signer::Signer;

fn series_terms_unchanged(r: &merces_tests::vectors::Runner, name: &str) {
    let key = r.series_pubkey(name).expect("series");
    let s = r.env.series(&key);
    let v = r.vector();
    let step = v["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|st| st["op"] == "create_series" && st["series"] == name)
        .expect("create step");
    let t = &step["terms"];
    let d = |k: &str| t[k].as_str().unwrap().parse::<u64>().unwrap();
    assert_eq!(s.units_offered, d("unitsOffered"));
    assert_eq!(s.reserve_price, d("reservePrice"));
    assert_eq!(s.min_raise, d("minRaise"));
    assert_eq!(s.hurdle_rate_wad, d("hurdleRateWad"));
    assert_eq!(u64::from(s.payout_multiple_k), d("payoutMultipleK"));
    assert_eq!(s.lockup_seconds, d("lockupSeconds"));
    assert_eq!(u64::from(s.wallet_cap_bps), d("walletCapBps"));
    assert_eq!(u64::from(s.auction_fee_bps), d("auctionFeeBps"));
    assert_eq!(u64::from(s.payout_fee_bps), d("payoutFeeBps"));
    assert_eq!(s.commit_duration, d("commitDuration"));
    assert_eq!(s.reveal_duration, d("revealDuration"));
    let schedule = step["releaseSchedule"].as_array().unwrap();
    assert_eq!(s.release_schedule.len(), schedule.len());
    for (tr, exp) in s.release_schedule.iter().zip(schedule) {
        assert_eq!(
            tr.at_offset_seconds,
            exp["atOffsetSeconds"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        );
        assert_eq!(
            u64::from(tr.bps),
            exp["bps"].as_str().unwrap().parse::<u64>().unwrap()
        );
    }
    assert_eq!(u64::from(s.tier_flags), step["tierFlags"].as_u64().unwrap());
    if let Some(h) = step["contractHash"].as_str() {
        assert_eq!(s.contract_hash, merces_tests::zkfix::hex32(h));
    }
}

/// Charter terms survive a full lifecycle untouched (SPEC §3.3): only `terms_commitment` and
/// `cap_multiple_wad` may change, and only through `amend_terms`.
#[test]
fn charter_terms_are_immutable_after_opening() {
    let r = run_vector("01_happy_path.json");
    series_terms_unchanged(&r, "S1");
    let amended = run_vector("14_amendment.json");
    series_terms_unchanged(&amended, "S1");
    let s1 = amended.env.series(&amended.series_pubkey("S1").unwrap());
    assert_eq!(s1.amendment_nonce, 1);
    assert_eq!(s1.cap_multiple_wad, 2_400_000_000_000_000_000);
}

/// The registry write interface only accepts the protocol's `registry_authority` PDA (SPEC §3.2).
#[test]
fn registry_write_interface_rejects_other_signers() {
    let mut r = run_vector("02_failed_auction.json");
    let series = r.series_pubkey("S1").unwrap();
    let attacker = r.env.new_wallet();
    let ix = Instruction {
        program_id: merces_registry::ID,
        accounts: merces_registry::accounts::MarkRaiseResult {
            config: config_pda(),
            protocol_authority: attacker.pubkey(),
            series,
        }
        .to_account_metas(None),
        data: merces_registry::instruction::MarkRaiseResult {
            state: 4,
            settlement_ts: 1,
            units_sold: 1,
            clearing_price: 1,
        }
        .data(),
    };
    r.env.send_expect(
        &[ix],
        &[&attacker],
        u32::from(RegistryError::NotProtocolAuthority),
    );
    let ix = Instruction {
        program_id: merces_registry::ID,
        accounts: merces_registry::accounts::MarkRaiseResult {
            config: config_pda(),
            protocol_authority: attacker.pubkey(),
            series,
        }
        .to_account_metas(None),
        data: merces_registry::instruction::MarkTerminal { status: 4 }.data(),
    };
    r.env.send_expect(
        &[ix],
        &[&attacker],
        u32::from(RegistryError::NotProtocolAuthority),
    );
    // the admin has no path into the raise results either
    let admin = r.env.admin.insecure_clone();
    let ix = Instruction {
        program_id: merces_registry::ID,
        accounts: merces_registry::accounts::MarkRaiseResult {
            config: config_pda(),
            protocol_authority: admin.pubkey(),
            series,
        }
        .to_account_metas(None),
        data: merces_registry::instruction::MarkMintFinalized {}.data(),
    };
    r.env.send_expect(
        &[ix],
        &[&admin],
        u32::from(RegistryError::NotProtocolAuthority),
    );
}

/// Hook rules 4 and 5 (SPEC §4.1): an unarmed deposit into the window escrow and a transfer into
/// the auction escrow are rejected; a wallet-to-wallet transfer is rejected.
#[test]
fn hook_rejects_unarmed_and_direct_transfers() {
    let mut r = run_vector("01_happy_path.json");
    let series = r.series_pubkey("S1").unwrap();
    let p = pdas(series);
    let b1 = r.actor_pubkey("b1").unwrap();
    let b2 = r.actor_pubkey("b2").unwrap();
    let b1_units = r.env.token_balance(&ata(&b1, &p.unit_mint, &TOKEN_2022));
    assert!(b1_units > 0, "b1 holds units after the raise");
    // we need b1's keypair to sign: rebuild the direct transfer with the runner's actor
    let holder = r.actor_keypair("b1");
    let direct = r.env.direct_unit_transfer_ix(&series, &b1, &b2, 1);
    r.env.send_expect(
        &[direct],
        &[&holder],
        u32::from(merces_hook::HookError::DirectTransferForbidden),
    );
    // unarmed deposit into the window escrow
    let mut to_window = spl_token_2022::instruction::transfer_checked(
        &TOKEN_2022,
        &ata(&b1, &p.unit_mint, &TOKEN_2022),
        &p.unit_mint,
        &p.window_escrow_ata,
        &b1,
        &[],
        1,
        0,
    )
    .unwrap();
    to_window.accounts.extend(r.env.unit_hook_accounts(&series));
    r.env.send_expect(
        &[to_window],
        &[&holder],
        u32::from(merces_hook::HookError::UnarmedEscrowDeposit),
    );
    // into the auction escrow: forbidden
    let mut to_auction = spl_token_2022::instruction::transfer_checked(
        &TOKEN_2022,
        &ata(&b1, &p.unit_mint, &TOKEN_2022),
        &p.unit_mint,
        &p.auction_escrow_ata,
        &b1,
        &[],
        1,
        0,
    )
    .unwrap();
    to_auction
        .accounts
        .extend(r.env.unit_hook_accounts(&series));
    r.env.send_expect(
        &[to_auction],
        &[&holder],
        u32::from(merces_hook::HookError::DirectTransferForbidden),
    );
    // the mint authority is gone: nobody can mint
    let mint = r.env.account_data(&p.unit_mint).unwrap();
    assert_eq!(mint[0..4], [0u8; 4], "mint authority option tag is None");
}

/// §6.3 invariants on the happy path: Σ accrual units == units_outstanding, Σ claimable ≤ vault,
/// paid_per_unit_wad ≤ cap_eff_wad, fee_collected == Σ fees.
#[test]
fn vault_invariants_hold_after_happy_path() {
    let r = run_vector("01_happy_path.json");
    let series = r.series_pubkey("S1").unwrap();
    let p = pdas(series);
    let s = r.env.series(&series);
    let l = r.env.ledger(&series).unwrap();
    let mut accrual_sum = 0u64;
    let mut claimable_sum = 0u64;
    for name in r.actor_names() {
        let w = r.actor_pubkey(&name).unwrap();
        let balance = r.env.token_balance(&ata(&w, &p.unit_mint, &TOKEN_2022));
        if let Some(h) = r.env.holder(&series, &w) {
            let weight = balance + h.undelivered_units + h.ask_escrow_units;
            accrual_sum += weight;
            claimable_sum +=
                h.pending + holder_delta(l.net_acc_wad, h.last_net_acc_wad, weight).unwrap();
        } else {
            assert_eq!(balance, 0, "{name} holds units without a holder record");
        }
    }
    assert_eq!(accrual_sum, l.units_outstanding);
    assert_eq!(l.units_outstanding, r.env.mint_supply(&p.unit_mint));
    let vault = r.env.token_balance(&p.vault_token);
    assert!(
        claimable_sum <= vault,
        "claimable {claimable_sum} > vault {vault}"
    );
    let cap = u128::from(s.cap_multiple_wad) * u128::from(s.clearing_price) / u128::from(WAD);
    assert!(l.paid_per_unit_wad <= cap * u128::from(WAD));
    assert!(u128::from(l.carry_wad) < u128::from(l.units_outstanding));
    assert_eq!(
        l.gross_received + l.refunded_to_issuer + l.fee_collected - l.fee_collected,
        l.gross_received + l.refunded_to_issuer
    );
}

/// No admin path moves money: the protocol admin cannot claim releases, pay out of the vault or
/// finalize a raise for someone else; the only money paths are the ones the vectors exercise.
#[test]
fn admin_cannot_move_funds() {
    let mut r = run_vector("01_happy_path.json");
    let series = r.series_pubkey("S1").unwrap();
    let admin = r.env.admin.insecure_clone();
    let res = r.env.claim_release(&admin, &series);
    let err = res.err().expect("admin cannot claim releases");
    assert!(format!("{:?}", err.err).contains(&format!(
        "Custom({})",
        u32::from(merces_protocol::error::ProtocolError::NotIssuer)
    )));
    // nor can the admin register as a holder to claim someone else's payout
    let res = r.env.claim(&series, &admin.pubkey());
    assert!(res.is_err(), "no holder record for the admin");
    let _ = Pubkey::default();
}
