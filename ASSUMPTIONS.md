# ASSUMPTIONS.md

Every sensible default chosen where the brief was ambiguous, with its id, the place it is enforced, and what would
change if Kunal or counsel decides otherwise. Money and charter semantics that could change who gets paid or how
much are flagged **ASK** and were not decided silently: the default is implemented but marked for confirmation.

| Id | Topic | Assumption | Where | Status |
| --- | --- | --- | --- | --- |
| A-ID-1 | Identifiers | EVM addresses are normalised to lowercase in the domain model; Solana addresses are case-sensitive base58. `seriesId = "<chain>:<address>"`. | `@merces/domain` ids.ts | default |
| A-TERMS-1 | Terms | Stablecoins have 6 decimals (USDC, USDG). Live adapters read `decimals` from the mint/contract and refuse a series whose mint disagrees. | simulator + adapters | default |
| A-TERMS-2 | Lockup | "18 months" = 18 × 30 days = 540 days, stored per series in seconds. | `DEFAULTS.lockupSeconds` | default |
| A-TERMS-3 | Release schedule | A fixed schedule is a list of tranches `{afterSeconds since settlement, bps}` summing to 10,000 bps. | simulator `drawRelease` | default |
| A-AUC-1 | Auction ties | Bids at the same price are filled in commit order (earlier first), not pro rata. | `@merces/math` clearAuction | **ASK** (changes who gets units at the margin) |
| A-AUC-2 | One bid per wallet | A wallet may commit once per raise. | simulator `commitBid` | default |
| A-AUC-3 | Deposits | A commit locks a deposit ≥ price × quantity × 1.01; reveals that the deposit cannot cover are rejected; refunds are pull-based (`claimRefund`). | simulator | default |
| A-AUC-4 | Wallet cap at settlement | Allocation is truncated at the wallet cap rather than rejecting the bid. | clearAuction | default |
| A-C8-1 | Accrual start | Days late are counted from the end of the 15-day grace period, not from the due date. | `@merces/math` lateness.ts | **ASK** (changes the amount owed) |
| A-C8-2 | Accrual base | Accrual applies to the amount still outstanding after tier-1 split receipts, and the 5% payout fee applies to the accrual too (it is "added to the gross payment"). Accrual counts toward the cap. | simulator `submitReport` / `receivePayment` | **ASK** |
| A-C8-3 | Tier-3 true-up | The 60-day true-up window is enforced by the attestor service (E10), not onchain; underpayments inside the window are submitted as a corrected report with no accrual. | E10 | default |
| A-REP-1 | First period | The quarter in which the auction settles is the first reportable quarter (reports are due for every quarter whose end is after settlement). | simulator `reportablePeriods` | default |
| A-REP-2 | Public inputs | zk public inputs v0: `[termsCommitment, incomeCommitment, unitsOutstanding, paymentStable, fxAvgWad, periodIndex]`. Stage 1 wins if its circuit differs. | `SimEngine.publicInputs` | provisional |
| A-REP-3 | Exact pay-in | `payIn` must equal the remaining amount due for the period (no partial payments). | simulator `payIn` | default |
| A-REP-4 | Currencies | All of a series' sources must be in its reporting currency or in USD; anything else goes through tier 3. | E5 | default (per brief E5) |
| A-RED-1 | Redemption precondition | The issuer must have reported and paid every completed quarter before redeeming. This is a condition the issuer alone controls, so redemption stays unblockable by others. | simulator `redeem` | **ASK** |
| A-RED-2 | Tail fee | Tail payouts are payouts, so the 5% backer fee applies to them (redemption itself is fee-free). | simulator `payIn` (tail) | **ASK** |
| A-RED-3 | Tail window | 12 months = 360 days from redemption. | `DEFAULTS.tailMonths` | default |
| A-RED-4 | Hurdle time | Years since settlement use 365-day years. | `@merces/math` time.ts | default |
| A-C11-6 | Extinguishment | Unreleased treasury funds are returned to holders pro rata, fee-free and outside the cap; the issuer's estate owes nothing else. Recorded for counsel. | simulator `extinguish` | **ASK (counsel)** |
| A-FX-1 | Coverage | 80% of the quarter's UTC days must have a snapshot; FX feeds do not publish at weekends, so the keeper submits the last available price on non-trading days (the contract accepts a publish time up to `maxRateAgeSeconds`; weekend handling is a Stage 1 question). | rate keeper | **ASK (shared with Stage 1)** |
| A-FX-2 | Deviation flag | The simulator trusts the keeper's `deviation` evidence; Stage 1's contracts are expected to read Chainlink themselves. Chainlink has no FX feeds on Monad (verified 2026-10-07), so on Monad the cross-check is unavailable and only the coverage rule applies until a second source is chosen. | simulator `flagFxFallback`, E8 | **ASK** |
| A-FX-3 | Deviation band | Placeholder 100 bps until Kunal sets it (Part J.8). | `DEFAULTS.fxDeviationBandBps` | placeholder |
| A-TW-1 | Transfer windows | Window orders clear at the price of the lowest filled bid (uniform price), no fee; sells by de-allowlisted wallets are allowed, buys are not. | simulator | default (feature off) |
| A-CURVE-1 | Curve mode | The simulator models the Meteora curve as a toy linear curve with 0-decimal units and graduation at `minimumRaise`; the real curve is Stage 1's. | simulator `buyCurve` | provisional |
| A-ADM-1 | Admin commands | Admin actions are built as unsigned transactions for the multisig; the simulator uses a single admin address as the multisig stand-in. | simulator | default |
| A-PRIV-1 | Report verifier | The verifier sees the attested figure in memory only; it keeps no database and logs no payloads. If Reclaim's `responseRedactions[].hash` option is used, it can be made to never see the figure (Part J.3). | E5 | default |
| A-DATA-1 | Threshold table | Seeded with clearly marked placeholder rows; no figure is a real statistic until Kunal supplies sources. | E9 | placeholder |
| A-REP-5 | Rate per unit | r = s / N uses N = units offered at creation (C1), not units sold; payment uses units outstanding. A half-sold raise owes half the share rate. | `@merces/poi-device`, harness | spec (clarified) |
| A-REP-6 | Tier 1 attestation | Tier-1 reports carry the proof and, when available, a verifier attestation; the chain requires only the proof since the income is onchain. | simulator `submitReport` | default |
| A-PRIV-2 | Verifier reachability | Devices POST zkTLS proofs directly to the report verifier; the API never receives a proof or a salt. In mock mode the verifier runs in-process with the same dev key. | E5, `@merces/server` | default |
| A-C6-1 | Period "paid" | A period's `paid` is the gross the vault accepted; the issuer's cap refund is recorded separately (PaymentRefunded) and not counted as paid. | simulator `payIn`, indexer | default |
