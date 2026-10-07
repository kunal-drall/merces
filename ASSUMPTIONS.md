# Assumptions, defaults and unverified items

Every default chosen during the build and everything that could not be verified. Items marked **(Kunal)** need a
decision; the default applies until one arrives. Track-specific notes compiled from `docs/assumptions/*.md`.

## Decisions taken (with the default in force)

| # | Topic | Default in force | Why / brief reference |
| --- | --- | --- | --- |
| A1 | Non-reveal charge **(Kunal, H1)** | 1% of escrow, parameter `non_reveal_charge_bps = 100`; **no** charge when the auction fails (brief: failed auctions charge no fee) | D3 |
| A2 | Pyth/Chainlink deviation band **(Kunal, H2)** | `fx_deviation_band_bps = 200` (2%). Reasoning: Pyth FX confidence is normally ≈0.1% of price; a 2% gap between two independent oracles on a liquid FX pair signals a stale or broken feed rather than noise, while anything tighter would trip on normal publish-time skew between the two networks | C9 |
| A3 | Meteora maximum-raise multiple and proceeds route **(Kunal, H3)** | Max raise = 3× attested trailing annual income (parameter). Proceeds route: the DBC **migration fee** with `creator_fee_percentage = 100` and a high `fee_percentage`; the migration fee is the only mechanism that moves raised quote tokens to the creator/partner (see `docs/research/METEORA_DBC.md` §4). Options and numbers are in `ARCHITECTURE.md` §Curve mode | D10 |
| A4 | Extinguishment **(Kunal, H4)** | Unreleased treasury funds go to holders pro rata through the vault with **no fee**; all open dues are cleared; nothing else is owed | C11 §6 |
| A5 | T-REX licence **(Kunal, H5)** | T-REX 4.1.6 and ONCHAINID 2.2.1 are GPL-3.0. The EVM package is therefore distributed under GPL-3.0 (see `LICENSE.md`). Tokeny's shipped compliance modules carry a CC-BY-NC-4.0 non-commercial rider, so Merces writes its own module against the GPL interfaces only. The upstream repository is marked deprecated in favour of the ERC-3643 association's repo; the npm package is still the published artefact | D2 |
| A6 | Partial redemption **(Kunal, H6)** | Not built (stretch) | C7 |
| A7 | Durations **(Kunal, H7)** | commit 7 d, reveal 2 d, window commit 3 d, window reveal 1 d, all per-series parameters with the bounds in `SPEC.md` §1.6 | D3, D9 |
| A8 | Hackathon fast path **(Kunal, H8)** | Not in effect; normal order followed | E |
| A9 | Year and month lengths | `YEAR = 365 d`; 18 months = 547.875 d = 47,336,400 s | C7, C8 |
| A10 | Wallet cap at the auction | Validated at reveal against `units_offered` (the only base known before settlement); after settlement the cap is enforced against outstanding supply on every window fill | C10 |
| A11 | One bid per wallet per auction and per window | Simplifies cap enforcement and sybil-resistance; a wallet may still bid in every series | D3, D9 |
| A12 | Min-raise test | Uses the upper bound `p* × (q_above + R)`; marginal rounding dust can make exact proceeds lower by less than `p* × (marginal bids − 1)` | D3 |
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
| A24 | Mock USDG | Token-2022 mint with TransferHook (mock no-op hook program), TransferFeeConfig at 0 bps / 0 max, ConfidentialTransferMint and MetadataPointer, 6 decimals — mirroring the extension set reported for USDG | M0 |

## Unverified

| # | Item | Status |
| --- | --- | --- |
| U1 | docs.meteora.ag, docs.monad.xyz, docs.pyth.network are unreachable from the build container (egress policy) | Replaced by the cloned official repos (`docs/research/*.md` cite file:line); Monad facts come from search snippets of docs.monad.xyz and must be re-checked by a human before deployment |
| U2 | USDG mint address and its exact extension set | Mint `2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH` from public token lists; extension set from the planning document. The deploy scripts read the real mint's extensions at runtime and refuse to proceed if a non-zero transfer fee is configured |
| U3 | Pyth FX feed ids for INR, JPY, CAD, CHF, BRL, MXN, SGD | Not present in the cloned repos; must be fetched from Hermes `/v2/price_feeds?asset_type=fx` at configuration time. EUR/USD, GBP/USD, AUD/USD and USDC/USD ids are verified |
| U4 | Pyth Monad contract: a second, undocumented testnet entry exists in Pyth's contract manager | The documented `0x2880aB15…` address is used |
| U5 | Devnet/testnet deployment from this container | Both RPC endpoints are blocked by the egress policy; deployment scripts are provided and must be run from a machine with network access |
| U6 | Meteora devnet keeper / manual migrator internals | Not documented in the clones; the graduation script performs the migration instructions directly |
