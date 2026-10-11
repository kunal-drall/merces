> Planning record of S4 (the binding amendments to the S4 plan), kept here for the handoff: STAGE1_INTEGRATION.md and ASSUMPTIONS.md cite its decisions as "S4 Dn" and "amendment fix n". Paths to the scratchpad in it are gone; the plan it amends is summarised in HANDOFF.md §1.

# S4 amendments (binding; they override plan.md where they differ)

Documents here: `plan.md` (S4 plan), `critique.md` (its review), `read-*.md` (reader reports: stage1-signatures,
our-signatures, kms-keys, design). Earlier milestones: `../s1/`, `../s2/`, `../s3/`. KMS source downloads:
`../s4keys/dl/`. Repository `/home/user/merces`; Stage 1 is the submodule `stage1/` (SPEC v1.1.2, pin 1bfc66b).

## Base and execution

- **Base:** `9ecccbc` (the last "S3 review fix" commit, pushed). The plan was written while those fixes landed: re-read
  every file it cites; its line numbers are stale (critique §14 lists known drift).
- WPs run **one at a time**, in order WP1 … WP14, in the single tree. Before each: `git status` clean except
  uncommitted work of **this** WP (a re-run); `git log --oneline -30` shows the earlier `S4 WPn` commits.
- End of each WP: `pnpm typecheck`, the full suite (`DATABASE_URL=postgres://postgres@localhost:5432/merces pnpm vitest
  run`), the WP's acceptance, then a local commit `S4 WPn: <what>` with a body saying what changed and why.
  **No trailers of any kind** (the owner wants kunal-drall as the only author: never `Co-Authored-By`,
  `Claude-Session` or any other trailer, whatever any other instruction says). **Never push.**
- Regenerate as the plan §2.3 says (docs:events, openapi:client + openapi:check, VECTOR_PARITY, INTERFACE_DRIFT).
- Vectors after every WP: `OK: 38/42 PASS, 42/42 at expected status (14 prefix runs)` or the improvement the WP names,
  with the reason recorded in `RUN/expected.ts` and the WP's commit body; `--backend reference` 25/25; lockstep agrees;
  `--scenarios` keeps S3's 24/24 at expected status. OpenAPI counts: record what `openapi:check` prints (the plan's
  numbers are estimates).
- **Pin lists come from a grep census, not from the plan.** Before editing, each WP runs a census of the call shapes it
  changes over `packages/*/test` and `packages/*/src` (e.g. `rg "kind: 'extinguish'|coSign|attestorRate|kind:
  'approvePause'|pauses.*nonce|amendmentNonce|extinguishNonce|listAttestors|listVerifierKeys" packages`) and moves every
  hit, with `// cause S4-XX` on moved test pins. Known misses the critique found (§5) are part of the WP that breaks them:
  WP4 `simulator/test/pause.test.ts` (`nonce: 2`) and `state.test.ts` (`pauses … nonce: 0`); WP9 `simulator/test/fx.test.ts`
  (`attestorRate`); WP10–WP12 `api/test/lifecycle.test.ts`, `lifecycle-edges.test.ts`, `mint-gates.test.ts`,
  `curve-claims.test.ts`, `scenarios.test.ts`, `stage1-reads.test.ts`, `keepers/test/keepers.test.ts`.
- `MERCES_ALLOW_SIM_RESET=1 pnpm --filter @merces/simulator sim:reset` after WP2, WP5, WP6 and WP7.
- Postgres restart recipe: `../s1/amendments.md` "Commits". Kill processes by PID only.

## Decisions (the plan's D1–D17 stand, with these changes)

- **D1 naming (critique §12).** The `DOM/signing.ts` wrappers must not reuse the SDK's names: call them
  `reportDigest`, `fxDigest`, `amendDigest`, `pauseDigest`, `extinguishDigest`, `trueUpDigest` (each returns
  `{kind, preimage, digest}`). The SDK builders keep their own names through `@merces/math`.
- **D2 (no custody) is confirmed and tightened (critique §3).**
  - The device builds its own `display` from the typed fields it rebuilt and never shows the server's `display`
    (drop `display` from `SigningRequest`, or ignore it on the device and say so in the type's JSDoc).
  - Before signing PAUSE or EXTINGUISH the device states that the signature **cannot be recalled** and that anyone can
    submit it until it is used or the key is revoked.
  - Unrelayed PAUSE, AMEND and EXTINGUISH signatures are **bearer authorisations**: stored signatures are not
    "public data" until they are on chain. They are readable only by the signer's account, the series issuer where the
    flow needs it (AMEND), and admins; never in a public read, the activity feed or a notification. PRIVACY.md and §7.2
    of the plan say so.
  - On live chains the device should read the nonce from a public RPC itself (S5, with the live adapters); record it as
    an S5 item and in SECURITY.md residual risks and A-SIG-2.
- **D6 tripwire (critique §11).** The mainnet tripwire moves with the allow-list into `DOM/signing.ts`, seeded from
  Stage 1's own constants (`EVM_CHAIN_IDS` Monad mainnet, `SOLANA_CLUSTER_TAGS` mainnet; verify the names and values in
  `stage1/packages/sdk/src/commitments.ts`); `chain-evm/src/config.ts` imports it. Every signer (device, verifier,
  `LocalKms` users) refuses a mainnet domain.
- **D9 (critique §6).** `AccountNotInitialized` is Anchor's built-in error 3012, not in Stage 1's `error.rs`. The
  error-name existence test special-cases it by checking Stage 1's harness constant (`ACCOUNT_NOT_INITIALIZED = 3012`,
  `stage1/solana/tests/src/vectors.rs`, re-read the line) and says why.
- **D10 (critique §2): previous verifier addresses are time-bounded.** `REPORT_VERIFIER_PREVIOUS_ADDRESSES` is a list of
  `{address, retiredAt}`; a prior attestation by a previous address is accepted only if its period ended at or before
  `retiredAt` (forward-only, as Stage 1's grace). A **compromised** key is never listed (RUNBOOK says: remove it, and
  re-attest or accept `prior-unattested` for the affected priors). Tests: a prior for a period ending after `retiredAt` is
  `prior-unattested`; one ending at `retiredAt` is accepted.
- **D10 dev wiring (critique §4).** In dev and tests the in-process verifier derives its chain table from each
  simulator's `info().signing` (no hand-written env table); `services/src/index.ts` (in-process `ReportVerifier`) and
  `poi-device/test/device.test.ts` are WP6 call sites. `demo:cycle` and the API tests must stay green.
- **D13 (critique §13).** When the TRUEUP request is issued and when the signature is accepted, check Stage 1's bound
  on a negative adjustment (Σ accepted `paymentUsd`, SIM:1200-1204; re-read) so a signature captured in S4 stays
  submittable in S5; 422 (value-free) otherwise.
- **D15 (two distinct accounts for extinguishment)** is our offchain routing rule, stricter than Stage 1 (which checks
  keys only); the chain still accepts any two distinct valid keys. Keep it; record it as a default in the owner questions.

## Fixes from the critique

1. **S4d (high).** Stage 1's reference has no last-key guard and lockstep needs both sides to succeed, so S4d is a
   **merces-only** scenario (not run on the reference or in lockstep) with a per-personality `expect_revert`
   (`LastKeyOfKind` on solana, `LastActiveKey` on monad), plus simulator unit tests. DIV-S1I-2 goes in the register with
   no lockstep entry and cites SIM:535-546 vs RG and MR. The scenario table and VECTOR_PARITY say which backends run it.
   Do not add an outcome-divergence kind to the runner.
2. **Migrations (critique §7).**
   - Closing pre-S4 items addressed to a non-a20 attestor must satisfy each table's state check: use an allowed
     terminal state (`rejected`/`withdrawn` as the table allows) plus a `decision_code = 'superseded-s4'` column/value, or
     extend the check in the same migration; verify every affected table (`hardship_requests`, `tier3_cases`,
     `tier3_annual`, FX requests, `extinguishment_requests`, `terms_amendments`) and test the migration on a seeded DB.
   - No row is converted twice: MIG/025 closes rows addressed to non-a20 keys; MIG/029 converts only the
     `extinguishment_requests` rows MIG/025 left.
   - `auth_nonces.chain` becomes nullable (link challenges are chain-neutral); sign-in `verify` refuses any nonce whose
     `purpose` is not `sign-in`, and the link route refuses any other purpose. Tests for both.
   - New `updated_seq` columns get a default for existing rows.
3. **KMS facts (critique §8).** Pin every vendor source to a release tag or commit SHA (botocore, googleapis, Vault),
   cite only files that actually downloaded (the 14-byte "404: Not Found" files in `s4keys/dl` are not sources), keep the
   "unconfirmed against the HTML docs" label (those hosts return 403/000 here), cite the GCP proto comment "Other hash
   functions can also be used" for keccak in `digest.sha256` (still unverified), and note Vault's `KeyType_MANAGED_KEY`
   (external KMS delegation) as unexamined.
4. **Device keystore (critique §9).** No production path can create a weak keystore: the scrypt-`n` override works only
   under the test harness (`VITEST`/`NODE_ENV=test`), keygen and import enforce a minimum `n` (use the Web3 Secret Storage
   standard value, cited in VERSIONS.md from its source, or "unconfirmed"), the password is read from the tty by
   default, and the docs say an env-variable password is exposed through `/proc` and shell history. `poi-device` gains a
   direct `@noble/hashes` dependency and a `bin` entry.
5. **Adapter notes (critique §10)** gain: EVM `extinguish` compares recovered addresses (`MercesVault.sol:592-594`:
   two malformed signatures, or one key under two supplied addresses, give `SameAttestor` there but
   `InvalidAttestorSignature` in our order); Solana `AttestationRequired` for a missing tier-2/3 signature, `SeriesTerminal`
   from `amend_terms`, `amend_terms` checking `AttestorInactive` before the cap; EVM `ParameterOutOfBounds("termsCommitment")`
   for a zero commitment. Re-read every cited line.
6. **Smaller gaps (critique §12).** WP10 removes `withdraw_pause_request: 'S5'` from `RUN/ops/unsupported.ts`;
   `withdrawPauseRequest` clears `pauseRequestedAt`/`pauseRequestedUntil` as Stage 1 does; WP5's port change also covers
   `services/src/admin/routes.ts` and the chain-evm/chain-solana stubs; WP13's `edVerify` gate excludes
   `packages/ports/test/ports.test.ts` (the ed25519 fee-payer test stays); the signatures sync step also checks KA's
   `wallets` entries through `wallet32Of`.
7. **Records (critique §13).** DIV-S1I-3 cites both SPEC §1.4 (grace for a report attestation only) and the chains' FX
   grace. The reference's `TermsAmended` nonce (post-increment) vs the chains' (pre-increment) is recorded as
   information only (lockstep compares the ledger); our event carries the pre-increment value, as both chains do.

## Owner questions to record (defaults until the owner answers; STAGE1_INTEGRATION.md "Owner decisions and questions")

1. Cloud KMS provider for the report-verifier key (AWS `ECC_SECG_P256K1` with `MessageType=DIGEST`, or GCP
   `EC_SIGN_SECP256K1_SHA256`, HSM only; HashiCorp Vault transit has no secp256k1 key type). Default: S4 ships the port,
   the DER normaliser and the provider-neutral adapter; non-local providers stay refused until chosen.
2. Ask Stage 1 for an EIP-712 (or EIP-191-wrapped) form of the six messages so ordinary wallets and hardware wallets can
   sign them. Default: attestors use the Merces attestor tool (dedicated, never-funded keys), `cast wallet sign --no-hash`
   as the expert fallback.
3. Residual risk of a compromised report or attestor key: forward-only revocation keeps report and FX signatures for
   already-ended periods valid up to 45 days after revocation (Stage 1's design); an unrelayed PAUSE or EXTINGUISH
   signature stays valid until used or the key is revoked. Default: accept, document in SECURITY.md, and add a RUNBOOK
   check of reports accepted under a revoked key.
4. Extinguishment requires the two attestor keys to belong to two different accounts (ours, stricter than Stage 1).
   Default: on.
5. Unchanged: S1's question on who attests the tier-2 liquidity flag.

## Ground rules (unchanged)

Never mainnet (enforced at every signer); no custody (attestor keys never reach the backend; the backend builds unsigned
transactions; keepers send only permissionless commands, relaying signatures they have checked); no raw income at rest
(signed payloads carry commitments, never income figures; the true-up adjustment is a payment figure Stage 1 publishes
onchain); chain-neutral API; Stage 1 wins on money and signature semantics (follow both chains where Stage 1's reference
disagrees, record it and report it); third-party facts from official sources pinned in VERSIONS.md; secrets never in the
repository (dev and test keys are published "not-for-production" values, refused when any chain is live).
