# Pyth Network research memo: daily FX rate snapshots on Solana and Monad

Date: 2026-10-07
Audience: protocol engineering (Solana program + Monad/EVM contract + off-chain snapshot job)
Status: research from local clones only; network access to docs.pyth.network was blocked.

## 0. Sources, provenance, and how to read citations

Two read-only clones were used. Both are shallow (1 commit of history), so "when was X added" cannot be answered from git.

| Clone | Path | HEAD |
| --- | --- | --- |
| docs site source (docs.pyth.network) | `/home/user/pyth-network/documentation` | `f16fd68dc3ec27648d28047493a3c5a5f8979d71`, 2025-11-28 |
| pyth-crosschain monorepo | `/home/user/pyth-network/pyth-crosschain` | `13bfa6468bb60f2446436cb9665f10aeabcab997`, 2026-10-05 |

The docs snapshot is ~10 months older than the monorepo snapshot. Where they disagree (notably the EVM contract store and the TypeScript client method names), the memo says so.

Citations are `relative/path:line` under one of the two roots above. Abbreviations: `DOCS/` = `/home/user/pyth-network/documentation/`, `XC/` = `/home/user/pyth-network/pyth-crosschain/`.

Nothing in this memo is a guess: every address and feed ID below is copied from a cited file. Anything that could not be found in the clones is listed in section 9 and marked unverified wherever it is mentioned.

## 1. Key takeaways for the daily FX snapshot design

1. Pyth is a pull oracle. The snapshot job must fetch a signed update from Hermes and post it on-chain in the same transaction (or just before) reading it; otherwise `getPriceNoOlderThan` reverts with `StalePrice` (`DOCS/pages/price-feeds/core/why-update-prices.mdx:3-17`, `DOCS/pages/price-feeds/core/pull-updates.mdx:15-22`).
2. Monad mainnet and Monad testnet Pyth contracts are documented. Both use `0x2880aB155794e7179c9eE2e38200202908C17B43` (section 2). Monad testnet is chain id 10143; Monad mainnet is chain id 143 (`XC/contract_manager/src/store/chains/EvmChains.json:1158-1163, 1305-1310`).
3. Solana receiver program ID is `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` on both mainnet and devnet (section 3).
4. Only three FX feed IDs are verifiable from the clones: EUR/USD, GBP/USD, AUD/USD (plus USDC/USD and metals). All others requested (JPY, INR, CAD, CHF, BRL, MXN, SGD, USDG) must be looked up at Hermes `/v2/price_feeds?asset_type=fx` and are unverified here (section 5, section 9).
5. The Monad mainnet sponsored "push feed" list contains no FX feeds (`DOCS/pages/price-feeds/core/push-feeds/data/evm/monad_mainnet.json`, aliases at lines 3-423), so on Monad the protocol must submit its own FX updates. On Solana mainnet, EUR/USD, GBP/USD and AUD/USD are sponsored on shard 0 (`DOCS/pages/price-feeds/core/push-feeds/data/svm/solana_mainnet.json:163-184`), but the sponsorship is best-effort and the protocol should still be able to post its own update.
6. FX feeds are closed from Friday 5PM ET to Sunday 5PM ET (`DOCS/pages/price-feeds/core/market-hours.mdx:14`), so a daily snapshot taken on a weekend will see a `publishTime` from Friday. The staleness window and the snapshot schedule must account for this; EM FX (INR, MXN, BRL, ...) have wider confidence at week open and local holidays (`market-hours.mdx:15`).
7. Confidence: Pyth's own guidance is to (a) use `price - conf` or `price + conf` in the direction conservative for the protocol, and/or (b) refuse to act when `conf / price` exceeds a protocol-chosen threshold (`DOCS/pages/price-feeds/core/best-practices.mdx:84-85`). No universal numeric threshold is published; see section 7 for what the repos actually use.

## 2. Pyth EVM price-feed contract addresses

### 2.1 Documented addresses (docs site, snapshot 2025-11-28)

Source: `DOCS/pages/price-feeds/core/contract-addresses/evm.mdx`. The page states these are "Pyth Stable price sources that are accessible via Hermes Stable" (line 5). Mainnets table starts line 7; testnets table starts line 89.

| Network | Address | Citation |
| --- | --- | --- |
| Monad (mainnet) | `0x2880aB155794e7179c9eE2e38200202908C17B43` | `evm.mdx:61` (explorer: monad.socialscan.io) |
| Monad testnet | `0x2880aB155794e7179c9eE2e38200202908C17B43` | `evm.mdx:153` (explorer: testnet.monadexplorer.com) |
| Monad testnet - beta oracle | `0xad2B52D2af1a9bD5c561894Cdd84f7505e1CD0B5` | `evm.mdx:154` |
| Ethereum mainnet | `0x4305FB66699C3B2702D4d05CF36551390A4c69C6` | `evm.mdx:34` |
| Sepolia (Ethereum testnet) | `0xDd24F84d36BF92C65F92307595335bdFab5Bbd21` | `evm.mdx:174` |
| Arbitrum (One) | `0xff1a0f4744e8582DF1aE09D5611b887B6a12925C` | `evm.mdx:14` |
| Arbitrum Sepolia | `0x4374e5a8b9C22271E9EB878A2AA31DE97DF15DAF` | `evm.mdx:96` |
| Base | `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a` | `evm.mdx:22` |
| Base Sepolia | `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729` | `evm.mdx:100` |

Notes:
- The "beta oracle" row for Monad testnet is a separate deployment fed by the Beta channel (Hermes Beta, `https://hermes-beta.pyth.network`, `DOCS/pages/price-feeds/core/api-instances-and-providers/hermes.mdx:18-23`). Beta feed IDs differ from Stable feed IDs (`DOCS/pages/price-feeds/core/price-feeds.mdx:26`). Use the Stable contract (`0x2880...`) with Stable IDs unless there is a specific reason to use Beta.
- The same `0x2880aB15...` address is reused on many chains (0G, Apechain, Giwa, Ink Sepolia, Superseed, Unichain Sepolia, Worldchain testnet; `evm.mdx:11, 13, 128, 139, 181, 186, 189`). Pyth deploys deterministically, so address reuse across chains is normal and not evidence of a copy-paste error.

### 2.2 Chain IDs and the contract_manager store (monorepo, snapshot 2026-10-05)

Chain definitions, `XC/contract_manager/src/store/chains/EvmChains.json`:

| Store id | mainnet | networkId (EIP-155 chain id) | rpcUrl | Lines |
| --- | --- | --- | --- | --- |
| `monad_testnet` | false | 10143 | https://rpc.ankr.com/monad_testnet | 1158-1163 |
| `monad` | true | 143 | https://rpc.monad.xyz | 1305-1310 |
| `ethereum` | true | 1 | https://ethereum-rpc.publicnode.com | 181-185 |
| `sepolia` | false | 11155111 | https://ethereum-sepolia-rpc.publicnode.com | 402-406 |
| `arbitrum` | true | 42161 | https://arb1.arbitrum.io/rpc | 308-312 |
| `arbitrum_sepolia` | false | 421614 | https://sepolia-rollup.arbitrum.io/rpc | 416-420 |
| `base` | true | 8453 | https://base-rpc.publicnode.com | 300-304 |
| `base_sepolia` | false | 84532 | https://sepolia.base.org | 601-605 |

Price feed contracts, `XC/contract_manager/src/store/contracts/EvmPriceFeedContracts.json` (228 entries total). Entries matching the documented addresses:

| chain | address | deploymentType | Lines |
| --- | --- | --- | --- |
| `monad` | `0x2880aB155794e7179c9eE2e38200202908C17B43` | pro-compatible-production | 886-890 |
| `monad_testnet` | `0x2880aB155794e7179c9eE2e38200202908C17B43` | pro-compatible-production | 949-953 |
| `ethereum` | `0x4305FB66699C3B2702D4d05CF36551390A4c69C6` | pro-compatible-production | 8-12 |
| `sepolia` | `0xDd24F84d36BF92C65F92307595335bdFab5Bbd21` | pro-compatible-production | 319-323 |
| `arbitrum` | `0xff1a0f4744e8582DF1aE09D5611b887B6a12925C` | pro-compatible-production | 36-40 |
| `arbitrum_sepolia` | `0x4374e5a8b9C22271E9EB878A2AA31DE97DF15DAF` | pro-compatible-production | 181-185 |
| `base` | `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a` | pro-compatible-production | 119-123 |
| `base_sepolia` | `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729` | pro-compatible-production | 376-380 |

The store also carries a second, undocumented set of entries (same `deploymentType` label), including for Monad:

| chain | address | Lines |
| --- | --- | --- |
| `monad_testnet` | `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379` | 1063-1067 |
| `monad` | `0xB754BA51E3861Ac0Cb67f73CD046dE790A36508d` | 1069-1073 |
| `ethereum` | `0x14b9932cc9AC8Ee03301665a8644A753f46D8552` | 1111-1115 |
| `sepolia` | `0xBb86bCc951A62DF86826219d9251Ee05F2c1e286` | 985-989 |
| `sepolia` | `0x26DD80569a8B23768A1d80869Ed7339e07595E85` | 313-317 |
| `sepolia` (pro-compatible-staging) | `0x6f98021B5491548fD1691dC6A63fc364B693C77F` | 1201-1205 |
| `arbitrum` | `0xe15357fB7ab31E091583b9c4b4135BB2f176f38e` | 1003-1007 |
| `arbitrum_sepolia` | `0x0B73614636C855Bf23F342F307FB981A3e47f42B` | 1009-1013 |
| `base` | `0xbC16aee60f64864882BC6C4E428e148Fc0E272F5` | 1015-1019 |
| `base_sepolia` | `0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83` | 1021-1025 |

What `deploymentType` means (`XC/contract_manager/src/core/base.ts`): the type is `"stable" | "beta" | "pro-compatible-staging" | "pro-compatible-production"` (lines 13-17); the comment at line 12 says stable/beta are for Pythnet and the pro-compatible types "are for Pro compatible deployments". `ProDeploymentType` is a deployment "whose wormhole receiver is a Pyth Pro receiver, i.e. one whose guardian set is the Pro router signing keys rather than the Wormhole mainnet guardians" (lines 19-25). The default config for `pro-compatible-production` has a single data source (emitterChain 26, emitterAddress `507974686e6574...`), `initialSingleUpdateFee: 0`, a 5-key initial guardian set and `quorum: "half"` (lines 263-291); `stable` has three data sources, fee 1, and `quorum: "two-third"` (lines 170-202).

Monad Wormhole receivers in `XC/contract_manager/src/store/contracts/EvmWormholeContracts.json`: `monad` stable `0xb27e5ca259702f209a29225d0eDdC131039C9933` (974-978), `monad_testnet` stable same address (1052-1056), `monad_testnet` pro-compatible-production `0xF8b6a7fD411Fff41443980b312C2bAb3A0DCaaf5` (1172-1176), `monad` pro-compatible-production `0xCAC639d17193b6EBfE8Dd23b07A0c0E7Bcf167B8` (1178-1182).

Assessment: the docs page (section 2.1) and the store agree on `0x2880aB15...` for both Monad networks. The second Monad entries (`0xB754...` mainnet, `0xFC6b...` testnet) appear only in the store, are not referenced anywhere else in either clone (grep over both repos found only `EvmPriceFeedContracts.json:1063,1069` and, for `0xFC6b...`, the Mumbai row at `evm.mdx:158`), and arrived in the single available commit ("fix(mcp): address Devin review findings"). Treat `0x2880aB155794e7179c9eE2e38200202908C17B43` as the address to integrate on Monad, verify it on the explorer links in `evm.mdx:61,153` before deployment, and treat `0xB754...`/`0xFC6b...` as undocumented and unverified.

### 2.3 Governance (Wormhole-style) chain IDs for Monad

`XC/governance/xc_admin/packages/xc_admin_common/src/chains.ts`: `monad: 60087` (line 120), `monad_devnet: 50116` (line 263), `monad_testnet: 50117` (line 264). These are Pyth governance receiver chain IDs, not EVM chain IDs; they matter only if you read governance VAAs.

### 2.4 Update fee on Monad

`DOCS/pages/price-feeds/core/current-fees.mdx:8-12` says the default fee on any chain not listed is 1 unit of the smallest native denomination; Monad is not listed (table lines 14-26). The on-chain fee is computed by `getUpdateFee(bytes[] updateData)` (`XC/target_chains/ethereum/contracts/contracts/pyth/Pyth.sol:95-...`), and the size-based variant charges `255 * singleUpdateFeeInWei * updateDataSize + transactionFeeInWei` (`Pyth.sol:82-93`). Always call `getUpdateFee` on-chain rather than hardcoding; the pro-compatible default `initialSingleUpdateFee: 0` (`base.ts:277`) is an initial config value, not a guarantee of the current fee.

## 3. Solana: receiver program, PriceUpdateV2, Rust SDK, verification

### 3.1 Program IDs

`DOCS/pages/price-feeds/core/contract-addresses/solana.mdx`:
- Solana receiver program, Solana Mainnet: `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` (line 11); Solana Devnet: same (line 12). Also Eclipse, Sonic, Mantis, Atlas, Fogo (lines 13-21).
- Price feed (push oracle) program, Solana Mainnet and Devnet: `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT` (lines 27-28).

Corroborated in code:
- `XC/target_chains/solana/pyth_solana_receiver_sdk/src/lib.rs:17-25`: default build `declare_id!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ")` and `PYTH_PUSH_ORACLE_ID = pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT` (lines 22-23). With cargo feature `pro-compatible` (Cargo.toml line 15): `rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp` and `pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou` (lines 19-20).
- `XC/target_chains/solana/sdk/js/pyth_solana_receiver/src/address.ts:10-12` `DEFAULT_RECEIVER_PROGRAM_ID = rec5EK...` ("deployed at this address on all SVM networks", lines 7-9); `DEFAULT_WORMHOLE_PROGRAM_ID = HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ` (17-19); `DEFAULT_PUSH_ORACLE_PROGRAM_ID = pythWSn...` (21-23); `PRO_COMPATIBLE_RECEIVER_PROGRAM_ID = rec2HH...` (25-27), `PRO_COMPATIBLE_WORMHOLE_PROGRAM_ID = HDw2E7P8X1SkCyjvoGsfBGAVUutKcj874bXjHrpVYrVL` (29-31), `PRO_COMPATIBLE_PUSH_ORACLE_PROGRAM_ID = pyt2F4...` (33-35).
- The on-chain program itself: `XC/target_chains/solana/programs/pyth-solana-receiver/src/lib.rs:42` `declare_id!(pyth_solana_receiver_sdk::ID)`; program crate `pyth-solana-receiver` v0.2.1 (`programs/pyth-solana-receiver/Cargo.toml:2-3`).

The `rec2HH...` "pro-compatible" program is not mentioned anywhere in the docs clone. Use `rec5EK...` unless Pyth tells you otherwise.

### 3.2 Rust SDK crate

- Crate: `pyth-solana-receiver-sdk`, version `2.0.0` (`XC/target_chains/solana/pyth_solana_receiver_sdk/Cargo.toml:2-3`), lib name `pyth_solana_receiver_sdk` (line 12). Depends on `anchor-lang` (workspace), `borsh 1.5.3`, `hex`, `pythnet-sdk` with feature `solana-program` (lines 17-22). `pythnet-sdk` is v3.0.0 (`XC/pythnet/pythnet_sdk/Cargo.toml:2-3`).
- Docs say to take the version from crates.io and that the SDK is compatible with Anchor 0.28.0, 0.29.0, 0.30.1 and 0.31.1; "if you are on any other version, please move to v0.31.1" (`DOCS/pages/price-feeds/core/use-real-time-data/pull-integration/solana.mdx:17-28`). An `anchor-lang` version mismatch produces `PriceUpdateV2: anchor_lang::AccountDeserialize is not satisfied`; fix with `cargo update -p anchor-lang@a.b.c --precise x.y.z` (`DOCS/pages/price-feeds/core/troubleshoot/svm.mdx:6-18`).

Key types and functions (`XC/target_chains/solana/pyth_solana_receiver_sdk/src/price_update.rs`):

```rust
pub enum VerificationLevel { Partial { num_signatures: u8 }, Full }       // lines 18-25
impl VerificationLevel { pub fn gte(&self, other: VerificationLevel) -> bool } // lines 30-40

#[account]
pub struct PriceUpdateV2 {                                                // lines 49-56
    pub write_authority: Pubkey,
    pub verification_level: VerificationLevel,
    pub price_message: PriceFeedMessage,
    pub posted_slot: u64,
}
impl PriceUpdateV2 { pub const LEN: usize = 8 + 32 + 2 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8; } // line 59 (= 134 bytes)

pub struct Price { pub price: i64, pub conf: u64, pub exponent: i32, pub publish_time: i64 } // lines 176-182

impl PriceUpdateV2 {
    pub fn get_price_unchecked(&self, feed_id: &FeedId) -> Result<Price, GetPriceError>;            // 193-207
    pub fn get_price_no_older_than_with_custom_verification_level(
        &self, clock: &Clock, maximum_age: u64, feed_id: &FeedId, verification_level: VerificationLevel,
    ) -> Result<Price, GetPriceError>;                                                               // 235-255
    pub fn get_price_no_older_than(&self, clock: &Clock, maximum_age: u64, feed_id: &FeedId)
        -> Result<Price, GetPriceError>;                                                             // 279-291 (uses VerificationLevel::Full)
}
pub fn get_feed_id_from_hex(input: &str) -> Result<FeedId, GetPriceError>;  // 305-317; accepts 64 hex chars or 66 with 0x
```

`FeedId` is `pub type FeedId = [u8; 32]` (`XC/pythnet/pythnet_sdk/src/messages.rs:81`). `PriceFeedMessage` (`messages.rs:91-114`):

```rust
pub struct PriceFeedMessage {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,        // seconds
    pub prev_publish_time: i64,   // "for any time t, the unique update is the one such that prev_publish_time < t <= publish_time" (lines 99-101)
    pub ema_price: i64,
    pub ema_conf: u64,
}
```

Errors (`XC/target_chains/solana/pyth_solana_receiver_sdk/src/error.rs:3-18`): `GetPriceError::{PriceTooOld = 10000, InvalidWindowSize, MismatchedFeedId, InsufficientVerificationLevel, FeedIdMustBe32Bytes, FeedIdNonHexCharacter}`; the base 10000 is chosen "to avoid conflicts with the SDK user's program error codes" (line 7).

TWAP: `TwapUpdate { write_authority, twap: TwapPrice }` (lines 69-74), `get_twap_no_older_than(clock, maximum_age, window_seconds, feed_id)` (131-156), `TwapPrice { feed_id, start_time, end_time, price, conf, exponent, down_slots_ratio }` (161-172). Docs: TWAP window max 600 s (`pull-integration/solana.mdx:246`). Probably not needed for a daily FX snapshot but useful if you want a smoothed rate.

### 3.3 PriceUpdateV2 account byte layout

From `PriceUpdateV2::LEN` (`price_update.rs:59`) and the Borsh/Anchor encoding of the fields (test `check_size`, lines 331-335, asserts `DISCRIMINATOR.len() + get_packed_len::<PriceUpdateV2>() == LEN`):

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 8 | Anchor account discriminator | sha256("account:PriceUpdateV2")[..8]; verified by `Account<'info, PriceUpdateV2>` |
| 8 | 32 | `write_authority: Pubkey` | can close/overwrite the account (doc comment lines 43-48) |
| 40 | 1-2 | `verification_level` | Borsh enum: tag byte `0` = `Partial` followed by 1 byte `num_signatures`; tag `1` = `Full` with no payload. `LEN` reserves 2 bytes (the maximum). |
| 42 (or 41) | 32 | `price_message.feed_id` | |
| +32 | 8 | `price: i64` LE | |
| +40 | 8 | `conf: u64` LE | |
| +48 | 4 | `exponent: i32` LE | |
| +52 | 8 | `publish_time: i64` LE | |
| +60 | 8 | `prev_publish_time: i64` LE | |
| +68 | 8 | `ema_price: i64` LE | |
| +76 | 8 | `ema_conf: u64` LE | |
| +84 | 8 | `posted_slot: u64` LE | slot at which the update was posted |
| total | 134 | | |

Caveat (inference from Borsh enum rules, not stated in the docs): because `Full` serialises to 1 byte and `Partial` to 2, every field after `verification_level` shifts by one byte depending on the variant. Do not parse with fixed offsets; deserialise with Anchor (`Account<'info, PriceUpdateV2>`) or Borsh, or at minimum branch on the tag byte at offset 40.

### 3.4 How a program must verify a PriceUpdateV2 account

1. Owner check. The account must be owned by the receiver program (`rec5EK...`). "Users must ensure that the account passed to their instruction is owned by the Pyth Pull Oracle program. Using Anchor with the `Account<'info, PriceUpdateV2>` type will automatically perform this check. However, it is the developer's responsibility to perform this check if they are not using Anchor." (`DOCS/pages/price-feeds/core/use-real-time-data/pull-integration/solana.mdx:58-62`; same warning in `XC/target_chains/solana/pyth_solana_receiver_sdk/README.md:16`). Anchor's `Account<T>` checks `owner == T::owner()` which for `#[account]` types is `crate::ID` of the SDK (`lib.rs:22`), and checks the 8-byte discriminator.
2. Feed ID check. `get_price_unchecked` / `get_price_no_older_than` compare `price_message.feed_id` to the requested `FeedId` and return `MismatchedFeedId` otherwise (`price_update.rs:197-200`). Hardcode the FX feed IDs in the program (`get_feed_id_from_hex`, lines 305-317) rather than trusting the client. If you use price feed accounts (PDAs; section 3.6), the account address itself also pins the feed id (`pull-integration/solana.mdx:90-92`).
3. Verification level. `get_price_no_older_than` requires `VerificationLevel::Full` (`price_update.rs:279-291`); `..._with_custom_verification_level` lets you accept `Partial { num_signatures }` (235-255) via `gte` (30-40). The SDK warns that partial verification "lowers the threshold of guardians that need to collude to produce a malicious price update" (lines 16-17, 211-213). For a value-bearing FX rate, require `Full`. Updates posted with `post_update` (encoded-VAA path) are always `Full` (`programs/pyth-solana-receiver/src/lib.rs:221`); `post_update_atomic` records `Full` or `Partial` depending on how many guardian signatures were checked (`lib.rs:151-153`).
4. Staleness. `get_price_no_older_than(&Clock::get()?, maximum_age, &feed_id)` returns `PriceTooOld` unless `publish_time + maximum_age >= clock.unix_timestamp` (`price_update.rs:247-253`). The docs sample uses `maximum_age = 30` seconds (`pull-integration/solana.mdx:69-70`); the SDK README uses 60 (`README.md:30`). For a daily FX snapshot the job posts a fresh update and reads it in the same transaction, so a tight window (tens of seconds) is practical during FX hours; but see the weekend note in section 1 (publish_time will be Friday's).
5. Write authority / account lifecycle. Price update accounts are ephemeral; whoever posted them (`write_authority`) can overwrite or close them (`price_update.rs:43-48`; `programs/pyth-solana-receiver/src/lib.rs:341-346`, `397-402`). Your program should not store a price update account address for later reads; read the price inside the instruction that receives the account, and copy `price/conf/exponent/publish_time` into your own snapshot account.

Minimal Anchor consumer (from `DOCS/pages/price-feeds/core/use-real-time-data/pull-integration/solana.mdx:45-81`):

```rust
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

#[derive(Accounts)]
pub struct Sample<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub price_update: Account<'info, PriceUpdateV2>,   // owner + discriminator checked by Anchor
}

pub fn sample(ctx: Context<Sample>) -> Result<()> {
    let price_update = &mut ctx.accounts.price_update;
    let maximum_age: u64 = 30;
    let feed_id: [u8; 32] = get_feed_id_from_hex("0x...")?;   // use the FX feed id
    let price = price_update.get_price_no_older_than(&Clock::get()?, maximum_age, &feed_id)?;
    // price.price (i64), price.conf (u64), price.exponent (i32), price.publish_time (i64)
    Ok(())
}
```

Docs callout: "`PriceUpdateV2` guarantees that the account contains a verified price for some price feed at some point in time" - the feed and timestamp checks are the consumer's job (`pull-integration/solana.mdx:83-93`).

### 3.5 JS SDK: `@pythnetwork/pyth-solana-receiver`

Package `@pythnetwork/pyth-solana-receiver` v0.16.0 (`XC/target_chains/solana/sdk/js/pyth_solana_receiver/package.json:117, 134`). Depends on `@coral-xyz/anchor ^0.29.0`, `@pythnetwork/price-service-sdk`, `@pythnetwork/solana-utils`, `@solana/web3.js ^1.90.0` (lines 3-8); `@pythnetwork/hermes-client` is a dev dependency used by the examples (line 12).

`PythSolanaReceiver` class (`src/PythSolanaReceiver.ts:337`):
- `constructor({ connection, wallet, wormholeProgramId?, receiverProgramId?, pushOracleProgramId?, treasuryId? })` with defaults from `address.ts` (lines 345-391).
- `newTransactionBuilder(config: { closeUpdateAccounts?: boolean }, addressLookupAccount?)` (393-409); `closeUpdateAccounts` defaults to true per the type doc (lines 58-62).
- `buildPostPriceUpdateInstructions(priceUpdateDataArray: string[])` -> `{ postInstructions, priceFeedIdToPriceUpdateAccount, closeInstructions }` (479-549). Fully verified path: posts the encoded VAA via Wormhole, then `postUpdate` per feed into a fresh keypair account, and builds `reclaimRent` close instructions. Input strings are decoded as base64 (`IsomorphicBuffer.from(priceUpdateData, "base64")`, lines 493-495), so fetch from Hermes with `encoding: "base64"`.
- `buildPostPriceUpdateAtomicInstructions(priceUpdateDataArray)` (411-477): partially verified, single-transaction path.
- `buildUpdatePriceFeedInstructions(priceUpdateDataArray, shardId)` (551-623): updates long-lived price feed PDAs instead of ephemeral accounts.
- `buildPostEncodedVaaInstructions(vaa)` (625), `buildCloseEncodedVaaInstruction(encodedVaa)` (636), `buildClosePreviousEncodedVaasInstructions(maxInstructions)` (645), `buildClosePriceUpdateInstruction(priceUpdateAccount)` (659-670; calls `receiver.methods.reclaimRent()`).
- `batchIntoVersionedTransactions(instructions, priorityFeeConfig, addressLookupTable?)` (672).
- `fetchPriceUpdateAccount(pubkey)` (691), `fetchPriceFeedAccount(shardId, priceFeedId)` (705), `getPriceFeedAccountAddress(shardId, priceFeedId)` (720), `findOwnedEncodedVaaAccounts()` (735).
- Free function `getPriceFeedAccountForProgram(shardId, priceFeedId, pushOracleProgramId?)` (751).

`PythTransactionBuilder` (`src/PythSolanaReceiver.ts:100`): `addPostPriceUpdates(priceUpdateDataArray)` (142), `addPostPartiallyVerifiedPriceUpdates(...)` (183), `addUpdatePriceFeed(priceUpdateDataArray, shardId)` (221), `addPriceConsumerInstructions(callback)` (268), `addClosePreviousEncodedVaasInstructions(maxInstructions = 40)` (282), `getPriceUpdateAccount(priceFeedId)` (318). The builder appends the close instructions automatically when `closeUpdateAccounts` is true.

End-to-end flow from the docs (`pull-integration/solana.mdx:158-229`): `HermesClient.getLatestPriceUpdates(ids, { encoding: "base64" })` -> `.binary.data` -> `transactionBuilder.addPostPriceUpdates(data)` -> `addPriceConsumerInstructions(async (getPriceUpdateAccount) => [...your ixs...])` -> `provider.sendAll(await transactionBuilder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50000 }), { skipPreflight: true })`.

Discrepancy: the docs page also calls `hermesClient.getLatestTwaps(...)` (lines 310-314) and `transactionBuilder.addPostTwapUpdates` / `addTwapConsumerInstructions` (lines 340-351). Neither exists in the cloned `@pythnetwork/hermes-client` 3.1.0 (`XC/apps/hermes/client/js/src/hermes-client.ts`, no "twap" match) nor in `@pythnetwork/pyth-solana-receiver` 0.16.0 (no "twap" match in `PythSolanaReceiver.ts`). Treat TWAP client support as unverified.

### 3.6 Price feed accounts (push integration on Solana)

Each feed also has up to 2^16 "price feed account" PDAs derived from (shard id, feed id) under the push oracle program; shard 0 is sponsored by the Pyth Data Association for the feeds in the push list (`pull-integration/solana.mdx:100-147`; `DOCS/pages/price-feeds/core/push-feeds/solana.mdx:13-20`). They are the same `PriceUpdateV2` layout, so the on-chain program code is identical (`pull-integration/solana.mdx:107`). Sponsored FX accounts on Solana mainnet (shard 0), from `DOCS/pages/price-feeds/core/push-feeds/data/svm/solana_mainnet.json`:

| alias | shard-0 account | lines |
| --- | --- | --- |
| AUD/USD | `6pPXqXcgFFoLEcXfedWJy3ypNZVJ1F3mgipaDFsvZ1co` | 163-168 |
| GBP/USD | `G25Tm7UkVruTJ7mcbCxFm45XGWwsH72nJKNGcHEQw1tU` | 171-176 |
| EUR/USD | `Fu76ChamBDjE8UuGLV6GP2AcPPSU6gjhkNhAyuoPm7ny` | 179-184 |
| USDC/USD | `Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX` | 59-64 |

Push cadence for these: `time_difference: 60`, `price_deviation: 0.5`, `confidence_ratio: 100` (same lines). Note the table is labelled "Solana mainnet and devnet" (`push-feeds/solana.mdx:17`), but the JSON itself carries no cluster field; whether devnet shard-0 accounts are actually kept fresh is unverified.

## 4. Solidity SDK (`@pythnetwork/pyth-sdk-solidity`)

Package `@pythnetwork/pyth-sdk-solidity` version `4.3.1` (`XC/target_chains/ethereum/sdk/solidity/package.json:21, 33`); Apache-2.0; ABIs in `abis/` including `IPyth.json` (`README.md:3`). Install `npm install @pythnetwork/pyth-sdk-solidity`; for Foundry add remapping `@pythnetwork/pyth-sdk-solidity/=node_modules/@pythnetwork/pyth-sdk-solidity` (`DOCS/pages/price-feeds/core/use-real-time-data/pull-integration/evm.mdx:20-47`).

### 4.1 `IPyth` (`XC/target_chains/ethereum/sdk/solidity/IPyth.sol`)

| Function | Lines | Notes |
| --- | --- | --- |
| `getPriceUnsafe(bytes32 id) view returns (PythStructs.Price)` | 19-21 | "without any sanity checks ... may be arbitrarily far in the past" (11-17) |
| `getPriceNoOlderThan(bytes32 id, uint age) view returns (PythStructs.Price)` | 28-31 | reverts `StalePrice` if older than `age` seconds (23-27) |
| `getEmaPriceUnsafe(bytes32 id)` / `getEmaPriceNoOlderThan(bytes32 id, uint age)` | 44-46 / 54-57 | EMA price |
| `updatePriceFeeds(bytes[] calldata updateData) payable` | 66 | requires fee from `getUpdateFee`; "Prices will be updated if they are more recent than the current stored prices" (59-65) |
| `updatePriceFeedsIfNecessary(bytes[] updateData, bytes32[] priceIds, uint64[] publishTimes) payable` | 84-88 | reverts `NoFreshUpdate` if on-chain is already at least as new |
| `getUpdateFee(bytes[] calldata updateData) view returns (uint feeAmount)` | 93-95 | fee in wei |
| `getTwapUpdateFee(bytes[] updateData)` | 100-102 | |
| `parsePriceFeedUpdates(bytes[] updateData, bytes32[] priceIds, uint64 minPublishTime, uint64 maxPublishTime) payable returns (PythStructs.PriceFeed[])` | 121-126 | parse without storing; use for a fixed-timestamp price (104-120) |
| `parsePriceFeedUpdatesWithConfig(..., bool checkUniqueness, bool checkUpdateDataIsMinimal, bool storeUpdatesIfFresh) payable returns (PriceFeed[], uint64[] slots)` | 149-163 | |
| `parseTwapPriceFeedUpdates(bytes[] updateData, bytes32[] priceIds) payable returns (TwapPriceFeed[])` | 183-189 | exactly two updates |
| `parsePriceFeedUpdatesUnique(...)` | 204-209 | first update at/after `minPublishTime` |

### 4.2 `PythStructs` (`XC/target_chains/ethereum/sdk/solidity/PythStructs.sol`)

```solidity
struct Price {            // lines 13-22
    int64 price;          // line 15
    uint64 conf;          // line 17  confidence interval around the price
    int32 expo;           // line 19  price exponent
    uint publishTime;     // line 21  unix timestamp
}
struct PriceFeed { bytes32 id; Price price; Price emaPrice; }   // lines 25-32
```

"Both the price and confidence are stored in a fixed-point numeric representation, `x * (10^expo)`" and "The confidence interval roughly corresponds to the standard error of a normal distribution" (lines 5-9). Note `publishTime` is `uint` (uint256) in Solidity while Hermes/Solana use `i64` seconds.

### 4.3 `PythUtils` and `PythErrors`

- `PythUtils.convertToUint(int64 price, int32 expo, uint8 targetDecimals) returns (uint256)` (`PythUtils.sol:21-70`): reverts `NegativeInputPrice` for negative prices, `InvalidInputExpo` for `expo < -255`, `ExponentOverflow` if `targetDecimals + expo` is outside [-58, 58]; rounds down (lines 15-20). Useful to convert an FX price to e.g. 18 decimals.
- `PythUtils.deriveCrossRate(int64 price1, int32 expo1, int64 price2, int32 expo2, int32 targetExponent) returns (uint256)` (`PythUtils.sol:84-126`): `a/b` and `c/b` -> `a/c`; "doesn't return the combined confidence interval" (line 80). Docs example: `ETH/EUR = ETH/USD / EUR/USD` (`DOCS/pages/price-feeds/core/derive-cross-rate.mdx:12-15, 62-73`); caveats at lines 81-86.
- `PythErrors` (`PythErrors.sol`): `StalePrice()` selector `0x19abf40e` (27-29), `PriceFeedNotFound()` `0x14aebe68` (24-26), `PriceFeedNotFoundWithinRange()` `0x45805f5d` (21-23), `InsufficientFee()` `0x025dbdd4` (15-17), `NoFreshUpdate()` `0xde2c57fa` (18-20), `InvalidUpdateData()` `0xe69ffece` (12-14). Full table in `DOCS/pages/price-feeds/core/error-codes/evm.mdx:9-24`.

### 4.4 How staleness is enforced on-chain

`AbstractPyth.getPriceNoOlderThan` is `price = getPriceUnsafe(id); if (diff(block.timestamp, price.publishTime) > age) revert PythErrors.StalePrice();` (`XC/target_chains/ethereum/sdk/solidity/AbstractPyth.sol:50-60`). Note `diff` is absolute, so a `publishTime` slightly in the future relative to `block.timestamp` is tolerated up to `age`. `Pyth.getPriceUnsafe` reverts `PriceFeedNotFound` if the feed has never been written on that chain (`publishTime == 0`, `XC/target_chains/ethereum/contracts/contracts/pyth/Pyth.sol:184-194`). The deprecated `getPrice(id)` is `getPriceNoOlderThan(id, getValidTimePeriod())` (`AbstractPyth.sol:29-34`); do not rely on it.

### 4.5 Recommended EVM pattern

From `DOCS/pages/price-feeds/core/use-real-time-data/pull-integration/evm.mdx:62-112` (also `XC/target_chains/ethereum/sdk/solidity/README.md:42-70`):

```solidity
import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

IPyth pyth = IPyth(pythContract);                        // 0x2880aB15... on Monad
function snapshot(bytes[] calldata priceUpdate) external payable {
    uint fee = pyth.getUpdateFee(priceUpdate);
    pyth.updatePriceFeeds{ value: fee }(priceUpdate);    // revert reasons: InsufficientFee, InvalidUpdateData, ...
    PythStructs.Price memory p = pyth.getPriceNoOlderThan(FEED_ID, MAX_AGE);  // reverts StalePrice (0x19abf40e)
    // then: confidence check (section 7), sign/exponent handling, store p.price/p.conf/p.expo/p.publishTime
}
```

Docs examples use `age = 60` seconds (`pull-integration/evm.mdx:12, 99`), the SDK README uses 10 (`README.md:66-68`). For a snapshot at a fixed daily timestamp, `parsePriceFeedUpdates(updateData, ids, minPublishTime, maxPublishTime)` with an update fetched from Hermes `/v2/updates/price/{publish_time}` lets the contract enforce that the stored rate is from the intended time window rather than "latest" (`IPyth.sol:104-126`; best-practices "Use Delayed Settlement", `DOCS/pages/price-feeds/core/best-practices.mdx:61-63`).

## 5. FX price feed IDs

### 5.1 Where IDs come from

The docs "Price Feed IDs" page is not static: `<PriceFeedIds />` (`DOCS/pages/price-feeds/core/price-feeds/price-feed-ids.mdx:27`) fetches `https://hermes.pyth.network/v2/price_feeds` and `https://hermes-beta.pyth.network/v2/price_feeds` at render time and derives the shard-0 Solana account for each (`DOCS/components/PriceFeedIds.tsx:157-203`). Hence the clones contain no complete feed-ID list. The Pyth Pro (Lazer) ID table likewise fetches at runtime (`DOCS/components/LazerPriceIdTable.tsx:4-10`) and Pro IDs are a different numbering (`DOCS/pages/price-feeds/pro/price-feed-ids.mdx:6-10`); do not mix them with Core IDs.

Authoritative lookup: `GET https://hermes.pyth.network/v2/price_feeds?asset_type=fx` (optionally `&query=eur`) returns `[{ id, attributes: { symbol, asset_type, base, quote_currency, ... } }]` (`XC/apps/hermes/server/src/api/rest/v2/price_feeds_metadata.rs:19-62`; `XC/apps/hermes/server/src/api/types.rs:321-326`; asset types enum incl. `fx` at `types.rs:330-342`). Stable and Beta channels have different IDs (`DOCS/pages/price-feeds/core/price-feeds.mdx:26`); Stable IDs are chain-independent (the same `eaa020c6...` USDC/USD id appears in both `monad_mainnet.json:32` and `solana_mainnet.json:61`).

### 5.2 IDs that are verifiable from the clones (Stable channel)

Source: `DOCS/pages/price-feeds/core/push-feeds/data/svm/solana_mainnet.json` unless noted. IDs are 32-byte hex; prefix with `0x` for Solidity/`get_feed_id_from_hex`.

| Pair (alias) | Feed ID (hex) | Citation |
| --- | --- | --- |
| EUR/USD | `a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b` | `solana_mainnet.json:179-181` |
| GBP/USD | `84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1` | `solana_mainnet.json:171-173` |
| AUD/USD | `67a6f93030420c1c9e3fe37c1ab6b77966af82f995944a9fefce357a22854a80` | `solana_mainnet.json:163-165` |
| USDC/USD | `eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a` | `solana_mainnet.json:59-61`; also `DOCS/pages/price-feeds/core/push-feeds/data/evm/monad_mainnet.json:31-32` |
| USDT/USD | `2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b` | `monad_mainnet.json:38-39` |
| XAU/USD (gold) | `765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2` | `solana_mainnet.json:195-197`; `monad_mainnet.json:213-214` |
| XAG/USD (silver) | `f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e` | `solana_mainnet.json:187-189`; `monad_mainnet.json:220-221` |

Not found in either clone (no file contains an ID for them): JPY (USD/JPY or JPY/USD), INR, CAD, CHF, BRL, MXN, SGD, and USDG/USD. A repo-wide grep for these pair names returned only prose (MCP skill docs, cross-rate docs) and the `FX.USD/JPY` product-metadata example without an ID. These must be fetched from Hermes `/v2/price_feeds?asset_type=fx` and recorded in the protocol config with a verification step; they are unverified here.

### 5.3 Quote direction and symbol conventions

- Pyth symbols are `AssetType.Base/Quote` with separate `base` and `quote_currency` attributes; FX and Metal products share the template `symbol.......... AssetType.BaseCurrency/QuoteCurrency` (`DOCS/pages/price-feeds/core/pythnet-reference/product-metadata.mdx:79-94`). The docs' FX example is `FX.USD/JPY` with `base: USD`, `quote_currency: JPY`, `generic_symbol: USDJPY`, `tenor: Spot` (`product-metadata.mdx:96-109`). So Pyth Core follows market convention: majors like EUR, GBP, AUD are quoted as `X/USD` (confirmed by the three IDs above), while JPY is quoted as `USD/JPY` in the documented example. The market-hours page refers to `USDBRL, USDCOP, USDCLP, USDPEN` (`market-hours.mdx:15`), suggesting EM pairs are `USD/X`. Direction for INR, CAD, CHF, MXN, SGD is not stated anywhere in the clones; read `base`/`quote_currency` from Hermes metadata per feed rather than assuming. The MCP skill text claiming "All FX feeds quote per USD" (`XC/apps/mcp/skills/pyth-fx-converter/SKILL.md:60-66, 115`) describes the Pyth Pro (Lazer) catalog and contradicts the Core `FX.USD/JPY` example; do not rely on it for Core IDs.
- Docs advise not to parse the symbol string; use the attributes (`product-metadata.mdx:115-119`).
- Cross rates: Pyth does not publish non-USD crosses; derive them (`derive-cross-rate.mdx:5-15`; `PythUtils.deriveCrossRate`).

### 5.4 Exponent conventions

- Value = `price * 10^expo`; `conf` uses the same exponent (`DOCS/pages/price-feeds/core/best-practices.mdx:6-16`; `PythStructs.sol:5-9`; `price_update.rs:174-175`). `expo` is negative for fixed-point decimals (docs examples use -5 and -8; Hermes schema example `-8`, `XC/apps/hermes/client/js/schema.json` `RpcPrice.expo`). The exponent is per feed and is not guaranteed constant; read it from each update rather than hardcoding, and normalise with `PythUtils.convertToUint` on EVM.
- Hermes JSON returns `price` and `conf` as strings "to avoid precision loss" (`schema.json` `RpcPrice`), `expo` as int32, `publish_time` as int64 seconds.

### 5.5 Market hours relevant to a daily FX snapshot

`DOCS/pages/price-feeds/core/market-hours.mdx:14-16`: FX "From Sunday 5PM ET to Friday 5PM ET", trading continues during most US holidays; Emerging-markets FX "From Sunday 6PM ET to Friday 5PM ET", with INR, IDR, PHP, KRW, TWD, CNH, TRY, ZAR, MXN, BRL, COP, CLP, PEN listed as EM currencies whose liquidity "can be significantly limited at the start of the trading week, outside local market trading hours, and during local holidays, which can lead to wider confidence intervals"; Metals have a daily 5-6PM ET maintenance window. Outside hours Pyth "may return a stale price" and SDK staleness checks will fail (`best-practices.mdx:18-34`). Consequence: schedule the daily snapshot inside FX hours (e.g. around 16:00 ET or a London fix), and decide explicitly whether weekend snapshots reuse Friday's rate (with a larger `maximum_age`) or are skipped.

## 6. Hermes API and clients

### 6.1 Endpoints

- Public instance `https://hermes.pyth.network`; Beta `https://hermes-beta.pyth.network` (`DOCS/pages/price-feeds/core/api-instances-and-providers/hermes.mdx:16, 21`). Rate limit: 30 requests per 10 seconds per IP, 429 for the following 60 s; production should use a provider (Triton, P2P, extrnode, Liquify) (`hermes.mdx:25-41`).
- Routes (`XC/apps/hermes/server/src/api.rs:176-197`): `/v2/updates/price/latest` (179), `/v2/updates/price/stream` (176), `/v2/updates/price/:publish_time` (194), `/v2/updates/twap/:window_seconds/latest` (181), `/v2/updates/publisher_stake_caps/latest` (190), `/v2/price_feeds` (197). The `/api/*` routes are legacy (`schema.json` paths).
- `GET /v2/updates/price/latest?ids[]=<hex>&ids[]=<hex>[&encoding=hex|base64][&parsed=true|false][&ignore_invalid_price_ids=false]` (`XC/apps/hermes/server/src/api/rest/v2/latest_price_updates.rs:21-45`). `encoding` defaults to `hex` (34-36; `types.rs:190-196`), `parsed` defaults to `true` (38-40). The hex form of `ids[]` in a URL is `ids%5B%5D=` (`DOCS/pages/price-feeds/core/fetch-price-updates.mdx:30-33`).
- Response shape: `{ binary: { encoding: "hex"|"base64", data: string[] }, parsed?: [{ id, price: { price, conf, expo, publish_time }, ema_price: {...}, metadata: { slot, proof_available_time, prev_publish_time } }] }` (`fetch-price-updates.mdx:38-87`; `schema.json` `PriceUpdate`, `BinaryUpdate`, `ParsedPriceUpdate`, `RpcPrice`, `RpcPriceFeedMetadataV2`). `binary.data` items are the bytes to pass to `updatePriceFeeds`/`parsePriceFeedUpdates` (EVM; one `bytes` element each) or to the Solana receiver. Each binary blob begins with the accumulator magic `0x504e4155` ("PNAU") (`XC/price_service/sdk/js/src/AccumulatorUpdateData.ts:4, 37-43`) and can carry multiple feeds in one blob.
- Fixed-time snapshots: `GET /v2/updates/price/{publish_time}?ids[]=...` returns the update valid at that unix time (`api.rs:194`; client method below). This is the natural source for a "rate as of 16:00 UTC" snapshot combined with `parsePriceFeedUpdates(min,max)` on EVM.

### 6.2 `@pythnetwork/hermes-client` (TypeScript)

Package `@pythnetwork/hermes-client` v3.1.0 (`XC/apps/hermes/client/js/package.json:77, 97`); deps `@zodios/core`, `eventsource`, `zod` (lines 5-9); schemas generated from Hermes OpenAPI (`schema.json`, script `build:schemas`, line 88). Class `HermesClient` (`src/hermes-client.ts:52`):

- `new HermesClient(endpoint, { timeout?, httpRetries?, headers?, accessToken? })` (lines 29-71); default timeout 5000 ms, 3 retries with exponential backoff (21-22, 78).
- `getPriceFeeds({ query?, assetType?, fetchOptions? }) : Promise<PriceFeedMetadata[]>` -> `/v2/price_feeds` (130-149). `assetType` values include `"fx"` (doc comment line 126; `schema.json` `AssetType`).
- `getLatestPriceUpdates(ids: HexString[], { encoding?, parsed?, ignoreInvalidPriceIds? }?, fetchOptions?) : Promise<PriceUpdate>` -> `/v2/updates/price/latest` (195-215). Default encoding hex (doc 189).
- `getPriceUpdatesAtTimestamp(publishTime: number, ids, options?, fetchOptions?)` -> `/v2/updates/price/{publish_time}` (231-252).
- `getPriceUpdatesStream(ids, { encoding?, parsed?, allowUnordered?, benchmarksOnly?, ignoreInvalidPriceIds? }?) : Promise<EventSource>` -> `/v2/updates/price/stream` (271-308). SSE connections auto-close after 24 h (`fetch-price-updates.mdx:97`).
- `getLatestPublisherCaps(...)` (162-180).
- URLs are built as `<endpoint>/v2/<path>` (322-330).

For on-chain submission "these updates are returned as binary data and is serialized as either a base64 string or a hex string depending on the chosen encoding" (`XC/apps/hermes/client/js/README.md:68-71`). EVM: use `encoding: "hex"` and pass each `binary.data[i]` (prefixed `0x`) as one element of `bytes[] updateData`. Solana: use `encoding: "base64"` because `buildPostPriceUpdateInstructions` decodes base64 (`PythSolanaReceiver.ts:493-495`; docs sample `pull-integration/solana.mdx:173-178`).

Naming discrepancies between the docs snapshot and client 3.1.0: docs call `getStreamingPriceUpdates` (`fetch-price-updates.mdx:141`) and `getLatestTwaps` (`pull-integration/solana.mdx:310`); the client exposes `getPriceUpdatesStream` and has no TWAP method. Docs also call `getPriceFeeds("btc", "crypto")` positionally (`fetch-price-updates.mdx:129`) while 3.1.0 takes an options object.

Supporting package `@pythnetwork/price-service-sdk` v1.9.0 (`XC/price_service/sdk/js/package.json:72, 90`) exposes `parseAccumulatorUpdateData(Buffer)` (`src/AccumulatorUpdateData.ts:168`) and `parsePriceFeedMessage(Buffer) -> { feedId, price, confidence, exponent, publishTime, prevPublishTime, emaPrice, emaConf }` (lines 15-24, 45-77), useful for off-chain validation of a blob before posting.

## 7. Confidence interval guidance

What Pyth says (`DOCS/pages/price-feeds/core/best-practices.mdx:72-93`):
- `conf` is an aggregate interval `(mu - sigma, mu + sigma)` built from publisher intervals that each target 95% coverage; under disagreement it behaves like an interquartile range of publisher submissions (lines 76-82).
- Two recommended responses when uncertainty is high: (1) "use a discounted price in the direction favorable to it" - value collateral at `mu - sigma`, liabilities at `mu + sigma` (line 84, 87-89); (2) "decide that there is too much uncertainty when `sigma/mu` exceeds some threshold and choose to pause any new activity that depends on the price of this asset" (line 85).
- For settlement at a single point in time, options are the EMA price (lower weight on wide-confidence samples), the aggregate price, or a contract that depends on confidence (e.g. delay settlement until the interval narrows, with a guaranteed eventual settlement) (lines 89-93).
- Illustration of scale: "$50000 +- $1000 ... is an unusually large confidence interval for bitcoin; the confidence interval is typically $50" (line 87), i.e. ~0.1% normal, ~2% abnormal, for BTC. No FX-specific numbers are given.

Computing a relative confidence bound. Since `price` and `conf` share `expo`, the ratio is exponent-free:

```
rel_conf = conf / |price|           // e.g. conf=1500, price=12276250 -> 1.22e-4 (0.012%)  (numbers from best-practices.mdx:10-16)
bps      = conf * 10_000 / |price|
```

Solidity (no floating point; `conf` is uint64, `price` is int64 and must be > 0 for FX):

```solidity
require(p.price > 0, "bad price");
// reject if conf/price > MAX_CONF_BPS / 10_000
require(uint256(p.conf) * 10_000 <= uint256(uint64(p.price)) * MAX_CONF_BPS, "conf too wide");
```

Rust (Solana): `require!(price.price > 0 && (price.conf as u128) * 10_000 <= (price.price as u128) * MAX_CONF_BPS, ...)`.

Thresholds actually used in the repos (all are "push again when conf/price exceeds X percent", not consumer rejection thresholds, but they show the scale maintainers consider normal):
- Price pusher `confidence_ratio` is "confidence to price ratio ... (%)"; the README discourages low values "because it triggers push for every update in high confidence periods" (`XC/apps/price_pusher/README.md:29-30, 39`). Sample configs use 100 (i.e. effectively disabled) with an early-update value of 10 or 5 (`XC/apps/price_pusher/price-config.stable.sample.yaml:5, 10, 14, 19`; `README.md:39, 49, 68`). All sponsored feeds in the docs' push lists use `confidence_ratio: 100` (`solana_mainnet.json`, `monad_mainnet.json`).
- The best-practices BTC anecdote implies ~0.1% is a normal interval and ~2% is abnormal (`best-practices.mdx:87`).

Recommendation for FX snapshots (engineering judgement, not a Pyth number): record `conf` alongside `price` in every snapshot; reject or flag when `conf/price` exceeds a per-currency threshold set from observed data (majors will be far tighter than EM pairs; see the EM warning in `market-hours.mdx:15`); and, where a one-sided error is cheaper for the protocol, apply `price -/+ conf` per `best-practices.mdx:84`. Pyth also notes publishers' intervals widen during volatility and when venues diverge (`best-practices.mdx:74`).

## 8. Chainlink (cross-check)

- Nothing in the clones defines Chainlink's `AggregatorV3Interface`; the only mention is the migration guide, which describes `latestRoundData()` returning `(uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)` by way of Pyth's adapter (`DOCS/pages/price-feeds/core/migrate-an-app-to-pyth/chainlink.md:42-46`; `XC/target_chains/ethereum/sdk/solidity/PythAggregatorV3.sol:99-119`). That `AggregatorV3Interface.latestRoundData` is the standard EVM cross-check interface is general knowledge, not verifiable from these repos.
- `PythAggregatorV3` (in the Solidity SDK) wraps one Pyth feed as a Chainlink-style aggregator: `decimals()` = `-expo` (`PythAggregatorV3.sol:40-43`), `latestRoundData()` uses `getPriceUnsafe` and sets `roundId = uint80(publishTime)` (99-119). It performs no staleness or confidence check and "does not store any roundId information on-chain" (11-15), so if used as a shim the caller must check `updatedAt` itself. One adapter per feed (`chainlink.md:44-46`).
- Whether Chainlink Data Feeds run on Monad or on Solana cannot be verified from the clones. To the best of my knowledge Chainlink does not operate price feeds on Solana (it historically ran a limited Solana data-feeds program), but this is unverified here; treat any Solana cross-check as requiring a different source (e.g. a second Pyth channel, Switchboard, or an off-chain reference such as a central-bank fix).

## 9. Not found / unverified

Addresses and programs
- Monad: the undocumented second store entries `0xB754BA51E3861Ac0Cb67f73CD046dE790A36508d` (mainnet) and `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379` (testnet) in `XC/contract_manager/src/store/contracts/EvmPriceFeedContracts.json:1063-1073` have no docs page, README or explorer link in the clones. Purpose unknown; not recommended without confirmation from Pyth.
- Whether the documented Monad address `0x2880aB15...` is currently a "stable"/Wormhole-guardian deployment or has been cut over to the Pro-compatible receiver is unclear: the store labels it `pro-compatible-production` but also lists both a `stable` and a `pro-compatible-production` Wormhole receiver for Monad (`EvmWormholeContracts.json:974-978, 1178-1182`). This does not change the consumer interface (`IPyth`) but may affect which Hermes/Pro data sources the contract accepts.
- Current update fee on Monad: not listed in `current-fees.mdx`; default is 1 wei-equivalent per the docs, but confirm via `getUpdateFee`.
- Solana devnet freshness of sponsored shard-0 FX accounts: the push list says "mainnet and devnet" but carries no per-cluster data.
- The `rec2HHDD...` pro-compatible Solana receiver program and `pyt2F414...` push oracle are present in SDK code only; no docs.

Feed IDs
- Not found: JPY (either direction), INR, CAD, CHF, BRL, MXN, SGD, USDG/USD. Lookup: `https://hermes.pyth.network/v2/price_feeds?asset_type=fx` (and `?query=usdg` for crypto asset type); verify `attributes.base`/`quote_currency` and that the feed is on the Stable channel.
- Quote direction for INR, CAD, CHF, MXN, SGD is unverified; only the `FX.USD/JPY` convention (docs example) and `USDBRL`-style EM naming (market-hours page) are evidenced.
- Per-feed exponents: not in the clones; read from updates.

Clients and docs drift
- `HermesClient.getLatestTwaps`, `getStreamingPriceUpdates`, positional `getPriceFeeds(query, assetType)` (docs) vs. `getPriceUpdatesStream`, options-object `getPriceFeeds`, no TWAP method (client 3.1.0 in the clone).
- `PythTransactionBuilder.addPostTwapUpdates` / `addTwapConsumerInstructions` (docs) are absent from `@pythnetwork/pyth-solana-receiver` 0.16.0 in the clone.
- Published npm/crates versions may be newer than the clone's `package.json`/`Cargo.toml` values (4.3.1, 3.1.0, 0.16.0, 2.0.0).

Chainlink
- No Chainlink interface or deployment data exists in the clones; Chainlink availability on Monad and Solana is unverified.

Other
- Git history is unavailable (both clones are depth 1), so dates of address additions and deprecations cannot be established.
- Network access to docs.pyth.network and hermes.pyth.network was unavailable during this research; every live-service claim (rate limits, endpoints, feed lists) reflects the repo snapshots cited above.
