//! LiteSVM harness: loads the four compiled programs, creates the mock stablecoins and provides
//! instruction builders for every registry and protocol instruction (SPEC v1.1).

use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{
    AccountDeserialize, AnchorSerialize, Discriminator, InstructionData, ToAccountMetas,
};
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use merces_common::encoding::{commitment_preimage, fx_pair_id_preimage};
use merces_common::params::Parameters;
use merces_protocol::income::SubmitReportArgs;
use merces_protocol::state::{
    self as pstate, seeds as pseeds, Auction, Bid, FxCheckpoint, FxPair, Holder, Ledger, Order,
    Report, Router, Treasury, Window,
};
use merces_registry::state::{
    AllowlistEntry, FxPairConfig, ParametersData, ProtocolConfig, Series, Tier1Terms, TrancheData,
};
use merces_registry::CreateSeriesArgs;
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
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
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/deploy")
        .join(format!("{name}.so"))
}

/// Seeds shared with the programs (re-exported for the tests).
pub mod merces_onchain_seeds {
    pub use merces_onchain::seeds::*;
}

/// All PDAs of one series.
#[derive(Debug, Clone)]
pub struct Pdas {
    pub series: Pubkey,
    pub config: Pubkey,
    pub registry_authority: Pubkey,
    pub auction: Pubkey,
    pub treasury: Pubkey,
    pub ledger: Pubkey,
    pub unit_mint: Pubkey,
    pub auction_auth: Pubkey,
    pub vault_auth: Pubkey,
    pub escrow_auth: Pubkey,
    pub treasury_auth: Pubkey,
    pub router_auth: Pubkey,
    pub auction_escrow_auth: Pubkey,
    pub auction_escrow_ata: Pubkey,
    pub window_escrow_auth: Pubkey,
    pub window_escrow_ata: Pubkey,
    pub escrow_token: Pubkey,
    pub treasury_token: Pubkey,
    pub vault_token: Pubkey,
    pub router: Pubkey,
    pub router_token: Pubkey,
    pub window_stable: Pubkey,
    pub extra_metas: Pubkey,
    pub escrow_arm: Pubkey,
}

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[merces_onchain_seeds::CONFIG], &merces_registry::ID).0
}
pub fn registry_authority_pda() -> Pubkey {
    Pubkey::find_program_address(&[pseeds::REGISTRY_AUTHORITY], &merces_protocol::ID).0
}
pub fn allow_pda(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[merces_onchain_seeds::ALLOW, wallet.as_ref()],
        &merces_registry::ID,
    )
    .0
}
pub fn issuer_pda(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[merces_onchain_seeds::ISSUER, wallet.as_ref()],
        &merces_registry::ID,
    )
    .0
}
pub fn attestor_pda(addr: &[u8; 20]) -> Pubkey {
    Pubkey::find_program_address(
        &[merces_onchain_seeds::ATTESTOR, addr],
        &merces_registry::ID,
    )
    .0
}
pub fn verifier_pda(addr: &[u8; 20]) -> Pubkey {
    Pubkey::find_program_address(
        &[merces_onchain_seeds::VERIFIER, addr],
        &merces_registry::ID,
    )
    .0
}
pub fn fx_config_pda(pair: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[merces_onchain_seeds::FX, pair], &merces_registry::ID).0
}
pub fn series_pda(series_id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[merces_onchain_seeds::SERIES, &series_id.to_le_bytes()],
        &merces_registry::ID,
    )
    .0
}
pub fn bid_pda(series: &Pubkey, bidder: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[pseeds::BID, series.as_ref(), bidder.as_ref()],
        &merces_protocol::ID,
    )
    .0
}
pub fn holder_pda(series: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[pseeds::HOLDER, series.as_ref(), wallet.as_ref()],
        &merces_protocol::ID,
    )
    .0
}
pub fn report_pda(series: &Pubkey, period: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[pseeds::REPORT, series.as_ref(), &period.to_le_bytes()],
        &merces_protocol::ID,
    )
    .0
}
pub fn window_pda(series: &Pubkey, period: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[pseeds::WINDOW, series.as_ref(), &period.to_le_bytes()],
        &merces_protocol::ID,
    )
    .0
}
pub fn order_pda(series: &Pubkey, period: u32, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            pseeds::ORDER,
            series.as_ref(),
            &period.to_le_bytes(),
            owner.as_ref(),
        ],
        &merces_protocol::ID,
    )
    .0
}
pub fn fx_pair_pda(pair: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[pseeds::FX_PAIR, pair], &merces_protocol::ID).0
}
pub fn fx_checkpoint_pda(pair: &[u8; 32], period: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[pseeds::FX_CHECKPOINT, pair, &period.to_le_bytes()],
        &merces_protocol::ID,
    )
    .0
}
pub fn mock_hook_extra_metas(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[mock_usdg_hook::EXTRA_ACCOUNT_METAS_SEED, mint.as_ref()],
        &mock_usdg_hook::ID,
    )
    .0
}
pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    anchor_spl::associated_token::get_associated_token_address_with_program_id(
        owner,
        mint,
        token_program,
    )
}
/// `pair_id = keccak256(feed_id ‖ inverted_u8)` (SPEC §3.1).
pub fn fx_pair_id(feed_id: &[u8; 32], inverted: bool) -> [u8; 32] {
    keccak(&[fx_pair_id_preimage(feed_id, inverted).as_bytes()])
}

pub fn pdas(series: Pubkey) -> Pdas {
    let p = |seed: &[u8]| {
        Pubkey::find_program_address(&[seed, series.as_ref()], &merces_protocol::ID).0
    };
    let unit_mint = p(pseeds::UNIT_MINT);
    let auction_escrow_auth = p(pseeds::AUCTION_ESCROW);
    let window_escrow_auth = p(pseeds::WINDOW_ESCROW);
    Pdas {
        series,
        config: config_pda(),
        registry_authority: registry_authority_pda(),
        auction: p(pseeds::AUCTION),
        treasury: p(pseeds::TREASURY),
        ledger: p(pseeds::LEDGER),
        unit_mint,
        auction_auth: p(pseeds::AUCTION_AUTH),
        vault_auth: p(pseeds::VAULT_AUTH),
        escrow_auth: p(pseeds::ESCROW_AUTH),
        treasury_auth: p(pseeds::TREASURY_AUTH),
        router_auth: p(pseeds::ROUTER_AUTH),
        auction_escrow_auth,
        auction_escrow_ata: ata(&auction_escrow_auth, &unit_mint, &TOKEN_2022),
        window_escrow_auth,
        window_escrow_ata: ata(&window_escrow_auth, &unit_mint, &TOKEN_2022),
        escrow_token: p(pseeds::ESCROW_TOKEN),
        treasury_token: p(pseeds::TREASURY_TOKEN),
        vault_token: p(pseeds::VAULT_TOKEN),
        router: p(pseeds::ROUTER),
        router_token: p(pseeds::ROUTER_TOKEN),
        window_stable: p(pseeds::WINDOW_STABLE),
        extra_metas: Pubkey::find_program_address(
            &[merces_hook::EXTRA_ACCOUNT_METAS_SEED, unit_mint.as_ref()],
            &merces_hook::ID,
        )
        .0,
        escrow_arm: Pubkey::find_program_address(
            &[pseeds::ESCROW_ARM, unit_mint.as_ref()],
            &merces_protocol::ID,
        )
        .0,
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
        svm.add_program_from_file(merces_registry::ID, deploy_path("merces_registry"))
            .expect("registry .so");
        svm.add_program_from_file(merces_hook::ID, deploy_path("merces_hook"))
            .expect("hook .so");
        svm.add_program_from_file(merces_protocol::ID, deploy_path("merces_protocol"))
            .expect("protocol .so");
        svm.add_program_from_file(mock_usdg_hook::ID, deploy_path("mock_usdg_hook"))
            .expect("mock hook .so");
        let payer = Keypair::new();
        let admin = Keypair::new();
        let allowlist_manager = Keypair::new();
        let fee_collector = Keypair::new();
        let mint_authority = Keypair::new();
        for k in [
            &payer,
            &admin,
            &allowlist_manager,
            &fee_collector,
            &mint_authority,
        ] {
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
            if s.pubkey() != payer_pk && !keypairs.iter().any(|k| k.pubkey() == s.pubkey()) {
                keypairs.push(s);
            }
        }
        let tx = Transaction::new_signed_with_payer(
            &all,
            Some(&payer_pk),
            &keypairs,
            self.svm.latest_blockhash(),
        );
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res
    }

    pub fn send_ok(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionMetadata {
        match self.send(ixs, signers) {
            Ok(m) => m,
            Err(e) => panic!(
                "transaction failed: {:?}\n{}",
                e.err,
                e.meta.logs.join("\n")
            ),
        }
    }

    /// Sends and asserts the failure carries the given custom error code.
    pub fn send_expect(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
        code: u32,
    ) -> FailedTransactionMetadata {
        match self.send(ixs, signers) {
            Ok(m) => panic!(
                "expected error {code}, transaction succeeded:\n{}",
                m.logs.join("\n")
            ),
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
        self.svm
            .get_account(key)
            .filter(|a| !a.data.is_empty())
            .map(|a| a.data)
    }

    pub fn exists(&self, key: &Pubkey) -> bool {
        self.account_data(key).is_some()
    }

    pub fn load<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let data = self
            .account_data(key)
            .unwrap_or_else(|| panic!("account {key} missing"));
        T::try_deserialize(&mut &data[..]).expect("deserialize")
    }

    pub fn load_opt<T: AccountDeserialize>(&self, key: &Pubkey) -> Option<T> {
        self.account_data(key)
            .and_then(|d| T::try_deserialize(&mut &d[..]).ok())
    }

    pub fn config(&self) -> ProtocolConfig {
        self.load(&config_pda())
    }
    pub fn series(&self, series: &Pubkey) -> Series {
        self.load(series)
    }
    pub fn allowlist(&self, wallet: &Pubkey) -> Option<AllowlistEntry> {
        self.load_opt(&allow_pda(wallet))
    }
    pub fn fx_config(&self, pair: &[u8; 32]) -> Option<FxPairConfig> {
        self.load_opt(&fx_config_pda(pair))
    }
    pub fn auction(&self, series: &Pubkey) -> Option<Auction> {
        self.load_opt(&pdas(*series).auction)
    }
    pub fn treasury(&self, series: &Pubkey) -> Option<Treasury> {
        self.load_opt(&pdas(*series).treasury)
    }
    pub fn bid(&self, series: &Pubkey, bidder: &Pubkey) -> Option<Bid> {
        self.load_opt(&bid_pda(series, bidder))
    }
    pub fn holder(&self, series: &Pubkey, wallet: &Pubkey) -> Option<Holder> {
        self.load_opt(&holder_pda(series, wallet))
    }
    pub fn report(&self, series: &Pubkey, period: u32) -> Option<Report> {
        self.load_opt(&report_pda(series, period))
    }
    pub fn window(&self, series: &Pubkey, period: u32) -> Option<Window> {
        self.load_opt(&window_pda(series, period))
    }
    pub fn order(&self, series: &Pubkey, period: u32, owner: &Pubkey) -> Option<Order> {
        self.load_opt(&order_pda(series, period, owner))
    }
    pub fn router(&self, series: &Pubkey) -> Option<Router> {
        self.load_opt(&pdas(*series).router)
    }
    pub fn fx_pair(&self, pair: &[u8; 32]) -> Option<FxPair> {
        self.load_opt(&fx_pair_pda(pair))
    }
    pub fn fx_checkpoint(&self, pair: &[u8; 32], period: u32) -> Option<FxCheckpoint> {
        self.load_opt(&fx_checkpoint_pda(pair, period))
    }
    pub fn ledger(&self, series: &Pubkey) -> Option<Ledger> {
        let data = self.account_data(&pdas(*series).ledger)?;
        Some(bytemuck::pod_read_unaligned::<Ledger>(
            &data[8..8 + core::mem::size_of::<Ledger>()],
        ))
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
        // classic SPL mint layout (`Mint::LEN`)
        let space = 82usize;
        let lamports = self.svm.minimum_balance_for_rent_exemption(space);
        let ixs = [
            solana_system_interface::instruction::create_account(
                &self.payer.pubkey(),
                &mint.pubkey(),
                lamports,
                space as u64,
                &TOKEN_CLASSIC,
            ),
            spl_token_interface::instruction::initialize_mint2(
                &TOKEN_CLASSIC,
                &mint.pubkey(),
                &self.mint_authority.pubkey(),
                None,
                USDC_DECIMALS,
            )
            .unwrap(),
        ];
        self.send_ok(&ixs, &[&mint]);
        mint.pubkey()
    }

    /// Token-2022 mint with TransferHook → mock_usdg_hook, TransferFeeConfig 0/0 and
    /// MetadataPointer (ASSUMPTIONS A24). Token-2022 refuses `ConfidentialTransferMint` next to a
    /// `TransferFeeConfig` without a `ConfidentialTransferFeeConfig`, so the mock leaves
    /// confidential transfers out; the programs never touch that extension.
    fn create_usdg_mint(&mut self) -> Pubkey {
        let mint = Keypair::new();
        let auth = self.mint_authority.pubkey();
        let space = ExtensionType::try_calculate_account_len::<MintState>(&[
            ExtensionType::TransferHook,
            ExtensionType::TransferFeeConfig,
            ExtensionType::MetadataPointer,
        ])
        .unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(space);
        let mk = mint.pubkey();
        let ixs = [
            solana_system_interface::instruction::create_account(
                &self.payer.pubkey(),
                &mk,
                lamports,
                space as u64,
                &TOKEN_2022,
            ),
            spl_token_2022::extension::transfer_hook::instruction::initialize(
                &TOKEN_2022,
                &mk,
                Some(auth),
                Some(mock_usdg_hook::ID),
            )
            .unwrap(),
            spl_token_2022::extension::transfer_fee::instruction::initialize_transfer_fee_config(
                &TOKEN_2022,
                &mk,
                Some(&auth),
                Some(&auth),
                0,
                0,
            )
            .unwrap(),
            spl_token_2022::extension::metadata_pointer::instruction::initialize(
                &TOKEN_2022,
                &mk,
                Some(auth),
                Some(mk),
            )
            .unwrap(),
            spl_token_2022::instruction::initialize_mint2(
                &TOKEN_2022,
                &mk,
                &auth,
                None,
                USDC_DECIMALS,
            )
            .unwrap(),
        ];
        self.send_ok(&ixs, &[&mint]);
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
        let ix = self.create_ata_ix(owner, mint);
        self.send_ok(&[ix], &[]);
        self.ata_of(owner, mint)
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
            spl_token_interface::instruction::mint_to(
                &tp,
                mint,
                &acc,
                &self.mint_authority.pubkey(),
                &[],
                amount,
            )
            .unwrap()
        } else {
            spl_token_2022::instruction::mint_to(
                &tp,
                mint,
                &acc,
                &self.mint_authority.pubkey(),
                &[],
                amount,
            )
            .unwrap()
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

    /// Plain stablecoin transfer from `from`'s ATA (signer) to `destination` (any token account).
    pub fn transfer_stable_ix(
        &self,
        from: &Pubkey,
        mint: &Pubkey,
        destination: &Pubkey,
        amount: u64,
    ) -> Instruction {
        let tp = self.token_program_of(mint);
        let source = self.ata_of(from, mint);
        let mut ix = if tp == TOKEN_CLASSIC {
            spl_token_interface::instruction::transfer_checked(
                &tp,
                &source,
                mint,
                destination,
                from,
                &[],
                amount,
                USDC_DECIMALS,
            )
            .unwrap()
        } else {
            spl_token_2022::instruction::transfer_checked(
                &tp,
                &source,
                mint,
                destination,
                from,
                &[],
                amount,
                USDC_DECIMALS,
            )
            .unwrap()
        };
        ix.accounts.extend(self.stable_hook_accounts(mint));
        ix
    }

    /// Remaining accounts a stablecoin transfer needs for hook resolution (none for USDC).
    pub fn stable_hook_accounts(&self, mint: &Pubkey) -> Vec<AccountMeta> {
        if *mint == self.usdg {
            vec![
                AccountMeta::new_readonly(mock_usdg_hook::ID, false),
                AccountMeta::new_readonly(mock_hook_extra_metas(mint), false),
            ]
        } else {
            vec![]
        }
    }

    /// Remaining accounts for a unit-mint transfer through the Merces hook (SPEC §4.1).
    pub fn unit_hook_accounts(&self, series: &Pubkey) -> Vec<AccountMeta> {
        let p = pdas(*series);
        vec![
            AccountMeta::new_readonly(merces_hook::ID, false),
            AccountMeta::new_readonly(p.extra_metas, false),
            AccountMeta::new_readonly(p.config, false),
            AccountMeta::new_readonly(*series, false),
            AccountMeta::new_readonly(merces_protocol::ID, false),
            AccountMeta::new_readonly(p.escrow_arm, false),
        ]
    }

    /// A direct wallet-to-wallet unit transfer instruction (expected to fail with the hook).
    pub fn direct_unit_transfer_ix(
        &self,
        series: &Pubkey,
        from: &Pubkey,
        to: &Pubkey,
        amount: u64,
    ) -> Instruction {
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
        ix.accounts.extend(self.unit_hook_accounts(series));
        ix
    }

    /// Writes a Pyth `PriceUpdateV2`-shaped account (fully verified) and returns its address.
    pub fn set_price_update(
        &mut self,
        feed_id: [u8; 32],
        price: i64,
        conf: u64,
        expo: i32,
        publish_time: i64,
    ) -> Pubkey {
        let update = PriceUpdateV2 {
            write_authority: Pubkey::default(),
            verification_level: VerificationLevel::Full,
            price_message: PriceFeedMessage {
                feed_id,
                price,
                conf,
                exponent: expo,
                publish_time,
                prev_publish_time: publish_time - 1,
                ema_price: price,
                ema_conf: conf,
            },
            posted_slot: 1,
        };
        let mut data = PriceUpdateV2::DISCRIMINATOR.to_vec();
        update.serialize(&mut data).unwrap();
        let mut acc = self.svm.get_account(&config_pda()).expect("config account");
        acc.data = data;
        acc.owner = pyth_solana_receiver_sdk::ID;
        acc.lamports = 10_000_000_000;
        let key = Pubkey::new_unique();
        self.svm.set_account(key, acc).unwrap();
        key
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

    fn rix(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: merces_registry::ID,
            accounts,
            data,
        }
    }

    pub fn admin_only_ix(&self, data: Vec<u8>) -> Instruction {
        Self::rix(
            merces_registry::accounts::AdminOnly {
                config: config_pda(),
                admin: self.admin.pubkey(),
            }
            .to_account_metas(None),
            data,
        )
    }

    fn send_admin(&mut self, ix: Instruction) -> TxResult {
        let admin = self.admin.insecure_clone();
        self.send(&[ix], &[&admin])
    }

    pub fn set_flags(
        &mut self,
        new_raises_paused: bool,
        windows_enabled: bool,
        tier4_enabled: bool,
    ) -> TxResult {
        let ix = self.admin_only_ix(
            merces_registry::instruction::SetFlags {
                new_raises_paused,
                windows_enabled,
                tier4_enabled,
            }
            .data(),
        );
        self.send_admin(ix)
    }

    pub fn set_early_draw_approver(&mut self, approver: Pubkey) -> TxResult {
        let ix = self
            .admin_only_ix(merces_registry::instruction::SetEarlyDrawApprover { approver }.data());
        self.send_admin(ix)
    }

    pub fn set_defaults(&mut self, defaults: ParametersData) -> TxResult {
        let ix = self.admin_only_ix(merces_registry::instruction::SetDefaults { defaults }.data());
        self.send_admin(ix)
    }

    pub fn set_fee_collector(&mut self, new_collector: Pubkey) -> TxResult {
        let ix = self
            .admin_only_ix(merces_registry::instruction::SetFeeCollector { new_collector }.data());
        self.send_admin(ix)
    }

    pub fn allow(&mut self, wallet: &Pubkey, allowed: bool) -> TxResult {
        let ix = Self::rix(
            merces_registry::accounts::SetAllowed {
                config: config_pda(),
                allowlist_manager: self.allowlist_manager.pubkey(),
                entry: allow_pda(wallet),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_registry::instruction::SetAllowed {
                wallet: *wallet,
                allowed,
            }
            .data(),
        );
        let m = self.allowlist_manager.insecure_clone();
        self.send(&[ix], &[&m])
    }

    pub fn register_issuer(&mut self, wallet: &Pubkey) -> TxResult {
        let ix = Self::rix(
            merces_registry::accounts::RegisterIssuer {
                config: config_pda(),
                admin: self.admin.pubkey(),
                issuer: issuer_pda(wallet),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_registry::instruction::RegisterIssuer { wallet: *wallet }.data(),
        );
        self.send_admin(ix)
    }

    pub fn deactivate_issuer(&mut self, wallet: &Pubkey) -> TxResult {
        let ix = Self::rix(
            merces_registry::accounts::DeactivateIssuer {
                config: config_pda(),
                admin: self.admin.pubkey(),
                issuer: issuer_pda(wallet),
            }
            .to_account_metas(None),
            merces_registry::instruction::DeactivateIssuer { wallet: *wallet }.data(),
        );
        self.send_admin(ix)
    }

    pub fn register_attestor(&mut self, addr: [u8; 20]) -> TxResult {
        let ix = Self::rix(
            merces_registry::accounts::RegisterAttestor {
                config: config_pda(),
                admin: self.admin.pubkey(),
                attestor: attestor_pda(&addr),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_registry::instruction::RegisterAttestor { addr }.data(),
        );
        self.send_admin(ix)
    }

    pub fn revoke_attestor(&mut self, addr: [u8; 20]) -> TxResult {
        let ix = Self::rix(
            merces_registry::accounts::RevokeAttestor {
                config: config_pda(),
                admin: self.admin.pubkey(),
                attestor: attestor_pda(&addr),
            }
            .to_account_metas(None),
            merces_registry::instruction::RevokeAttestor { addr }.data(),
        );
        self.send_admin(ix)
    }

    pub fn register_verifier(&mut self, addr: [u8; 20]) -> TxResult {
        let ix = Self::rix(
            merces_registry::accounts::RegisterVerifierKey {
                config: config_pda(),
                admin: self.admin.pubkey(),
                verifier: verifier_pda(&addr),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_registry::instruction::RegisterVerifierKey { addr }.data(),
        );
        self.send_admin(ix)
    }

    pub fn revoke_verifier(&mut self, addr: [u8; 20]) -> TxResult {
        let ix = Self::rix(
            merces_registry::accounts::RevokeVerifierKey {
                config: config_pda(),
                admin: self.admin.pubkey(),
                verifier: verifier_pda(&addr),
            }
            .to_account_metas(None),
            merces_registry::instruction::RevokeVerifierKey { addr }.data(),
        );
        self.send_admin(ix)
    }

    /// Registers an FX pair; `crosscheck` is the cross-check Pyth feed id (`Pubkey::default()`
    /// for none).
    pub fn set_fx_pair(
        &mut self,
        pair_id: [u8; 32],
        feed_id: [u8; 32],
        inverted: bool,
        crosscheck: Pubkey,
        enabled: bool,
    ) -> TxResult {
        let ix = Self::rix(
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
                crosscheck,
                enabled,
            }
            .data(),
        );
        self.send_admin(ix)
    }

    /// The synthetic cross-check feed id the tests pair with `feed_id`
    /// (`keccak256("MERCES_TEST_CROSSCHECK" ‖ feed_id)`).
    pub fn crosscheck_feed_for(feed_id: &[u8; 32]) -> [u8; 32] {
        keccak(&[b"MERCES_TEST_CROSSCHECK", feed_id])
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
            tier_flags: 0b0110,
            fx_pair_id: [0u8; 32],
            mode: 0,
            issuer_accepts_public_price: false,
            metadata_uri: "https://merces.example/heu/0.json".to_string(),
            tier1_terms: None,
        }
    }

    /// Tier-1 plaintext terms for `create_series` (bit0 of `tier_flags`).
    pub fn tier1_terms(
        theta: u64,
        r_wad: u64,
        currency_code: u32,
        indexing_rule: u32,
        terms_salt: [u8; 32],
    ) -> Tier1Terms {
        Tier1Terms {
            theta,
            r_wad,
            currency_code,
            indexing_rule,
            terms_salt,
        }
    }

    pub fn create_series_ix(
        &self,
        issuer: &Pubkey,
        stablecoin: &Pubkey,
        fx_pair: Option<Pubkey>,
        args: CreateSeriesArgs,
    ) -> (Instruction, Pubkey) {
        let cfg = self.config();
        let series = series_pda(cfg.series_count);
        let ix = Self::rix(
            merces_registry::accounts::CreateSeries {
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
            merces_registry::instruction::CreateSeries { args }.data(),
        );
        (ix, series)
    }

    pub fn create_series_tx(
        &mut self,
        issuer: &Keypair,
        stablecoin: &Pubkey,
        fx_pair: Option<Pubkey>,
        args: CreateSeriesArgs,
    ) -> (TxResult, Pubkey) {
        let (ix, series) = self.create_series_ix(&issuer.pubkey(), stablecoin, fx_pair, args);
        (self.send(&[ix], &[issuer]), series)
    }

    pub fn create_series(
        &mut self,
        issuer: &Keypair,
        stablecoin: &Pubkey,
        args: CreateSeriesArgs,
    ) -> Pubkey {
        let (res, series) = self.create_series_tx(issuer, stablecoin, None, args);
        res.unwrap_or_else(|e| {
            panic!(
                "create_series failed: {:?}\n{}",
                e.err,
                e.meta.logs.join("\n")
            )
        });
        series
    }

    pub fn set_contract_hash(
        &mut self,
        issuer: &Keypair,
        series: &Pubkey,
        hash: [u8; 32],
    ) -> TxResult {
        let ix = Self::rix(
            merces_registry::accounts::IssuerSeries {
                issuer_wallet: issuer.pubkey(),
                series: *series,
            }
            .to_account_metas(None),
            merces_registry::instruction::SetContractHash { hash }.data(),
        );
        self.send(&[ix], &[issuer])
    }

    fn issuer_self(&mut self, issuer: &Keypair, data: Vec<u8>) -> TxResult {
        let ix = Self::rix(
            merces_registry::accounts::IssuerSelf {
                issuer_wallet: issuer.pubkey(),
                issuer: issuer_pda(&issuer.pubkey()),
            }
            .to_account_metas(None),
            data,
        );
        self.send(&[ix], &[issuer])
    }

    pub fn stop_issuance(&mut self, issuer: &Keypair) -> TxResult {
        self.issuer_self(issuer, merces_registry::instruction::StopIssuance {}.data())
    }

    pub fn resume_issuance(&mut self, issuer: &Keypair) -> TxResult {
        self.issuer_self(
            issuer,
            merces_registry::instruction::ResumeIssuance {}.data(),
        )
    }

    pub fn amend_terms(
        &mut self,
        issuer: &Keypair,
        series: &Pubkey,
        new_tc: [u8; 32],
        new_cap: u64,
        attestor_addr: [u8; 20],
        sig: [u8; 65],
    ) -> TxResult {
        let ix = Self::rix(
            merces_registry::accounts::AmendTerms {
                config: config_pda(),
                issuer_wallet: issuer.pubkey(),
                series: *series,
                attestor: attestor_pda(&attestor_addr),
            }
            .to_account_metas(None),
            merces_registry::instruction::AmendTerms {
                new_terms_commitment: new_tc,
                new_cap_multiple_wad: new_cap,
                attestor_addr,
                attestor_sig: sig,
            }
            .data(),
        );
        self.send(&[ix], &[issuer])
    }

    /// Registers an issuer, allowlists it, creates a series on `stablecoin` and sets the contract
    /// hash. Returns the series key.
    pub fn setup_series(
        &mut self,
        issuer: &Keypair,
        stablecoin: &Pubkey,
        args: CreateSeriesArgs,
    ) -> Pubkey {
        self.register_issuer(&issuer.pubkey()).unwrap();
        self.allow(&issuer.pubkey(), true).unwrap();
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
                unit_mint: p.unit_mint,
                vault_auth: p.vault_auth,
                escrow_auth: p.escrow_auth,
                treasury_auth: p.treasury_auth,
                window_escrow_auth: p.window_escrow_auth,
                auction: p.auction,
                treasury: p.treasury,
                ledger: p.ledger,
                escrow_arm: p.escrow_arm,
                escrow_token: p.escrow_token,
                treasury_token: p.treasury_token,
                vault_token: p.vault_token,
                window_stable: p.window_stable,
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
                auction_escrow_auth: p.auction_escrow_auth,
                auction_escrow_ata: p.auction_escrow_ata,
                window_escrow_auth: p.window_escrow_auth,
                window_escrow_ata: p.window_escrow_ata,
                extra_account_meta_list: p.extra_metas,
                registry_authority: p.registry_authority,
                hook_program: merces_hook::ID,
                registry_program: merces_registry::ID,
                token_2022_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::OpenRaise {}.data(),
        )
    }

    /// `prepare_raise` + `open_raise` in one transaction (the second alone when the first ran).
    pub fn open_raise(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        let b = self.open_raise_ix(&issuer.pubkey(), series);
        if self.exists(&pdas(*series).auction) {
            self.send(&[b], &[issuer])
        } else {
            let a = self.prepare_raise_ix(&issuer.pubkey(), series);
            self.send(&[a, b], &[issuer])
        }
    }

    pub fn cancel_raise(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::CancelRaise {
                issuer: issuer.pubkey(),
                config: p.config,
                series: *series,
                auction: p.auction,
                registry_authority: p.registry_authority,
                registry_program: merces_registry::ID,
            }
            .to_account_metas(None),
            merces_protocol::instruction::CancelRaise {}.data(),
        );
        self.send(&[ix], &[issuer])
    }

    pub fn commit_bid(
        &mut self,
        series: &Pubkey,
        bidder: &Keypair,
        commitment: [u8; 32],
        escrow: u64,
    ) -> TxResult {
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

    pub fn reveal_bid(
        &mut self,
        series: &Pubkey,
        bidder: &Keypair,
        price: u64,
        quantity: u64,
        salt: [u8; 32],
    ) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::RevealBid {
                bidder: bidder.pubkey(),
                series: *series,
                auction: p.auction,
                bid: bid_pda(series, &bidder.pubkey()),
            }
            .to_account_metas(None),
            merces_protocol::instruction::RevealBid {
                price,
                quantity,
                salt,
            }
            .data(),
        );
        self.send(&[ix], &[bidder])
    }

    pub fn begin_settlement(
        &mut self,
        series: &Pubkey,
        price: u64,
        q_above_claim: u64,
        q_at_claim: u64,
    ) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::BeginSettlement {
                series: *series,
                auction: p.auction,
            }
            .to_account_metas(None),
            merces_protocol::instruction::BeginSettlement {
                clearing_price: price,
                q_above_claim,
                q_at_claim,
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
            ix.accounts
                .push(AccountMeta::new(bid_pda(series, b), false));
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
                treasury: p.treasury,
                ledger: p.ledger,
                registry_authority: p.registry_authority,
                registry_program: merces_registry::ID,
            }
            .to_account_metas(None),
            merces_protocol::instruction::FinalizeSettlement {}.data(),
        );
        self.send(&[ix], &[])
    }

    /// Tally pages of 24 over `bidders`, then finalize.
    pub fn tally_and_finalize(&mut self, series: &Pubkey, bidders: &[Pubkey]) -> TxResult {
        for page in bidders.chunks(pstate::TALLY_PAGE) {
            self.tally_bids(series, page)?;
        }
        self.finalize_settlement(series)
    }

    pub fn process_bid(&mut self, series: &Pubkey, bidder: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let create_fee = self.create_ata_ix(&self.fee_collector.pubkey(), &s.stablecoin);
        let mut ix = Self::pix(
            merces_protocol::accounts::ProcessBid {
                payer: self.payer.pubkey(),
                config: p.config,
                series: *series,
                auction: p.auction,
                bid: bid_pda(series, bidder),
                treasury: p.treasury,
                ledger: p.ledger,
                holder: holder_pda(series, bidder),
                bidder: *bidder,
                escrow_auth: p.escrow_auth,
                auction_auth: p.auction_auth,
                escrow_token: p.escrow_token,
                treasury_token: p.treasury_token,
                fee_collector_ata: self.ata_of(&self.fee_collector.pubkey(), &s.stablecoin),
                auction_escrow_ata: p.auction_escrow_ata,
                unit_mint: p.unit_mint,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                token_2022_program: TOKEN_2022,
                registry_authority: p.registry_authority,
                registry_program: merces_registry::ID,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::ProcessBid {}.data(),
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[create_fee, ix], &[])
    }

    pub fn deliver_bid(&mut self, series: &Pubkey, bidder: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let holder = holder_pda(series, bidder);
        let mut ix = Self::pix(
            merces_protocol::accounts::DeliverBid {
                payer: self.payer.pubkey(),
                series: *series,
                bid: bid_pda(series, bidder),
                bidder: *bidder,
                holder: if self.exists(&holder) {
                    Some(holder)
                } else {
                    None
                },
                bidder_stable_ata: self.ata_of(bidder, &s.stablecoin),
                bidder_unit_ata: ata(bidder, &p.unit_mint, &TOKEN_2022),
                escrow_auth: p.escrow_auth,
                escrow_token: p.escrow_token,
                auction_escrow_auth: p.auction_escrow_auth,
                auction_escrow_ata: p.auction_escrow_ata,
                unit_mint: p.unit_mint,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                token_2022_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::DeliverBid {}.data(),
        );
        ix.accounts.extend(self.unit_hook_accounts(series));
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[ix], &[])
    }

    /// Full settlement: begin with the given claims, tally (pages of 24), finalize, then process
    /// and deliver every bid.
    pub fn settle(
        &mut self,
        series: &Pubkey,
        price: u64,
        q_above_claim: u64,
        q_at_claim: u64,
        bidders: &[Pubkey],
    ) -> TxResult {
        self.begin_settlement(series, price, q_above_claim, q_at_claim)?;
        let res = self.tally_and_finalize(series, bidders)?;
        for b in bidders {
            self.process_bid(series, b)?;
        }
        for b in bidders {
            self.deliver_bid(series, b)?;
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

    pub fn set_release_pause(
        &mut self,
        issuer: &Keypair,
        series: &Pubkey,
        paused: bool,
    ) -> TxResult {
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

    pub fn request_early_draw(
        &mut self,
        issuer: &Keypair,
        approver: &Keypair,
        series: &Pubkey,
        amount: u64,
    ) -> TxResult {
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

    /// Builds `submit_report`. `attestation_key` / `fx_attestor_key` are the registry key PDAs
    /// (any account when unused). FX accounts are attached when the series has a pair; the end
    /// checkpoint only when it exists; the router when the series has one.
    pub fn submit_report_ix(
        &self,
        issuer: &Pubkey,
        series: &Pubkey,
        args: SubmitReportArgs,
        attestation_key: Pubkey,
        fx_attestor_key: Pubkey,
    ) -> Instruction {
        let s = self.series(series);
        let p = pdas(*series);
        let (fx_pair, fx_start, fx_end) = if s.fx_pair_id != [0u8; 32] {
            let pair = s.fx_pair_id;
            let end = fx_checkpoint_pda(&pair, args.period + 1);
            (
                Some(fx_pair_pda(&pair)),
                Some(fx_checkpoint_pda(&pair, args.period)),
                if self.exists(&end) { Some(end) } else { None },
            )
        } else {
            (None, None, None)
        };
        let router = if self.exists(&p.router) {
            Some(p.router)
        } else {
            None
        };
        Self::pix(
            merces_protocol::accounts::SubmitReport {
                issuer: *issuer,
                config: p.config,
                series: *series,
                ledger: p.ledger,
                report: report_pda(series, args.period),
                attestation_key,
                fx_attestor_key,
                fx_pair,
                fx_start,
                fx_end,
                router,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::SubmitReport { args }.data(),
        )
    }

    pub fn submit_report(
        &mut self,
        issuer: &Keypair,
        series: &Pubkey,
        args: SubmitReportArgs,
        attestation_key: Pubkey,
        fx_attestor_key: Pubkey,
    ) -> TxResult {
        let ix = self.submit_report_ix(
            &issuer.pubkey(),
            series,
            args,
            attestation_key,
            fx_attestor_key,
        );
        self.send(&[ix], &[issuer])
    }

    /// `pay` / `pay_trueup` shared accounts.
    pub fn pay_ixs(
        &self,
        payer: &Pubkey,
        series: &Pubkey,
        period: Option<u32>,
        trueup: bool,
    ) -> Vec<Instruction> {
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
            stablecoin_mint: s.stablecoin,
            stablecoin_program: s.stablecoin_program,
            registry_authority: p.registry_authority,
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
        let period = self.ledger(series).and_then(|l| {
            if l.open_due_amount > 0 {
                l.open_due_period()
            } else {
                None
            }
        });
        let ixs = self.pay_ixs(&payer.pubkey(), series, period, false);
        self.send(&ixs, &[payer])
    }

    pub fn pay_trueup(&mut self, payer: &Keypair, series: &Pubkey) -> TxResult {
        let ixs = self.pay_ixs(&payer.pubkey(), series, None, true);
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

    pub fn retire_if_capped(&mut self, series: &Pubkey) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::RetireIfCapped {
                config: p.config,
                series: *series,
                ledger: p.ledger,
                registry_authority: p.registry_authority,
                registry_program: merces_registry::ID,
            }
            .to_account_metas(None),
            merces_protocol::instruction::RetireIfCapped {}.data(),
        );
        self.send(&[ix], &[])
    }

    fn issuer_ledger(&mut self, issuer: &Keypair, series: &Pubkey, data: Vec<u8>) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::IssuerLedger {
                issuer: issuer.pubkey(),
                series: *series,
                ledger: p.ledger,
            }
            .to_account_metas(None),
            data,
        );
        self.send(&[ix], &[issuer])
    }

    pub fn request_pause(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        self.issuer_ledger(
            issuer,
            series,
            merces_protocol::instruction::RequestPause {}.data(),
        )
    }

    pub fn withdraw_pause_request(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        self.issuer_ledger(
            issuer,
            series,
            merces_protocol::instruction::WithdrawPauseRequest {}.data(),
        )
    }

    pub fn end_pause(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        self.issuer_ledger(
            issuer,
            series,
            merces_protocol::instruction::EndPause {}.data(),
        )
    }

    pub fn approve_pause(
        &mut self,
        series: &Pubkey,
        pause_end: u64,
        attestor_addr: [u8; 20],
        sig: [u8; 65],
    ) -> TxResult {
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

    pub fn submit_trueup(
        &mut self,
        issuer: &Keypair,
        series: &Pubkey,
        year: u16,
        adjustment: i64,
        attestation_ts: u64,
        attestor_addr: [u8; 20],
        sig: [u8; 65],
    ) -> TxResult {
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

    fn holder_claim_ixs(
        &self,
        series: &Pubkey,
        holder: &Pubkey,
        data: Vec<u8>,
    ) -> Vec<Instruction> {
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
        let ixs = self.holder_claim_ixs(
            series,
            holder,
            merces_protocol::instruction::Claim {}.data(),
        );
        self.send(&ixs, &[])
    }
    pub fn burn_retired(&mut self, series: &Pubkey, holder: &Pubkey) -> TxResult {
        let ixs = self.holder_claim_ixs(
            series,
            holder,
            merces_protocol::instruction::BurnRetired {}.data(),
        );
        self.send(&ixs, &[])
    }
    pub fn claim_redemption(&mut self, series: &Pubkey, holder: &Pubkey) -> TxResult {
        let ixs = self.holder_claim_ixs(
            series,
            holder,
            merces_protocol::instruction::ClaimRedemption {}.data(),
        );
        self.send(&ixs, &[])
    }
    pub fn claim_tail(&mut self, series: &Pubkey, holder: &Pubkey) -> TxResult {
        let ixs = self.holder_claim_ixs(
            series,
            holder,
            merces_protocol::instruction::ClaimTail {}.data(),
        );
        self.send(&ixs, &[])
    }
    pub fn claim_final(&mut self, series: &Pubkey, holder: &Pubkey) -> TxResult {
        let ixs = self.holder_claim_ixs(
            series,
            holder,
            merces_protocol::instruction::ClaimFinal {}.data(),
        );
        self.send(&ixs, &[])
    }

    // ------------------------------------------------------------------ protocol: router, fx, exit

    pub fn init_router(&mut self, series: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::InitRouter {
                payer: self.payer.pubkey(),
                series: *series,
                router: p.router,
                router_auth: p.router_auth,
                router_token: p.router_token,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::InitRouter {}.data(),
        );
        self.send(&[ix], &[])
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
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                registry_authority: p.registry_authority,
                registry_program: merces_registry::ID,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::Route {}.data(),
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[create_issuer, create_fee, ix], &[])
    }

    pub fn close_router_period(&mut self, series: &Pubkey, period: u32) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::CloseRouterPeriod {
                series: *series,
                router: p.router,
            }
            .to_account_metas(None),
            merces_protocol::instruction::CloseRouterPeriod { period }.data(),
        );
        self.send(&[ix], &[])
    }

    pub fn init_fx_pair(&mut self, pair_id: [u8; 32]) -> TxResult {
        let ix = Self::pix(
            merces_protocol::accounts::InitFxPair {
                payer: self.payer.pubkey(),
                pair_config: fx_config_pda(&pair_id),
                pair: fx_pair_pda(&pair_id),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::InitFxPair { pair_id }.data(),
        );
        self.send(&[ix], &[])
    }

    /// Takes a snapshot with a freshly written Pyth-shaped price account. `crosscheck` is the
    /// pair's cross-check feed `(feed_id, price, expo)` when one is configured (SPEC §6.6 step 4;
    /// on Solana the cross-check is a second Pyth feed, see `docs/assumptions/track-b.md` B-S10).
    pub fn snapshot_fx(
        &mut self,
        pair_id: [u8; 32],
        feed_id: [u8; 32],
        price: i64,
        conf: u64,
        expo: i32,
        publish_time: i64,
        crosscheck: Option<([u8; 32], i64, i32)>,
    ) -> TxResult {
        let period = merces_common::time::period_of(self.now).unwrap();
        let price_update = self.set_price_update(feed_id, price, conf, expo, publish_time);
        let crosscheck_update = crosscheck.map(|(cc_feed, cc_price, cc_expo)| {
            self.set_price_update(cc_feed, cc_price, 0, cc_expo, publish_time)
        });
        let ix = Self::pix(
            merces_protocol::accounts::SnapshotFx {
                keeper: self.payer.pubkey(),
                config: config_pda(),
                pair_config: fx_config_pda(&pair_id),
                pair: fx_pair_pda(&pair_id),
                checkpoint: fx_checkpoint_pda(&pair_id, period),
                price_update,
                crosscheck_update,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::SnapshotFx { period }.data(),
        );
        self.send(&[ix], &[])
    }

    pub fn redeem(&mut self, issuer: &Keypair, series: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let create = self.create_ata_ix(&issuer.pubkey(), &s.stablecoin);
        let mut ix = Self::pix(
            merces_protocol::accounts::Redeem {
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
            .to_account_metas(None),
            merces_protocol::instruction::Redeem {}.data(),
        );
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[create, ix], &[issuer])
    }

    pub fn extinguish(
        &mut self,
        series: &Pubkey,
        a: ([u8; 20], [u8; 65]),
        b: ([u8; 20], [u8; 65]),
    ) -> TxResult {
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
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                attestor_key_a: attestor_pda(&a.0),
                attestor_key_b: attestor_pda(&b.0),
                registry_authority: p.registry_authority,
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
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::OpenWindow {
                payer: self.payer.pubkey(),
                config: p.config,
                series: *series,
                ledger: p.ledger,
                window: window_pda(series, period),
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::OpenWindow { period }.data(),
        );
        self.send(&[ix], &[])
    }

    pub fn commit_ask(
        &mut self,
        series: &Pubkey,
        period: u32,
        owner: &Keypair,
        commitment: [u8; 32],
        units: u64,
    ) -> TxResult {
        let p = pdas(*series);
        let mut ix = Self::pix(
            merces_protocol::accounts::CommitAsk {
                owner: owner.pubkey(),
                series: *series,
                ledger: p.ledger,
                window: window_pda(series, period),
                order: order_pda(series, period, &owner.pubkey()),
                holder: holder_pda(series, &owner.pubkey()),
                escrow_arm: p.escrow_arm,
                owner_unit_ata: ata(&owner.pubkey(), &p.unit_mint, &TOKEN_2022),
                window_escrow_ata: p.window_escrow_ata,
                unit_mint: p.unit_mint,
                token_2022_program: TOKEN_2022,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::CommitAsk { commitment, units }.data(),
        );
        ix.accounts.extend(self.unit_hook_accounts(series));
        self.send(&[ix], &[owner])
    }

    pub fn window_commit_bid(
        &mut self,
        series: &Pubkey,
        period: u32,
        owner: &Keypair,
        commitment: [u8; 32],
        escrow: u64,
    ) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let mut ix = Self::pix(
            merces_protocol::accounts::WindowCommitBid {
                owner: owner.pubkey(),
                series: *series,
                owner_allowlist: allow_pda(&owner.pubkey()),
                window: window_pda(series, period),
                order: order_pda(series, period, &owner.pubkey()),
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

    pub fn reveal_order(
        &mut self,
        series: &Pubkey,
        period: u32,
        owner: &Keypair,
        price: u64,
        quantity: u64,
        salt: [u8; 32],
    ) -> TxResult {
        let p = pdas(*series);
        let ix = Self::pix(
            merces_protocol::accounts::RevealOrder {
                owner: owner.pubkey(),
                series: *series,
                ledger: p.ledger,
                window: window_pda(series, period),
                order: order_pda(series, period, &owner.pubkey()),
                owner_unit_ata: ata(&owner.pubkey(), &p.unit_mint, &TOKEN_2022),
                token_2022_program: TOKEN_2022,
            }
            .to_account_metas(None),
            merces_protocol::instruction::RevealOrder {
                price,
                quantity,
                salt,
            }
            .data(),
        );
        self.send(&[ix], &[owner])
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

    pub fn begin_window_settlement(
        &mut self,
        series: &Pubkey,
        period: u32,
        price: u64,
        no_match: bool,
    ) -> TxResult {
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

    pub fn tally_orders(&mut self, series: &Pubkey, period: u32, owners: &[Pubkey]) -> TxResult {
        let mut ix = self.window_settle_ix(
            series,
            period,
            merces_protocol::instruction::TallyOrders {}.data(),
        );
        for owner in owners {
            ix.accounts
                .push(AccountMeta::new(order_pda(series, period, owner), false));
        }
        self.send(&[ix], &[])
    }

    pub fn finalize_window(&mut self, series: &Pubkey, period: u32) -> TxResult {
        let ix = self.window_settle_ix(
            series,
            period,
            merces_protocol::instruction::FinalizeWindow {}.data(),
        );
        self.send(&[ix], &[])
    }

    pub fn process_order(&mut self, series: &Pubkey, period: u32, owner: &Pubkey) -> TxResult {
        let s = self.series(series);
        let p = pdas(*series);
        let create_fee = self.create_ata_ix(&self.fee_collector.pubkey(), &s.stablecoin);
        let allow = allow_pda(owner);
        let mut ix = Self::pix(
            merces_protocol::accounts::ProcessOrder {
                payer: self.payer.pubkey(),
                config: p.config,
                series: *series,
                ledger: p.ledger,
                window: window_pda(series, period),
                order: order_pda(series, period, owner),
                owner: *owner,
                holder: holder_pda(series, owner),
                owner_allowlist: if self.exists(&allow) {
                    Some(allow)
                } else {
                    None
                },
                owner_unit_ata: ata(owner, &p.unit_mint, &TOKEN_2022),
                owner_stable_ata: self.ata_of(owner, &s.stablecoin),
                window_escrow_ata: p.window_escrow_ata,
                window_stable: p.window_stable,
                window_escrow_auth: p.window_escrow_auth,
                fee_collector_ata: self.ata_of(&self.fee_collector.pubkey(), &s.stablecoin),
                unit_mint: p.unit_mint,
                stablecoin_mint: s.stablecoin,
                stablecoin_program: s.stablecoin_program,
                token_2022_program: TOKEN_2022,
                associated_token_program: ATA_PROGRAM,
                system_program: SYSTEM_PROGRAM,
            }
            .to_account_metas(None),
            merces_protocol::instruction::ProcessOrder {}.data(),
        );
        ix.accounts.extend(self.unit_hook_accounts(series));
        ix.accounts.extend(self.stable_hook_accounts(&s.stablecoin));
        self.send(&[create_fee, ix], &[])
    }
}
