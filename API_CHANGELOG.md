# API changelog

The frontend builds against this API. **Every push lists every changed or removed operation and field** of
`packages/api/openapi.yaml` (additions too, as a courtesy), newest first. A work package appends its changes under
`## Unreleased`; whoever pushes renames that heading to the push's commit. `pnpm openapi:check` prints the operation
count; `API.md` is the narrative; `packages/client/src/generated/openapi.d.ts` is regenerated with `pnpm openapi:client`.
Generate a revision diff with `pnpm api:changelog <from-rev> <to-rev>`.

## Unreleased

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
