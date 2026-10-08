# Merces Stage 1 — Architecture

Companion to `SPEC.md` (normative). This document explains the shape of the system, the state machines, the
reasoning behind the settlement algorithms, and the differences between sealed-bid and curve-mode series. Chain
specific account and storage layouts are in `docs/solana/INTERFACES.md` and `docs/evm/INTERFACES.md`; the
consolidated instruction/function list is in `INTERFACES.md`.

## 1. One protocol, two stacks

```
                 ┌────────────────────────── off-chain (Stage 2, later) ──────────────────────────┐
                 │  issuer device: income → zk proof     verifier service: Reclaim → signs commit  │
                 │  attestors (CPAs): sign amendments, pauses, FX fallbacks, extinguishment          │
                 │  keepers: pages, cranks, FX snapshots       indexer: reads the events in §10     │
                 └───────────────┬───────────────────────────────────────────────┬─────────────────┘
                                 ▼                                               ▼
   ┌──────────────── Solana ────────────────┐              ┌──────────────── EVM (Monad) ─────────────────┐
   │ merces_registry   (immutable)          │              │ MercesRegistry          (non-upgradeable)    │
   │   issuers, series terms, allowlist,    │              │   same fields; allowlist = T-REX identity    │
   │   attestor / verifier keys, config     │              │   registry membership                        │
   │ merces_hook       (Token-2022 hook)    │              │ T-REX token per series + ModularCompliance   │
   │   rejects every non-window transfer    │              │   + MercesComplianceModule (same rule)       │
   │ merces_protocol   (multisig+timelock)  │              │ MercesAuction  MercesTreasury  MercesIncome  │
   │   auction · treasury · income · vault  │              │ MercesVault    MercesWindow   Groth16Verifier│
   │   redemption/tail/pause/extinguish ·   │              │   UUPS proxies owned by TimelockController   │
   │   window · router · FX accumulator     │              │ FeeCollector (pull-only)                     │
   └────────────────────────────────────────┘              └──────────────────────────────────────────────┘
                 ▲                                                               ▲
                 └──────── identical math, events and vectors (packages/reference, packages/vectors) ───────┘
```

The reference implementation (`packages/reference`) is the executable form of `SPEC.md`. It generates the parity
vectors; each stack has a vector runner that replays them and asserts every balance to the base unit.

### Trust boundaries

| Component | Mutability | Who can change what |
| --- | --- | --- |
| Registry (D1, registries) | Code immutable (Solana: upgrade authority revoked; EVM: no proxy) | Admin edits only registries, flags and *defaults for future series*; issuers edit only their own drafts and amend terms with an attestor |
| Unit token / hook / compliance | Hook program immutable; T-REX behind its own implementation authority owned by the timelock | Nobody can freeze or seize units; the only transfer path is the window module |
| Money code (auction, treasury, income, vault, window) | Upgradeable after a timelock delay by the protocol multisig | No function moves treasury, vault or escrow funds except the payment, release, refund, claim and redemption paths |
| Fee collector | Receives only | Protocol multisig withdraws fees |

The registry is split from the money code precisely so that the charter (terms, cap, lockup, fees, contract hash,
terms commitment) has **no upgrade path**, while the money code can still be fixed under a delay.

## 2. Series lifecycle

### 2.1 Raise state

```
 Draft ──open_raise──▶ Open ──(commit_end)──▶ Reveal ──(reveal_end)──▶ Settling ──finalize──▶ Settled
   │                     │                                                  │
   └──cancel (0 bids)──▶ Cancelled                                           └──min raise missed──▶ Failed
```

`Draft` is the only state in which terms can be edited (and only by the issuer, within bounds). `open_raise`
requires the contract hash, an allowlisted issuer wallet, and `new_raises_paused == false`. From `Open` onwards the
charter block is frozen (`SPEC.md` §3.3). `Settled` is the only entry into the repayment lifecycle.

### 2.2 Repayment status (C8)

```
             ┌──────────────── derived from the effective clock every call ────────────────┐
             │                                                                            │
   OnTime ──(e > deadline)──▶ InGrace ──(e > grace_end)──▶ Late ──pay──▶ OnTime            │
      ▲                                                     │                             │
      └─────────────── pay / zero due ──────────────────────┘                             │
                                                                                          │
   any of the above ──pause approved──▶ Paused ──(pause_end or end_pause)──▶ back to derived
                                                                                          │
   cap reached ──▶ Retired        issuer redeems ──▶ Redeemed (tail for 12 months)         │
   two attestors ──▶ Extinguished                                                         │
```

`e = effective_now = now − total paused time`. Deadlines are fixed in real time (`period_end + 30 d`), so a pause
"stops the clock" by making `e` lag `now`. Accrual uses `late_days = floor((e − grace_end) / DAY)`, so it also
stops during a pause and resumes where it left off. `FormalNoticeDue` fires once per period when
`e ≥ deadline + 90 d`. Only `Late` blocks treasury releases (plus the issuer's own release pause); `InGrace` and
`Paused` do not. `Retired`, `Redeemed` and `Extinguished` are terminal and stored.

## 3. Money flows

```
 bidders ──escrow──▶ auction escrow ──finalize/claim_win──▶ treasury (p* × units) ──schedule──▶ issuer
                                   └──1 % fee──▶ fee collector      └── Extinguished: unreleased ──▶ vault (no fee)
                                   └──refunds──▶ bidders

 issuer ──pay (due + accrual)──▶ vault ──5 % fee──▶ fee collector
 tier-1 income ──router──▶ issuer (≤ θ) / vault (r × units × excess)
                                 vault ──claim──▶ holders (pro rata, net accumulator)
                                 vault ──cap truncation refund──▶ issuer
 issuer ──redeem (P_redeem × units, no fee)──▶ vault ──claim_redemption──▶ holders (units burn)
 issuer ──tail report──▶ vault ──claim_tail──▶ holders at redemption
 window buyers ──escrow──▶ window ──fill──▶ sellers (p* × fill) ; units escrow ──▶ buyers ; fee ──▶ collector
```

Every arrow is a pull by its rightful recipient or a push by a keeper **to the recipient's own address**. There is
no admin arrow.

## 4. Cap accounting and the reward-per-share pattern

The series keeps `paid_per_unit_wad` (gross, counts toward the cap) and `net_acc_wad` (net of the 5 % fee, what
holders can claim). A gross payment `G` with `N` units outstanding adds `floor(G × WAD / N)` to both (fee removed
from the second). Truncation at the cap happens before the fee, so the issuer's refund is exact and fees never
extend the obligation. Rounding dust (`net − floor(delta_acc × N / WAD)`) is carried into the next distribution,
so nothing is lost and total claims never exceed the vault's balance.

Holders claim `floor((net_acc_wad − last_acc) × balance / WAD)`. Because units only move inside the window module
(which settles both sides first) or are burned by the vault itself, the per-holder snapshot is always consistent.
In curve mode, where units trade freely, a holder must claim before selling; a late claim can only under-pay the
seller, never over-pay anyone.

## 5. Why the one-pass settlement checks are sound

### 5.1 Auction (uniform price)

Let valid bids have prices `p_i` and quantities `q_i`, `N = units_offered`, and define demand
`D(p) = Σ_{p_i ≥ p} q_i` (non-increasing in `p`). The keeper proposes `p*` together with the claimed tallies
`q_above_claim`, `q_at_claim`; the program fixes `R = min(N − q_above_claim, q_at_claim)` before the tally. The tally
then computes `q_above = Σ_{p_i > p*} q_i`, `q_at = Σ_{p_i = p*} q_i`, `min_valid_price`, `valid_count` and
`alloc_sum = Σ_{p_i = p*} floor(R × q_i / q_at_claim)`. Finalize accepts `p*` iff the claims equal the tally and
either `q_at > 0 ∧ q_above < N ∧ q_above + q_at ≥ N` (oversubscribed) or `q_above + q_at < N ∧ min_valid_price = p*`
(undersubscribed); with no valid bids at all the auction fails outright.

- Oversubscribed case. `q_above = D(p*+) < N ≤ D(p*)`: every bid strictly above `p*` is filled in full, the bids at
  `p*` share `R = N − q_above` units, and no bid below `p*` wins. `p*` is therefore the lowest winning price and is
  unique (if `p' > p*` also qualified, `D(p') ≥ N` but `D(p') ≤ D(p*+) < N`; if `p' < p*` qualified,
  `D(p'+) ≥ D(p*) ≥ N` contradicts `q_above(p') < N`).
- Undersubscribed case. Total valid demand `< N` and `p*` is the lowest valid price: everyone is filled in full and
  pays the lowest bid, as the brief requires.
- Because the marginal allocations are summed during the tally against the fixed `R`, `units_sold = q_above +
  alloc_sum` and `proceeds = p* × units_sold` are exact before any bid is processed, so the min-raise rule is applied
  to the real proceeds and the registry is written once.

Bid processing moves money only into protocol-owned accounts (treasury, fee collector, auction escrow) and records
what each bidder is owed; delivery to the bidder is a separate, retryable step. Finalization of the mint and the
start of treasury releases therefore never depend on any bidder being able to receive tokens.

### 5.2 Transfer window (call auction)

Bids give demand `D(p)` (non-increasing); asks give supply `S(p) = Σ_{ask price ≤ p} q` (non-decreasing). Matched
volume at a price `p` is `M(p) = min(D(p), S(p))`. The keeper proposes `p*`; the tally yields `d_above`, `d_at`,
`s_below`, `s_at` with `D = d_above + d_at = D(p*)` and `S = s_below + s_at = S(p*)`. The program accepts `p*` (a
revealed price) iff exactly one branch holds:

- **(A) supply-limited:** `S > 0 ∧ d_above < S ≤ D`. Then `M(p*) = S`. For `p > p*`: `D(p) ≤ d_above < S ≤ S(p)`, so
  `M(p) ≤ d_above < M(p*)`. For `p < p*`: `S(p) ≤ S` and `D(p) ≥ D ≥ S`, so `M(p) = S(p) ≤ M(p*)`. Every ask at or
  below `p*` sells in full; bids above `p*` fill in full; bids at `p*` share `S − d_above`.
- **(B) demand-limited:** `D > 0 ∧ s_below ≤ D < S`. Then `M(p*) = D`. For `p < p*`: `S(p) ≤ s_below ≤ D ≤ D(p)`, so
  `M(p) = S(p) ≤ M(p*)`. For `p > p*`: `D(p) ≤ D` so `M(p) ≤ M(p*)`. Every bid at or above `p*` fills in full; asks
  below `p*` sell in full; asks at `p*` share `D − s_below`.

Hence an accepted `p*` maximises matched volume. Existence: when `max_bid ≥ min_ask` a revealed price satisfies one
branch (the lowest revealed price with `D(p) < S(p)` satisfies B, else the highest revealed price satisfies A);
uniqueness follows from the monotonicity of `D − S` — the reference implementation carries a property test that
brute-forces random books to confirm both. If `max_bid < min_ask` the keeper proposes `NO_MATCH` and the program
verifies the inequality from the tally.

Marginal orders are filled first-come in ascending reveal order until the marginal remainder is exhausted, so the
units bought equal the units sold exactly: no rounding dust, and buyers' payments always cover sellers' proceeds.
Both tallies are paged (Solana: order PDAs as remaining accounts, ≤ 24 per instruction; EVM: index ranges of ≤ 200);
a proposal can be replaced only after its round is complete and rejected, so no caller can reset a tally that
honest keepers are completing.

## 6. Redemption price

`P_redeem = min(C_remaining, max(P_hurdle, k × D_avg))`. `C_remaining` uses `ceil(paid_per_unit)` so the issuer is
never asked to pay back cap it has already met through rounding. `P_hurdle` compounds the hurdle rate per full year
since settlement and applies simple interest for the fractional year, multiplying in a fixed order so both stacks
produce the same integer. `D_avg` averages the per-unit gross paid in the last `min(3, full years)` settlement-years
and is omitted during the first year. Redemption deposits `P_redeem × units_outstanding` with **no fee**; the
remaining cap after redemption, `C_remaining − P_redeem`, bounds the tail clause.

## 7. ProofOfIncome

```
 issuer device                                  chain
 ─────────────                                  ─────
 income_ytd, θ, r, salts ─▶ circuit ─▶ proof ─▶ submit_report(period, payment_usd, fx_avg, commitments, proof, attestation)
 Reclaim session ─▶ Stage 2 verifier ─▶ secp256k1 signature over (series, period, income_commitment, tier)
```

The chain checks: sequencing (period = next expected; previous due paid), FX (accumulator average or an
attestor-signed fallback when coverage or the Chainlink cross-check fails), the Groth16 proof with public inputs
`[terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd]`, and the
attestation. The prior commitment chains quarters within a year (`ZERO_INCOME_COMMITMENT` at the start of a year),
which is what makes the year-to-date method enforceable without revealing income. Nothing about income, θ or r is
ever written on-chain; the series stores only `terms_commitment`.

## 8. Sealed-bid series vs curve-mode series

| Aspect | Sealed-bid (default) | Curve mode (Solana only, Meteora DBC) |
| --- | --- | --- |
| Primary raise | Commit–reveal uniform-price auction, one clearing price | Public bonding curve, price moves with every buy |
| Unit mint | Created by `merces_protocol` with TransferHook + PermanentDelegate, 0 decimals | Created by the DBC program; hook revoked when the curve completes |
| Holding rules | Allowlist, 18-month lockup, 10 % wallet cap, window-only transfers | None after graduation: anyone can hold and trade on DAMM v2 |
| Who enforces | Hook (Solana) / compliance module (EVM) | Nothing on transfers; **claims are gated** (`register_holder` needs the allowlist) |
| Proceeds | Exactly `p* × units_sold` to the treasury at settlement | Only the DBC migration fee reaches creator/partner (see `docs/meteora/PROCEEDS_OPTIONS.md`); the rest is pool liquidity |
| Issue price `P0` | Clearing price | Fixed at activation from pool state (`docs/meteora/CURVE_MODE.md`) |
| Cap, payouts, fees | Vault accumulators, 5 % fee, burn at retirement | Same vault and fee; at the cap claims end (no forced burn) |
| Redemption | Issuer deposits, holders claim, units burn | Tender: holders deposit units to receive `P_redeem` |
| Public price | None | Live public price; the issuer records this acceptance in the series |
| Stablecoin | USDC or USDG (Solana), USDC (Monad) | USDC quote only (USDG needs a Meteora token badge) |

## 9. Parity strategy

- One reference implementation in TypeScript (`bigint`), one vector format, one set of vectors.
- Each stack replays every vector with a time-warping harness (LiteSVM clock sysvar / `vm.warp`) and asserts every
  stablecoin and unit balance plus the ledger fields in each `expect` step.
- Bid and ask commitments depend on the wallet bytes and so are recomputed per chain by the harness; amounts never
  differ. Attestation signatures are produced per chain from fixed test keys embedded in the vectors.
- Results per vector and per network are recorded in `PARITY_REPORT.md`.
