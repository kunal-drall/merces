# PRIVACY.md

A map of every personal data field: where it lives, who can read it, and when it is deleted. Ground rule: **no raw
income at rest** — income figures, income documents and hardship reasons are never written to a database, a log, a
queue or an error report. The canary test (`pnpm test:canary`) pushes distinctive values through every income flow and
scans every table, the captured logs, the outbox/jobs rows and error responses for them, written out or encoded in hex or
base64; one hit fails CI. Its error-path probes (a report whose commitment the proof does not cover, a forged proof, a
payment no u64 holds, a stray figure or opening) are sent for a period that has ended and chain from the last report,
so each reaches the check it was written for, and each pins the exact status, error code and message.

Retention periods are an open question (Part J.9). Until Kunal sets them, nothing is deleted automatically; the
"deleted when" column records the intended rule.

## Legend

Readers: **owner** (the account the data belongs to), **issuer** (of the series), **holder** (of the series),
**backer** (eligible), **attestor** (the chosen attestor, and only while its wallet is registered onchain and indexed;
a proposed attestor reads nothing), **admin**, **public**, **nobody** (ciphertext the server cannot
decrypt). Storage: **plain**, **vault** (AES-256-GCM under the server's vault key), **e2e** (encrypted on the client for a
specific attestor; the server never holds the key), **hash** (a commitment or digest), **none** (never stored).
An **e2e** row lists who can decrypt it. Admins can also fetch e2e ciphertext through the attestor routes (to route or
reassign a case) but hold no key, so they cannot read it.

## The end-to-end envelope (merces-e2e v1)

A tier-3 income opening travels only in this envelope (ASSUMPTIONS A-PRIV-3; `@merces/domain` `e2e-envelope.ts`). The
issuer's device seals it for the chosen attestor's X25519 public key (`@merces/poi-device` `sealTier3Opening`); the
attestor's device opens it (`openTier3Opening`). The wire form is base64 (standard alphabet, padded, canonical) of:

| Offset | Bytes | Field |
| --- | --- | --- |
| 0 | 1 | version `0x01`: X25519 + HKDF-SHA256 + AES-256-GCM |
| 1 | 32 | the sender's ephemeral X25519 public key, fresh for every envelope |
| 33 | 12 | the AES-GCM nonce, random |
| 45 | n + 16 | the AES-256-GCM ciphertext of the n-byte payload, then its 16-byte tag |

The key is HKDF-SHA256 over the X25519 shared secret, with salt = ephemeral public key ‖ attestor public key and info =
`merces/e2e/v1` ‖ `0x00` ‖ purpose (`merces/tier3-opening/v1`); the 45 header bytes are the associated data. The server
holds no key and checks the shape only: canonical base64, the version byte, an opening's size (64 to 4,096 payload
bytes), a key and a nonce that are not placeholders, and a body that does not read as text. It refuses anything else,
including the opening in plaintext, hex, base64 or base64url, and ciphertext in another format. The other e2e fields
(documents, hardship reasons, evidence) are refused when they are plaintext, JSON, or an encoding of text or of a
document file (A-PRIV-4).

## Income and the things derived from it

| Field | Where | Storage | Readers | Deleted when |
| --- | --- | --- | --- | --- |
| Income figure (year to date, per source) | the issuer's device only: its income chain keeps each reported quarter's year-to-date figure and salt (the opening the next quarter's proof chains from). The report verifier sees the figure inside the zkTLS proof, and the prior quarter's opening, in memory only; a tier-3 attestor receives the opening end-to-end encrypted | none on the server | — | never exists at rest on the server |
| Income salt | device; derived from a device secret (HMAC-SHA512 under the device secret over the series and period, reduced mod the BN254 field order; `@merces/poi-device` `deriveIncomeSalt`), so a reinstalled device rebuilds its openings from its own records and no server-side copy exists (owner question 2, default). Sent to the verifier in memory only (tier 2) or end-to-end encrypted to the attestor (tier 3) | none | — | — |
| Income commitment and the prior it chains from | `reports.income_commitment`, `reports.prior_income_commitment`, `periods`, `series.last_income_commitment`, onchain `ReportAccepted` | hash (Stage 1 Poseidon(2) over the year-to-date figure and the salt) | issuer, holders, public (onchain) | — |
| Payment amounts (gross, fee, net, accrual) | `reports`, `periods`, `money_events`, `fees_ledger`, onchain | plain (public onchain in v1) | issuer, holders, admin; never in the public activity feed | end of retention |
| Threshold θ, rate r (and the share rate it comes from) and the terms salt | `terms_vault.ciphertext`; `terms_amendments.ciphertext` | vault | issuer, eligible backers (every read logged in `terms_access_log`; eligibility read live); the reviewing attestor on an amendment. No admin bypass. Never in an error message or a log: a share rate a WAD cannot hold is refused naming the rule only (A-TERMS-5), and the logger censors `theta`, `rWad`, `shareRate`, `ratePerUnitWad` and `termsSalt` | series end + retention |
| Terms commitment | `series`, `series_drafts`, onchain | hash (Stage 1 Poseidon(5) over θ, r, the currency code, the indexing rule and the terms salt) | public | — |
| zkTLS proof (contains the figure) | never on the server; device → verifier in memory | none | — | — |
| Report proof + public inputs | `reports.proof`: Stage 1's Groth16 proof and its six public signals (terms commitment, units outstanding, FX rate, prior and income commitments, payment); never the witness, which stays inside the device's prover | plain | issuer, holders, admin | end of retention |
| Verifier attestation (signature over series, period, prior and income commitments, tier and liquidity event) | `reports.attestation`, onchain | plain | issuer, holders, admin | — |
| Tier-3 income opening (year-to-date figures and salts of the quarter and its prior) | `tier3_cases.opening_ciphertext` | e2e (a merces-e2e v1 envelope; anything else is refused) | the chosen attestor only, to check the commitments against the documents; server: nobody. The attestor's signed case carries commitments, the proof and the attestation only | case closed + retention |
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
| Approval refusal | API response only (`detail.stage1`: Stage 1's rule name; the message names the rule and the protocol bound, never a date); nothing stored, audited or notified | plain (codes only) | the deciding attestor | — |
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
| Auction settlement: rounds and rejections, the clearing price, units sold, proceeds, the failure reason, the mint gate | `series`, `settlement_rounds`, onchain | plain | public (`GET /series`, `GET /series/{id}/auction`; onchain); the activity feed names rounds, reasons and unit counts only, never an amount (the indexer's `summary()`) | — |
| A bid's validity, processing and delivery state, and what it is owed (pending units and refund) or was delivered | `bids`, onchain | plain | owner (`/me/bids`); public onchain: Stage 1 keeps every bid's state in a public account, and anyone may deliver any bid (`deliverBid` pays the bidder only); the public preview projects each revealed bid's processing | — |
| Positions, claims | `positions`, `money_events`, onchain | plain | holder, issuer, admin; public onchain | — |

## Operational data

| Field | Where | Storage | Readers | Deleted when |
| --- | --- | --- | --- | --- |
| Audit log (actor, action, target, codes) | `audit_log` (append-only) | plain | admin | never (immutable) |
| Terms access log | `terms_access_log` | plain | issuer, admin | series end + retention |
| Notifications (statuses, ids, dates) | `notifications`, `email_outbox` (mock) | plain | owner; admin views are audited | read + retention |
| Outbox payloads | `outbox` | plain (may carry amounts owed to the issuer, and an auction event's public onchain amounts: a delivered refund, proceeds; never income) | admin | after dispatch + 30 days |
| Logs | process stdout | redacted (income-bearing keys censored at the sink, with Stage 1's openings and private terms: `incomeSalt`, `priorSalt`, `termsSalt`, `priorIncomeYtd`, `theta`, `rWad`, `shareRate`, `ratePerUnitWad`, `opening`, `priorOpening`, `tier3Opening`, `deviceSecret`); error messages carry no values | operators | log retention |
| Keeper runs, reconciliation runs | `keeper_runs`, `reconciliation_runs` | plain | admin | 90 days |
| Delivery retries (series, bidder, attempts, next attempt, Stage 1 error name or code; never a message) | `auction_deliveries` | plain | admin | when the bid is delivered |

## What is onchain (C11.2)

Series parameters, the terms commitment, payment amounts, statuses and events. Nothing about health, location,
relationships or career; no income figure; no reason text.

## Deletion requests

An account can request deletion of its offchain data: accounts, wallets, applications (and their encrypted notes),
notifications and preferences, backups, terms access entries that name it. Chain data, commitments, amounts,
signed contracts under legal retention and the audit log are kept. Not yet automated (Part J.9).
