//! Merces charter and terms registry (D1) plus the allowlist, attestor, verifier-key and FX-pair
//! registries (D11). Deployed with its upgrade authority revoked: charter data has no upgrade path.
//!
//! The protocol program writes raise results, mint finalisation and terminal statuses through the
//! narrow interface in SPEC §3.2/§3.3, authenticated by its `registry_authority` PDA.
#![allow(unexpected_cfgs)]
#![allow(clippy::too_many_arguments)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use merces_common::encoding::{
    amend_message, domain_preimage, fx_pair_id_preimage, CHAIN_KIND_SOLANA,
};
use merces_common::params::{validate_schedule, wallet_cap_allows_a_bid, Parameters, Tranche};
use merces_common::time::period_of;
use merces_common::WAD;
use merces_onchain::seeds::{
    ALLOW, ATTESTOR, CONFIG, FX, ISSUER, REGISTRY_AUTHORITY, SERIES, VERIFIER,
};
use merces_onchain::{
    assert_zero_transfer_fee, keccak, poseidon5, recover_eth_address, u64_field, FeeCheckError,
    SigError,
};

pub mod error;
pub mod events;
pub mod state;

use error::RegistryError;
use events::*;
use state::*;

declare_id!("GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi");

/// Arguments to `init_protocol`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitProtocolArgs {
    pub admin: Pubkey,
    pub allowlist_manager: Pubkey,
    pub fee_collector: Pubkey,
    /// Cluster tag (SPEC §1.3): mainnet-beta 101, testnet 102, devnet 103, localnet 104.
    pub chain_id: u64,
    pub defaults: ParametersData,
    /// The `merces_protocol` program id whose `[REGISTRY_AUTHORITY]` PDA may call the write
    /// interface. Fixed for the life of the deployment (no setter).
    pub protocol_program: Pubkey,
}

/// Arguments to `create_series`. Fees, FX bounds and pause bounds are copied from
/// `ProtocolConfig.defaults`; everything here is issuer-chosen within the §1.6 bounds.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateSeriesArgs {
    pub units_offered: u64,
    pub reserve_price: u64,
    pub min_raise: u64,
    pub cap_multiple_wad: u64,
    pub hurdle_rate_wad: u64,
    pub payout_multiple_k: u16,
    pub lockup_seconds: u64,
    pub wallet_cap_bps: u16,
    pub commit_duration: u64,
    pub reveal_duration: u64,
    pub window_commit_duration: u64,
    pub window_reveal_duration: u64,
    pub release_schedule: Vec<TrancheData>,
    pub terms_commitment: [u8; 32],
    pub tier_flags: u8,
    pub fx_pair_id: [u8; 32],
    pub mode: u8,
    pub issuer_accepts_public_price: bool,
    pub metadata_uri: String,
    /// Required when bit0 (tier 1 split) is set; must hash to `terms_commitment`.
    pub tier1_terms: Option<Tier1Terms>,
}

fn map_fee_error(e: FeeCheckError) -> Error {
    match e {
        FeeCheckError::InvalidMint => error!(RegistryError::InvalidStablecoinMint),
        FeeCheckError::TransferFeeNotZero => error!(RegistryError::TransferFeeNotZero),
    }
}

fn map_sig_error(e: SigError) -> Error {
    match e {
        SigError::Malformed => error!(RegistryError::MalformedSignature),
        SigError::RecoveryFailed => error!(RegistryError::SignatureRecoveryFailed),
    }
}

fn now_u64() -> Result<u64> {
    u64::try_from(Clock::get()?.unix_timestamp).map_err(|_| error!(RegistryError::MathOverflow))
}

#[program]
pub mod merces_registry {
    use super::*;

    /// Creates `ProtocolConfig` once (SPEC §3.2).
    pub fn init_protocol(ctx: Context<InitProtocol>, args: InitProtocolArgs) -> Result<()> {
        require_keys_neq!(args.admin, Pubkey::default(), RegistryError::ZeroAddress);
        require_keys_neq!(
            args.allowlist_manager,
            Pubkey::default(),
            RegistryError::ZeroAddress
        );
        require_keys_neq!(
            args.fee_collector,
            Pubkey::default(),
            RegistryError::ZeroAddress
        );
        require_keys_neq!(
            args.protocol_program,
            Pubkey::default(),
            RegistryError::ZeroAddress
        );
        require!(args.chain_id != 0, RegistryError::InvalidChainId);
        let params: Parameters = args.defaults.into();
        if let Some(f) = params.first_violation() {
            return Err(RegistryError::from(f).into());
        }
        let (protocol_authority, _) =
            Pubkey::find_program_address(&[REGISTRY_AUTHORITY], &args.protocol_program);
        let domain =
            keccak(&[
                domain_preimage(CHAIN_KIND_SOLANA, args.chain_id, &crate::ID.to_bytes()).as_bytes(),
            ]);
        let cfg = &mut ctx.accounts.config;
        cfg.admin = args.admin;
        cfg.pending_admin = Pubkey::default();
        cfg.allowlist_manager = args.allowlist_manager;
        cfg.fee_collector = args.fee_collector;
        cfg.domain = domain;
        cfg.chain_id = args.chain_id;
        cfg.new_raises_paused = false;
        cfg.windows_enabled = false;
        cfg.tier4_enabled = false;
        cfg.early_draw_approver = Pubkey::default();
        cfg.defaults = args.defaults;
        cfg.protocol_program = args.protocol_program;
        cfg.protocol_authority = protocol_authority;
        cfg.series_count = 0;
        cfg.attestor_count = 0;
        cfg.verifier_count = 0;
        cfg.bump = ctx.bumps.config;
        emit!(ProtocolInitialized {
            admin: args.admin,
            allowlist_manager: args.allowlist_manager,
            fee_collector: args.fee_collector,
            chain_id: args.chain_id,
            domain,
            protocol_program: args.protocol_program,
            protocol_authority,
        });
        Ok(())
    }

    // ---------------------------------------------------------------- admin

    pub fn set_allowlist_manager(ctx: Context<AdminOnly>, new_manager: Pubkey) -> Result<()> {
        require_keys_neq!(new_manager, Pubkey::default(), RegistryError::ZeroAddress);
        ctx.accounts.config.allowlist_manager = new_manager;
        emit!(AllowlistManagerSet {
            allowlist_manager: new_manager
        });
        Ok(())
    }

    pub fn set_fee_collector(ctx: Context<AdminOnly>, new_collector: Pubkey) -> Result<()> {
        require_keys_neq!(new_collector, Pubkey::default(), RegistryError::ZeroAddress);
        ctx.accounts.config.fee_collector = new_collector;
        emit!(FeeCollectorSet {
            fee_collector: new_collector
        });
        Ok(())
    }

    pub fn set_flags(
        ctx: Context<AdminOnly>,
        new_raises_paused: bool,
        windows_enabled: bool,
        tier4_enabled: bool,
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.new_raises_paused = new_raises_paused;
        cfg.windows_enabled = windows_enabled;
        cfg.tier4_enabled = tier4_enabled;
        emit!(FlagsSet {
            new_raises_paused,
            windows_enabled,
            tier4_enabled
        });
        Ok(())
    }

    /// `Pubkey::default()` unsets the approver (early draws off).
    pub fn set_early_draw_approver(ctx: Context<AdminOnly>, approver: Pubkey) -> Result<()> {
        ctx.accounts.config.early_draw_approver = approver;
        emit!(EarlyDrawApproverSet { approver });
        Ok(())
    }

    /// Edits the defaults for *future* series only (bounds-checked).
    pub fn set_defaults(ctx: Context<AdminOnly>, defaults: ParametersData) -> Result<()> {
        let params: Parameters = defaults.into();
        if let Some(f) = params.first_violation() {
            return Err(RegistryError::from(f).into());
        }
        ctx.accounts.config.defaults = defaults;
        emit!(DefaultsSet { defaults });
        Ok(())
    }

    /// Registers (or re-activates) an attestor key.
    pub fn register_attestor(ctx: Context<RegisterAttestor>, addr: [u8; 20]) -> Result<()> {
        require!(addr != [0u8; 20], RegistryError::ZeroAttestorAddress);
        let k = &mut ctx.accounts.attestor;
        if !k.active {
            ctx.accounts.config.attestor_count = ctx
                .accounts
                .config
                .attestor_count
                .checked_add(1)
                .ok_or(RegistryError::MathOverflow)?;
        }
        k.addr = addr;
        k.active = true;
        k.revoked_at = 0;
        k.bump = ctx.bumps.attestor;
        emit!(AttestorRegistered { addr });
        Ok(())
    }

    /// Forward-only revocation (SPEC §1.4): records `revoked_at`; refused for the last active key.
    pub fn revoke_attestor(ctx: Context<RevokeAttestor>, addr: [u8; 20]) -> Result<()> {
        let k = &mut ctx.accounts.attestor;
        require!(k.active, RegistryError::KeyAlreadyRevoked);
        require!(
            ctx.accounts.config.attestor_count >= 2,
            RegistryError::LastKeyOfKind
        );
        let now = now_u64()?;
        k.active = false;
        k.revoked_at = now;
        ctx.accounts.config.attestor_count = ctx
            .accounts
            .config
            .attestor_count
            .checked_sub(1)
            .ok_or(RegistryError::MathOverflow)?;
        emit!(AttestorRevoked {
            addr,
            revoked_at: now
        });
        Ok(())
    }

    pub fn register_verifier_key(ctx: Context<RegisterVerifierKey>, addr: [u8; 20]) -> Result<()> {
        require!(addr != [0u8; 20], RegistryError::ZeroAttestorAddress);
        let k = &mut ctx.accounts.verifier;
        if !k.active {
            ctx.accounts.config.verifier_count = ctx
                .accounts
                .config
                .verifier_count
                .checked_add(1)
                .ok_or(RegistryError::MathOverflow)?;
        }
        k.addr = addr;
        k.active = true;
        k.revoked_at = 0;
        k.bump = ctx.bumps.verifier;
        emit!(VerifierKeyRegistered { addr });
        Ok(())
    }

    pub fn revoke_verifier_key(ctx: Context<RevokeVerifierKey>, addr: [u8; 20]) -> Result<()> {
        let k = &mut ctx.accounts.verifier;
        require!(k.active, RegistryError::KeyAlreadyRevoked);
        require!(
            ctx.accounts.config.verifier_count >= 2,
            RegistryError::LastKeyOfKind
        );
        let now = now_u64()?;
        k.active = false;
        k.revoked_at = now;
        ctx.accounts.config.verifier_count = ctx
            .accounts
            .config
            .verifier_count
            .checked_sub(1)
            .ok_or(RegistryError::MathOverflow)?;
        emit!(VerifierKeyRevoked {
            addr,
            revoked_at: now
        });
        Ok(())
    }

    /// FX pair configuration (SPEC §3.1): `pair_id = keccak256(feed_id ‖ inverted)`; `feed_id` and
    /// `inverted` are write-once; `crosscheck` may be set from zero once (effective now), later
    /// changes apply from the next period; `enabled` only gates new series.
    /// Registers an FX pair, write-once: `pair_id = keccak256(feed_id ‖ inverted)` commits to the
    /// feed and its direction, and a pair can never be re-registered (SPEC §3.1). The cross-check
    /// feed is recorded with its effective period; on Solana it stays unset in this version (A21).
    pub fn set_fx_pair(
        ctx: Context<SetFxPair>,
        pair_id: [u8; 32],
        feed_id: [u8; 32],
        inverted: bool,
        crosscheck: Pubkey,
        enabled: bool,
    ) -> Result<()> {
        require!(feed_id != [0u8; 32], RegistryError::ZeroAddress);
        let expected = keccak(&[fx_pair_id_preimage(&feed_id, inverted).as_bytes()]);
        require!(pair_id == expected, RegistryError::FxPairIdMismatch);
        let now = now_u64()?;
        let current_period = period_of(now).map_err(|_| RegistryError::MathOverflow)?;
        let p = &mut ctx.accounts.fx_pair;
        require!(p.pair_id == [0u8; 32], RegistryError::FxPairImmutable);
        p.pair_id = pair_id;
        p.feed_id = feed_id;
        p.inverted = inverted;
        p.crosscheck = crosscheck;
        p.crosscheck_effective_period = if crosscheck == Pubkey::default() {
            0
        } else {
            current_period
        };
        p.enabled = enabled;
        p.bump = ctx.bumps.fx_pair;
        emit!(FxPairSet {
            pair_id,
            feed_id,
            inverted,
            crosscheck: p.crosscheck,
            crosscheck_effective_period: p.crosscheck_effective_period,
            enabled,
        });
        Ok(())
    }

    /// Enables or disables an existing pair (`enabled = false` only stops new series from
    /// referencing it; live series keep their pair, SPEC §3.1).
    pub fn set_fx_pair_enabled(ctx: Context<SetFxPairEnabled>, enabled: bool) -> Result<()> {
        let p = &mut ctx.accounts.fx_pair;
        p.enabled = enabled;
        emit!(FxPairSet {
            pair_id: p.pair_id,
            feed_id: p.feed_id,
            inverted: p.inverted,
            crosscheck: p.crosscheck,
            crosscheck_effective_period: p.crosscheck_effective_period,
            enabled,
        });
        Ok(())
    }

    pub fn register_issuer(ctx: Context<RegisterIssuer>, wallet: Pubkey) -> Result<()> {
        require_keys_neq!(wallet, Pubkey::default(), RegistryError::ZeroAddress);
        let i = &mut ctx.accounts.issuer;
        i.wallet = wallet;
        i.active = true;
        i.bump = ctx.bumps.issuer;
        emit!(IssuerRegistered { wallet });
        Ok(())
    }

    /// Blocks *new* series only; existing series are untouched (SPEC §3.2).
    pub fn deactivate_issuer(ctx: Context<DeactivateIssuer>, wallet: Pubkey) -> Result<()> {
        ctx.accounts.issuer.active = false;
        emit!(IssuerDeactivated { wallet });
        Ok(())
    }

    pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        require_keys_neq!(new_admin, Pubkey::default(), RegistryError::ZeroAddress);
        ctx.accounts.config.pending_admin = new_admin;
        emit!(AdminTransferStarted {
            admin: ctx.accounts.config.admin,
            pending_admin: new_admin
        });
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        let old = cfg.admin;
        cfg.admin = cfg.pending_admin;
        cfg.pending_admin = Pubkey::default();
        emit!(AdminTransferred {
            old_admin: old,
            new_admin: cfg.admin
        });
        Ok(())
    }

    // ---------------------------------------------------------------- allowlist manager

    pub fn set_allowed(ctx: Context<SetAllowed>, wallet: Pubkey, allowed: bool) -> Result<()> {
        require_keys_neq!(wallet, Pubkey::default(), RegistryError::ZeroAddress);
        let e = &mut ctx.accounts.entry;
        e.wallet = wallet;
        e.allowed = allowed;
        e.updated_at = Clock::get()?.unix_timestamp;
        e.bump = ctx.bumps.entry;
        emit!(AllowlistUpdated { wallet, allowed });
        Ok(())
    }

    // ---------------------------------------------------------------- issuer

    pub fn create_series(ctx: Context<CreateSeries>, args: CreateSeriesArgs) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let issuer = &ctx.accounts.issuer;
        require!(issuer.active, RegistryError::IssuerInactive);
        require!(!issuer.issuance_stopped, RegistryError::IssuanceStopped);
        require!(
            ctx.accounts.allowlist_entry.allowed,
            RegistryError::NotAllowlisted
        );
        require!(args.units_offered >= 1, RegistryError::UnitsOfferedZero);
        require!(args.reserve_price >= 1, RegistryError::ReservePriceZero);
        let max_raise = args
            .reserve_price
            .checked_mul(args.units_offered)
            .ok_or(RegistryError::MathOverflow)?;
        require!(args.min_raise <= max_raise, RegistryError::MinRaiseTooHigh);
        require!(
            args.tier_flags != 0 && args.tier_flags & !TIER_FLAGS_MASK == 0,
            RegistryError::InvalidTierFlags
        );
        require!(
            args.mode == MODE_SEALED_BID || args.mode == MODE_CURVE,
            RegistryError::InvalidMode
        );
        if args.mode == MODE_CURVE {
            require!(
                args.issuer_accepts_public_price,
                RegistryError::PublicPriceNotAccepted
            );
        }
        require!(
            args.metadata_uri.len() <= MAX_METADATA_URI,
            RegistryError::MetadataUriTooLong
        );
        let schedule: Vec<Tranche> = args
            .release_schedule
            .iter()
            .map(|t| Tranche::from(*t))
            .collect();
        validate_schedule(&schedule).map_err(|_| RegistryError::InvalidReleaseSchedule)?;

        // Bounds: issuer-chosen values plus the protocol defaults, checked as one parameter set.
        let d: Parameters = cfg.defaults.into();
        let params = Parameters {
            cap_multiple_wad: args.cap_multiple_wad,
            hurdle_rate_wad: args.hurdle_rate_wad,
            payout_multiple_k: args.payout_multiple_k,
            lockup_seconds: args.lockup_seconds,
            wallet_cap_bps: args.wallet_cap_bps,
            auction_fee_bps: d.auction_fee_bps,
            payout_fee_bps: d.payout_fee_bps,
            window_fee_bps: d.window_fee_bps,
            non_reveal_charge_bps: d.non_reveal_charge_bps,
            commit_duration: args.commit_duration,
            reveal_duration: args.reveal_duration,
            window_commit_duration: args.window_commit_duration,
            window_reveal_duration: args.window_reveal_duration,
            fx_min_coverage_bps: d.fx_min_coverage_bps,
            fx_max_staleness_seconds: d.fx_max_staleness_seconds,
            fx_max_conf_bps: d.fx_max_conf_bps,
            fx_deviation_band_bps: d.fx_deviation_band_bps,
            max_pause_seconds: d.max_pause_seconds,
            max_cumulative_pause_seconds: d.max_cumulative_pause_seconds,
        };
        if let Some(f) = params.first_violation() {
            return Err(RegistryError::from(f).into());
        }
        // SPEC §1.6: at least one unit of wallet cap, so a bid can be valid.
        require!(
            wallet_cap_allows_a_bid(args.units_offered, args.wallet_cap_bps)
                .map_err(|_| RegistryError::MathOverflow)?,
            RegistryError::WalletCapTooSmall
        );

        // FX pair: zero means stablecoin income (fx = 1); otherwise the pair must exist and be enabled.
        if args.fx_pair_id != [0u8; 32] {
            let pair = ctx
                .accounts
                .fx_pair
                .as_ref()
                .ok_or(RegistryError::FxPairMismatch)?;
            require!(
                pair.pair_id == args.fx_pair_id && pair.enabled,
                RegistryError::FxPairMismatch
            );
        }

        // Tier-1 router terms (SPEC §6.5): plaintext θ / r, Poseidon(5)-bound to the commitment.
        let (router_theta, router_r_wad) = if args.tier_flags & TIER_FLAG_SPLIT != 0 {
            let t = args.tier1_terms.ok_or(RegistryError::Tier1TermsRequired)?;
            require!(
                args.fx_pair_id == [0u8; 32],
                RegistryError::Tier1NeedsStablecoinIncome
            );
            let share = u128::from(t.r_wad)
                .checked_mul(u128::from(args.units_offered))
                .ok_or(RegistryError::MathOverflow)?;
            require!(share <= WAD, RegistryError::Tier1ShareTooLarge);
            let h = poseidon5(&[
                u64_field(t.theta),
                u64_field(t.r_wad),
                u64_field(u64::from(t.currency_code)),
                u64_field(u64::from(t.indexing_rule)),
                t.terms_salt,
            ])
            .map_err(|_| RegistryError::PoseidonFailed)?;
            require!(
                h == args.terms_commitment,
                RegistryError::Tier1TermsMismatch
            );
            (t.theta, t.r_wad)
        } else {
            require!(
                args.tier1_terms.is_none(),
                RegistryError::Tier1TermsUnexpected
            );
            (0, 0)
        };

        // Stablecoin: decimals and owner program are read from the mint; zero transfer fee required.
        let mint_info = ctx.accounts.stablecoin_mint.to_account_info();
        assert_zero_transfer_fee(&mint_info).map_err(map_fee_error)?;

        let series_id = cfg.series_count;
        let s = &mut ctx.accounts.series;
        s.series_id = series_id;
        s.issuer = ctx.accounts.issuer_wallet.key();
        s.mode = args.mode;
        s.stablecoin = ctx.accounts.stablecoin_mint.key();
        s.stablecoin_decimals = ctx.accounts.stablecoin_mint.decimals;
        s.stablecoin_program = *mint_info.owner;
        s.unit_mint = Pubkey::default();
        s.units_offered = args.units_offered;
        s.reserve_price = args.reserve_price;
        s.min_raise = args.min_raise;
        s.cap_multiple_wad = args.cap_multiple_wad;
        s.hurdle_rate_wad = args.hurdle_rate_wad;
        s.payout_multiple_k = args.payout_multiple_k;
        s.lockup_seconds = args.lockup_seconds;
        s.wallet_cap_bps = args.wallet_cap_bps;
        s.auction_fee_bps = d.auction_fee_bps;
        s.payout_fee_bps = d.payout_fee_bps;
        s.window_fee_bps = d.window_fee_bps;
        s.non_reveal_charge_bps = d.non_reveal_charge_bps;
        s.commit_duration = args.commit_duration;
        s.reveal_duration = args.reveal_duration;
        s.window_commit_duration = args.window_commit_duration;
        s.window_reveal_duration = args.window_reveal_duration;
        s.fx_min_coverage_bps = d.fx_min_coverage_bps;
        s.max_pause_seconds = d.max_pause_seconds;
        s.max_cumulative_pause_seconds = d.max_cumulative_pause_seconds;
        s.release_schedule = args.release_schedule.clone();
        s.contract_hash = [0u8; 32];
        s.tier_flags = args.tier_flags;
        s.fx_pair_id = args.fx_pair_id;
        s.issuer_accepts_public_price = args.issuer_accepts_public_price;
        s.metadata_uri = args.metadata_uri.clone();
        s.router_theta = router_theta;
        s.router_r_wad = router_r_wad;
        s.terms_commitment = args.terms_commitment;
        s.amendment_nonce = 0;
        s.raise_state = RAISE_DRAFT;
        s.opened_at = 0;
        s.settlement_ts = 0;
        s.units_sold = 0;
        s.clearing_price = 0;
        s.mint_finalized = false;
        s.terminal_status = TERMINAL_NONE;
        s.auction_escrow_ata = Pubkey::default();
        s.window_escrow_ata = Pubkey::default();
        s.dbc_config = Pubkey::default();
        s.dbc_pool = Pubkey::default();
        s.base_mint = Pubkey::default();
        s.bump = ctx.bumps.series;

        let cfg = &mut ctx.accounts.config;
        cfg.series_count = cfg
            .series_count
            .checked_add(1)
            .ok_or(RegistryError::MathOverflow)?;
        let issuer = &mut ctx.accounts.issuer;
        issuer.series_count = issuer
            .series_count
            .checked_add(1)
            .ok_or(RegistryError::MathOverflow)?;

        emit!(SeriesCreated {
            series: s.key(),
            series_id,
            issuer: s.issuer,
            mode: s.mode,
            stablecoin: s.stablecoin,
            units_offered: s.units_offered,
            reserve_price: s.reserve_price,
            min_raise: s.min_raise,
            cap_multiple_wad: s.cap_multiple_wad,
            hurdle_rate_wad: s.hurdle_rate_wad,
            k: s.payout_multiple_k,
            lockup_seconds: s.lockup_seconds,
            wallet_cap_bps: s.wallet_cap_bps,
            auction_fee_bps: s.auction_fee_bps,
            payout_fee_bps: s.payout_fee_bps,
            window_fee_bps: s.window_fee_bps,
            non_reveal_charge_bps: s.non_reveal_charge_bps,
            terms_commitment: s.terms_commitment,
            tier_flags: s.tier_flags,
            fx_pair_id: s.fx_pair_id,
        });
        Ok(())
    }

    /// Draft only, non-zero (SPEC §3.2).
    pub fn set_contract_hash(ctx: Context<IssuerSeries>, hash: [u8; 32]) -> Result<()> {
        let s = &mut ctx.accounts.series;
        require!(s.raise_state == RAISE_DRAFT, RegistryError::NotDraft);
        require!(hash != [0u8; 32], RegistryError::ZeroContractHash);
        s.contract_hash = hash;
        emit!(ContractHashSet {
            series: s.key(),
            hash
        });
        Ok(())
    }

    pub fn stop_issuance(ctx: Context<IssuerSelf>) -> Result<()> {
        ctx.accounts.issuer.issuance_stopped = true;
        emit!(IssuanceStopped {
            wallet: ctx.accounts.issuer_wallet.key()
        });
        Ok(())
    }

    pub fn resume_issuance(ctx: Context<IssuerSelf>) -> Result<()> {
        ctx.accounts.issuer.issuance_stopped = false;
        emit!(IssuanceResumed {
            wallet: ctx.accounts.issuer_wallet.key()
        });
        Ok(())
    }

    /// Issuer-favourable amendment (SPEC §3.2, brief C4): the issuer signs the transaction and an
    /// active attestor signs the `MERCES_AMEND_V1` message with the current nonce. The cap
    /// multiple may only decrease. Allowed only while `terminal_status == 0`.
    pub fn amend_terms(
        ctx: Context<AmendTerms>,
        new_terms_commitment: [u8; 32],
        new_cap_multiple_wad: u64,
        attestor_addr: [u8; 20],
        attestor_sig: [u8; 65],
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let s = &mut ctx.accounts.series;
        require!(!s.is_terminal(), RegistryError::SeriesTerminal);
        require!(
            ctx.accounts.attestor.active,
            RegistryError::AttestorInactive
        );
        require!(
            new_cap_multiple_wad <= s.cap_multiple_wad,
            RegistryError::CapMultipleIncrease
        );
        require!(
            (2_000_000_000_000_000_000..=3_000_000_000_000_000_000).contains(&new_cap_multiple_wad),
            RegistryError::BoundCapMultiple
        );
        let series_key = s.key().to_bytes();
        let msg = keccak(&[amend_message(
            &cfg.domain,
            &series_key,
            s.amendment_nonce,
            &new_terms_commitment,
            new_cap_multiple_wad,
        )
        .as_bytes()]);
        let recovered = recover_eth_address(&msg, &attestor_sig).map_err(map_sig_error)?;
        require!(recovered == attestor_addr, RegistryError::AttestorMismatch);
        let nonce = s.amendment_nonce;
        s.terms_commitment = new_terms_commitment;
        s.cap_multiple_wad = new_cap_multiple_wad;
        s.amendment_nonce = nonce.checked_add(1).ok_or(RegistryError::MathOverflow)?;
        emit!(TermsAmended {
            series: s.key(),
            nonce,
            new_terms_commitment,
            new_cap_multiple_wad,
            attestor: attestor_addr,
        });
        Ok(())
    }

    // ---------------------------------------------------------------- protocol write interface

    /// Draft → Open. Also enforces the D1 gate: contract hash set, issuer allowlisted, raises not
    /// paused. Records the unit mint and the protocol's unit escrow ATAs for the hook.
    pub fn mark_raise_opened(
        ctx: Context<MarkRaiseOpened>,
        unit_mint: Pubkey,
        opened_at: u64,
        auction_escrow_ata: Pubkey,
        window_escrow_ata: Pubkey,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let s = &mut ctx.accounts.series;
        require!(s.raise_state == RAISE_DRAFT, RegistryError::NotDraft);
        require!(s.mode == MODE_SEALED_BID, RegistryError::NotSealedBid);
        require!(
            s.contract_hash != [0u8; 32],
            RegistryError::ContractHashNotSet
        );
        require!(!cfg.new_raises_paused, RegistryError::NewRaisesPaused);
        require!(
            ctx.accounts.issuer_allowlist.allowed,
            RegistryError::NotAllowlisted
        );
        require_keys_neq!(unit_mint, Pubkey::default(), RegistryError::ZeroAddress);
        require_keys_neq!(
            auction_escrow_ata,
            Pubkey::default(),
            RegistryError::ZeroAddress
        );
        require_keys_neq!(
            window_escrow_ata,
            Pubkey::default(),
            RegistryError::ZeroAddress
        );
        s.unit_mint = unit_mint;
        s.opened_at = opened_at;
        s.auction_escrow_ata = auction_escrow_ata;
        s.window_escrow_ata = window_escrow_ata;
        s.raise_state = RAISE_OPEN;
        emit!(RaiseStateChanged {
            series: s.key(),
            state: RAISE_OPEN
        });
        Ok(())
    }

    /// Records the raise outcome, exact and written once (SPEC §3.2).
    pub fn mark_raise_result(
        ctx: Context<MarkRaiseResult>,
        state: u8,
        settlement_ts: u64,
        units_sold: u64,
        clearing_price: u64,
    ) -> Result<()> {
        let s = &mut ctx.accounts.series;
        match state {
            RAISE_CANCELLED => {
                require!(
                    s.raise_state == RAISE_OPEN,
                    RegistryError::InvalidRaiseTransition
                );
                s.raise_state = RAISE_CANCELLED;
            }
            RAISE_FAILED => {
                require!(
                    s.raise_state == RAISE_OPEN || s.raise_state == RAISE_SETTLING,
                    RegistryError::InvalidRaiseTransition
                );
                s.raise_state = RAISE_FAILED;
                s.settlement_ts = settlement_ts;
                s.clearing_price = clearing_price;
                s.units_sold = 0;
            }
            RAISE_SETTLED => {
                require!(
                    s.raise_state == RAISE_OPEN || s.raise_state == RAISE_SETTLING,
                    RegistryError::InvalidRaiseTransition
                );
                require!(
                    units_sold >= 1 && clearing_price >= 1,
                    RegistryError::InvalidRaiseTransition
                );
                s.raise_state = RAISE_SETTLED;
                s.settlement_ts = settlement_ts;
                s.units_sold = units_sold;
                s.clearing_price = clearing_price;
            }
            _ => return Err(RegistryError::InvalidRaiseTransition.into()),
        }
        emit!(RaiseStateChanged {
            series: s.key(),
            state: s.raise_state
        });
        Ok(())
    }

    /// Settled → mint finalised (every bid processed, mint authority revoked).
    pub fn mark_mint_finalized(ctx: Context<MarkRaiseResult>) -> Result<()> {
        let s = &mut ctx.accounts.series;
        require!(
            s.raise_state == RAISE_SETTLED,
            RegistryError::InvalidRaiseTransition
        );
        require!(!s.mint_finalized, RegistryError::MintAlreadyFinalized);
        s.mint_finalized = true;
        emit!(MintFinalized { series: s.key() });
        Ok(())
    }

    /// Terminal status mirror: Retired / Redeemed / Extinguished. Extinguished may follow Retired
    /// or Redeemed (SPEC §6.9: allowed in every status but Extinguished).
    pub fn mark_terminal(ctx: Context<MarkRaiseResult>, status: u8) -> Result<()> {
        let s = &mut ctx.accounts.series;
        require!(
            matches!(
                status,
                TERMINAL_RETIRED | TERMINAL_REDEEMED | TERMINAL_EXTINGUISHED
            ),
            RegistryError::InvalidTerminalStatus
        );
        match s.terminal_status {
            TERMINAL_NONE => {}
            TERMINAL_RETIRED | TERMINAL_REDEEMED => {
                require!(
                    status == TERMINAL_EXTINGUISHED,
                    RegistryError::InvalidTerminalTransition
                )
            }
            _ => return Err(RegistryError::InvalidTerminalTransition.into()),
        }
        s.terminal_status = status;
        emit!(TerminalStatusSet {
            series: s.key(),
            status
        });
        Ok(())
    }

    /// Curve-mode activation (SPEC §9; the Meteora integration is a later track). Records the DBC
    /// accounts and fixes `P0` and `units_sold` for cap accounting. Draft → Settled, mint finalised.
    pub fn mark_curve_activated(
        ctx: Context<MarkCurveActivated>,
        dbc_config: Pubkey,
        dbc_pool: Pubkey,
        base_mint: Pubkey,
        activated_at: u64,
        units_sold: u64,
        clearing_price: u64,
    ) -> Result<()> {
        let s = &mut ctx.accounts.series;
        require!(s.mode == MODE_CURVE, RegistryError::NotCurveMode);
        require!(s.raise_state == RAISE_DRAFT, RegistryError::NotDraft);
        require!(
            s.contract_hash != [0u8; 32],
            RegistryError::ContractHashNotSet
        );
        require!(
            !ctx.accounts.config.new_raises_paused,
            RegistryError::NewRaisesPaused
        );
        require!(
            ctx.accounts.issuer_allowlist.allowed,
            RegistryError::NotAllowlisted
        );
        require!(
            units_sold >= 1 && clearing_price >= 1,
            RegistryError::InvalidRaiseTransition
        );
        require_keys_neq!(base_mint, Pubkey::default(), RegistryError::ZeroAddress);
        s.dbc_config = dbc_config;
        s.dbc_pool = dbc_pool;
        s.base_mint = base_mint;
        s.unit_mint = base_mint;
        s.opened_at = activated_at;
        s.settlement_ts = activated_at;
        s.units_sold = units_sold;
        s.clearing_price = clearing_price;
        s.mint_finalized = true;
        s.raise_state = RAISE_SETTLED;
        emit!(CurveActivated {
            series: s.key(),
            dbc_config,
            dbc_pool,
            base_mint,
            units_sold,
            clearing_price,
        });
        emit!(RaiseStateChanged {
            series: s.key(),
            state: RAISE_SETTLED
        });
        Ok(())
    }
}

// ======================================================================== accounts

#[derive(Accounts)]
pub struct InitProtocol<'info> {
    #[account(init, payer = payer, space = 8 + ProtocolConfig::INIT_SPACE, seeds = [CONFIG], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [CONFIG], bump = config.bump, has_one = admin @ RegistryError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [CONFIG], bump = config.bump, constraint = config.pending_admin == pending_admin.key() @ RegistryError::NotPendingAdmin)]
    pub config: Account<'info, ProtocolConfig>,
    pub pending_admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(addr: [u8; 20])]
pub struct RegisterAttestor<'info> {
    #[account(mut, seeds = [CONFIG], bump = config.bump, has_one = admin @ RegistryError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init_if_needed, payer = admin, space = 8 + AttestorKey::INIT_SPACE, seeds = [ATTESTOR, addr.as_ref()], bump)]
    pub attestor: Account<'info, AttestorKey>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(addr: [u8; 20])]
pub struct RevokeAttestor<'info> {
    #[account(mut, seeds = [CONFIG], bump = config.bump, has_one = admin @ RegistryError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [ATTESTOR, addr.as_ref()], bump = attestor.bump)]
    pub attestor: Account<'info, AttestorKey>,
}

#[derive(Accounts)]
#[instruction(addr: [u8; 20])]
pub struct RegisterVerifierKey<'info> {
    #[account(mut, seeds = [CONFIG], bump = config.bump, has_one = admin @ RegistryError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init_if_needed, payer = admin, space = 8 + VerifierKey::INIT_SPACE, seeds = [VERIFIER, addr.as_ref()], bump)]
    pub verifier: Account<'info, VerifierKey>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(addr: [u8; 20])]
pub struct RevokeVerifierKey<'info> {
    #[account(mut, seeds = [CONFIG], bump = config.bump, has_one = admin @ RegistryError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [VERIFIER, addr.as_ref()], bump = verifier.bump)]
    pub verifier: Account<'info, VerifierKey>,
}

#[derive(Accounts)]
#[instruction(pair_id: [u8; 32])]
pub struct SetFxPair<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, has_one = admin @ RegistryError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init_if_needed, payer = admin, space = 8 + FxPairConfig::INIT_SPACE, seeds = [FX, pair_id.as_ref()], bump)]
    pub fx_pair: Account<'info, FxPairConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetFxPairEnabled<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, has_one = admin @ RegistryError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [FX, fx_pair.pair_id.as_ref()], bump = fx_pair.bump)]
    pub fx_pair: Account<'info, FxPairConfig>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RegisterIssuer<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, has_one = admin @ RegistryError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init_if_needed, payer = admin, space = 8 + Issuer::INIT_SPACE, seeds = [ISSUER, wallet.as_ref()], bump)]
    pub issuer: Account<'info, Issuer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct DeactivateIssuer<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, has_one = admin @ RegistryError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [ISSUER, wallet.as_ref()], bump = issuer.bump)]
    pub issuer: Account<'info, Issuer>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct SetAllowed<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, has_one = allowlist_manager @ RegistryError::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub allowlist_manager: Signer<'info>,
    #[account(init_if_needed, payer = allowlist_manager, space = 8 + AllowlistEntry::INIT_SPACE, seeds = [ALLOW, wallet.as_ref()], bump)]
    pub entry: Account<'info, AllowlistEntry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateSeries<'info> {
    #[account(mut, seeds = [CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub issuer_wallet: Signer<'info>,
    #[account(mut, seeds = [ISSUER, issuer_wallet.key().as_ref()], bump = issuer.bump)]
    pub issuer: Box<Account<'info, Issuer>>,
    #[account(seeds = [ALLOW, issuer_wallet.key().as_ref()], bump = allowlist_entry.bump)]
    pub allowlist_entry: Box<Account<'info, AllowlistEntry>>,
    /// The settlement stablecoin (SPL Token or Token-2022); decimals and owner are read from it.
    pub stablecoin_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Required when `fx_pair_id != 0`.
    pub fx_pair: Option<Box<Account<'info, FxPairConfig>>>,
    #[account(
        init,
        payer = issuer_wallet,
        space = 8 + Series::INIT_SPACE,
        seeds = [SERIES, config.series_count.to_le_bytes().as_ref()],
        bump
    )]
    pub series: Box<Account<'info, Series>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct IssuerSeries<'info> {
    pub issuer_wallet: Signer<'info>,
    #[account(mut, seeds = [SERIES, series.series_id.to_le_bytes().as_ref()], bump = series.bump, constraint = series.issuer == issuer_wallet.key() @ RegistryError::Unauthorized)]
    pub series: Box<Account<'info, Series>>,
}

#[derive(Accounts)]
pub struct IssuerSelf<'info> {
    pub issuer_wallet: Signer<'info>,
    #[account(mut, seeds = [ISSUER, issuer_wallet.key().as_ref()], bump = issuer.bump)]
    pub issuer: Account<'info, Issuer>,
}

#[derive(Accounts)]
#[instruction(new_terms_commitment: [u8; 32], new_cap_multiple_wad: u64, attestor_addr: [u8; 20])]
pub struct AmendTerms<'info> {
    #[account(seeds = [CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub issuer_wallet: Signer<'info>,
    #[account(mut, seeds = [SERIES, series.series_id.to_le_bytes().as_ref()], bump = series.bump, constraint = series.issuer == issuer_wallet.key() @ RegistryError::Unauthorized)]
    pub series: Box<Account<'info, Series>>,
    #[account(seeds = [ATTESTOR, attestor_addr.as_ref()], bump = attestor.bump)]
    pub attestor: Account<'info, AttestorKey>,
}

#[derive(Accounts)]
pub struct MarkRaiseOpened<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, constraint = config.protocol_authority == protocol_authority.key() @ RegistryError::NotProtocolAuthority)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub protocol_authority: Signer<'info>,
    #[account(mut, seeds = [SERIES, series.series_id.to_le_bytes().as_ref()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(seeds = [ALLOW, series.issuer.as_ref()], bump = issuer_allowlist.bump)]
    pub issuer_allowlist: Account<'info, AllowlistEntry>,
}

#[derive(Accounts)]
pub struct MarkRaiseResult<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, constraint = config.protocol_authority == protocol_authority.key() @ RegistryError::NotProtocolAuthority)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub protocol_authority: Signer<'info>,
    #[account(mut, seeds = [SERIES, series.series_id.to_le_bytes().as_ref()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
}

#[derive(Accounts)]
pub struct MarkCurveActivated<'info> {
    #[account(seeds = [CONFIG], bump = config.bump, constraint = config.protocol_authority == protocol_authority.key() @ RegistryError::NotProtocolAuthority)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    pub protocol_authority: Signer<'info>,
    #[account(mut, seeds = [SERIES, series.series_id.to_le_bytes().as_ref()], bump = series.bump)]
    pub series: Box<Account<'info, Series>>,
    #[account(seeds = [ALLOW, series.issuer.as_ref()], bump = issuer_allowlist.bump)]
    pub issuer_allowlist: Account<'info, AllowlistEntry>,
}
