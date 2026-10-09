//! Curve-mode harness (SPEC §9): the real Meteora DBC program (the SDK's `local`-feature build,
//! vendored in `tests/fixtures/meteora` with its MIT licence) loaded into LiteSVM, DBC instruction
//! builders (`create_config` from the generator fixture, `initialize_virtual_pool_with_token2022`,
//! `swap2`), the Merces curve instructions, and byte-exact account writers for the post-migration
//! DAMM v2 / locker state that LiteSVM tests do not drive through those programs.

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AnchorSerialize, InstructionData, ToAccountMetas};
use merces_protocol::curve::{
    disc, layout, DAMM_V2_PROGRAM_ID, DBC_EVENT_AUTHORITY, DBC_POOL_AUTHORITY, DBC_PROGRAM_ID,
    LOCKER_PROGRAM_ID,
};
use merces_protocol::state::seeds as pseeds;
use merces_registry::state::TrancheData;
use merces_registry::CreateSeriesArgs;
use serde_json::Value;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::harness::*;

pub fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/meteora")
}

/// The generator fixture (`scripts/gen-dbc-fixture.ts`).
pub fn curve_fixture() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixture_dir().join("curve_config.json")).unwrap())
        .unwrap()
}

pub fn fixture_u64(v: &Value, key: &str) -> u64 {
    v["expected"][key].as_str().unwrap().parse().unwrap()
}

pub fn curve_authority(series: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[pseeds::CURVE_AUTHORITY, series.as_ref()],
        &merces_protocol::ID,
    )
    .0
}
pub fn stake_auth(series: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[pseeds::CURVE_STAKE, series.as_ref()],
        &merces_protocol::ID,
    )
    .0
}
pub fn stake_vault(series: &Pubkey, base_mint: &Pubkey) -> Pubkey {
    ata(&stake_auth(series), base_mint, &TOKEN_2022)
}
pub fn dbc_pool_address(config: &Pubkey, base: &Pubkey, quote: &Pubkey) -> Pubkey {
    let (hi, lo) = if base > quote {
        (base, quote)
    } else {
        (quote, base)
    };
    Pubkey::find_program_address(
        &[b"pool", config.as_ref(), hi.as_ref(), lo.as_ref()],
        &DBC_PROGRAM_ID,
    )
    .0
}
pub fn dbc_vault(mint: &Pubkey, pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"token_vault", mint.as_ref(), pool.as_ref()],
        &DBC_PROGRAM_ID,
    )
    .0
}
pub fn damm_pool_address(config: &Pubkey, base: &Pubkey, quote: &Pubkey) -> Pubkey {
    let (hi, lo) = if base > quote {
        (base, quote)
    } else {
        (quote, base)
    };
    Pubkey::find_program_address(
        &[b"pool", config.as_ref(), hi.as_ref(), lo.as_ref()],
        &DAMM_V2_PROGRAM_ID,
    )
    .0
}
pub fn damm_vault(base: &Pubkey, pool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"token_vault", base.as_ref(), pool.as_ref()],
        &DAMM_V2_PROGRAM_ID,
    )
    .0
}
pub fn locker_escrow_token(dbc_pool: &Pubkey, base: &Pubkey) -> Pubkey {
    let base_key =
        Pubkey::find_program_address(&[b"base_locker", dbc_pool.as_ref()], &DBC_PROGRAM_ID).0;
    let escrow =
        Pubkey::find_program_address(&[b"escrow", base_key.as_ref()], &LOCKER_PROGRAM_ID).0;
    ata(&escrow, base, &TOKEN_2022)
}

/// `sha256("global:initialize_virtual_pool_with_token2022")[..8]`.
pub const IX_INIT_POOL_T22: [u8; 8] = [169, 118, 51, 78, 145, 110, 220, 155];
/// `sha256("global:swap2")[..8]` (also in the SDK IDL).
pub const IX_SWAP2: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];

/// The DBC objects of one curve series.
#[derive(Clone, Copy, Debug)]
pub struct Dbc {
    pub config: Pubkey,
    pub pool: Pubkey,
    pub base_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
}

/// Curve-series arguments for `create_series` (SPEC §9 / CURVE_MODE §2): the fixture's 100 units,
/// `min_raise = X`, no lockup / wallet cap / durations.
pub fn curve_series_args(terms_commitment: [u8; 32], threshold: u64) -> CreateSeriesArgs {
    let d = merces_common::params::Parameters::DEFAULT;
    CreateSeriesArgs {
        units_offered: 100,
        reserve_price: 4 * ONE_USDC,
        min_raise: threshold,
        cap_multiple_wad: d.cap_multiple_wad,
        hurdle_rate_wad: d.hurdle_rate_wad,
        payout_multiple_k: d.payout_multiple_k,
        lockup_seconds: 0,
        wallet_cap_bps: 0,
        commit_duration: 0,
        reveal_duration: 0,
        window_commit_duration: 0,
        window_reveal_duration: 0,
        release_schedule: vec![
            TrancheData {
                at_offset_seconds: 0,
                bps: 5_000,
            },
            TrancheData {
                at_offset_seconds: merces_common::time::YEAR,
                bps: 5_000,
            },
        ],
        terms_commitment,
        tier_flags: 0b0100,
        fx_pair_id: [0u8; 32],
        mode: merces_registry::state::MODE_CURVE,
        issuer_accepts_public_price: true,
        metadata_uri: "https://merces.example/heu/curve.json".to_string(),
        tier1_terms: None,
    }
}

impl Env {
    /// Loads the vendored DBC program (`tests/fixtures/meteora/dynamic_bonding_curve.so`).
    pub fn load_dbc(&mut self) {
        self.svm
            .add_program_from_file(
                DBC_PROGRAM_ID,
                fixture_dir().join("dynamic_bonding_curve.so"),
            )
            .expect("dynamic_bonding_curve.so");
    }

    /// `create_config` with the fixture's partner-route parameters; `fee_claimer =
    /// leftover_receiver = claimer`.
    pub fn dbc_create_config(
        &mut self,
        claimer: &Pubkey,
        quote_mint: &Pubkey,
    ) -> (TxResult, Pubkey) {
        let data = curve_fixture()["createConfigData"]
            .as_str()
            .unwrap()
            .to_string();
        self.dbc_create_config_with(claimer, quote_mint, &data)
    }

    /// `create_config` with the fixture's `pdaCreator` parameters (no issuer allocation, a 50/50
    /// migration-fee split).
    pub fn dbc_create_config_pda_creator(
        &mut self,
        claimer: &Pubkey,
        quote_mint: &Pubkey,
    ) -> (TxResult, Pubkey) {
        let data = curve_fixture()["pdaCreator"]["createConfigData"]
            .as_str()
            .unwrap()
            .to_string();
        self.dbc_create_config_with(claimer, quote_mint, &data)
    }

    fn dbc_create_config_with(
        &mut self,
        claimer: &Pubkey,
        quote_mint: &Pubkey,
        data_hex: &str,
    ) -> (TxResult, Pubkey) {
        let data = hex::decode(data_hex).unwrap();
        let config = Keypair::new();
        let ix = Instruction {
            program_id: DBC_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new(config.pubkey(), true),
                AccountMeta::new_readonly(*claimer, false),
                AccountMeta::new_readonly(*claimer, false),
                AccountMeta::new_readonly(*quote_mint, false),
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
                AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false),
                AccountMeta::new_readonly(DBC_PROGRAM_ID, false),
            ],
            data,
        };
        let key = config.pubkey();
        (self.send(&[ix], &[&config]), key)
    }

    /// `initialize_virtual_pool_with_token2022` with `creator` as the pool creator.
    pub fn dbc_create_pool(
        &mut self,
        config: &Pubkey,
        creator: &Keypair,
        quote_mint: &Pubkey,
    ) -> (TxResult, Dbc) {
        let base = Keypair::new();
        let pool = dbc_pool_address(config, &base.pubkey(), quote_mint);
        let base_vault = dbc_vault(&base.pubkey(), &pool);
        let quote_vault = dbc_vault(quote_mint, &pool);
        let mut data = IX_INIT_POOL_T22.to_vec();
        (
            "Merces HEU curve".to_string(),
            "HEU".to_string(),
            "https://merces.example/heu/curve.json".to_string(),
        )
            .serialize(&mut data)
            .unwrap();
        let ix = Instruction {
            program_id: DBC_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(*config, false),
                AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
                AccountMeta::new_readonly(creator.pubkey(), true),
                AccountMeta::new(base.pubkey(), true),
                AccountMeta::new_readonly(*quote_mint, false),
                AccountMeta::new(pool, false),
                AccountMeta::new(base_vault, false),
                AccountMeta::new(quote_vault, false),
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new_readonly(TOKEN_CLASSIC, false),
                AccountMeta::new_readonly(TOKEN_2022, false),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
                AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false),
                AccountMeta::new_readonly(DBC_PROGRAM_ID, false),
            ],
            data,
        };
        let res = self.send(&[ix], &[creator, &base]);
        (
            res,
            Dbc {
                config: *config,
                pool,
                base_mint: base.pubkey(),
                base_vault,
                quote_vault,
            },
        )
    }

    /// A `swap2` PartialFill buy of `amount_in` quote by `buyer` (its ATAs created first).
    pub fn dbc_buy(&mut self, dbc: &Dbc, buyer: &Keypair, amount_in: u64) -> TxResult {
        let quote = self.usdc;
        let input = ata(&buyer.pubkey(), &quote, &TOKEN_CLASSIC);
        let output = self.create_ata(&buyer.pubkey(), &dbc.base_mint);
        let mut data = IX_SWAP2.to_vec();
        data.extend_from_slice(&amount_in.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.push(1); // SwapMode::PartialFill
        let ix = Instruction {
            program_id: DBC_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
                AccountMeta::new_readonly(dbc.config, false),
                AccountMeta::new(dbc.pool, false),
                AccountMeta::new(input, false),
                AccountMeta::new(output, false),
                AccountMeta::new(dbc.base_vault, false),
                AccountMeta::new(dbc.quote_vault, false),
                AccountMeta::new_readonly(dbc.base_mint, false),
                AccountMeta::new_readonly(quote, false),
                AccountMeta::new_readonly(buyer.pubkey(), true),
                AccountMeta::new_readonly(TOKEN_2022, false),
                AccountMeta::new_readonly(TOKEN_CLASSIC, false),
                // referral_token_account: None (Anchor optional account = program id)
                AccountMeta::new_readonly(DBC_PROGRAM_ID, false),
                AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false),
                AccountMeta::new_readonly(DBC_PROGRAM_ID, false),
            ],
            data,
        };
        self.send(&[ix], &[buyer])
    }

    /// Raw account bytes (panics when missing).
    pub fn raw(&self, key: &Pubkey) -> Vec<u8> {
        self.account_data(key)
            .unwrap_or_else(|| panic!("account {key} missing"))
    }

    /// Overwrites `len` bytes of an existing account at `offset` (mocking program-owned state).
    pub fn patch(&mut self, key: &Pubkey, offset: usize, bytes: &[u8]) {
        let mut acc = self.svm.get_account(key).expect("account");
        acc.data[offset..offset + bytes.len()].copy_from_slice(bytes);
        self.svm.set_account(*key, acc).unwrap();
    }

    /// Writes a program-owned account with `data` at `key`.
    pub fn put_account(&mut self, key: &Pubkey, owner: &Pubkey, data: Vec<u8>) {
        let mut acc = self.svm.get_account(&config_pda()).unwrap();
        acc.lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        acc.data = data;
        acc.owner = *owner;
        acc.executable = false;
        self.svm.set_account(*key, acc).unwrap();
    }

    /// Byte-exact DAMM v2 `Config` (idls/damm_v2.json, bytemuck): discriminator, vault config key,
    /// `pool_creator_authority`, zero fee/price fields (only the authority is read by Merces).
    pub fn mock_damm_config(&mut self, pool_creator_authority: &Pubkey) -> Pubkey {
        let key = Pubkey::new_unique();
        let mut d = vec![0u8; 8 + 320];
        d[..8].copy_from_slice(&disc::DAMM_CONFIG);
        d[layout::DAMM_CFG_POOL_CREATOR_AUTHORITY..layout::DAMM_CFG_POOL_CREATOR_AUTHORITY + 32]
            .copy_from_slice(pool_creator_authority.as_ref());
        self.put_account(&key, &DAMM_V2_PROGRAM_ID, d);
        key
    }

    /// Byte-exact DAMM v2 `Pool` header at its PDA (the migrated pool exists).
    pub fn mock_damm_pool(&mut self, pool: &Pubkey) {
        let mut d = vec![0u8; 8 + 1104];
        d[..8].copy_from_slice(&disc::DAMM_POOL);
        self.put_account(pool, &DAMM_V2_PROGRAM_ID, d);
    }

    /// A Token-2022 token account (165-byte base layout, initialised) of `mint` owned by `owner`
    /// holding `amount`, written at `key`.
    pub fn mock_token_account(&mut self, key: &Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) {
        let mut d = vec![0u8; 165];
        d[..32].copy_from_slice(mint.as_ref());
        d[32..64].copy_from_slice(owner.as_ref());
        d[64..72].copy_from_slice(&amount.to_le_bytes());
        d[108] = 1; // AccountState::Initialized
        self.put_account(key, &TOKEN_2022, d);
    }

    /// Sets the amount of an existing token account (mocks a migration moving base lamports).
    pub fn set_token_amount(&mut self, key: &Pubkey, amount: u64) {
        self.patch(key, 64, &amount.to_le_bytes());
    }

    // ---------------------------------------------------------------- Merces curve instructions

    pub fn prepare_curve(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let ix = Instruction {
            program_id: merces_protocol::ID,
            accounts: merces_protocol::accounts::PrepareCurve {
                issuer: issuer.pubkey(),
                series: *series,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                vault_auth: p.vault_auth,
                treasury_auth: p.treasury_auth,
                treasury: p.treasury,
                ledger: p.ledger,
                treasury_token: p.treasury_token,
                vault_token: p.vault_token,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: merces_protocol::instruction::PrepareCurve {}.data(),
        };
        self.send(&[ix], &[issuer])
    }

    pub fn activate_curve(&mut self, issuer: &Keypair, series: &Pubkey, dbc: &Dbc) -> TxResult {
        let p = pdas(*series);
        let ix = Instruction {
            program_id: merces_protocol::ID,
            accounts: merces_protocol::accounts::ActivateCurve {
                issuer: issuer.pubkey(),
                config: p.config,
                series: *series,
                issuer_allowlist: allow_pda(&issuer.pubkey()),
                ledger: p.ledger,
                dbc_config: dbc.config,
                dbc_pool: dbc.pool,
                base_mint: dbc.base_mint,
                curve_authority: curve_authority(series),
                registry_authority: p.registry_authority,
                registry_program: merces_registry::ID,
            }
            .to_account_metas(None),
            data: merces_protocol::instruction::ActivateCurve {}.data(),
        };
        self.send(&[ix], &[issuer])
    }

    pub fn complete_curve(&mut self, series: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let ix = Instruction {
            program_id: merces_protocol::ID,
            accounts: merces_protocol::accounts::CompleteCurve {
                config: p.config,
                series: *series,
                ledger: p.ledger,
                treasury: p.treasury,
                dbc_config: s.dbc_config,
                dbc_pool: s.dbc_pool,
                registry_authority: p.registry_authority,
                registry_program: merces_registry::ID,
            }
            .to_account_metas(None),
            data: merces_protocol::instruction::CompleteCurve {}.data(),
        };
        self.send(&[ix], &[])
    }

    /// The eight census accounts (`sync_curve_units` order) for a DAMM v2 config `damm_config`.
    pub fn curve_census(&self, series: &Pubkey, damm_config: &Pubkey) -> [Pubkey; 8] {
        let s = self.series(series);
        let base = s.base_mint;
        let pool_data = self.raw(&s.dbc_pool);
        let base_vault = Pubkey::new_from_array(
            pool_data[layout::POOL_BASE_VAULT..layout::POOL_BASE_VAULT + 32]
                .try_into()
                .unwrap(),
        );
        let damm_pool = damm_pool_address(damm_config, &base, &s.stablecoin);
        [
            base,
            s.dbc_pool,
            base_vault,
            *damm_config,
            damm_pool,
            damm_vault(&base, &damm_pool),
            locker_escrow_token(&s.dbc_pool, &base),
            ata(&curve_authority(series), &base, &TOKEN_2022),
        ]
    }

    pub fn sync_curve_units_ix(&self, series: &Pubkey, census: [Pubkey; 8]) -> Instruction {
        let p = pdas(*series);
        Instruction {
            program_id: merces_protocol::ID,
            accounts: merces_protocol::accounts::SyncCurveUnits {
                series: *series,
                ledger: p.ledger,
                base_mint: census[0],
                dbc_pool: census[1],
                dbc_base_vault: census[2],
                damm_config: census[3],
                damm_pool: census[4],
                damm_base_vault: census[5],
                locker_escrow_token: census[6],
                leftover_token: census[7],
            }
            .to_account_metas(None),
            data: merces_protocol::instruction::SyncCurveUnits {}.data(),
        }
    }

    pub fn sync_curve_units(&mut self, series: &Pubkey, damm_config: &Pubkey) -> TxResult {
        let census = self.curve_census(series, damm_config);
        let ix = self.sync_curve_units_ix(series, census);
        self.send(&[ix], &[])
    }

    pub fn collect_curve_proceeds(&mut self, series: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let pool_data = self.raw(&s.dbc_pool);
        let read =
            |off: usize| Pubkey::new_from_array(pool_data[off..off + 32].try_into().unwrap());
        let fee_collector = self.fee_collector.pubkey();
        let create = self.create_ata_ix(&fee_collector, &s.stablecoin);
        let ix = Instruction {
            program_id: merces_protocol::ID,
            accounts: merces_protocol::accounts::CollectCurveProceeds {
                config: p.config,
                series: *series,
                treasury: p.treasury,
                treasury_token: p.treasury_token,
                fee_collector_token: ata(&fee_collector, &s.stablecoin, &s.stablecoin_program),
                curve_authority: curve_authority(series),
                dbc_pool_authority: DBC_POOL_AUTHORITY,
                dbc_config: s.dbc_config,
                dbc_pool: s.dbc_pool,
                dbc_quote_vault: read(layout::POOL_QUOTE_VAULT),
                dbc_base_vault: read(layout::POOL_BASE_VAULT),
                base_mint: s.base_mint,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                token_2022_program: TOKEN_2022,
                dbc_event_authority: DBC_EVENT_AUTHORITY,
                dbc_program: DBC_PROGRAM_ID,
            }
            .to_account_metas(None),
            data: merces_protocol::instruction::CollectCurveProceeds {}.data(),
        };
        self.send(&[create, ix], &[])
    }

    pub fn stake_units(&mut self, owner: &Keypair, series: &Pubkey, units: u64) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let w = owner.pubkey();
        let ix = Instruction {
            program_id: merces_protocol::ID,
            accounts: merces_protocol::accounts::StakeUnits {
                owner: w,
                series: *series,
                ledger: p.ledger,
                holder: holder_pda(series, &w),
                owner_allowlist: allow_pda(&w),
                owner_base_ata: ata(&w, &s.base_mint, &TOKEN_2022),
                stake_auth: stake_auth(series),
                stake_vault: stake_vault(series, &s.base_mint),
                base_mint: s.base_mint,
                token_2022_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: merces_protocol::instruction::StakeUnits { units }.data(),
        };
        self.send(&[ix], &[owner])
    }

    pub fn unstake_units(&mut self, owner: &Keypair, series: &Pubkey, units: u64) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let w = owner.pubkey();
        let ix = Instruction {
            program_id: merces_protocol::ID,
            accounts: merces_protocol::accounts::UnstakeUnits {
                owner: w,
                series: *series,
                ledger: p.ledger,
                holder: holder_pda(series, &w),
                owner_base_ata: ata(&w, &s.base_mint, &TOKEN_2022),
                stake_auth: stake_auth(series),
                stake_vault: stake_vault(series, &s.base_mint),
                base_mint: s.base_mint,
                token_2022_program: TOKEN_2022,
            }
            .to_account_metas(None),
            data: merces_protocol::instruction::UnstakeUnits { units }.data(),
        };
        self.send(&[ix], &[owner])
    }

    pub fn tender_units(
        &mut self,
        owner: &Keypair,
        series: &Pubkey,
        from_stake: u64,
        from_wallet: u64,
    ) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let w = owner.pubkey();
        let create = self.create_ata_ix(&w, &s.stablecoin);
        let ix = Instruction {
            program_id: merces_protocol::ID,
            accounts: merces_protocol::accounts::TenderUnits {
                owner: w,
                series: *series,
                ledger: p.ledger,
                holder: holder_pda(series, &w),
                owner_base_ata: ata(&w, &s.base_mint, &TOKEN_2022),
                owner_stable_ata: ata(&w, &s.stablecoin, &s.stablecoin_program),
                stake_auth: stake_auth(series),
                stake_vault: stake_vault(series, &s.base_mint),
                base_mint: s.base_mint,
                vault_token: p.vault_token,
                vault_auth: p.vault_auth,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                token_2022_program: TOKEN_2022,
            }
            .to_account_metas(None),
            data: merces_protocol::instruction::TenderUnits {
                from_stake,
                from_wallet,
            }
            .data(),
        };
        self.send(&[create, ix], &[owner])
    }

    /// Curve-mode `redeem`: the eight census accounts follow as remaining accounts (USDC has no
    /// stablecoin hook accounts).
    pub fn redeem_curve(
        &mut self,
        issuer: &Keypair,
        series: &Pubkey,
        damm_config: &Pubkey,
    ) -> TxResult {
        let census = self.curve_census(series, damm_config);
        let s = self.series(series);
        let p = pdas(*series);
        let create = self.create_ata_ix(&issuer.pubkey(), &s.stablecoin);
        let mut accounts = merces_protocol::accounts::Redeem {
            issuer: issuer.pubkey(),
            config: p.config,
            series: *series,
            ledger: p.ledger,
            issuer_stable: self.ata_of(&issuer.pubkey(), &s.stablecoin),
            vault_token: p.vault_token,
            stablecoin_mint: s.stablecoin,
            stablecoin_program: s.stablecoin_program,
            registry_authority: p.registry_authority,
            registry_program: merces_registry::ID,
        }
        .to_account_metas(None);
        accounts.extend(census.iter().map(|k| AccountMeta::new_readonly(*k, false)));
        let ix = Instruction {
            program_id: merces_protocol::ID,
            accounts,
            data: merces_protocol::instruction::Redeem {}.data(),
        };
        self.send(&[create, ix], &[issuer])
    }
}
