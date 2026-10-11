# SECURITY.md

Threat model, controls and what the backend can never do. Companion to PRIVACY.md (data) and RUNBOOK.md (operations).

## What the backend is, and is not

Merces Stage 2 is software and a protocol: an indexer, an API and a set of keepers around onchain programs. It is not
a lender or a broker, and it is **never a custodian**:

- It holds no user funds and has no code path that moves them. Every state change on a user's behalf is an
  **unsigned transaction** (`ChainPort.build`) that the user's wallet signs; `POST /tx/send` relays a user-signed
  transaction and refuses one whose signer is not one of the caller's linked wallets.
- Its own keys are low-privilege: a **keeper** fee payer that can only call permissionless functions (settlement and
  delivery, the Retired burn, a curve's completion, proceeds collection and census, cranks, snapshots; never a holder's
  stake, unstake, tender or claim), and an **allowlist manager** that can only add or remove eligibility. Neither can touch terms,
  move treasury or vault funds, or block claims, redemption or releases (C12). Removal from the allowlist never strands
  value: the chain keeps claims, redemption and window sells open (on a curve also unstaking and the tender of a
  registered holder; only a new registration or stake needs the allowlist).
- Admin actions (register attestors and verifier keys, pause new raises, fee collector, templates, flags) are built
  for the **protocol multisig**; the backend records the request and never signs it. The simulator stands in for the
  multisig with one admin address in mock mode only.
- `private_payouts` can never be enabled through the admin API; it is "coming soon" and the claim builder sits behind
  `PayoutClaimBuilder` so a private implementation can be added without touching accounting.

## Keys

| Key | Where | Can | Cannot |
| --- | --- | --- | --- |
| Report-verifier secp256k1 (S4 WP6, D10) | KMS port, algorithm configured (`LocalKms` for development; a cloud KMS in production once the owner chooses AWS or GCP, S4 owner question 1; until then the standalone verifier refuses any other provider). Its 20-byte address is registered onchain as a verifier key by the multisig (`registerVerifierKey`), and pinned in the verifier's configuration (`REPORT_VERIFIER_ADDRESS`): the verifier refuses to start when the KMS key's address differs. | Sign Stage 1's `MERCES_REPORT_V1` with tier 2 (the series' chain's signing domain from the verifier's own table `MERCES_VERIFIER_CHAINS`, the series key, period, prior and income commitments, liquidity flag) after verifying a zkTLS proof and the prior opening. It builds every digest itself from typed fields: no route signs a digest a caller supplies. Every domain of its table is checked against the signing allow-list at startup and again before each signature (never mainnet; local ids only in development). Development (`MERCES_VERIFIER_DEV=true`: the published dev seed, no address pin) is the simulator only: the verifier refuses to start when its table holds any chain but a local id (Solana localnet 104, EVM 31337), a testnet included, and a dev verifier refuses a non-local domain at every signature. The proof's source is checked against the request but is not signed (A-REV-1, B7); the liquidity flag is the one the device declares (owner question 1 open since S1) | Sign anything else; sign for a chain off its table or a mainnet; the verifier has no database and no payload logs |
| Attestor keys (S4 WP7, WP8, D2, D4) | never in the backend: each attestor's own machine, in the Merces attestor tool (`merces-attestor`, S4 WP8: a Web3 Secret Storage v3 keystore at scrypt n ≥ 2^18, "Attestor signing" below; a hardware wallet can make the EIP-191 link proof but cannot sign Stage 1's raw digests). The backend stores the key's 20-byte address and its link to an account (`account_signer_keys`), never key material; dev and test attestor keys are published simulator keys (seeds `sim-attestor:*`, `merces-dev-attestor:*`), linked only while every chain is the simulator | Prove control of the key (EIP-191 link challenge) and, through S4 WP9-WP13, sign Stage 1's attestor messages on the device, each over a digest the device rebuilt from typed fields under its own pinned network table | Be held, used or rebuilt by the server, an admin or the keeper; act on a chain that has not registered it; sign for a mainnet or a network the device has not pinned |
| Keeper fee payer (per chain) | KMS port | Submit permissionless cranks | Any user action |
| Allowlist manager (per chain) | KMS port | `setAllowlist` | Freeze or seize units, block claims |
| Session HMAC secret | environment | Sign API session tokens | — |
| Vault key (AES-256-GCM) | environment / KMS | Encrypt private terms, application notes, signed contracts | Decrypt end-to-end attestor documents (the server never holds those keys) |

Secrets never enter the repository: `.env.example` lists names only; development seeds are marked
"not-for-production"; the local KMS derives deterministic dev keys from a seed so restarts keep them.

## Authentication and authorisation

- Sign-in is a wallet signature over a domain-bound, nonce-bound message (Solana ed25519; EVM EIP-191); nonces
  expire in ten minutes and are single-use. One account can link both wallet families; a wallet cannot belong to two
  accounts. Simulator signatures are accepted only in mock mode.
- Attestor keys are linked separately (S4 WP7, D4): a one-time challenge (`POST /me/signer-keys/challenge`) bound to the
  host, the account, the key and a nonce, signed with the key itself (EIP-191, checked with viem; a simulator signature
  is never accepted, in any mode), spent once (`POST /me/signer-keys`). Every nonce names its purpose: sign-in accepts
  only a sign-in nonce, the key link only a key-link challenge issued to that account for that key (amendment fix 2), so
  a signed link challenge can never sign anyone in, and a sign-in (even with an EVM wallet at a key's address) never
  links a key. A key belongs to one account. A link proof's EIP-191 digest (pre-image 0x19…) can never equal a Stage 1
  `MERCES_*` digest, so it is never an attestation. Linking grants nothing by itself.
- Every route declares an access tier (`public | account | backer | holder | issuer | attestor | admin | …`) that is
  enforced before the handler runs and written into `openapi.yaml` as `x-access`. The contract check fails CI when a
  route and the spec disagree; the H3 matrix test calls every operation anonymously, as a backer, as an ineligible
  account and as a signed-in stranger and asserts the declared tier.
- Admin and attestor actions are written to an append-only `audit_log` (a trigger forbids update and delete).
- Writes accept an `Idempotency-Key`, scoped to the calling account: a replay only ever returns the caller's own
  earlier response, never another account's. The key is reserved before the write runs, so a concurrent duplicate gets
  a 409 ("still in progress") instead of executing twice; a failed write releases the key. A key replayed with a
  different body is a 409.
  Stored replays are redacted: a response that carried decrypted vault material (application notes) is persisted
  with that field nulled, so the idempotency table never duplicates vault plaintext.
- The `attestor` tier is the indexed onchain registry, read live per key (S4 WP7): a key linked to the session's account
  must be registered and active in `attestors`; the token's wallets and roles never decide it. Proposing a key grants
  nothing; an indexed revocation or unlinking the key ends access at once (A-M5-2). Each case, document or decision
  also requires the addressed key itself to be linked to the account and active and indexed on the item's chain.
  Since S4 WP5 a deactivation is Stage 1's forward-only revocation (A-SIG-4): the chain still accepts the revoked key's
  report (tier 3) and FX signatures for periods that ended by its revocation until 45 days after it (Stage 1's design,
  so no revocation manufactures lateness), and never its pause, amendment or extinguishment signatures. A compromised
  key's in-flight report and FX signatures therefore stay usable for that window: the residual risk is accepted as
  Stage 1 designed it (S4 owner question 3's default), and the RUNBOOK's key section says to check the reports accepted
  under a revoked key. The last active attestor key of a chain cannot be revoked (both chains): rotate instead.
  The report verifier's keys follow the same registry (S4 WP6): a revoked verifier key's tier-2 attestations of periods
  that ended by its revocation stay valid onchain for 45 days, so a compromised verifier key is the same residual risk
  (only the issuer can submit a report, and the RUNBOOK's check of reports accepted under a revoked key covers both).
- The `holder` tier means holding or having held units of the series (a position row, so a seller can still claim what
  accrued); a bid alone never grants it, so losing or refunded bidders do not see the holder list or payment amounts.
- Session tokens are HMAC-signed with `MERCES_SESSION_SECRET`. The published development default is accepted only
  while every chain is the simulator; with any live chain the API and keepers refuse to start without a strong secret
  (the same rule covers the vault key and the local KMS seed). The report verifier, whose key is the one registered
  onchain, refuses the dev seed unless `MERCES_VERIFIER_DEV=true` is set explicitly and every chain of its own table is
  a local id (Solana localnet 104, EVM 31337); with any live chain in the table, a testnet included,
  `MERCES_VERIFIER_DEV=true` stops it at boot. The simulator harness's and the vector runner's test keys sign for the
  local ids only.
- Backer-tier access is decided by a live read of the `eligibility` table on every request, never by the session
  token's `eligible` flag: a revoke takes effect on the next request. Private terms have no admin bypass.

## Attestor signing (S4 WP8, no custody)

- The attestor's key never leaves the attestor's machine (S4 D2, A-SIG-2): the Merces attestor tool
  (`@merces/poi-device`, bin `merces-attestor`) keeps it in a Web3 Secret Storage v3 keystore. Every keystore it writes
  uses go-ethereum's standard scrypt strength (n = 2^18, r = 8, p = 1); a lower n is refused outside the test harness
  (`VITEST=true` or `NODE_ENV=test`), and the tool signs only with a keystore at that strength (a lighter one is
  re-encrypted by `import`). The MAC is checked in constant time before decryption. The password is read from the
  terminal with echo off; `--password-env` exists for scripted tests and is documented as exposed through
  `/proc/<pid>/environ` and shell history. No command prints the key, errors name no value, and the in-memory key
  object prints its address only.
- The tool never trusts a signing request: the request's chain must be in the device's own pinned network table with
  exactly the pinned domain (the table itself refuses any mainnet, any network off the signing allow-list and any domain
  that is not the hash of its fields; the simulator's local ids only with `--allow-local`), the series key is recomputed
  from the series id, Stage 1's pre-image and digest are rebuilt from the typed fields and any difference is refused, and
  only the rebuilt digest is signed (a structural rule: only an object the check returned can be signed). It never
  signs a tier-2 REPORT (the report verifier's key) and signs EIP-191 text only when it is exactly the API's key-link
  challenge for that key. What the attestor reads is built from the typed fields alone: a request carries no display
  text of the server's, and a request with any extra field is refused. Before a PAUSE or an EXTINGUISH it states that the
  signature cannot be recalled.
- **Residual risks** (S4; owner question 3's default is to accept and document them):
  - The tool cannot yet check a nonce against the chain. A compromised API could collect a PAUSE signature over a future
    pause nonce (N + 1), which approves whatever request N + 1 turns out to be, or EXTINGUISH signatures (nonce 0),
    which stay valid until used or the key is revoked. The tool shows the nonce and says it cannot check it; on live
    chains it is to read the nonce from a public RPC itself (S5, with the live adapters).
  - Unrelayed PAUSE, AMEND and EXTINGUISH signatures are bearer authorisations (S4 amendment D2): anyone holding one can
    submit it. Stored ones are readable only by the signer's account, the series' issuer where the flow needs it
    (AMEND) and admins, never in a public read, the activity feed or a notification (S4 WP10-WP12). A leaked one is
    withdrawn only by rotating the key (the RUNBOOK's attestor key rotation).
  - A raw-digest key signs any 32 bytes. The key is dedicated and never funded, and the tool signs only digests it
    rebuilt; the expert fallback (`cast wallet sign --no-hash`) signs blind and is documented as such.

## Report proofs

- Reports carry Stage 1's ProofOfIncome proof: Groth16 over BN254 (`stage1/circuits`), six public signals in Stage 1's
  order. The issuer's device proves with fresh randomness; the API verifies before it builds `submitReport`, and every
  simulated chain verifies again before its engine runs (the ports' `Groth16ReportVerifier`), then checks the six
  signals against its own state (terms commitment, units, FX rate, the prior chain, the payment). The Stage 1 vector
  runner uses the same verifier.
- **The proving key is a development key.** It comes from Stage 1's development trusted setup with a public beacon
  (`stage1/circuits/build/MANIFEST.txt`): anyone can forge proofs with it. It is fit for the simulator, devnet and
  testnet only and must be replaced by a real ceremony before mainnet (Stage 1 A37); mainnet is refused anyway.
  `GET /prover/artifacts` says so (`trustedSetup: "development"`), and every served file is checked against the
  build manifest's sha256.
- **Mock proofs are development-only.** The mock system is a digest over the six public signals, so anyone can compute
  one. The simulator engine refuses mock proofs by default (`acceptMockProofs: false`); tests and the harness opt in
  explicitly. A process accepts them only with `MERCES_PROOF_SYSTEM=mock` while every chain resolves to the simulator;
  it logs a warning at startup, and a process with a live chain refuses to start with it set. Never on a live chain.
- Stage 1 error messages can embed the values they range-check, so calls into Stage 1's math, prover and verifier are
  wrapped (`guardStage1` in the engine, `paymentStable` in `@merces/math`, error codes in the device and the verifier):
  errors carry codes and Stage 1 error names (`detail.stage1`), never a submitted value. The canary covers it: a
  year-to-date figure of 2^64 or more at the device and the verifier, and a report for an ended, chained period with a
  payment of 2^64 or more at the API's wrap of the circuit's range check. Each probe pins the exact status, error code
  and message, so a probe stopped by an earlier check (for example "the period has not ended") fails the canary.

## The report verifier (most sensitive component)

It unavoidably sees the attested income figure in memory, and for tier 2 the prior quarter's opening. Controls: a separate process and port; no database; logs
carry request id, route, outcome code and duration only; the input schema is validated before any processing; the
only output is Stage 1's REPORT signature over the attestation fields (commitments, tier, liquidity flag; never a figure), over a digest it builds itself for a chain of its own table; the secp256k1 signing key lives behind the KMS port, pinned by address. A prior attestation is accepted from its current address, or from a previous one (`REPORT_VERIFIER_PREVIOUS_ADDRESSES`) only for a quarter that ended at or before that address was retired, so a rotated-out key cannot vouch for later quarters; a compromised key is never listed (RUNBOOK "Report verifier key"). Devices send proofs
to it directly, never through the API, so the API process never sees income or salts. If Reclaim's hash-attesting
providers (`responseRedactions[].hash`) are adopted (Part J.3), the verifier can stop seeing figures entirely.

## Chain safety

- Mainnet is refused in every mode, failing closed. Solana accepts only devnet, testnet or loopback localnet and checks
  the RPC's genesis hash against the configured cluster (the mainnet-beta hash is always refused). EVM accepts only chain
  ids on the testnet allow-list (`EVM_TESTNET_CHAIN_IDS`, in `@merces/domain` signing.ts since S4 with its mainnet
  tripwire seeded from Stage 1's constants; every signer refuses a mainnet domain through the same list) and checks the
  RPC serves that id; the list grows only by a reviewed code change. A refusal stops the process under `live`; under `auto` the chain stays on the simulator.
- Money-bearing reads and the event stream use finalized commitment; `confirmed` events are parked, never projected.
- `auto` mode uses a live adapter only when a manifest entry exists, a health check (RPC reachable, network allowed,
  programs or contracts deployed) passes, and the adapter is wired to the generated Stage 1 clients; otherwise the
  simulator. The decision is logged per chain.

## Privacy controls (summary; see PRIVACY.md)

No income figure, income document, hardship reason or identity document is persisted or logged. The logger redacts
income-bearing keys at the sink, with Stage 1's openings and private terms (salts, θ, r, the share rate, the device
secret), and error messages carry no values. A tier-3 opening is accepted only as a merces-e2e v1 envelope sealed for the
attestor (PRIVACY.md). The canary test pushes distinctive values through every income flow and scans every table, the
captured logs, the outbox and error reports, in decimal, hex and base64; finding one fails CI.

## Reporting a vulnerability

Open a private security advisory on the repository or write to the maintainers listed in README.md. Please do not
file public issues for security problems.
