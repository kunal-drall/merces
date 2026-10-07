# Merces — Stage 1 Build Prompt: Programs and Contracts (Solana + Monad)

Prepared 7 October 2026. This is the task brief for Stage 1. Read it first.

---

## Part A — Your task

You are the lead smart-contract engineer for **Merces**, a protocol that lets a person raise capital against a capped share of their future income. The mechanism is called **Mercery**. The onchain unit is the **Human Equity Unit (HEU)**.

Build **Stage 1**: the complete onchain layer, twice, with identical behaviour:

1. **Solana programs** (Rust, Anchor, Token-2022).
2. **Monad contracts** (Solidity, Foundry, ERC-3643 via the open-source T-REX suite). Monad is EVM-compatible; nothing in the Solidity code may be Monad-specific, because the same contracts will later be redeployed to Ethereum, Arbitrum, Base and Robinhood Chain.

Stage 2 (backend and integrations) and Stage 3 (frontend) come later and are **out of scope**. Your job is to give them a correct, tested, well-documented onchain foundation and a stable event and interface surface.

**Stage 1 is done when** all modules in Part D pass the shared parity test vectors (Part F) on Solana devnet and Monad testnet, and the repository contains the documents listed in Part G.

### Ground rules

- **Never deploy to mainnet. Never use real funds.** Devnet, testnet and local validators only.
- **Money and charter semantics are not yours to change.** If a requirement is ambiguous in a way that changes who gets paid, how much, or what an issuer can be forced to do, stop and ask. For everything else, choose a sensible default, build it, and record it in `ASSUMPTIONS.md`.
- **Do not invent facts.** Program IDs, chain IDs, mint addresses, SDK method names and library versions must come from official documentation or the package itself. If you cannot verify something, say so in `ASSUMPTIONS.md`. Use the latest stable version of each dependency, pin it, and list it in `VERSIONS.md`.
- **Parity is a hard requirement.** Both stacks must produce identical balances, to the base unit, for every shared test vector. Write the reference math once in TypeScript (`bigint`), generate expected results from it, and make both stacks match.
- **Build in the order given in Part E.** Finish and test each milestone before starting the next. After each milestone, write a short summary: what was built, what was assumed, what is open.
- **No backdoors.** No admin function may seize issuer funds, change a live series' terms, block an issuer's redemption, or weaken the Autonomy Charter. See the role limits in Part C.
- **Security first.** Checked arithmetic, checks-effects-interactions, pull payments, reentrancy guards on EVM, strict account validation on Solana (owner, PDA seeds, signer, mint and token-program checks).

---

## Part B — Product Requirements (complete, consolidated v1.0)

This is the full PRD as of 7 October 2026, with every later decision already applied. Where an older document disagrees with this file, this file wins.

### B1. Summary

Merces lets people raise capital against a capped share of their future income, without forming a company. Backers get verified, capped cash flows. Issuers keep every life choice.

- **Name.** *Merces* is Latin for wages, pay or reward. *Mercery* is the mechanism: issue, verify, pay, redeem.
- **Thesis.** Venture capital says it backs founders but invests in companies, so the investor's upside ends with the first entity. Merces matches the instrument to the real bet: the person, across every career chapter.
- **Principle.** Contracts first, tokens second. A signed legal contract is the asset; the onchain unit represents it. If the two disagree, the contract governs.
- **Ethical keystone.** No payment below the threshold, no control over life choices, and a guaranteed way out.

### B2. Problem and opportunity

Capital can back companies but not people, so talented individuals must squeeze their lives into company-shaped containers to get funded.

- Investors' upside dies with the first entity, even when the founder's third company succeeds.
- Most high-potential people (engineers, artists, athletes, traders) never start a company, yet no instrument lets anyone invest in their trajectory.
- Earlier person-linked products failed on design: income share agreements drew backlash over terms, athlete tracking stocks wound down, and social tokens became reflexive speculation.
- The rails now exist: onchain treasuries, sealed-bid auctions and zkTLS income proofs.

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
- Futarchy-gated early draws ship as a switched-off hook; they run only when an issuer asks for an early or larger draw.
- Permissionless issuance is a non-goal. Issuers are invited and reviewed.
- Any feature that gives holders a say in an issuer's life choices is a non-goal in every phase.
- **Private payouts are not in this version.** They are listed as "coming soon". Payment amounts are public onchain in v1.

### B4. Users

| User | Need | What Merces gives them |
| --- | --- | --- |
| Issuer: artist or musician | Capital to make work without a label or gallery advance | A raise against future sales and royalties, repaid only above the threshold |
| Issuer: engineer | Money to relocate, study or take a risky role | A capped claim on salary, with no say for holders in career moves |
| Issuer: freelancer | Runway between clients or to build a practice | Payments that flex with revenue and stop below the threshold |
| Issuer: founder | Funding that survives a failed first startup | One claim across every company, salary and exit |
| Backer | Exposure to a person's trajectory across chapters | Capped, verified cash flows from a vetted cohort of issuers |
| Attestor (CA or CPA) | A clear scope and fee for verification work | Tier 3 reports to review and sign, plus hardship reviews, paid by the protocol |

Issuers are the primary user. Every trade-off favours them.

### B5. Core flows

**Issuer journey**

1. Apply and pass review, including identity and income-source checks.
2. Set terms: units offered, share rate, threshold, payout cap and release schedule.
3. Sign the HEU contract and the Autonomy Charter.
4. Connect income adapters: an onchain split, a zkTLS source, or an annual attestor.
5. Launch the raise; proceeds land in the issuer's onchain treasury.
6. Receive scheduled releases from the treasury.
7. Each quarter, submit a ProofOfIncome report; the payment goes to the payout vault.
8. Optionally pause for hardship, or redeem units at the formula price after the lockup.

**Backer journey**

1. Apply as a backer and pass eligibility checks.
2. Review the issuer's profile, terms and verification tier.
3. Place a sealed bid; all winning bids clear at one price, plus a 1% fee.
4. Hold units through the lockup, claiming pro rata payouts each quarter, net of a 5% fee.
5. See payout history and yield, never the issuer's income sources or personal data.
6. Receive the formula price if the issuer redeems; at the payout cap, the unit burns.

### B6. Functional requirements

Priority is build order (P0, then P1, then P2); all of them ship before the pilot. The **Stage** column says where each requirement is built. **S1** is this task. Where a requirement is mainly Stage 2 or 3, the note says what Stage 1 must still provide.

| ID | Component | Requirement | Pri | Stage and Stage 1 obligation |
| --- | --- | --- | --- | --- |
| R1 | Issuance | Invite-only issuer onboarding with identity and income-source review | P0 | S2. S1: issuer registry and wallet allowlist |
| R2 | Issuance | Term builder for units, share rate, threshold, payout cap, release schedule | P0 | S3. S1: terms registry with bounds and defaults |
| R3 | Issuance | HEU contract and Autonomy Charter signed before any raise opens | P0 | S2. S1: contract hash anchored in each series; a raise cannot open without it |
| R4 | Auction | Sealed-bid auction clearing all winning bids at one price | P0 | **S1** |
| R5 | Auction | Minimum raise per issuer, full refunds if not met | P0 | **S1** |
| R6 | Treasury | Onchain USDC or USDG treasury releasing funds on a fixed schedule | P0 | **S1** |
| R7 | Treasury | Futarchy check only for early or larger draws the issuer requests | P2 | **S1**: approver hook, switched off |
| R8 | ProofOfIncome | Tier 1 adapter: onchain split routing the HEU share automatically | P0 | **S1** |
| R9 | ProofOfIncome | Tier 2 adapters: zkTLS proofs from Stripe, Deel and DistroKid (via Reclaim) | P0 | S2. S1: verifier accepts attested reports |
| R10 | ProofOfIncome | Tier 3 attestor portal for annual sign-off | P1 | S2/S3. S1: attestor key registry |
| R11 | ProofOfIncome | zk circuit proving the payment owed without revealing total income | P0 | **S1**: reference circuit and onchain verifier |
| R12 | ProofOfIncome | Tier 4 self-attestation with random audits | P2 | **S1**: supported but disabled by flag |
| R13 | Payouts | Pro rata payouts to holders each period | P0 | **S1** |
| R14 | Exit | Per-unit payout tracking with automatic burn at the cap | P0 | **S1** |
| R15 | Exit | Issuer redemption at the formula price after lockup, with the tail clause | P1 | **S1** |
| R16 | Exit | Hardship pause approved by a private attestor review | P1 | **S1**: onchain state; review is S2 |
| R17 | Market | Transfer limits: no transfers in lockup, approved wallets only (Token-2022 hook on Solana, ERC-3643 on Monad) | P0 | **S1** |
| R18 | Market | Per-wallet holding cap per issuer (10% of a series) | P0 | **S1** |
| R19 | Market | Quarterly sealed-bid transfer auctions after income reports | P2 | **S1**: built, closed until lockup ends |
| R20 | Backer app | Dashboard showing payout history and yield only | P0 | S3 |
| R21 | Chains | Issuer picks launch chain and settlement stablecoin at issuance; locked once the raise opens | P0 | **S1** |
| R22 | Chains | Solana programs and EVM contracts live together, on Solana and Monad | P0 | **S1** |
| R23 | Chains | EVM redeployments to Ethereum, Arbitrum, Base, Robinhood Chain with identical rules | P1 | Later. S1: no chain-specific code |
| R24 | Chains | Cross-chain funding through CCTP (USDC) and USDG0 (USDG) | P2 | Later |
| R25 | Backer app | One app listing issuers across every chain | P1 | S3. S1: consistent events on both chains |
| R26 | ProofOfIncome | Tier 3 prefill from tax returns and accounting software | P1 | S2 |
| R27 | Issuance | Private readiness report for applicants | P2 | S2/S3 |
| R28 | Privacy | Holder-only payment amounts and private payouts | — | **Coming soon, not in v1.** S1: terms commitment (see C4) and a clean seam in the payout vault |
| R29–R32 | Surfaces | Landing page with Arena, issuer profile and auction page, issuer dashboard, separate applications | P0 | S3 |
| R33 | Fees | Backers pay 1% of cleared bids and 5% of payouts; issuers pay nothing; caps count gross payouts | P0 | **S1** |
| R34 | Issuance | Threshold floor at local median full-time income, indexed yearly; defaults of 2.5× cap, 8% hurdle, k = 5, 18-month lockup | P0 | **S1**: defaults and bounds. Floor data is S2 |
| R35 | Raise style | Meteora bonding curve (DBC to DAMM v2) as an optional raise style on Solana, sealed bids as default | P0 | **S1**: Solana devnet (see D10) |

### B7. Non-functional requirements

- **Privacy.** Income sources, income below the threshold and hardship reasons never go onchain. In v1, payment amounts are public onchain, so each series stores only a **commitment** to its threshold and share rate; the plaintext goes to eligible backers offchain.
- **Security.** Treasury, payout and burn code is audited on each stack before launch. Upgrades to money-handling code need a multisig and a time delay.
- **Enforceability.** Every series maps to a signed offchain contract by hash.
- **Compliance.** Only allowlisted wallets may bid, hold (sealed-bid series) or claim. Public copy describes Merces as software and a protocol, not a lender or broker.
- **Immutability of the charter.** No upgrade path can weaken Autonomy Charter terms; only issuer-favourable amendments are possible. Charter, caps and transfer rules behave identically on every chain.
- **Auditability.** Every payment, release, burn and redemption emits an event traceable to a period's report.

### B8. Decisions in force

| Topic | Decision |
| --- | --- |
| Sequencing | Complete software ships before the pilot |
| Pilot cohort | 12 invited issuers: three per persona, six on Solana, six on Monad |
| Unit defaults | Payout cap 2.5× issue price (issuer may pick 2.0–3.0×); hurdle 8% a year; payout multiple k = 5; lockup 18 months |
| Threshold | Set by each issuer, never below local median full-time income, raised with inflation yearly |
| Tier 2 sources | Stripe, Deel, DistroKid, through Reclaim Protocol (TLSNotary as open-source fallback) |
| Fees | Backers pay 1% of cleared bids and 5% of each payout. Issuers pay nothing. Caps count gross payouts |
| Launch chains | Solana and Monad together |
| Stablecoins | Solana: USDC and USDG. Monad: USDC only. (Later: Ethereum and Arbitrum USDC and USDG; Base USDC; Robinhood Chain USDG) |
| Sealed bids | Commit-reveal on both chains |
| Reporting period | Quarterly |
| Proof system | One zk system for both chains; Groth16 over BN254 is the candidate. Confirm verification cost on each chain |
| Private payouts | Not in v1; coming soon |
| Currency conversion | Quarter-average rate from Pyth FX feeds; Chainlink as cross-check; attestor-signed central-bank rate where no feed exists |
| Paying in | Due 30 days after quarter end; 15 days grace; then 8% yearly accrual and release pause; formal notice at 90 days; nothing slashed |
| Unit token on Monad | ERC-3643 using the open-source T-REX contracts, deployed by Merces |
| Raise style on Solana | Sealed bids by default; Meteora curve optional in this version |
| USDG on the Meteora curve | The curve quotes in USDC. USDG enters through a swap. A Meteora token badge for USDG is optional |

### B9. Success metrics (for context)

On-time reporting rate; share of payments proven at tiers 1–2; payout accuracy under audit; share of auctions meeting the minimum raise; issuer satisfaction on autonomy and fairness; count of disputes and hardship pauses. Stage 1 must emit the events these metrics are computed from.

### B10. Release plan (for context)

Phase 0 foundations (legal wrapper, contract, charter). Phase 1 build and ship the complete software on Solana and Monad, with audits. Phase 2 closed pilot with 12 issuers. Phase 3 open market as lockups end, plus EVM redeployments. Each phase starts only when the gate before it is met.

### B11. Still open (do not block on these)

- Which jurisdictions the pilot can run in.
- Whether the unit defaults hold up when modelled against sample incomes. **Therefore every default must be a parameter, never a constant baked into logic.**
- The privacy layer for future private payouts.

---

## Part C — Mechanism specification

This is what the code must do. Follow it exactly. Where it says "parameter", make it configurable within the stated bounds.

### C1. Glossary

- **Issuer**: the person raising. **Backer / holder**: a wallet holding units.
- **Series**: one raise by one issuer. **One token per series.** An issuer may have several series over time.
- **Unit (HEU)**: one indivisible token of a sealed-bid series (0 decimals).
- **Covered income**: employment income, consulting or freelance revenue, equity exit proceeds, dividends, IP and content royalties. Excluded: gifts, inheritance, spousal income, unrealised gains.
- **Threshold (θ)**: annual income below which nothing is owed.
- **Rate per unit (r)**: the fraction of participation income each unit is entitled to. A series offering N units at total share rate s has r = s / N.
- **Period**: a calendar quarter (UTC). **Reporting year**: the calendar year unless the series says otherwise.
- **Issue price (P0)**: the auction's clearing price per unit, in stablecoin base units.
- **Gross payment**: what the issuer pays into the vault. **Net payout**: gross minus the 5% backer fee.

### C2. Number conventions (identical on both stacks)

- Money is in stablecoin base units (USDC and USDG both use 6 decimals; verify from the mint, never assume).
- Ratios use 1e18 fixed point (WAD). On Solana use `u128` intermediates.
- **Rounding always favours the issuer when computing what the issuer owes, and never lets holders be paid more than the vault holds.** Division rounds down. Dust stays in the vault and rolls into the next period.

### C3. Payment formula (year-to-date method)

Nothing is owed until year-to-date income clears the full annual threshold.

```
owed_YTD(q)   = r × units_outstanding × max(0, income_YTD(q) − θ)     // in income currency
payment(q)    = owed_YTD(q) − owed_YTD(q−1)                           // income currency
payment_usd(q) = payment(q) × fx_avg(q)                               // stablecoin base units
```

- `fx_avg(q)` is the quarter-average rate from the rate accumulator (C9). For income already in USD stablecoins it is 1.
- A zero payment is a valid, complete report. No function may penalise low or zero income.
- The payment is computed offchain inside the zk circuit (D6). Onchain code never sees income or θ.

### C4. Terms and the terms commitment

Each series stores, immutably once the raise opens:

- issuer, chain-local stablecoin mint, units offered N, reserve price, minimum raise, cap multiple m (bounds 2.0–3.0, default 2.5), lockup (default 18 months), release schedule, fee rates (1% and 5%, fixed for the life of the series), hash of the signed legal contract, verification tier flags.
- **`terms_commitment`** = hash(θ, r, reporting currency, indexing rule, salt). θ and r are **not** stored in plaintext. Every ProofOfIncome proof takes `terms_commitment` as a public input.

The commitment may be replaced only by `amend_terms`, which requires the issuer's signature **and** a registered attestor's signature stating the change is issuer-favourable (the yearly inflation increase of θ uses this path). The cap multiple may only ever decrease.

### C5. Fees

- **Auction fee**: 1% of the cleared amount, paid by winning bidders on top of the clearing price.
- **Payout fee**: 5% of each gross payment, taken when the payment enters the vault.
- Issuers pay no fee of any kind. Failed auctions charge no fee.
- Fees go to a fee collector account controlled by the protocol multisig.

### C6. Cap accounting

- Per-unit cap `C = m × P0`. Caps count **gross** payments, so fees never lengthen an issuer's obligation.
- Each series keeps one accumulator `paid_per_unit` (gross, WAD-scaled).
- When a gross payment G arrives with N units outstanding: `inc = G / N`.
  - If `paid_per_unit + inc < C`: accept all of G.
  - Otherwise accept only `G' = (C − paid_per_unit) × N`, refund `G − G'` to the issuer, set the series to **Retired**, and make all units burnable by the protocol. Holders claim their final payout; units are burned on claim or by a permissionless crank.
- Holders claim with the standard "reward per share" pattern against a net accumulator. A holder can never claim more than their share, and total claims can never exceed vault balance.
- **Invariant:** for every unit, lifetime gross payments + redemption price + tail payouts ≤ C.

### C7. Redemption (after lockup)

The issuer may buy back a whole series at the formula price per unit:

```
P_redeem = min( C_remaining , max( P_hurdle , k × D_avg ) )

C_remaining = C − paid_per_unit
P_hurdle    = P0 × (1 + h)^floor(t) × (1 + h × frac(t))     // t = years since auction settlement
D_avg       = average annual gross payment per unit over the trailing 3 years
              (if less than 3 years of history, average over full years elapsed;
               if less than 1 full year, omit this term)
```

- Defaults: h = 8%, k = 5. Both are parameters fixed per series at creation.
- The issuer deposits `P_redeem × units_outstanding`; holders claim; units burn. **No fee is charged on redemption.**
- Redemption is never blockable by an admin, a holder or an attestor.
- Partial redemption (a pro rata fraction of every holder's units) is a stretch goal. Full-series redemption is required.

**Tail clause.** For 12 months after a redemption, if the issuer reports a covered liquidity event (an exit or large contract, flagged in the report), holders at redemption receive what they would have been paid. Record each holder's redeemed units at redemption time. Tail payouts per unit are capped at `C_remaining − P_redeem` as measured at redemption. If `P_redeem` equalled `C_remaining`, no tail is due.

### C8. Paying in, lateness and pauses

For tier 2 and tier 3 income:

1. The report and payment for a quarter are due **30 days** after the quarter ends.
2. A **15-day grace period** follows with no charge.
3. After grace, a late amount accrues at the series hurdle rate (simple interest, `payment × h × days_late / 365`), added to the gross payment, and **treasury releases pause** until the issuer is current. A permissionless crank sets the Late status once the deadline passes with no accepted report.
4. At 90 days late the program emits a `FormalNoticeDue` event. Nothing is slashed, seized or burned.
5. **Hardship pause**: the issuer requests; a registered attestor approves with an end date. While paused, deadlines and accrual stop. Payments for paused periods are deferred, not forgiven. Holders see only the status.
6. Tier 3 issuers pay quarterly on their own estimate and true up within 60 days of the annual attestation. Overpayments are credited to the next period; underpayments are due without accrual if paid inside the true-up window.
7. Public statuses: `OnTime`, `InGrace`, `Late`, `Paused`, `Retired`, `Redeemed`, `Extinguished`.

### C9. Currency conversion: the rate accumulator

- One accumulator per currency pair, on each chain.
- Once per UTC day a permissionless keeper submits a Pyth price update. The contract checks staleness and confidence, then adds the rate to a running sum and increments a day count. One snapshot per day per feed.
- `fx_avg(q) = (sum_end − sum_start) / (count_end − count_start)`.
- If fewer than 80% of the quarter's days have snapshots (parameter), or Pyth deviates from a configured Chainlink feed by more than a band (parameter, to be set by Kunal), the pair is marked `NeedsFallback` for that quarter, and the report must carry an attestor-signed rate instead.
- Verify from Pyth's own documentation which feeds exist and that Pyth is deployed on Monad before relying on it.

### C10. Market rules (sealed-bid series)

- **Allowlist.** Only approved wallets can bid, hold, receive or claim.
- **Lockup.** No transfers for 18 months (parameter) from auction settlement.
- **Window-only transfers.** After lockup, units move only through the Transfer Window module (D9). Direct wallet-to-wallet transfers always fail. Burns, redemption and protocol retirement are always allowed.
- **Wallet cap.** No wallet may hold more than 10% (parameter) of a series' outstanding units. Enforced at auction settlement and on every transfer.
- **No lending, no AMMs, no shorting.** The transfer rules must make these impossible for sealed-bid series.
- Removing a wallet from the allowlist must never strand value: it can still claim payouts, receive redemption proceeds and sell in a transfer window.

### C11. The Autonomy Charter, as code invariants

Write a test for each.

1. Capital releases follow the fixed schedule with no approval from anyone. The only things that pause releases are the Late status and the issuer's own request.
2. Onchain data about an issuer is limited to: series parameters, the terms commitment, payment amounts, statuses and events. No health, location, relationship or career data, ever.
3. No work obligation: no function can force a payment, and no penalty exists for reporting zero.
4. Units carry no vote. No function whose outcome affects an issuer is gated on holder votes or holder signatures.
5. The issuer can stop new issuance at any time. Existing series end only through cap, redemption or extinguishment.
6. **Extinguishment**: on death or permanent disability, confirmed by two registered attestors, all claims end. Unreleased treasury funds are returned to holders pro rata; nothing else is owed. (The treatment of unreleased funds is an assumption for counsel; record it.)
7. Charter-relevant fields have no upgrade path. Only issuer-favourable amendments exist (C4).

### C12. Roles and their hard limits

| Role | Can | Can never |
| --- | --- | --- |
| Protocol admin (multisig + timelock) | Register attestors and report-verifier keys; manage the fee collector; pause **new** raises; upgrade money-handling code after the delay | Touch a live series' terms; move treasury or vault funds; block redemption, claims or releases; change fees on an existing series |
| Allowlist manager | Add or remove wallet eligibility | Freeze or seize units; block claims |
| Attestor | Sign tier 3 reports, favourable amendments, hardship pauses, fallback FX rates, extinguishment (two needed) | Set payment amounts unilaterally for tiers 1–2; move funds |
| Keeper | Anything permissionless: cranks, snapshots, status updates | Anything else |
| Issuer | Open and cancel their own raise before bids; draw released funds; report; pay; pause request; redeem | Change a live series' terms, except through the favourable-amendment path in C4 |

---

## Part D — Stage 1 modules

Build each module on both stacks unless marked Solana-only. For every module deliver: state layout, instructions or functions, events, access control, invariants, tests.

### D1. Charter and terms registry
Creates issuers and series, stores the fields in C4, enforces bounds and defaults, anchors the legal-contract hash, and exposes read interfaces to every other module. A raise cannot open unless the contract hash is set and the issuer wallet is allowlisted. Charter fields are immutable.

### D2. Unit token
- **Solana:** one Token-2022 mint per series, 0 decimals, with **TransferHook** (the Merces hook program enforcing C10), **PermanentDelegate** (a program PDA, used only to burn at cap, redemption and extinguishment), and metadata. Mint authority belongs to the auction program and is revoked after settlement. Consider `DefaultAccountState = Frozen` with thaw-on-allowlist as defence in depth.
- **Monad:** an ERC-3643 token from the T-REX suite (token, identity registry, trusted issuers registry, claim topics registry, modular compliance). Write Merces compliance modules for lockup, window-only transfers and the wallet cap. The payout vault and redemption contracts hold the agent role needed to burn. **Check T-REX's licence before depending on it and report it to Kunal**; it may be copyleft. Charter fields live in the D1 contract, not in the upgradeable token.

### D3. Auction (sealed-bid, uniform price)
- Phases: `Commit` → `Reveal` → `Settle`. Durations are per-series parameters.
- **Commit:** an allowlisted bidder escrows stablecoin and submits `hash(price, quantity, salt, bidder)`. The escrow must cover `price × quantity × 1.01`; over-collateralising is allowed so the deposit does not reveal the bid.
- **Reveal:** bidder reveals; bids below the reserve price or above the wallet cap are rejected and refunded.
- **Settle:** winning bids are the highest prices until units run out. **Every winner pays the same clearing price**: the lowest winning bid. Ties at the margin fill pro rata, rounded down. Winners pay clearing price × quantity + 1% fee; all excess escrow is refunded.
- Settlement must be verifiable onchain within compute limits. A cranker may propose the clearing price; the program checks it against the revealed bids in pages. Document the maximum number of bids supported.
- If cleared proceeds are below the minimum raise, the auction fails: full refunds, no fee, no units.
- Only the units actually sold are minted. The series' effective share rate is `r × units_sold`.
- **Unrevealed bids:** refunded after settlement minus a non-reveal charge equal to 1% of the escrow (parameter). This deters selective reveals. Flag it in `ASSUMPTIONS.md` for Kunal to confirm.
- Proceeds go straight to the series treasury (D4); the fee goes to the fee collector.

### D4. Treasury
Holds a series' proceeds in its stablecoin. Releases follow the immutable schedule (a list of timestamps and amounts, or linear vesting); the issuer pulls what has vested. Releases pause only under C8 or at the issuer's request. Include an **early-draw hook**: a request that succeeds only if an external approver address returns approval. The approver is unset by default, so early draws are off. Do not build the futarchy market itself.

On Solana the treasury and vault must handle **both** token programs: USDC is a classic SPL token; USDG is Token-2022 with extra extensions (including a transfer hook and a transfer-fee config currently at zero). Use `transfer_checked`, pass the correct token program, resolve any transfer-hook accounts, and **assert the transfer fee is zero**, failing safely otherwise.

### D5. Tier 1 split router
A receiving account or contract per issuer for income that arrives onchain. Tracks year-to-date receipts. Receipts up to the annual threshold pass through 100% to the issuer; above it, `r × units_outstanding` of each receipt goes to the payout vault and the rest to the issuer. Tier 1 issuers accept that this stream's terms are public. Amounts routed are credited against the quarter's reported payment; the quarterly report reconciles any shortfall or excess (excess is credited forward).

### D6. ProofOfIncome verifier
- Accepts one report per series per quarter: `{series, period, payment_usd, fx_avg or fallback rate, terms_commitment, income_commitment, tier, liquidity_event flag, proof, attestations}`.
- Verifies a **Groth16 proof** that `payment_usd` follows from C3 given private inputs (income, θ, r, salt) and public inputs (`terms_commitment`, `units_outstanding`, `fx_avg`, prior YTD commitment, `income_commitment`).
- Verifies an **attestation** binding `income_commitment` to a real source: a signature from a registered report-verifier key for tier 2 (the Stage 2 service checks the Reclaim proof offchain and signs the commitment, because verifying the raw zkTLS proof onchain would publish the income), or a registered attestor key for tier 3. Tier 4 uses the issuer's own signature and is disabled by flag.
- On success: records the report, updates the status machine (C8), and tells the payout vault how much is due.
- Deliver a **reference circuit** (circom or equivalent) and a development-only trusted setup, clearly marked as not for production.
- Solana verification should use the chain's native BN254 support; EVM uses the precompiles. Measure and report cost on both.

### D7. Payout vault
Receives gross payments (from the issuer or the split router), takes the 5% fee, updates the accumulators (C6), handles cap truncation and refunds, lets allowlisted holders claim, and burns units at retirement. Keep the claim path isolated behind an interface so a private-payout implementation can replace it later without touching accounting.

### D8. Redemption, tail and pause
Implements C7 and the hardship pause and extinguishment in C8 and C11.

### D9. Transfer window
A quarterly call auction per series, open only after the lockup and only after that quarter's report is accepted. Sellers escrow units with sealed asks; buyers escrow stablecoin with sealed bids; one clearing price maximises matched volume; the module is the only path through which units change hands (C10). Ships closed.

### D10. Meteora raise style (Solana only, devnet)
An optional alternative to D3 for issuers who choose it. Read Meteora's DBC documentation before writing any code:

- https://docs.meteora.ag/developer-guides/dbc
- https://docs.meteora.ag/core-products/dbc/token-2022-support
- https://docs.meteora.ag/core-products/dbc/launch-configurations
- https://docs.meteora.ag/core-products/dbc/migration-and-liquidity
- SDK: https://github.com/MeteoraAg/dynamic-bonding-curve-sdk

Mapping: series unit = DBC base token; Merces = partner (owns configs, takes the partner fee share); issuer = creator (creator fee share may be zero); raise target = migration threshold; bonding phase = primary raise; DAMM v2 pool after graduation = secondary market.

Build:
1. **Oracle-driven config generator** (TypeScript): turns an issuer's attested trailing income into a DBC config. Start price and maximum raise are anchored to verified earnings, with the maximum raise capped at a multiple of trailing annual income (parameter; ask Kunal for the default).
2. **Curve-mode series** in the registry, with the differences below.
3. **Graduation to DAMM v2**, demonstrated end to end with a test issuer on devnet using the manual migrator.

Curve-mode series behave differently, and the code and docs must say so plainly:
- DBC creates the base mint itself and revokes the transfer hook at graduation, so **after graduation anyone can hold and trade units**. There is no lockup, wallet cap or forced burn.
- Therefore **gate claims, not transfers**: only allowlisted wallets can claim payouts.
- At the cap, claims simply end and the series is Retired. Redemption works by tender: holders deposit units to receive the formula price.
- The curve **quotes in USDC**. Do not use USDG as the quote token; it would need a Meteora token badge. USDG pay-in via swap is a Stage 3 concern.
- The issuer accepts a live public price. This is the issuer's explicit choice and must be recorded in the series.

**Verify and report before building:** in a bonding curve, buyers' quote tokens fund pool liquidity; they are not paid to the creator by default. Work out, from Meteora's docs, how much capital actually reaches the issuer's Merces treasury (for example through the migration fee, the creator's liquidity share or an issuer-held allocation), and present the options and numbers to Kunal. Do not assume the migration threshold equals the issuer's proceeds.

### D11. Supporting pieces
- **Rate accumulator** (C9).
- **Registries**: allowlist, attestors, report-verifier keys.
- **Fee collector.**
- **Governance**: multisig and timelock wiring for upgrades to money-handling code; no upgrade authority over D1.

---

## Part E — Build order and milestones

| # | Milestone | Contents |
| --- | --- | --- |
| M0 | Foundations | Monorepo, toolchains, CI, the TypeScript reference math library, the parity vector format, mock stablecoins (a classic SPL "USDC" and a Token-2022 "USDG" with the same extension set as the real one; an ERC-20 "USDC" on EVM) |
| M1 | Charter, terms, unit token | D1, D2, registries |
| M2 | Raise path | D3, D4, fee collector |
| M3 | Repayment path | D6 with reference circuit, D7, D5, rate accumulator |
| M4 | Exit path | D8, D9 |
| M5 | Meteora raise style | D10 on Solana devnet |
| M6 | Parity and deployment | All vectors green on local, Solana devnet and Monad testnet; deployment scripts; documentation |

**Hackathon fast path.** If Kunal says "hackathon first", build a thin slice in this order instead: D1 (issuer and series registry only), D6 (attestation path, proof stubbed behind the same interface), D7, then D10. Then return to the normal order. Do not cut tests on D7.

Suggested stack, to confirm against current docs: Anchor and Rust for Solana, with fast local tests (LiteSVM or bankrun) plus devnet runs; Foundry for Solidity with fuzz and invariant tests; circom and snarkjs for the reference circuit; a TypeScript workspace for the reference math, vectors, scripts and the Meteora generator. Read Monad's developer docs (https://docs.monad.xyz) for any execution or gas-accounting differences from Ethereum before deploying.

---

## Part F — Testing and acceptance

### F1. Shared parity vectors
JSON scenarios with exact inputs and expected balances. Both stacks must match the reference implementation to the base unit. At minimum:

1. Happy path: raise, four quarterly payments, claims.
2. Failed auction: below minimum raise, full refunds, no fee.
3. Auction edge cases: tie at the margin, over-collateralised bids, unrevealed bid, bid above wallet cap.
4. Zero-payment quarters: income below threshold all year, then crossing it mid-year (checks the YTD method).
5. Cap hit: truncated final payment, refund to issuer, retirement and burn.
6. Redemption where each of the three terms decides the price: remaining cap, hurdle, payout multiple.
7. Late payment: grace, accrual, release pause, recovery.
8. Hardship pause across a deadline.
9. Tail clause payout after redemption, including the no-tail case.
10. Transfer window clearing, wallet-cap and lockup rejections.
11. Extinguishment with unreleased treasury funds.
12. Multi-series issuer and tier 1 split reconciliation.
13. FX: normal quarter, low-coverage fallback, deviation fallback.
14. Favourable amendment accepted; unfavourable amendment rejected.

### F2. Invariants (fuzz and property tests on both stacks)
- No unit ever receives more than its cap, counting payments, redemption and tail.
- Total claims never exceed vault balance; total refunds plus proceeds plus fees equal total escrow.
- No fee is ever taken from an issuer.
- Charter fields never change after a raise opens.
- No path lets an admin move treasury or vault funds.
- Sealed-bid units never move outside D9, burns and redemption.
- Every Autonomy Charter rule in C11 has a dedicated test.

### F3. Done when
All vectors and invariants pass locally, on Solana devnet and on Monad testnet; deployment is scripted and reproducible; the documents in Part G exist and are accurate.

---

## Part G — Deliverables

- Source for both stacks, the reference circuit, the reference math library, vectors and scripts.
- `README.md`: how to build, test and deploy to devnet and testnet.
- `ARCHITECTURE.md`: module diagrams, state layouts, the status machine, the differences between sealed-bid and curve-mode series.
- `EVENTS.md`: every event on both chains with field meanings, written for the Stage 2 indexer. Equivalent events must carry equivalent fields on both chains.
- `INTERFACES.md`, plus exported IDLs and ABIs.
- `ASSUMPTIONS.md`: every default you chose and everything you could not verify.
- `VERSIONS.md`: pinned toolchain and dependency versions.
- `AUDIT_NOTES.md`: trust assumptions, privileged roles, known limitations, the compute and gas measurements, and anything an auditor should look at first.
- `PARITY_REPORT.md`: vector-by-vector results on each network.

---

## Part H — Questions to raise with Kunal

Ask these early. Use the stated default if no answer comes, and record it.

1. Non-reveal charge in the auction: 1% of escrow (default), or full refund?
2. Deviation band between Pyth and Chainlink before falling back (no default; propose one with reasoning).
3. Meteora: the maximum-raise multiple of trailing income, and which route carries proceeds to the issuer.
4. Extinguishment: unreleased treasury funds returned to holders pro rata (default). Counsel should confirm.
5. T-REX licence: acceptable for this repository?
6. Should partial redemption be built now or left as a stretch goal (default: stretch)?
7. Auction, reveal and transfer-window durations (propose defaults).
8. Is "hackathon first" in effect, and what is the submission deadline?

---

## Operator instructions for this build (7 October 2026)

- Skip booking or performing external security audits. Do a hard internal security review instead.
- Run fuzz tests, invariant tests and every other kind of test.
- Target Solana devnet and Monad testnet only. Nothing goes further until Kunal says proceed.
- Everything must be production grade.
