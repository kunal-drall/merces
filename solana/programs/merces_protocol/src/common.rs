//! Shared protocol logic: clock, registry write-interface CPIs, stablecoin transfers, the ledger's
//! status machine (SPEC §6.4) and the vault accounting glue (SPEC §6.3).

use anchor_lang::prelude::*;
use merces_common::params::MAX_YEAR_BUCKETS;
use merces_common::status::{
    derive_status, effective_now, formal_notice_at, SeriesStatus, StatusInputs,
};
use merces_common::time::{period_of, YEAR};
use merces_common::vault::{self, ReceiveInput, ReceiveOutcome};
use merces_onchain::{
    token_account_owner_and_amount, transfer_checked_hooked, HelperError, TransferAccounts,
};
use merces_registry::state::{TERMINAL_EXTINGUISHED, TERMINAL_REDEEMED, TERMINAL_RETIRED};

use crate::error::{math, ProtocolError};
use crate::events::*;
use crate::state::*;

/// Current unix time as `u64`.
pub fn now_ts() -> Result<u64> {
    let ts = Clock::get()?.unix_timestamp;
    u64::try_from(ts).map_err(|_| error!(ProtocolError::NegativeTimestamp))
}

/// Accounts for the registry write interface (SPEC §3.3).
pub struct RegistryCpi<'info> {
    pub registry_program: AccountInfo<'info>,
    pub config: AccountInfo<'info>,
    pub series: AccountInfo<'info>,
    pub protocol_signer: AccountInfo<'info>,
    pub signer_bump: u8,
}

impl<'info> RegistryCpi<'info> {
    pub fn mark_raise_result(
        &self,
        state: u8,
        settlement_ts: u64,
        units_sold: u64,
        clearing_price: u64,
        is_final: bool,
    ) -> Result<()> {
        let bump = [self.signer_bump];
        let seeds: &[&[u8]] = &[seeds::REGISTRY_SIGNER, &bump];
        let signer: &[&[&[u8]]] = &[seeds];
        let ctx = CpiContext::new_with_signer(
            *self.registry_program.key,
            merces_registry::cpi::accounts::MarkRaiseResult {
                config: self.config.clone(),
                protocol_signer: self.protocol_signer.clone(),
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
            is_final,
        )
    }

    pub fn mark_terminal(&self, status: SeriesStatus) -> Result<()> {
        let code = match status {
            SeriesStatus::Retired => TERMINAL_RETIRED,
            SeriesStatus::Redeemed => TERMINAL_REDEEMED,
            SeriesStatus::Extinguished => TERMINAL_EXTINGUISHED,
            _ => return Err(ProtocolError::InvalidInput.into()),
        };
        let bump = [self.signer_bump];
        let seeds: &[&[u8]] = &[seeds::REGISTRY_SIGNER, &bump];
        let signer: &[&[&[u8]]] = &[seeds];
        let ctx = CpiContext::new_with_signer(
            *self.registry_program.key,
            merces_registry::cpi::accounts::MarkTerminal {
                config: self.config.clone(),
                protocol_signer: self.protocol_signer.clone(),
                series: self.series.clone(),
            },
            signer,
        );
        merces_registry::cpi::mark_terminal(ctx, code)
    }
}

/// Hook-aware stablecoin `transfer_checked` with the protocol's error codes.
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
    .map_err(|e| match e {
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
    })
}

/// Validates a fee-collector token account: owned by the configured fee collector, right mint.
pub fn check_fee_collector_token(
    acc: &AccountInfo,
    mint: &Pubkey,
    fee_collector: &Pubkey,
) -> Result<()> {
    let (owner, _) = token_account_owner_and_amount(acc)?;
    require_keys_eq!(owner, *fee_collector, ProtocolError::FeeCollectorMismatch);
    require_keys_eq!(
        token_account_mint(acc)?,
        *mint,
        ProtocolError::StablecoinMismatch
    );
    Ok(())
}

/// Requires `acc` to be the associated token account of `owner` for `mint` under `token_program`
/// (SPEC §12: ATA derivation is validated for every payout destination).
pub fn require_ata(
    acc: &AccountInfo,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Result<()> {
    let expected = anchor_spl::associated_token::get_associated_token_address_with_program_id(
        owner,
        mint,
        token_program,
    );
    require_keys_eq!(*acc.key, expected, ProtocolError::HolderAtaMismatch);
    Ok(())
}

/// Mint of a token account (bytes 0..32 of the base layout).
pub fn token_account_mint(acc: &AccountInfo) -> Result<Pubkey> {
    let data = acc.try_borrow_data()?;
    if data.len() < 72 {
        return Err(ProtocolError::InvalidMint.into());
    }
    let mut mint = [0u8; 32];
    mint.copy_from_slice(&data[0..32]);
    Ok(Pubkey::new_from_array(mint))
}

/// Amount of a token account (bytes 64..72).
pub fn token_account_amount(acc: &AccountInfo) -> Result<u64> {
    Ok(token_account_owner_and_amount(acc)?.1)
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

    pub fn status_inputs(&self) -> Result<StatusInputs> {
        Ok(StatusInputs {
            stored: self.stored_status(),
            pause_start: self.pause_start,
            pause_end: self.pause_end,
            paused_total: self.paused_total,
            earliest_unpaid_period: self.earliest_unpaid()?,
        })
    }

    pub fn derived_status(&self, now: u64) -> Result<SeriesStatus> {
        derive_status(&self.status_inputs()?, now).map_err(math)
    }

    pub fn effective_now(&self, now: u64) -> Result<u64> {
        effective_now(self.pause_start, self.pause_end, self.paused_total, now).map_err(math)
    }

    /// `sync_status(now)` (SPEC §6.4): closes an elapsed pause, stores the derived status, emits
    /// `StatusChanged` on change and `FormalNoticeDue` once per period.
    pub fn sync_status(&mut self, now: u64, series_key: Pubkey) -> Result<SeriesStatus> {
        if self.pause_start != 0 && now >= self.pause_end {
            let len = self
                .pause_end
                .checked_sub(self.pause_start)
                .ok_or(ProtocolError::MathOverflow)?;
            self.paused_total = self
                .paused_total
                .checked_add(len)
                .ok_or(ProtocolError::MathOverflow)?;
            self.pause_start = 0;
            self.pause_end = 0;
        }
        let old = self.stored_status();
        let new = self.derived_status(now)?;
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
            let e = self.effective_now(now)?;
            if e >= formal_notice_at(p).map_err(math)?
                && self.formal_notice_emitted_for() != Some(p)
            {
                self.set_formal_notice_emitted_for(Some(p));
                emit!(FormalNoticeDue {
                    series: series_key,
                    period: p
                });
            }
        }
        Ok(new)
    }

    /// Index into `year_gross_wad` for `now`.
    pub fn settlement_year_index(&self, now: u64) -> Result<usize> {
        let elapsed = now
            .checked_sub(self.settlement_ts)
            .ok_or(ProtocolError::MathOverflow)?;
        let idx =
            usize::try_from(elapsed / YEAR).map_err(|_| ProtocolError::YearIndexOutOfRange)?;
        require!(idx < MAX_YEAR_BUCKETS, ProtocolError::YearIndexOutOfRange);
        Ok(idx)
    }

    /// Main-cap receipt (SPEC §6.3). Updates the accumulators and emits `PayoutDistributed`; the
    /// caller moves the fee and the refund and handles retirement side effects.
    pub fn receive_gross(
        &mut self,
        source: u8,
        gross: u64,
        units: u64,
        fee_bps: u16,
        now: u64,
        series_key: Pubkey,
    ) -> Result<ReceiveOutcome> {
        require!(units > 0, ProtocolError::NoUnitsOutstanding);
        let carry_in = self.carry;
        let out = vault::receive_gross(ReceiveInput {
            gross,
            units,
            cap_per_unit: self.cap_per_unit,
            paid_per_unit_wad: self.paid_per_unit_wad,
            carry: carry_in,
            fee_bps,
        })
        .map_err(math)?;
        let year = self.settlement_year_index(now)?;
        self.paid_per_unit_wad = self
            .paid_per_unit_wad
            .checked_add(out.inc_wad)
            .ok_or(ProtocolError::MathOverflow)?;
        self.year_gross_wad[year] = self.year_gross_wad[year]
            .checked_add(out.inc_wad)
            .ok_or(ProtocolError::MathOverflow)?;
        self.net_acc_wad = self
            .net_acc_wad
            .checked_add(out.delta_acc_wad)
            .ok_or(ProtocolError::MathOverflow)?;
        self.carry = out.carry_out;
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
        if out.retired {
            self.status = SeriesStatus::Retired as u8;
        }
        emit!(PayoutDistributed {
            series: series_key,
            source,
            gross,
            accepted: out.accepted,
            fee: out.fee,
            net_added: out
                .net
                .checked_sub(carry_in)
                .ok_or(ProtocolError::MathOverflow)?,
            delta_acc_wad: out.delta_acc_wad,
            paid_per_unit_wad: self.paid_per_unit_wad,
            retired: out.retired,
        });
        Ok(out)
    }

    /// Tail receipt (SPEC §6.8) against `tail_cap_per_unit` with `units_at_redemption` weights.
    pub fn receive_tail(
        &mut self,
        gross: u64,
        fee_bps: u16,
        series_key: Pubkey,
    ) -> Result<ReceiveOutcome> {
        let units = self.units_at_redemption;
        require!(units > 0, ProtocolError::NoUnitsOutstanding);
        let carry_in = self.tail_carry;
        let out = vault::receive_tail(ReceiveInput {
            gross,
            units,
            cap_per_unit: self.tail_cap_per_unit,
            paid_per_unit_wad: self.tail_paid_per_unit_wad,
            carry: carry_in,
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
        self.tail_carry = out.carry_out;
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
            source: SOURCE_TAIL,
            gross,
            accepted: out.accepted,
            fee: out.fee,
            net_added: out
                .net
                .checked_sub(carry_in)
                .ok_or(ProtocolError::MathOverflow)?,
            delta_acc_wad: out.delta_acc_wad,
            paid_per_unit_wad: self.tail_paid_per_unit_wad,
            retired: false,
        });
        Ok(out)
    }

    /// Final (extinguishment) distribution (SPEC §6.9): no fee, no cap.
    pub fn receive_final(
        &mut self,
        gross: u64,
        units: u64,
        series_key: Pubkey,
    ) -> Result<ReceiveOutcome> {
        require!(units > 0, ProtocolError::NoUnitsOutstanding);
        let carry_in = self.final_carry;
        let out = vault::receive_final(gross, units, carry_in).map_err(math)?;
        self.final_acc_wad = self
            .final_acc_wad
            .checked_add(out.delta_acc_wad)
            .ok_or(ProtocolError::MathOverflow)?;
        self.final_carry = out.carry_out;
        emit!(PayoutDistributed {
            series: series_key,
            source: SOURCE_FINAL,
            gross,
            accepted: out.accepted,
            fee: 0,
            net_added: out
                .net
                .checked_sub(carry_in)
                .ok_or(ProtocolError::MathOverflow)?,
            delta_acc_wad: out.delta_acc_wad,
            paid_per_unit_wad: self.paid_per_unit_wad,
            retired: false,
        });
        Ok(out)
    }

    /// `first_period = period_of(settlement_ts)`.
    pub fn init_after_settlement(&mut self, settlement_ts: u64, cap_per_unit: u64) -> Result<()> {
        self.settlement_ts = settlement_ts;
        self.first_period = period_of(settlement_ts).map_err(math)?;
        self.cap_per_unit = cap_per_unit;
        self.status = SeriesStatus::OnTime as u8;
        Ok(())
    }
}

/// `settle_holder` (SPEC §6.3): credits the pending payout for `balance` units since the last
/// snapshot and moves the snapshot forward.
pub fn settle_holder(ledger: &Ledger, holder: &mut Holder, balance: u64) -> Result<()> {
    require!(holder.registered, ProtocolError::HolderNotRegistered);
    let delta =
        vault::holder_delta(ledger.net_acc_wad, holder.last_net_acc_wad, balance).map_err(math)?;
    holder.pending = holder
        .pending
        .checked_add(delta)
        .ok_or(ProtocolError::MathOverflow)?;
    holder.last_net_acc_wad = ledger.net_acc_wad;
    Ok(())
}

/// Registers a holder at the current accumulators if not yet registered.
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
    holder.bump = bump;
    emit!(HolderRegistered {
        series,
        holder: wallet
    });
    Ok(true)
}
