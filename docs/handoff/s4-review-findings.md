# S4 cross-cutting review: findings to fix (handoff)

The S4 review (four reviewers over the diff `9ecccbc..8837dba`, in an isolated worktree) finished its finding pass; its
sceptic pass died on the account's weekly usage limit, so the findings below were judged by the orchestrator instead:
**all eleven are real enough to act on; none was a false positive at the level that matters.** Fix 1–5 first (money and
access), then 6–11. Each entry: what, where (at `8837dba`; re-read, line numbers move), how to fix. The two highs come
with reproduction probes the reviewers wrote; the scenarios are reproducible from the descriptions alone.

## 1. HIGH: rotating or revoking an attestor key strands open work addressed to it

- **Where:** `packages/services/src/attestor/service.ts` (every read and decision checks the addressed key itself:
  `actsAs(session, chain, c.attestor)` at ~:576/703/793/858/885/426/464/497; extinguish checks ~:1195-1211, :1235-1241);
  migration 029 `extinguishment_requests_open` unique index (one open request per series); `attestor/routes.ts` has
  only open/get/message/sign; `admin/service.ts` `revokeAttestor`/`rotateAttestor` check no open work; RUNBOOK.md ~:174,
  :203, :360 describe remedies the API cannot perform.
- **Scenario (reproduced):** an extinguishment names `kOld` as co-attestor and a tier-3 case is addressed to `kOld`; the
  attestor rotates `kOld`→`kNew` (same account, as the RUNBOOK says). Afterwards: `GET /attestor/extinguish/{id}/message`
  403, `?attestor=kNew` 422 "does not name that key"; a new extinguishment for the series 409 "already open"; the tier-3
  case 403 and a new case for the quarter 409 "already open"; `DELETE /me/signer-keys/kOld` 409 `open-work` with no
  hand-over. The series' extinguishment path and that quarter's tier-3 attestation are blocked for good; sequential
  reporting keeps the series Late. Same for an open annual attestation, a co-attestor who never signs, and work
  addressed to a registered key no account has linked (`requestHardship`, `openTier3Case`, `openAnnual` check only the
  indexed registry).
- **Fix:** add a withdraw path (requester or admin) for an extinguishment request (`collecting`/`ready`: drops the stored
  signatures), a tier-3 case (`open`, or `signed` with no report accepted) and an annual attestation (`open`, or `signed`
  and not submitted); let a rotation re-address open items from `from` to `to` (rotate already requires the same linked
  account); make admin revoke/rotate list (or refuse) open work; require the addressed key to be linked to an account when
  a hardship, tier-3 or annual item is opened; correct the RUNBOOK lines. Tests for each path.

## 2. HIGH: a stored FX or tier-3 signature whose key passed Stage 1's grace cannot be replaced

- **Where:** `attestor/service.ts` `signFxRequest` ~:1034 (409 `already-signed`), `fxMessages` ~:1000 (`fxUnsigned`
  skips any series with a stored signature), tier-3 dup check ~:595 (`state in ('open','signed')`), `signAnnual` ~:886
  (state must be `open`); `poi/service.ts` ~:218, :257 (`verifySigned` refuses the stored signature with 422
  `InvalidAttestorSignature` once `keyUsable` fails); `GET /series/{id}/reporting/fx-fallback/{period}` still says
  `seriesSigned: true`.
- **Scenario (reproduced):** an attestor signs the EUR/USD fallback for 2026Q1 for a series; the key is revoked; the issuer
  reports more than 45 days after `revokedAt`. The stored signature is dead, no live key can replace it (messages `[]`,
  sign 409), so the period can never be reported with the attestor basis and every later period is blocked. Same for a
  signed tier-3 case and a signed annual TRUEUP after a rotation.
- **Fix:** treat a stored signature whose key is no longer usable for its period (`keyUsable` with `reportPeriod`
  against the chain's `getSignerKey`) as absent: `fxUnsigned`/`signFxRequest` accept a replacement at the same rate from a
  usable key; a tier-3 case or annual whose signature died goes back to `open` (or can be withdrawn) so it can be signed
  again; `seriesSigned` reflects usability. Tests: inside and outside the grace.

## 3. MEDIUM: `PauseApproved` is not projected onto `hardship_requests`

- **Where:** `packages/indexer/src/projections.ts` ~:562 (`case 'PauseApproved': case 'PauseEnded': break;`); only
  `PauseRequested`/`PauseRequestWithdrawn` touch the table (~:541-560).
- **Scenario (reproduced):** the attestor's PAUSE signature is relayed by someone other than `decideHardship`
  (`approve_pause` is permissionless; the device prints the signature), or the relay lands but its DB transaction fails.
  The chain pauses; the row stays `pending`; `decide` → 409 PauseNotRequested; after the pause a new hardship request is
  409 "already pending"; the only way out records a wrong "rejected" decision. The extinguishment projection already
  handles this case (~:425-430); the pause one does not.
- **Fix:** in the `PauseApproved` projection mark the series' pending hardship row approved (`approved_until` from the
  event's `until`, `decision_code 'approved'`, `pause_nonce` from the row), matching by chain and series as the withdrawn
  projection does; leave `approval`/`relay_tx` null unless the relay itself recorded them (the migration-027 relay check).

## 4. MEDIUM: the true-up adjustment mixes chain completeness with a lagging read model

- **Where:** `attestor/service.ts` `trueUpBasis` ~:820-825: completeness from the chain (`series.reporting.lastAcceptedPeriod`),
  "paid on estimate" from the read-model `periods` table; `signAnnual` recomputes from the same lagging source.
- **Scenario (reproduced on monad):** Q4's report is accepted onchain before the indexer projects it; the year counts as
  complete, the estimate misses Q4, the adjustment is +1,000 USDC instead of 0, the signature is accepted and stored
  `signed`, and after the indexer catches up it cannot be re-signed or withdrawn (409 "annual attestation is signed").
- **Fix:** one consistent source: compute the estimate from the chain's period reads (as the D13 bound already does with
  `chain.getPeriod` ~:839-843), or 409 (retry later) while the read model's last report-accepted period for the year is
  behind the chain's `lastAcceptedPeriod`. Plus the reopen path of finding 1.

## 5. MEDIUM: published test attestor keys can be linked and proposed on a live deployment

- **Where:** `packages/services/src/identity/service.ts` `linkSignerKey` ~:139-160 (checks only nonce, account, EIP-191
  signature); the admin proposal and the attestor tool's keygen/import have no published-key check; the only simulator-only
  guard is `seedSignerKeys` (~:197-201). SECURITY.md ~:31 and PRIVACY.md ~:161 promise more than the code does.
- **Scenario:** with Monad testnet live, any account links the address of `deriveTestPrivateKey('sim-attestor:attestor-1')`,
  `merces-dev-attestor:<n>`, a Stage 1 known-answer `testKey` or a vector key (all public), an admin proposes it, the
  multisig registers it: anyone can then sign PAUSE, AMEND or EXTINGUISH with it.
- **Fix:** a denylist of published key addresses (the `sim-attestor:*`, `sim-verifier:*`, `merces-dev-attestor:1..N`
  seeds the code uses, Stage 1's known-answer `testKeys`, every vector's keys; derive the addresses at startup from the
  seeds and the submodule), refused while any chain is live in `linkSignerKey`, `POST /admin/attestors` (and rotate), the
  verifier-key routes, and the attestor tool's import. Test with a live chain configured. The ground rule ("published test
  keys refused when any chain is live") requires it.

## 6. LOW: DIV-S1I-2 misses a second reference/chain difference that S4d depends on

- **Where:** `packages/stage1-sync/src/stage1-vectors/divergences.ts` ~:67-80; STAGE1_INTEGRATION.md register row;
  `S4d_last_attestor_key.json` description; asks 6 and 7.
- **What:** Stage 1's reference `revoke_attestor`/`revoke_verifier_key` (simulator.ts:538-546) do no check at all: a
  revoke of an already-revoked or never-registered key succeeds and moves `revokedAt` forward (re-opening the 45-day
  grace), while both chains refuse (`KeyAlreadyRevoked`, lib.rs:241; `KeyNotRegistered`, MercesRegistry.sol:328). S4d's
  #37 re-revokes attestor2, so S4d would still fail on the reference after Stage 1 adds the last-key rule.
- **Fix:** widen DIV-S1I-2 or add DIV-S1I-4 (re-revocation of an inactive key), cite the three sources, correct the "Lifting
  it" text to require both rules, update S4d's description and the register row; ask Stage 1 to refuse re-revocation in
  the reference because moving `revokedAt` changes the grace window.

## 7. LOW: VectorKeyring does not check the `<vector>:<name>` seed, and registered-only keys are never checked

- **Where:** `stage1-vectors/keys.ts` ~:41-44 (checks derivation and address, not that `seed === "<vector>:<name>"`);
  `actors.ts` `keyAddress()` and `ops/registry.ts` register `keys[name].address` after a shape check only.
  VERSIONS.md ~:38 and the S4 results claim the runner checks the seeds.
- **Fix:** require `vk.seed === \`${vector.name}:${name}\`` in `VectorKeyring` and at registration; run the derivation and
  address check on every key at world creation (our scenario loader already does: `scenarios.ts` `scenarioKeys`).

## 8. LOW: a pending pause request outlives a terminal transition (a Stage 1 chain-level divergence)

- **Where:** ours: `simulator/src/engine/status.ts` `approvePause` ~:172-190 and `withdrawPauseRequest` ~:145-155 have
  no terminal check; `terminal.ts` ~:125-127 and `redemption.ts` ~:99 never reset `ledger.pauseRequested`;
  `attestor/service.ts` `approvableHardship` ~:436-454 has no status check; no projection closes pending hardship rows
  on a terminal status. Stage 1: Solana clears `pause_requested` at redeem/retire/extinguish (exit.rs:146, common.rs:466-472,
  :683, exit.rs:279) and refuses `approve_pause` on a terminal series (income.rs:1011-1018); the EVM and the reference
  never clear it and accept the approval (MercesIncome.sol:477/489/517, :684-694; simulator.ts:656-667, :1284-1297).
- **Consequence:** on our simulator and the EVM a hardship request pending at redemption can still be approved and relayed,
  which cuts the late accrual owed to holders on tail dues; on Solana the relay reverts and the row stays pending forever.
- **Fix:** record the chain-level divergence (Solana vs EVM/reference) in the register and the adapter notes; refuse in
  `approvableHardship` and `hardshipMessage` a series whose status is Retired, Redeemed or Extinguished (409, stage1
  `TerminalStatus`), as `requestHardship` does; have the indexer close pending hardship rows (`series-terminal`) on a
  `StatusChanged` to a terminal status. Optional (POLISH_LATER): the solana personality clears the request at exit as its
  chain does.

## 9. LOW: TRUEUP signatures for several years of one series are captured over the same nonce

- **Where:** `attestor/service.ts` `signAnnual` ~:903-907 (checks only `live.nonces.trueup === input.trueupNonce`);
  `openAnnual` ~:771-790 deduplicates per (series, year) only; `signAnnual` requires state `open` (~:886); migration 030.
- **What:** before S5's `submit_trueup`, every series' true-up nonce is 0, so 2026's and 2027's annual rows can both be
  signed over nonce 0; after the first is submitted (nonce → 1) the second recovers to another address and is refused;
  submitted out of order, Stage 1's `last_trueup_year < year` rule kills the earlier one; no path re-signs a dead one.
  Also: the signature binds `attestationTs` = chain now at request time, and Stage 1 makes a positive true-up Late once
  unpaused time since `attestationTs` exceeds 60 days, so one captured long before S5 is Late as soon as it is submitted.
- **Fix:** at most one TRUEUP signature per series that is signed but not yet submitted (409 `earlier-trueup-pending`),
  or a re-sign path that reopens a signed row when the live nonce or `last_trueup_year` moves (a projection of S5's
  `TrueUpRecorded`); correct A-M5-5, the D13 text and SECURITY.md about `attestationTs` and the 60-day deadline.

## 10. HIGH (pre-existing, disputed): the standalone verifier accepts forgeable mock zkTLS proofs on a live chain

- **Where:** `packages/report-verifier/src/main.ts` ~:6-15 (only the `mock` zkTLS provider is wired, Part J.3);
  `env.ts` `verifierSetupFromEnv` checks the seed, the pin and the chain table but never the zkTLS provider;
  `MockZkTls` checks proofs against a secret published in the repository (`ports/src/zktls.ts` ~:137).
- **What:** with a devnet/testnet chain table, a real seed and the address pin, the verifier starts and signs a
  `MERCES_REPORT_V1` over any commitment a caller forges a mock proof for. One sceptic called it an existing, documented
  J.3 gap (testnet proofs use Stage 1's development trusted setup anyway); the other reproduced it end to end. Both are
  right; the fix is five lines and the ground rule (published secrets refused when any chain is live) asks for it.
- **Fix:** mock zkTLS is simulator-only: `verifierSetupFromEnv` (and `services/src/index.ts` for the in-process verifier)
  throw unless every chain in the table is a simulator when the zkTLS provider is `mock`; add it to OPEN_DECISIONS.md
  (default: refuse on live chains; the owner can allow it on testnet with an explicit override) and to DEPLOY_DAY.md (a
  real zkTLS provider, J.3, is needed before live reporting). Test: a devnet table with mock zkTLS refuses to start.

## 11. LOW: the retired verifier address's `retiredAt` is never checked against the current time

- **Where:** `packages/report-verifier/src/verifier.ts` ~:194 (`previousAddressesFromEnv`), ~:280 (`check()`), ~:394
  (`signedByUs`): only a positive safe integer is required.
- **What:** an operator writes `retiredAt` in milliseconds (or a future time); every period up to year 57,000 then counts as
  "ended before retirement", so a leaked retired key can forge a prior for a later quarter (and under the high-water rule a
  forged high prior zeroes the quarter's payment).
- **Fix:** in `check()`, refuse a previous address whose `retiredAt` is after the current time (small skew allowance) or
  outside a plausible unix-seconds range, with a `VerifierConfigError` that names the unit.

## Reviewer notes that are information only

- The reference emits `TermsAmended nonce` after the increment, both chains before it; lockstep compares the ledger, not
  events (recorded in STAGE1_INTEGRATION.md).
- FX grace is chain behaviour beyond the SPEC's §1.4 wording (DIV-S1I-3 cites both).
