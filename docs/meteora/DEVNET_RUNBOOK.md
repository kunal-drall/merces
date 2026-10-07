# Devnet runbook: graduating a Merces curve-mode series end to end

What the lead runs, from a machine with Solana devnet access, to reproduce the D10 demonstration:
create the DBC config as Merces, create the pool for a test issuer, buy out the curve with test wallets,
lock the issuer allocation, migrate to DAMM v2, withdraw the migration fees, and print where every USDC went.

The same flow has been executed in this repository against a **local validator running the real program
binaries** (`pnpm --filter @merces/meteora test:local-validator`, §6); devnet differs only in RPC, funding and
the DAMM v2 config key.

## 1. Prerequisites

- Node 22, pnpm 10 (`pnpm install` at the repository root).
- Solana CLI (any recent Agave; only `solana-keygen` and `solana airdrop` are used).
- Network access to `https://api.devnet.solana.com` (or any devnet RPC; pass `--rpc <url>`).
- **Never mainnet.** The CLIs refuse `mainnet` clusters and URLs.

Programs on devnet (identical ids on mainnet; research memo §1): DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`,
DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`, Jupiter locker `LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn`.

## 2. Keypairs and funding

```bash
mkdir -p ~/merces-devnet && cd ~/merces-devnet
solana-keygen new -o payer.json --no-bip39-passphrase     # pays rent and fees, funds test buyers; doubles as Merces
solana-keygen new -o issuer.json --no-bip39-passphrase    # the test issuer (pool creator)
# optional separate Merces wallet (partner: fee_claimer / leftover_receiver)
solana-keygen new -o merces.json --no-bip39-passphrase
```

SOL (devnet faucet: `solana airdrop 2 <pubkey> --url devnet`, or https://faucet.solana.com; airdrops are rate
limited, repeat as needed):

| Wallet | Needs | Why |
| --- | --- | --- |
| payer | **≥ 3 SOL** (5 recommended) | config account rent (1048 bytes ≈ 0.0082 SOL), pool + 2 vaults + Token-2022 mint with metadata (≈ 0.02 SOL), 0.02 SOL per test buyer, a 0.1 SOL top-up of the DBC pool authority for flash rent (returned to the authority, not to you), DAMM v2 pool + positions + locker escrow rent repaid through flash rent (≈ 0.05 SOL), transaction fees |
| issuer | ≥ 0.05 SOL | signs `initialize_virtual_pool` and `withdraw_migration_fee(1)`; the payer pays those fees but the issuer's quote ATA rent is paid by the payer too — 0.05 is a safety margin |
| merces (if separate) | ≥ 0.05 SOL | signs partner withdrawals |

USDC (quote). Two options:

1. **Mock USDC (recommended for the demonstration):** pass `--create-quote-mint`. The script creates a classic SPL
   mint with 6 decimals and the payer as mint authority, mints exactly what the buyers need, and the config file's
   `quoteMint` is overridden. Nothing to fund.
2. **A real devnet USDC mint:** pass `--quote-mint <mint>`; the payer's USDC ATA must hold at least
   `1.02 × X / 0.99` (the gross including the 1% fee and a 2% margin; for X = 1,000 USDC that is 1,030.6 USDC) which
   the script transfers to the buyers. Circle's devnet USDC faucet is https://faucet.circle.com; the devnet USDC mint
   address could not be verified from this container (docs blocked) — take it from Circle's page, not from memory.
   The script checks the mint: 6 decimals, SPL Token or Token-2022 with zero transfer fee and no extensions other than
   `MetadataPointer`/`TokenMetadata` (otherwise a Meteora token badge is needed; research memo §8).

## 3. Generate the series config

Write the issuer input (amounts in USDC base units, 6 decimals; every omitted field takes the default in
`docs/assumptions/track-d.md`):

```json
{
  "seriesLabel": "devnet-pilot-1",
  "trailingAnnualIncome": "400000000",
  "targetRaise": "1000000000",
  "unitsOnCurve": "100",
  "issuerUnits": "10",
  "issuerVesting": { "cliffSeconds": 60, "periods": 2, "periodSeconds": 60 },
  "quoteMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
}
```

(`quoteMint` is only a placeholder when `--create-quote-mint` is used; otherwise put the devnet USDC mint.)

```bash
cd /path/to/merces
pnpm --filter @merces/meteora config -- --input ~/merces-devnet/issuer.json --out ~/merces-devnet/series-config.json
```

The command prints the anchoring (raise = min(target, 3 × income) = 1,000 USDC here; start price 3.636 USDC,
P0 10 USDC, migration price 27.5 USDC), the supply split, and the proceeds breakdown (issuer 990 USDC, Merces ≈ 8.08
USDC of trading fees, DAMM v2 pool 9.98 USDC, Meteora 2 + ≈ 2.02 USDC). The JSON is deterministic and carries a
`configHash`; the graduation state file pins it.

## 4. Run the graduation

```bash
pnpm --filter @merces/meteora graduate -- \
  --cluster devnet \
  --payer ~/merces-devnet/payer.json \
  --issuer ~/merces-devnet/issuer.json \
  --merces ~/merces-devnet/merces.json \
  --config ~/merces-devnet/series-config.json \
  --create-quote-mint \
  --buyers 3 \
  --state ~/merces-devnet/graduation-state.json
```

The script is **idempotent and resumable**: every step reads the chain first and skips what is done; keypairs it
generates (config, base mint, buyers) and every signature are saved in the state file before sending. Re-run the
same command after any failure. The state file refuses to be reused with another config, cluster or set of wallets.

Order of operations and what each step sends:

| # | Step | Instruction(s) | Signers |
| --- | --- | --- | --- |
| 1 | quote mint | (mock) `create_account` + `initialize_mint2` | payer, mint |
| 2 | config | `create_config` (Merces = `fee_claimer` = `leftover_receiver`) | payer, config keypair |
| 3 | pool | `initialize_virtual_pool_with_token2022` (creator = issuer) | payer, issuer, base mint keypair |
| 4 | buyers | SOL transfers, ATA creation, `mint_to` (or `transfer_checked` from the payer's USDC) | payer |
| 5 | buys | `swap2` with `SwapMode::PartialFill` until `quote_reserve >= X` (round-robin over buyers) | each buyer |
| 6 | locker | `create_locker` (only if the config has locked vesting) after topping the pool authority up to 0.1 SOL | payer |
| 7 | migration | `migration_damm_v2` with remaining account 0 = DAMM v2 config, 600k CU | payer, 2 position NFT mints |
| 8 | fees | `withdraw_migration_fee(1)` by the issuer, `withdraw_migration_fee(0)` by Merces (skipped when the share is 0) | payer + sender |
| 9 | leftover | `withdraw_leftover` (fixed supply) | payer |
| 10 | claims | `claim_trading_fee` (partner), `claim_creator_trading_fee` if any, surplus withdrawals if any | payer + claimer |
| 11 | report | reads balances and prints the table | — |

After step 2 the script asserts that the on-chain `PoolConfig` stores exactly the values the generator predicted
(`migration_sqrt_price`, `swap_base_amount`, `migration_base_threshold`, supply, fee fields). A mismatch aborts.

### The DAMM v2 config key

Step 7 needs a DAMM v2 `Config` account whose `pool_creator_authority` is the DBC pool authority and whose fee
matches the config's `migration_fee_option` (100 bps by default). Meteora publishes one key per option
(`DAMM_V2_MIGRATION_FEE_ADDRESS[2] = Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` for 100 bps) and the SDK uses the
same list on every cluster, but **the docs do not state that these accounts exist on devnet** (research memo §10.2).
Check before step 7:

```bash
solana account Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp --url devnet
```

If it does not exist on devnet: (a) complete steps 1–6 with the script (it stops with a clear error at step 7),
then graduate the pool with Meteora's manual migrator https://migrator.meteora.ag (supports devnet; it supplies its own
config) and re-run the script to perform steps 8–11; or (b) ask Meteora for the devnet key and pass `--damm-config <key>`.

### Flash rent

`create_locker` and `migration_damm_v2` borrow account rent from the DBC pool authority and the payer repays it
(PROG/instructions/migration/flash_rent.rs:6-25; "someone has to fund 1 SOL for pool authority"). The script
transfers up to 0.1 SOL from the payer to the authority `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` when its balance
is below that. If migration fails with an insufficient-funds error inside the DAMM v2 CPI, raise the top-up
(`poolAuthorityMinLamports` in `runGraduation`, or send SOL to the authority manually) and re-run.

## 5. What the lead must verify

Use the report and `pnpm --filter @merces/meteora state -- --cluster devnet --pool <DBC pool>`; cross-check on
https://explorer.solana.com/?cluster=devnet.

1. **Config** (`state` output / explorer): `fee_claimer` and `leftover_receiver` = the Merces wallet; `quote_mint` = the
   USDC mint used; `migration_fee_percentage = 99`, `creator_migration_fee_percentage = 100`; `token_decimal = 6`;
   `migration_option = 1`.
2. **Pool:** `creator` = issuer; base mint is Token-2022 with mint authority `None` (`spl-token display <base mint>
   --url devnet`); `quote_reserve >= migration_quote_threshold` after step 5; `migration_progress = 3` and `is_migrated = 1`
   after step 7.
3. **Migration transaction** on the explorer: inner instructions `cpamdpZ…::initialize_pool`, `permanent_lock_position`,
   Token-2022 `set_authority` of the position NFT account to the Merces wallet; the first account in "remaining accounts"
   is the DAMM v2 config.
4. **DAMM v2 pool** address printed by the report = `derivePoolAddress(dammConfig, baseMint, quoteMint)`; its quote vault
   holds `≈ 0.998 × 1% × X` (9.98 USDC for a 1,000 USDC raise), its base vault ≈ 0.36 units; position NFT owned by Merces,
   `permanent_locked_liquidity == pool.liquidity`.
5. **Proceeds, exactly:** issuer USDC ATA increased by `creator migration fee` = 990.000000 USDC; Merces USDC ATA increased
   by the partner trading fees (≈ 8.08 USDC, ± 2 lamports per swap) and 0 migration fee; DBC quote vault keeps Meteora's
   20% of trading fees + 0.2% migration fee (≈ 2.04 USDC) until Meteora claims it.
6. **Units:** buyers hold ≈ 100 units in total (minus ≤ 1 base lamport per swap), the locker escrow holds exactly the
   issuer allocation (10.000000), the DAMM v2 base vault ≈ 0.36 units, Merces' base ATA a few lamports of leftover,
   the DBC base vault Meteora's base fee; the sum equals the fixed supply `110.363638` (no burn).
7. **Resume:** run the same command again; it must send no transaction and print the same report.

Keep the state file and the report: they are the evidence for the M5 milestone summary.

## 6. Rehearsal without devnet: local validator with the real binaries

```bash
# needs solana-test-validator on PATH (or SOLANA_TEST_VALIDATOR=/path/to/it) and the SDK fixture binaries
export DBC_FIXTURES_DIR=/home/user/meteoraag/dynamic-bonding-curve-sdk/packages/dynamic-bonding-curve/tests/fixtures
pnpm --filter @merces/meteora test:local-validator
```

The test starts `solana-test-validator` with `dynamic_bonding_curve.so`, `cp_amm.so` and `locker.so` (the fixtures the
SDK's own test suite uses; `local`-feature builds whose admin check accepts any signer), creates a DAMM v2 config
equivalent to Meteora's 100 bps key, runs `runGraduation` exactly as the CLI does (mock USDC, 3 buyers, 10 vesting
units), and asserts the proceeds, pool depth, liquidity locks, unit conservation and idempotent resume. It ran in
≈ 20 s here. The same test is skipped automatically when the validator or fixtures are absent, so `pnpm test` stays
green on CI.

## 7. Known failure modes

| Symptom | Cause | Action |
| --- | --- | --- |
| `DAMM v2 config … does not exist on this cluster` | Meteora's key not on devnet | §4 "The DAMM v2 config key" |
| `InvalidTokenBadge` / `quote mint carries Token-2022 extensions` | quote mint not permissionless-supported | use SPL USDC or the mock mint |
| `QuoteMintHasNonZeroTransferFee` | Token-2022 quote with a transfer fee | not usable as quote |
| `PoolIsCompleted` on a buy | race: another buyer completed the curve | harmless; re-run |
| `block height exceeded` | congested RPC | the script retries 3× with fresh blockhashes; re-run resumes |
| `InsufficientLiquidityForMigration` | base vault short at completion — impossible with generator configs (fixed supply covers it) | report, do not hand-edit the config |
| Different `migration_sqrt_price` on chain than predicted | program version differs from 0.2.1 | stop; re-check `docs/research/METEORA_DBC.md` against the deployed program |
