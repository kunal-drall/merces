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
| Report-verifier ed25519 | KMS port (`LocalKms` for development; cloud KMS in production, Part J.2). Public key registered onchain by the multisig. | Sign `{series, period, income_commitment, tier, source}` after verifying a zkTLS proof | Sign anything else; the verifier has no database and no payload logs |
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
- Writes accept an `Idempotency-Key`; a key replayed with a different body is a 409.

## The report verifier (most sensitive component)

It unavoidably sees the attested income figure in memory. Controls: a separate process and port; no database; logs
carry request id, route, outcome code and duration only; the input schema is validated before any processing; the
only output is a signature over the commitment tuple; the signing key lives behind the KMS port. Devices send proofs
to it directly, never through the API, so the API process never sees income or salts. If Reclaim's hash-attesting
providers (`responseRedactions[].hash`) are adopted (Part J.3), the verifier can stop seeing figures entirely.

## Chain safety

- Live adapters refuse mainnet (Solana mainnet-beta URLs and mints; EVM chain ids 1, 10, 56, 137, 143, 8453, 42161,
  43114) at construction time.
- Money-bearing reads and the event stream use finalized commitment; `confirmed` events are parked, never projected.
- `auto` mode uses a live adapter only when a manifest entry exists and a health check (RPC reachable, programs or
  contracts deployed) passes; otherwise the simulator. The decision is logged per chain.

## Privacy controls (summary; see PRIVACY.md)

No income figure, income document, hardship reason or identity document is persisted or logged. The logger redacts
income-bearing keys at the sink. The canary test pushes distinctive values through every income flow and scans every
table, the captured logs, the outbox and error reports; finding one fails CI.

## Reporting a vulnerability

Open a private security advisory on the repository or write to the maintainers listed in README.md. Please do not
file public issues for security problems.
