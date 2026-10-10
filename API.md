# API.md

The contract is `packages/api/openapi.yaml` (OpenAPI 3.1, assembled from `packages/api/src/openapi/openapi.yaml` plus one
fragment per service module; `pnpm openapi:build`). A typed client is generated from it (`@merces/client`). This file
explains how to use the API; the spec is the source of truth for shapes.

## Conventions

- Base URL `http://localhost:3000` in development. JSON in and out. Errors are `{ error, message, detail }` with HTTP
  400 (validation), 401 (no session), 403 (wrong tier), 404, 409 (state), 422 (rejected by rule or by the chain), 501
  (live adapter not ready).
- **Money** is a decimal string in stablecoin base units (6 decimals); ratios are decimal strings in 1e18 fixed point;
  timestamps are unix seconds; periods are `YYYYQn`. Ids are chain-neutral: `seriesId = "<chain>:<address>"`.
- **Chain neutrality**: no endpoint needs the client to know which chain a series is on. `GET /chains` lists chains,
  modes and stablecoins for the issuer's one-time choice; after that the id carries it.
- **Sessions**: `POST /auth/nonce` → sign the message with the wallet → `POST /auth/verify` → `Authorization: Bearer
  <token>`. One account links a Solana and an EVM wallet (`POST /me/wallets/link`). Roles and eligibility are inside the
  token; refresh with `POST /me/session/refresh` after review decisions.
- **Access tiers** (`x-access` on every operation): `public`, `account` (signed in), `backer` (passed eligibility),
  `holder` (holds or held units of that series), `issuer` (the series' issuer), `attestor` (a wallet registered
  onchain and indexed; a proposal alone gets 403 "pending"), `admin`, and the
  combinations `holder-or-issuer`, `issuer-or-attestor`.
- **Writes** accept an `Idempotency-Key` header, scoped to your account; the same key with the same body replays the
  stored response, a different body is a 409, and a repeat while the first request is still running is a 409 (retry later).
- **Transactions**: the backend never signs for a user. Builders return `{ tx: UnsignedTx }` (`chain`, `family`, `signer`,
  `coSigners`, `command`, `payload`, `encoding`, `expiresAt`; since S3 `commands` when one transaction runs several
  commands in order, all or nothing, as the curve unstake does, `command` being the first). The wallet signs; `POST
  /tx/send` relays `{ tx, signatures }` and returns the canonical events the transaction emitted.
- **Mock mode** adds `/dev/time`, `/dev/advance-time`, `/dev/faucet`, `/dev/esign/complete` so Stage 3 can drive the whole
  lifecycle without waiting for quarters to pass.

## Flows

**Issuer**: apply (`POST /applications`, `…/identity/start`, `…/submit`; admin decides) → create a draft (`POST /drafts`)
→ set terms (`PUT /drafts/{id}/terms`; `POST /terms/validate` to dry-run) → sign the contract and charter
(`POST /drafts/{id}/contract/prepare`, then the provider's signing URL; `GET /drafts/{id}/contract`) → build and send
`createSeries` (`POST /drafts/{id}/build-create-series`, `POST /tx/send`, `POST /drafts/{id}/link-created`) → open the
raise (`POST /series/{id}/raise/build-open`: Stage 1's `open_raise`; the chain sets the commit end to now + the series'
commit duration and the reveal end after its reveal duration; 409 with `detail.stage1` RaiseNotDraft, ContractHashMissing,
NotAllowlisted or NewRaisesPaused) or cancel it while it has no bid (`POST /series/{id}/raise/build-cancel`, at any time,
also after the reveal end; 409 RaiseNotOpen or BidsExist) → draw treasury (`POST /series/{id}/treasury/build-draw`) → each quarter: `GET
/series/{id}/reporting/schedule`, `POST …/reporting/zktls-session`, the device proves and gets an attestation from the
report verifier (`GET /reporting/verifier`), `POST /series/{id}/reports` (returns the `submitReport` tx), `POST
/reports/{id}/build-payin` (the exact remaining due: a late period accrues per day, so a pay-in built on one day of
lateness is refused onchain after the next day boundary; rebuild it). On a curve series a regular report proves over the
curve's census (S3 WP9, A-CURVE-5): assembling (and opening or signing a tier-3 case) is 409 `detail.stage1`
CurveUnitsNotSynced while the last census predates the period's end, with the sync step in `detail.next` (the schedule
shows `nextStep: sync-curve-units`); a proof over another count is 409 `detail.reason` `census-changed` (prove again);
`POST /reports/{id}/build-submit` is 409 `census-changed` (`next: re-assemble`) when a census moved the count since the
report was assembled → hardship (`POST /series/{id}/hardship`) or redemption (`GET /series/{id}/redemption/quote`,
`POST …/redemption/build-redeem`).

**Backer**: apply → `GET /arena`, `GET /series/{id}`, `GET /series/{id}/terms` (eligible backers only, logged) →
`POST /series/{id}/bids/precheck` → compute the commitment client-side (or `POST …/bids/commitment`) → `POST
…/bids/build-commit` → keep an encrypted backup (`PUT …/bids/backup`) → reveal (`POST …/bids/build-reveal`) → after the
reveal end the keepers settle the raise in Stage 1's steps and then push every bid's refund and units (`deliverBid`): there
is nothing to claim. "Deliver now": `POST …/bids/build-deliver {bidder, signer?}` builds Stage 1's `deliver_bid` for a
processed, undelivered bid (`signer` defaults to the bidder and must be one of your wallets; any wallet may deliver any
bid, and the bidder is always the one paid; 409 `detail.stage1` NotProcessed or AlreadyDelivered) → `GET /me/holdings`,
`GET /series/{id}/payouts`, claims (below). Curve-mode trades (`POST /series/{id}/curve/build-swap {wallet, side,
amountIn, payIn?, slippageBps?}`, which replaced `build-buy` in S3 WP12) build a `curveSwap` (a Meteora DBC swap on a live
chain; the simulator's stand-in pool until S5) against the chain's quote (`ChainPort.quoteCurveSwap`) for any linked
wallet, 409 once the curve filled; the curve flow, staking included, is under **Curve staking** below. A curve
series is Open from its creation (its activation fixes P0); the keepers' `curve.lifecycle` job completes it once the
pool filled (`completeCurve`, settling at the pool's finish time) and collects its proceeds (`collectCurveProceeds`: the
partner migration fee into the treasury once, the partner trading fee to the fee collector at most weekly, kind
`curveTrading` in the fee ledger); the admin monitor (`POST /admin/curves/monitor`) triggers the same pass and answers
what it did with any failure as a code (`errors`). The keepers also take the census once after completion and once
after each period end (S3 WP11), and remind linked wallets holding unstaked units to stake and, after a redemption, to
tender (no amounts; RUNBOOK.md Keepers). The census (`syncCurveUnits`, permissionless): `POST
/series/{id}/curve/build-sync {signer}` builds it for one of your wallets, with what it would count now beside the count
stored last (`census`, `changes`); 409 RaiseNotOpen or TerminalStatus, and 409 `detail.reason` `report-pending` while the
issuer has assembled the report for the series' next expected period and not submitted it (its proof is over the current
census; amendment H1). `GET /series/{id}/curve` carries `onchain.census` (`CurveCensus`: supply, protocol-held, the count
a census would store now, the count `redeem`'s own census would take with the DAMM pool not subtracted, the stakes, the
last stored count and its time); the redemption quote on a curve counts `redeem`'s own census (`unitsCounted:
redemption-census`; a count of 0 blocks with NoUnitsOutstanding). Every sealed-bid builder refuses a curve series with 409 `detail.stage1`
NotSealedBid (open, cancel, commit, reveal, deliver, the settlement step, the preview); the redemption claim builder
refuses it with CurveUsesTender and the admin burn crank with CurveModeNoBurn. Every curve response carries the buyer
notice (`CURVE_BUYER_NOTICE` with the curve's figures read from the chain: the trading fee and its split among Merces,
Meteora and the issuer come from the pool's config, `CurveState.tradingFeeSplitBps`, never from the notice itself;
A-CURVE-8). **No cap:** a curve raise has no wallet cap at any stage, before or after the curve
fills; a wallet buys and holds any number of units. Every curve read and builder says so in one statement
(`walletCap: null`, `noCap: true`, `noCapStatement`, the schema `CurveNoCap`), and so do the series read (`noCap`,
`noCapStatement`; a curve series' `terms.walletCapBps` is Stage 1's 0, never a cap) and the transfer-window read. A curve
draft records no lockup, no wallet cap and no raise phases (Stage 1's zeros; `POST /terms/validate` reports any other
value per field, code `curve-zero`), a positive minimum raise (the curve's target) and USDC (S3). The auction preview counts every revealed bid, its bidder still allowlisted or not, as
Stage 1's settlement does (S2).
`GET /me/bids` shows the chain's figures (the `Bid` schema): `pendingRefund` (also `refundable`) and `pendingUnits` are
what a processed bid is still owed until it is delivered ("0" otherwise), with the bid's `deposit`, `revealed`, `valid`
(fixed at reveal: an invalid bid is refunded in full), `processed`, `delivered`, `allocatedUnits` and `nonRevealCharge`
(what a bid never revealed paid when the raise settled; "0" otherwise). The bid precheck returns the series'
`nonRevealChargeBps` and `nonRevealCharge`, what the deposit would pay if the bid were never revealed and the raise
settled. Each bid's figures come from one source, never a mix (`source`): the chain's read of the bid, or the indexed
row as a whole when the chain has no read of it (it may lag the chain by an indexer pass). `refunded`, the refund
delivered, is indexed (only the delivery event carries it): "0" while the bid is undelivered, and null while the chain
shows the bid delivered and the indexer has not projected the delivery yet.

**Claims** (S3: Stage 1's claim family). A holder has four claims, each a transaction it signs with its own wallet (no
one claims for another, A-CLM-3), each with a builder (holder tier, `{holder}` one of your wallets) and each figure apart
in the position (`GET /series/{id}/position`, the `PositionView` schema, and `/me/holdings`):

| Claim | Builder | Pays (the read) | Burns |
| --- | --- | --- | --- |
| `claimPayout` (Stage 1 `claim`) | `POST /series/{id}/payouts/build-claim` | the net payout, on every status (`claimable`; `pending` is the part already settled into the holder's balance) | on a Retired series the holder's balance (`burnsUnits`), even when it pays nothing |
| `claimRedemption` (`claim_redemption`) | `POST /series/{id}/redemption/build-claim` | after a redemption: the price on the units not yet redeemed and their tail catch-up (`redemptionClaimable`; `redemption`) and the pending payout (`claimable`; `payout`); `amount` is both | the redeemed units |
| `claimTail` (`claim_tail`) | `POST /series/{id}/tail/build-claim` | the tail since the holder's tail cursor on its redeemed units (`tailClaimable`; `amount`) | nothing of its own |
| `claimFinal` (`claim_final`) | `POST /series/{id}/final/build-claim` | after an extinguishment, once: the pending payout and the final-pool share (`claimable + finalClaimable`; `amount`) | the holder's balance |

- The tail and final builders return `{tx, amount, redeemsFirst, total, burnsUnits}`. A holder that still has units to
  redeem is redeemed first by the same transaction (`claimTail` when it has redeemed nothing; `claimFinal` on a series
  that redeemed): `redeemsFirst = {units, amount, payout}` is that redemption (the units it redeems and burns, the price
  and catch-up, and the pending payout it pays), and `claimFinal`'s `amount` is then the share alone. `total` is everything
  the transaction pays; `burnsUnits` every unit it burns.
- Refusals come before the wallet signs, in Stage 1's order, with the Stage 1 name in `detail.stage1`: the tail 409
  NotRedeemed (no redemption yet; an extinguished series that redeemed still pays its tail), HolderNotRegistered,
  NoRedeemedUnits (nothing redeemed and nothing to redeem); the final 409 TerminalStatus (not Extinguished),
  HolderNotRegistered; the redemption 409 NotRedeemed or no units to redeem.
- **The zero rule.** Onchain a claim of nothing succeeds and emits its own event with zeros (`PayoutClaimed{0, burned}`,
  `TailClaimed{0}`, `FinalClaimed{units, 0}`; Stage 1's zero-amount rule), and on a Retired series a payout claim of 0
  still burns. The builders do not build one: a claim that would pay 0 and burn nothing is 409 with `detail.reason`
  `nothing-to-claim` and `detail.claimWith`, the other claims that would pay the holder something now. A claim never
  makes a wallet a holder for the API (A-REV-10).
- Units of a Retired series also burn by the permissionless `burnRetired`, one holder per call, which the keepers send for
  every holder still holding units (the admin trigger `POST /series/{id}/retirement/crank-burn` does the same and returns
  `{burned, refused}`).
- A notice of a status change to Redeemed or Extinguished names the claims to send (`claimRedemption` and `claimTail`;
  `claimFinal`), never an amount.
- **On a curve series** (S3 WP10, A-CURVE-6) only staked units earn: the position's `units` are the holder's stake
  (`stakedUnits`), and `walletUnits` are the base lamports in its wallet, which earn nothing until staked (a wallet that
  bought and never registered reads `registered: false` with its `walletUnits`). A curve position row, and so holder
  access, comes from the first stake or a tender, never from buying or registering. Nothing burns on a claim
  (`burnsUnits` "0"). The redemption is a tender (`tenderUnits`, `POST /series/{id}/curve/build-tender`;
  `redemptionClaimable` previews what a tender of the stake and the wallet units within the quota pays), so
  the redemption claim builder is 409 CurveUsesTender; the tail builder redeems nothing (`redeemsFirst: null`): it is
  409 NoRedeemedUnits until the holder tendered, and `total` adds the pending payout the transaction also pays; the
  final builder's `amount` = `total` is the pending payout (on a series that did not redeem, the stake's final share is
  in it, so `finalClaimable` is 0 and `claimPayout` pays it too) plus the final share of the tendered units on a series
  that redeemed. Stage 1's unstake credits the stake's earnings to the pending payout and pays nothing; the unstake
  builder bundles the claim that pays it into the same transaction (below).

**Curve staking** (S3 WP12; Stage 1 curve mode; amendments M4 and M8 and the owner's directions of 2026-10-10). On a
curve series only staked units earn. Every route here is account tier with `wallet` one of your wallets (it signs): a
buyer has no position row, so no holder access, until it stakes. Unit counts are base lamports (10^6 to a whole unit);
prices are per whole unit. Refusals come before the wallet signs, in Stage 1's order, with the Stage 1 name in
`detail.stage1` (a short wallet: `detail.code` InsufficientFunds).

| Step | Route | What it returns |
| --- | --- | --- |
| Quote before a trade | `GET /series/{id}/curve/quote?wallet&side&amountIn&payIn?&slippageBps?` | the chain's quote, `minimumAmountOut`, `earns` (false, with a `warning`, for a wallet that is not approved: it can trade, never earn or tender) and, before a buy, `beforeYouBuy {version, statements}`: first "Unapproved wallets earn nothing and cannot tender.", then the buyer notice's points with the curve's figures; with `payIn` USDG the DEX quote (`swapQuote`) |
| Buy or sell | `POST /series/{id}/curve/build-swap {wallet, side, amountIn, payIn?, slippageBps?, acknowledged?, beforeYouBuyVersion?}` | the quote's figures and the unsigned `curveSwap` (`tx`), and with USDG the swap route to sign first (`swap`). A buy needs an eligible backer (403) and `acknowledged: true` with the current `beforeYouBuyVersion` (422 `detail.reason` `acknowledgement-required`, value-free, before anything is quoted or built; the version changes with any statement, a figure included). A sell needs neither: any linked wallet sells back the units it holds (USDC out only) |
| Where a wallet stands | `GET /series/{id}/curve/position?wallet?` | per linked wallet (all of them on the series' chain, or the one named): `approved`, `registered`, `walletUnits`, `stakedUnits`, `earning`, `pending`, `claimable`, `stakable` (what the stake builder can stake now, its steps included) or `stakeBlockedBy` (RaiseNotOpen, TerminalStatus, ZeroUnits, NotAllowlisted, StakeExceedsOutstanding), `censusHeldBy` (the issuer's assembled report holds the census), `stakeSteps`, `unstakable`, `tender` after a redemption (`fromStake`, `fromWallet` within `quotaLeft`, `principal`, `blockedBy` HolderNotRegistered) and `next` (approve-wallet, register-and-stake, stake, register-and-tender, tender, claim) |
| Stake | `POST /series/{id}/curve/build-stake {wallet, units}` | ordered `steps` to sign in turn: `registerHolder` when the wallet is not registered, `syncCurveUnits` when the last census cannot cover the stake and one now can, then `stakeUnits`; 409 RaiseNotOpen, TerminalStatus, ZeroUnits, 403 NotAllowlisted, 409 StakeExceedsOutstanding (`detail.stakable`; `detail.reason` `report-pending` while the issuer's assembled report holds the census, amendment H1: the builder never adds a census then), InsufficientFunds |
| Unstake (pays) | `POST /series/{id}/curve/build-unstake {wallet, units}` | ONE transaction, `[unstakeUnits, claimPayout]` (`tx.commands`), all or nothing: the unstake credits what the stake earned into `pending` (Stage 1's code moves no stablecoin) and the claim pays exactly that (`payout` at the current state). Never refused but ZeroUnits or InsufficientStake: no allowlist and no status check. A holder that unstakes through another tool keeps the credit as `pending`, claimable later |
| Tender | `POST /series/{id}/curve/build-tender {wallet, fromStake?, fromWallet?}` | after a redemption: `principal` = floor(P × units / 10^6), `payout` (the pending payout it also pays), `total`, `quotaLeft` and `quotaLeftAfter` (staked units are reserved; wallet units share what is left); 409 NotRedeemed, ZeroUnits, InsufficientStake, TenderQuotaExhausted, HolderNotRegistered, InsufficientFunds |
| Census | `POST /series/{id}/curve/build-sync {signer}` | as above |

`ChainPort.build` takes an ordered command list as one all-or-nothing transaction (`UnsignedTx.commands`; the
simulator runs it in one execution with one rollback, the Solana adapter packs the instructions in S5); an EVM chain
builds one command per transaction (NotImplemented for a list) until a bundle is needed there. Every per-unit read is
per whole unit at the series' unit scale (amendment M4): `/me/holdings` rows carry `unitScale` (and a curve row its
`stakedUnits` and `walletUnits`), `grossPaidPerUnit = floor(paidPerUnitWad × unitScale / 1e18)` and a cost basis of
`issuePrice × units / unitScale`; the retirement read's `paidPerUnit`, `capRemaining` (Stage 1's C_remaining at the unit
scale) and `capProgressBps`; the redemption read's tail `paidPerUnit`; the accounting statement's cap figures
(`unitScale`, `total = perUnit × unitsSold / unitScale`, `remainingTotal`, `progressBps`). The series read carries the
curve's `stakedTotal`, `tenderedTotal` and `unitsSyncedAt`.

**Registration.** Payouts accrue only to registered holders, from the registration on. A winning bid registers its
bidder when it is processed (and a window purchase its buyer), so a holder rarely needs to. `POST
/series/{id}/holders/build-register {wallet}` (account tier, `wallet` one of your wallets, which signs) builds Stage 1's
permissionless `register_holder`; an already registered wallet gets `{tx: null, alreadyRegistered: true}`, and a wallet
not on the chain's allowlist 403 with `detail.stage1` NotAllowlisted. Every claim needs the registration, never current
allowlist membership. A registration holds no units and opens no holder-tier route (A-REV-10).

**Settlement** (Stage 1 SPEC §5.2; every step is permissionless). After the reveal end a settlement runs in steps: the
honest proposal (`beginSettlement`), the tally pages (`tallyBids`), `finalizeSettlement` (Settled, or Failed with
NoValidBids or MinRaise; a raise that would sell no unit fails), a `processBid` per bid (the mint is final after the last:
payments, reports, releases, redemption, extinguishment and windows wait for it, `MintNotFinalized`), then a `deliverBid`
per bid. The keepers do all of it (a raise that drew no bid waits 24 hours past its reveal end, so its issuer can still
cancel it). Anyone can drive it instead: `POST /series/{id}/auction/build-step {signer}` returns `{stage, command, tx}`,
the next step built for one of your wallets; sign it, relay it with `POST /tx/send` and ask again. 409 when there is nothing
to build, with `detail = {stage, reason}`: `wait` (before the reveal end, with `until`), `done`, `curve`, or the
planner's stuck code (an operator matter). `GET /series/{id}/auction` is the chain's auction record (the `AuctionState`
schema): the display `phase` (Reveal after the commit end; Settling between the first proposal and the finalize) beside
Stage 1's stored `raiseState`, the counts, the current round, its proposal and running tally, the results once finalized
(a failed raise keeps its price and would-be results), `stage` (where the settlement stands: `awaiting-proposal`,
`tallying`, `awaiting-finalize`, `processing`, `delivering`, `complete`, …), `now` and `phaseEndsAt` (null while
Settling: steps have no deadline). The series row carries `mintFinalized`, the raise's `terms.commitDurationSeconds` /
`revealDurationSeconds` and, for a sealed raise, `auction` (round, rejection, clearing price, units sold, proceeds,
failure reason, `finalizedAt`). `terms.nonRevealChargeBps` is the series' own non-reveal charge, frozen at creation
(Stage 1; 0–1,000 bps): when the raise settles, a bid committed and never revealed pays `floor(deposit ×
nonRevealChargeBps / 10000)` to the protocol fee collector and is refunded the rest at delivery; a failed raise and a
revealed bid are never charged. New series take the operator's setting `MERCES_NON_REVEAL_CHARGE_BPS` (the owner's
decision); issuers cannot choose it, and `POST /drafts/{id}/build-create-series` answers 409 (`detail.setting`) for a
sealed raise while it is unset. Series created under the S2 hold record 0. `GET /arena` lists raises taking bids or
settling, and settled series.

**Attestor**: `GET /attestor/queue` → hardship decisions, tier-3 case sign-off, fallback FX rates, amendment
attestations, extinguishment transactions (two signers).

**Admin**: review queue, eligibility revocation, flags, templates, attestor proposals and their onchain status
(`GET /admin/attestors`) and verifier-key registration (multisig transactions), accounting and reconciliation (the fee
ledger's kinds: `auction`, `payout`, `curveTrading`, and `nonReveal` for the non-reveal charge, paid by the bidder),
notification backlog, keeper runs, audit log.

## What the public sees

Issuers, series parameters, phases and statuses, unit counts, the activity feed **without amounts**, retirement and
curve progress, threshold data with sources. Amounts (periods, payouts, treasury, vault, statements) need the holder,
issuer or admin tier. Terms (threshold, rate) need an eligible backer or the issuer and every read is logged.
