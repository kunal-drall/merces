# Meteora DBC raise: where the buyers' USDC goes, and how it can reach the issuer

**For:** Kunal. **From:** Track D (Meteora raise style, brief D10). **Date:** 7 October 2026.
**Status:** verified against the program source; numbers reproduced by `solana/meteora/test/proceeds.test.ts`
and exercised end to end against the real program binaries on a local validator
(`solana/meteora/test/local-validator.e2e.test.ts`). Devnet execution is pending network access
(see `DEVNET_RUNBOOK.md`).

Citations use `PROG/<file>:<lines>` for
`/home/user/meteoraag/dynamic-bonding-curve/programs/dynamic-bonding-curve/src` (program 0.2.1, the version
the pinned SDK 1.5.13 targets) and `SDK/<file>:<lines>` for `dynamic-bonding-curve-sdk/packages/dynamic-bonding-curve/src`.
The research memo `docs/research/METEORA_DBC.md` has the longer form of every citation.

---

## 1. The one-paragraph answer

In a DBC raise the buyers' USDC does **not** go to the issuer. Every buy is a swap into a virtual pool: the
USDC (less the trading fee) becomes the pool's `quote_reserve`, held in a vault owned by the DBC program's
pool authority, and nobody — not the issuer (creator), not Merces (partner), not Meteora — can withdraw
from that reserve while the curve is running (PROG/state/virtual_pool.rs:940-1000; the only quote-side
exits are the instructions in §3). When the reserve reaches the migration threshold `X`, the program
turns `ceil(X · (100 − f)/100)` of it into DAMM v2 liquidity owned by partner/creator position NFTs
(mostly locked) and leaves `X − ceil(X · (100 − f)/100)` in the vault as the **migration fee**, which is the
only mechanism that moves raised USDC to the creator and/or the partner (PROG/state/config.rs:846-874;
PROG/instructions/migration/ix_withdraw_migration_fee.rs:89-128). `f` is the config's
`migration_fee.fee_percentage`, capped at 99 (PROG/constants.rs:58). So **the issuer's proceeds are at most
99% of the raise, and only if the config says so**; with Meteora's typical launch config (`f = 0`) the issuer
receives nothing from the raise itself, only trading fees.

The migration threshold therefore equals the issuer's proceeds only in the sense that proceeds = `f%` of it.
Do not plan on "the raise target reaches the treasury" without setting `f`.

## 2. During the bonding phase

| What | Where it is | Who can take it, when | Source |
| --- | --- | --- | --- |
| Buyers' USDC net of fee | `quote_vault` (token account owned by the pool authority PDA `FhVo3m…`), tracked as `PoolState.quote_reserve` | Nobody until the curve completes. Sells return quote to sellers from the same reserve. | PROG/state/virtual_pool.rs:979-994; PROG/const_pda.rs:4-14 |
| Trading fee on each swap (`cliff_fee_numerator / 1e9`, min 0.25%, max 99%) | Same vault, in the buckets `partner_quote_fee`, `creator_quote_fee`, `protocol_quote_fee` (excluded from `quote_reserve`) | Protocol takes 20% of every fee (PROG/constants.rs:94). The remaining 80% splits `creator_trading_fee_percentage`% to the creator and the rest to the partner. Claimable at any time by `claim_trading_fee` (partner, signer `fee_claimer`) and `claim_creator_trading_fee` (creator). | PROG/state/config.rs:139-187, 1014-1033; PROG/instructions/partner/ix_claim_partner_trading_fee.rs; PROG/instructions/creator/ix_claim_creator_trading_fee.rs |
| Base tokens not yet sold | `base_vault` (same authority) | Nobody. The initial mint is fixed at pool creation (`pre_migration_token_supply`) and the mint authority is revoked at creation. | PROG/instructions/initialize_pool/process_initialize_virtual_pool_with_token2022.rs:69-83,145-167 |

Completion: `quote_reserve >= migration_quote_threshold` (PROG/state/virtual_pool.rs:1122-1124). Further swaps
fail (`PoolIsCompleted`, PROG/instructions/swap/process_swap.rs:224-227). A `PartialFill` buy stops exactly at
the migration price and refunds the rest, so the surplus above `X` is rounding dust (our local run: 1 lamport).

## 3. Every route by which quote can leave the pool

Notation: `X` = `migration_quote_threshold`; `f` = `migration_fee.fee_percentage` (0..=99);
`c_m` = `migration_fee.creator_fee_percentage` (0..=100, must be 0 when `f = 0`);
`c_t` = `creator_trading_fee_percentage` (0..=100); `R` = `quote_reserve` at completion; `S = R − X` (surplus);
`V` = gross USDC buyers paid in; `φ` = trading fee numerator / 1e9.

| # | Route | Formula (quote lamports) | Recipient | Timing / signer | Source |
| --- | --- | --- | --- | --- | --- |
| R1 | **Migration fee, creator share** | `MigFee = X − ceil(X·(100−f)/100)`; `creator = floor(MigFee · c_m / 100)` | `pool.creator` (the issuer), to **any quote token account passed as `token_quote_account`** (no owner check on that account) | once `quote_reserve >= X`, before or after migration; `withdraw_migration_fee(flag = 1)`, signer = creator; once | PROG/state/config.rs:846-874; ix_withdraw_migration_fee.rs:30-32, 89-128 |
| R2 | **Migration fee, partner share** | `partner = MigFee − creator` | `config.fee_claimer` (Merces), same freedom of destination account | `withdraw_migration_fee(flag = 0)`, signer = fee_claimer; once | same |
| R3 | **Surplus** | `S = R − X`; `pc = floor(S·80/100)`; `creator = floor(pc·c_t/100)`; `partner = pc − creator`; `protocol = S − pc` | creator / partner / Meteora | after completion; `creator_withdraw_surplus`, `partner_withdraw_surplus`, `claim_protocol_fee2`; once each | PROG/state/virtual_pool.rs:1130-1166; PROG/constants.rs:47 |
| R4 | **Trading-fee claims** (curve phase) | per swap: `fee = ceil(amount·φ)`; `protocol = floor(fee·20/100)`; LP = `fee − protocol`; `creator = floor(LP·c_t/100)`; `partner = LP − creator`. Aggregate for a curve that nets `X`: `V = ceil(X/(1−φ))`, total fee `V − X` | creator / partner / Meteora | any time; `claim_creator_trading_fee`, `claim_trading_fee`, `claim_protocol_fee2` | PROG/state/config.rs:139-220 |
| R5 | **DAMM v2 position liquidity** (unlocked share) | pool quote `Q_net = ceil(X·(100−f)/100) − floor(ceil(X·(100−f)/100)·20/10000)`; the position owner can `remove_liquidity` for their *unlocked* share: `quote ≈ share · Q_net`, **plus** `share · B_net` base units | partner / creator per `partner_liquidity_percentage` / `creator_liquidity_percentage` (unlocked), `*_permanent_locked_*` (never), `*_liquidity_vesting_info` (after vesting ≤ 2 y). At least 10% must still be locked one day after migration | after `migration_damm_v2`; DAMM v2 `remove_liquidity`, signer = position NFT owner | PROG/state/config.rs:951-1012, 1046-1065; PROG/constants.rs:60,64; migrate_damm_v2_initialize_pool.rs:594-732 |
| R6 | **DAMM v2 LP trading fees** (secondary market) | pool LP fee (25/30/100/200/400/600 bps or custom) on every secondary trade, 20% to Meteora, rest accrues to positions pro rata, **including locked positions** | partner / creator as position NFT owners | after migration, `claim_position_fee` | DOCS core-products/damm-v2/nft-positions.mdx:31-67; DOCS developer-guides/damm-v2/pool-fee-configs.mdx:43-44 |
| R7 | Meteora's protocol liquidity migration fee | `floor(Q_gross · 20 / 10_000)` (0.2%) quote + the base equivalent | Meteora only | after migration, `claim_protocol_fee2` | PROG/constants.rs:107; PROG/migration_handler/concentrated_liquidity.rs:147-172 |
| — | Pool creation fee | `pool_creation_fee` lamports of **SOL** (0 in our config), 90% partner / 10% protocol | partner / Meteora | after pool init | PROG/state/config.rs:1035-1044 |

There is **no** quote-side "leftover": `withdraw_leftover` returns only unused **base** tokens to
`leftover_receiver` (PROG/instructions/migration/withdraw_leftover.rs:48-120). Any quote dust the second
position could not absorb stays in the DBC vault with no instruction to withdraw it (research memo §10.6).

Base side at migration (matters for pool depth and for Merces' unit accounting): the pool deposits
`B_gross = migration_base_threshold` units priced at the migration price alongside `Q_gross`, less the 0.2%
protocol cut, so the graduated pool starts with equal value on both sides
(PROG/migration_handler/concentrated_liquidity.rs:190-237, 259-303).

### A note on R1/R2 and the Merces treasury

`withdraw_migration_fee` transfers to whatever quote token account the signer passes. That lets the
withdrawal be sent **straight into the series treasury** (D4) instead of a wallet — but only the signer
chooses. If the signer is the issuer's own wallet (creator), the issuer can bypass the treasury's release
schedule; if the signer is a Merces program PDA (as `fee_claimer`/partner, or as `creator` with the issuer
signing the Merces instruction), the protocol can enforce that the fee lands in the treasury. This is the
single most consequential routing choice; see §6.

## 4. Worked numbers: target raise X = 100,000 USDC

Series used for the pool-depth columns: attested trailing income 40,000 USDC, 10,000 units on the curve,
start price 4 USDC (start FDV = 1 × income), average price 10 USDC (= `P0`), migration price 25 USDC; 1%
trading fee in quote (`CollectFeeMode::QuoteToken`), `c_t = 0`, DAMM v2 fee tier 100 bps,
100% of migrated liquidity permanently locked in the partner position. All amounts in USDC (6 decimals);
every cell is produced by `computeProceeds` in `solana/meteora/src/proceeds.ts` and asserted in
`test/proceeds.test.ts`.

**What reaches whom** (migration fee and surplus routes; surplus is 0 with PartialFill buys):

| Config | `Q_gross` to pool before Meteora's 0.2% | Migration fee `X − Q_gross` | → issuer (R1) | → Merces (R2) | → Meteora 0.2% (R7) | `Q_net` sits in the DAMM v2 pool |
| --- | --- | --- | --- | --- | --- | --- |
| `f = 0` (Meteora's usual launch) | 100,000.00 | 0.00 | **0.00** | 0.00 | 200.00 | 99,800.00 |
| `f = 20, c_m = 100` | 80,000.00 | 20,000.00 | **20,000.00** | 0.00 | 160.00 | 79,840.00 |
| `f = 50, c_m = 100` | 50,000.00 | 50,000.00 | **50,000.00** | 0.00 | 100.00 | 49,900.00 |
| `f = 99, c_m = 100` (A3 default) | 1,000.00 | 99,000.00 | **99,000.00** | 0.00 | 2.00 | 998.00 |
| `f = 99, c_m = 0` (partner takes the fee) | 1,000.00 | 99,000.00 | 0.00 | **99,000.00** | 2.00 | 998.00 |
| `f = 99, c_m = 50` | 1,000.00 | 99,000.00 | 49,500.00 | 49,500.00 | 2.00 | 998.00 |

**Trading fees during the curve, identical for every row** (R4; buyers pay gross so that exactly X nets into
the reserve; per-swap rounding adds at most 1 lamport per swap):

| Buyers pay in total | Trading fee total | → Meteora (20%) | → Merces partner (80%, `c_t = 0`) | → issuer |
| --- | --- | --- | --- | --- |
| 101,010.101011 | 1,010.101011 | 202.020202 | **808.080809** | 0 |

**Pool depth and post-graduation price impact** (R5/R6 context; concentrated full-range liquidity at the
migration price, computed with the program's own liquidity formulas):

| Config | USDC in pool | Units in pool | USDC to move price +10% | USDC to move price +100% | Price impact of a 1,000 USDC buy | … of a 10,000 USDC buy | USDC received for selling 10 units (worth 250 at migration) | … for selling 100 units (1% of the public allocation, worth 2,500) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `f = 0` | 99,799.999999 | 3,991.999995 | 4,871.12 | 41,338.51 | +2.01% | +21.04% | 249.38 | 2,438.91 |
| `f = 20` | 79,839.999999 | 3,193.599996 | 3,896.90 | 33,070.81 | +2.52% | +26.61% | 249.22 | 2,424.10 |
| `f = 50` | 49,899.999999 | 1,995.999997 | 2,435.56 | 20,669.26 | +4.04% | +44.09% | 248.75 | 2,380.73 |
| `f = 99` (any `c_m`) | 997.999999 | 39.919999 | 48.71 | 413.39 | **+300.80%** | +12,044% | 199.92 | 713.26 |

Reading the table: with `f = 99` the issuer receives 99% of the raise, but the "secondary market" the brief
promises is a 998 USDC pool in which a single 1,000 USDC order triples the price and a holder selling 1% of the
public allocation gets 29 cents on the dollar. With `f = 50` the issuer gets half the raise and a 50,000 USDC
pool absorbs a 10,000 USDC order at −44%. There is no configuration in which the issuer gets most of the raise
*and* the pool is deep: pool depth is exactly what the issuer does not take.

Supply per configuration (10,000 public units + units minted for the pool deposit, no issuer allocation):
`f = 0` → 13,999.999997 units (≈ 4,000 in the pool); `f = 20` → 13,199.999998; `f = 50` → 11,999.999999; `f = 99` → 10,040.000001
(40 in the pool). The pool-deposited units are not holder units (see `CURVE_MODE.md` for how Merces counts them).

## 5. The liquidity-withdrawal route (R5) in numbers

If instead of a migration fee the config gives the **creator** an unlocked liquidity share, the issuer can
drain that share from the DAMM v2 pool the moment it exists. Example `f = 0`, `creator_liquidity_percentage = 90`,
`partner_permanent_locked_liquidity_percentage = 10` (the legal minimum lock): the issuer can remove
≈ 89,820 USDC **and ≈ 3,593 units** (90% of both sides of the 99,800 / 3,992 pool), leaving a 9,980 USDC pool
behind. The issuer ends up holding 36% of the public allocation in units, which they could sell into the
remaining pool or hold as "their own" units — both bad for holders. This route also pays the issuer in a mix
of USDC and units rather than USDC, and it is a post-migration action nothing in DBC forces. It is strictly
worse than the migration fee for Merces' purposes and is listed only for completeness. Vesting the creator's
liquidity (`creator_liquidity_vesting_info`, up to 2 years) turns it into a slow version of the same thing.

## 6. Recommendation

1. **Keep the migration fee as the proceeds route (A3), at the maximum `f = 99`.** It is the only route that
   (a) pays USDC, not units, (b) is bounded and deterministic at config creation, (c) is available the moment the
   curve completes, before migration, and (d) does not depend on anyone trading afterwards.
2. **Decide who signs the withdrawal.** Two Charter-compatible variants, same money, different custody:
   - **A3 as recorded** (`c_m = 100`, creator = issuer wallet): the issuer withdraws 99% of X to a token account of
     their choice. Simple, but the series treasury's release schedule (D4) is bypassed unless the issuer
     voluntarily passes the treasury account. Not enforceable on-chain.
   - **Partner route** (`c_m = 0`, `fee_claimer` = a `merces_protocol` PDA): the protocol's curve instruction
     withdraws the 99% by CPI with the PDA signer and passes the series treasury's token account as
     `token_quote_account`, so proceeds enter D4 and follow the release schedule exactly as in sealed-bid mode.
     The issuer stays `creator` (so the vesting escrow of their allocation is theirs). This is the variant that
     keeps Charter invariant 1 ("capital releases follow the fixed schedule") intact. **Recommended**; it changes
     A3's `creator_fee_percentage` from 100 to 0 and needs Kunal's sign-off because it changes custody, not amounts.
   The generator is one field away from either (`migrationFee: { feePercentage: 99, creatorFeePercentage: 100 | 0 }`);
   the graduation script already withdraws both shares.
3. **Merces' own revenue** comes from the 1% quote trading fee during the curve (0.8% net of Meteora's cut,
   808 USDC per 100,000 raised in the example), the economic mirror of the sealed-bid 1% auction fee (C5), plus
   secondary-market LP fees on the permanently locked partner position (R6). The partner migration-fee share is 0
   in both variants above unless Kunal wants a protocol take from the raise itself.
4. **Lock all migrated liquidity permanently in the partner position** (default). Nobody can rug the pool, holders
   always have *some* exit, and the LP fees accrue to Merces. If the issuer should earn those fees instead, set
   `creator_permanent_locked_liquidity_percentage = 100`.
5. Accept that with `f = 99` the graduated pool is a token of a market, not a market. If Kunal wants holders to have
   a real exit, the answer is a lower `f` (issuer gets less), not a different route.

## 7. Questions Kunal must answer

| # | Question | Default in force until answered |
| --- | --- | --- |
| Q1 | Maximum raise as a multiple of attested trailing annual income (`μ`). Brief H3. | 3× (`maxRaiseMultipleWad = 3e18`) |
| Q2 | Acceptable pool depth after graduation, i.e. the migration fee `f`. Table §4: issuer share vs. depth are complementary. | `f = 99` |
| Q3 | Who receives the migration fee: issuer wallet directly (A3, `c_m = 100`) or Merces protocol PDA into the series treasury under the release schedule (`c_m = 0`, §6.2)? | A3 as recorded (`c_m = 100`) in the generator; memo recommends switching |
| Q4 | Start valuation multiple `ν` (series valued at `ν × income` at the first unit) and the maximum price ramp `P_mig / P_start`. With `ν = 1` and `X = 3 × income` the price rises 9× along the curve; with `X = 2.5 × income`, 6.25×. | `ν = 1`, ramp ≤ 25× |
| Q5 | Curve trading fee (buyers' cost) and whether the issuer shares in it (`c_t`). 1% mirrors the auction fee; 0.25% is the program minimum. | 100 bps, `c_t = 0` |
| Q6 | Issuer allocation: how many units the issuer keeps and the vesting schedule. | 0 units; if set, 12 monthly periods from graduation, no cliff |
| Q7 | Graduated pool fee tier and who owns the locked LP position (earns secondary fees). | 100 bps tier; 100% permanently locked, partner-owned |
| Q8 | Whether a Merces protocol take from the raise (partner migration-fee share) is wanted at all. | none |

## 8. What could not be verified offline

- Devnet execution (RPC blocked from the build container). The flow was executed instead on a local
  `solana-test-validator` running the SDK's fixture binaries of the DBC, DAMM v2 and locker programs
  (`local`-feature builds whose admin check accepts any signer; otherwise the same code).
- That Meteora's DAMM v2 migration config keys (`DAMM_V2_MIGRATION_FEE_ADDRESS`) exist on devnet. The SDK ships
  one list without a cluster qualifier; the manual migrator supports devnet, which implies they do. The script
  takes `--damm-config` so a devnet-specific key can be supplied, and the runbook explains how to check.
- Whether the devnet DBC pool authority is funded for flash rent; the script tops it up from the payer.
