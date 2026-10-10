# SECURITY.md

Threat model, controls and what the backend can never do. Companion to PRIVACY.md (data) and RUNBOOK.md (operations).

## What the backend is, and is not

Merces Stage 2 is software and a protocol: an indexer, an API and a set of keepers around onchain programs. It is not
a lender or a broker, and it is **never a custodian**:

- It holds no user funds and has no code path that moves them. Every state change on a user's behalf is an
  **unsigned transaction** (`ChainPort.build`) that the user's wallet signs; `POST /tx/send` relays a user-signed
  transaction and refuses one whose signer is not one of the caller's linked wallets.
- Its own keys are low-privilege: a **keeper** fee payer that can only call permissionless functions (settlement,
  cranks, snapshots), and an **allowlist manager** that can only add or remove eligibility. Neither can touch terms,
  move treasury or vault funds, or block claims, redemption or releases (C12). Removal from the allowlist never strands
  value: the chain keeps claims, redemption and window sells open.
- Admin actions (register attestors and verifier keys, pause new raises, fee collector, templates, flags) are built
  for the **protocol multisig**; the backend records the request and never signs it. The simulator stands in for the
  multisig with one admin address in mock mode only.
- `private_payouts` can never be enabled through the admin API; it is "coming soon" and the claim builder sits behind
  `PayoutClaimBuilder` so a private implementation can be added without touching accounting.

## Keys

| Key | Where | Can | Cannot |
| --- | --- | --- | --- |
| Report-verifier ed25519 | KMS port (`LocalKms` for development; cloud KMS in production, Part J.2). Public key registered onchain by the multisig. | Sign attestation v1 `{series, period, prior_income_commitment, income_commitment, tier, liquidity_event}` after verifying a zkTLS proof and the prior opening. The proof's source is checked against the request but is not signed (A-REV-1, B7); the liquidity flag is the one the device declares (owner question 1). S4 moves it to Stage 1's secp256k1 key and `MERCES_REPORT_V1` bytes | Sign anything else; the verifier has no database and no payload logs |
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
- The `attestor` tier is the indexed onchain registry, read live: a wallet of the session must be registered and
  active in `attestors`. Proposing an attestor grants nothing; an indexed deactivation ends access at once (A-M5-2).
  Each case, document or decision also requires the addressed wallet itself to be active and indexed on its chain.
- The `holder` tier means holding or having held units of the series (a position row, so a seller can still claim what
  accrued); a bid alone never grants it, so losing or refunded bidders do not see the holder list or payment amounts.
- Session tokens are HMAC-signed with `MERCES_SESSION_SECRET`. The published development default is accepted only
  while every chain is the simulator; with any live chain the API and keepers refuse to start without a strong secret
  (the same rule covers the vault key and the local KMS seed). The report verifier refuses the dev seed unless
  `MERCES_VERIFIER_DEV=true` is set explicitly, because its key is the one registered onchain.
- Backer-tier access is decided by a live read of the `eligibility` table on every request, never by the session
  token's `eligible` flag: a revoke takes effect on the next request. Private terms have no admin bypass.

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
  errors carry codes and Stage 1 error names (`detail.stage1`), never a submitted value. The canary covers it.

## The report verifier (most sensitive component)

It unavoidably sees the attested income figure in memory, and for tier 2 the prior quarter's opening. Controls: a separate process and port; no database; logs
carry request id, route, outcome code and duration only; the input schema is validated before any processing; the
only output is a signature over the attestation fields (commitments, tier, liquidity flag; never a figure); the signing key lives behind the KMS port. Devices send proofs
to it directly, never through the API, so the API process never sees income or salts. If Reclaim's hash-attesting
providers (`responseRedactions[].hash`) are adopted (Part J.3), the verifier can stop seeing figures entirely.

## Chain safety

- Mainnet is refused in every mode, failing closed. Solana accepts only devnet, testnet or loopback localnet and checks
  the RPC's genesis hash against the configured cluster (the mainnet-beta hash is always refused). EVM accepts only chain
  ids on the testnet allow-list (`EVM_TESTNET_CHAIN_IDS`) and checks the RPC serves that id; the list grows only by a
  reviewed code change. A refusal stops the process under `live`; under `auto` the chain stays on the simulator.
- Money-bearing reads and the event stream use finalized commitment; `confirmed` events are parked, never projected.
- `auto` mode uses a live adapter only when a manifest entry exists, a health check (RPC reachable, network allowed,
  programs or contracts deployed) passes, and the adapter is wired to the generated Stage 1 clients; otherwise the
  simulator. The decision is logged per chain.

## Privacy controls (summary; see PRIVACY.md)

No income figure, income document, hardship reason or identity document is persisted or logged. The logger redacts
income-bearing keys at the sink. The canary test pushes distinctive values through every income flow and scans every
table, the captured logs, the outbox and error reports; finding one fails CI.

## Reporting a vulnerability

Open a private security advisory on the repository or write to the maintainers listed in README.md. Please do not
file public issues for security problems.
