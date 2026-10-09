# PRIVACY.md

A map of every personal data field: where it lives, who can read it, and when it is deleted. Ground rule: **no raw
income at rest** — income figures, income documents and hardship reasons are never written to a database, a log, a
queue or an error report. The canary test (`pnpm test:canary`) pushes distinctive values through every income flow and
scans every table, the captured logs, the outbox/jobs rows and error responses; one hit fails CI.

Retention periods are an open question (Part J.9). Until Kunal sets them, nothing is deleted automatically; the
"deleted when" column records the intended rule.

## Legend

Readers: **owner** (the account the data belongs to), **issuer** (of the series), **holder** (of the series),
**backer** (eligible), **attestor** (the chosen attestor), **admin**, **public**, **nobody** (ciphertext the server cannot
decrypt). Storage: **plain**, **vault** (AES-256-GCM under the server's vault key), **e2e** (encrypted on the client for a
specific attestor; the server never holds the key), **hash** (a commitment or digest), **none** (never stored).
An **e2e** row lists who can decrypt it. Admins can also fetch e2e ciphertext through the attestor routes (to route or
reassign a case) but hold no key, so they cannot read it.

## Income and the things derived from it

| Field | Where | Storage | Readers | Deleted when |
| --- | --- | --- | --- | --- |
| Income figure (YTD, per source) | nowhere on the server; the device computes the payment; the report verifier sees it in memory only | none | — | never exists at rest |
| Income salt | device; sent to the verifier in memory only | none | — | — |
| Income commitment | `reports.income_commitment`, onchain `ReportAccepted` | hash | issuer, holders, public (onchain) | — |
| Payment amounts (gross, fee, net, accrual) | `reports`, `periods`, `money_events`, `fees_ledger`, onchain | plain (public onchain in v1) | issuer, holders, admin; never in the public activity feed | end of retention |
| Threshold θ and rate r | `terms_vault.ciphertext`; `terms_amendments.ciphertext` | vault | issuer, eligible backers (every read logged in `terms_access_log`; eligibility read live); the reviewing attestor on an amendment. No admin bypass. | series end + retention |
| Terms commitment | `series`, `series_drafts`, onchain | hash | public | — |
| zkTLS proof (contains the figure) | never on the server; device → verifier in memory | none | — | — |
| Prover proof + public inputs | `reports.proof` (no witness) | plain | issuer, holders, admin | end of retention |
| Verifier attestation (signature over the commitment tuple) | `reports.attestation`, onchain | plain | issuer, holders, admin | — |
| Tier-3 documents (tax returns, accounting exports) | `tier3_cases.documents_ciphertext`, `tier3_annual.documents_ciphertext` | e2e | the chosen attestor only (client-side decryption); server: nobody | case closed + retention |
| Tier-3 attested payment | `tier3_cases`, `tier3_annual` (amounts only) | plain | issuer, attestor, admin | end of retention |
| Income source kinds (stripe/deel/…) | `applications.income_source_kinds`, `income_sources.kind` | plain | owner, admin | account deletion |
| Report source kind (stripe/deel/…) | `reports.source` (never in the verifier attestation or onchain) | plain | issuer, admin (holders get report rows without it) | end of retention |
| zkTLS session source kind | `zktls_sessions.source` | plain | nobody through the API (written at session start, never served) | end of retention |
| Source credentials / API keys | never (zkTLS sessions run on the device with the provider) | none | — | — |

## Hardship and personal circumstances

| Field | Where | Storage | Readers | Deleted when |
| --- | --- | --- | --- | --- |
| Hardship reason and evidence | `hardship_requests.ciphertext` | e2e | the chosen attestor only; server: nobody | decision + retention |
| Hardship state and dates | `hardship_requests` (state, until, decided_at), onchain `PauseRequested/Approved/Ended` | plain | issuer, holders (status and dates only), attestor, admin | — |
| Decision code | `hardship_requests.decision_code`, `audit_log` | plain (codes only) | attestor, admin | — |
| Extinguishment evidence | `extinguishment_requests.evidence_ciphertext` | e2e | the two attestors; server: nobody | — |

## Identity and accounts

| Field | Where | Storage | Readers | Deleted when |
| --- | --- | --- | --- | --- |
| Wallet addresses | `account_wallets`, `eligibility`, `allowlist` (indexed), onchain | plain | owner; public onchain | account deletion (chain data persists) |
| Email address | `accounts.email` | plain | owner, the email channel | account deletion / on request |
| Display name, country | `accounts`, `applications.country` | plain | owner, admin | account deletion |
| Identity documents | never (the identity-check provider holds them) | none | — | provider's policy |
| Identity check id and status | `applications.identity_check_id`, `identity_status` | plain | owner, admin | application retention |
| Application notes | `applications.notes_encrypted` | vault | owner, admin | application retention |
| Persona | `applications.persona` | plain | owner, admin | — |
| Readiness report | `applications.readiness` | plain | owner, admin | — |
| Decision reason | `applications.decision_reason_code`, `audit_log` | codes only | admin (owner sees the code) | — |
| Sign-in nonces | `auth_nonces` | plain | nobody (consumed) | 10 minutes (expiry); purge weekly |
| Session token | client only (HMAC) | none | — | 24 h expiry |

## Contracts and terms

| Field | Where | Storage | Readers | Deleted when |
| --- | --- | --- | --- | --- |
| Signed HEU contract and charter | `contract_sessions.signed_document_encrypted` | vault | the signer, admin (every read audited) | legal retention |
| Contract hash | `contract_sessions.signed_hash`, `series.contract_hash`, onchain | hash | public | — |
| Rendered (unsigned) documents | returned once to the signer; not stored | none | — | — |

## Bids and holdings

| Field | Where | Storage | Readers | Deleted when |
| --- | --- | --- | --- | --- |
| Bid price, quantity, salt | client; revealed onchain at reveal time | none until reveal (public afterwards) | — | — |
| Reveal backup | `bid_backups.ciphertext` (plaintext fields rejected) | client-encrypted | owner; server: nobody | after settlement + retention |
| Commitment, deposit | `bids`, onchain | plain | owner, issuer; public onchain | — |
| Positions, claims | `positions`, `money_events`, onchain | plain | holder, issuer, admin; public onchain | — |

## Operational data

| Field | Where | Storage | Readers | Deleted when |
| --- | --- | --- | --- | --- |
| Audit log (actor, action, target, codes) | `audit_log` (append-only) | plain | admin | never (immutable) |
| Terms access log | `terms_access_log` | plain | issuer, admin | series end + retention |
| Notifications (statuses, ids, dates) | `notifications`, `email_outbox` (mock) | plain | owner; admin views are audited | read + retention |
| Outbox payloads | `outbox` | plain (may carry amounts owed to the issuer) | admin | after dispatch + 30 days |
| Logs | process stdout | redacted (income-bearing keys censored at the sink) | operators | log retention |
| Keeper runs, reconciliation runs | `keeper_runs`, `reconciliation_runs` | plain | admin | 90 days |

## What is onchain (C11.2)

Series parameters, the terms commitment, payment amounts, statuses and events. Nothing about health, location,
relationships or career; no income figure; no reason text.

## Deletion requests

An account can request deletion of its offchain data: accounts, wallets, applications (and their encrypted notes),
notifications and preferences, backups, terms access entries that name it. Chain data, commitments, amounts,
signed contracts under legal retention and the audit log are kept. Not yet automated (Part J.9).
