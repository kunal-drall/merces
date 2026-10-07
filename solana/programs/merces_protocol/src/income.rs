//! ProofOfIncome verifier, payments, true-ups, status crank and hardship pauses (SPEC §6.2, §6.4).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use merces_common::encoding::{
    fx_message, pause_message, report_message, trueup_message, u64_to_be32,
};
use merces_common::fx::{quarter_average, Checkpoint};
use merces_common::params::{TAIL_SECONDS, TRUEUP_DAYS};
use merces_common::status::{grace_end, late_accrual, late_days_from, SeriesStatus};
use merces_common::time::{period_end, year_of, DAY};
use merces_common::WAD_U64;
use merces_onchain::seeds::{ATTESTOR, CONFIG, VERIFIER};
use merces_onchain::{keccak, recover_eth_address, SigError};
use merces_registry::program::MercesRegistry;
use merces_registry::state::{AttestorKey, ProtocolConfig, Series, VerifierKey};

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

pub fn map_sig_error(e: SigError) -> Error {
    match e {
        SigError::Malformed => error!(ProtocolError::MalformedSignature),
        SigError::RecoveryFailed => error!(ProtocolError::SignatureRecoveryFailed),
    }
}

/// Checks that `acc` is the registry's `AttestorKey` PDA for `addr` and that it is active.
pub fn require_active_attestor(acc: &AccountInfo, addr: &[u8; 20]) -> Result<()> {
    let (expected, _) =
        Pubkey::find_program_address(&[ATTESTOR, addr.as_ref()], &merces_registry::ID);
    require_keys_eq!(*acc.key, expected, ProtocolError::KeyAccountMismatch);
    require_keys_eq!(
        *acc.owner,
        merces_registry::ID,
        ProtocolError::KeyAccountMismatch
    );
    let data = acc.try_borrow_data()?;
    let key = AttestorKey::try_deserialize(&mut &data[..])?;
    require!(
        key.active && key.addr == *addr,
        ProtocolError::AttestorInactive
    );
    Ok(())
}

/// Checks that `acc` is the registry's `VerifierKey` PDA for `addr` and that it is active.
pub fn require_active_verifier(acc: &AccountInfo, addr: &[u8; 20]) -> Result<()> {
    let (expected, _) =
        Pubkey::find_program_address(&[VERIFIER, addr.as_ref()], &merces_registry::ID);
    require_keys_eq!(*acc.key, expected, ProtocolError::KeyAccountMismatch);
    require_keys_eq!(
        *acc.owner,
        merces_registry::ID,
        ProtocolError::KeyAccountMismatch
    );
    let data = acc.try_borrow_data()?;
    let key = VerifierKey::try_deserialize(&mut &data[..])?;
    require!(
        key.active && key.addr == *addr,
        ProtocolError::VerifierKeyInactive
    );
    Ok(())
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
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    #[account(init, payer = issuer, space = 8 + Report::INIT_SPACE, seeds = [seeds::REPORT, series.key().as_ref(), args.period.to_le_bytes().as_ref()], bump)]
    pub report: Box<Account<'info, Report>>,
    #[account(address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: registry key PDA for `attestation_addr` (verifier key for tier 2, attestor for tier 3);
    /// validated in the handler. Any account for tiers 1 and 4.
    pub attestation_key: UncheckedAccount<'info>,
    /// CHECK: registry `AttestorKey` PDA for `fx_attestor_addr`; validated when a fallback is used.
    pub fx_attestor_key: UncheckedAccount<'info>,
    /// Accumulator checkpoint at `period` (required when the series has an FX pair).
    #[account(seeds = [seeds::FX_CHECKPOINT, series.fx_pair_id.as_ref(), args.period.to_le_bytes().as_ref()], bump = fx_start.bump)]
    pub fx_start: Option<Account<'info, FxCheckpoint>>,
    /// Accumulator checkpoint at `period + 1`.
    #[account(seeds = [seeds::FX_CHECKPOINT, series.fx_pair_id.as_ref(), args.period.saturating_add(1).to_le_bytes().as_ref()], bump = fx_end.bump)]
    pub fx_end: Option<Account<'info, FxCheckpoint>>,
    pub system_program: Program<'info, System>,
}

pub fn submit_report(ctx: Context<SubmitReport>, args: SubmitReportArgs) -> Result<()> {
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    let config = &ctx.accounts.config;
    let ledger = &mut ctx.accounts.ledger;
    let status = ledger.sync_status(now, series_key)?;

    // 2. status and period rules
    require!(
        status != SeriesStatus::Extinguished,
        ProtocolError::SeriesExtinguished
    );
    require!(
        status != SeriesStatus::Retired,
        ProtocolError::SeriesRetired
    );
    let is_tail = status == SeriesStatus::Redeemed;
    if is_tail {
        require!(args.liquidity_event, ProtocolError::SeriesRedeemed);
        require!(ledger.tail_cap_per_unit > 0, ProtocolError::NoTailDue);
        let tail_end = ledger
            .redemption_ts
            .checked_add(TAIL_SECONDS)
            .ok_or(ProtocolError::MathOverflow)?;
        require!(now <= tail_end, ProtocolError::TailWindowClosed);
        if let Some(last) = ledger.last_accepted_period {
            require!(args.period > last, ProtocolError::WrongPeriod);
        }
        require!(
            args.period >= ledger.first_period,
            ProtocolError::WrongPeriod
        );
    } else {
        require!(
            args.period == ledger.next_expected_period()?,
            ProtocolError::WrongPeriod
        );
    }
    require!(
        now >= period_end(args.period).map_err(math)?,
        ProtocolError::PeriodNotEnded
    );
    require!(ledger.open_due_amount == 0, ProtocolError::DueOutstanding);

    // 3. tier
    require!((1..=4).contains(&args.tier), ProtocolError::TierNotEnabled);
    let tier_bit = 1u8 << (args.tier - 1);
    require!(
        series.tier_flags & tier_bit != 0,
        ProtocolError::TierNotEnabled
    );
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
        let quarter = match (&ctx.accounts.fx_start, &ctx.accounts.fx_end) {
            (Some(s), Some(e)) => {
                require!(
                    s.pair_id == series.fx_pair_id && e.pair_id == series.fx_pair_id,
                    ProtocolError::FxCheckpointMismatch
                );
                let start = Checkpoint {
                    sum_wad: s.sum_wad,
                    count: s.count,
                    flagged: s.flagged,
                };
                let end = Checkpoint {
                    sum_wad: e.sum_wad,
                    count: e.count,
                    flagged: e.flagged,
                };
                quarter_average(args.period, &start, &end, series.fx_min_coverage_bps)
                    .map_err(math)?
            }
            _ => (false, 0),
        };
        if quarter.0 {
            require!(
                args.fx_avg_wad == quarter.1,
                ProtocolError::FxAverageMismatch
            );
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
            let recovered = recover_eth_address(&msg, &sig).map_err(map_sig_error)?;
            require!(
                recovered == args.fx_attestor_addr,
                ProtocolError::SignerMismatch
            );
            require_active_attestor(
                &ctx.accounts.fx_attestor_key.to_account_info(),
                &args.fx_attestor_addr,
            )?;
            true
        }
    };

    // 5. prior commitment
    let prior = match ledger.last_income_period {
        Some(last)
            if last.checked_add(1) == Some(args.period)
                && year_of(last) == year_of(args.period) =>
        {
            ledger.last_income_commitment
        }
        _ => ZERO_INCOME_COMMITMENT,
    };

    // 6. proof
    let units_outstanding = if is_tail {
        ledger.units_at_redemption
    } else {
        ctx.accounts.unit_mint.supply
    };
    require!(units_outstanding > 0, ProtocolError::NoUnitsOutstanding);
    require!(args.proof.len() == 256, ProtocolError::MalformedProof);
    let mut proof = [0u8; 256];
    proof.copy_from_slice(&args.proof);
    let public_inputs: [[u8; 32]; NR_PUBLIC_INPUTS] = [
        series.terms_commitment,
        u64_to_be32(units_outstanding),
        u64_to_be32(args.fx_avg_wad),
        prior,
        args.income_commitment,
        u64_to_be32(args.payment_usd),
    ];
    verify_report_proof(&proof, &public_inputs)?;

    // 7. attestation
    match args.tier {
        TIER_ZKTLS | TIER_ATTESTOR => {
            let sig = args
                .attestation_sig
                .ok_or(ProtocolError::AttestationRequired)?;
            let msg = keccak(&[report_message(
                &config.domain,
                &series_key.to_bytes(),
                args.period,
                &args.income_commitment,
                args.tier,
            )
            .as_bytes()]);
            let recovered = recover_eth_address(&msg, &sig).map_err(map_sig_error)?;
            require!(
                recovered == args.attestation_addr,
                ProtocolError::SignerMismatch
            );
            let key = ctx.accounts.attestation_key.to_account_info();
            if args.tier == TIER_ZKTLS {
                require_active_verifier(&key, &args.attestation_addr)?;
            } else {
                require_active_attestor(&key, &args.attestation_addr)?;
            }
        }
        _ => {}
    }

    // 8. effects
    let credit_used = if is_tail {
        0
    } else {
        core::cmp::min(ledger.router_credit, args.payment_usd)
    };
    ledger.router_credit = ledger
        .router_credit
        .checked_sub(credit_used)
        .ok_or(ProtocolError::MathOverflow)?;
    let due = args
        .payment_usd
        .checked_sub(credit_used)
        .ok_or(ProtocolError::MathOverflow)?;
    ledger.last_accepted_period = Some(args.period);
    ledger.last_income_commitment = args.income_commitment;
    ledger.last_income_period = Some(args.period);
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
    r.due = due;
    r.bump = ctx.bumps.report;
    if due == 0 {
        ledger.last_paid_period = Some(args.period);
        r.paid_at = now;
        emit!(PaymentSettled {
            series: series_key,
            period: args.period,
            gross: 0,
            accrual: 0,
            fee: 0,
            accepted: 0,
            refunded: 0,
        });
    } else {
        ledger.open_due_period = Some(args.period);
        ledger.open_due_amount = due;
        ledger.open_due_tier = args.tier;
        ledger.open_due_is_tail = is_tail;
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
    Ok(())
}

// ------------------------------------------------------------------------------------------ pay

/// Shared accounts for every path that pulls stablecoin from a payer into the vault and settles
/// a receipt (fee to the collector, truncation refund to the issuer, retirement side effects).
#[derive(Accounts)]
pub struct Pay<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// The report of the open due period (`pay` only; any report account for `pay_trueup`).
    #[account(mut, seeds = [seeds::REPORT, series.key().as_ref(), report.period.to_le_bytes().as_ref()], bump = report.bump)]
    pub report: Option<Account<'info, Report>>,
    #[account(mut, token::mint = stablecoin_mint, token::authority = payer, token::token_program = stablecoin_program)]
    pub payer_stable: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::VAULT_TOKEN, series.key().as_ref()], bump)]
    pub vault_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: data-less signer PDA, vault owner and permanent delegate.
    #[account(seeds = [seeds::VAULT_AUTH, series.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    /// CHECK: the series issuer (refund destination owner).
    #[account(address = series.issuer @ ProtocolError::NotIssuer)]
    pub issuer: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = stablecoin_mint,
        associated_token::authority = issuer,
        associated_token::token_program = stablecoin_program,
    )]
    pub issuer_stable_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the configured fee collector wallet.
    #[account(address = config.fee_collector @ ProtocolError::FeeCollectorMismatch)]
    pub fee_collector: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = stablecoin_mint,
        associated_token::authority = fee_collector,
        associated_token::token_program = stablecoin_program,
    )]
    pub fee_collector_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = series.unit_mint @ ProtocolError::UnitMintMismatch)]
    pub unit_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin @ ProtocolError::StablecoinMismatch)]
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.stablecoin_program @ ProtocolError::TokenProgramMismatch)]
    pub stablecoin_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK: data-less signer PDA for the registry write interface.
    #[account(seeds = [seeds::REGISTRY_SIGNER], bump)]
    pub registry_signer: UncheckedAccount<'info>,
    pub registry_program: Program<'info, MercesRegistry>,
    pub system_program: Program<'info, System>,
}

/// Pulls `total` into the vault, runs the ledger receipt and moves fee / refund. Returns the
/// receive outcome. Handles the Retired transition (registry + event + clearing dues).
fn settle_receipt<'info>(
    ctx: &mut Context<'info, Pay<'info>>,
    total: u64,
    source: u8,
    is_tail: bool,
    now: u64,
) -> Result<merces_common::vault::ReceiveOutcome> {
    let series_key = ctx.accounts.series.key();
    let decimals = ctx.accounts.series.stablecoin_decimals;
    let fee_bps = ctx.accounts.series.payout_fee_bps;
    let token_program = ctx.accounts.stablecoin_program.to_account_info();
    let mint = ctx.accounts.stablecoin_mint.to_account_info();
    let vault = ctx.accounts.vault_token.to_account_info();
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
    let units = ctx.accounts.unit_mint.supply;
    let out = if is_tail {
        ctx.accounts
            .ledger
            .receive_tail(total, fee_bps, series_key)?
    } else {
        ctx.accounts
            .ledger
            .receive_gross(source, total, units, fee_bps, now, series_key)?
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
    if out.retired {
        let ledger = &mut ctx.accounts.ledger;
        ledger.open_due_amount = 0;
        ledger.open_due_period = None;
        ledger.trueup_due = 0;
        RegistryCpi {
            registry_program: ctx.accounts.registry_program.to_account_info(),
            config: ctx.accounts.config.to_account_info(),
            series: ctx.accounts.series.to_account_info(),
            protocol_signer: ctx.accounts.registry_signer.to_account_info(),
            signer_bump: ctx.bumps.registry_signer,
        }
        .mark_terminal(SeriesStatus::Retired)?;
        emit!(SeriesRetired {
            series: series_key,
            paid_per_unit_wad: ledger.paid_per_unit_wad,
            refund: out.refund,
        });
    }
    Ok(out)
}

/// `pay` (SPEC §6.2): pulls the open due plus late accrual from the payer into the vault.
pub fn pay<'info>(mut ctx: Context<'info, Pay<'info>>) -> Result<()> {
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let status = ctx.accounts.ledger.sync_status(now, series_key)?;
    require!(
        status != SeriesStatus::Extinguished,
        ProtocolError::SeriesExtinguished
    );
    require!(
        status != SeriesStatus::Retired,
        ProtocolError::SeriesRetired
    );
    let ledger = &ctx.accounts.ledger;
    require!(ledger.open_due_amount > 0, ProtocolError::NothingDue);
    let period = ledger.open_due_period.ok_or(ProtocolError::NothingDue)?;
    let report = ctx
        .accounts
        .report
        .as_ref()
        .ok_or(ProtocolError::NothingDue)?;
    require!(report.period == period, ProtocolError::WrongPeriod);
    let amount = ledger.open_due_amount;
    let is_tail = ledger.open_due_is_tail;
    let eff = ledger.effective_now(now)?;
    let late_days = late_days_from(eff, grace_end(period).map_err(math)?);
    let accrual =
        late_accrual(amount, ctx.accounts.series.hurdle_rate_wad, late_days).map_err(math)?;
    let total = amount
        .checked_add(accrual)
        .ok_or(ProtocolError::MathOverflow)?;

    let out = settle_receipt(&mut ctx, total, SOURCE_PAYMENT, is_tail, now)?;

    let ledger = &mut ctx.accounts.ledger;
    ledger.last_paid_period = Some(period);
    ledger.open_due_amount = 0;
    ledger.open_due_period = None;
    ledger.open_due_is_tail = false;
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
pub fn pay_trueup<'info>(mut ctx: Context<'info, Pay<'info>>) -> Result<()> {
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let status = ctx.accounts.ledger.sync_status(now, series_key)?;
    require!(!status.is_terminal(), ProtocolError::SeriesTerminal);
    let ledger = &ctx.accounts.ledger;
    require!(ledger.trueup_due > 0, ProtocolError::NoTrueUpDue);
    let amount = ledger.trueup_due;
    let eff = ledger.effective_now(now)?;
    let late_days = late_days_from(eff, ledger.trueup_deadline);
    let accrual =
        late_accrual(amount, ctx.accounts.series.hurdle_rate_wad, late_days).map_err(math)?;
    let total = amount
        .checked_add(accrual)
        .ok_or(ProtocolError::MathOverflow)?;
    settle_receipt(&mut ctx, total, SOURCE_PAYMENT, false, now)?;
    let ledger = &mut ctx.accounts.ledger;
    ledger.trueup_due = 0;
    ledger.trueup_deadline = 0;
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
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: registry `AttestorKey` PDA for `attestor_addr`; validated in the handler.
    pub attestor_key: UncheckedAccount<'info>,
}

pub fn submit_trueup(
    ctx: Context<SubmitTrueUp>,
    year: u16,
    adjustment: i64,
    attestation_ts: u64,
    attestor_addr: [u8; 20],
    attestor_sig: [u8; 65],
) -> Result<()> {
    let now = now_ts()?;
    let series_key = ctx.accounts.series.key();
    let series = &ctx.accounts.series;
    require!(
        series.tier_flags & (1 << (TIER_ATTESTOR - 1)) != 0,
        ProtocolError::TierNotEnabled
    );
    require!(adjustment != 0, ProtocolError::ZeroAdjustment);
    let status = ctx.accounts.ledger.sync_status(now, series_key)?;
    require!(!status.is_terminal(), ProtocolError::SeriesTerminal);
    let msg = keccak(&[trueup_message(
        &ctx.accounts.config.domain,
        &series_key.to_bytes(),
        year,
        adjustment,
        attestation_ts,
    )
    .as_bytes()]);
    let recovered = recover_eth_address(&msg, &attestor_sig).map_err(map_sig_error)?;
    require!(recovered == attestor_addr, ProtocolError::SignerMismatch);
    require_active_attestor(&ctx.accounts.attestor_key.to_account_info(), &attestor_addr)?;
    let ledger = &mut ctx.accounts.ledger;
    let deadline = if adjustment > 0 {
        let add = u64::try_from(adjustment).map_err(|_| ProtocolError::MathOverflow)?;
        ledger.trueup_due = ledger
            .trueup_due
            .checked_add(add)
            .ok_or(ProtocolError::MathOverflow)?;
        let deadline = attestation_ts
            .checked_add(
                TRUEUP_DAYS
                    .checked_mul(DAY)
                    .ok_or(ProtocolError::MathOverflow)?,
            )
            .ok_or(ProtocolError::MathOverflow)?;
        ledger.trueup_deadline = deadline;
        deadline
    } else {
        let credit = u64::try_from(
            adjustment
                .checked_neg()
                .ok_or(ProtocolError::MathOverflow)?,
        )
        .map_err(|_| ProtocolError::MathOverflow)?;
        ledger.router_credit = ledger
            .router_credit
            .checked_add(credit)
            .ok_or(ProtocolError::MathOverflow)?;
        0
    };
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
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
}

pub fn crank_status(ctx: Context<CrankStatus>) -> Result<()> {
    let now = now_ts()?;
    let key = ctx.accounts.series.key();
    ctx.accounts.ledger.sync_status(now, key)?;
    Ok(())
}

// -------------------------------------------------------------------------------------- pauses

#[derive(Accounts)]
pub struct RequestPause<'info> {
    pub issuer: Signer<'info>,
    #[account(constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
}

pub fn request_pause(ctx: Context<RequestPause>) -> Result<()> {
    let now = now_ts()?;
    let key = ctx.accounts.series.key();
    let status = ctx.accounts.ledger.sync_status(now, key)?;
    require!(!status.is_terminal(), ProtocolError::SeriesTerminal);
    ctx.accounts.ledger.pause_requested = true;
    emit!(PauseRequested { series: key });
    Ok(())
}

#[derive(Accounts)]
pub struct ApprovePause<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, seeds::program = merces_registry::ID)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: registry `AttestorKey` PDA for `attestor_addr`; validated in the handler.
    pub attestor_key: UncheckedAccount<'info>,
}

/// Anyone may submit the attestor's approval (SPEC §6.4).
pub fn approve_pause(
    ctx: Context<ApprovePause>,
    pause_end: u64,
    attestor_addr: [u8; 20],
    attestor_sig: [u8; 65],
) -> Result<()> {
    let now = now_ts()?;
    let key = ctx.accounts.series.key();
    let status = ctx.accounts.ledger.sync_status(now, key)?;
    require!(!status.is_terminal(), ProtocolError::SeriesTerminal);
    let ledger = &ctx.accounts.ledger;
    require!(ledger.pause_requested, ProtocolError::PauseNotRequested);
    require!(pause_end > now, ProtocolError::PauseEndInPast);
    require!(ledger.pause_start == 0, ProtocolError::AlreadyPaused);
    let msg = keccak(&[pause_message(
        &ctx.accounts.config.domain,
        &key.to_bytes(),
        ledger.pause_nonce,
        pause_end,
    )
    .as_bytes()]);
    let recovered = recover_eth_address(&msg, &attestor_sig).map_err(map_sig_error)?;
    require!(recovered == attestor_addr, ProtocolError::SignerMismatch);
    require_active_attestor(&ctx.accounts.attestor_key.to_account_info(), &attestor_addr)?;
    let ledger = &mut ctx.accounts.ledger;
    ledger.pause_start = now;
    ledger.pause_end = pause_end;
    ledger.pause_nonce = ledger
        .pause_nonce
        .checked_add(1)
        .ok_or(ProtocolError::MathOverflow)?;
    ledger.pause_requested = false;
    ledger.sync_status(now, key)?;
    emit!(PauseApproved {
        series: key,
        start: now,
        end: pause_end,
        attestor: attestor_addr,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct EndPause<'info> {
    pub issuer: Signer<'info>,
    #[account(constraint = series.issuer == issuer.key() @ ProtocolError::NotIssuer)]
    pub series: Box<Account<'info, Series>>,
    #[account(mut, seeds = [seeds::LEDGER, series.key().as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
}

pub fn end_pause(ctx: Context<EndPause>) -> Result<()> {
    let now = now_ts()?;
    let key = ctx.accounts.series.key();
    let ledger = &mut ctx.accounts.ledger;
    // closes an already-elapsed pause first
    ledger.sync_status(now, key)?;
    require!(
        ledger.pause_start != 0 && now < ledger.pause_end,
        ProtocolError::NotPaused
    );
    let elapsed = now
        .checked_sub(ledger.pause_start)
        .ok_or(ProtocolError::MathOverflow)?;
    ledger.paused_total = ledger
        .paused_total
        .checked_add(elapsed)
        .ok_or(ProtocolError::MathOverflow)?;
    ledger.pause_start = 0;
    ledger.pause_end = 0;
    ledger.sync_status(now, key)?;
    emit!(PauseEnded {
        series: key,
        paused_total: ledger.paused_total,
    });
    Ok(())
}
