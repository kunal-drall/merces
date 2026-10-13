# API changelog

The frontend builds against this API. **Every push lists every changed or removed operation and field** of
`packages/api/openapi.yaml` (additions too, as a courtesy), newest first. A work package appends its changes under
`## Unreleased`; whoever pushes renames that heading to the push's commit. `pnpm openapi:check` prints the operation
count; `API.md` is the narrative; `packages/client/src/generated/openapi.d.ts` is regenerated with `pnpm openapi:client`.
Generate a revision diff with `pnpm api:changelog <from-rev> <to-rev>`.

## 2026-10-13 — local provider adapters (226 operations)

- `POST /contracts/webhook/{provider}` documents a 403 response for real providers. Unsigned callbacks can only complete the test mock; DocuSign completion is checked through authenticated provider polling.
- Local provider jobs encrypt identity and e-signature payloads/results at rest. `MERCES_LOCAL_PROVIDERS=true` selects Stripe Identity, DocuSign developer signing and the reviewed Reclaim adapter, and disables synthetic identity/income/signing paths. It remains disabled until account/provider activation is complete.
- Real Reclaim proof submission uses a session-bound `{sessionId, proofs}` envelope inside the existing encrypted verifier request. No raw proof or income field is added to the hosted API. The last-transaction catalogue provider is refused because it cannot attest complete YTD income.
- Interrupted DocuSign preparation recovers the original session and transaction ID; authenticated contract status can return a fresh embedded signing URL.
- Vendor credentials and registered signing keys remain local. Adapter implementation is not evidence of live account activation; see `PROVIDER_INTEGRATIONS.md`.

## 2026-10-12 — local testnet operator (226 operations)

- Added admin `POST /admin/keepers/crank-status` (`chain`, `seriesId`) for idempotent, audited status reconciliation on a configured test series using the local keeper key.
- Added public `GET /operator/status` (online, lastSeenAt, local custody, testOnly).
- Added `POST /operator/poll` and `POST /operator/jobs/{jobId}/complete`, protected by a dedicated relay credential. Only public typed commands and encrypted verifier envelopes traverse the queue.
- Added issuer `POST /series/{seriesId}/verifier-jobs` and account `GET /operator/verifier-jobs/{jobId}`. Requests require series ownership; results require the originating account. Encrypted payloads expire after three minutes.
- Added admin `POST /admin/applications/{applicationId}/test-identity`, requiring `acknowledgeSynthetic: true` and a configured disposable test wallet. This records a synthetic identity review, never real identity verification.
- `ReportVerifierInfo` adds optional `transport` with kind `local-operator-v1`, RSA public encryption key and its registered-verifier signature. The device encrypts inputs and decrypts replies; registered signing keys remain local.
- Sign-in rejects any message differing from the issued nonce challenge. Approved applications independently confirm onchain allowlisting before recording eligibility. Existing registered issuers do not receive duplicate governance proposals.

## 2026-10-11 — explicit synthetic income demo (219 operations)

- `ReportVerifierInfo` adds optional `syntheticIncome: { testOnly: true, notice }`.
- `/income-sources` and issuer zkTLS-session responses mark the synthetic Stripe demo with `testOnly` and `notice`; only Stripe is listed in this mode and its real Reclaim provider ID is omitted.
- The isolated verifier adds `POST /synthetic/fixture` only in the explicitly enabled demo. Fixed completed-quarter data travels directly to the device, never through the API. Its `/keys` response carries the same test label.
- `MERCES_ZKTLS_PROVIDER=synthetic` plus `MERCES_TEST_INCOME=true` enables this user-requested demo only on Solana devnet and Monad testnet. Arbitrary mock zkTLS and mock Groth16 proofs remain forbidden on live networks. Real provider verification remains unimplemented.

## 2026-10-11 — explicit test-only contract signing (219 operations)

- Added issuer `POST /drafts/{draftId}/contract/test-sign`, requiring `{ testOnly: true }`.
  Disabled unless `MERCES_TEST_ESIGN=true` and the mock e-sign provider is active.
  It checks ownership and the chain's signing domain, refuses mainnet, and records a mock audit trail.
- Contract preparation/status objects add `testSigningAvailable` so the app can display the test action.
  No development route or mock zkTLS acceptance is enabled.

## d845658 — native curve setup and migration, 2026-10-11 (218 operations)

- Added issuer `POST /series/{seriesId}/curve/build-setup`: a single `createCurveConfig`,
  `createCurvePool` or `openRaise` command, restricted to the linked issuer of a Draft series.
  Public parameters are generated on the device; raw income and private keys are never accepted.
- Added account `POST /series/{seriesId}/curve/build-migration`: a linked payer plus a
  `migrateCurve` command naming the two fresh position mint accounts. Both new responses
  include `CurveNoCap`, the buyer notice and an unsigned transaction.
- `POST /series/{seriesId}/raise/build-open` also activates Draft native Solana curves;
  sealed-bid cancellation, settlement and bid routes continue to reject curves.
- `CurveState` adds optional `migrated` and `dammV2Pool`, read from Meteora state.
- `UnsignedTx` retains one funding wallet. Only the exact fresh account addresses in the
  three creation commands may add signatures. Preparation transactions remain wallet-only.
  No backend key holds or signs for a user's funds.
- Permissionless live keepers confirm DAMM v2 migration before collecting treasury proceeds.
  Simulator curves do not pretend to perform a native migration.

## Stage 5 draft terms schema correction — 2026-10-11 (213 operations)

`POST /terms/validate` and `PUT /drafts/{draftId}/terms` now share the complete
`PublicDraftTerms` request schema: all 18 accepted public fields and the same
required fields/defaults as the existing service validator. Previously the
OpenAPI request documented only `routerPublicConsent` and `fxPairId`, making
generated frontend clients reject valid drafts. Runtime validation, consent,
fees and contract behavior are unchanged. Regenerated the bundled specification
and client; contract tests check both operations against the service schema.

## 4625660 — 2026-10-11 (213 operations)

Live adapters and registry completion (213 operations):
- Added admin `POST /admin/issuers/deactivate`, with `{chain,wallet}` and a stored admin transaction request.
- Added issuer `POST /drafts/{draftId}/build-contract-hash`, with `{seriesId}`, for the signed draft's matching,
  issuer-owned Draft series. EVM creates first, then binds the contract hash; Solana binds it in the create transaction.
- `UnsignedTx` adds optional `preparations`, exact token `approvals`, and `afterCreate`. Confirm prerequisites and
  rebuild before signing the main transaction. Each transaction has exactly one wallet signer; there is no custody.
- Public issuer reads and `IssuerState` add `active`; deactivation prevents future series without affecting existing ones.
- Domain events add `ContractHashSet` and `IssuerDeactivated`. `RateSnapshot.confWad` and `.publishTime` can be null:
  Stage 1's onchain snapshot event does not publish those fields. No inferred provider metadata is stored.
- Live curve configuration validates a pre-created pool's public terms and treasury authorities; live USDG-to-USDC
  quote requests refuse the mock DEX. A live `redeem` with `maxPricePerUnit` is refused because Stage 1 has no onchain
  slippage parameter; the simulator still supports that guard. Live create fees must match the registry defaults.
- Simulator state is version 10: reset/reseed older snapshots before development startup.

Router flow (211 operations):
- Added issuer-only `GET /series/{seriesId}/router`: live receiver/held balance, YTD, checkpoints, public terms, credit
  and mint-finalization state. The linked issuer wallet is required; raw income is never indexed.
- Added account builders `POST /series/{seriesId}/router/build-route`, `/build-sweep`, `/build-close`; each requires a
  linked fee-payer wallet. Route takes an amount; close takes an ended period.
- Added issuer `POST /issuers/build-issuance` with `{chain,wallet,stopped}` for stop/resume transactions.
- Draft terms/validation accept `routerPublicConsent` (default false, required true for tier 1). `SeriesTerms.routerTerms`
  exposes the explicitly consented threshold, rate, currency/rule codes and commitment salt. Amendment builders bind
  the new public router terms as well as the commitment.
- Pure tier-1 report assembly now rejects missing checkpoints or commitments that do not match the zero-salt router
  YTD checkpoints. Domain events add value-free router notifications and `IssuanceResumed`.

Window flow:
- Added `POST /admin/protocol-flags` [admin], returning a stored request and unsigned `setFlags` transaction.
- Added `POST /series/{seriesId}/window/build-step` and `/window/build-delivery` [account]. A linked fee payer signs;
  delivery always pays the recorded owner and can target an older window.
- `GET /series/{seriesId}/window` accepts optional `windowId`, returns Stage 1 state (`Commit`, `Reveal`, `Settling`,
  `Settled`, `NoMatch`, `Done`), bounded `nextStep`, pending `deliveries` and detailed order/escrow state. Cap rounds down.
- `POST /series/{seriesId}/window/build-reveal` remains usable with the opening flag disabled.
- Domain adds explicit window commands/events, `ProtocolFlagsSet`, and `FeeTaken.kind=window`; `TransferWindowCleared`
  describes a clearing decision, with `done` only when no processing remains. Units reach wallets through delivery.


S4 recovery, S5 lifecycle and FX (203 operations, previously 190).

FX additions and changes:
- `POST /admin/fx-pairs` [admin]: `{chain,feedId,inverted,crosscheck?}` → `{request,tx}`, a write-once pair registration for the admin to sign.
- `GET /chains/{chain}/fx-pairs` [public]: `{chain,pairs}` with `pairId,feedId,inverted,crosscheck,effectivePeriod`.
- `SeriesTerms` and draft public terms (`POST /terms/validate`, `PUT /drafts/{draftId}/terms`) add nullable `fxPairId`; non-USD drafts require a registered pair, tier 1 forbids it. Public series and reporting reads use that identity.
- Commands add admin `setFxPair` and permissionless `snapshotFx`; event `FxPairSet` indexes pair configuration. `submitReport.fxBasis` and `.pair` are optional checks; the chain derives the basis from the series.
- FX coverage uses Stage 1 trading days and quarter checkpoints; deviating prices still accumulate and require attestor fallback. New schema `FxPair`.


Added:
- `POST /series/{seriesId}/tier3/annual/{annualId}/build-submit` [issuer]: returns `{tx}` carrying the stored
  attestation for the linked issuer to sign; rejects a consumed nonce, completed year, inactive key or changed basis.
- `GET /series/{seriesId}/true-up` [holder-or-issuer]: live `TrueUpState` (`nonce,lastYear,year,due,attestedAt,accrual,total,routerCredit,noticeEmitted`).
- `POST /series/{seriesId}/true-up/build-pay` [account]: `{wallet}` → `{tx,total}`, recomputed by the chain at execution.
- `POST /attestor/tier3/{caseId}/withdraw`, `/attestor/tier3/annual/{annualId}/withdraw`, and
  `/attestor/extinguish/{requestId}/withdraw` [account]: requester/admin withdrawal before chain acceptance; returns `{id,state}`.
- `POST /me/signer-keys/readdress-work` [account]: `{chain,from,to}`, confirmed same-account attestor rotation only;
  returns counts for hardship, tier3, annual and extinguishments. Clears unusable signatures and requires fresh approvals.
- `POST /series/{seriesId}/hardship/build-end` [issuer]: `{seriesId,tx}` for early pause end.
- `POST /series/{seriesId}/retirement/build-retire` and `/retirement/build-burn` [account]: `{wallet}` or
  `{wallet,holder}` → `{tx}`; permissionless transactions signed by a linked wallet.
- `POST /admin/issuers` [admin]: `{chain,wallet}` → `{requestId,tx}` for an approved issuer wallet.

Changed:
- Annual records add `recorded` and `paid` states after indexed `TrueUpRecorded`/`TrueUpPaid`; competing stale
  signatures are cleared. Terminal/future-time and active-key rules follow both Stage 1 contracts.
- Canonical commands add `submitTrueUp` and `payTrueUp`; events add `TrueUpRecorded`, `TrueUpPaid`, `TrueUpNoticeDue`.
  SeriesState adds `trueUp`. Negative adjustments are consumed as forward credit by subsequent reports.
- `POST /admin/applications/{applicationId}/decide`: issuer approval also returns `issuerRegistration: {requestId,tx}`.
  Registration requires the protocol admin signature. Direct issuer self-registration is removed; repeated admin
  registration preserves the issuer's issuance-stop state.
- `POST /admin/attestors/revoke` and `/rotate`: proposal metadata includes `openWork` counts.
- Tier-3/annual/extinguishment work is recoverable after rotation. Terminal hardship decisions now return 409
  `TerminalStatus`, and third-party `PauseApproved` events close matching pending hardship rows.
- FX queues/listing include signed requests when coverage becomes unusable or a new series needs the fixed rate.
  Replacement signatures retain the original rate; usable grace-period signatures remain untouched.
- `GET /series/{seriesId}/retirement`: adds `retirableNow`.
- `POST /series/{seriesId}/redemption/build-redeem`: body and `maxPricePerUnit` become optional; an explicit bound
  still applies. `payIn.periodId` and `.amount` are optional guards; the chain computes the open due when absent.
- Canonical `requestPause` and `PauseRequested` remove `until`; the private hardship review retains `requestedUntil`.
- Series/draft public terms add `windowCommitDuration`, `windowRevealDuration`, `windowFeeBps`, bounded by Stage 1.
  Indexed historical rows return null until replayed; new drafts default to 259200 seconds, 86400 seconds and 100 bps.
- Live enrollment and admin key proposals reject published test keys. The signing tool refuses those keys for live
  domains even with `--allow-local`. Mock zkTLS startup is simulator-only.
- Annual signing rejects another signed/unsubmitted year for the same series (`earlier-trueup-pending`); its basis
  comes from chain-accepted reports, and previous verifier retirement times must be plausible unix seconds.

New schemas: `WorkWithdrawal`, `ReaddressWork`, `ReaddressedWork`, `TrueUpState`. Client/types and domain event schema regenerated.
Simulator snapshots move to version 7; reset/reseed local simulator data before startup (RUNBOOK.md).


## S4 owner decisions, 2026-10-11 (190 operations; was 188)

Added:
- `POST /me/attestor/identity-check` [account]: start the account's attestor identity check with the provider (or return
  the passed/pending one; a failed one starts again). Returns `{provider, checkId, redirectUrl, status, startedAt, updatedAt}`.
- `GET /me/attestor/identity-check` [account]: the account's check (`status: not_started|pending|passed|failed`; a pending
  status is refreshed from the provider).

Changed:
- `GET /admin/attestors`: each row gains `identityStatus` (`not_started|pending|passed|failed|null`; null when no account
  holds the key).
- `POST /admin/attestors` and `POST /admin/attestors/rotate`: new 409 reasons `identity-not-verified` (the key's account
  has not passed the attestor identity check) and `account-already-attestor` (another key linked to the account is active
  or proposed on that chain: one attestor key per verified account and chain).
- `pnpm stage1:vectors --vector-file <path>` (CLI, not HTTP): replays a vector file by path.

Removed: nothing.

## S4 baseline, 2026-10-11 (`8837dba`, 188 operations; S3 was 170)

The S4 surface the frontend builds against. New since S3 (signatures): `GET /series/{seriesId}/signing`,
`GET /chains/{chain}/signer-keys`, `GET /chains` carries `signing`; key linking `POST /me/signer-keys/challenge`,
`POST /me/signer-keys`, `GET /me/signer-keys`, `DELETE /me/signer-keys/{address}`; admin `POST /admin/attestors/revoke`,
`/rotate`, `POST /admin/verifier-keys`, `GET`, `/revoke`, `/rotate`; attestor signing requests
`GET /attestor/tier3/{caseId}/message`, `GET /attestor/fx-requests/{requestId}/messages`,
`GET /attestor/hardship/{hardshipId}/message`, `GET /attestor/amendments/{amendmentId}/message`,
`GET /attestor/extinguish/{requestId}/message`, `POST /attestor/extinguish/{requestId}/sign`,
`GET /attestor/tier3/annual/{annualId}/message`; `POST /series/{seriesId}/hardship/build-withdraw`. Changed since S3:
attestor addresses are 20-byte `0x` keys everywhere (`attestor`, never `wallet`); `submitReport` carries
`attestation {signer, signature}` and `fxFallback`; `approvePause` and `extinguish` are permissionless commands relayed
by the keeper (the attestor posts only a signature); `UnsignedTx` has no `coSigners`; `SeriesState.nonces` replaces
`amendmentNonce`, `extinguishNonce` and `pauses.nonce`; bid and order commitments are Stage 1's keccak (compute with the
fields the server returns; a fresh 32-byte salt per bid). Full detail: `git diff 9ecccbc 8837dba -- packages/api/openapi.yaml`.

## Stage 5 public forms integration — 11 October 2026

Added `POST /forms/{form}` (`submitPublicForm`) for all five signed-out site forms, with strict per-form schemas, versioned Humanathon consent, server-only gateway authentication, durable idempotency and quotas. Returns only `{ok, duplicate}`; a successful response confirms durable intake and queueing, not delivery. Added `POST /forms/webhooks/resend` (`receiveFormsResendWebhook`) with exact-byte Svix verification and duplicate-event protection. Both routes remain unavailable until explicit enable/privacy flags and complete host configuration are present. No chain command or economic behavior changed.

## 11 October 2026 — native hardship recovery

Added issuer-only `POST /series/{seriesId}/hardship/build-request` to refresh an unsigned transaction for the existing private review. It preserves the original account, encrypted case and notification, rechecks current eligibility and attestor registration, and refuses a request already onchain. No protocol rule or pause duration changes.
