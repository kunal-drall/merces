# Track D assumptions and defaults (Meteora DBC raise style, brief D10)

Every default, interpretation and unverifiable item of `solana/meteora/` and `docs/meteora/`. Items marked
**(Kunal)** need a decision; the default applies until one arrives. `PROG` = DBC program source 0.2.1,
`SDK` = `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 (see `docs/research/METEORA_DBC.md` §0 for paths).

## Defaults in force

| # | Topic | Default | Why |
| --- | --- | --- | --- |
| D1 | Max raise multiple `μ` **(Kunal, H3)** | `3e18` (3× attested trailing annual income); `X = min(target, μ × income)` | ASSUMPTIONS A3 |
| D2 | Proceeds route **(Kunal, H3)** | Migration fee, `fee_percentage = 99` (program max, PROG/constants.rs:58), `creator_fee_percentage = 100` | ASSUMPTIONS A3 as recorded. `docs/meteora/PROCEEDS_OPTIONS.md` §6 recommends `creator_fee_percentage = 0` with a Merces PDA as `fee_claimer` so proceeds enter the series treasury under the release schedule; same amounts, different custody, so it needs Kunal |
| D3 | Start price anchoring `ν` **(Kunal)** | `startValuationMultipleWad = 1e18`: the series is valued at 1 × trailing income at the first unit sold, over the issued units (public + issuer allocation). `P_start = ν × I / (N_pub + N_iss)` | Brief: "start price anchored to verified earnings". The pool-deposited units are excluded from "issued" because they are liquidity, not holder units; FDV over total supply is reported separately |
| D4 | Migration price | Derived, not chosen: `X / N_pub = √P_start · √P_mig / 2^128` (the average price buyers pay is the geometric mean of start and end), so `√P_mig = X · 2^128 / (N_pub · 10^6 · √P_start)` | Makes the raise complete exactly when the public allocation is sold; one constant-liquidity segment `L = ceil(X · 2^128 / Δ√P)` |
| D5 | Price ramp bound **(Kunal)** | `maxPriceRampWad = 25e18` (`P_mig / P_start ≤ 25`); generator rejects steeper curves | With `ν = 1`: `X = 3 × I` gives 9×, `X = 2.5 × I` gives 6.25× |
| D6 | Base decimals | 6 (`token_decimal` must be 6..=9, PROG process_create_config.rs:448-452); 1 HEU = 10^6 base lamports; Merces vault accounts per base lamport (`CURVE_MODE.md` §4 option 1) | Program bound; 0 is impossible |
| D7 | Base token type | Token-2022 (`MetadataPointer` + `TokenMetadata`, mint authority `None` at creation) | Consistent with the rest of Merces; no Metaplex dependency |
| D8 | Token authority | `TokenAuthorityOption::Immutable` (1): no update authority; mint authority is `None` for every non-transfer-hook option anyway | Brief: nobody can mint after creation. `PartnerUpdateAuthority` (2) is the alternative if Merces wants to edit metadata |
| D9 | Trading fee **(Kunal)** | Fixed 100 bps, `CollectFeeMode::QuoteToken`, no dynamic fee, no scheduler; `creator_trading_fee_percentage = 0` | Mirrors the 1% backer auction fee (C5): buyers pay 1%, Merces nets 0.8% (Meteora takes 20% of every fee). Program minimum 25 bps |
| D10 | Migrated pool fee tier | `MigrationFeeOption::FixedBps100` (2) → DAMM v2 config `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp` | A thin pool wants a higher LP fee; the fixed keys' collect mode is undocumented (memo §10.5) |
| D11 | Migrated liquidity ownership **(Kunal)** | 100% permanently locked, partner (Merces) position; creator 0% | Nobody can drain the secondary pool; LP fees to Merces. ≥ 10% must be locked on day one anyway (PROG/constants.rs:60) |
| D12 | Supply | Fixed supply, `pre == post == swap_base_amount_with_buffer + migration_base_threshold + locked vesting total` (the program minimum), so nothing is burned at migration and leftover is dust; `leftover_receiver` = Merces | Deterministic supply = public units + pool deposit + issuer allocation (+1 lamport of unsellable buffer) |
| D13 | Issuer allocation vesting **(Kunal)** | 0 units by default. When set: no cliff, 12 periods of 2,629,800 s (one Merces month), division remainder in the cliff unlock. Cliff-only schedules use the SDK's encoding at lamport granularity (1 period of 1 lamport, 1 s after the cliff) so the locker always sees `number_of_period ≥ 1` and `amount_per_period ≥ 1` | Locker source not in the clones; the SDK's `getLockedVestingParams` implies those constraints |
| D14 | Activation | `ActivationType::Timestamp` (1) | Standard; fee schedulers are not used |
| D15 | Pool creation fee | 0 lamports | Nothing to split |
| D16 | Quote mint | Mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`; devnet configurable (`--quote-mint`) or a mock SPL mint created by the script (`--create-quote-mint`); decimals must be 6 (generator rejects others); quote-mint eligibility checked against PROG/utils/token.rs:216-267 before sending | Brief D10; the devnet USDC mint address is not verifiable offline |
| D17 | DAMM v2 config key | `DAMM_V2_MIGRATION_FEE_ADDRESS[option]` from the SDK; overridable (`--damm-config`) because devnet existence is inferred, not documented | Memo §10.2 |
| D18 | `P0` for cap accounting | `floor(migration_quote_threshold × 10^token_decimal / swap_base_amount)` from the `PoolConfig`, fixed at activation (SPEC §9 default); rounding down favours the issuer | `CURVE_MODE.md` §3 |
| D19 | `units_outstanding` | `base_mint.supply − DAMM v2 base vault − DBC base vault − locker escrow ATA − leftover receiver ATA`, in base lamports; issuer-held (claimed vesting) units count as outstanding **(Kunal)** | `CURVE_MODE.md` §4 |
| D20 | Claim gating | `register_holder` requires allowlist; claims read the current ATA balance with a debt-pattern checkpoint | SPEC §9; `CURVE_MODE.md` §5 |
| D21 | Redemption | Tender: holder transfers units to the vault, vault pays `P_redeem × units` and burns them | SPEC §9; `CURVE_MODE.md` §7 |
| D22 | Buy loop (script) | `swap2` `PartialFill`, `minimum_amount_out = 0` (test wallets on devnet; the last buy is refunded above the threshold), largest single buy `X/3 + 1`, 3 buyers funded with `1.02 × X / 0.99 / 3` each | Test harness only; not a production trading path |
| D23 | Flash rent | Script tops the DBC pool authority up to 0.1 SOL from the payer before `create_locker`/`migration_damm_v2` | PROG/instructions/migration/flash_rent.rs:12; memo §10.4 |
| D24 | Confirmation | Polling `getSignatureStatuses` + block-height expiry, 3 attempts with fresh blockhashes; no websockets | Public devnet RPCs drop PubSub; local validator serves it on another port |
| D25 | Mainnet | CLIs refuse `mainnet` clusters and URLs | Brief ground rule |

## Interpretations

| # | Interpretation |
| --- | --- |
| I1 | "Raise target = migration threshold" (brief D10 mapping) with the correction the brief itself asks for: the issuer's proceeds are `fee_percentage%` of the threshold (memo §1). |
| I2 | "Partner share" in the brief = the partner's part of the migration fee plus partner trading fees, both received by `fee_claimer`. |
| I3 | `units_offered` for a curve series = the public allocation `N_pub`; the pool-deposited units and the issuer allocation are not "offered". |
| I4 | `min_raise` has no curve-mode meaning: the raise completes at exactly `X` or not at all. |
| I5 | The validator mirrors `ConfigParameters::validate` and the derived checks of `process_create_config` for the concentrated-liquidity handler only; `Compounding` migrated pools are rejected as unsupported (never emitted). Quote-mint checks (owner program, transfer fee, extensions/badge) are done against the live mint by the script, not by the pure validator. |
| I6 | `creator` = issuer wallet in the demonstration (brief mapping). `CURVE_MODE.md` §6 explains the custody trade-off and proposes the partner route for production. |
| I7 | Surplus is rounding dust with PartialFill buys (1 lamport in the local run); it is handled (withdrawn) but never relied on. |

## Verified offline, by what

| What | How |
| --- | --- |
| Program constants and enums | `test/constants.test.ts` against SDK 1.5.13 and cp-amm-sdk 1.5.1 |
| Curve, migration, fee and vesting math | `test/math.test.ts` against the SDK's BN port of the program (200 random cases per delta function) |
| `create_config` validation | `test/validate.test.ts`: every `PoolError` path, plus agreement with the SDK's `validateConfigParameters` on SDK-built and Merces-built configs |
| Generator | `test/config.test.ts`: known answers, monotone curve, LP sum, SDK swap simulator completes the curve with `quote_reserve ∈ [X, X+1]` for 1, 5, 40 and 2,000 buys, determinism and tamper detection |
| Proceeds table | `test/proceeds.test.ts` |
| Transaction building | `test/graduation.test.ts` against a stub connection serving program-encoded accounts |
| Whole flow | `test/local-validator.e2e.test.ts` against the real DBC / DAMM v2 / locker binaries |

## Unverified

| # | Item |
| --- | --- |
| U1 | Devnet execution itself (RPC blocked). Runbook written; local-validator rehearsal passes. |
| U2 | Existence of Meteora's DAMM v2 migration config keys on devnet (`--damm-config` override provided). |
| U3 | Devnet USDC mint address (not in the clones; use Circle's faucet page or the mock mint). |
| U4 | Whether the devnet DBC pool authority holds SOL for flash rent (script tops it up). |
| U5 | Jupiter locker's own parameter validation (source not in the clones); the SDK's encoding convention is followed. |
| U6 | That the deployed devnet program is 0.2.1 (the fixtures used locally are the SDK 1.5.13 test binaries). The script aborts if the on-chain config derivation differs from the generator's. |
