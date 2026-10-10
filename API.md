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
  `coSigners`, `command`, `payload`, `encoding`, `expiresAt`). The wallet signs; `POST /tx/send` relays `{ tx, signatures }`
  and returns the canonical events the transaction emitted.
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
lateness is refused onchain after the next day boundary; rebuild it) → hardship (`POST /series/{id}/hardship`) or redemption (`GET /series/{id}/redemption/quote`,
`POST …/redemption/build-redeem`).

**Backer**: apply → `GET /arena`, `GET /series/{id}`, `GET /series/{id}/terms` (eligible backers only, logged) →
`POST /series/{id}/bids/precheck` → compute the commitment client-side (or `POST …/bids/commitment`) → `POST
…/bids/build-commit` → keep an encrypted backup (`PUT …/bids/backup`) → reveal (`POST …/bids/build-reveal`) → after the
reveal end the keepers settle the raise in Stage 1's steps and then push every bid's refund and units (`deliverBid`): there
is nothing to claim. "Deliver now": `POST …/bids/build-deliver {bidder, signer?}` builds Stage 1's `deliver_bid` for a
processed, undelivered bid (`signer` defaults to the bidder and must be one of your wallets; any wallet may deliver any
bid, and the bidder is always the one paid; 409 `detail.stage1` NotProcessed or AlreadyDelivered) → `GET /me/holdings`,
`GET /series/{id}/payouts`, claims (`POST /series/{id}/payouts/build-claim`), redemption claims. Curve-mode buys (`POST /series/{id}/curve/build-buy`) need a wallet on that
chain's allowlist (403 otherwise) and, while the curve is bonding, stay within the wallet cap shown by
`GET /series/{id}/curve` (`walletCap`; 422 with the remaining allowance otherwise). After graduation no cap applies. The auction preview counts every revealed bid, its bidder still allowlisted or not, as
Stage 1's settlement does (S2).
`GET /me/bids` shows the chain's figures (the `Bid` schema): `pendingRefund` (also `refundable`) and `pendingUnits` are what
a processed bid is still owed until it is delivered ("0" otherwise), with the bid's `deposit`, `revealed`, `valid` (fixed at
reveal: an invalid bid is refunded in full), `processed`, `delivered` and `allocatedUnits`. Each bid's figures come from one
source, never a mix (`source`): the chain's read of the bid, or the indexed row as a whole when the chain has no read of
it (it may lag the chain by an indexer pass). `refunded`, the refund delivered, is indexed (only the delivery event
carries it): "0" while the bid is undelivered, and null while the chain shows the bid delivered and the indexer has not
projected the delivery yet.

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
failure reason, `finalizedAt`). `terms.nonRevealChargeBps` is what the series recorded; the charge is an owner hold and
is not applied (series created during the hold record 0). `GET /arena` lists raises taking bids or settling, and settled
series.

**Attestor**: `GET /attestor/queue` → hardship decisions, tier-3 case sign-off, fallback FX rates, amendment
attestations, extinguishment transactions (two signers).

**Admin**: review queue, eligibility revocation, flags, templates, attestor proposals and their onchain status
(`GET /admin/attestors`) and verifier-key registration (multisig
transactions), accounting and reconciliation, notification backlog, keeper runs, audit log.

## What the public sees

Issuers, series parameters, phases and statuses, unit counts, the activity feed **without amounts**, retirement and
curve progress, threshold data with sources. Amounts (periods, payouts, treasury, vault, statements) need the holder,
issuer or admin tier. Terms (threshold, rate) need an eligible backer or the issuer and every read is logged.
