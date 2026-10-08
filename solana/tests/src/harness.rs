//! LiteSVM harness: loads the four compiled programs, creates the mock stablecoins and provides
//! instruction builders for every registry and protocol instruction.

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use merces_common::encoding::commitment_preimage;
use merces_common::params::Parameters;
use merces_protocol::state::{self as pstate, seeds as pseeds, Auction, Bid, Holder, Ledger, Order, Report, Treasury, Window};
use merces_registry::state::{AllowlistEntry, ParametersData, ProtocolConfig, Series, TrancheData};
use merces_registry::CreateSeriesArgs;
use solana_clock::Clock;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_2022::extension::ExtensionType;
use spl_token_2022::state::Mint as MintState;

use crate::sig::keccak;

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

/// 2026-01-01T00:00:00Z — every test starts here (SPEC §1.2 example period 8104).
pub const START_TS: u64 = 1_767_225_600;
pub const CHAIN_ID_LOCALNET: u64 = 104;
pub const USDC_DECIMALS: u8 = 6;
pub const WAD: u64 = 1_000_000_000_000_000_000;
pub const ONE_USDC: u64 = 1_000_000;

pub const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
pub const TOKEN_CLASSIC: Pubkey = anchor_spl::token::ID;
pub const ATA_PROGRAM: Pubkey = anchor_spl::associated_token::ID;
pub const SYSTEM_PROGRAM: Pubkey = anchor_lang::system_program::ID;

fn deploy_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/deploy").join(format!("{name}.so"))
}

/// All PDAs of one series.
#[derive(Debug, Clone)]
pub struct Pdas {
    pub series: Pubkey,
    pub config: Pubkey,
    pub registry_signer: Pubkey,
    pub auction: Pubkey,
    pub treasury: Pubkey,
    pub ledger: Pubkey,
    pub unit_mint: Pubkey,
    pub auction_auth: Pubkey,
    pub vault_auth: Pubkey,
    pub escrow_auth: Pubkey,
    pub treasury_auth: Pubkey,
    pub router_auth: Pubkey,
    pub window_escrow: Pubkey,
    pub escrow_token: Pubkey,
    pub treasury_token: Pubkey,
    pub vault_token: Pubkey,
    pub router: Pubkey,
    pub router_token: Pubkey,
    pub window_units: Pubkey,
    pub window_stable: Pubkey,
    pub extra_metas: Pubkey,
    pub mint_link: Pubkey,
}

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[merces_onchain_seeds::CONFIG], &merces_registry::ID).0
}
pub fn allow_pda(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[merces_onchain_seeds::ALLOW, wallet.as_ref()], &merces_registry::ID).0
}
pub fn issuer_pda(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[merces_onchain_seeds::ISSUER, wallet.as_ref()], &merces_registry::ID).0
}
pub fn attestor_pda(addr: &[u8; 20]) -> Pubkey {
    Pubkey::find_program_address(&[merces_onchain_seeds::ATTESTOR, addr], &merces_registry::ID).0
}
pub fn verifier_pda(addr: &[u8; 20]) -> Pubkey {
    Pubkey::find_program_address(&[merces_onchain_seeds::VERIFIER, addr], &merces_registry::ID).0
}
pub fn fx_config_pda(pair: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[merces_onchain_seeds::FX, pair], &merces_registry::ID).0
}
pub fn series_pda(series_id: u64) -> Pubkey {
    Pubkey::find_program_address(&[merces_onchain_seeds::SERIES, &series_id.to_le_bytes()], &merces_registry::ID).0
}
pub fn bid_pda(series: &Pubkey, bidder: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[pseeds::BID, series.as_ref(), bidder.as_ref()], &merces_protocol::ID).0
}
pub fn holder_pda(series: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[pseeds::HOLDER, series.as_ref(), wallet.as_ref()], &merces_protocol::ID).0
}
pub fn report_pda(series: &Pubkey, period: u32) -> Pubkey {
    Pubkey::find_program_address(&[pseeds::REPORT, series.as_ref(), &period.to_le_bytes()], &merces_protocol::ID).0
}
pub fn window_pda(series: &Pubkey, period: u32) -> Pubkey {
    Pubkey::find_program_address(&[pseeds::WINDOW, series.as_ref(), &period.to_le_bytes()], &merces_protocol::ID).0
}
pub fn order_pda(series: &Pubkey, period: u32, owner: &Pubkey, side: u8) -> Pubkey {
    Pubkey::find_program_address(&[pseeds::ORDER, series.as_ref(), &period.to_le_bytes(), owner.as_ref(), &[side]], &merces_protocol::ID).0
}
pub fn fx_pair_pda(pair: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[pseeds::FX_PAIR, pair], &merces_protocol::ID).0
}
pub fn fx_checkpoint_pda(pair: &[u8; 32], period: u32) -> Pubkey {
    Pubkey::find_program_address(&[pseeds::FX_CHECKPOINT, pair, &period.to_le_bytes()], &merces_protocol::ID).0
}
pub fn mock_hook_extra_metas(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[mock_usdg_hook::EXTRA_ACCOUNT_METAS_SEED, mint.as_ref()], &mock_usdg_hook::ID).0
}
pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    anchor_spl::associated_token::get_associated_token_address_with_program_id(owner, mint, token_program)
}

/// Seeds shared with the programs (re-exported for the tests).
pub mod merces_onchain_seeds {
    pub use merces_onchain::seeds::*;
}

pub fn pdas(series: Pubkey) -> Pdas {
    let p = |seed: &[u8]| Pubkey::find_program_address(&[seed, series.as_ref()], &merces_protocol::ID).0;
    let unit_mint = p(pseeds::UNIT_MINT);
    Pdas {
        series,
        config: config_pda(),
        registry_signer: Pubkey::find_program_address(&[pseeds::REGISTRY_SIGNER], &merces_protocol::ID).0,
        auction: p(pseeds::AUCTION),
        treasury: p(pseeds::TREASURY),
        ledger: p(pseeds::LEDGER),
        unit_mint,
        auction_auth: p(pseeds::AUCTION_AUTH),
        vault_auth: p(pseeds::VAULT_AUTH),
        escrow_auth: p(pseeds::ESCROW_AUTH),
        treasury_auth: p(pseeds::TREASURY_AUTH),
        router_auth: p(pseeds::ROUTER_AUTH),
        window_escrow: p(pseeds::WINDOW_ESCROW),
        escrow_token: p(pseeds::ESCROW_TOKEN),
        treasury_token: p(pseeds::TREASURY_TOKEN),
        vault_token: p(pseeds::VAULT_TOKEN),
        router: p(pseeds::ROUTER),
        router_token: p(pseeds::ROUTER_TOKEN),
        window_units: p(pseeds::WINDOW_UNITS),
        window_stable: p(pseeds::WINDOW_STABLE),
        extra_metas: Pubkey::find_program_address(&[merces_hook::EXTRA_ACCOUNT_METAS_SEED, unit_mint.as_ref()], &merces_hook::ID).0,
        mint_link: Pubkey::find_program_address(&[merces_onchain_seeds::MINT_LINK, unit_mint.as_ref()], &merces_registry::ID).0,
    }
}

/// Bid / ask commitment `keccak256(price ‖ quantity ‖ salt ‖ wallet)`.
pub fn commitment(price: u64, quantity: u64, salt: &[u8; 32], wallet: &Pubkey) -> [u8; 32] {
    keccak(&[commitment_preimage(price, quantity, salt, &wallet.to_bytes()).as_bytes()])
}

pub fn salt(n: u8) -> [u8; 32] {
    let mut s = [0u8; 32];
    s[0] = n;
    s[31] = 0xAA;
    s
}

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub admin: Keypair,
    pub allowlist_manager: Keypair,
    pub fee_collector: Keypair,
    pub mint_authority: Keypair,
    pub usdc: Pubkey,
    pub usdg: Pubkey,
    pub now: u64,
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

impl Env {
    /// Loads the programs, creates the mock stablecoins and initialises the protocol with
    /// SPEC §1.6 defaults at `START_TS`.
    pub fn new() -> Self {
        let mut env = Self::new_without_protocol();
        env.init_protocol(Parameters::DEFAULT.into());
        env
    }

    pub fn new_without_protocol() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(merces_registry::ID, deploy_path("merces_registry")).expect("registry .so");
        svm.add_program_from_file(merces_hook::ID, deploy_path("merces_hook")).expect("hook .so");
        svm.add_program_from_file(merces_protocol::ID, deploy_path("merces_protocol")).expect("protocol .so");
        svm.add_program_from_file(mock_usdg_hook::ID, deploy_path("mock_usdg_hook")).expect("mock hook .so");
        let payer = Keypair::new();
        let admin = Keypair::new();
        let allowlist_manager = Keypair::new();
        let fee_collector = Keypair::new();
        let mint_authority = Keypair::new();
        for k in [&payer, &admin, &allowlist_manager, &fee_collector, &mint_authority] {
            svm.airdrop(&k.pubkey(), 1_000_000_000_000).unwrap();
        }
        let mut env = Env {
            svm,
            payer,
            admin,
            allowlist_manager,
            fee_collector,
            mint_authority,
            usdc: Pubkey::default(),
            usdg: Pubkey::default(),
            now: 0,
        };
        env.warp(START_TS);
        env.usdc = env.create_usdc_mint();
        env.usdg = env.create_usdg_mint();
        env
    }

    // ------------------------------------------------------------------ clock and transactions

    /// Sets the clock to `ts` (SPEC §11 `t`), advancing the slot so the blockhash rotates.
    pub fn warp(&mut self, ts: u64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = i64::try_from(ts).unwrap();
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
        self.svm.expire_blockhash();
        self.now = ts;
    }

    pub fn advance(&mut self, seconds: u64) {
        let t = self.now + seconds;
        self.warp(t);
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        self.send_with_cu(ixs, signers, 1_400_000)
    }

    pub fn send_with_cu(&mut self, ixs: &[Instruction], signers: &[&Keypair], cu: u32) -> TxResult {
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(cu)];
        all.extend_from_slice(ixs);
        let payer_pk = self.payer.pubkey();
        let mut keypairs: Vec<&Keypair> = vec![&self.payer];
        for s in signers {
            if s.pubkey() != payer_pk {
                keypairs.push(s);
            }
        }
        let tx = Transaction::new_signed_with_payer(&all, Some(&payer_pk), &keypairs, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    pub fn send_ok(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionMetadata {
        match self.send(ixs, signers) {
            Ok(m) => m,
            Err(e) => panic!("transaction failed: {:?}\n{}", e.err, e.meta.logs.join("\n")),
        }
    }

    /// Sends and asserts the failure carries the given custom error code.
    pub fn send_expect(&mut self, ixs: &[Instruction], signers: &[&Keypair], code: u32) -> FailedTransactionMetadata {
        match self.send(ixs, signers) {
            Ok(m) => panic!("expected error {code}, transaction succeeded:\n{}", m.logs.join("\n")),
            Err(e) => {
                let s = format!("{:?}", e.err);
                assert!(
                    s.contains(&format!("Custom({code})")),
                    "expected error {code}, got {s}\n{}",
                    e.meta.logs.join("\n")
                );
                e
            }
        }
    }

    pub fn new_wallet(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        k
    }

    // ------------------------------------------------------------------ accounts

    pub fn account_data(&self, key: &Pubkey) -> Option<Vec<u8>> {
        self.svm.get_account(key).map(|a| a.data)
    }

    pub fn load<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let data = self.account_data(key).unwrap_or_else(|| panic!("account {key} missing"));
        T::try_deserialize(&mut &data[..]).expect("deserialize")
    }

    pub fn config(&self) -> ProtocolConfig {
        self.load(&config_pda())
    }
    pub fn series(&self, series: &Pubkey) -> Series {
        self.load(series)
    }
    pub fn allowlist(&self, wallet: &Pubkey) -> Option<AllowlistEntry> {
        self.account_data(&allow_pda(wallet)).map(|d| AllowlistEntry::try_deserialize(&mut &d[..]).unwrap())
    }
    pub fn auction(&self, series: &Pubkey) -> Auction {
        self.load(&pdas(*series).auction)
    }
    pub fn treasury(&self, series: &Pubkey) -> Treasury {
        self.load(&pdas(*series).treasury)
    }
    pub fn bid(&self, series: &Pubkey, bidder: &Pubkey) -> Bid {
        self.load(&bid_pda(series, bidder))
    }
    pub fn holder(&self, series: &Pubkey, wallet: &Pubkey) -> Option<Holder> {
        self.account_data(&holder_pda(series, wallet)).map(|d| Holder::try_deserialize(&mut &d[..]).unwrap())
    }
    pub fn report(&self, series: &Pubkey, period: u32) -> Report {
        self.load(&report_pda(series, period))
    }
    pub fn window(&self, series: &Pubkey, period: u32) -> Window {
        self.load(&window_pda(series, period))
    }
    pub fn order(&self, series: &Pubkey, period: u32, owner: &Pubkey, side: u8) -> Order {
        self.load(&order_pda(series, period, owner, side))
    }
    pub fn ledger(&self, series: &Pubkey) -> Ledger {
        let data = self.account_data(&pdas(*series).ledger).expect("ledger");
        *bytemuck::from_bytes::<Ledger>(&data[8..8 + core::mem::size_of::<Ledger>()])
    }

    // ------------------------------------------------------------------ tokens

    pub fn token_program_of(&self, mint: &Pubkey) -> Pubkey {
        if *mint == self.usdc {
            TOKEN_CLASSIC
        } else {
            TOKEN_2022
        }
    }

    pub fn ata_of(&self, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
        ata(owner, mint, &self.token_program_of(mint))
    }

    fn create_usdc_mint(&mut self) -> Pubkey {
        let mint = Keypair::new();
        let space = spl_token_2022::state::Mint::LEN;
        let lamports = self.svm.minimum_balance_for_rent_exemption(space);
        let ixs = [
            solana_system_interface::instruction::create_account(&self.payer.pubkey(), &mint.pubkey(), lamports, space as u64, &TOKEN_CLASSIC),
            spl_token_interface::instruction::initialize_mint2(&TOKEN_CLASSIC, &mint.pubkey(), &self.mint_authority.pubkey(), None, USDC_DECIMALS).unwrap(),
        ];
        self.send_ok(&ixs, &[&mint]);
        mint.pubkey()
    }

    /// Token-2022 mint with TransferHook → mock_usdg_hook, TransferFeeConfig 0/0,
    /// ConfidentialTransferMint and MetadataPointer (ASSUMPTIONS A24).
    fn create_usdg_mint(&mut self) -> Pubkey {
        let mint = Keypair::new();
        let auth = self.mint_authority.pubkey();
        let space = ExtensionType::try_calculate_account_len::<MintState>(&[
            ExtensionType::TransferHook,
            ExtensionType::TransferFeeConfig,
            ExtensionType::ConfidentialTransferMint,
            ExtensionType::MetadataPointer,
        ])
        .unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(space);
        let mk = mint.pubkey();
        let ixs = [
            solana_system_interface::instruction::create_account(&self.payer.pubkey(), &mk, lamports, space as u64, &TOKEN_2022),
            spl_token_2022::extension::transfer_hook::instruction::initialize(&TOKEN_2022, &mk, Some(auth), Some(mock_usdg_hook::ID)).unwrap(),
            spl_token_2022::extension::transfer_fee::instruction::initialize_transfer_fee_config(&TOKEN_2022, &mk, Some(&auth), Some(&auth), 0, 0).unwrap(),
            spl_token_2022::extension::confidential_transfer::instruction::initialize_mint(&TOKEN_2022, &mk, Some(auth), false, None).unwrap(),
            spl_token_2022::extension::metadata_pointer::instruction::initialize(&TOKEN_2022, &mk, Some(auth), Some(mk)).unwrap(),
            spl_token_2022::instruction::initialize_mint2(&TOKEN_2022, &mk, &auth, None, USDC_DECIMALS).unwrap(),
        ];
        self.send_ok(&ixs, &[&mint]);
        // the mock hook's (empty) extra account metas
        let ix = Instruction {
            program_id: mock_usdg_hook::ID,
            accounts: mock_usdg_hook::accounts::InitializeExtraAccountMetaList {
                payer: self.payer.pubkey(),
                extra_account_meta_list: mock_hook_extra_metas(&mk),
                mint: mk,
                token_program: TOKEN_2022,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: mock_usdg_hook::instruction::InitializeExtraAccountMetaList {}.data(),
        };
        self.send_ok(&[ix], &[]);
        mk
    }

    /// Creates the ATA (idempotent) and returns it.
    pub fn create_ata(&mut self, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
        let tp = self.token_program_of(mint);
        let ix = spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent(&self.payer.pubkey(), owner, mint, &tp);
        self.send_ok(&[ix], &[]);
        ata(owner, mint, &tp)
    }

    pub fn create_ata_ix(&self, owner: &Pubkey, mint: &Pubkey) -> Instruction {
        let tp = self.token_program_of(mint);
        spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent(&self.payer.pubkey(), owner, mint, &tp)
    }

    /// Mints `amount` stablecoin to `owner`'s ATA (creating it).
    pub fn fund(&mut self, owner: &Pubkey, mint: &Pubkey, amount: u64) -> Pubkey {
        let acc = self.create_ata(owner, mint);
        let tp = self.token_program_of(mint);
        let ix = if tp == TOKEN_CLASSIC {
            spl_token_interface::instruction::mint_to(&tp, mint, &acc, &self.mint_authority.pubkey(), &[], amount).unwrap()
        } else {
            spl_token_2022::instruction::mint_to(&tp, mint, &acc, &self.mint_authority.pubkey(), &[], amount).unwrap()
        };
        let auth = self.mint_authority.insecure_clone();
        self.send_ok(&[ix], &[&auth]);
        acc
    }

    pub fn token_balance(&self, token_account: &Pubkey) -> u64 {
        match self.account_data(token_account) {
            Some(d) if d.len() >= 72 => u64::from_le_bytes(d[64..72].try_into().unwrap()),
            _ => 0,
        }
    }

    pub fn balance_of(&self, owner: &Pubkey, mint: &Pubkey) -> u64 {
        self.token_balance(&self.ata_of(owner, mint))
    }

    pub fn mint_supply(&self, mint: &Pubkey) -> u64 {
        let d = self.account_data(mint).expect("mint");
        u64::from_le_bytes(d[36..44].try_into().unwrap())
    }

    /// Remaining accounts a stablecoin transfer needs for hook resolution (none for USDC).
    pub fn stable_hook_accounts(&self, mint: &Pubkey) -> Vec<AccountMeta> {
        if *mint == self.usdg {
            vec![AccountMeta::new_readonly(mock_usdg_hook::ID, false), AccountMeta::new_readonly(mock_hook_extra_metas(mint), false)]
        } else {
            vec![]
        }
    }

    /// Remaining accounts for a unit-mint transfer through the Merces hook.
    pub fn unit_hook_accounts(&self, series: &Pubkey, source_owner: &Pubkey, destination_owner: &Pubkey) -> Vec<AccountMeta> {
        let p = pdas(*series);
        vec![
            AccountMeta::new_readonly(merces_hook::ID, false),
            AccountMeta::new_readonly(p.extra_metas, false),
            AccountMeta::new_readonly(merces_registry::ID, false),
            AccountMeta::new_readonly(p.config, false),
            AccountMeta::new_readonly(p.mint_link, false),
            AccountMeta::new_readonly(*series, false),
            AccountMeta::new_readonly(allow_pda(source_owner), false),
            AccountMeta::new_readonly(allow_pda(destination_owner), false),
        ]
    }

    /// A direct wallet-to-wallet unit transfer instruction (expected to fail with the hook).
    pub fn direct_unit_transfer_ix(&self, series: &Pubkey, from: &Pubkey, to: &Pubkey, amount: u64) -> Instruction {
        let p = pdas(*series);
        let mut ix = spl_token_2022::instruction::transfer_checked(
            &TOKEN_2022,
            &ata(from, &p.unit_mint, &TOKEN_2022),
            &p.unit_mint,
            &ata(to, &p.unit_mint, &TOKEN_2022),
            from,
            &[],
            amount,
            0,
        )
        .unwrap();
        ix.accounts.extend(self.unit_hook_accounts(series, from, to));
        ix
    }

    // ------------------------------------------------------------------ registry

    pub fn init_protocol(&mut self, defaults: ParametersData) {
        let ix = Instruction {
            program_id: merces_registry::ID,
            accounts: merces_registry::accounts::InitProtocol {
                config: config_pda(),
                payer: self.payer.pubkey(),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: merces_registry::instruction::InitProtocol {
                args: merces_registry::InitProtocolArgs {
                    admin: self.admin.pubkey(),
                    allowlist_manager: self.allowlist_manager.pubkey(),
                    fee_collector: self.fee_collector.pubkey(),
                    chain_id: CHAIN_ID_LOCALNET,
                    defaults,
                    protocol_program: merces_protocol::ID,
                },
            }
            .data(),
        };
        self.send_ok(&[ix], &[]);
    }

    fn admin_ix(&self, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: merces_registry::ID,
            accounts,
            data,
        }
    }

    pub fn admin_only_ix(&self, data: Vec<u8>) -> Instruction {
        self.admin_ix(
            merces_registry::accounts::AdminOnly {
                config: config_pda(),
                admin: self.admin.pubkey(),
            }
            .to_account_metas(None),
            data,
        )
    }

    pub fn set_flags(&mut self, new_raises_paused: bool, windows_enabled: bool, tier4_enabled: bool) {
        let ix = self.admin_only_ix(
            merces_registry::instruction::SetFlags {
                new_raises_paused,
                windows_enabled,
                tier4_enabled,
            }
            .data(),
        );
        let admin = self.admin.insecure_clone();
        self.send_ok(&[ix], &[&admin]);
    }

    pub fn set_early_draw_approver(&mut self, approver: Pubkey) {
        let ix = self.admin_only_ix(merces_registry::instruction::SetEarlyDrawApprover { approver }.data());
        let admin = self.admin.insecure_clone();
        self.send_ok(&[ix], &[&admin]);
    }

    pub fn set_defaults(&mut self, defaults: ParametersData) -> TxResult {
        let ix = self.admin_only_ix(merces_registry::instruction::SetDefaults { defaults }.data());
        let admin = self.admin.insecure_clone();
        self.send(&[ix], &[&admin])
    }

    pub fn allow(&mut self, wallet: &Pubkey, allowed: bool) {
        let ix = self.admin_ix(
            merces_registry::accounts::SetAllowed {
                config: config_pda(),
                allowlist_manager: self.allowlist_manager.pubkey(),
                entry: allow_pda(wallet),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_registry::instruction::SetAllowed { wallet: *wallet, allowed }.data(),
        );
        let m = self.allowlist_manager.insecure_clone();
        self.send_ok(&[ix], &[&m]);
    }

    pub fn register_issuer(&mut self, wallet: &Pubkey) {
        let ix = self.admin_ix(
            merces_registry::accounts::RegisterIssuer {
                config: config_pda(),
                admin: self.admin.pubkey(),
                issuer: issuer_pda(wallet),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_registry::instruction::RegisterIssuer { wallet: *wallet }.data(),
        );
        let admin = self.admin.insecure_clone();
        self.send_ok(&[ix], &[&admin]);
    }

    pub fn deactivate_issuer(&mut self, wallet: &Pubkey) {
        let ix = self.admin_ix(
            merces_registry::accounts::DeactivateIssuer {
                config: config_pda(),
                admin: self.admin.pubkey(),
                issuer: issuer_pda(wallet),
            }
            .to_account_metas(None),
            merces_registry::instruction::DeactivateIssuer { wallet: *wallet }.data(),
        );
        let admin = self.admin.insecure_clone();
        self.send_ok(&[ix], &[&admin]);
    }

    pub fn register_attestor(&mut self, addr: [u8; 20]) {
        let ix = self.admin_ix(
            merces_registry::accounts::RegisterAttestor {
                config: config_pda(),
                admin: self.admin.pubkey(),
                attestor: attestor_pda(&addr),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_registry::instruction::RegisterAttestor { addr }.data(),
        );
        let admin = self.admin.insecure_clone();
        self.send_ok(&[ix], &[&admin]);
    }

    pub fn revoke_attestor(&mut self, addr: [u8; 20]) {
        let ix = self.admin_ix(
            merces_registry::accounts::RevokeAttestor {
                config: config_pda(),
                admin: self.admin.pubkey(),
                attestor: attestor_pda(&addr),
            }
            .to_account_metas(None),
            merces_registry::instruction::RevokeAttestor { addr }.data(),
        );
        let admin = self.admin.insecure_clone();
        self.send_ok(&[ix], &[&admin]);
    }

    pub fn register_verifier(&mut self, addr: [u8; 20]) {
        let ix = self.admin_ix(
            merces_registry::accounts::RegisterVerifierKey {
                config: config_pda(),
                admin: self.admin.pubkey(),
                verifier: verifier_pda(&addr),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_registry::instruction::RegisterVerifierKey { addr }.data(),
        );
        let admin = self.admin.insecure_clone();
        self.send_ok(&[ix], &[&admin]);
    }

    pub fn set_fx_pair(&mut self, pair_id: [u8; 32], feed_id: [u8; 32], inverted: bool, enabled: bool) {
        let ix = self.admin_ix(
            merces_registry::accounts::SetFxPair {
                config: config_pda(),
                admin: self.admin.pubkey(),
                fx_pair: fx_config_pda(&pair_id),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_registry::instruction::SetFxPair {
                pair_id,
                feed_id,
                inverted,
                crosscheck: Pubkey::default(),
                enabled,
            }
            .data(),
        );
        let admin = self.admin.insecure_clone();
        self.send_ok(&[ix], &[&admin]);
    }

    /// Issuer-chosen terms used across the tests: 100 units at a 1 000 USDC reserve, min raise
    /// 50 000 USDC, defaults for everything else, immediate 50% release and 50% after one year.
    pub fn default_series_args(terms_commitment: [u8; 32]) -> CreateSeriesArgs {
        let d = Parameters::DEFAULT;
        CreateSeriesArgs {
            units_offered: 100,
            reserve_price: 1_000 * ONE_USDC,
            min_raise: 50_000 * ONE_USDC,
            cap_multiple_wad: d.cap_multiple_wad,
            hurdle_rate_wad: d.hurdle_rate_wad,
            payout_multiple_k: d.payout_multiple_k,
            lockup_seconds: d.lockup_seconds,
            wallet_cap_bps: d.wallet_cap_bps,
            commit_duration: d.commit_duration,
            reveal_duration: d.reveal_duration,
            window_commit_duration: d.window_commit_duration,
            window_reveal_duration: d.window_reveal_duration,
            release_schedule: vec![
                TrancheData { at_offset_seconds: 0, bps: 5_000 },
                TrancheData {
                    at_offset_seconds: merces_common::time::YEAR,
                    bps: 5_000,
                },
            ],
            terms_commitment,
            tier_flags: 0b0111,
            fx_pair_id: [0u8; 32],
            mode: 0,
            issuer_accepts_public_price: false,
            metadata_uri: "https://merces.example/heu/0.json".to_string(),
        }
    }

    pub fn create_series_ix(&self, issuer: &Pubkey, stablecoin: &Pubkey, fx_pair: Option<Pubkey>, args: CreateSeriesArgs) -> (Instruction, Pubkey) {
        let cfg = self.config();
        let series = series_pda(cfg.series_count);
        let ix = Instruction {
            program_id: merces_registry::ID,
            accounts: merces_registry::accounts::CreateSeries {
                config: config_pda(),
                issuer_wallet: *issuer,
                issuer: issuer_pda(issuer),
                allowlist_entry: allow_pda(issuer),
                stablecoin_mint: *stablecoin,
                fx_pair,
                series,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data: merces_registry::instruction::CreateSeries { args }.data(),
        };
        (ix, series)
    }

    pub fn create_series(&mut self, issuer: &Keypair, stablecoin: &Pubkey, args: CreateSeriesArgs) -> Pubkey {
        let (ix, series) = self.create_series_ix(&issuer.pubkey(), stablecoin, None, args);
        self.send_ok(&[ix], &[issuer]);
        series
    }

    pub fn set_contract_hash(&mut self, issuer: &Keypair, series: &Pubkey, hash: [u8; 32]) -> TxResult {
        let ix = Instruction {
            program_id: merces_registry::ID,
            accounts: merces_registry::accounts::IssuerSeries {
                issuer_wallet: issuer.pubkey(),
                series: *series,
            }
            .to_account_metas(None),
            data: merces_registry::instruction::SetContractHash { hash }.data(),
        };
        self.send(&[ix], &[issuer])
    }

    pub fn amend_terms_ix(&self, issuer: &Pubkey, series: &Pubkey, new_tc: [u8; 32], new_cap: u64, attestor_addr: [u8; 20], sig: [u8; 65]) -> Instruction {
        Instruction {
            program_id: merces_registry::ID,
            accounts: merces_registry::accounts::AmendTerms {
                config: config_pda(),
                issuer_wallet: *issuer,
                series: *series,
                attestor: attestor_pda(&attestor_addr),
            }
            .to_account_metas(None),
            data: merces_registry::instruction::AmendTerms {
                new_terms_commitment: new_tc,
                new_cap_multiple_wad: new_cap,
                attestor_addr,
                attestor_sig: sig,
            }
            .data(),
        }
    }

    /// Registers an issuer, allowlists it, creates a series on `stablecoin` and sets the contract
    /// hash. Returns the series key.
    pub fn setup_series(&mut self, issuer: &Keypair, stablecoin: &Pubkey, args: CreateSeriesArgs) -> Pubkey {
        self.register_issuer(&issuer.pubkey());
        self.allow(&issuer.pubkey(), true);
        let series = self.create_series(issuer, stablecoin, args);
        self.set_contract_hash(issuer, &series, [7u8; 32]).unwrap();
        series
    }

    // ------------------------------------------------------------------ protocol: raise

    fn pix(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: merces_protocol::ID,
            accounts,
            data,
        }
    }

    pub fn prepare_raise_ix(&self, issuer: &Pubkey, series: &Pubkey) -> Instruction {
        let s = self.series(series);
        let p = pdas(*series);
        Self::pix(
            merces_protocol::accounts::PrepareRaise {
                issuer: *issuer,
                series: *series,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                vault_auth: p.vault_auth,
                escrow_auth: p.escrow_auth,
                treasury_auth: p.treasury_auth,
                auction: p.auction,
                treasury: p.treasury,
                ledger: p.ledger,
                escrow_token: p.escrow_token,
                treasury_token: p.treasury_token,
                vault_token: p.vault_token,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::PrepareRaise {}.data(),
        )
    }

    pub fn open_raise_ix(&self, issuer: &Pubkey, series: &Pubkey) -> Instruction {
        let p = pdas(*series);
        Self::pix(
            merces_protocol::accounts::OpenRaise {
                issuer: *issuer,
                config: p.config,
                series: *series,
                issuer_allowlist: allow_pda(issuer),
                unit_mint: p.unit_mint,
                auction_auth: p.auction_auth,
                vault_auth: p.vault_auth,
                auction: p.auction,
                extra_account_meta_list: p.extra_metas,
                mint_link: p.mint_link,
                registry_signer: p.registry_signer,
                hook_program: merces_hook::ID,
                registry_program: merces_registry::ID,
                token_2022_program: TOKEN_2022,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::OpenRaise {}.data(),
        )
    }

    pub fn open_raise(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        let a = self.prepare_raise_ix(&issuer.pubkey(), series);
        let b = self.open_raise_ix(&issuer.pubkey(), series);
        self.send(&[a, b], &[issuer])
    }

    pub fn cancel_raise(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::CancelRaise {
                issuer: issuer.pubkey(),
                config: p.config,
                series: *series,
                auction: p.auction,
                registry_signer: p.registry_signer,
                registry_program: merces_registry::ID,
            }
            .to_account_metas(None),
            merces_protocol::instruction::CancelRaise {}.data(),
        );
        self.send(&[ix], &[issuer])
    }

    pub fn commit_bid(&mut self, series: &Pubkey, bidder: &Keypair, commitment: [u8; 32], escrow: u64) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let mut ix = Self::pix(
            merces_protocol::accounts::CommitBid {
                bidder: bidder.pubkey(),
                series: *series,
                bidder_allowlist: allow_pda(&bidder.pubkey()),
                auction: p.auction,
                bid: bid_pda(series, &bidder.pubkey()),
                bidder_stable: self.ata_of(&bidder.pubkey(), &s.stablecoin),
                escrow_token: p.escrow_token,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::CommitBid { commitment, escrow }.data(),
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[ix], &[bidder])
    }

    pub fn reveal_bid(&mut self, series: &Pubkey, bidder: &Keypair, price: u64, quantity: u64, salt: [u8; 32]) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::RevealBid {
                bidder: bidder.pubkey(),
                series: *series,
                auction: p.auction,
                bid: bid_pda(series, &bidder.pubkey()),
            }
            .to_account_metas(None),
            merces_protocol::instruction::RevealBid { price, quantity, salt }.data(),
        );
        self.send(&[ix], &[bidder])
    }

    pub fn begin_settlement(&mut self, series: &Pubkey, price: u64) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::BeginSettlement {
                series: *series,
                auction: p.auction,
            }
            .to_account_metas(None),
            merces_protocol::instruction::BeginSettlement {
                proposed_clearing_price: price,
            }
            .data(),
        );
        self.send(&[ix], &[])
    }

    pub fn tally_bids(&mut self, series: &Pubkey, bidders: &[Pubkey]) -> TxResult {
        let p = pdas(*series);
        let mut ix = Self::pix(
            merces_protocol::accounts::TallyBids {
                series: *series,
                auction: p.auction,
            }
            .to_account_metas(None),
            merces_protocol::instruction::TallyBids {}.data(),
        );
        for b in bidders {
            ix.accounts.push(AccountMeta::new(bid_pda(series, b), false));
        }
        self.send(&[ix], &[])
    }

    pub fn finalize_settlement(&mut self, series: &Pubkey) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::FinalizeSettlement {
                config: p.config,
                series: *series,
                auction: p.auction,
                ledger: p.ledger,
                registry_signer: p.registry_signer,
                registry_program: merces_registry::ID,
            }
            .to_account_metas(None),
            merces_protocol::instruction::FinalizeSettlement {}.data(),
        );
        self.send(&[ix], &[])
    }

    pub fn claim_win(&mut self, series: &Pubkey, bidder: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let create_unit = self.create_ata_ix(bidder, &p.unit_mint);
        let create_stable = self.create_ata_ix(bidder, &s.stablecoin);
        let create_fee = self.create_ata_ix(&self.fee_collector.pubkey(), &s.stablecoin);
        let mut ix = Self::pix(
            merces_protocol::accounts::ClaimWin {
                payer: self.payer.pubkey(),
                config: p.config,
                series: *series,
                auction: p.auction,
                bid: bid_pda(series, bidder),
                treasury: p.treasury,
                ledger: p.ledger,
                holder: holder_pda(series, bidder),
                bidder: *bidder,
                bidder_stable_ata: self.ata_of(bidder, &s.stablecoin),
                bidder_unit_ata: ata(bidder, &p.unit_mint, &TOKEN_2022),
                escrow_token: p.escrow_token,
                treasury_token: p.treasury_token,
                fee_collector_ata: self.ata_of(&self.fee_collector.pubkey(), &s.stablecoin),
                escrow_auth: p.escrow_auth,
                auction_auth: p.auction_auth,
                unit_mint: p.unit_mint,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                token_2022_program: TOKEN_2022,
                registry_signer: p.registry_signer,
                registry_program: merces_registry::ID,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::ClaimWin {}.data(),
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[create_unit, create_stable, create_fee, ix], &[])
    }

    pub fn refund_bid(&mut self, series: &Pubkey, bidder: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let create_stable = self.create_ata_ix(bidder, &s.stablecoin);
        let mut ix = Self::pix(
            merces_protocol::accounts::RefundBid {
                payer: self.payer.pubkey(),
                series: *series,
                auction: p.auction,
                bid: bid_pda(series, bidder),
                bidder: *bidder,
                bidder_stable_ata: self.ata_of(bidder, &s.stablecoin),
                escrow_token: p.escrow_token,
                escrow_auth: p.escrow_auth,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::RefundBid {}.data(),
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[create_stable, ix], &[])
    }

    /// Full settlement at `price`: begin, tally (pages of 24), finalize, then claim/refund every bid.
    pub fn settle(&mut self, series: &Pubkey, price: u64, bidders: &[Pubkey]) -> TxResult {
        self.begin_settlement(series, price)?;
        for page in bidders.chunks(24) {
            self.tally_bids(series, page)?;
        }
        let res = self.finalize_settlement(series)?;
        let a = self.auction(series);
        for b in bidders {
            if a.state == pstate::RAISE_SETTLED {
                self.claim_win(series, b)?;
            } else {
                self.refund_bid(series, b)?;
            }
        }
        Ok(res)
    }

    // ------------------------------------------------------------------ protocol: treasury

    pub fn claim_release(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let create = self.create_ata_ix(&issuer.pubkey(), &s.stablecoin);
        let mut ix = Self::pix(
            merces_protocol::accounts::ClaimRelease {
                issuer: issuer.pubkey(),
                series: *series,
                treasury: p.treasury,
                ledger: p.ledger,
                treasury_token: p.treasury_token,
                treasury_auth: p.treasury_auth,
                issuer_stable: self.ata_of(&issuer.pubkey(), &s.stablecoin),
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
            }
            .to_account_metas(None),
            merces_protocol::instruction::ClaimRelease {}.data(),
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[create, ix], &[issuer])
    }

    pub fn set_release_pause(&mut self, issuer: &Keypair, series: &Pubkey, paused: bool) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::SetReleasePause {
                issuer: issuer.pubkey(),
                series: *series,
                treasury: p.treasury,
            }
            .to_account_metas(None),
            merces_protocol::instruction::SetReleasePause { paused }.data(),
        );
        self.send(&[ix], &[issuer])
    }

    pub fn request_early_draw(&mut self, issuer: &Keypair, approver: &Keypair, series: &Pubkey, amount: u64) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let create = self.create_ata_ix(&issuer.pubkey(), &s.stablecoin);
        let mut ix = Self::pix(
            merces_protocol::accounts::RequestEarlyDraw {
                issuer: issuer.pubkey(),
                approver: approver.pubkey(),
                config: p.config,
                series: *series,
                treasury: p.treasury,
                ledger: p.ledger,
                treasury_token: p.treasury_token,
                treasury_auth: p.treasury_auth,
                issuer_stable: self.ata_of(&issuer.pubkey(), &s.stablecoin),
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
            }
            .to_account_metas(None),
            merces_protocol::instruction::RequestEarlyDraw { amount }.data(),
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[create, ix], &[issuer, approver])
    }

    // ------------------------------------------------------------------ protocol: repayment

    pub fn submit_report_ix(&self, issuer: &Pubkey, series: &Pubkey, args: merces_protocol::income::SubmitReportArgs, attestation_key: Pubkey, fx_attestor_key: Pubkey, fx_pair: Option<[u8; 32]>) -> Instruction {
        let p = pdas(*series);
        let (fx_start, fx_end) = match fx_pair {
            Some(pair) => (Some(fx_checkpoint_pda(&pair, args.period)), Some(fx_checkpoint_pda(&pair, args.period + 1))),
            None => (None, None),
        };
        Self::pix(
            merces_protocol::accounts::SubmitReport {
                issuer: *issuer,
                config: p.config,
                series: *series,
                ledger: p.ledger,
                report: report_pda(series, args.period),
                unit_mint: p.unit_mint,
                attestation_key,
                fx_attestor_key,
                fx_start,
                fx_end,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::SubmitReport { args }.data(),
        )
    }

    /// `pay` / `pay_trueup` shared accounts.
    pub fn pay_ix(&self, payer: &Pubkey, series: &Pubkey, period: Option<u32>, trueup: bool) -> Vec<Instruction> {
        let s = self.series(series);
        let p = pdas(*series);
        let create_issuer = self.create_ata_ix(&s.issuer, &s.stablecoin);
        let create_fee = self.create_ata_ix(&self.fee_collector.pubkey(), &s.stablecoin);
        let accounts = merces_protocol::accounts::Pay {
            payer: *payer,
            config: p.config,
            series: *series,
            ledger: p.ledger,
            report: period.map(|per| report_pda(series, per)),
            payer_stable: self.ata_of(payer, &s.stablecoin),
            vault_token: p.vault_token,
            vault_auth: p.vault_auth,
            issuer: s.issuer,
            issuer_stable_ata: self.ata_of(&s.issuer, &s.stablecoin),
            fee_collector_ata: self.ata_of(&self.fee_collector.pubkey(), &s.stablecoin),
            unit_mint: p.unit_mint,
            stablecoin_mint: s.stablecoin,
            stablecoin_program: s.stablecoin_program,
            registry_signer: p.registry_signer,
            registry_program: merces_registry::ID,
            system_program: SYSTEM_PROGRAM,
        };
        let data = if trueup {
            merces_protocol::instruction::PayTrueup {}.data()
        } else {
            merces_protocol::instruction::Pay {}.data()
        };
        let mut ix = Self::pix(accounts.to_account_metas(None), data);
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        vec![create_issuer, create_fee, ix]
    }

    pub fn pay(&mut self, payer: &Keypair, series: &Pubkey) -> TxResult {
        let l = self.ledger(series);
        let period = l.open_due_period();
        let ixs = self.pay_ix(&payer.pubkey(), series, period, false);
        self.send(&ixs, &[payer])
    }

    pub fn pay_trueup(&mut self, payer: &Keypair, series: &Pubkey) -> TxResult {
        let ixs = self.pay_ix(&payer.pubkey(), series, None, true);
        self.send(&ixs, &[payer])
    }

    pub fn crank_status(&mut self, series: &Pubkey) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::CrankStatus {
                series: *series,
                ledger: p.ledger,
            }
            .to_account_metas(None),
            merces_protocol::instruction::CrankStatus {}.data(),
        );
        self.send(&[ix], &[])
    }

    pub fn request_pause(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::RequestPause {
                issuer: issuer.pubkey(),
                series: *series,
                ledger: p.ledger,
            }
            .to_account_metas(None),
            merces_protocol::instruction::RequestPause {}.data(),
        );
        self.send(&[ix], &[issuer])
    }

    pub fn approve_pause(&mut self, series: &Pubkey, pause_end: u64, attestor_addr: [u8; 20], sig: [u8; 65]) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::ApprovePause {
                config: p.config,
                series: *series,
                ledger: p.ledger,
                attestor_key: attestor_pda(&attestor_addr),
            }
            .to_account_metas(None),
            merces_protocol::instruction::ApprovePause {
                pause_end,
                attestor_addr,
                attestor_sig: sig,
            }
            .data(),
        );
        self.send(&[ix], &[])
    }

    pub fn end_pause(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::EndPause {
                issuer: issuer.pubkey(),
                series: *series,
                ledger: p.ledger,
            }
            .to_account_metas(None),
            merces_protocol::instruction::EndPause {}.data(),
        );
        self.send(&[ix], &[issuer])
    }

    pub fn submit_trueup(&mut self, issuer: &Keypair, series: &Pubkey, year: u16, adjustment: i64, attestation_ts: u64, attestor_addr: [u8; 20], sig: [u8; 65]) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::SubmitTrueUp {
                issuer: issuer.pubkey(),
                config: p.config,
                series: *series,
                ledger: p.ledger,
                attestor_key: attestor_pda(&attestor_addr),
            }
            .to_account_metas(None),
            merces_protocol::instruction::SubmitTrueup {
                year,
                adjustment,
                attestation_ts,
                attestor_addr,
                attestor_sig: sig,
            }
            .data(),
        );
        self.send(&[ix], &[issuer])
    }

    // ------------------------------------------------------------------ protocol: claims

    pub fn register_holder(&mut self, series: &Pubkey, wallet: &Pubkey) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::RegisterHolder {
                payer: self.payer.pubkey(),
                series: *series,
                ledger: p.ledger,
                allowlist_entry: allow_pda(wallet),
                holder: holder_pda(series, wallet),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::RegisterHolder { wallet: *wallet }.data(),
        );
        self.send(&[ix], &[])
    }

    fn holder_claim_ixs(&self, series: &Pubkey, holder: &Pubkey, data: Vec<u8>) -> Vec<Instruction> {
        let s = self.series(series);
        let p = pdas(*series);
        let create_unit = self.create_ata_ix(holder, &p.unit_mint);
        let create_stable = self.create_ata_ix(holder, &s.stablecoin);
        let mut ix = Self::pix(
            merces_protocol::accounts::HolderClaim {
                payer: self.payer.pubkey(),
                series: *series,
                ledger: p.ledger,
                holder: holder_pda(series, holder),
                holder_wallet: *holder,
                holder_unit_ata: ata(holder, &p.unit_mint, &TOKEN_2022),
                holder_stable_ata: self.ata_of(holder, &s.stablecoin),
                vault_token: p.vault_token,
                vault_auth: p.vault_auth,
                unit_mint: p.unit_mint,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                token_2022_program: TOKEN_2022,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            data,
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        vec![create_unit, create_stable, ix]
    }

    pub fn claim(&mut self, series: &Pubkey, holder: &Pubkey) -> TxResult {
        let ixs = self.holder_claim_ixs(series, holder, merces_protocol::instruction::Claim {}.data());
        self.send(&ixs, &[])
    }
    pub fn burn_retired(&mut self, series: &Pubkey, holder: &Pubkey) -> TxResult {
        let ixs = self.holder_claim_ixs(series, holder, merces_protocol::instruction::BurnRetired {}.data());
        self.send(&ixs, &[])
    }
    pub fn claim_redemption(&mut self, series: &Pubkey, holder: &Pubkey) -> TxResult {
        let ixs = self.holder_claim_ixs(series, holder, merces_protocol::instruction::ClaimRedemption {}.data());
        self.send(&ixs, &[])
    }
    pub fn claim_tail(&mut self, series: &Pubkey, holder: &Pubkey) -> TxResult {
        let ixs = self.holder_claim_ixs(series, holder, merces_protocol::instruction::ClaimTail {}.data());
        self.send(&ixs, &[])
    }
    pub fn claim_final(&mut self, series: &Pubkey, holder: &Pubkey) -> TxResult {
        let ixs = self.holder_claim_ixs(series, holder, merces_protocol::instruction::ClaimFinal {}.data());
        self.send(&ixs, &[])
    }

    // ------------------------------------------------------------------ protocol: router, fx, exit

    pub fn init_router(&mut self, issuer: &Keypair, series: &Pubkey, theta: u64, r_wad: u64) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::InitRouter {
                issuer: issuer.pubkey(),
                series: *series,
                router: p.router,
                router_auth: p.router_auth,
                router_token: p.router_token,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::InitRouter { theta, r_wad }.data(),
        );
        self.send(&[ix], &[issuer])
    }

    pub fn route(&mut self, series: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let create_issuer = self.create_ata_ix(&s.issuer, &s.stablecoin);
        let create_fee = self.create_ata_ix(&self.fee_collector.pubkey(), &s.stablecoin);
        let mut ix = Self::pix(
            merces_protocol::accounts::Route {
                payer: self.payer.pubkey(),
                config: p.config,
                series: *series,
                ledger: p.ledger,
                router: p.router,
                router_auth: p.router_auth,
                router_token: p.router_token,
                vault_token: p.vault_token,
                vault_auth: p.vault_auth,
                issuer: s.issuer,
                issuer_stable_ata: self.ata_of(&s.issuer, &s.stablecoin),
                fee_collector_ata: self.ata_of(&self.fee_collector.pubkey(), &s.stablecoin),
                unit_mint: p.unit_mint,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                registry_signer: p.registry_signer,
                registry_program: merces_registry::ID,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::Route {}.data(),
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[create_issuer, create_fee, ix], &[])
    }

    pub fn redeem(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let mut ix = Self::pix(
            merces_protocol::accounts::Redeem {
                issuer: issuer.pubkey(),
                config: p.config,
                series: *series,
                ledger: p.ledger,
                treasury: p.treasury,
                issuer_stable: self.ata_of(&issuer.pubkey(), &s.stablecoin),
                vault_token: p.vault_token,
                unit_mint: p.unit_mint,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                registry_signer: p.registry_signer,
                registry_program: merces_registry::ID,
            }
            .to_account_metas(None),
            merces_protocol::instruction::Redeem {}.data(),
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[ix], &[issuer])
    }

    pub fn extinguish(&mut self, series: &Pubkey, a: ([u8; 20], [u8; 65]), b: ([u8; 20], [u8; 65])) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let mut ix = Self::pix(
            merces_protocol::accounts::Extinguish {
                payer: self.payer.pubkey(),
                config: p.config,
                series: *series,
                ledger: p.ledger,
                treasury: p.treasury,
                treasury_token: p.treasury_token,
                treasury_auth: p.treasury_auth,
                vault_token: p.vault_token,
                unit_mint: p.unit_mint,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                attestor_key_a: attestor_pda(&a.0),
                attestor_key_b: attestor_pda(&b.0),
                registry_signer: p.registry_signer,
                registry_program: merces_registry::ID,
            }
            .to_account_metas(None),
            merces_protocol::instruction::Extinguish {
                attestor_a: a.0,
                sig_a: a.1,
                attestor_b: b.0,
                sig_b: b.1,
            }
            .data(),
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[ix], &[])
    }

    // ------------------------------------------------------------------ protocol: window

    pub fn open_window(&mut self, series: &Pubkey, period: u32) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::OpenWindow {
                payer: self.payer.pubkey(),
                config: p.config,
                series: *series,
                ledger: p.ledger,
                window: window_pda(series, period),
                window_escrow: p.window_escrow,
                window_units: p.window_units,
                window_stable: p.window_stable,
                unit_mint: p.unit_mint,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                token_2022_program: TOKEN_2022,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::OpenWindow { period }.data(),
        );
        self.send(&[ix], &[])
    }

    pub fn commit_ask(&mut self, series: &Pubkey, period: u32, owner: &Keypair, commitment: [u8; 32], units: u64) -> TxResult {
        let p = pdas(*series);
        let mut ix = Self::pix(
            merces_protocol::accounts::CommitAsk {
                owner: owner.pubkey(),
                series: *series,
                ledger: p.ledger,
                window: window_pda(series, period),
                order: order_pda(series, period, &owner.pubkey(), pstate::SIDE_ASK),
                holder: holder_pda(series, &owner.pubkey()),
                owner_unit_ata: ata(&owner.pubkey(), &p.unit_mint, &TOKEN_2022),
                window_units: p.window_units,
                unit_mint: p.unit_mint,
                token_2022_program: TOKEN_2022,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::CommitAsk { commitment, units }.data(),
        );
        ix.accounts.extend(self.unit_hook_accounts(series, &owner.pubkey(), &p.window_escrow));
        self.send(&[ix], &[owner])
    }

    pub fn window_commit_bid(&mut self, series: &Pubkey, period: u32, owner: &Keypair, commitment: [u8; 32], escrow: u64) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let mut ix = Self::pix(
            merces_protocol::accounts::WindowCommitBid {
                owner: owner.pubkey(),
                series: *series,
                owner_allowlist: allow_pda(&owner.pubkey()),
                window: window_pda(series, period),
                order: order_pda(series, period, &owner.pubkey(), pstate::SIDE_BID),
                owner_stable: self.ata_of(&owner.pubkey(), &s.stablecoin),
                window_stable: p.window_stable,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::WindowCommitBid { commitment, escrow }.data(),
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[ix], &[owner])
    }

    pub fn reveal_order(&mut self, series: &Pubkey, period: u32, owner: &Keypair, side: u8, price: u64, quantity: u64, salt: [u8; 32]) -> TxResult {
        let p = pdas(*series);
        let create = self.create_ata_ix(&owner.pubkey(), &p.unit_mint);
        let ix = Self::pix(
            merces_protocol::accounts::RevealOrder {
                owner: owner.pubkey(),
                series: *series,
                window: window_pda(series, period),
                order: order_pda(series, period, &owner.pubkey(), side),
                owner_unit_ata: ata(&owner.pubkey(), &p.unit_mint, &TOKEN_2022),
                unit_mint: p.unit_mint,
                token_2022_program: TOKEN_2022,
            }
            .to_account_metas(None),
            merces_protocol::instruction::RevealOrder {
                side,
                price,
                quantity,
                salt,
            }
            .data(),
        );
        self.send(&[create, ix], &[owner])
    }

    fn window_settle_ix(&self, series: &Pubkey, period: u32, data: Vec<u8>) -> Instruction {
        let p = pdas(*series);
        Self::pix(
            merces_protocol::accounts::WindowSettle {
                series: *series,
                ledger: p.ledger,
                window: window_pda(series, period),
            }
            .to_account_metas(None),
            data,
        )
    }

    pub fn begin_window_settlement(&mut self, series: &Pubkey, period: u32, price: u64, no_match: bool) -> TxResult {
        let ix = self.window_settle_ix(
            series,
            period,
            merces_protocol::instruction::BeginWindowSettlement {
                clearing_price: price,
                no_match,
            }
            .data(),
        );
        self.send(&[ix], &[])
    }

    pub fn tally_orders(&mut self, series: &Pubkey, period: u32, orders: &[(Pubkey, u8)]) -> TxResult {
        let mut ix = self.window_settle_ix(series, period, merces_protocol::instruction::TallyOrders {}.data());
        for (owner, side) in orders {
            ix.accounts.push(AccountMeta::new(order_pda(series, period, owner, *side), false));
        }
        self.send(&[ix], &[])
    }

    pub fn finalize_window(&mut self, series: &Pubkey, period: u32) -> TxResult {
        let ix = self.window_settle_ix(series, period, merces_protocol::instruction::FinalizeWindow {}.data());
        self.send(&[ix], &[])
    }

    pub fn process_order(&mut self, series: &Pubkey, period: u32, owner: &Pubkey, side: u8) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let create_unit = self.create_ata_ix(owner, &p.unit_mint);
        let create_stable = self.create_ata_ix(owner, &s.stablecoin);
        let create_fee = self.create_ata_ix(&self.fee_collector.pubkey(), &s.stablecoin);
        let mut ix = Self::pix(
            merces_protocol::accounts::ProcessOrder {
                payer: self.payer.pubkey(),
                config: p.config,
                series: *series,
                ledger: p.ledger,
                window: window_pda(series, period),
                order: order_pda(series, period, owner, side),
                owner: *owner,
                holder: holder_pda(series, owner),
                owner_unit_ata: ata(owner, &p.unit_mint, &TOKEN_2022),
                owner_stable_ata: self.ata_of(owner, &s.stablecoin),
                window_units: p.window_units,
                window_stable: p.window_stable,
                window_escrow: p.window_escrow,
                fee_collector_ata: self.ata_of(&self.fee_collector.pubkey(), &s.stablecoin),
                unit_mint: p.unit_mint,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                token_2022_program: TOKEN_2022,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::ProcessOrder {}.data(),
        );
        ix.accounts.extend(self.unit_hook_accounts(series, &p.window_escrow, owner));
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[create_unit, create_stable, create_fee, ix], &[])
    }

    pub fn return_dust(&mut self, series: &Pubkey, period: u32, asks: &[Pubkey]) -> TxResult {
        let mut ix = Self::pix(
            merces_protocol::accounts::ReturnDust {
                series: *series,
                window: window_pda(series, period),
            }
            .to_account_metas(None),
            merces_protocol::instruction::ReturnDust {}.data(),
        );
        for owner in asks {
            ix.accounts.push(AccountMeta::new(order_pda(series, period, owner, pstate::SIDE_ASK), false));
        }
        self.send(&[ix], &[])
    }
}
