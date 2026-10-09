# Assumptions, defaults and unverified items

Every default chosen during the build and everything that could not be verified. Items marked **(Kunal)** need a
decision; the default applies until one arrives. Track-specific notes compiled from `docs/assumptions/*.md`.

## Decisions taken (with the default in force)

| # | Topic | Default in force | Why / brief reference |
| --- | --- | --- | --- |
| A1 | Non-reveal charge **(Kunal, H1)** | 1% of escrow, parameter `non_reveal_charge_bps = 100`; **no** charge when the auction fails (brief: failed auctions charge no fee) | D3 |
| A2 | Pyth/Chainlink deviation band **(Kunal, H2)** | `fx_deviation_band_bps = 200` (2%). Reasoning: Pyth FX confidence is normally ≈0.1% of price; a 2% gap between two independent oracles on a liquid FX pair signals a stale or broken feed rather than noise, while anything tighter would trip on normal publish-time skew between the two networks | C9 |
| A3 | Meteora maximum-raise multiple and proceeds route **(Kunal, H3)** | Max raise = 3× attested trailing annual income (parameter `μ`). Proceeds route: the DBC **migration fee** at `fee_percentage = 99` — the only mechanism that moves raised quote tokens out of the pool to the creator/partner (`docs/research/METEORA_DBC.md` §4, `docs/meteora/PROCEEDS_OPTIONS.md`). Generator default keeps `creator_fee_percentage = 100` (issuer wallet withdraws). **Recommended change for Kunal**: `creator_fee_percentage = 0` with a `merces_protocol` PDA as the partner `fee_claimer`, so proceeds land in the series treasury under the D4 release schedule — same amounts, different custody (`withdraw_migration_fee` has no destination owner check). Merces revenue = the 1% curve trading fee (mirror of the auction fee). Trade-off table (pool depth vs proceeds) in the memo | D10 |
| A4 | Extinguishment **(Kunal, H4)** | Unreleased treasury funds go to holders pro rata through the vault with **no fee**; all open dues are cleared; nothing else is owed | C11 §6 |
| A5 | T-REX licence **(Kunal, H5)** | T-REX 4.1.6 and ONCHAINID 2.2.1 are GPL-3.0. The EVM package is therefore distributed under GPL-3.0 (see `LICENSE.md`). Tokeny's shipped compliance modules carry a CC-BY-NC-4.0 non-commercial rider, so Merces writes its own module against the GPL interfaces only. The upstream repository is marked deprecated in favour of the ERC-3643 association's repo; the npm package is still the published artefact | D2 |
| A6 | Partial redemption **(Kunal, H6)** | Not built (stretch) | C7 |
| A7 | Durations **(Kunal, H7)** | commit 7 d, reveal 2 d, window commit 3 d, window reveal 1 d, all per-series parameters with the bounds in `SPEC.md` §1.6 | D3, D9 |
| A8 | Hackathon fast path **(Kunal, H8)** | Not in effect; normal order followed | E |
| A9 | Year and month lengths | `YEAR = 365 d`; 18 months = 547.875 d = 47,336,400 s | C7, C8 |
| A10 | Wallet cap at the auction | Validated at reveal against `units_offered` (the only base known before settlement); after settlement the cap is enforced against outstanding supply on every window fill | C10 |
| A11 | One bid per wallet per auction and per window | Simplifies cap enforcement and sybil-resistance; a wallet may still bid in every series | D3, D9 |
| A12 | Min-raise test | Exact: the settlement proposer also claims `q_above`/`q_at`, the tally accumulates the marginal allocations, and `finalize_settlement` compares exact proceeds with `min_raise` (SPEC v1.1 §5.2; the v1.0 upper-bound rule is withdrawn) | D3 |
| A13 | Payment timing | A report must be accepted before `pay`; `pay` pulls the full due plus accrual in one call (no partial payments); accrual counts toward the cap because it is paid into the vault | C6, C8 |
| A14 | Late days | Counted from the end of grace in *effective* time (the clock stops during hardship pauses); `FormalNoticeDue` at `deadline + 90 d` | C8 |
| A15 | Redemption while a payment is due | Rejected until the issuer pays (the issuer's own due, not a third-party block) | C7 |
| A16 | Rounding of `paid_per_unit` in `C_remaining` | `ceil` (favours the issuer) | C2, C7 |
| A17 | Window fee | `window_fee_bps` default 100 on cleared window bids, by analogy with auction bids | R33 |
| A18 | Transfer windows | Ship closed: `windows_enabled = false` until the admin enables them after the first lockups end | R19 |
| A19 | Holder claims after allowlist removal | Claims need holder registration (taken at mint or window fill), not current allowlist membership | C10 |
| A20 | Signatures | Attestor and verifier keys are secp256k1 on both chains, verified by `ecrecover` / `secp256k1_recover`, so one Stage 2 key serves both chains | D6 |
| A21 | Solana FX cross-check | Chainlink cross-check is configured only on EVM in this version; on Solana the cross-check feed is unset (coverage check still applies) | C9 |
| A22 | Tier-1 series | Hold plaintext `theta` and `r_wad` in the router (public by the issuer's explicit choice); still submit quarterly proofs; routed amounts are credited forward | D5 |
| A23 | `DefaultAccountState = Frozen` | Not used; the hook forbids every non-window transfer, so the extension adds nothing but an extra thaw step | D2 |
| A25 | First report of a series **(Kunal)** | The issuer supplies an *attested* prior income commitment (YTD income at the start of the first reporting period), so income earned in the settlement year before the raise is **not** owed. The alternative (zero prior → pre-raise same-year income is owed) is a who-pays-how-much choice the brief does not make; the issuer-favourable reading is in force | C3, SPEC §6.2 |
| A26 | Amended terms mid-year | Apply to marginal income from the next accepted report; no retroactive credit for quarters already paid. Stage 2 should submit CPI amendments after the Q4 report and before Q1 | C4, SPEC §3.2 |
| A27 | Window margin | First-come (ascending reveal index) fills at the clearing price instead of pro rata: exact, dust-free and always solvent. The brief requires pro rata rounding only for the primary auction | D9, SPEC §7 |
| A28 | Window non-reveals | Uncharged (full escrow back). The non-reveal charge applies to the primary auction only | D9 |
| A29 | Hardship pause while Late | A pause stops the clock but does not lift a release block already in force (`is_late_underlying`); the issuer must pay the overdue amount (no accrual accrues during the pause) before releases resume | C8, C11 §1 |
| A30 | Tier-1 reports | Bound on-chain to the router's period checkpoint via Poseidon(2) (Solana `sol_poseidon` syscall; EVM Poseidon contract generated from circomlibjs). Tier 1 is a valid report tier only for pure tier-1 series; series with tiers 2/3/4 must report with an attested tier | D5, D6 |
| A31 | Extinguishment and the estate | Only tranches not yet vested by the schedule go to holders; tranches vested before extinguishment remain claimable by the issuer's wallet (the estate). Counsel to confirm (H4) | C11 §6 |
| A32 | Redemption `D_avg` bucketing | Gross payments are attributed to the settlement-year containing the period's *due date* (not the payment date), so grace-period timing cannot move a payment across a bucket; router income by receipt time | C7 |
| A33 | Key revocation | Forward-only with a 45-day grace for already-ended periods; the last active key of a kind cannot be revoked without a replacement | C12 |
| A34 | Pause bounds | One approval ≤ 365 days; ≤ 730 days cumulative per series; at most 16 pauses; requests can be withdrawn | C8 §5 |
| A35 | EVM allowlist | A Merces flag; T-REX identities are registered once and never deleted so protocol-initiated unit movements never fail verification. Flag checked at bid commit, window bid commit, holder registration and the buyer side of a fill | C10, D2 |
| A36 | Window buyer removed before fill | The fill is cancelled (full refund) and the units return to the seller; validity at reveal is otherwise what counts | C10, D9 |
| A37 | Dev trusted setup | snarkjs *beacon* contributions (SHA-256 chain over a fixed public string) for powers-of-tau and phase 2, so every circuit artefact is byte-reproducible. Not a secure ceremony; never for production | D6 |
| A38 | Deterministic test proofs | Groth16 blinding scalars in the vector generator derive from a keccak of the (private) inputs and a nonce, so `pnpm vectors` is reproducible while proofs stay zero-knowledge; production provers use CSPRNG randomness | F1 |
| A39 | Tier-1 proof inputs | `income_ytd = ytd_at_end(period)` with salt 0, prior = `Poseidon(2)(ytd_at_end(period−1), 0)` or the zero commitment at a year start, `fx_avg_wad = WAD`, stored `units_outstanding`; a missing checkpoint reverts and `close_router_period` creates it | D5, D6 |
| A40 | Window buyer removed before fill | Units it would have bought are taken back from asks at `p*` in descending reveal order, then from asks below `p*`, so money is conserved exactly | D9 |
| A41 | Error naming | Canonical v1.1 error names are exported by `@merces/sdk` (`errors.ts`) and used by the vectors' `expect_revert` steps; where several preconditions fail at once the vectors pin the SPEC's listed check order | F1 |
| A42 | Not yet covered by a parity vector | Tier-3 true-up and the `AmountOutOfRange` entry rule are unit-tested in the reference only (vectors 20–21 planned) | F1 |
| A43 | Hook upgrade authority | `merces_hook` (the Solana transfer rules) is upgradeable by the protocol multisig + timelock, mirroring the EVM compliance module behind the T-REX implementation authority owned by the timelock; only the registry (D1) has no upgrade authority | D2, D11 |
| A44 | Two-step window delivery | `process_order` is accounting only; `deliver_order` pushes units/stablecoin and is retryable, so one frozen recipient account cannot block a window (liveness, §12). Same split as `process_bid`/`deliver_bid` | D9 |
| A45 | Cancelled-buyer take-back | Asks at `p*` in descending reveal index, then asks below `p*` in descending (price, reveal index); on Solana via a keeper-proposed threshold verified by a paged tally | D9 |
| A46 | Mock USDG and confidential transfers | Token-2022 refuses `ConfidentialTransferMint` next to a transfer-fee config without a confidential-fee config, so the mock carries TransferHook, TransferFeeConfig (0/0) and MetadataPointer only; the deploy scripts read the real mint's extensions at runtime | M0 |
| A47 | Compute budgets | `submit_report` needs about 209k CU and `process_bid` can exceed 200k; clients must set a compute-unit limit (Solana) | D6 |
| A24 | Mock USDG | Token-2022 mint with TransferHook (mock no-op hook program), TransferFeeConfig at 0 bps / 0 max, ConfidentialTransferMint and MetadataPointer, 6 decimals — mirroring the extension set reported for USDG | M0 |

Track-level detail: `docs/assumptions/track-a.md` (reference, circuit, vectors), `docs/assumptions/track-b.md` (Solana), `docs/assumptions/track-c.md` (EVM), `docs/assumptions/track-d.md` (Meteora).

## Unverified

| # | Item | Status |
| --- | --- | --- |
| U1 | docs.meteora.ag, docs.monad.xyz, docs.pyth.network are unreachable from the build container (egress policy) | Replaced by the cloned official repos (`docs/research/*.md` cite file:line); Monad facts come from search snippets of docs.monad.xyz and must be re-checked by a human before deployment |
| U2 | USDG mint address and its exact extension set | Mint `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` from public token lists; extension set from the planning document. The deploy scripts read the real mint's extensions at runtime and refuse to proceed if a non-zero transfer fee is configured |
| U3 | Pyth FX feed ids for INR, JPY, CAD, CHF, BRL, MXN, SGD | Not present in the cloned repos; must be fetched from Hermes `/v2/price_feeds?asset_type=fx` at configuration time. EUR/USD, GBP/USD, AUD/USD and USDC/USD ids are verified |
| U4 | Pyth Monad contract: a second, undocumented testnet entry exists in Pyth's contract manager | The documented `0x2880aB15…` address is used |
| U5 | Devnet/testnet deployment from this container | Both RPC endpoints are blocked by the egress policy; deployment scripts are provided and must be run from a machine with network access |
| U6 | Meteora devnet keeper / manual migrator internals | Not documented in the clones; the graduation script performs the migration instructions directly |
