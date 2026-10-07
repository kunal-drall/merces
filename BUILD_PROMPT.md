# Merces — Stage 2 Build Prompt: Integration and Backend

Prepared 7 October 2026. This is the task brief the Stage 2 code in this repository implements. Read it first.

---

## Part A — Your task

You are the lead backend engineer for **Merces**, a protocol that lets a person raise capital against a capped share of their future income. The mechanism is called **Mercery**. The onchain unit is the **Human Equity Unit (HEU)**.

The product is built in three stages:

1. **Stage 1** — onchain programs on Solana and contracts on Monad. Being built in parallel by another team. **Its code may not exist yet.**
2. **Stage 2** — integration and backend. **This is your task.**
3. **Stage 3** — frontend apps, built later against your API.

Build Stage 2: the services that connect both chains to the outside world (income sources, legal contracts, identity checks, exchange rates) and the single API the apps will read and write through.

### The two things that make this task unusual

**1. You must be able to work without Stage 1.** Build everything against a chain *port* (an interface you define) backed by a deterministic **simulator** that implements the mechanism in Part C. Every service, test and demo must run end to end on the simulator. Never block on Stage 1.

**2. You must catch Stage 1 the moment it appears.** When Stage 1 publishes its artifacts (interfaces, events, deployments, test vectors), a single command must detect them, generate live adapters, report every difference from what you assumed, and prove with one shared test suite that the live chains behave like the simulator. Part D specifies this.

### Stage 2 is done when

- **Before Stage 1 exists:** one complete raise-to-payout cycle runs end to end on the simulator, for both the Solana and the Monad personality, with Stripe test data and no manual steps.
- **After Stage 1 exists:** the same cycle runs on Solana devnet and Monad testnet, the adapter conformance suite passes on both, and the drift report is empty or every item is resolved.

### Ground rules

- **Never touch mainnet. Never use real funds or real personal data.** Devnet, testnet, sandboxes and synthetic fixtures only.
- **No custody.** The backend never holds user funds and cannot move them. It builds unsigned transactions for users to sign. Keepers only call functions anyone could call.
- **No raw income at rest.** Income figures, income documents and hardship reasons are never written to a database, a log, a queue or an error report. Part E says how each service achieves this.
- **Chain-neutral API.** No endpoint makes a client care which chain an issuer is on.
- **Money and charter semantics are not yours to change.** If something is ambiguous in a way that changes who gets paid, how much, or what an issuer can be forced to do, stop and ask. Otherwise choose a sensible default and record it in `ASSUMPTIONS.md`.
- **Do not invent facts.** Third-party APIs (Reclaim, Pyth, identity and e-signature providers, DEX aggregators), SDK methods and versions must come from official documentation. Put every external provider behind a port with a mock implementation. Pin versions in `VERSIONS.md`.
- **Secrets never enter the repository.** Signing keys sit behind a key-management port (local dev signer, cloud KMS in production).
- **Build in the order in Part G.** After each milestone write a short summary: what was built, what was assumed, what is open.

---

## Part B — Product Requirements (complete, consolidated v1.0)

### B1. Summary

Merces lets people raise capital against a capped share of their future income, without forming a company. Backers get verified, capped cash flows. Issuers keep every life choice.

- **Name.** *Merces* is Latin for wages, pay or reward. *Mercery* is the mechanism: issue, verify, pay, redeem.
- **Thesis.** Venture capital says it backs founders but invests in companies, so the investor's upside ends with the first entity. Merces matches the instrument to the real bet: the person, across every career chapter.
- **Principle.** Contracts first, tokens second. A signed legal contract is the asset; the onchain unit represents it. If the two disagree, the contract governs.
- **Ethical keystone.** No payment below the threshold, no control over life choices, and a guaranteed way out.

### B2. Problem and opportunity

Capital can back companies but not people, so talented individuals must squeeze their lives into company-shaped containers to get funded. Investors' upside dies with the first entity. Most high-potential people never start a company, yet no instrument lets anyone invest in their trajectory. Earlier person-linked products failed on design. The rails now exist: onchain treasuries, sealed-bid auctions and zkTLS income proofs.

### B3. Goals and non-goals

The complete software ships first. A closed pilot then proves one thing: a person can raise capital, report income, and repay holders under capped terms without giving up autonomy.

**Goals**

1. Let an invited issuer pick a launch chain (Solana and Monad at launch; Ethereum, Arbitrum, Base and Robinhood Chain later) and raise USDC or USDG by selling HEUs in a sealed-bid auction.
2. Release raised capital to the issuer on a fixed schedule from an onchain treasury.
3. Verify each period's payment through ProofOfIncome.
4. Pay holders pro rata and burn units at their cap or on issuer redemption.
5. Enforce the Autonomy Charter in both the legal contract and the code.

**Built but not active in the pilot, and non-goals**

- Secondary trading ships with the software but stays closed until the 18-month lockups end.
- Self-attested income (tier 4) ships but stays switched off until an audit process is staffed.
- Futarchy-gated early draws ship as a switched-off hook.
- Permissionless issuance is a non-goal. Issuers are invited and reviewed.
- Any feature that gives holders a say in an issuer's life choices is a non-goal in every phase.
- **Private payouts are not in this version.** Payment amounts are public onchain in v1.

### B4. Users

Issuers (artist/musician, engineer, freelancer, founder), backers, attestors (CA or CPA). Issuers are the primary user. Every trade-off favours them.

### B5. Core flows

**Issuer journey:** apply and pass review; set terms; sign the HEU contract and the Autonomy Charter; connect income adapters; launch the raise; receive scheduled releases; submit a quarterly ProofOfIncome report and pay into the vault; optionally pause for hardship or redeem after the lockup.

**Backer journey:** apply and pass eligibility; review profile, terms and tier; place a sealed bid (one clearing price plus a 1% fee); hold through the lockup, claiming quarterly payouts net of a 5% fee; see payout history and yield only; receive the formula price on redemption; at the cap the unit burns.

### B6. Functional requirements (Stage 2 obligations)

| ID | Component | Requirement | Pri | Stage 2 obligation |
| --- | --- | --- | --- | --- |
| R1 | Issuance | Invite-only issuer onboarding with identity and income-source review | P0 | Owns it: applications, review workflow, identity checks, allowlist sync |
| R2 | Issuance | Term builder | P0 | Terms validation, bounds and defaults, commitment helper, private terms vault |
| R3 | Issuance | HEU contract and Autonomy Charter signed before any raise opens | P0 | Owns it: e-signature flow, contract hash anchoring |
| R4 | Auction | Sealed-bid auction clearing at one price | P0 | Commitment backup, reveal reminders, settlement crank, transaction builders |
| R5 | Auction | Minimum raise, full refunds if not met | P0 | Refund builders and status |
| R6 | Treasury | Onchain treasury releasing on a fixed schedule | P0 | Schedule views, draw builder, pause status |
| R7 | Treasury | Futarchy check for early or larger draws | P2 | Surface the switched-off flag only |
| R8 | ProofOfIncome | Tier 1 adapter: onchain split | P0 | Index router receipts; reconcile in quarterly reports |
| R9 | ProofOfIncome | Tier 2 adapters: zkTLS proofs from Stripe, Deel, DistroKid (Reclaim) | P0 | Owns it |
| R10 | ProofOfIncome | Tier 3 attestor portal | P1 | Owns the backend |
| R11 | ProofOfIncome | zk circuit proving the payment owed | P0 | Serve prover artifacts, assemble public inputs, verify offchain before submission |
| R12 | ProofOfIncome | Tier 4 self-attestation with random audits | P2 | Admin flag (off) and audit-sampling scaffolding |
| R13 | Payouts | Pro rata payouts each period | P0 | Claim builders, payout history |
| R14 | Exit | Per-unit payout tracking with automatic burn at the cap | P0 | Burn crank, retirement status |
| R15 | Exit | Issuer redemption at the formula price, with the tail clause | P1 | Quote endpoint, builders, tail tracking |
| R16 | Exit | Hardship pause approved by a private attestor review | P1 | Owns the private review workflow |
| R17 | Market | Transfer limits and approved wallets only | P0 | Allowlist-manager operations |
| R18 | Market | Per-wallet holding cap (10%) | P0 | Pre-checks in the bid API |
| R19 | Market | Quarterly sealed-bid transfer auctions | P2 | Window scheduling and commitment backup, built and switched off |
| R20 | Backer app | Dashboard showing payout history and yield only | P0 | Holdings, payout and yield endpoints |
| R21 | Chains | Issuer picks chain and stablecoin; locked once the raise opens | P0 | Chain-neutral series model; per-chain stablecoin catalogue |
| R22 | Chains | Solana and Monad live together | P0 | Both live adapters and both simulator personalities |
| R23 | Chains | EVM redeployments later | P1 | EVM adapter driven purely by chain config |
| R24 | Chains | Cross-chain funding | P2 | Not built |
| R25 | Backer app | One app listing issuers across every chain | P1 | Owns it: one indexer and API over both chains |
| R26 | ProofOfIncome | Tier 3 prefill from tax returns and accounting software | P1 | Owns it |
| R27 | Issuance | Private readiness report for applicants | P2 | Owns it |
| R28 | Privacy | Holder-only payment amounts and private payouts | — | Coming soon; disclose terms only to eligible backers; keep amounts out of the public feed; persist no raw income |
| R29–R32 | Surfaces | Landing/Arena, issuer profile and auction page, dashboards, applications | P0 | The APIs they need, an OpenAPI contract, a mock server |
| R33 | Fees | Backers pay 1% of cleared bids and 5% of payouts; issuers pay nothing | P0 | Fee accounting and reconciliation |
| R34 | Issuance | Threshold floor at local median income, indexed yearly | P0 | Owns the threshold data service, floor check, yearly indexing amendments |
| R35 | Raise style | Meteora bonding curve as an optional raise style on Solana | P0 | Curve-mode orchestration, swap-route builder, graduation monitoring |

### B7. Non-functional requirements

Privacy (income sources, income below threshold and hardship reasons never go onchain; v1 stores only a commitment to θ and r); security (audits, multisig + time delay); enforceability (series ↔ signed contract by hash); compliance (allowlisted wallets only; Merces is software and a protocol); immutability of the charter (only issuer-favourable amendments); auditability (every money event traceable to a period's report).

### B8. Decisions in force

Sequencing: software before pilot. Pilot: 12 invited issuers, six per chain. Unit defaults: cap 2.5× (2.0–3.0×), hurdle 8%, k = 5, lockup 18 months. Threshold: never below local median full-time income, indexed yearly. Tier 2: Stripe, Deel, DistroKid via Reclaim (TLSNotary fallback). Fees: 1% of cleared bids, 5% of each payout; issuers pay nothing; caps count gross. Chains: Solana and Monad. Stablecoins: Solana USDC and USDG; Monad USDC. Commit-reveal sealed bids. Quarterly reporting. One zk system (Groth16/BN254 candidate). No private payouts in v1. FX: quarter-average Pyth with Chainlink cross-check, attestor-signed central-bank rate as fallback. Paying in: due 30 days after quarter end, 15 days grace, then 8% accrual and release pause, formal notice at 90 days, nothing slashed. ERC-3643 (T-REX) on Monad. Meteora curve optional on Solana; the curve quotes in USDC, USDG enters through a swap.

### B9–B11

Success metrics (on-time reporting, tier 1–2 share, payout accuracy, minimum-raise rate, issuer satisfaction, disputes/pauses). Release plan: Phase 0 foundations, Phase 1 build + audits, Phase 2 pilot, Phase 3 open market. Still open: pilot jurisdictions; whether defaults hold under modelling (**every default is a parameter**); the privacy layer for future private payouts.

---

## Part C — Mechanism specification

### C1. Glossary
Issuer; backer/holder; series (one token per series); unit (HEU, 0 decimals); covered income (employment, consulting/freelance, equity exits, dividends, IP/content royalties; excluded: gifts, inheritance, spousal income, unrealised gains); threshold θ; rate per unit r = s / N; period = calendar quarter (UTC); reporting year = calendar year unless the series says otherwise; issue price P0 = clearing price; gross payment vs net payout (minus 5%).

### C2. Number conventions
Money in stablecoin base units (6 decimals; verify from the mint). Ratios in 1e18 fixed point (WAD); u128 intermediates on Solana. **Rounding favours the issuer when computing what the issuer owes and never lets holders be paid more than the vault holds.** Division rounds down; dust rolls forward.

### C3. Payment formula (year-to-date)
```
owed_YTD(q)    = r × units_outstanding × max(0, income_YTD(q) − θ)
payment(q)     = owed_YTD(q) − owed_YTD(q−1)
payment_usd(q) = payment(q) × fx_avg(q)
```
fx_avg(q) from the rate accumulator (1 for USD stablecoin income). A zero payment is a valid, complete report. The payment is computed offchain inside the zk circuit on the issuer's device; neither the chain nor the database ever sees income or θ in plaintext.

### C4. Terms and the terms commitment
Immutable once the raise opens: issuer, stablecoin mint, N, reserve price, minimum raise, cap multiple m (2.0–3.0, default 2.5), lockup (18 months), release schedule, fee rates, contract hash, tier flags. `terms_commitment = hash(θ, r, reporting currency, indexing rule, salt)`; θ and r are not stored in plaintext; every proof takes `terms_commitment` as a public input. Replaced only by `amend_terms` (issuer signature + registered attestor signature stating the change is issuer-favourable). The cap multiple may only decrease.

### C5. Fees
1% auction fee paid by winning bidders on top of the clearing price; 5% payout fee taken when the payment enters the vault; issuers pay nothing; failed auctions charge nothing; fees go to a multisig-controlled fee collector.

### C6. Cap accounting
C = m × P0 (gross). One accumulator `paid_per_unit` (WAD). On gross G with N outstanding: inc = G / N; if paid_per_unit + inc < C accept all; else accept G' = (C − paid_per_unit) × N, refund the rest, set Retired, make units burnable (burn on claim or by crank). Reward-per-share claims against a net accumulator; a holder can never claim more than its share and total claims never exceed the vault. Invariant: lifetime gross + redemption price + tail ≤ C per unit.

### C7. Redemption (after lockup)
```
P_redeem    = min( C_remaining , max( P_hurdle , k × D_avg ) )
C_remaining = C − paid_per_unit
P_hurdle    = P0 × (1 + h)^floor(t) × (1 + h × frac(t))
D_avg       = average annual gross payment per unit over the trailing 3 years (full years only; omit if < 1 year)
```
h = 8%, k = 5 (parameters fixed per series). Issuer deposits P_redeem × units; holders claim; units burn; no fee. Never blockable. Full-series redemption required; partial is a stretch goal. **Tail clause:** for 12 months after redemption, a covered liquidity event pays holders at redemption what they would have been paid, capped per unit at C_remaining − P_redeem.

### C8. Paying in, lateness and pauses
Due 30 days after quarter end; 15-day grace; then simple interest at h (payment × h × days_late / 365) added to the gross payment and treasury releases pause until current; a permissionless crank sets Late; FormalNoticeDue at 90 days; nothing slashed. Hardship pause: issuer requests, attestor approves with an end date; deadlines and accrual stop; payments deferred, not forgiven; holders see only the status. Tier 3 issuers pay on estimate and true up within 60 days of the annual attestation. Statuses: OnTime, InGrace, Late, Paused, Retired, Redeemed, Extinguished.

### C9. Rate accumulator
One per pair per chain; one Pyth snapshot per UTC day by a permissionless keeper (staleness and confidence checked); fx_avg(q) = Δsum / Δcount; NeedsFallback if < 80% of days have snapshots or Pyth deviates from Chainlink beyond a band; then the report carries an attestor-signed rate. Verify Pyth feeds and Monad deployment from Pyth's documentation.

### C10. Market rules
Allowlist; 18-month lockup; window-only transfers after lockup (direct transfers fail; burns, redemption, retirement always allowed); 10% wallet cap at settlement and on every transfer; no lending, AMMs or shorting; removing a wallet from the allowlist never strands value.

### C11. Autonomy Charter as code invariants
1. Releases follow the schedule with no approval; only Late status and the issuer's own request pause them. 2. Onchain data is limited to series parameters, the commitment, amounts, statuses and events. 3. No work obligation; no penalty for reporting zero. 4. Units carry no vote. 5. The issuer can stop new issuance; existing series end only through cap, redemption or extinguishment. 6. Extinguishment on death or permanent disability confirmed by two attestors: unreleased treasury returned to holders pro rata; nothing else owed (assumption for counsel). 7. Charter fields have no upgrade path; only issuer-favourable amendments.

### C12. Roles and hard limits
Protocol admin (multisig + timelock): register attestors and verifier keys, manage the fee collector, pause new raises, upgrade after delay; never touch live terms, move funds, block redemption/claims/releases or change fees. Allowlist manager: eligibility only. Attestor: sign tier 3 reports, favourable amendments, pauses, fallback FX, extinguishment (two). Keeper: anything permissionless. Issuer: open/cancel own raise before bids, draw, report, pay, request pause, redeem; never change live terms except through the favourable path.

---

## Part D — Working without Stage 1, and catching it when it lands

**D1.** One `ChainPort` interface (read, events, write with `build<Command>` for users and `submit` for keeper/service roles); three implementations: `SimulatorChain`, `SolanaChain`, `EvmChain`.

**D2.** Canonical domain model v0 in `DOMAIN_EVENTS.md` and a machine-readable schema. Events: IssuerRegistered, SeriesCreated, RaiseOpened, RaiseCancelled, BidCommitted, BidRevealed, AuctionSettled, AuctionFailed, BidRefunded, UnitsMinted, TreasuryFunded, FundsReleased, ReleasesPaused, ReleasesResumed, SplitReceipt, ReportAccepted, PaymentReceived, PaymentRefunded, FeeTaken, PayoutClaimed, SeriesRetired, UnitsBurned, RedemptionOpened, RedemptionClaimed, TailPayout, PauseRequested, PauseApproved, PauseEnded, StatusChanged, FormalNoticeDue, TermsAmended, SeriesExtinguished, RateSnapshot, FxFallbackFlagged, TransferWindowOpened, TransferWindowCleared, UnitsTransferred, AllowlistUpdated, AttestorRegistered, CurveSeriesCreated, CurveGraduated. Commands: createSeries, openRaise, cancelRaise, commitBid, revealBid, settleAuction, claimRefund, drawRelease, submitReport, payIn, claimPayout, requestPause, approvePause, redeem, claimRedemption, amendTerms, extinguish, snapshotRate, crankStatus, crankBurn, openTransferWindow, setAllowlist. Live adapters are anti-corruption layers. `seriesId = "<chain>:<address>"`; money is a decimal string in base units; never floating point.

**D3.** `SimulatorChain`: deterministic bigint implementation of Part C; personalities `solana` and `monad`; time travel; Postgres persistent mode; emits exactly the canonical events; pure math in `@merces/math` (interim; swappable for Stage 1's library).

**D4.** Per-chain mode `mock | live | auto` (auto: manifest entry + health check, else simulator; log which mode each chain is in).

**D5.** Stage 1 handoff manifest (`handoff/manifest.json`) located through `STAGE1_PATH`; `stage1.map.json` by hand if absent. `stage1:sync`: detect; generate typed clients; diff interfaces into `INTERFACE_DRIFT.md`; swap the math after vector parity; replay parity vectors through the simulator; run the conformance suite; print a verdict per chain. Run in CI on a schedule and whenever `STAGE1_PATH` changes.

**D6.** Catch-up checklist: run `stage1:sync`, read the drift report, resolve drift in adapters, Stage 1 wins for onchain behaviour, get conformance green on devnet and testnet, run the full cycle live, flip to `live` in staging, write `STAGE1_INTEGRATION.md`.

---

## Part E — Services

E1 indexer and API gateway (idempotent, resumable, reorg-safe; public feed without amounts). E2 identity, sign-in (Solana and EVM wallets), onboarding, eligibility, allowlist sync. E3 contract signing (e-signature port, hash into `createSeries`). E4 terms vault and disclosure (encrypted θ and r, access-logged disclosure, yearly amendment). E5 ProofOfIncome (zkTLS port, Reclaim first; device-side commitment and proof; isolated report verifier with no database, no payload logs, KMS key; report assembly and offchain verification; deadlines; tier-1 reconciliation). E6 auction service (client-encrypted reveal backups, reminders, offchain clearing and settlement crank, cap and allowlist pre-checks). E7 keepers and scheduler (idempotent, low-privilege fee payer). E8 rate keeper (daily Pyth snapshot, Chainlink cross-check, fallback routing). E9 threshold data service (curated, sourced, admin-edited; placeholders until sources arrive). E10 attestor service (tier 3 prefill and sign-off, hardship, fallback FX, amendments, two-attestor extinguishment; E2E-encrypted documents). E11 fees and accounting. E12 notifications (statuses, never reasons). E13 admin API with append-only audit log. E14 Meteora support (Solana only). E15 private payouts not built; claim builder behind an interface.

## Part F — Data and API conventions
TypeScript, pnpm monorepo, Postgres, a job queue, Docker Compose, OpenAPI 3.1 contract first with a generated typed client and `dev:mock`; access tiers per endpoint (public, eligible backer, holder, issuer, attestor, admin) written down and tested; idempotency keys on every write; outbox pattern; `PRIVACY.md`.

## Part G — Build order
M0 foundations; M1 read side; M2 people and paper; M3 ProofOfIncome; M4 raise and clockwork; M5 everything else; M6 Meteora; M7 Stage 1 catch-up (run `stage1:sync` at the end of every milestone).

## Part H — Testing and acceptance
H1 scenario tests through the API on the simulator; H2 adapter conformance suite against `ChainPort`; H3 privacy canary, access matrix, no-custody, restart/duplicate/out-of-order/reorg safety; H4 done when Part A's conditions hold.

## Part I — Deliverables
Source; `openapi.yaml`, typed client, `dev:mock`; `README.md`, `ARCHITECTURE.md`, `API.md`; `DOMAIN_EVENTS.md` + schema; `STAGE1_INTEGRATION.md` and `INTERFACE_DRIFT.md`; `PRIVACY.md`, `SECURITY.md`, `RUNBOOK.md`; `ASSUMPTIONS.md`, `VERSIONS.md`.

## Part J — Questions for Kunal
1. Identity-check and e-signature providers (default: mocks). 2. Cloud and KMS (default: local dev signer). 3. Reclaim account; can a proof attest a hash of the figure? 4. Median income and inflation sources. 5. Tier 3 client-side extraction vs isolated worker. 6. Channels beyond email. 7. DEX aggregator for USDG→USDC. 8. Pyth/Chainlink deviation band. 9. Retention periods and pilot jurisdictions.
