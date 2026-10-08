//! Shared protocol logic: clock, registry write-interface CPIs, token transfers, the ledger's
//! status machine (SPEC §6.4) and the vault accounting glue (SPEC §6.3, §6.8, §6.9).

use anchor_lang::prelude::*;
use merces_common::params::{Tranche, MAX_PAUSES, YEAR_RING};
use merces_common::redemption::{settlement_year, year_gross_add, YearGross};
use merces_common::status::{
    countdown, derive_status, formal_notice_due, is_late_underlying, trueup_notice_due, Pause,
    SeriesStatus, StatusInputs,
};
use merces_common::time::period_of;
use merces_common::vault::{self, cap_per_unit, holder_delta, ReceiveInput, ReceiveOutcome};
use merces_onchain::{
    token_account_owner_and_amount, transfer_checked_hooked, HelperError, TransferAccounts,
};
use merces_registry::state::{Series, TERMINAL_EXTINGUISHED, TERMINAL_REDEEMED, TERMINAL_RETIRED};

use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::state::*;

/// Current unix time as `u64`.
pub fn now_ts() -> Result<u64> {
    let ts = Clock::get()?.unix_timestamp;
    u64::try_from(ts).map_err(|_| error!(ProtocolError::NegativeTimestamp))
}

/// `cap_per_unit() = floor(cap_multiple_wad × P0 / WAD)`, read live from the registry so a
/// favourable amendment applies immediately (SPEC §6.1).
pub fn cap_per_unit_of(series: &Series) -> Result<u64> {
    cap_per_unit(series.cap_multiple_wad, series.clearing_price).map_err(math)
}

/// The release schedule as shared-crate tranches.
pub fn schedule_of(series: &Series) -> Vec<Tranche> {
    series
        .release_schedule
        .iter()
        .map(|t| Tranche::from(*t))
        .collect()
}

// ------------------------------------------------------------------------------- registry CPI

/// Accounts for the registry write interface (SPEC §3.2), signed by `[REGISTRY_AUTHORITY]`.
pub struct RegistryCpi<'info> {
    pub registry_program: AccountInfo<'info>,
    pub config: AccountInfo<'info>,
    pub series: AccountInfo<'info>,
    pub registry_authority: AccountInfo<'info>,
    pub authority_bump: u8,
}

impl<'info> RegistryCpi<'info> {
    pub fn mark_raise_result(
        &self,
        state: u8,
        settlement_ts: u64,
        units_sold: u64,
        clearing_price: u64,
    ) -> Result<()> {
        let bump = [self.authority_bump];
        let seeds: &[&[u8]] = &[seeds::REGISTRY_AUTHORITY, &bump];
        let signer: &[&[&[u8]]] = &[seeds];
        let ctx = CpiContext::new_with_signer(
            *self.registry_program.key,
            merces_registry::cpi::accounts::MarkRaiseResult {
                config: self.config.clone(),
                protocol_authority: self.registry_authority.clone(),
                series: self.series.clone(),
            },
            signer,
        );
        merces_registry::cpi::mark_raise_result(
            ctx,
            state,
            settlement_ts,
            units_sold,
            clearing_price,
        )
    }

    pub fn mark_mint_finalized(&self) -> Result<()> {
        let bump = [self.authority_bump];
        let seeds: &[&[u8]] = &[seeds::REGISTRY_AUTHORITY, &bump];
        let signer: &[&[&[u8]]] = &[seeds];
        let ctx = CpiContext::new_with_signer(
            *self.registry_program.key,
            merces_registry::cpi::accounts::MarkRaiseResult {
                config: self.config.clone(),
                protocol_authority: self.registry_authority.clone(),
                series: self.series.clone(),
            },
            signer,
        );
        merces_registry::cpi::mark_mint_finalized(ctx)
    }

    pub fn mark_terminal(&self, status: SeriesStatus) -> Result<()> {
        let code = match status {
            SeriesStatus::Retired => TERMINAL_RETIRED,
            SeriesStatus::Redeemed => TERMINAL_REDEEMED,
            SeriesStatus::Extinguished => TERMINAL_EXTINGUISHED,
            _ => return Err(ProtocolError::InvalidInput.into()),
        };
        let bump = [self.authority_bump];
        let seeds: &[&[u8]] = &[seeds::REGISTRY_AUTHORITY, &bump];
        let signer: &[&[&[u8]]] = &[seeds];
        let ctx = CpiContext::new_with_signer(
            *self.registry_program.key,
            merces_registry::cpi::accounts::MarkRaiseResult {
                config: self.config.clone(),
                protocol_authority: self.registry_authority.clone(),
                series: self.series.clone(),
            },
            signer,
        );
        merces_registry::cpi::mark_terminal(ctx, code)
    }
}

// ------------------------------------------------------------------------------------- tokens

fn map_helper_error(e: Error) -> Error {
    match e {
        Error::AnchorError(ref a)
            if a.error_code_number == u32::from(HelperError::TokenProgramMismatch) =>
        {
            error!(ProtocolError::TokenProgramMismatch)
        }
        Error::AnchorError(ref a)
            if a.error_code_number == u32::from(HelperError::TransferFeeNotZero) =>
        {
            error!(ProtocolError::TransferFeeNotZero)
        }
        Error::AnchorError(ref a) if a.error_code_number == u32::from(HelperError::InvalidMint) => {
            error!(ProtocolError::InvalidMint)
        }
        other => other,
    }
}

/// Hook-aware stablecoin `transfer_checked` with the protocol's error codes (zero amount = no-op).
#[allow(clippy::too_many_arguments)]
pub fn transfer_stable<'info>(
    token_program: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    extra: &[AccountInfo<'info>],
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    transfer_checked_hooked(
        TransferAccounts {
            token_program,
            source,
            mint,
            destination,
            authority,
            extra,
        },
        amount,
        decimals,
        signer_seeds,
    )
    .map_err(map_helper_error)
}

/// Hook-aware unit transfer (Token-2022, `decimals = 0`); the Merces hook's extra accounts come
/// from `extra` (zero amount = no-op).
#[allow(clippy::too_many_arguments)]
pub fn transfer_units<'info>(
    token_2022: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    extra: &[AccountInfo<'info>],
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    transfer_checked_hooked(
        TransferAccounts {
            token_program: token_2022,
            source,
            mint,
            destination,
            authority,
            extra,
        },
        amount,
        0,
        signer_seeds,
    )
    .map_err(map_helper_error)
}

/// Associated token account address of `owner` for `mint` under `token_program`.
pub fn ata_address(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    anchor_spl::associated_token::get_associated_token_address_with_program_id(
        owner,
        mint,
        token_program,
    )
}

/// Requires `acc` to be the associated token account of `owner` for `mint` under `token_program`
/// (SPEC §12: ATA derivation is validated for every payout destination).
pub fn require_ata(
    acc: &AccountInfo,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *acc.key,
        ata_address(owner, mint, token_program),
        ProtocolError::AtaMismatch
    );
    Ok(())
}

/// Accounts of one idempotent ATA creation.
pub struct CreateAta<'a, 'info> {
    pub payer: &'a AccountInfo<'info>,
    pub ata: &'a AccountInfo<'info>,
    pub owner: &'a AccountInfo<'info>,
    pub mint: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub ata_program: &'a AccountInfo<'info>,
}

/// Creates the ATA if it does not exist (the payer funds it); the address is validated first.
pub fn create_ata_idempotent(a: CreateAta<'_, '_>) -> Result<()> {
    require_ata(a.ata, a.owner.key, a.mint.key, a.token_program.key)?;
    anchor_spl::associated_token::create_idempotent(CpiContext::new(
        *a.ata_program.key,
        anchor_spl::associated_token::Create {
            payer: a.payer.clone(),
            associated_token: a.ata.clone(),
            authority: a.owner.clone(),
            mint: a.mint.clone(),
            system_program: a.system_program.clone(),
            token_program: a.token_program.clone(),
        },
    ))
}

/// Amount of a token account (bytes 64..72 of the base layout).
pub fn token_account_amount(acc: &AccountInfo) -> Result<u64> {
    Ok(token_account_owner_and_amount(acc)?.1)
}

/// Owner (wallet) of a token account.
pub fn token_account_owner(acc: &AccountInfo) -> Result<Pubkey> {
    Ok(token_account_owner_and_amount(acc)?.0)
}

// ------------------------------------------------------------------------------------- ledger

/// A copy of the ledger's pause history as shared-crate pauses.
pub struct PauseList {
    items: [Pause; MAX_PAUSES],
    len: usize,
}

impl PauseList {
    pub fn as_slice(&self) -> &[Pause] {
        &self.items[..self.len]
    }
}

impl Ledger {
    pub fn stored_status(&self) -> SeriesStatus {
        SeriesStatus::from_u8(self.status).unwrap_or(SeriesStatus::OnTime)
    }

    pub fn is_terminal(&self) -> bool {
        self.stored_status().is_terminal()
    }

    /// `first_period` if nothing accepted, else `last_accepted_period + 1`.
    pub fn next_expected_period(&self) -> Result<u32> {
        match self.last_accepted_period() {
            None => Ok(self.first_period),
            Some(p) => p.checked_add(1).ok_or(ProtocolError::MathOverflow.into()),
        }
    }

    /// `open_due_period` if a due is open, else the next expected period.
    pub fn earliest_unpaid(&self) -> Result<u32> {
        if self.open_due_amount > 0 {
            if let Some(p) = self.open_due_period() {
                return Ok(p);
            }
        }
        self.next_expected_period()
    }

    pub fn pauses(&self) -> PauseList {
        let mut items = [Pause::default(); MAX_PAUSES];
        let len = core::cmp::min(usize::from(self.pause_count), MAX_PAUSES);
        for (i, slot) in items.iter_mut().enumerate().take(len) {
            *slot = Pause {
                start: self.pause_start[i],
                end: self.pause_end[i],
            };
        }
        PauseList { items, len }
    }

    pub fn status_inputs<'a>(&self, pauses: &'a [Pause]) -> Result<StatusInputs<'a>> {
        Ok(StatusInputs {
            stored: self.stored_status(),
            pauses,
            earliest_unpaid_period: self.earliest_unpaid()?,
            trueup_due: self.trueup_due,
            trueup_attested_at: self.trueup_attested_at,
        })
    }

    pub fn derived_status(&self, now: u64) -> Result<SeriesStatus> {
        let pauses = self.pauses();
        derive_status(&self.status_inputs(pauses.as_slice())?, now).map_err(math)
    }

    /// `is_late_underlying(now)` (SPEC §6.4): the Late condition ignoring an active pause.
    pub fn is_late_underlying(&self, now: u64) -> Result<bool> {
        let pauses = self.pauses();
        is_late_underlying(&self.status_inputs(pauses.as_slice())?, now).map_err(math)
    }

    /// An open pause exists with `start ≤ now < end`.
    pub fn is_paused(&self, now: u64) -> bool {
        let pauses = self.pauses();
        merces_common::status::is_paused(pauses.as_slice(), now)
    }

    /// `sync_status(now)` (SPEC §6.4): stores the derived status, emits `StatusChanged` on change,
    /// `FormalNoticeDue` once per period and once per true-up. Elapsed pauses need no closing: the
    /// pause record already holds its end.
    pub fn sync_status(&mut self, now: u64, series_key: Pubkey) -> Result<SeriesStatus> {
        let pauses = self.pauses();
        let old = self.stored_status();
        let new = derive_status(&self.status_inputs(pauses.as_slice())?, now).map_err(math)?;
        if new != old {
            self.status = new as u8;
            emit!(StatusChanged {
                series: series_key,
                old: old as u8,
                new: new as u8,
            });
        }
        if !new.is_terminal() {
            let p = self.earliest_unpaid()?;
            let c = countdown(pauses.as_slice(), p, now).map_err(math)?;
            if formal_notice_due(c) && self.formal_notice_emitted_for() != Some(p) {
                self.set_formal_notice_emitted_for(Some(p));
                emit!(FormalNoticeDue {
                    series: series_key,
                    period: p,
                    trueup: false,
                });
            }
            if self.trueup_due > 0
                && self.trueup_notice_emitted == 0
                && trueup_notice_due(pauses.as_slice(), self.trueup_attested_at, now)
            {
                self.trueup_notice_emitted = 1;
                emit!(FormalNoticeDue {
                    series: series_key,
                    period: self.trueup_year_v,
                    trueup: true,
                });
            }
        }
        Ok(new)
    }

    /// Clears every open obligation (retirement, extinguishment).
    pub fn clear_dues(&mut self) {
        self.open_due_amount = 0;
        self.set_open_due_period(None);
        self.open_due_tier = 0;
        self.trueup_due = 0;
        self.pause_requested = 0;
    }

    // ---- tagged rings

    pub fn year_gross_ring(&self) -> [YearGross; YEAR_RING] {
        let mut ring = [YearGross::default(); YEAR_RING];
        for (i, slot) in ring.iter_mut().enumerate() {
            *slot = YearGross {
                year: self.year_gross_tag[i],
                gross_wad: self.year_gross_wad[i],
                set: self.year_gross_set[i] != 0,
            };
        }
        ring
    }

    fn set_year_gross_ring(&mut self, ring: &[YearGross; YEAR_RING]) {
        for (i, slot) in ring.iter().enumerate() {
            self.year_gross_tag[i] = slot.year;
            self.year_gross_wad[i] = slot.gross_wad;
            self.year_gross_set[i] = u8::from(slot.set);
        }
    }

    /// Σ `payment_usd` accepted for calendar `year` (tagged ring; a missing tag reads 0).
    pub fn year_pay_at(&self, year: u32) -> u64 {
        let i = (year as usize) % YEAR_RING;
        if self.year_pay_set[i] != 0 && self.year_pay_tag[i] == year {
            self.year_pay_sum[i]
        } else {
            0
        }
    }

    pub fn year_pay_add(&mut self, year: u32, amount: u64) -> Result<()> {
        let i = (year as usize) % YEAR_RING;
        if self.year_pay_set[i] == 0 || self.year_pay_tag[i] != year {
            self.year_pay_tag[i] = year;
            self.year_pay_sum[i] = 0;
            self.year_pay_set[i] = 1;
        }
        self.year_pay_sum[i] = self.year_pay_sum[i]
            .checked_add(amount)
            .ok_or(ProtocolError::MathOverflow)?;
        Ok(())
    }

    // ---- receipts

    /// `vault_receive_gross(G, source, anchor)` (SPEC §6.3) against the live `cap_per_unit` with
    /// `N = units_outstanding`. Updates the accumulators and emits `PayoutDistributed`; the caller
    /// moves the fee and the refund and calls [`retire`] when `capped`.
    pub fn receive_gross(
        &mut self,
        source: u8,
        gross: u64,
        cap_per_unit: u64,
        anchor_ts: u64,
        fee_bps: u16,
        series_key: Pubkey,
    ) -> Result<ReceiveOutcome> {
        let units = self.units_outstanding;
        require!(units > 0, ProtocolError::NoUnitsOutstanding);
        let out = vault::receive_capped(ReceiveInput {
            gross,
            units,
            cap_per_unit,
            paid_per_unit_wad: self.paid_per_unit_wad,
            carry_wad: self.carry_wad,
            fee_bps,
        })
        .map_err(math)?;
        let anchor = core::cmp::max(anchor_ts, self.settlement_ts);
        let year = settlement_year(self.settlement_ts, anchor).map_err(math)?;
        let mut ring = self.year_gross_ring();
        year_gross_add(&mut ring, year, out.inc_wad).map_err(math)?;
        self.set_year_gross_ring(&ring);
        self.paid_per_unit_wad = self
            .paid_per_unit_wad
            .checked_add(out.inc_wad)
            .ok_or(ProtocolError::MathOverflow)?;
        self.net_acc_wad = self
            .net_acc_wad
            .checked_add(out.delta_acc_wad)
            .ok_or(ProtocolError::MathOverflow)?;
        self.carry_wad = out.carry_wad_out;
        self.gross_received = self
            .gross_received
            .checked_add(out.accepted)
            .ok_or(ProtocolError::MathOverflow)?;
        self.fee_collected = self
            .fee_collected
            .checked_add(out.fee)
            .ok_or(ProtocolError::MathOverflow)?;
        self.refunded_to_issuer = self
            .refunded_to_issuer
            .checked_add(out.refund)
            .ok_or(ProtocolError::MathOverflow)?;
        emit!(PayoutDistributed {
            series: series_key,
            source,
            gross,
            accepted: out.accepted,
            fee: out.fee,
            net_added: out.net,
            delta_acc_wad: out.delta_acc_wad,
            paid_per_unit_wad: self.paid_per_unit_wad,
            retired: out.capped,
        });
        Ok(out)
    }

    /// `vault_receive_tail(G)` (SPEC §6.8) against `tail_cap_per_unit` with `units_at_redemption`
    /// weights; `capped` sets `tail_exhausted`.
    pub fn receive_tail(
        &mut self,
        gross: u64,
        fee_bps: u16,
        series_key: Pubkey,
    ) -> Result<ReceiveOutcome> {
        let units = self.units_at_redemption;
        require!(units > 0, ProtocolError::NoUnitsOutstanding);
        let out = vault::receive_capped(ReceiveInput {
            gross,
            units,
            cap_per_unit: self.tail_cap_per_unit,
            paid_per_unit_wad: self.tail_paid_per_unit_wad,
            carry_wad: self.tail_carry_wad,
            fee_bps,
        })
        .map_err(math)?;
        self.tail_paid_per_unit_wad = self
            .tail_paid_per_unit_wad
            .checked_add(out.inc_wad)
            .ok_or(ProtocolError::MathOverflow)?;
        self.tail_acc_wad = self
            .tail_acc_wad
            .checked_add(out.delta_acc_wad)
            .ok_or(ProtocolError::MathOverflow)?;
        self.tail_carry_wad = out.carry_wad_out;
        self.fee_collected = self
            .fee_collected
            .checked_add(out.fee)
            .ok_or(ProtocolError::MathOverflow)?;
        self.refunded_to_issuer = self
            .refunded_to_issuer
            .checked_add(out.refund)
            .ok_or(ProtocolError::MathOverflow)?;
        if out.capped {
            self.tail_exhausted = 1;
        }
        emit!(PayoutDistributed {
            series: series_key,
            source: SOURCE_TAIL,
            gross,
            accepted: out.accepted,
            fee: out.fee,
            net_added: out.net,
            delta_acc_wad: out.delta_acc_wad,
            paid_per_unit_wad: self.tail_paid_per_unit_wad,
            retired: false,
        });
        Ok(out)
    }

    /// Final (extinguishment) distribution (SPEC §6.9): no fee, no cap, `final_units` weights.
    pub fn receive_final(&mut self, gross: u64, series_key: Pubkey) -> Result<ReceiveOutcome> {
        let units = self.final_units;
        require!(units > 0, ProtocolError::NoUnitsOutstanding);
        let out = vault::receive_final(gross, units, self.final_carry_wad).map_err(math)?;
        self.final_acc_wad = self
            .final_acc_wad
            .checked_add(out.delta_acc_wad)
            .ok_or(ProtocolError::MathOverflow)?;
        self.final_carry_wad = out.carry_wad_out;
        emit!(PayoutDistributed {
            series: series_key,
            source: SOURCE_FINAL,
            gross,
            accepted: out.accepted,
            fee: 0,
            net_added: out.net,
            delta_acc_wad: out.delta_acc_wad,
            paid_per_unit_wad: self.paid_per_unit_wad,
            retired: false,
        });
        Ok(out)
    }

    /// Ledger initialisation at settlement: `first_period = period_of(settlement_ts)`.
    pub fn init_after_settlement(&mut self, settlement_ts: u64) -> Result<()> {
        self.settlement_ts = settlement_ts;
        self.first_period = period_of(settlement_ts).map_err(math)?;
        self.status = SeriesStatus::OnTime as u8;
        Ok(())
    }
}

/// `retire()` (SPEC §6.3): stored status `Retired`, dues cleared, registry mirror, events.
pub fn retire(
    ledger: &mut Ledger,
    registry: &RegistryCpi<'_>,
    series_key: Pubkey,
    refund: u64,
) -> Result<()> {
    if ledger.stored_status() == SeriesStatus::Retired {
        return Ok(());
    }
    let old = ledger.status;
    ledger.status = SeriesStatus::Retired as u8;
    ledger.clear_dues();
    registry.mark_terminal(SeriesStatus::Retired)?;
    emit!(StatusChanged {
        series: series_key,
        old,
        new: SeriesStatus::Retired as u8,
    });
    emit!(SeriesRetired {
        series: series_key,
        paid_per_unit_wad: ledger.paid_per_unit_wad,
        refund,
    });
    Ok(())
}

// ------------------------------------------------------------------------------------ holders

/// `accrual_units(w) = unit_balance + undelivered auction units + ask-escrow units` (SPEC §6.1).
pub fn accrual_units(holder: &Holder, balance: u64) -> Result<u64> {
    balance
        .checked_add(holder.undelivered_units)
        .and_then(|v| v.checked_add(holder.ask_escrow_units))
        .ok_or(ProtocolError::MathOverflow.into())
}

/// `settle_holder` (SPEC §6.3): credits the pending payout for the holder's accrual weight since
/// the last snapshot and moves the snapshot forward.
pub fn settle_holder(ledger: &Ledger, holder: &mut Holder, balance: u64) -> Result<()> {
    require!(holder.registered, ProtocolError::HolderNotRegistered);
    let weight = accrual_units(holder, balance)?;
    let delta = holder_delta(ledger.net_acc_wad, holder.last_net_acc_wad, weight).map_err(math)?;
    holder.pending = holder
        .pending
        .checked_add(delta)
        .ok_or(ProtocolError::MathOverflow)?;
    holder.last_net_acc_wad = ledger.net_acc_wad;
    Ok(())
}

/// Registers a holder at the current accumulators if not yet registered. Returns `true` when the
/// record was created now.
pub fn register_holder_now(
    ledger: &Ledger,
    holder: &mut Holder,
    series: Pubkey,
    wallet: Pubkey,
    bump: u8,
) -> Result<bool> {
    if holder.registered {
        return Ok(false);
    }
    holder.series = series;
    holder.wallet = wallet;
    holder.registered = true;
    holder.last_net_acc_wad = ledger.net_acc_wad;
    holder.last_tail_acc_wad = ledger.tail_acc_wad;
    holder.last_final_acc_wad = ledger.final_acc_wad;
    holder.pending = 0;
    holder.redeemed_units = 0;
    holder.undelivered_units = 0;
    holder.ask_escrow_units = 0;
    holder.bump = bump;
    emit!(HolderRegistered {
        series,
        holder: wallet
    });
    Ok(true)
}
