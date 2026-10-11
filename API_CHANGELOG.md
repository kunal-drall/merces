# API changelog

The frontend builds against this API. **Every push lists every changed or removed operation and field** of
`packages/api/openapi.yaml` (additions too, as a courtesy), newest first. A work package appends its changes under
`## Unreleased`; whoever pushes renames that heading to the push's commit. `pnpm openapi:check` prints the operation
count; `API.md` is the narrative; `packages/client/src/generated/openapi.d.ts` is regenerated with `pnpm openapi:client`.
(A diff script, `scripts/api-changelog.mjs <from-rev> <to-rev>`, is planned: HANDOFF.md §5.3.)

## Unreleased

(nothing yet)

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
