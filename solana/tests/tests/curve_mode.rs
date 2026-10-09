//! Curve mode (SPEC §9, `docs/meteora/CURVE_MODE.md`) against the real Meteora DBC program (the
//! SDK's fixture build, vendored in `tests/fixtures/meteora`): a DBC config created with the
//! Merces generator's parameters and the series `curve_authority` PDA as partner, a Token-2022
//! pool created by the issuer, real swaps until the curve completes, the protocol's CPIs into DBC
//! for the proceeds, and the repayment path on base-lamport units. Post-migration DAMM v2 / locker
//! state is written byte-exactly from the program layouts where LiteSVM does not run those
//! programs.

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::Pubkey;
use merces_common::bps_of;
use merces_common::curve::CURVE_UNIT_SCALE;
use merces_common::encoding::{extinguish_message, report_message};
use merces_common::time::{period_end, period_of};
use merces_common::vault::{holder_delta, scaled_amount};
use merces_protocol::curve::{layout, DBC_POOL_AUTHORITY};
use merces_protocol::error::ProtocolError as P;
use merces_protocol::income::SubmitReportArgs;
use merces_registry::error::RegistryError as R;
use merces_registry::state::{MODE_CURVE, RAISE_OPEN, RAISE_SETTLED};
use merces_tests::curve::*;
use merces_tests::harness::*;
use merces_tests::sig::{keccak, EthSigner};
use merces_tests::zkfix::{hex32, hex_bytes};
use serde_json::Value;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn ok(res: TxResult, what: &str) {
    if let Err(e) = res {
        panic!("{what} failed: {:?}\n{}", e.err, e.meta.logs.join("\n"));
    }
}

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

fn reports() -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(fixture_dir().join("curve_reports.json")).unwrap(),
    )
    .unwrap()
}

fn read_u64(env: &Env, key: &Pubkey, off: usize) -> u64 {
    u64::from_le_bytes(env.raw(key)[off..off + 8].try_into().unwrap())
}

/// A launched curve series: DBC config + pool bound to the series, three buyers (`a`, `b`
/// allowlisted; `d` not), the curve completed and the proceeds collected.
struct Curve {
    env: Env,
    issuer: Keypair,
    series: Pubkey,
    dbc: Dbc,
    damm: Pubkey,
    attestor: EthSigner,
    a: Keypair,
    b: Keypair,
    d: Keypair,
}

fn new_curve_series(env: &mut Env, issuer: &Keypair) -> Pubkey {
    let x = fixture_u64(&curve_fixture(), "migrationQuoteThreshold");
    let terms = hex32(reports()["terms"]["terms_commitment"].as_str().unwrap());
    let usdc = env.usdc;
    let series = env.setup_series(issuer, &usdc, curve_series_args(terms, x));
    ok(env.prepare_curve(issuer, &series), "prepare_curve");
    series
}

fn activated() -> (Env, Keypair, Pubkey, Dbc) {
    let mut env = Env::new();
    env.load_dbc();
    let issuer = env.new_wallet();
    let series = new_curve_series(&mut env, &issuer);
    let usdc = env.usdc;
    let (res, config) = env.dbc_create_config(&curve_authority(&series), &usdc);
    ok(res, "dbc create_config");
    let (res, dbc) = env.dbc_create_pool(&config, &issuer, &usdc);
    ok(res, "dbc initialize_virtual_pool_with_token2022");
    ok(env.activate_curve(&issuer, &series, &dbc), "activate_curve");
    (env, issuer, series, dbc)
}

fn launched() -> Curve {
    let (mut env, issuer, series, dbc) = activated();
    let usdc = env.usdc;
    let attestor = EthSigner::from_seed(41);
    ok(env.register_attestor(attestor.addr), "register attestor");
    let mut buyers = Vec::new();
    for (i, amount) in [400u64, 350, 300].into_iter().enumerate() {
        let w = env.new_wallet();
        if i < 2 {
            ok(env.allow(&w.pubkey(), true), "allow buyer");
        }
        env.fund(&w.pubkey(), &usdc, 2_000 * ONE_USDC);
        ok(env.dbc_buy(&dbc, &w, amount * ONE_USDC), "dbc swap2");
        buyers.push(w);
    }
    let d = buyers.pop().unwrap();
    let b = buyers.pop().unwrap();
    let a = buyers.pop().unwrap();
    ok(env.complete_curve(&series), "complete_curve");
    ok(
        env.collect_curve_proceeds(&series),
        "collect_curve_proceeds",
    );
    let damm = env.mock_damm_config(&DBC_POOL_AUTHORITY);
    Curve {
        env,
        issuer,
        series,
        dbc,
        damm,
        attestor,
        a,
        b,
        d,
    }
}

impl Curve {
    fn base(&self, w: &Pubkey) -> u64 {
        self.env.balance_of(w, &self.dbc.base_mint)
    }

    /// The Q1 report (tier 3, the fixture proof for the scenario's units).
    fn report(&mut self, period: u32) -> TxResult {
        self.report_with(period, 0)
    }

    /// A tier-3 report with fixture proof `index` (0: 2,000 USDC; 1: 14,000 USDC, past the cap).
    fn report_with(&mut self, period: u32, index: usize) -> TxResult {
        let all = reports();
        let f = &all["fixtures"][index];
        let prior = hex32(f["prior_income_commitment"].as_str().unwrap());
        let income = hex32(f["income_commitment"].as_str().unwrap());
        let domain = self.env.config().domain;
        let msg = keccak(&[report_message(
            &domain,
            &self.series.to_bytes(),
            period,
            &prior,
            &income,
            3,
            false,
        )
        .as_bytes()]);
        let args = SubmitReportArgs {
            period,
            payment_usd: f["payment_usd"].as_str().unwrap().parse().unwrap(),
            fx_avg_wad: WAD,
            fx_fallback_sig: None,
            fx_attestor_addr: [0u8; 20],
            prior_income_commitment: prior,
            income_commitment: income,
            tier: 3,
            liquidity_event: false,
            proof: hex_bytes(f["proof"].as_str().unwrap()),
            attestation_sig: Some(self.attestor.sign(&msg)),
            attestation_addr: self.attestor.addr,
        };
        let issuer = self.issuer.insecure_clone();
        let series = self.series;
        self.env.submit_report(
            &issuer,
            &series,
            args,
            attestor_pda(&self.attestor.addr),
            config_pda(),
        )
    }
}

/// activate → buy → complete → collect → release → sync → register / stake (claim gating) →
/// report (sync required) → pay → claims by stake only → redeem → tender (stake reserved, wallet
/// quota) — with exact amounts throughout.
#[test]
fn curve_lifecycle_activate_sync_report_claim_tender() {
    let mut c = launched();
    let fixture = curve_fixture();
    let series = c.series;
    let base_mint = c.dbc.base_mint;
    let usdc = c.env.usdc;

    // --- activation and completion recorded in the registry --------------------------------
    let s = c.env.series(&series);
    assert_eq!(s.mode, MODE_CURVE);
    assert_eq!(s.raise_state, RAISE_SETTLED);
    assert!(s.mint_finalized);
    assert_eq!(s.clearing_price, fixture_u64(&fixture, "p0PerUnit"));
    assert_eq!(s.units_sold, fixture_u64(&fixture, "swapBaseAmount"));
    assert_eq!(
        (s.dbc_config, s.dbc_pool, s.base_mint),
        (c.dbc.config, c.dbc.pool, base_mint)
    );
    assert_eq!(s.unit_mint, base_mint);
    assert_eq!(s.dbc_creator, c.issuer.pubkey());
    let finish = read_u64(&c.env, &c.dbc.pool, layout::POOL_FINISH_CURVE_TIMESTAMP);
    assert!(finish > 0);
    assert_eq!(s.settlement_ts, finish);
    let l = c.env.ledger(&series).unwrap();
    assert_eq!(l.settlement_ts, finish);
    assert_eq!(l.first_period, period_of(finish).unwrap());
    assert_eq!(l.unit_scale, CURVE_UNIT_SCALE);

    // --- proceeds: the whole migration fee in the treasury, the partner fee to the collector ----
    let t = c.env.treasury(&series).unwrap();
    assert_eq!(t.proceeds, fixture_u64(&fixture, "partnerMigrationFee"));
    assert_eq!(
        c.env.token_balance(&pdas(series).treasury_token),
        t.proceeds
    );
    assert_eq!(
        read_u64(&c.env, &c.dbc.pool, layout::POOL_PARTNER_QUOTE_FEE),
        0
    );
    let fee_collected = c.env.balance_of(&c.env.fee_collector.pubkey(), &usdc);
    assert!(fee_collected > 0, "partner trading fee collected");
    // idempotent: nothing more to collect, proceeds unchanged
    ok(c.env.collect_curve_proceeds(&series), "collect again");
    assert_eq!(c.env.treasury(&series).unwrap().proceeds, t.proceeds);
    // the D4 schedule: 50 % at settlement
    let issuer = c.issuer.insecure_clone();
    ok(c.env.claim_release(&issuer, &series), "claim_release");
    assert_eq!(c.env.balance_of(&issuer.pubkey(), &usdc), t.proceeds / 2);

    // --- units outstanding: supply minus the DBC vault = what the buyers hold ----------------
    let (a, b, d) = (
        c.a.insecure_clone(),
        c.b.insecure_clone(),
        c.d.insecure_clone(),
    );
    let held = c.base(&a.pubkey()) + c.base(&b.pubkey()) + c.base(&d.pubkey());
    let damm = c.damm;
    ok(c.env.sync_curve_units(&series, &damm), "sync");
    let n = c.env.ledger(&series).unwrap().units_outstanding;
    assert_eq!(n, held);
    let fixture_units: u64 = reports()["fixtures"][0]["units_outstanding"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(n, fixture_units, "the proof fixture matches the DBC buys");

    // --- claim gating: allowlisted holders register and stake; others cannot ----------------
    ok(c.env.register_holder(&series, &a.pubkey()), "register a");
    ok(c.env.register_holder(&series, &b.pubkey()), "register b");
    ok(c.env.allow(&d.pubkey(), false), "d explicitly not allowed");
    expect_code(
        c.env.register_holder(&series, &d.pubkey()),
        u32::from(P::NotAllowlisted),
        "non-allowlisted register",
    );
    let a_units = c.base(&a.pubkey());
    let b_staked = 10 * CURVE_UNIT_SCALE;
    ok(c.env.stake_units(&a, &series, a_units), "a stakes all");
    ok(
        c.env.stake_units(&b, &series, b_staked),
        "b stakes 10 units",
    );
    assert_eq!(c.base(&a.pubkey()), 0);
    assert_eq!(
        c.env.token_balance(&stake_vault(&series, &base_mint)),
        a_units + b_staked
    );
    // staking never changes units outstanding (the stake vault is not protocol-held)
    ok(c.env.sync_curve_units(&series, &damm), "sync with stakes");
    assert_eq!(c.env.ledger(&series).unwrap().units_outstanding, n);

    // --- report: the units must be re-counted after the period ended ---------------------------
    let period = c.env.ledger(&series).unwrap().first_period;
    c.env.warp(period_end(period).unwrap() + 3_600);
    expect_code(
        c.report(period),
        u32::from(P::CurveUnitsNotSynced),
        "stale units",
    );
    ok(c.env.sync_curve_units(&series, &damm), "sync after period");
    ok(c.report(period), "submit_report");
    let due = c.env.ledger(&series).unwrap().open_due_amount;
    assert_eq!(due, 1_999_999_960);
    c.env.fund(&issuer.pubkey(), &usdc, due);
    ok(c.env.pay(&issuer, &series), "pay");
    let fee = bps_of(due, c.env.series(&series).payout_fee_bps).unwrap();
    let net = due - fee;
    let l = c.env.ledger(&series).unwrap();
    // per-base-lamport accumulator with the exact WAD carry
    assert_eq!(
        l.net_acc_wad * u128::from(n) + u128::from(l.carry_wad),
        u128::from(net) * u128::from(WAD)
    );

    // --- claims pay staked units only, exactly ---------------------------------------------------
    let vault_before = c.env.token_balance(&pdas(series).vault_token);
    assert_eq!(vault_before, net);
    ok(c.env.claim(&series, &a.pubkey()), "claim a");
    ok(c.env.claim(&series, &b.pubkey()), "claim b");
    let paid_a = c.env.balance_of(&a.pubkey(), &usdc) - (2_000 - 400) * ONE_USDC;
    let paid_b = c.env.balance_of(&b.pubkey(), &usdc) - (2_000 - 350) * ONE_USDC;
    assert_eq!(paid_a, holder_delta(l.net_acc_wad, 0, a_units).unwrap());
    assert_eq!(paid_b, holder_delta(l.net_acc_wad, 0, b_staked).unwrap());
    // the unstaked units' share stays in the vault (never over-paid)
    assert!(paid_a + paid_b <= net);
    // staking after a receipt earns nothing for it (debt pattern)
    ok(
        c.env.stake_units(&b, &series, 5 * CURVE_UNIT_SCALE),
        "b stakes more",
    );
    ok(c.env.claim(&series, &b.pubkey()), "claim b again");
    assert_eq!(
        c.env.balance_of(&b.pubkey(), &usdc) - (2_000 - 350) * ONE_USDC,
        paid_b
    );
    let b_staked = b_staked + 5 * CURVE_UNIT_SCALE;
    assert_eq!(
        c.env.holder(&series, &b.pubkey()).unwrap().staked_units,
        b_staked
    );

    // --- redemption by tender ------------------------------------------------------------------
    c.env.fund(&issuer.pubkey(), &usdc, 1_000 * ONE_USDC);
    let vault_mid = c.env.token_balance(&pdas(series).vault_token);
    ok(c.env.redeem_curve(&issuer, &series, &damm), "redeem");
    let l = c.env.ledger(&series).unwrap();
    assert_eq!(l.units_at_redemption, n);
    let price = l.redemption_price;
    assert!(price > 0);
    let deposit = scaled_amount(price, n, CURVE_UNIT_SCALE).unwrap();
    assert_eq!(
        c.env.token_balance(&pdas(series).vault_token),
        vault_mid + deposit
    );
    // staking is closed once redeemed
    expect_code(
        c.env.stake_units(&b, &series, 1),
        u32::from(P::TerminalStatus),
        "stake after redemption",
    );
    // a tenders its whole stake (burned by the stake vault PDA)
    let supply0 = c.env.mint_supply(&base_mint);
    let a_stable0 = c.env.balance_of(&a.pubkey(), &usdc);
    ok(
        c.env.tender_units(&a, &series, a_units, 0),
        "a tenders its stake",
    );
    assert_eq!(
        c.env.balance_of(&a.pubkey(), &usdc) - a_stable0,
        scaled_amount(price, a_units, CURVE_UNIT_SCALE).unwrap()
    );
    assert_eq!(c.env.mint_supply(&base_mint), supply0 - a_units);
    // b tenders its stake and its wallet units (burned by its own signature)
    let b_wallet = c.base(&b.pubkey());
    let b_stable0 = c.env.balance_of(&b.pubkey(), &usdc);
    ok(
        c.env.tender_units(&b, &series, b_staked, b_wallet),
        "b tenders all",
    );
    assert_eq!(
        c.env.balance_of(&b.pubkey(), &usdc) - b_stable0,
        scaled_amount(price, b_staked + b_wallet, CURVE_UNIT_SCALE).unwrap()
    );
    assert_eq!(c.base(&b.pubkey()), 0);
    let h = c.env.holder(&series, &b.pubkey()).unwrap();
    assert_eq!((h.staked_units, h.redeemed_units), (0, b_staked + b_wallet));
    // the unregistered holder cannot tender (claim gating)
    let res = c.env.tender_units(&d, &series, 0, 1);
    assert!(res.is_err(), "unregistered holder tendered");

    // --- the tender quota: units that were protocol-held at redemption cannot drain the deposit -
    // (mock: 10 units leave the DBC base vault for a registered holder `e`, as a post-redemption
    // release would, and `d` passes its units to `e`; the supply is unchanged)
    let e = c.env.new_wallet();
    ok(c.env.allow(&e.pubkey(), true), "allow e");
    ok(c.env.register_holder(&series, &e.pubkey()), "register e");
    let e_ata = c.env.create_ata(&e.pubkey(), &base_mint);
    let d_ata = ata(&d.pubkey(), &base_mint, &TOKEN_2022);
    let d_units = c.env.token_balance(&d_ata);
    let vault_units = c.env.token_balance(&c.dbc.base_vault);
    let moved = 10 * CURVE_UNIT_SCALE;
    c.env
        .set_token_amount(&c.dbc.base_vault, vault_units - moved);
    c.env.set_token_amount(&d_ata, 0);
    c.env.set_token_amount(&e_ata, moved + d_units);
    let l = c.env.ledger(&series).unwrap();
    let quota = l.units_at_redemption - l.tendered_total - l.staked_total;
    assert_eq!(quota, d_units, "only d's units remain unredeemed");
    expect_code(
        c.env.tender_units(&e, &series, 0, quota + 1),
        u32::from(P::TenderQuotaExhausted),
        "tender beyond the quota",
    );
    ok(
        c.env.tender_units(&e, &series, 0, quota),
        "tender the quota",
    );
    expect_code(
        c.env.tender_units(&e, &series, 0, 1),
        u32::from(P::TenderQuotaExhausted),
        "quota used up",
    );
    // the deposit covered every tender: what is left is d's never-claimable share plus the
    // unstaked units' share of the payout
    let l = c.env.ledger(&series).unwrap();
    assert_eq!(l.tendered_total, l.units_at_redemption);
    let tendered_paid: u64 = [a_units, b_staked + b_wallet, quota]
        .iter()
        .map(|u| scaled_amount(price, *u, CURVE_UNIT_SCALE).unwrap())
        .sum();
    assert!(tendered_paid <= deposit);
    assert_eq!(
        c.env.token_balance(&pdas(series).vault_token),
        vault_mid + deposit - tendered_paid
    );
}

/// `activate_curve` refuses every DBC setup that could bypass the treasury, mis-state `P0` or the
/// units, or give anyone power over the units; the registry refuses malformed curve series.
#[test]
fn curve_activation_validates_the_dbc_setup() {
    // a fresh activation-ready series for each probe
    let fresh = || {
        let mut env = Env::new();
        env.load_dbc();
        let issuer = env.new_wallet();
        let series = new_curve_series(&mut env, &issuer);
        let usdc = env.usdc;
        let (res, config) = env.dbc_create_config(&curve_authority(&series), &usdc);
        ok(res, "create_config");
        let (res, dbc) = env.dbc_create_pool(&config, &issuer, &usdc);
        ok(res, "create_pool");
        (env, issuer, series, dbc)
    };
    type Patch = (&'static str, usize, Vec<u8>, u32);
    let config_patches: Vec<Patch> = vec![
        (
            "creator migration-fee share",
            layout::CFG_CREATOR_MIGRATION_FEE_PCT,
            vec![50],
            u32::from(P::CreatorMigrationFeeBypassesTreasury),
        ),
        (
            "creator unlocked liquidity",
            layout::CFG_CREATOR_LIQ_PCT,
            vec![10],
            u32::from(P::CreatorLiquidityBypassesTreasury),
        ),
        (
            "creator vesting liquidity",
            layout::CFG_CREATOR_LIQ_VESTING_PCT,
            vec![10],
            u32::from(P::CreatorLiquidityBypassesTreasury),
        ),
        (
            "DAMM v1 migration",
            layout::CFG_MIGRATION_OPTION,
            vec![0],
            u32::from(P::DbcMigrationOptionUnsupported),
        ),
        (
            "9 decimals",
            layout::CFG_TOKEN_DECIMAL,
            vec![9],
            u32::from(P::DbcTokenUnsupported),
        ),
        (
            "SPL base token",
            layout::CFG_TOKEN_TYPE,
            vec![0],
            u32::from(P::DbcTokenUnsupported),
        ),
        (
            "dynamic supply",
            layout::CFG_FIXED_SUPPLY_FLAG,
            vec![0],
            u32::from(P::DbcTokenUnsupported),
        ),
        (
            "Token-2022 quote flag",
            layout::CFG_QUOTE_TOKEN_FLAG,
            vec![1],
            u32::from(P::DbcQuoteProgramMismatch),
        ),
        (
            "another fee claimer",
            layout::CFG_FEE_CLAIMER,
            Pubkey::new_unique().to_bytes().to_vec(),
            u32::from(P::DbcFeeClaimerMismatch),
        ),
        (
            "another leftover receiver",
            layout::CFG_LEFTOVER_RECEIVER,
            Pubkey::new_unique().to_bytes().to_vec(),
            u32::from(P::DbcFeeClaimerMismatch),
        ),
        (
            "another quote mint",
            layout::CFG_QUOTE_MINT,
            Pubkey::new_unique().to_bytes().to_vec(),
            u32::from(P::DbcQuoteMintMismatch),
        ),
        (
            "threshold differs from min_raise",
            layout::CFG_MIGRATION_QUOTE_THRESHOLD,
            999_000_000u64.to_le_bytes().to_vec(),
            u32::from(P::CurveThresholdMismatch),
        ),
        (
            "sells other units",
            layout::CFG_SWAP_BASE_AMOUNT,
            150_000_000u64.to_le_bytes().to_vec(),
            u32::from(P::CurveUnitsMismatch),
        ),
        (
            "wrong account type",
            0,
            vec![0u8; 8],
            u32::from(P::DbcAccountInvalid),
        ),
    ];
    for (what, off, bytes, code) in config_patches {
        let (mut env, issuer, series, dbc) = fresh();
        env.patch(&dbc.config, off, &bytes);
        expect_code(env.activate_curve(&issuer, &series, &dbc), code, what);
    }
    // pool-side probes
    let (mut env, issuer, series, dbc) = fresh();
    let stranger = Pubkey::new_unique();
    env.patch(&dbc.pool, layout::POOL_CREATOR, stranger.as_ref());
    expect_code(
        env.activate_curve(&issuer, &series, &dbc),
        u32::from(P::CurveCreatorInvalid),
        "third-party creator",
    );
    // the PDA as creator cannot hold an issuer allocation in a locker (the fixture vests 10 units)
    env.patch(
        &dbc.pool,
        layout::POOL_CREATOR,
        curve_authority(&series).as_ref(),
    );
    expect_code(
        env.activate_curve(&issuer, &series, &dbc),
        u32::from(P::CurveCreatorLockedVesting),
        "PDA creator with locked vesting",
    );
    let (mut env, issuer, series, mut dbc) = fresh();
    dbc.base_mint = env.usdc;
    expect_code(
        env.activate_curve(&issuer, &series, &dbc),
        u32::from(P::DbcPoolMismatch),
        "base mint of another pool",
    );
    // a base mint someone could still mint or freeze
    let (mut env, issuer, series, dbc) = fresh();
    let mut auth = vec![1u8, 0, 0, 0];
    auth.extend_from_slice(Pubkey::new_unique().as_ref());
    env.patch(&dbc.base_mint, 0, &auth);
    expect_code(
        env.activate_curve(&issuer, &series, &dbc),
        u32::from(P::CurveMintAuthority),
        "mint authority present",
    );
    // a config owned by another program
    let (mut env, issuer, series, mut dbc) = fresh();
    let data = env.raw(&dbc.config);
    let fake = Pubkey::new_unique();
    env.put_account(&fake, &merces_protocol::ID, data);
    dbc.config = fake;
    expect_code(
        env.activate_curve(&issuer, &series, &dbc),
        u32::from(P::DbcAccountInvalid),
        "config not owned by DBC",
    );
    // a curve that completed before activation can no longer be bound to the series
    let (mut env, issuer, series, dbc) = fresh();
    let usdc = env.usdc;
    let w = env.new_wallet();
    env.fund(&w.pubkey(), &usdc, 2_000 * ONE_USDC);
    ok(env.dbc_buy(&dbc, &w, 1_100 * ONE_USDC), "buy out the curve");
    expect_code(
        env.activate_curve(&issuer, &series, &dbc),
        u32::from(P::CurveAlreadyComplete),
        "activation after completion",
    );
    // activation is once: the series is Open afterwards
    let (mut env, issuer, series, dbc) = fresh();
    ok(env.activate_curve(&issuer, &series, &dbc), "activate");
    assert_eq!(env.series(&series).raise_state, RAISE_OPEN);
    expect_code(
        env.activate_curve(&issuer, &series, &dbc),
        u32::from(P::NotDraft),
        "second activation",
    );
    // the curve is not complete: complete_curve refuses, nothing settles
    expect_code(
        env.complete_curve(&series),
        u32::from(P::CurveNotComplete),
        "incomplete curve",
    );

    // registry rules for curve series (SPEC §9)
    let mut env = Env::new();
    let issuer = env.new_wallet();
    ok(env.register_issuer(&issuer.pubkey()), "register issuer");
    ok(env.allow(&issuer.pubkey(), true), "allow issuer");
    let (usdc, usdg) = (env.usdc, env.usdg);
    let mut args = curve_series_args([9u8; 32], 1_000 * ONE_USDC);
    args.issuer_accepts_public_price = false;
    expect_code(
        env.create_series_tx(&issuer, &usdc, None, args).0,
        u32::from(R::PublicPriceNotAccepted),
        "public price",
    );
    let args = curve_series_args([9u8; 32], 1_000 * ONE_USDC);
    expect_code(
        env.create_series_tx(&issuer, &usdg, None, args).0,
        u32::from(R::CurveQuoteMintMismatch),
        "USDG quote",
    );
    let mut args = curve_series_args([9u8; 32], 1_000 * ONE_USDC);
    args.lockup_seconds = 1;
    expect_code(
        env.create_series_tx(&issuer, &usdc, None, args).0,
        u32::from(R::CurveTermsNotZero),
        "lockup",
    );
    let mut args = curve_series_args([9u8; 32], 1_000 * ONE_USDC);
    args.wallet_cap_bps = 1_000;
    expect_code(
        env.create_series_tx(&issuer, &usdc, None, args).0,
        u32::from(R::CurveTermsNotZero),
        "wallet cap",
    );
    let args = curve_series_args([9u8; 32], 0);
    expect_code(
        env.create_series_tx(&issuer, &usdc, None, args).0,
        u32::from(R::CurveThresholdZero),
        "zero threshold",
    );
}

/// `sync_curve_units` derives every protocol-held account and refuses substitutes; after a
/// (mocked) migration the DAMM v2 pool vault, the locker escrow and the leftover receiver are
/// counted, and units released from the locker become outstanding.
#[test]
fn curve_census_counts_exactly_the_protocol_held_units() {
    let mut c = launched();
    let series = c.series;
    let base = c.dbc.base_mint;
    let usdc = c.env.usdc;
    let damm = c.damm;
    ok(c.env.sync_curve_units(&series, &damm), "sync");
    let n0 = c.env.ledger(&series).unwrap().units_outstanding;
    let census = c.env.curve_census(&series, &damm);

    // substitutes are refused, one account at a time
    let wrong_authority = c.env.mock_damm_config(&Pubkey::new_unique());
    let mut bad = c.env.curve_census(&series, &wrong_authority);
    let ix = c.env.sync_curve_units_ix(&series, bad);
    expect_code(
        c.env.send(&[ix], &[]),
        u32::from(P::DammConfigInvalid),
        "config of another creator",
    );
    for (i, code, what) in [
        (
            2usize,
            u32::from(P::DbcVaultMismatch),
            "a holder's account as the DBC vault",
        ),
        (4, u32::from(P::DammPoolMismatch), "an arbitrary DAMM pool"),
        (
            5,
            u32::from(P::DammVaultMismatch),
            "the stake vault as the DAMM vault",
        ),
        (
            6,
            u32::from(P::LockerEscrowMismatch),
            "an arbitrary locker escrow",
        ),
        (
            7,
            u32::from(P::LeftoverAccountMismatch),
            "an arbitrary leftover account",
        ),
    ] {
        bad = census;
        bad[i] = ata(&c.a.pubkey(), &base, &TOKEN_2022);
        if i == 5 {
            bad[i] = stake_vault(&series, &base);
        }
        let ix = c.env.sync_curve_units_ix(&series, bad);
        expect_code(c.env.send(&[ix], &[]), code, what);
    }

    // mocked migration (PROG migrate_damm_v2 + create_locker + withdraw_leftover): the DBC vault
    // keeps Meteora's protocol base fee, the DAMM v2 vault takes the deposit, the locker escrow
    // the issuer allocation, the leftover receiver the dust — base lamports only move
    let vault0 = c.env.token_balance(&c.dbc.base_vault);
    let fixture = curve_fixture();
    let vesting = fixture_u64(&fixture, "lockedVestingTotal");
    let protocol_fee = 7u64;
    let leftover = 3u64;
    let deposit = vault0 - vesting - protocol_fee - leftover;
    c.env
        .patch(&c.dbc.pool, layout::POOL_MIGRATION_PROGRESS, &[3]);
    // the migrated pool must be counted now: without the pool account the census is refused
    let ix = c.env.sync_curve_units_ix(&series, census);
    expect_code(
        c.env.send(&[ix], &[]),
        u32::from(P::DammPoolMissing),
        "migrated pool omitted",
    );
    c.env.mock_damm_pool(&census[4]);
    c.env.set_token_amount(&c.dbc.base_vault, protocol_fee);
    c.env
        .mock_token_account(&census[5], &base, &DBC_POOL_AUTHORITY, deposit);
    let escrow_owner = Pubkey::new_unique();
    c.env
        .mock_token_account(&census[6], &base, &escrow_owner, vesting);
    c.env
        .mock_token_account(&census[7], &base, &curve_authority(&series), leftover);
    ok(
        c.env.sync_curve_units(&series, &damm),
        "sync after migration",
    );
    assert_eq!(c.env.ledger(&series).unwrap().units_outstanding, n0);
    // the issuer claims vested units from the locker: they become outstanding
    let released = 4 * CURVE_UNIT_SCALE;
    c.env.set_token_amount(&census[6], vesting - released);
    let issuer_ata = c.env.create_ata(&c.issuer.pubkey(), &base);
    c.env.set_token_amount(&issuer_ata, released);
    ok(
        c.env.sync_curve_units(&series, &damm),
        "sync after a vesting claim",
    );
    assert_eq!(
        c.env.ledger(&series).unwrap().units_outstanding,
        n0 + released
    );
    // a trader buys units out of the DAMM pool: outstanding again grows by exactly that
    let bought = 100_000u64;
    c.env.set_token_amount(&census[5], deposit - bought);
    let ta = c.env.create_ata(&c.d.pubkey(), &base);
    let d_units = c.env.token_balance(&ta);
    c.env.set_token_amount(&ta, d_units + bought);
    ok(
        c.env.sync_curve_units(&series, &damm),
        "sync after a DAMM trade",
    );
    assert_eq!(
        c.env.ledger(&series).unwrap().units_outstanding,
        n0 + released + bought
    );
    let _ = usdc;
}

/// Staking rules: bounded by the synced units, allowlisted wallets only, never more than staked
/// out; the sealed-bid-only paths (burns, claim_redemption, the raise, the window) are closed.
#[test]
fn curve_staking_rules_and_closed_sealed_bid_paths() {
    let mut c = launched();
    let series = c.series;
    let damm = c.damm;
    let a = c.a.insecure_clone();
    let b = c.b.insecure_clone();
    ok(c.env.register_holder(&series, &a.pubkey()), "register a");
    ok(c.env.register_holder(&series, &b.pubkey()), "register b");
    // nothing synced yet: no stake can be covered
    expect_code(
        c.env.stake_units(&a, &series, 1),
        u32::from(P::StakeExceedsOutstanding),
        "stake before any sync",
    );
    ok(c.env.sync_curve_units(&series, &damm), "sync");
    let a_units = c.base(&a.pubkey());
    expect_code(
        c.env.stake_units(&a, &series, 0),
        u32::from(P::ZeroUnits),
        "zero stake",
    );
    ok(c.env.stake_units(&a, &series, a_units), "stake");
    expect_code(
        c.env.unstake_units(&a, &series, a_units + 1),
        u32::from(P::InsufficientStake),
        "unstake beyond the stake",
    );
    // de-allowlisted: no new stake, but unstaking and claiming still work (C10)
    ok(c.env.allow(&b.pubkey(), false), "remove b");
    expect_code(
        c.env.stake_units(&b, &series, 1),
        u32::from(P::NotAllowlisted),
        "stake after removal",
    );
    ok(c.env.allow(&a.pubkey(), false), "remove a");
    ok(
        c.env.unstake_units(&a, &series, a_units / 2),
        "unstake after removal",
    );
    ok(c.env.claim(&series, &a.pubkey()), "claim after removal");
    assert_eq!(c.base(&a.pubkey()), a_units / 2);
    // the sealed-bid paths are closed for a curve series
    expect_code(
        c.env.burn_retired(&series, &a.pubkey()),
        u32::from(P::CurveModeNoBurn),
        "burn_retired",
    );
    expect_code(
        c.env.claim_redemption(&series, &a.pubkey()),
        u32::from(P::CurveUsesTender),
        "claim_redemption",
    );
    // (a curve series that was never prepared reaches the mode check of prepare_raise)
    let issuer = c.issuer.insecure_clone();
    let x = fixture_u64(&curve_fixture(), "migrationQuoteThreshold");
    let usdc = c.env.usdc;
    let other = c
        .env
        .create_series(&issuer, &usdc, curve_series_args([4u8; 32], x));
    expect_code(
        c.env.send(
            &[c.env.prepare_raise_ix(&issuer.pubkey(), &other)],
            &[&issuer],
        ),
        u32::from(P::NotSealedBid),
        "prepare_raise",
    );
    ok(c.env.set_flags(false, true, false), "windows on");
    let period = c.env.ledger(&series).unwrap().first_period;
    expect_code(
        c.env.open_window(&series, period),
        u32::from(P::NotSealedBid),
        "open_window",
    );
}

/// Extinguishment of a curve series: the unvested treasury is distributed over the units
/// outstanding and only staked units can claim their share (by stake, settled on unstake too).
#[test]
fn curve_extinguishment_pays_stakers() {
    let mut c = launched();
    let series = c.series;
    let damm = c.damm;
    let a = c.a.insecure_clone();
    let b = c.b.insecure_clone();
    ok(c.env.register_holder(&series, &a.pubkey()), "register a");
    ok(c.env.register_holder(&series, &b.pubkey()), "register b");
    ok(c.env.sync_curve_units(&series, &damm), "sync");
    let n = c.env.ledger(&series).unwrap().units_outstanding;
    let (sa, sb) = (c.base(&a.pubkey()), 7 * CURVE_UNIT_SCALE);
    ok(c.env.stake_units(&a, &series, sa), "a stakes");
    ok(c.env.stake_units(&b, &series, sb), "b stakes");
    let k1 = EthSigner::from_seed(51);
    let k2 = EthSigner::from_seed(52);
    ok(c.env.register_attestor(k1.addr), "attestor 1");
    ok(c.env.register_attestor(k2.addr), "attestor 2");
    let domain = c.env.config().domain;
    let msg = keccak(&[extinguish_message(&domain, &series.to_bytes(), 0).as_bytes()]);
    let proceeds = c.env.treasury(&series).unwrap().proceeds;
    ok(
        c.env
            .extinguish(&series, (k1.addr, k1.sign(&msg)), (k2.addr, k2.sign(&msg))),
        "extinguish",
    );
    // nothing released yet: half vested at settlement stays with the estate, half is distributed
    let unreleased = proceeds - proceeds / 2;
    let l = c.env.ledger(&series).unwrap();
    assert_eq!(l.final_units, n);
    assert_eq!(
        l.final_acc_wad * u128::from(n) + u128::from(l.final_carry_wad),
        u128::from(unreleased) * u128::from(WAD)
    );
    let usdc = c.env.usdc;
    let a0 = c.env.balance_of(&a.pubkey(), &usdc);
    ok(c.env.claim_final(&series, &a.pubkey()), "claim_final a");
    assert_eq!(
        c.env.balance_of(&a.pubkey(), &usdc) - a0,
        holder_delta(l.final_acc_wad, 0, sa).unwrap()
    );
    // b unstakes first: the settlement credits its final share, then claim_final pays it
    ok(c.env.unstake_units(&b, &series, sb), "b unstakes");
    let b0 = c.env.balance_of(&b.pubkey(), &usdc);
    ok(c.env.claim_final(&series, &b.pubkey()), "claim_final b");
    assert_eq!(
        c.env.balance_of(&b.pubkey(), &usdc) - b0,
        holder_delta(l.final_acc_wad, 0, sb).unwrap()
    );
    // a second claim pays nothing more
    let b1 = c.env.balance_of(&b.pubkey(), &usdc);
    ok(
        c.env.claim_final(&series, &b.pubkey()),
        "claim_final b again",
    );
    assert_eq!(c.env.balance_of(&b.pubkey(), &usdc), b1);
}

/// At the cap the series retires: the capping receipt is truncated (refund to the issuer), staked
/// holders keep claiming what they earned, nothing is burned, staking and re-counting stop.
#[test]
fn curve_retirement_ends_claims_without_burns() {
    let mut c = launched();
    let series = c.series;
    let damm = c.damm;
    let base_mint = c.dbc.base_mint;
    let a = c.a.insecure_clone();
    ok(c.env.register_holder(&series, &a.pubkey()), "register a");
    ok(c.env.sync_curve_units(&series, &damm), "sync");
    let sa = c.base(&a.pubkey());
    ok(c.env.stake_units(&a, &series, sa), "a stakes");
    let period = c.env.ledger(&series).unwrap().first_period;
    c.env.warp(period_end(period).unwrap() + 3_600);
    ok(c.env.sync_curve_units(&series, &damm), "sync after period");
    ok(c.report_with(period, 1), "report past the cap");
    let issuer = c.issuer.insecure_clone();
    let usdc = c.env.usdc;
    let due = c.env.ledger(&series).unwrap().open_due_amount;
    assert_eq!(due, 13_999_999_720);
    c.env.fund(&issuer.pubkey(), &usdc, due);
    let issuer0 = c.env.balance_of(&issuer.pubkey(), &usdc);
    ok(c.env.pay(&issuer, &series), "pay");
    let l = c.env.ledger(&series).unwrap();
    assert_eq!(
        l.stored_status(),
        merces_common::status::SeriesStatus::Retired
    );
    // the cap per base lamport is exactly 25 USDC per unit / 10^6
    let cap_wad = merces_common::vault::scaled_cap_wad(25 * ONE_USDC, CURVE_UNIT_SCALE).unwrap();
    assert!(l.paid_per_unit_wad <= cap_wad);
    let n = l.units_outstanding;
    let accepted = (u128::from(n) * cap_wad / u128::from(WAD)) as u64;
    assert!(issuer0 - c.env.balance_of(&issuer.pubkey(), &usdc) <= accepted + 1);
    assert!(
        l.refunded_to_issuer > 0,
        "the capping receipt refunds the excess"
    );
    // claims end with what was earned; nothing burns
    let supply = c.env.mint_supply(&base_mint);
    let stake = c.env.token_balance(&stake_vault(&series, &base_mint));
    let a0 = c.env.balance_of(&a.pubkey(), &usdc);
    ok(c.env.claim(&series, &a.pubkey()), "claim after retirement");
    assert_eq!(
        c.env.balance_of(&a.pubkey(), &usdc) - a0,
        holder_delta(l.net_acc_wad, 0, sa).unwrap()
    );
    assert_eq!(c.env.mint_supply(&base_mint), supply);
    assert_eq!(
        c.env.token_balance(&stake_vault(&series, &base_mint)),
        stake
    );
    expect_code(
        c.env.burn_retired(&series, &a.pubkey()),
        u32::from(P::CurveModeNoBurn),
        "no forced burn",
    );
    expect_code(
        c.env.stake_units(&a, &series, 1),
        u32::from(P::TerminalStatus),
        "stake after retirement",
    );
    expect_code(
        c.env.sync_curve_units(&series, &damm),
        u32::from(P::TerminalStatus),
        "sync after retirement",
    );
    // units can always come back to the wallet
    ok(
        c.env.unstake_units(&a, &series, sa),
        "unstake after retirement",
    );
    assert_eq!(c.base(&a.pubkey()), sa);
    let a1 = c.env.balance_of(&a.pubkey(), &usdc);
    ok(c.env.claim(&series, &a.pubkey()), "nothing more to claim");
    assert_eq!(c.env.balance_of(&a.pubkey(), &usdc), a1);
}

/// A pool whose creator is the series curve_authority PDA (CURVE_MODE §6, the other arrangement):
/// both migration-fee shares are withdrawn by the PDA, so the whole fee still reaches the
/// treasury.
#[test]
fn curve_pda_creator_collects_both_migration_fee_shares() {
    let mut env = Env::new();
    env.load_dbc();
    let issuer = env.new_wallet();
    let series = new_curve_series(&mut env, &issuer);
    let usdc = env.usdc;
    let ca = curve_authority(&series);
    let (res, config) = env.dbc_create_config_pda_creator(&ca, &usdc);
    ok(res, "create_config");
    let (res, dbc) = env.dbc_create_pool(&config, &issuer, &usdc);
    ok(res, "create_pool");
    // the issuer hands the creator role to the PDA (DBC transfer_pool_creator; mocked here)
    env.patch(&dbc.pool, layout::POOL_CREATOR, ca.as_ref());
    ok(
        env.activate_curve(&issuer, &series, &dbc),
        "activate with a PDA creator",
    );
    assert_eq!(env.series(&series).dbc_creator, ca);
    for amount in [600u64, 500] {
        let w = env.new_wallet();
        env.fund(&w.pubkey(), &usdc, 2_000 * ONE_USDC);
        ok(env.dbc_buy(&dbc, &w, amount * ONE_USDC), "buy");
    }
    ok(env.complete_curve(&series), "complete");
    ok(env.collect_curve_proceeds(&series), "collect");
    let f = &curve_fixture()["pdaCreator"]["expected"];
    let share = |k: &str| -> u64 { f[k].as_str().unwrap().parse().unwrap() };
    let t = env.treasury(&series).unwrap();
    assert_eq!(
        t.proceeds,
        share("partnerMigrationFee") + share("creatorMigrationFee")
    );
    assert_eq!(t.proceeds, 990 * ONE_USDC);
    let status = env.raw(&dbc.pool)[layout::POOL_MIGRATION_FEE_WITHDRAW_STATUS];
    assert_eq!(status & 0b110, 0b110, "both shares withdrawn");
}
