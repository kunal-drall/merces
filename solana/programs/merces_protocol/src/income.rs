//! ProofOfIncome verifier, payments, true-ups, status crank and hardship pauses
//! (SPEC v1.1 §6.2, §6.4).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use merces_common::encoding::{
    fx_message, pause_message, report_message, trueup_message, u64_to_be32,
};
use merces_common::fx::{quarter_average, Checkpoint};
use merces_common::params::{GRACE_DAYS, MAX_PAUSES, REPORT_DUE_DAYS, TAIL_SECONDS};
use merces_common::status::{
    countdown, late_accrual, late_days_from_countdown, trueup_late_days, SeriesStatus, DEADLINE_S,
    TRUEUP_S,
};
use merces_common::time::{period_end, period_of, period_start, quarter_index, year_of, DAY};
use merces_common::vault::is_capped;
use merces_common::WAD_U64;
use merces_onchain::seeds::{ATTESTOR, CONFIG, VERIFIER};
use merces_onchain::{keccak, poseidon2, recover_eth_address, u64_field, SigError};
use merces_registry::program::MercesRegistry;
use merces_registry::state::{
    AttestorKey, ProtocolConfig, Series, VerifierKey, RAISE_SETTLED, TIER_FLAG_SPLIT,
};

use crate::common::*;
use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::state::*;
use crate::zk::{verify_report_proof, NR_PUBLIC_INPUTS};

/// `Poseidon(2)(0, 0)`: the prior commitment at the start of every reporting year (SPEC §1.5).
pub const ZERO_INCOME_COMMITMENT: [u8; 32] = [
    0x20, 0x98, 0xf5, 0xfb, 0x9e, 0x23, 0x9e, 0xab, 0x3c, 0xea, 0xc3, 0xf2, 0x7b, 0x81, 0xe4, 0x81,
    0xdc, 0x31, 0x24, 0xd5, 0x5f, 0xfe, 0xd5, 0x23, 0xa8, 0x39, 0xee, 0x84, 0x46, 0xb6, 0x48, 0x64,
];

/// Revocation grace for report attestations: `(report_due_days + grace_days) × DAY` (SPEC §1.4).
pub const KEY_GRACE_S: u64 = (REPORT_DUE_DAYS + GRACE_DAYS) * DAY;

pub fn map_sig_error(e: SigError) -> Error {
    match e {
        SigError::Malformed => error!(ProtocolError::MalformedSignature),
        SigError::RecoveryFailed => error!(ProtocolError::SignatureRecoveryFailed),
    }
}

/// Which registry key set a signature must come from.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    Attestor,
    Verifier,
}

/// A key is usable when `active`, or — for a report attestation of `period` — when it was revoked
/// at `revoked_at ≥ period_end(period)` and `now ≤ revoked_at + KEY_GRACE_S` (forward-only
/// revocation, SPEC §1.4).
fn key_usable(active: bool, revoked_at: u64, grace: Option<(u32, u64)>) -> Result<bool> {
    if active {
        return Ok(true);
    }
    match grace {
        Some((period, now)) if revoked_at > 0 => {
            let end = period_end(period).map_err(math)?;
            let limit = revoked_at
                .checked_add(KEY_GRACE_S)
                .ok_or(ProtocolError::MathOverflow)?;
            Ok(end <= revoked_at && now <= limit)
        }
        _ => Ok(false),
    }
}

/// Checks that `acc` is the registry key PDA for `addr` of the given kind and that the key is
/// usable (active, or inside its revocation grace for a report of `grace.0`).
pub fn require_key(
    acc: &AccountInfo,
    addr: &[u8; 20],
    kind: KeyKind,
    grace: Option<(u32, u64)>,
) -> Result<()> {
    let seed = match kind {
        KeyKind::Attestor => ATTESTOR,
        KeyKind::Verifier => VERIFIER,
    };
    let (expected, _) = Pubkey::find_program_address(&[seed, addr.as_ref()], &merces_registry::ID);
    require_keys_eq!(*acc.key, expected, ProtocolError::KeyAccountMismatch);
    require_keys_eq!(
        *acc.owner,
        merces_registry::ID,
        ProtocolError::KeyAccountMismatch
    );
    let data = acc.try_borrow_data()?;
    let (key_addr, active, revoked_at) = match kind {
        KeyKind::Attestor => {
            let k = AttestorKey::try_deserialize(&mut &data[..])?;
            (k.addr, k.active, k.revoked_at)
        }
        KeyKind::Verifier => {
            let k = VerifierKey::try_deserialize(&mut &data[..])?;
            (k.addr, k.active, k.revoked_at)
        }
    };
    require!(key_addr == *addr, ProtocolError::KeyAccountMismatch);
    let usable = key_usable(active, revoked_at, grace)?;
    match kind {
        KeyKind::Attestor => require!(usable, ProtocolError::AttestorInactive),
        KeyKind::Verifier => require!(usable, ProtocolError::VerifierKeyInactive),
    }
    Ok(())
}

/// Active-attestor check (no grace).
pub fn require_active_attestor(acc: &AccountInfo, addr: &[u8; 20]) -> Result<()> {
    require_key(acc, addr, KeyKind::Attestor, None)
}

/// Recovers the signer of `msg` and requires it to be `addr`.
pub fn require_signer(msg: &[u8; 32], sig: &[u8; 65], addr: &[u8; 20]) -> Result<()> {
    let recovered = recover_eth_address(msg, sig).map_err(map_sig_error)?;
    require!(recovered == *addr, ProtocolError::SignerMismatch);
    Ok(())
}

/// `deadline(p) = period_end(p) + report_due_days × DAY` — the year-ring anchor for payments.
pub fn deadline_of(period: u32) -> Result<u64> {
    period_end(period)
        .map_err(math)?
        .checked_add(DEADLINE_S)
        .ok_or(ProtocolError::MathOverflow.into())
}

// -------------------------------------------------------------------------------- submit_report

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SubmitReportArgs {
    pub period: u32,
    pub payment_usd: u64,
    pub fx_avg_wad: u64,
    /// Attestor signature over `MERCES_FX_V1` when the pair needs a fallback rate.
    pub fx_fallback_sig: Option<[u8; 65]>,
    pub fx_attestor_addr: [u8; 20],
    pub prior_income_commitment: [u8; 32],
    pub income_commitment: [u8; 32],
    pub tier: u8,
    pub liquidity_event: bool,
    /// 256 bytes: A (64) ‖ B (128) ‖ C (64), see `zk`.
    pub proof: Vec<u8>,
    /// Tier 2: report-verifier key; tier 3: attestor. None for tiers 1 and 4.
    pub attestation_sig: Option<[u8; 65]>,
    pub attestation_addr: [u8; 20],
}

#[derive(Accounts)]
#[instruction(args: SubmitReportArgs)]
pub struct SubmitReport<'info> {
    #[account(mut)]
    pub issuer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    /// `init_if_needed` so a repeated period reverts `WrongPeriod` (the sequential-period rule
    /// guarantees the account of the next expected period is fresh).
    #[account(init_if_needed, payer = issuer, space = 8 + Report::INIT_SPACE, seeds = [seeds::REPORT, series.key().as_ref(), args.period.to_le_bytes().as_ref()], bump)]
    pub report: Box<Account<'info, Report>>,
    /// CHECK: registry key PDA for `attestation_addr` (verifier key for tier 2, attestor for tier 3);
    /// validated in the handler. Any account for tiers 1 and 4.
    pub attestation_key: UncheckedAccount<'info>,
    /// CHECK: registry `AttestorKey` PDA for `fx_attestor_addr`; validated when a fallback is used.
    pub fx_attestor_key: UncheckedAccount<'info>,
    /// CHECK: the rate accumulator PDA of the series' pair (address checked by the seeds; read
    /// when it exists — a pair never snapshotted reads as `NeedsFallback`). Ignored for stablecoin
    /// income.
    #[account(seeds = [seeds::FX_PAIR, series.fx_pair_id.as_ref()], bump)]
    pub fx_pair: UncheckedAccount<'info>,
    /// CHECK: the accumulator checkpoint PDA at `period` (missing ⇒ `NeedsFallback`).
    #[account(seeds = [seeds::FX_CHECKPOINT, series.fx_pair_id.as_ref(), args.period.to_le_bytes().as_ref()], bump)]
    pub fx_start: UncheckedAccount<'info>,
    /// CHECK: the accumulator checkpoint PDA at `period + 1`. Always passed, so the live totals
    /// stand in only when no snapshot of `period + 1` exists (SPEC §6.6).
    #[account(seeds = [seeds::FX_CHECKPOINT, series.fx_pair_id.as_ref(), args.period.saturating_add(1).to_le_bytes().as_ref()], bump)]
    pub fx_end: UncheckedAccount<'info>,
    /// Tier 1 router (required for tier 1 reports).
    #[account(seeds = [seeds::ROUTER, series.key().as_ref()], bump = router.bump)]
    pub router: Option<Box<Account<'info, Router>>>,
    pub system_program: Program<'info, System>,
}

/// Reads an account of this program when it exists (address checked by the caller's seeds).
fn read_existing<T: AccountDeserialize>(info: &AccountInfo) -> Result<Option<T>> {
    if *info.owner != crate::ID || info.data_is_empty() {
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    Ok(Some(T::try_deserialize(&mut &data[..])?))
}

pub fn submit_report(ctx: Context<SubmitReport>, args: SubmitReportArgs) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    let config = &ctx.accounts.config;
    require!(
        series.raise_state == RAISE_SETTLED,
        ProtocolError::RaiseNotSettled
    );
    // preconditions read the derived status; the stored status is synced in the effects phase
    let status = ledger.derived_status(now)?;

    // 2. preconditions
    require!(ledger.is_mint_finalized(), ProtocolError::MintNotFinalized);
    require!(
        !matches!(status, SeriesStatus::Retired | SeriesStatus::Extinguished),
        ProtocolError::TerminalStatus
    );
    require!(
        args.period == ledger.next_expected_period()?,
        ProtocolError::WrongPeriod
    );
    require!(
        now >= period_end(args.period).map_err(math)?,
        ProtocolError::PeriodNotEnded
    );
    require!(ledger.open_due_amount == 0, ProtocolError::DueOutstanding);
    let is_tail = status == SeriesStatus::Redeemed;
    if is_tail {
        let tail_end = ledger
            .redemption_ts
            .checked_add(TAIL_SECONDS)
            .ok_or(ProtocolError::MathOverflow)?;
        require!(
            period_start(args.period).map_err(math)? <= tail_end,
            ProtocolError::TailEnded
        );
        if args.liquidity_event {
            require!(
                ledger.tail_cap_per_unit > 0 && !ledger.is_tail_exhausted(),
                ProtocolError::NoTailDue
            );
        }
    }

    // 3. tier
    require!((1..=4).contains(&args.tier), ProtocolError::TierNotEnabled);
    let tier_bit = 1u8 << (args.tier - 1);
    require!(
        series.tier_flags & tier_bit != 0,
        ProtocolError::TierNotEnabled
    );
    if args.tier == TIER_SPLIT {
        require!(
            series.tier_flags == TIER_FLAG_SPLIT,
            ProtocolError::Tier1NotExclusive
        );
    }
    if args.tier == TIER_SELF {
        require!(config.tier4_enabled, ProtocolError::Tier4Disabled);
    }

    // 4. FX
    let fx_fallback = if series.fx_pair_id == [0u8; 32] {
        require!(args.fx_avg_wad == WAD_U64, ProtocolError::FxMustBeOne);
        require!(
            args.fx_fallback_sig.is_none(),
            ProtocolError::FxFallbackNotNeeded
        );
        false
    } else {
        let pair = read_existing::<FxPair>(&ctx.accounts.fx_pair.to_account_info())?;
        let start_cp = read_existing::<FxCheckpoint>(&ctx.accounts.fx_start.to_account_info())?;
        let end_cp = read_existing::<FxCheckpoint>(&ctx.accounts.fx_end.to_account_info())?;
        let (ok, avg) = match (pair, start_cp) {
            (Some(pair), Some(start_cp)) => {
                require!(
                    pair.pair_id == series.fx_pair_id && start_cp.pair_id == series.fx_pair_id,
                    ProtocolError::FxCheckpointMismatch
                );
                let start = Checkpoint {
                    sum_wad: start_cp.sum_wad,
                    count: start_cp.count,
                    flagged: start_cp.flagged,
                };
                let next_start = period_start(
                    args.period
                        .checked_add(1)
                        .ok_or(ProtocolError::MathOverflow)?,
                )
                .map_err(math)?;
                let live_is_end = now >= period_end(args.period).map_err(math)?
                    && u64::from(pair.last_day)
                        .checked_mul(DAY)
                        .ok_or(ProtocolError::MathOverflow)?
                        < next_start;
                let end = match end_cp {
                    Some(e) => {
                        require!(
                            e.pair_id == series.fx_pair_id,
                            ProtocolError::FxCheckpointMismatch
                        );
                        Some(Checkpoint {
                            sum_wad: e.sum_wad,
                            count: e.count,
                            flagged: e.flagged,
                        })
                    }
                    // no snapshot of `period + 1` yet: the live totals are the end-of-period totals
                    None if live_is_end => Some(Checkpoint {
                        sum_wad: pair.sum_wad,
                        count: pair.count,
                        flagged: false,
                    }),
                    None => None,
                };
                match end {
                    Some(end) => {
                        quarter_average(args.period, &start, &end, series.fx_min_coverage_bps)
                            .map_err(math)?
                    }
                    None => (false, 0),
                }
            }
            // no accumulator or no snapshot inside the period: NeedsFallback
            _ => (false, 0),
        };
        if ok {
            require!(args.fx_avg_wad == avg, ProtocolError::FxAverageMismatch);
            require!(
                args.fx_fallback_sig.is_none(),
                ProtocolError::FxFallbackNotNeeded
            );
            false
        } else {
            let sig = args.fx_fallback_sig.ok_or(ProtocolError::FxNeedsFallback)?;
            let msg = keccak(&[fx_message(
                &config.domain,
                &series_key.to_bytes(),
                args.period,
                args.fx_avg_wad,
            )
            .as_bytes()]);
            require_signer(&msg, &sig, &args.fx_attestor_addr)?;
            require_key(
                &ctx.accounts.fx_attestor_key.to_account_info(),
                &args.fx_attestor_addr,
                KeyKind::Attestor,
                Some((args.period, now)),
            )?;
            true
        }
    };

    // 5. prior commitment
    let chained = matches!(ledger.last_income_period(), Some(last) if last.checked_add(1) == Some(args.period) && year_of(last) == year_of(args.period));
    let first_report_mid_year =
        ledger.last_accepted_period().is_none() && quarter_index(args.period) != 0;
    if chained {
        require!(
            args.prior_income_commitment == ledger.last_income_commitment,
            ProtocolError::PriorCommitmentMismatch
        );
    } else if !first_report_mid_year {
        require!(
            args.prior_income_commitment == ZERO_INCOME_COMMITMENT,
            ProtocolError::PriorCommitmentMismatch
        );
    }

    // 6. proof
    let units_outstanding = if is_tail {
        ledger.units_at_redemption
    } else {
        ledger.units_outstanding
    };
    require!(units_outstanding > 0, ProtocolError::NoUnitsOutstanding);
    require!(args.proof.len() == 256, ProtocolError::MalformedProof);
    let mut proof = [0u8; 256];
    proof.copy_from_slice(&args.proof);
    let public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] = [
        series.terms_commitment,
        u64_to_be32(units_outstanding),
        u64_to_be32(args.fx_avg_wad),
        args.prior_income_commitment,
        args.income_commitment,
        u64_to_be32(args.payment_usd),
    ];
    verify_report_proof(&proof, &public_inputs)?;

    // 7. source binding
    match args.tier {
        TIER_ZKTLS | TIER_ATTESTOR => {
            let sig = args
                .attestation_sig
                .ok_or(ProtocolError::AttestationRequired)?;
            let msg = keccak(&[report_message(
                &config.domain,
                &series_key.to_bytes(),
                args.period,
                &args.prior_income_commitment,
                &args.income_commitment,
                args.tier,
                args.liquidity_event,
            )
            .as_bytes()]);
            require_signer(&msg, &sig, &args.attestation_addr)?;
            let kind = if args.tier == TIER_ZKTLS {
                KeyKind::Verifier
            } else {
                KeyKind::Attestor
            };
            require_key(
                &ctx.accounts.attestation_key.to_account_info(),
                &args.attestation_addr,
                kind,
                Some((args.period, now)),
            )?;
        }
        TIER_SPLIT => {
            let router = ctx
                .accounts
                .router
                .as_ref()
                .ok_or(ProtocolError::RouterRequired)?;
            let zero = [0u8; 32];
            let ytd = router
                .checkpoint(args.period)
                .ok_or(ProtocolError::RouterPeriodNotClosed)?;
            let expected = poseidon2(&u64_field(ytd), &zero)?;
            require!(
                args.income_commitment == expected,
                ProtocolError::RouterCommitmentMismatch
            );
            if quarter_index(args.period) != 0 {
                let prev = args
                    .period
                    .checked_sub(1)
                    .ok_or(ProtocolError::MathOverflow)?;
                let ytd_prev = router
                    .checkpoint(prev)
                    .ok_or(ProtocolError::RouterPeriodNotClosed)?;
                let expected_prior = poseidon2(&u64_field(ytd_prev), &zero)?;
                require!(
                    args.prior_income_commitment == expected_prior,
                    ProtocolError::RouterCommitmentMismatch
                );
            }
        }
        _ => {}
    }

    // 8. effects
    let due = if is_tail && !args.liquidity_event {
        0
    } else {
        let credit_used = core::cmp::min(ledger.router_credit, args.payment_usd);
        ledger.router_credit = ledger
            .router_credit
            .checked_sub(credit_used)
            .ok_or(ProtocolError::MathOverflow)?;
        args.payment_usd
            .checked_sub(credit_used)
            .ok_or(ProtocolError::MathOverflow)?
    };
    ledger.set_last_accepted_period(Some(args.period));
    ledger.last_income_commitment = args.income_commitment;
    ledger.set_last_income_period(Some(args.period));
    ledger.year_pay_add(year_of(args.period), args.payment_usd)?;
    let r = &mut ctx.accounts.report;
    r.series = series_key;
    r.period = args.period;
    r.accepted_at = now;
    r.payment_usd = args.payment_usd;
    r.fx_avg_wad = args.fx_avg_wad;
    r.fx_fallback = fx_fallback;
    r.tier = args.tier;
    r.liquidity_event = args.liquidity_event;
    r.income_commitment = args.income_commitment;
    r.prior_income_commitment = args.prior_income_commitment;
    r.due = due;
    r.bump = ctx.bumps.report;
    if due == 0 {
        ledger.set_last_paid_period(Some(args.period));
        r.paid_at = now;
    } else {
        ledger.set_open_due_period(Some(args.period));
        ledger.open_due_amount = due;
        ledger.open_due_tier = args.tier;
    }
    ledger.sync_status(now, series_key)?;
    emit!(ReportAccepted {
        series: series_key,
        period: args.period,
        payment_usd: args.payment_usd,
        fx_avg_wad: args.fx_avg_wad,
        fx_fallback,
        tier: args.tier,
        liquidity_event: args.liquidity_event,
        income_commitment: args.income_commitment,
        due,
    });
    if due == 0 {
        emit!(PaymentSettled {
            series: series_key,
            period: args.period,
            gross: 0,
            accrual: 0,
            fee: 0,
            accepted: 0,
            refunded: 0,
        });
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------ pay

/// Accounts shared by every path that pulls stablecoin from a payer into the vault and settles a
/// receipt (fee to the collector, truncation refund to the issuer, retirement side effects).
#[derive(Accounts)]
pub struct Pay<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    /// The report of the open due period (`pay`); unused by `pay_trueup`.
    #[account(mut, seeds = [seeds::REPORT, series.key().as_ref(), report.period.to_le_bytes().as_ref()], bump = report.bump)]
    pub report: Option<Box<Account<'info, Report>>>,
    /// The payer's stablecoin account; `dup` because the issuer usually pays from the same account
    /// that receives truncation refunds (`issuer_stable_ata`).
    #[account(mut, dup, token::mint = stablecoin_mint, token::authority = payer, token::token_program = stablecoin_program)]
    pub payer_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::VAULT_TOKEN, series.key().as_ref()], bump)]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less signer PDA, vault owner and permanent delegate.
    #[account(seeds = [seeds::VAULT_AUTH, series.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    /// CHECK: the series issuer (refund destination owner).
    #[account(address = series.issuer @ ProtocolError::NotIssuer)]
    pub issuer: UncheckedAccount<'info>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = issuer, token::token_program = stablecoin_program)]
    pub issuer_stable_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = config.fee_collector, token::token_program = stablecoin_program)]
    pub fee_collector_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_AUTHORITY], bump)]
    pub registry_authority: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
    pub system_program: Program<'info, System>,
}

/// Pulls `total` into the vault, runs the ledger receipt and moves fee / refund. Handles the
/// Retired transition (registry + event + clearing dues) for main-cap receipts.
fn settle_receipt<'info>(
    ctx: &Context<'info, Pay<'info>>,
    ledger: &mut Ledger,
    total: u64,
    anchor_ts: u64,
    is_tail: bool,
) -> Result<merces_common::vault::ReceiveOutcome> {
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    let decimals = series.stablecoin_decimals;
    let fee_bps = series.payout_fee_bps;
    let token_program = ctx.accounts.stablecoin_program.to_account_info();
    let mint = ctx.accounts.stablecoin_mint.to_account_info();
    let vault = ctx.accounts.vault_token.to_account_info();
    require_ata(
        &ctx.accounts.issuer_stable_ata.to_account_info(),
        &series.issuer,
        mint.key,
        token_program.key,
    )?;
    require_ata(
        &ctx.accounts.fee_collector_ata.to_account_info(),
        &ctx.accounts.config.fee_collector,
        mint.key,
        token_program.key,
    )?;
    // pull
    transfer_stable(
        &token_program,
        &ctx.accounts.payer_stable.to_account_info(),
        &mint,
        &vault,
        &ctx.accounts.payer.to_account_info(),
        ctx.remaining_accounts,
        total,
        decimals,
        &[],
    )?;
    let out = if is_tail {
        ledger.receive_tail(total, fee_bps, series_key)?
    } else {
        let cap = cap_per_unit_of(series)?;
        ledger.receive_gross(SOURCE_PAYMENT, total, cap, anchor_ts, fee_bps, series_key)?
    };
    // fee and refund out of the vault
    let bump = [ctx.bumps.vault_auth];
    let vault_seeds: &[&[u8]] = &[seeds::VAULT_AUTH, series_key.as_ref(), &bump];
    let auth = ctx.accounts.vault_auth.to_account_info();
    transfer_stable(
        &token_program,
        &vault,
        &mint,
        &ctx.accounts.fee_collector_ata.to_account_info(),
        &auth,
        ctx.remaining_accounts,
        out.fee,
        decimals,
        &[vault_seeds],
    )?;
    transfer_stable(
        &token_program,
        &vault,
        &mint,
        &ctx.accounts.issuer_stable_ata.to_account_info(),
        &auth,
        ctx.remaining_accounts,
        out.refund,
        decimals,
        &[vault_seeds],
    )?;
    if out.capped && !is_tail {
        let registry = RegistryCpi {
            registry_program: ctx.accounts.registry_program.to_account_info(),
            config: ctx.accounts.config.to_account_info(),
            series: ctx.accounts.series.to_account_info(),
            registry_authority: ctx.accounts.registry_authority.to_account_info(),
            authority_bump: ctx.bumps.registry_authority,
        };
        retire(ledger, &registry, series_key, out.refund)?;
    }
    Ok(out)
}

/// `pay` (SPEC §6.2): pulls the open due plus late accrual from the payer into the vault.
pub fn pay<'info>(ctx: Context<'info, Pay<'info>>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let status = ledger.derived_status(now)?;
    require!(ledger.is_mint_finalized(), ProtocolError::MintNotFinalized);
    require!(
        !matches!(status, SeriesStatus::Retired | SeriesStatus::Extinguished),
        ProtocolError::TerminalStatus
    );
    require!(ledger.open_due_amount > 0, ProtocolError::NothingDue);
    let period = ledger.open_due_period().ok_or(ProtocolError::NothingDue)?;
    let report = ctx
        .accounts
        .report
        .as_ref()
        .ok_or(ProtocolError::NothingDue)?;
    require!(report.period == period, ProtocolError::WrongPeriod);
    let amount = ledger.open_due_amount;
    let is_tail = status == SeriesStatus::Redeemed;
    let accrual = if is_tail {
        0
    } else {
        let pauses = ledger.pauses();
        let c = countdown(pauses.as_slice(), period, now).map_err(math)?;
        late_accrual(
            amount,
            ctx.accounts.series.hurdle_rate_wad,
            late_days_from_countdown(c),
        )
        .map_err(math)?
    };
    let total = amount
        .checked_add(accrual)
        .ok_or(ProtocolError::MathOverflow)?;
    let anchor = deadline_of(period)?;

    let out = settle_receipt(&ctx, &mut ledger, total, anchor, is_tail)?;

    if ledger.stored_status() != SeriesStatus::Retired {
        ledger.open_due_amount = 0;
        ledger.set_open_due_period(None);
        ledger.open_due_tier = 0;
    }
    ledger.set_last_paid_period(Some(period));
    if let Some(r) = ctx.accounts.report.as_mut() {
        r.accrual_paid = accrual;
        r.paid_at = now;
    }
    ledger.sync_status(now, series_key)?;
    emit!(PaymentSettled {
        series: series_key,
        period,
        gross: total,
        accrual,
        fee: out.fee,
        accepted: out.accepted,
        refunded: out.refund,
    });
    if is_tail {
        emit!(TailDistributed {
            series: series_key,
            period,
            gross: total,
            accepted: out.accepted,
            fee: out.fee,
            refunded: out.refund,
        });
    }
    Ok(())
}

/// `pay_trueup` (SPEC §6.2): pulls the true-up due plus accrual past the true-up deadline.
pub fn pay_trueup<'info>(ctx: Context<'info, Pay<'info>>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let status = ledger.derived_status(now)?;
    require!(ledger.is_mint_finalized(), ProtocolError::MintNotFinalized);
    require!(!status.is_terminal(), ProtocolError::TerminalStatus);
    require!(ledger.trueup_due > 0, ProtocolError::NoTrueUpDue);
    let amount = ledger.trueup_due;
    let pauses = ledger.pauses();
    let late_days = trueup_late_days(pauses.as_slice(), ledger.trueup_attested_at, now);
    let accrual =
        late_accrual(amount, ctx.accounts.series.hurdle_rate_wad, late_days).map_err(math)?;
    let total = amount
        .checked_add(accrual)
        .ok_or(ProtocolError::MathOverflow)?;
    let anchor = deadline_of(period_of(ledger.trueup_attested_at).map_err(math)?)?;
    settle_receipt(&ctx, &mut ledger, total, anchor, false)?;
    ledger.clear_trueup();
    ledger.sync_status(now, series_key)?;
    emit!(TrueUpPaid {
        series: series_key,
        amount,
        accrual,
    });
    Ok(())
}

// ------------------------------------------------------------------------------- submit_trueup

#[derive(Accounts)]
pub struct SubmitTrueUp<'info> {
    pub issuer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    /// CHECK: registry `AttestorKey` PDA for `attestor_addr`; validated in the handler.
    pub attestor_key: UncheckedAccount<'info>,
}

/// Tier 3 true-up (SPEC §6.2): one per year, after the year ended and every period of it was
/// reported; positive → due with a 60-day unpaused deadline, negative → credit carried forward.
pub fn submit_trueup(
    ctx: Context<SubmitTrueUp>,
    year: u16,
    adjustment: i64,
    attestation_ts: u64,
    attestor_addr: [u8; 20],
    attestor_sig: [u8; 65],
) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    let status = ledger.derived_status(now)?;
    // check order: mint finalised, tier 3, attestor, nonce (signature), then the year rules
    require!(ledger.is_mint_finalized(), ProtocolError::MintNotFinalized);
    require!(!status.is_terminal(), ProtocolError::TerminalStatus);
    require!(
        series.tier_flags & (1 << (TIER_ATTESTOR - 1)) != 0,
        ProtocolError::TierNotEnabled
    );
    require_active_attestor(&ctx.accounts.attestor_key.to_account_info(), &attestor_addr)?;
    // the message carries the stored nonce: a replayed or wrong-nonce signature does not recover
    let msg = keccak(&[trueup_message(
        &ctx.accounts.config.domain,
        &series_key.to_bytes(),
        ledger.trueup_nonce,
        year,
        adjustment,
        attestation_ts,
    )
    .as_bytes()]);
    require_signer(&msg, &attestor_sig, &attestor_addr)?;
    require!(
        attestation_ts <= now,
        ProtocolError::TrueUpTimestampInFuture
    );
    require!(ledger.trueup_due == 0, ProtocolError::TrueUpOutstanding);
    let year32 = u32::from(year);
    require!(
        ledger.last_trueup_year().is_none_or(|y| y < year32),
        ProtocolError::TrueUpYearUsed
    );
    require!(
        year32 < year_of(period_of(now).map_err(math)?),
        ProtocolError::TrueUpYearNotEnded
    );
    // every period of the year from `first_period` on has an accepted report (vacuous for a year
    // that ended before the series' first period)
    let last_of_year = year32
        .checked_mul(4)
        .and_then(|v| v.checked_add(3))
        .ok_or(ProtocolError::MathOverflow)?;
    require!(
        last_of_year < ledger.first_period
            || matches!(ledger.last_accepted_period(), Some(p) if p >= last_of_year),
        ProtocolError::TrueUpYearIncomplete
    );
    if adjustment < 0 {
        let credit = adjustment.unsigned_abs();
        require!(
            credit <= ledger.year_pay_at(year32),
            ProtocolError::TrueUpExceedsYear
        );
    }
    ledger.trueup_nonce = ledger
        .trueup_nonce
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    ledger.set_last_trueup_year(Some(year32));
    let deadline = match adjustment.cmp(&0) {
        core::cmp::Ordering::Greater => {
            ledger.trueup_due = adjustment.unsigned_abs();
            ledger.trueup_attested_at = attestation_ts;
            ledger.set_trueup_year(Some(year32));
            ledger.trueup_notice_emitted = 0;
            attestation_ts
                .checked_add(TRUEUP_S)
                .ok_or(ProtocolError::MathOverflow)?
        }
        core::cmp::Ordering::Less => {
            // overpayment: credited forward against the next reports
            ledger.router_credit = ledger
                .router_credit
                .checked_add(adjustment.unsigned_abs())
                .ok_or(ProtocolError::MathOverflow)?;
            0
        }
        // an exact estimate: the year is trued up, nothing moves
        core::cmp::Ordering::Equal => 0,
    };
    ledger.sync_status(now, series_key)?;
    emit!(TrueUpRecorded {
        series: series_key,
        year,
        adjustment,
        deadline,
    });
    Ok(())
}

// -------------------------------------------------------------------------------- crank_status

#[derive(Accounts)]
pub struct CrankStatus<'info> {
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
}

pub fn crank_status(ctx: Context<CrankStatus>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let key = ctx.accounts.series.key();
    ledger.sync_status(now, key)?;
    Ok(())
}

// ----------------------------------------------------------------------------- retire_if_capped

#[derive(Accounts)]
pub struct RetireIfCapped<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_AUTHORITY], bump)]
    pub registry_authority: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
}

/// `retire_if_capped` (SPEC §6.3): a lowered cap already met retires the series.
pub fn retire_if_capped(ctx: Context<RetireIfCapped>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    require!(ledger.is_mint_finalized(), ProtocolError::MintNotFinalized);
    require!(
        !ledger.derived_status(now)?.is_terminal(),
        ProtocolError::TerminalStatus
    );
    let cap = cap_per_unit_of(&ctx.accounts.series)?;
    require!(
        is_capped(cap, ledger.paid_per_unit_wad).map_err(math)?,
        ProtocolError::NotCapped
    );
    let registry = RegistryCpi {
        registry_program: ctx.accounts.registry_program.to_account_info(),
        config: ctx.accounts.config.to_account_info(),
        series: ctx.accounts.series.to_account_info(),
        registry_authority: ctx.accounts.registry_authority.to_account_info(),
        authority_bump: ctx.bumps.registry_authority,
    };
    retire(&mut ledger, &registry, series_key, 0)
}

// -------------------------------------------------------------------------------------- pauses

#[derive(Accounts)]
pub struct IssuerLedger<'info> {
    pub issuer: Signer<'info>,
    #[account(constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
}

pub fn request_pause(ctx: Context<IssuerLedger>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let key = ctx.accounts.series.key();
    require!(
        ctx.accounts.series.raise_state == RAISE_SETTLED,
        ProtocolError::RaiseNotSettled
    );
    require!(
        !ledger.derived_status(now)?.is_terminal(),
        ProtocolError::TerminalStatus
    );
    ledger.pause_requested = 1;
    ledger.pause_requested_at = now;
    ledger.pause_nonce = ledger
        .pause_nonce
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    emit!(PauseRequested {
        series: key,
        nonce: ledger.pause_nonce,
    });
    Ok(())
}

pub fn withdraw_pause_request(ctx: Context<IssuerLedger>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let key = ctx.accounts.series.key();
    require!(
        ledger.is_pause_requested(),
        ProtocolError::PauseNotRequested
    );
    let nonce = ledger.pause_nonce;
    ledger.pause_requested = 0;
    ledger.pause_requested_at = 0;
    ledger.pause_nonce = nonce.checked_add(1).ok_or(ProtocolError::MathOverflow)?;
    emit!(PauseRequestWithdrawn { series: key, nonce });
    Ok(())
}

#[derive(Accounts)]
pub struct ApprovePause<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump)]
    pub ledger: AccountLoader<'info, Ledger>,
    /// CHECK: registry `AttestorKey` PDA for `attestor_addr`; validated in the handler.
    pub attestor_key: UncheckedAccount<'info>,
}

/// Anyone may submit the attestor's approval (SPEC §6.4); bounded by the series' pause limits.
pub fn approve_pause(
    ctx: Context<ApprovePause>,
    pause_end: u64,
    attestor_addr: [u8; 20],
    attestor_sig: [u8; 65],
) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    // check order (reference): attestor, request, then the bounds of SPEC §6.4
    require_active_attestor(&ctx.accounts.attestor_key.to_account_info(), &attestor_addr)?;
    let msg = keccak(&[pause_message(
        &ctx.accounts.config.domain,
        &key.to_bytes(),
        ledger.pause_nonce,
        pause_end,
    )
    .as_bytes()]);
    require_signer(&msg, &attestor_sig, &attestor_addr)?;
    require!(
        ledger.is_pause_requested(),
        ProtocolError::PauseNotRequested
    );
    require!(
        !ledger.derived_status(now)?.is_terminal(),
        ProtocolError::TerminalStatus
    );
    require!(pause_end > now, ProtocolError::PauseEndInPast);
    require!(!ledger.is_paused(now), ProtocolError::AlreadyPaused);
    let len = pause_end
        .checked_sub(now)
        .ok_or(ProtocolError::MathOverflow)?;
    require!(len <= series.max_pause_seconds, ProtocolError::PauseTooLong);
    let total = ledger
        .paused_total
        .checked_add(len)
        .ok_or(ProtocolError::MathOverflow)?;
    require!(
        total <= series.max_cumulative_pause_seconds,
        ProtocolError::PauseCumulativeExceeded
    );
    let idx = usize::from(ledger.pause_count);
    require!(idx < MAX_PAUSES, ProtocolError::TooManyPauses);
    ledger.pause_start[idx] = now;
    ledger.pause_end[idx] = pause_end;
    ledger.pause_count = ledger
        .pause_count
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    ledger.paused_total = total;
    ledger.pause_requested = 0;
    ledger.pause_requested_at = 0;
    ledger.sync_status(now, key)?;
    emit!(PauseApproved {
        series: key,
        start: now,
        end: pause_end,
        attestor: attestor_addr,
    });
    Ok(())
}

pub fn end_pause(ctx: Context<IssuerLedger>) -> Result<()> {
    let mut ledger = ctx.accounts.ledger.load_mut()?;
    let now = now_ts()?;
    let key = ctx.accounts.series.key();
    let count = usize::from(ledger.pause_count);
    let open = (0..count).find(|&i| ledger.pause_start[i] <= now && now < ledger.pause_end[i]);
    let i = open.ok_or(ProtocolError::NotPaused)?;
    let cut = ledger.pause_end[i]
        .checked_sub(now)
        .ok_or(ProtocolError::MathOverflow)?;
    ledger.paused_total = ledger
        .paused_total
        .checked_sub(cut)
        .ok_or(ProtocolError::MathOverflow)?;
    ledger.pause_end[i] = now;
    ledger.sync_status(now, key)?;
    emit!(PauseEnded {
        series: key,
        paused_total: ledger.paused_total,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_income_commitment_is_poseidon2_of_zeros() {
        let zero = [0u8; 32];
        assert_eq!(poseidon2(&zero, &zero).unwrap(), ZERO_INCOME_COMMITMENT);
    }

    #[test]
    fn key_grace_rules() {
        // active always passes
        assert!(key_usable(true, 0, None).unwrap());
        // revoked, no grace context
        assert!(!key_usable(false, 10, None).unwrap());
        // 2026 Q1 ends 1_774_915_200; revoked a day later, report within grace
        let end = period_end(8104).unwrap();
        assert!(key_usable(false, end + DAY, Some((8104, end + 2 * DAY))).unwrap());
        // revoked before the period ended: the period's attestation never validates
        assert!(!key_usable(false, end - 1, Some((8104, end + DAY))).unwrap());
        // past the grace
        assert!(!key_usable(false, end + DAY, Some((8104, end + DAY + KEY_GRACE_S + 1))).unwrap());
    }
}
