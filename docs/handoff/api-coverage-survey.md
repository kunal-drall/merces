# API coverage against the frontend's flows (read-only survey at 8837dba)

Scope: `/home/user/merces` at 8837dba (S1-S4 done). Sources: `packages/api/src/**`, `packages/services/src/*/routes.ts` and `service.ts`, `packages/api/openapi.yaml` (built), `packages/api/src/openapi/{openapi.yaml,fragments/*.yaml,build.ts}`, `packages/server/src/{dev-mock,main,openapi-check}.ts`, `packages/client/src/*`, `packages/domain/src/{commands,port,state,events}.ts`, `packages/simulator/src/engine/{window,index}.ts`, `packages/keepers/src/{jobs,curve}.ts`, `packages/scenarios/src/{seed,demo-cycle}.ts`, `packages/stage1-sync/src/stage1-vectors/{shims,expected,ops/*}.ts`, `docs/stage1/VECTOR_PARITY.md`, `STAGE1_INTEGRATION.md`, `API.md`, Stage 1 `stage1/SPEC.md`, `stage1/packages/reference/src/sim/simulator.ts`, `stage1/packages/vectors/*.json`. Line numbers are of those files at this commit.

Numbers: **188 operations** in the built `openapi.yaml` (101 schemas, 20 tags); `pnpm openapi:check` currently reports `openapi.yaml matches 188 operations`. Route modules: 3 in `packages/api/src/routes` (public, me, dev) and 12 in `packages/services/src/*/routes.ts` (identity, contracts, terms, poi, auction, lifecycle, meteora, threshold, attestor, accounting, notifications, admin), registered in that order by `serviceRoutes` (`packages/services/src/index.ts:88`).

---

## 1. How the contract is assembled, checked and consumed

### 1.1 Assembly (fragments)

- Base spec: `packages/api/src/openapi/openapi.yaml` (1,379 lines): info, tags, `components` (Money, Wad, Error, Stage1ErrorName, ChainHealth, …) and the paths of the gateway's own routes plus the identity/contracts/terms/poi/auction modules (its `paths` start at line 471: `/health`, `/chains`, … through `/series/{seriesId}/auction/preview` at line 1372).
- Fragments: `packages/api/src/openapi/fragments/{accounting,admin,attestor,lifecycle,meteora,notifications,signing,threshold}.yaml` (303/507/438/266/410/138/65/179 lines). Each contributes `paths`, optional `components.*` and `tags`.
- `buildSpec()` (`packages/api/src/openapi/build.ts:231-251`): parses the base, then every fragment in sorted filename order; a duplicate path (`:237`) or duplicate `components.<section>.<key>` (`:244`) throws; tags are merged by name. `pnpm openapi:build` writes `packages/api/openapi.yaml` with a GENERATED header (`:253-257`).
- The built file is what the client generator and the check read (`packages/client/src/generate.ts:262`, `packages/server/src/openapi-check.ts:157`).

### 1.2 Check (`pnpm openapi:check`, `packages/server/src/openapi-check.ts`)

- Rebuilds the spec first (`:204-208`), then `checkContract()` (`:179-201`) boots the real app with every service route over a null pool and empty chain registry (`:181-182`), reads the route table (`routeTable`, `packages/api/src/app.ts:80-95`, fed by an `onRoute` hook that records method, url, `config.access`, `config.devOnly`), converts `:param` to `{param}` (`:184`) and compares both ways: every route must be in the spec with equal `x-access` and `x-dev-only` and a non-empty `operationId` (`:189-197`); every spec operation must have a route (`:198`).
- **What it does not check**: request/response schemas against handler output, path-parameter declarations, or that a response schema is more than `{type: object}`. There is no runtime response validation and no test that validates responses against the spec (`grep ajv|validateResponse` in `packages/api/test`: none; the only spec reads are `contracts-terms.test.ts:8` (buildSpec) and `curve-staking.test.ts:350`, which greps the yaml for a field name).
- Consequence for a typed frontend: **121 of 188 operations have a bare (`{type: object}` with no properties) or thin (≤2 top-level properties) 2xx response schema**, and 3 have no JSON content (`/prover/report.wasm`, `/prover/report.zkey`, `/admin/accounting/export` CSV). The bare ones include most of what the frontend reads first: `getIssuer`, `getSeriesStatus`, `getArena`, `getTreasury`, `getVault`, `getHolders`, `getSeriesPayouts`, `getMe`, `getMyPayouts`, every `/applications/*`, every `/drafts/*`, `getSeriesTerms`, `sendSignedTx`, `getReportingSchedule`, `assembleReport`, `listReports`, `getReport`, `buildSubmitReport`, `precheckBid`, `computeBidCommitment`, `buildCommitBid`, `buildRevealBid`, `getBidBackup`, `attestorMe`, `attestorQueue`, `requestHardship`, `getHardship`, `decideHardship`, every tier-3 route, `listFxRequests`, `signFxRequest`, `buildTreasuryDraw`, `buildTreasuryPause`, `buildWindowCommit`, `buildWindowReveal`, `getWindowBackup`, `attestAmendment`, `buildAmendTerms`. The generated client types them as `Record<string, never>` (118 occurrences in `packages/client/src/generated/openapi.d.ts`). The well-typed ones are the S2-S4 additions (`AuctionState`, `Bid`, `PositionView`, `ClaimBuild`, `RedemptionQuote`, `SigningRequest`, `UnsignedTx`, `CurveWalletPosition`, `AdminTxRequest`, …; full list of 101 schemas in `openapi.yaml` `components.schemas`).

### 1.3 Client (`@merces/client`)

- `pnpm openapi:client` = `openapi:build` + `tsx packages/client/src/generate.ts` (`package.json:28`): openapi-typescript 7.13.0 writes `packages/client/src/generated/openapi.d.ts` (`paths` at line 2, `components` 2959, `operations` interface 4545; 11,261 lines).
- Wrapper `packages/client/src/index.ts:303-328`: `createClient({baseUrl, token?, fetch?})` with `get/post/put/delete(path, {path, query, body, idempotencyKey})`, typed by path literal (no per-operationId helpers), sets `authorization: Bearer`, `content-type`, `idempotency-key`; `setToken`. Errors become `MercesApiError{status, code, message, detail}` (`:288-297`).
- Gaps: no `patch` (none needed today); **`JSON.parse(text)` on every response (`:314-315`)**, so `GET /admin/accounting/export` (CSV), `/prover/report.wasm` and `/prover/report.zkey` (binary) throw through the client; no query support on `post`/`put` (`:324-325`; none of today's writes take a query, but `GET /series/{id}/curve/quote` and the attestor `…/message?…` routes do and work through `get`); no helper for the sign-in dance (`/auth/nonce` → sign → `/auth/verify`) or for building `sim:` signatures in mock mode. Nothing in the repository imports `@merces/client` (`grep -rl "@merces/client" packages` → none): it is generated and type-checked but never exercised.

---

## 2. What `pnpm dev:mock` serves (`packages/server/src/dev-mock.ts`)

- Both chains are the simulator (`createChains({solana:{mode:'mock'}, evm:{mode:'mock', chainKey:'monad'}, …})`, `:23`), persisted in Postgres under `MERCES_SIM_KEY` (default `sim`); first run seeds (`seedCohort`, `:26-29`; `MERCES_SEED=false` skips; `MERCES_SEED_QUARTERS` default 3; proofs Groth16 unless `MERCES_PROOF_SYSTEM=mock`), later runs resume. Indexer catch-up then poll loop (`:30-31`, `:76`; `INDEXER_POLL_MS` 1000). Keepers in-process (`:78-80`, `KEEPER_TICK_MS` 5000, `MERCES_KEEPERS=false` disables) with `MockPyth` at simulator time and `MockChainlink`. App = `buildApp(ctx, serviceRoutes)` with `devMode: true` (`:32`, `:72`), so `/dev/*` routes are on. Port `PORT` (3000).
- Seeded world (`packages/scenarios/src/seed.ts:47-167`, cohort `packages/fixtures/src/cohort.ts:33-44`): 12 issuers (solana: nova-synth, low-tide, byte-anand, pixel-pat, lens-lior (tier 1), orbit-ora; monad: ink-and-ash, kernel-k, rust-belt (tier 3), copy-cass, founder-fen (tier 3), mesh-mika), each: `registerIssuer`, `createSeries` (sealed, 2-day commit / 1-day reveal), `openRaise`, 5 backer bids, reveal, Stage 1 settlement with delivery (`h.settle(seriesId,'deliver')`, `:96`), `drawRelease`; tier-1 issuer gets a split router (`:101`); quarters 2026Q1-Q3 reported through the device (Groth16, tier-2 verifier attestation, tier-3 attestor REPORT signature, FX fallback signatures for non-USD) and paid (`:118-152`); backers 1-2 claim (`:154-157`); one Solana curve series `issuer:curve-cam` created and left Open/unfilled (`:159-165`). Every seeded sealed series is therefore **Settled, mint-finalized, delivered, three quarters paid**, in lockup (18 months from ~Jan 2026).
- Accounts (`dev-mock.ts:46-71`): `acct-issuer-<handle>` (roles issuer+backer, eligible, wallet `SimWallet(family, 'issuer:<handle>')`); `acct-backer-1..5` (roles backer, eligible, one solana and one monad wallet `SimWallet(..., 'backer-n')`, which are exactly the harness's allowlisted and funded backers, `packages/simulator/src/harness.ts:218-241`); `acct-attestor-1..2` (no roles; EVM wallet at the dev attestor key's address, seeds `merces-dev-attestor:<n>`, keys registered on both simulators and linked, `:60-70`); `acct-admin` (role admin, both admin wallets, `:71`). The dev report-verifier key is registered on both chains (`:35-44`).
- Sign-in in mock mode: `POST /auth/nonce {chain, address}` → `POST /auth/verify` with `signature = 'sim:' + sha256(address ‖ message)` (accepted only when `devMode`, `packages/services/src/identity/service.ts:74`, `packages/ports/src/wallet-verify.ts:12-18`). Transactions: `POST /tx/send {tx, signatures: {[tx.signer]: 'sim:' + tx.signer}}` (`packages/simulator/src/chain.ts:368`; `packages/simulator/src/wallets.ts:21-22`). A wallet unknown to the backend that signs in gets a fresh account with roles `['backer']`, not eligible (`identity/service.ts:89-92`).
- Dev routes: `GET /dev/time`, `POST /dev/advance-time {seconds ≤ 10y}`, `POST /dev/faucet {chain, wallet, stablecoin, amount}` (`packages/api/src/routes/dev.ts:141-162`), `POST /dev/esign/complete {sessionId, outcome}` (`packages/services/src/contracts/routes.ts:29-40`). **No dev route lists the personas/addresses** (a frontend developer must derive them from `GET /issuers` and the seed labels), none produces a mock zkTLS proof, none toggles Stage 1-style protocol flags (windows are a DB feature flag, below).
- Feature flags (`packages/db/migrations/001_core.sql:61`): `tier4`, `transfer_windows`, `early_draws`, `secondary_trading`, `private_payouts`, all false; `PUT /admin/flags/{name}` flips them unless locked (`admin/service.ts:118-127`, `LOCKED_FLAGS`).
- Keeper jobs running under dev:mock (`packages/keepers/src/jobs.ts`): `auction.settle` (:81, every 60 s), `auction.deliver` (:98), `auction.reveal-reminders` (:110), `status.crank` (:159), `pause.crank` (:189), `burn.crank` (:217), `reporting.reminders` (:250), `transfer.windows` (:279-319: opens one window per quarter 14 days after quarter start, 7 d commit + 2 d reveal, flag-gated; always clears a due window), `fx.coverage` (:322), `outbox.dispatch` (:370); `curve.lifecycle`, `curve.sync`, `curve.stake-reminders`, `curve.tender-reminders` (`keepers/src/curve.ts:53,81,171,188`); `rate.snapshot` (`rate-keeper.ts:27`).

---

## 3. Flow by flow

Format per flow: routes that exist (method path → operationId, tier, where), what is missing or stubbed for S5, what a frontend can exercise end to end on dev:mock today, what the client exposes.

### 3.1 Auction (sealed-bid raise)

Routes (all in OpenAPI, all served):

| Route | operationId | tier | code |
| --- | --- | --- | --- |
| GET /series/{id}/auction | getAuction | public | `api/src/routes/public.ts:117-127` (chain record + `stage`, `now`, `phaseEndsAt`) |
| GET /series/{id}/auction/preview | getAuctionPreview | public | `auction/routes.ts:38`, `service.ts:275` |
| GET /series/{id} | getSeries | public | `public.ts:93-113` (`terms.commitDurationSeconds/revealDurationSeconds/nonRevealChargeBps`, `mintFinalized`, `auction{round, rejection, clearingPrice, unitsSold, proceeds, failureReason, finalizedAt}`, `serialize.ts:24-110`) |
| POST /series/{id}/raise/build-open | buildOpenRaise | issuer | `auction/routes.ts:31`, `service.ts:225-233` (RaiseNotDraft, ContractHashMissing, NotAllowlisted, NewRaisesPaused pre-checks) |
| POST /series/{id}/raise/build-cancel | buildCancelRaise | issuer | `routes.ts:32`, `service.ts:240-247` |
| POST /series/{id}/bids/precheck | precheckBid | backer | `routes.ts:11`, `service.ts:111-139` (issues, deposit, walletCapUnits, fee, nonRevealChargeBps/charge, phase ends) |
| POST /series/{id}/bids/commitment | computeBidCommitment | backer | `routes.ts:12-15`, `service.ts:155` (Stage 1 keccak; price/qty/salt sent to the server: API.md says compute client-side) |
| POST /series/{id}/bids/build-commit | buildCommitBid | backer | `routes.ts:16-19` |
| POST /series/{id}/bids/build-reveal | buildRevealBid | backer | `routes.ts:20-23` |
| PUT /series/{id}/bids/backup, GET …/backup/{bidder} | putBidBackup / getBidBackup | backer / account | `routes.ts:33-37` (client-encrypted) |
| POST /series/{id}/auction/build-step | buildSettlementStep | account | `routes.ts:29`, `service.ts:198-216` → `{stage, command, tx}` or 409 `{stage, reason: wait|done|<stuck>}` |
| POST /series/{id}/bids/build-deliver | buildDeliverBid | account | `routes.ts:25-28`, `service.ts:178` (`{tx, pendingUnits, pendingRefund}`) |
| GET /me/bids | getMyBids | account | `api/src/routes/me.ts:82-111` (one source per bid: chain read or indexed row; `pendingRefund`/`refundable`, `nonRevealCharge`, `refunded`) |
| POST /tx/send | sendSignedTx | account | `terms/routes.ts:96-109` (relays; signer must be one of the session's wallets or admin) |

Terms/draft path that precedes a raise: `POST /drafts`, `GET /drafts/mine`, `GET /drafts/{id}`, `PUT /drafts/{id}/terms`, `GET /drafts/{id}/terms/private`, `POST /drafts/{id}/build-create-series`, `POST /drafts/{id}/link-created` (`terms/routes.ts:40-60`), `POST /terms/validate`, `POST /terms/commitment` (`:15-31`), contracts `POST /drafts/{id}/contract/prepare`, `GET …/contract`, `GET …/contract/document` (`contracts/routes.ts:11-13`).

Missing or stubbed (S5):
- **No route builds `registerIssuer`.** The command exists (`domain/src/commands.ts:42`) and the simulator refuses `createSeries` for an unregistered issuer (`simulator/src/engine/registry.ts:25-26`, `Unauthorized 'issuer not registered'`); the only callers are the seed (`scenarios/src/seed.ts:72,162`) and the vector shim SH-REG-1 (`stage1-vectors/ops/registry.ts:44-46`). Stage 1 makes `register_issuer(wallet)` admin-only (SPEC.md:224; reference `simulator.ts:527-529`), so the S5 shape is an admin tx-request (`POST /admin/issuers` → `registerIssuer{wallet}` built for the multisig, like `/admin/attestors`), plus `deactivate_issuer` (SPEC.md:224, `simulator.ts:530-534`) and the issuer's own `stop_issuance`/`resume_issuance` (`simulator.ts:569-574`; our `stopIssuance` user command exists at `commands.ts:185` with no route and no `resumeIssuance`). Also `set_contract_hash` (Draft only, `simulator.ts:561-568`): ours folds the hash into `createSeries.terms.contractHash` (`terms/service.ts:348`), and `buildOpenRaise` refuses a zero hash (`auction/service.ts:229`); no route sets it later.
- Window terms are not series terms: `publicTermsSchema` (`terms/service.ts:21-40`) has no `windowCommitDuration`, `windowRevealDuration`, `windowFeeBps`; the runner holds them per series (SH-REG-4, `ops/registry.ts:109-113,120`); Stage 1 bounds them at `create_series` (SPEC.md:123,127,128; register row STAGE1_INTEGRATION.md:111). S5 must add them to `SeriesTerms`, the draft schema, `/terms/validate`, `seriesRow` and the migration.
- `GET /series/{id}/auction` and `/me/bids` fall back to the indexed row when a chain has no bid read (`me.ts:116-123`, NotImplemented): only the live adapters hit that.
- The settlement planner is exercised by the keepers (`auction.settle`, `auction.deliver`) and by `build-step`; nothing lets a frontend watch "who delivered what" beyond `/me/bids` and the public `/series/{id}/activity` summaries.

dev:mock today: fully exercisable end to end for a seeded issuer persona: draft → terms → contract prepare + `/dev/esign/complete` → build-create-series → `/tx/send` → link-created → build-open → backer bids (precheck/commitment/build-commit, `/dev/faucet` for deposits, `/dev/advance-time` past the commit and reveal ends) → keepers settle and deliver within one tick, or `build-step` by hand → `/me/bids`, `/series/{id}/auction`. The seeded 12 series are already past this (Settled, delivered). A **new** issuer (fresh wallet) cannot create a series (no `registerIssuer` route; see above). Coverage: `packages/api/test/auction.test.ts`, `auction-builders.test.ts`, `mint-gates.test.ts`, `scenarios.test.ts`.

Client: all routes present in `paths`; typed responses for `getAuction` (AuctionState), `getMyBids` (Bid), `buildSettlementStep` (SettlementStep), `buildDeliverBid`; bare objects for precheck, commitment, build-commit, build-reveal, backups, `/tx/send`, every draft route.

### 3.2 Claims (Stage 1's claim family)

| Route | operationId | tier | code |
| --- | --- | --- | --- |
| POST /series/{id}/payouts/build-claim | buildClaimPayout | holder | `lifecycle/routes.ts:13`, `service.ts:71-83` (`{tx, claimable, burnsUnits, builder}`; 409 `nothing-to-claim` with `claimWith`) |
| POST /series/{id}/tail/build-claim | buildClaimTail | holder | `routes.ts:14`, `service.ts:103-127` (`{tx, amount, redeemsFirst, total, burnsUnits}`; NotRedeemed / HolderNotRegistered / NoRedeemedUnits) |
| POST /series/{id}/final/build-claim | buildClaimFinal | holder | `routes.ts:15`, `service.ts:147-169` (TerminalStatus unless Extinguished; weighs escrowed ask units, DIV-S1I-1) |
| POST /series/{id}/redemption/build-claim | buildClaimRedemption | holder | `routes.ts:19`, `service.ts:250-261` (`{tx, units, amount, redemption, payout}`; CurveUsesTender on a curve) |
| POST /series/{id}/holders/build-register | buildRegisterHolder | account | `routes.ts:16`, `service.ts:179-186` (`{tx|null, alreadyRegistered}`; 403 NotAllowlisted) |
| GET /series/{id}/redemption/quote | getRedemptionQuote | holder-or-issuer | `routes.ts:17`, `service.ts:205-234` (Stage 1's quote, `blockedBy` names, `outcome: redeem|retire`) |
| POST /series/{id}/redemption/build-redeem | buildRedeem | issuer | `routes.ts:18`, `service.ts:235-241` (`maxPricePerUnit` slippage bound: ours, SH-RED-1 stays) |
| GET /series/{id}/redemption | getRedemption | holder-or-issuer | `routes.ts:20`, `service.ts:269-291` (tail tracking) |
| GET /series/{id}/retirement | getRetirement | public | `routes.ts:21`, `service.ts:300-315` |
| POST /series/{id}/retirement/crank-burn | burnRetiredHolders | admin | `routes.ts:22`, `service.ts:373-393` |
| GET /series/{id}/position | getPosition | holder | `public.ts:258-268` (`PositionState`: `claimable`, `pending`, `redemptionClaimable`, `tailClaimable`, `finalClaimable`, `undeliveredUnits`, `escrowedUnits`, `registered`; `domain/src/state.ts:274-320`) |
| GET /me/holdings, GET /me/payouts, GET /series/{id}/payouts | getMyHoldings, getMyPayouts, getSeriesPayouts | account / account / holder | `me.ts:31-58, 62-67`, `public.ts:248-254` |
| GET /series/{id}/vault, /holders, /periods | getVault, getHolders, getSeriesPeriods | holder-or-issuer | `public.ts:229-245, 202-215` |

Missing or stubbed (S5):
- **`burnRetired` has no wallet builder** (only the keeper job and the admin crank); Stage 1's `burn_retired` is permissionless. Minor for the frontend.
- **`retire_if_capped`** has no command (BLK-1, `ops/unsupported.ts:239`; waived in 01#34, 05#42; gate of 14 at #62): Stage 1's permissionless crank (`simulator.ts:637-643`: MintNotFinalized, TerminalStatus, NothingDue). Needs a permissionless command + keeper + (optional) wallet builder; the `/retirement` read could expose "retirable now".
- No "push claim for another holder" (Stage 1 `claimFor`; register row STAGE1_INTEGRATION.md:86, owner matter).
- Holder tier needs a `positions` row (`access.ts:66-73`): a wallet that only bid, or a curve buyer that never staked, gets 403 on `/position`, `/payouts`, the claim builders (by design, A-REV-10), so the frontend must route them to `/me/bids` and `/series/{id}/curve/position`.
- The redemption quote's TrueUpOutstanding blocker is "not reachable until the true-up lands" (`service.ts:197`).

dev:mock today: `claimPayout` exercisable at once for `acct-backer-3..5` on any seeded series (backers 1-2 already claimed; a repeat is 409 `nothing-to-claim`). Redemption: issuer `/redemption/quote` is 409-blocked by `LockupActive` until `/dev/advance-time` passes ~18 months; then `build-redeem` → holders `redemption/build-claim`, tail after a liquidity-event report (needs the device prover, see 3.4), final after an extinguishment (3.7; both dev attestor accounts exist). Retirement by cap: reachable only by paying enough quarters (device prover). Coverage: `lifecycle.test.ts`, `lifecycle-edges.test.ts`, `curve-claims.test.ts`, `scenarios.test.ts`.

Client: typed `ClaimBuild`, `RedeemsFirst`, `RedemptionQuote`, `RedemptionView`, `PositionView`, `Holding`; `getVault`, `getHolders`, `getSeriesPayouts`, `getMyPayouts`, `buildRegisterHolder` (thin), `burnRetiredHolders` (thin) are bare/thin.

### 3.3 Curve (Solana curve mode)

| Route | operationId | tier | code |
| --- | --- | --- | --- |
| GET /series/{id}/curve | getCurveStatus | public | `meteora/routes.ts:22`, `service.ts:81-88` (`onchain` CurveState with `census`, `notice`, `beforeYouBuy`, no-cap fields) |
| POST /series/{id}/curve/configure | configureCurve | issuer | `routes.ts:23`, `service.ts:53` |
| GET /series/{id}/curve/quote | quoteCurveSwap | account | `routes.ts:32`, `service.ts:146` (`minimumAmountOut`, `earns`, `beforeYouBuy{version, statements}`) |
| POST /series/{id}/curve/build-swap | buildCurveSwap | account | `routes.ts:34-37`, `service.ts:159-172` (buy: eligible backer + `acknowledged: true` + current `beforeYouBuyVersion`, else 422 `acknowledgement-required` at `:171-172`; sell: any linked wallet; `payIn: USDG` adds a DEX route) |
| GET /series/{id}/curve/position | getCurveWalletPositions | account | `routes.ts:41`, `staking.ts:151` (`approved, registered, walletUnits, stakedUnits, earning, pending, claimable, stakable|stakeBlockedBy, censusHeldBy, stakeSteps, unstakable, tender{…}, next`) |
| POST /series/{id}/curve/build-stake | buildCurveStake | account | `routes.ts:42-48`, `staking.ts:198` (ordered `steps`: registerHolder?, syncCurveUnits?, stakeUnits) |
| POST /series/{id}/curve/build-unstake | buildCurveUnstake | account | `routes.ts:49-55`, `staking.ts:236` (one tx `[unstakeUnits, claimPayout]`, `tx.commands`) |
| POST /series/{id}/curve/build-tender | buildCurveTender | account | `routes.ts:56-62`, `staking.ts:257` |
| POST /series/{id}/curve/build-sync | buildCurveSync | account | `routes.ts:64`, `service.ts:194` (409 `report-pending` while the issuer's assembled report holds the census) |
| POST /admin/curves/monitor | monitorCurves | admin | `routes.ts:65`, `service.ts:214` |
| Curve claims | the 3.2 builders branch on `raiseStyle === 'curve'` (`lifecycle/service.ts:78-82, 112-119, 156-162, 253`) |

Missing or stubbed (S5):
- The venue is the simulator's stand-in pool (`CurveState.venue: 'simulator-stand-in'`, `domain/src/state.ts:425-427`); Meteora's DBC/DAMM quote and swap route arrive with the Solana adapter (`port.ts:55-59` NotImplemented on live chains; register rows STAGE1_INTEGRATION.md:89-90). API shape is final; only the adapter is pending (deployment-last scope).
- No API for the issuer's `prepare_curve`/`activate_curve` steps (folded into `createSeries`, row :89); no read of "proceeds collected so far" beyond `getSeries().curve` (indexed `proceeds, migrationFee, surplus, tradingFee`, `public.ts:105-111`).
- `curveSwap` is a user command the simulator executes (`engine/index.ts:142`); on a live chain the frontend sends the Meteora swap itself — the API returns `tx` today either way, which is fine for mock mode.

dev:mock today: one curve series (`solana:` curve-cam, Open). Flow: sign in as `acct-backer-n` → `/dev/faucet` USDC → `GET …/curve/quote?wallet&side=buy&amountIn` → `build-swap` with the acknowledgement → `/tx/send`; buy to the 2,000 USDC target → `curve.lifecycle` completes and collects (or `POST /admin/curves/monitor`) → `build-stake` (steps) → `build-unstake` → reports on the curve need the census (`build-sync`) and the device prover; tender after a redemption (issuer `build-redeem` on the curve, lockup is 0 on a curve). Coverage: `meteora.test.ts`, `curve-staking.test.ts`, `curve-census.test.ts`, `curve-claims.test.ts`.

Client: well typed (`CurveStatus`, `CurveState`, `CurveCensus`, `CurveSwap`, `CurveBeforeYouBuy`, `CurveWalletPosition`, `CurveNoCap`).

### 3.4 Reports (ProofOfIncome, tiers 1-4; verifier; census)

| Route | operationId | tier | code |
| --- | --- | --- | --- |
| GET /prover/artifacts, /prover/report.wasm, /prover/report.zkey | getProverArtifacts, getProverWasm, getProverZkey | public | `poi/routes.ts:18-28` |
| GET /income-sources | listIncomeSources | public | `:29` |
| GET /reporting/verifier | getReportVerifier | public | `:30` |
| GET /series/{id}/reporting/schedule | getReportingSchedule | issuer | `:31`, `service.ts:60-85` (`nextStep` per period incl. `sync-curve-units`) |
| GET /series/{id}/reporting/prior | getReportingPrior | public | `:32-35` |
| GET /series/{id}/reporting/fx/{periodId} | getReportingFx | issuer | `:36` |
| POST /series/{id}/reporting/zktls-session | createZkTlsSession | issuer | `:37-43` (tier 2 only) |
| POST /series/{id}/reports | assembleReport | issuer | `:44-52`, `service.ts:193-262` (`assembleSchema` tier 1|2|3|4 at `:23-27`; tier 4 behind the `tier4` flag `:199`; tier 2 needs the verifier attestation `:240-243`; tier 3 needs the stored signed case `:244-253`; curve census gates) |
| GET /series/{id}/reports | listReports | holder-or-issuer | `:53` |
| GET /series/{id}/reporting/splits/{periodId} | getSplitReceipts | issuer | `:54` (tier 1) |
| GET /reports/{id}, POST …/build-submit, POST …/submitted, POST …/build-payin, POST …/paid | getReport, buildSubmitReport, markReportSubmitted, buildPayIn, markReportPaid | account (issuer checked in handler) | `:55-63`; `buildSubmit` `service.ts:284-306` (409 `census-changed`) |
| GET /series/{id}/reporting/fx-fallback/{periodId} | fxFallbackForSeries | issuer | `attestor/routes.ts:109` |
| GET /series/{id}/periods, GET /series/{id}/status | getSeriesPeriods, getSeriesStatus | holder-or-issuer / public | `public.ts:202-215, 148-161` |
| Census | `POST /series/{id}/curve/build-sync` (3.3) |

Missing or stubbed (S5):
- **FX accumulator and FX pairs**: `snapshotRate`/`flagFxFallback` service commands exist (`commands.ts:189,194`) and the `rate.snapshot`/`fx.coverage` keepers run, but Stage 1's `set_fx_pair` (admin, `simulator.ts:552-560`; pair id = keccak(feed ‖ inverted)) and `fx_snapshot` (`simulator.ts:1303`) are NOT-YET (`ops/unsupported.ts:220-221`; vectors 13 and 24 not replayed). No admin route configures an FX pair; `fxBasis`/`pair` on a report are derived by the service (`poi/service.ts:262`) and by the runner (SH-REP-1, `ops/reports.ts:27`). Frontend impact: non-USD issuers see `fxBasis: 'accumulator'` in the schedule (`service.ts:76`) and `getReportingFx` answers from the accumulator or says an attestor rate is required (`scenarios.test.ts:381`), which works on the simulator; the admin has no FX-pair UI route.
- **Tier-3 true-up**: `openTier3Annual`, `tier3AnnualSigningRequest`, `signTier3Annual` capture the TRUEUP signature (3.7), but there is **no `submitTrueUp` / `payTrueUp` command or route** (`ops/unsupported.ts:223-224`; vector 20 gated at #71; reference `simulator.ts:1187-1240`). The issuer cannot submit or pay the true-up; the 60-day underpayment deadline is not enforced onchain (register row STAGE1_INTEGRATION.md:98).
- **Tier 1 router**: `route_income`, `close_router_period` NOT-YET (`unsupported.ts:221-222`; vectors 12, 18); only `registerSplitRouter` (admin command, no route) and `postSplitReceipt` (router command, simulator only) exist; `getSplitReceipts` reads what the simulator posted. The frontend has no tier-1 issuer flow beyond reading splits.
- **`pay` shape**: ours is `payIn{periodId, amount}` built by `buildPayIn` with the exact remaining due (SH-PAY-1, `ops/money.ts:24-34`; register row :88). Stage 1's `pay` takes neither; a pay-in built on one day is refused after the next lateness day boundary (API.md:108). S5 either drops the guards or keeps rebuilding; the route shape can stay.
- **Device/prover for a frontend**: assembling a report needs a Groth16 proof and (tier 2) a zkTLS proof + the verifier's REPORT signature. The only assembler is `assembleOnDevice` in `@merces/poi-device` (Node; used by the seed and `demo-cycle.ts:75`); the zkTLS provider on dev:mock is `MockZkTls` (`services/src/index.ts:67`), whose `prove()` is in-process and not exposed by any route (`MockZkTls`, `ports/src/zktls.ts:135-141`; no `/dev/zktls*` route), and the standalone verifier (`pnpm dev:verifier`, `report-verifier/src/server.ts`) is not what dev:mock uses (in-process `ReportVerifier`, `services/src/index.ts:76-78`). So **a browser frontend cannot complete a tier-2 or tier-3 report on dev:mock without a Node-side issuer device**; there is no issuer device CLI (only `merces-attestor`, `poi-device/src/attestor-cli.ts:423-427`). Tier 4 (self-attestation, no zkTLS) still needs the Groth16 prover in the browser or a device.

dev:mock today: reads (`schedule`, `prior`, `reports`, `periods`, `status`, `fx`) all work for seeded issuers; `/reports/{id}/build-submit|build-payin` work for a report the device assembled; assembly itself is blocked for a pure frontend as above. The demo (`demo-cycle.ts`) and the seed prove the backend side end to end.

Client: `ReportProof`, `Groth16Proof`, `ReportPublicInputs`, `ReportAttestationRecord`, `ReportVerifierInfo`, `Period`, `SeriesReporting` typed; `assembleReport`, `getReport`, `listReports`, `getReportingSchedule`, `buildSubmitReport`, `createZkTlsSession`, `getReportingFx` bare.

### 3.5 Pause (hardship)

| Route | operationId | tier | code |
| --- | --- | --- | --- |
| POST /series/{id}/hardship | requestHardship | issuer | `attestor/routes.ts:25-33`, `service.ts:384` (`{until, attestor, ciphertext, keyHint}` at `:53`; returns the `requestPause` tx + request row) |
| GET /series/{id}/hardship | hardshipStatus | holder-or-issuer | `routes.ts:34`, `service.ts:546` |
| POST /series/{id}/hardship/build-withdraw | buildWithdrawPauseRequest | issuer | `routes.ts:36`, `service.ts:416` |
| GET /attestor/hardship/{id} | getHardship | attestor | `routes.ts:37` |
| GET /attestor/hardship/{id}/message?pauseEnd | hardshipSigningRequest | attestor | `routes.ts:39`, `service.ts:462-493` (PAUSE SigningRequest over the live nonce) |
| POST /attestor/hardship/{id}/decide | decideHardship | attestor | `routes.ts:40-47`, `service.ts:495-544` (approve: `{pauseEnd, pauseNonce, attestation}` → keeper relays `approvePause`, returns `relayTx`; reject: `{decisionCode}`) |
| GET /series/{id}/signing | getSeriesSigning | public | `public.ts:131-144` (domain, seriesKey, nonces) |
| GET /series/{id}/status, /series/{id} | status/phase/pauses as indexed |

Missing or stubbed (S5):
- **`end_pause`** (issuer ends an approved pause early; `simulator.ts:674-685`: NotIssuer, NotPaused; SPEC.md:451) has no command, no route (`unsupported.ts:219`; vector 08 gated at #58; register row :87). Needs `endPause` user command, engine, indexer (`PauseEnded`), issuer builder `POST /series/{id}/hardship/build-end` and the `pause.crank` interplay.
- `requestPause.until` is ours and advisory (`commands.ts:116-123`; SH-PAU-1 `ops/pauses.ts:29-33`; row :87): the frontend's `until` is a hint; the attestor's `pauseEnd` is what counts. The runner sends `t + maxPauseSeconds`.
- `pause.crank` only ends a pause at its approved end (`jobs.ts:189-197`).

dev:mock today: fully exercisable: issuer (`acct-issuer-<handle>`) `POST /series/{id}/hardship` naming the dev attestor key → `/tx/send` the `requestPause` → attestor (`acct-attestor-1`, signs in with its EVM wallet at the key's address, `sim:` signature) `GET …/message?pauseEnd` → sign the digest with `merces-attestor sign` (dev key seed `merces-dev-attestor:1`) → `POST …/decide` → the API relays `approvePause`. `build-withdraw` works. Coverage: `attestor.test.ts`, `scenarios.test.ts:152`.

Client: `HardshipStatus`, `SigningRequest`, `Attestation` typed; `requestHardship`, `getHardship`, `decideHardship`, `buildWithdrawPauseRequest` bare.

### 3.6 Buy-back = Stage 1 transfer windows (today: one-step shims)

Routes that exist (OpenAPI `lifecycle` fragment lines 225-265):

| Route | operationId | tier | code |
| --- | --- | --- | --- |
| GET /series/{id}/window | getTransferWindow | public | `lifecycle/routes.ts:23`, `service.ts:321-331` (`enabled` flag, `lockupEndsAt`, `window: TransferWindowState|null`, `phase: none|commit|reveal|clear-due`, `walletCapUnits`, curve: no windows) |
| POST /series/{id}/window/build-commit | buildWindowCommit | account | `routes.ts:24`, `service.ts:332-341` (403 while the `transfer_windows` flag is off; `{wallet, side, commitment, deposit, units}`; buyers must be allowlisted) |
| POST /series/{id}/window/build-reveal | buildWindowReveal | account | `routes.ts:25`, `service.ts:342-351` |
| PUT /series/{id}/window/backup, GET …/backup/{wallet} | putWindowBackup, getWindowBackup | account | `routes.ts:26-30`, `service.ts:352-365` |
| (keeper) `transfer.windows` | opens (`openTransferWindow{commitEndsAt, revealEndsAt}`) and clears (`clearTransferWindow`) | `jobs.ts:279-319` |

Where windows stand today (the one-step engine): commands `openTransferWindow`, `commitWindowOrder{side, commitment, deposit, units}`, `revealWindowOrder{side, pricePerUnit, quantity, salt}`, `clearTransferWindow` (`commands.ts:146-147, 192-193`); engine `simulator/src/engine/window.ts`: open `:30-44` (sealed only, Settled, mint final, lockup over, one open window, `syncStatus`), commit `:55-75` (one order per wallet; buy debits the deposit and needs the allowlist; ask settles the holder and marks `position.escrowed`), reveal `:76-93` (Stage 1 keccak order commitment; invalid reveal **reverts** `InvalidCommitment`/`InsufficientFunds`, where Stage 1 records `valid=false`), **clear `:155-196` = Stage 1's `finalize_window` + `process_orders` in one step with our own greedy matcher (`matchOrders` `:103-139`: buys descending, sells ascending, price = last matched buy, wallet cap via `interim.walletCapUnits`, no fee)**; forced NoMatch on a terminal series (`:162`). State `TransferWindowState` (`domain/src/state.ts:404-416`): `windowId, commitEndsAt, revealEndsAt, cleared, clearingPrice, orderCount, escrowStable, escrowUnits` — no per-order read, no state machine, no rounds. Events: `TransferWindowOpened`, `TransferWindowCleared`, `UnitsTransferred` (`events.ts:287-288`); indexer `transfer_windows` table (`db/migrations/002_indexer.sql:214-222`) and position moves (`indexer/src/projections.ts:479-495`); no order events indexed. Flag: DB `transfer_windows` (default false), checked by the builders and by the keeper's opener (`jobs.ts:283,304`), never by the engine.

What Stage 1 has that is missing (S5; SPEC §7 `SPEC.md:536-565`, reference `simulator.ts:1485-1655`, vectors 10/16/22/25, README ops `vectors/README.md:101-104`):
- Protocol flag `windows_enabled` onchain (`set_flags`, `simulator.ts:547-551`; `WindowsDisabled` 10#36, 16#41; SH-FLG-1) — admin command + route; today only a DB flag.
- `open_window(series, period)`: `WindowNotEligible` (status OnTime/InGrace, `last_paid_period ≥ period`, `period == period_of(now) − 1`), `WindowOpen`, phase ends from the **series terms** `window_commit_duration`/`window_reveal_duration` (`:1485-1514`; 10#45-#49). Ours takes the ends from the caller (keeper: 7 d / +2 d, `jobs.ts:311`) and has no `period`.
- Orders: `commit_ask{units}` moves units into the window escrow (ours keeps them in the position as `escrowed`, which S3 settled as equivalent for accrual), `window_commit_bid{escrow}` (`ZeroEscrow`, `NotAllowlisted`, `OrderExists`, `InsufficientUnits`; `:1516-1540`); `reveal_order` records validity instead of reverting (`isOrderValid`: price ≥ 1, qty ≥ 1, asks qty ≤ escrow, bids escrow ≥ price×qty + fee and the **owned-units wallet cap**; `:1542-1556`; 10#68 b7 "invalid (cap), never reverts").
- Multi-step settlement: `begin_window_settlement(clearingPrice | NO_MATCH)` (`SettlementNotReady`, `TallyInProgress`, rounds, `roundRejected`; `:1558-1569`), `finalize_window` with Stage 1's `tallyOrders`/`finalizeWindow` (reject / NoMatch / Settled with `branch` supply- or demand-limited; `WindowSettlementRejected`, `WindowNoMatch`, `WindowCleared`; `:1571-1597`), `process_orders` with `computeFills` (first-come at the margin, **window fee** `windowFeeBps` to the collector, allowlist re-check at fill with take-back, `OrderFilled` per order; `:1599-1655`), and on the chains the per-order `process_order` + `deliver_order` with `DeliverFirst` and the take-back rounds (SPEC.md:558-563). Stage 1's math is importable: `isOrderValid`, `tallyOrders`, `finalizeWindow`, `computeFills` in `stage1/packages/reference/src/math/window.ts:38,54,109,150` — none re-exported by `@merces/math` yet (`packages/math/src/index.ts` has no window names).
- Vector expectations read `window{period, state, tallyRound, roundRejected, clearingPrice, branch, matchedUnits, escrowStable, escrowUnits}`, `windowEscrowStable`, `windowEscrowUnits` (`view.ts:75-88`), today from runner bookkeeping (`book.ts:11-21`; VECTOR_PARITY.md:128 "shim-derived view fields").
- API consequences for the frontend ("claims from a window"): no read of **a wallet's own order** (side, escrow, revealed, valid, fill, refund, delivered) — only `PositionState.escrowedUnits` and the window's totals; no builder for the permissionless `begin_window_settlement` / `tally` / `finalize_window` / `process_order` / `deliver_order` steps (the auction has `build-step`; windows have nothing, the keeper clears); no "deliver my order now"; no indexed order history (the activity feed shows "Transfer window N opened/cleared" and "X units transferred", `projections.ts:54-55`). The S5 window API should mirror the auction's: `GET /series/{id}/window` with rounds/proposal/branch and `stage`, `GET /me/window-orders` (or `/series/{id}/window/orders/{wallet}`), `POST /series/{id}/window/build-step {signer}`, `POST /series/{id}/window/build-deliver {wallet}`, and an admin/issuer "open window for period" builder if the keeper's opening is not enough.

dev:mock today: the one-step flow is exercisable with `PUT /admin/flags/transfer_windows {enabled:true}`, `/dev/advance-time` past the 18-month lockup and to ≥14 days into a quarter, then the keeper opens (or wait one `transfer.windows` tick, hourly interval but the scheduler runs each job on its own interval), `build-commit`/`build-reveal` by two personas, `/dev/advance-time` past the reveal end, keeper clears; `/series/{id}/holders` shows the moved units (`scenarios.test.ts:337-380` does exactly this through the API). The frontend sees no clearing rounds, no fee, no per-order outcome.

Client: `getTransferWindow` has a 3-property schema (`walletCapUnits`, `noCap`, `noCapStatement`) — `window`, `phase`, `enabled` are untyped; both builders and backups are bare.

### 3.7 Attestor signing (tier 3, FX, pause, amendment, extinguishment, true-up; key linking; device tool)

| Route | operationId | tier | code |
| --- | --- | --- | --- |
| GET /attestor/me, GET /attestor/queue | attestorMe, attestorQueue | attestor | `attestor/routes.ts:21-22`, `service.ts:327-358` (queue: hardship, tier3, tier3Annual, fxRequests, amendments, extinguishments scoped to the account's registered keys) |
| Tier 3 quarterly: POST /series/{id}/tier3/{periodId} (issuer opens), GET /series/{id}/tier3 (issuer), GET /attestor/tier3/{caseId}, GET …/prefill-spec, GET …/message?priorIncomeCommitment&incomeCommitment&liquidityEvent, POST …/sign | openTier3Case, listTier3, getTier3Case, tier3PrefillSpec, tier3SigningRequest, signTier3Case | issuer / attestor | `routes.ts:59-95`, `service.ts:584-746` |
| Annual true-up: POST /series/{id}/tier3/annual (issuer), GET /attestor/tier3/annual/{id}, GET …/message?totalPaymentStable, POST …/sign | openTier3Annual, getTier3Annual, tier3AnnualSigningRequest, signTier3Annual | issuer / attestor | `routes.ts:50-83`, `service.ts:771-928` (TRUEUP signature stored; nothing submits it) |
| FX: GET /attestor/fx-requests, GET …/{id}/messages?rateWad[&attestor], POST …/{id}/sign | listFxRequests, fxSigningRequests, signFxRequest | attestor | `routes.ts:98-108`, `service.ts:965-1070` (one FX signature per covered series) |
